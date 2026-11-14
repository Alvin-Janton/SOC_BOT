"""Validate private response groups locally, then project only safe existing evidence shapes."""

import base64
from decimal import Decimal
import json
import math
import re

from .common import encoded, integer, require, text
from scripts.client_common import unique_fields

GROUP = {"response_format", "response_block_count", "assistant_message_id", "model_id", "stop_reason", "purpose", "content_block_index"}
PRIVATE = {"THINKING", "ASSISTANT_TEXT"}
UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z")
TOKEN = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")


def decode_input(value):
    """Decode only json_text_v1; reject unsupported numeric precision/range instead of coercing private input.

    This validates the writer's accepted finite ECMAScript JSON values, not an
    arbitrary-precision number format. The original encoded text remains the byte-accounting source.
    """
    require(isinstance(value, dict) and set(value) == {'encoding', 'json'} and value['encoding'] == 'json_text_v1'
            and isinstance(value['json'], str) and len(encoded(value)) <= 16384, 'Invalid private input encoding.')

    def number(token):
        """Require the numeric token's decimal value to survive the finite binary64 interchange representation."""
        try:
            parsed = float(token)
            require(math.isfinite(parsed) and not (parsed == 0 and math.copysign(1, parsed) < 0)
                    and Decimal(token) == Decimal(str(parsed)), 'Unsupported private numeric representation.')
            return parsed if '.' in token or 'e' in token.lower() else int(token)
        except (ValueError, OverflowError) as exc:
            raise ValueError('Invalid private numeric representation.') from exc

    def constant(_token):
        """Reject JSON extensions without disclosing their source token."""
        raise ValueError('Invalid private JSON constant.')

    try:
        result = json.loads(value['json'], parse_int=number, parse_float=number,
                            parse_constant=constant, object_pairs_hook=unique_fields)
        encoded(result)
        return result
    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        raise ValueError('Invalid private input encoding.') from exc


def grouped_block(event):
    """Check one declared version-1 private payload and return its size-accounted ordered block, never report it."""
    require(GROUP <= set(event) and type(event['response_format']) is int and event['response_format'] == 1
            and isinstance(event['assistant_message_id'], str) and UUID.fullmatch(event['assistant_message_id'])
            and text(event['model_id'], 256) and event['purpose'] in {'investigation', 'finalization'}
            and integer(event['response_block_count'], 1) and event['response_block_count'] <= 64
            and integer(event['content_block_index']) and event['content_block_index'] < event['response_block_count']
            and event['stop_reason'] in {'tool_use', 'end_turn', 'stop_sequence', 'max_tokens'}, 'Invalid private response metadata.')
    common = {'index': event['content_block_index']}
    kind = event['entity_type']
    if kind == 'THINKING':
        thinking = event.get('thinking')
        require(isinstance(thinking, dict), 'Invalid private reasoning variant.')
        if thinking.get('type') == 'text':
            require(set(thinking) == {'type', 'text', 'signature'} and isinstance(thinking['text'], str)
                    and isinstance(thinking['signature'], str) and len(thinking['signature']) > 0, 'Invalid private signed reasoning.')
        else:
            require(set(thinking) == {'type', 'data'} and thinking['type'] == 'redacted' and isinstance(thinking['data'], str),
                    'Invalid private redacted reasoning.')
            try:
                data = base64.b64decode(thinking['data'], validate=True)
                require(base64.b64encode(data).decode('ascii') == thinking['data'], 'Invalid private redacted encoding.')
            except (ValueError, UnicodeError) as exc:
                raise ValueError('Invalid private redacted encoding.') from exc
        block = {**common, 'type': 'thinking', 'thinking': thinking}
    elif kind == 'ASSISTANT_TEXT':
        require(isinstance(event.get('text'), str), 'Invalid private assistant text.')
        block = {**common, 'type': 'text', 'text': event['text']}
    else:
        require(kind == 'TOOL_CALL' and 'model_input' in event and 'arguments' not in event
                and isinstance(event.get('tool_use_id'), str) and TOKEN.fullmatch(event['tool_use_id'])
                and isinstance(event.get('tool_name'), str) and TOKEN.fullmatch(event['tool_name'])
                and len(encoded(event['model_input'])) <= 16384 and isinstance(event.get('preparation'), dict), 'Invalid private tool call.')
        original = decode_input(event['model_input'])
        if event['preparation'].get('status') == 'approved':
            require(isinstance(original, dict), 'Approved private input must be an object.')
        require(event['purpose'] == 'investigation', 'Finalization cannot contain tool calls.')
        block = {**common, 'type': 'tool_use', 'id': event['tool_use_id'], 'name': event['tool_name'], 'input': original}
    encoded(block)
    return block


def safe_records(records):
    """Prove complete atomic groups before excluding private blocks and raw rejected inputs from all report data."""
    groups = {}
    for event in records:
        if 'response_format' in event:
            groups.setdefault(event['assistant_message_id'], []).append(event)
    for group_id, items in groups.items():
        items = sorted(items, key=lambda event: event['content_block_index'])
        first = items[0]
        require(len(items) == first['response_block_count'] and all(
            event['content_block_index'] == index and event['event_sequence'] == first['event_sequence'] + index
            and all(event[key] == first[key] for key in GROUP - {'content_block_index'})
            and all(event[key] == first[key] for key in ('conversation_id', 'turn_id', 'attempt_id'))
            for index, event in enumerate(items)), 'Incomplete or inconsistent private response group.')
        blocks = [grouped_block(event) for event in items]
        content = [{key: event[key] for key in ('content_block_index', 'entity_type', 'thinking', 'text', 'tool_use_id', 'tool_name', 'model_input')
                    if key in event} for event in items]
        require(len(encoded(content)) <= 65536, 'Private response group exceeds its aggregate limit.')
        calls = [block for block in blocks if block['type'] == 'tool_use']
        require(len({block['id'] for block in calls}) == len(calls)
                and bool(calls) == (first['stop_reason'] == 'tool_use'), 'Invalid private stop/tool relationship.')
        answers = [event for event in records if event['entity_type'] == 'ASSISTANT_MESSAGE' and event.get('assistant_message_id') == group_id]
        if calls:
            require(not answers, 'Tool response cannot publish an answer.')
        else:
            require(len(answers) == 1, 'Private final response has no atomic public answer.')
            answer = answers[0]
            answer_text = ''.join(block['text'] for block in blocks if block['type'] == 'text')
            require(bool(answer_text.strip()) and len(answer_text.encode('utf-8')) <= 32768
                    and answer['content'] == answer_text and answer['event_sequence'] == first['event_sequence'] + len(items)
                    and all(answer[key] == first[key] for key in ('turn_id', 'attempt_id', 'model_id', 'stop_reason')),
                    'Private/public answer linkage mismatch.')
    require(all(event.get('assistant_message_id') in groups for event in records
                if event['entity_type'] == 'ASSISTANT_MESSAGE' and 'assistant_message_id' in event), 'Missing private answer group.')
    output = []
    for event in records:
        if event['entity_type'] in PRIVATE:
            continue
        if event['entity_type'] == 'TOOL_CALL' and 'model_input' in event:
            arguments = decode_input(event['model_input']) if event['preparation']['status'] == 'approved' else {}
            event = {key: value for key, value in event.items() if key not in GROUP - {'assistant_message_id', 'content_block_index'} | {'model_input'}}
            event = {**event, 'arguments': arguments}
        output.append(event)
    return output
