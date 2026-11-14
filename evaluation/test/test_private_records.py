"""Focused offline compatibility checks for private adaptive-response audit records."""

import copy
import json
import unittest

from evaluation.evidence import select, validate_event
from evaluation.private_records import decode_input, safe_records
from evaluation.common import EvaluationError

TURN = '11111111-1111-4111-8111-111111111111'
ATTEMPT = '22222222-2222-4222-8222-222222222222'
GROUP = '33333333-3333-4333-8333-333333333333'
STAMP = '2026-11-14T12:00:00.000Z'


def event(sequence, kind, **payload):
    """Build a complete small synthetic EVT envelope rather than importing runtime handlers or real data."""
    identity = f'00000000-0000-4000-8000-{sequence:012d}'
    return dict(PK='CONV#conversation-one', SK=f'EVT#{STAMP}#{sequence:010d}#{identity}', schema_version=1,
                conversation_id='conversation-one', event_id=identity, event_sequence=sequence, turn_id=TURN,
                created_at=STAMP, **({} if kind == 'USER_MESSAGE' else {'attempt_id': ATTEMPT}), entity_type=kind, **payload)


def metadata(index, count, reason='tool_use'):
    """Reuse the committed group contract with synthetic non-secret model/response identifiers."""
    return dict(response_format=1, response_block_count=count, assistant_message_id=GROUP, model_id='synthetic-model',
                stop_reason=reason, purpose='investigation', content_block_index=index)


def stored_input(value):
    """Supply a synthetic versioned JSON-text fixture; no real model/credential values are used."""
    return {'encoding': 'json_text_v1', 'json': json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'))}


class PrivateRecords(unittest.TestCase):
    """Verify private validation/exclusion while keeping the existing evidence and judge input shape."""

    def test_rejected_input_and_private_text_never_enter_projection(self):
        """A rejected JSON scalar survives local validation but is outwardly only arguments:{} and a code."""
        records = [event(1, 'USER_MESSAGE', role='user', content='Synthetic request.'),
                   event(2, 'THINKING', **metadata(0, 3), thinking={'type': 'text', 'text': '', 'signature': 'synthetic-signature'}),
                   event(3, 'ASSISTANT_TEXT', **metadata(1, 3), text='private intermediate text'),
                   event(4, 'TOOL_CALL', **metadata(2, 3), tool_use_id='tool-one', tool_name='describe_document',
                         model_input=stored_input('private rejected input'), preparation={'status': 'rejected', 'code': 'INVALID_TOOL_INPUT'}),
                   event(5, 'TOOL_RESULT', tool_use_id='tool-one', tool_name='describe_document', status='error',
                         output={'ok': False, 'error': {'code': 'INVALID_TOOL_INPUT'}})]
        output = select(records, {'question': 'Synthetic request.'}, {'conversation_id': 'conversation-one', 'turn_id': TURN,
                        'status': 'failed', 'answer': '', 'terminal': None})
        self.assertEqual(output['pairs'][0]['arguments'], {})
        rendered = json.dumps(output)
        for private in ('synthetic-signature', 'private intermediate text', 'private rejected input', 'THINKING', 'ASSISTANT_TEXT', 'model_input'):
            self.assertNotIn(private, rendered)
        self.assertEqual(output['pairs'][0]['call']['event_sequence'], 4)

    def test_signed_and_redacted_groups_link_to_exact_public_answer(self):
        """Opaque base64 and empty signed text are validated but only the exact public final text is selected."""
        records = [event(1, 'USER_MESSAGE', role='user', content='Synthetic request.'),
                   event(2, 'THINKING', **metadata(0, 3, 'end_turn'), thinking={'type': 'redacted', 'data': 'AP8B'}),
                   event(3, 'THINKING', **metadata(1, 3, 'end_turn'), thinking={'type': 'text', 'text': '', 'signature': 'sig'}),
                   event(4, 'ASSISTANT_TEXT', **metadata(2, 3, 'end_turn'), text='Public answer.'),
                   event(5, 'ASSISTANT_MESSAGE', role='assistant', content='Public answer.', model_id='synthetic-model',
                         stop_reason='end_turn', assistant_message_id=GROUP)]
        for record in records:
            validate_event(record, 'conversation-one')
        public = safe_records(records)
        self.assertEqual([row['entity_type'] for row in public], ['USER_MESSAGE', 'ASSISTANT_MESSAGE'])
        for change in ('missing', 'duplicate', 'bad_signature', 'bad_base64', 'bad_answer', 'bad_metadata'):
            modified = copy.deepcopy(records)
            if change == 'missing': modified.pop(1)
            elif change == 'duplicate': modified[2]['content_block_index'] = 0
            elif change == 'bad_signature': modified[2]['thinking']['signature'] = ''
            elif change == 'bad_base64': modified[1]['thinking']['data'] = 'AP8B='
            elif change == 'bad_answer': modified[-1]['content'] = 'Different.'
            else: modified[2]['response_block_count'] = 2
            with self.subTest(change=change), self.assertRaises((EvaluationError, ValueError)):
                safe_records(modified)

    def test_legacy_approved_new_calls_and_null_inputs(self):
        """Legacy calls remain readable, mixed shapes fail and raw JSON type distinctions are preserved privately."""
        legacy = event(1, 'TOOL_CALL', assistant_message_id='legacy-group', content_block_index=0,
                       tool_use_id='tool-one', tool_name='describe_documents', arguments={}, preparation={'status': 'approved'})
        validate_event(legacy, 'conversation-one')
        self.assertEqual(safe_records([legacy]), [legacy])
        for value in (None, [], False, 0, 'synthetic', {'quantity': 0.25}, 1e100, 1e308, 1e-200):
            raw = stored_input(value)
            call = event(1, 'TOOL_CALL', **metadata(0, 1), tool_use_id='tool-one', tool_name='describe_document',
                         model_input=raw, preparation={'status': 'rejected', 'code': 'INVALID_TOOL_INPUT'})
            validate_event(call, 'conversation-one')
            self.assertEqual(safe_records([call])[0]['arguments'], {})
            mixed = {**call, 'arguments': {}}
            with self.assertRaises(EvaluationError): validate_event(mixed, 'conversation-one')
        approved = event(1, 'TOOL_CALL', **metadata(0, 1), tool_use_id='tool-one', tool_name='describe_documents',
                         model_input=stored_input({}), preparation={'status': 'approved'})
        validate_event(approved, 'conversation-one')
        self.assertEqual(safe_records([approved])[0]['arguments'], {})
        self.assertIsInstance(decode_input(stored_input(0.25)), float)

    def test_encoding_rejects_unknown_malformed_or_lossy_inputs(self):
        """Bad versions/fields, invalid JSON and unsupported numeric tokens never become valid null/object inputs."""
        for value in (None, {'encoding': 'unknown', 'json': 'null'}, {'encoding': 'json_text_v1', 'json': '{'},
                      {'encoding': 'json_text_v1', 'json': '1e400'}, {'encoding': 'json_text_v1', 'json': '1e-400'},
                      {'encoding': 'json_text_v1', 'json': '9007199254740993'}, {'encoding': 'json_text_v1', 'json': '-0'},
                      {'encoding': 'json_text_v1', 'json': 'null', 'extra': True}):
            with self.subTest(value=value), self.assertRaises((EvaluationError, ValueError)):
                decode_input(value)

    def test_private_group_enforces_aggregate_byte_limit(self):
        """The limit applies to a whole serialized group, including UTF-8 escaping and signature data."""
        record = event(1, 'TOOL_CALL', **metadata(0, 1), tool_use_id='tool-one', tool_name='describe_documents',
                       model_input=stored_input({}), preparation={'status': 'approved'})
        thinking = event(1, 'THINKING', **metadata(0, 2), thinking={'type': 'text', 'text': '雪\n', 'signature': 's' * 65536})
        record.update(content_block_index=1, response_block_count=2, event_sequence=2)
        with self.assertRaises(EvaluationError): safe_records([thinking, record])


if __name__ == '__main__':
    unittest.main()
