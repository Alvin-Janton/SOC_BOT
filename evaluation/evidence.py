"""Read only the exact conversation's base-table events and select causal evidence."""

from decimal import Decimal
import re
import time

from .common import encoded, integer, require, sdk_call, text, utc

LIMITS = {"pages": 128, "records": 10000, "decoded_bytes": 8388608, "deadline_seconds": 60,
          "record_bytes": 98304, "connect_seconds": 5, "read_seconds": 10, "page_limit": 100}
PENDING = {"SUBMITTED", "QUEUED", "RUNNING", "UNKNOWN"}
UUID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z")
BASE = {"PK", "SK", "schema_version", "conversation_id", "event_id", "event_sequence", "turn_id", "attempt_id", "created_at", "entity_type"}
VARIANTS = {
    "USER_MESSAGE": {"role", "content"},
    "ASSISTANT_MESSAGE": {"role", "content", "model_id", "stop_reason"},
    "TOOL_CALL": {"assistant_message_id", "content_block_index", "tool_use_id", "tool_name", "arguments", "preparation"},
    "TOOL_RESULT": {"tool_use_id", "tool_name", "status", "output"},
    "TURN_OUTCOME": {"outcome", "retryable", "failure_phase", "error_code"},
}


def decoded(value, depth: int = 0):
    """Convert DynamoDB Decimals exactly and reject non-JSON attributes/deep data."""

    require(depth <= 24, "Durable JSON exceeds maximum nesting.")

    if isinstance(value, Decimal):
        require(value.is_finite(), "Non-finite DynamoDB number.")
        return int(value) if value == value.to_integral_value() else str(value)

    if isinstance(value, dict):
        require(all(isinstance(key, str) for key in value), "Non-string attribute key.")
        return {key: decoded(item, depth + 1) for key, item in value.items()}

    if isinstance(value, list):
        return [decoded(item, depth + 1) for item in value]

    require(value is None or type(value) in {str, bool, int}, "Unsupported DynamoDB attribute type.")
    return value


def read_events(session, table: str, conversation_id: str, statistics: dict) -> list[dict]:
    """Paginate a strongly consistent PK/prefix Query, including empty pages."""

    from botocore.config import Config

    deadline = time.monotonic() + LIMITS["deadline_seconds"]
    records = []
    cursor = None
    seen_cursors = set()
    statistics.update(pages=0, records=0, decoded_bytes=0)

    while True:

        require(statistics["pages"] < LIMITS["pages"], "Conversation page cap exceeded.", "EVIDENCE_LIMIT")
        arguments = {"KeyConditionExpression": "PK = :pk AND begins_with(SK, :events)",
                     "ExpressionAttributeValues": {":pk": "CONV#" + conversation_id, ":events": "EVT#"},
                     "ConsistentRead": True, "Limit": LIMITS["page_limit"]}

        if cursor:
            arguments["ExclusiveStartKey"] = cursor

        def query(stop_at):
            """Create/close a read-only SDK client inside the bounded worker."""
            resource = session.resource("dynamodb", config=Config(connect_timeout=5, read_timeout=10,
                                        retries={"total_max_attempts": 1}))
            try:
                require(time.monotonic() < stop_at, "Evidence deadline exceeded.", "STAGE_DEADLINE")
                return resource.Table(table).query(**arguments)
            finally:
                resource.meta.client.close()

        page = sdk_call(query, deadline, statistics)
        items = page.get("Items")
        require(isinstance(items, list), "DynamoDB Query omitted Items.")

        for item in items:
            record = decoded(item)
            statistics["decoded_bytes"] += len(encoded(record))
            statistics["records"] += 1

            require(statistics["decoded_bytes"] <= LIMITS["decoded_bytes"] and statistics["records"] <= LIMITS["records"],
                    "Conversation record/byte cap exceeded; no partial score.", "EVIDENCE_LIMIT")

            records.append(record)
        statistics["pages"] += 1
        cursor = page.get("LastEvaluatedKey")

        if not cursor:
            require(time.monotonic() < deadline, "Evidence deadline exceeded.", "STAGE_DEADLINE")
            return records

        cursor_key = encoded(decoded(cursor))
        require(cursor_key not in seen_cursors, "Repeated DynamoDB pagination cursor.")
        seen_cursors.add(cursor_key)


def validate_event(event: dict, conversation_id: str) -> None:
    """Check the store's envelope, physical key, payload and size contracts."""

    require(isinstance(event, dict) and len(encoded(event)) <= LIMITS["record_bytes"], "Invalid durable event size/type.")
    kind = event.get("entity_type")
    require(kind in VARIANTS and set(event) <= BASE | VARIANTS[kind], "Unknown durable event variant/field.")

    require(event.get("PK") == "CONV#" + conversation_id and event.get("conversation_id") == conversation_id
            and type(event.get("schema_version")) is int and event["schema_version"] == 1, "Durable conversation envelope mismatch.")

    for key in ("event_id", "turn_id"):

        require(isinstance(event.get(key), str) and bool(UUID.fullmatch(event[key])), "Invalid durable event/turn ID.")

    if kind != "USER_MESSAGE" or "attempt_id" in event:
        require(isinstance(event.get("attempt_id"), str) and bool(UUID.fullmatch(event["attempt_id"])), "Invalid attempt ID.")
    sequence = event.get("event_sequence")

    require(integer(sequence, 1) and sequence <= 9999999999, "Invalid event sequence.")
    utc(event.get("created_at"))
    require(event.get("SK") == f"EVT#{event['created_at']}#{sequence:010d}#{event['event_id']}", "Event sort key and sequence disagree.")

    if kind in {"USER_MESSAGE", "ASSISTANT_MESSAGE"}:
        require(text(event.get("content"), 32768) and event.get("role") == ("user" if kind == "USER_MESSAGE" else "assistant"), "Invalid durable message.")
        if kind == "ASSISTANT_MESSAGE":
            require(text(event.get("model_id"), 256) and text(event.get("stop_reason"), 64), "Missing assistant metadata.")

    elif kind in {"TOOL_CALL", "TOOL_RESULT"}:
        require(text(event.get("tool_use_id"), 128) and text(event.get("tool_name"), 128), "Invalid tool identity.")

        if kind == "TOOL_CALL":

            require(text(event.get("assistant_message_id"), 128) and integer(event.get("content_block_index"))
                    and event["content_block_index"] <= 128 and isinstance(event.get("arguments"), dict)
                    and len(encoded(event["arguments"])) <= 20480, "Invalid tool call.")

            preparation = event.get("preparation")

            require(preparation is None or preparation == {"status": "approved"} or (
                isinstance(preparation, dict) and set(preparation) == {"status", "code"}
                and preparation["status"] == "rejected" and preparation["code"] in {
                    "INVALID_TOOL", "INVALID_TOOL_INPUT", "TOOL_LIMIT_REACHED", "FINALIZATION_REQUIRED"}
                and event["arguments"] == {}), "Invalid durable preparation.")

        else:
            require(event.get("status") in {"success", "error"} and isinstance(event.get("output"), dict)
                    and len(encoded(event["output"])) <= 65536, "Invalid tool result.")

    else:
        require(event.get("outcome") in {"failed", "timed_out", "cancelled", "abandoned"}
                and type(event.get("retryable")) is bool and text(event.get("failure_phase"), 64)
                and text(event.get("error_code"), 64) and (event["outcome"] != "abandoned" or not event["retryable"]), "Invalid turn outcome.")


def reference(event: dict) -> dict:
    """Retain explicit causal identifiers without copying raw table envelopes."""

    return {key: event[key] for key in ("event_id", "event_sequence", "turn_id", "attempt_id", "created_at", "entity_type") if key in event}


def terminal(event: dict) -> bool:
    """Mirror context.ts: errors are terminal; successful checkpoints are not."""

    return event["status"] == "error" or event["output"].get("state") not in PENDING


def select(records: list[dict], case: dict, application: dict) -> dict:
    """Select complete call/result pairs across attempts and enforce final-answer agreement."""

    seen_sequences, seen_ids = set(), set()

    for event in records:
        validate_event(event, application["conversation_id"])
        require(event["event_sequence"] not in seen_sequences and event["event_id"] not in seen_ids, "Duplicate durable event sequence/ID.")
        seen_sequences.add(event["event_sequence"])
        seen_ids.add(event["event_id"])

    events = sorted((event for event in records if event["turn_id"] == application["turn_id"]), key=lambda event: event["event_sequence"])
    users = [event for event in events if event["entity_type"] == "USER_MESSAGE"]
    require(len(users) == 1 and users[0]["content"] == case["question"], "Expected exactly one matching persisted user message.")
    completed = application["status"] in {"completed", "truncated"}
    assistants = [event for event in events if event["entity_type"] == "ASSISTANT_MESSAGE"]
    assistant = assistants[-1] if assistants else None

    if completed:

        require(assistant is not None and assistant["event_sequence"] > users[0]["event_sequence"], "Missing causal persisted assistant message.")
        require(all(item["content"] == application["answer"] and item["stop_reason"] == assistant["stop_reason"] for item in assistants), "Stream/persisted answers conflict.")
        require(assistant["stop_reason"] in {"end_turn", "stop_sequence", "max_tokens"}
                and (assistant["stop_reason"] == "max_tokens") == application["terminal"]["truncated"], "Assistant stop reason/truncation mismatch.")
        require(not any(event.get("outcome") == "abandoned" for event in events), "Completed turn contains terminal abandonment.")

    cutoff = assistant["event_sequence"] if completed else (events[-1]["event_sequence"] if events else 0)
    selected = [event for event in events if event["event_sequence"] <= cutoff]
    calls = [event for event in selected if event["entity_type"] == "TOOL_CALL"]
    results = [event for event in selected if event["entity_type"] == "TOOL_RESULT"]
    call_map, groups = {}, {}

    for call in calls:
        require(call["event_sequence"] > users[0]["event_sequence"] and call["tool_use_id"] not in call_map, "Duplicate or noncausal tool call.")
        call_map[call["tool_use_id"]] = call
        group = groups.setdefault(call["assistant_message_id"], [])
        require(all(item["content_block_index"] != call["content_block_index"] and item["attempt_id"] == call["attempt_id"] for item in group), "Tool group block/attempt mismatch.")
        group.append(call)

    for result in results:
        call = call_map.get(result["tool_use_id"])
        require(call is not None and result["tool_name"] == call["tool_name"] and result["event_sequence"] > call["event_sequence"], "Orphan, mismatched or noncausal tool result.")

    pairs, checkpoints, unresolved = [], [], []

    for call in calls:
        matches = [event for event in results if event["tool_use_id"] == call["tool_use_id"]]
        finished = [event for event in matches if terminal(event)]
        require(len({encoded({"status": event["status"], "output": event["output"]}) for event in finished}) <= 1, "Contradictory terminal results for one tool call.")
        checkpoints.extend({"tool_use_id": call["tool_use_id"], "reference": reference(event), "output": event["output"]} for event in matches if not terminal(event))

        if not finished:
            unresolved.append({"call": reference(call), "tool_use_id": call["tool_use_id"], "tool_name": call["tool_name"], "arguments": call["arguments"], "preparation": call.get("preparation")})
            continue

        result = finished[-1]
        require(result["output"].get("ok") is (result["status"] == "success"), "Terminal result status and response envelope disagree.")
        preparation = call.get("preparation")

        if preparation and preparation["status"] == "rejected":
            error = result["output"].get("error")
            require(result["status"] == "error" and isinstance(error, dict)
                    and error.get("code") in {preparation["code"], "NOT_EXECUTED"}, "Rejected preparation has an incompatible terminal result.")

        pairs.append({"tool_use_id": call["tool_use_id"], "tool_name": call["tool_name"], "arguments": call["arguments"],
                      "preparation": call.get("preparation"), "assistant_message_id": call["assistant_message_id"],
                      "content_block_index": call["content_block_index"], "call": reference(call), "result": reference(result),
                      "equivalent_terminal_references": [reference(item) for item in finished[:-1]],
                      "status": result["status"], "output": result["output"]})

    require(not completed or not unresolved, "Completed answer has unresolved tool associations.")

    return {"status": "completed" if completed else "incomplete", "answer_agrees": completed,
            "user_message": {**reference(users[0]), "content": users[0]["content"]},
            "assistant_message": ({**reference(assistant), "content": assistant["content"], "model_id": assistant["model_id"], "stop_reason": assistant["stop_reason"]} if assistant else None),
            "pairs": pairs, "checkpoints": checkpoints, "unresolved_calls": unresolved,
            "outcomes": [{**reference(event), **{key: event[key] for key in VARIANTS["TURN_OUTCOME"]}} for event in selected if event["entity_type"] == "TURN_OUTCOME"],
            "causal_cutoff": cutoff, "excluded_later_event_count": len(events) - len(selected),
            "excluded_other_turn_count": len(records) - len(events),
            "attempt_ids": sorted({event["attempt_id"] for event in selected if "attempt_id" in event})}


def execution_checks(case: dict, application: dict, evidence: dict) -> dict:
    """Report declared coverage without mistaking it for semantic investigation completeness."""

    pairs = evidence["pairs"]
    scope = case["scope"]
    start, end = utc(scope["start_time"]), utc(scope["end_time"])
    intervals, queries = [], []

    for pair in pairs:

        if pair["tool_name"] not in {"query_events", "aggregate_events"}:
            continue

        args, output = pair["arguments"], pair["output"]
        query = {"tool_use_id": pair["tool_use_id"], "arguments": args, "status": pair["status"],
                 "duration_ms": output.get("duration_ms"), "bytes_scanned": output.get("bytes_scanned"),
                 "truncated": output.get("truncated"), "result_count": output.get("result_count"),
                 "scope_relation": "not_executed_or_invalid"}

        if pair["status"] == "success" and output.get("state") == "SUCCEEDED":

            lower, upper = utc(args.get("start_time")), utc(args.get("end_time"))
            require(lower < upper, "Persisted query has an invalid time range.")
            same = args.get("table") == scope["table"]
            query["scope_relation"] = "named_table" if same else "alternative_or_corroborating_table"
            query["includes_final_endpoint"] = lower <= end < upper
            query["overlaps_requested_window"] = (lower <= end if scope["end_inclusive"] else lower < end) and upper > start

            if same:
                intervals.append((lower, upper))

        queries.append(query)

    reached = start

    for lower, upper in sorted(intervals):
        if lower <= reached and upper > reached:
            reached = upper

    covered = reached > end if scope["end_inclusive"] else reached >= end
    preparations = [pair.get("preparation") for pair in pairs + evidence["unresolved_calls"]]
    
    return {"application_status": application["status"], "terminal": application["terminal"],
            "answer_persistence_agreement": evidence["answer_agrees"], "logical_tool_calls": len(pairs) + len(evidence["unresolved_calls"]),
            "preparation_outcomes": {"approved": sum(item == {"status": "approved"} for item in preparations),
                                     "rejected": sum(item is not None and item.get("status") == "rejected" for item in preparations),
                                     "legacy_unspecified": sum(item is None for item in preparations)},
            "rejected_calls": sum(item is not None and item.get("status") == "rejected" for item in preparations),
            "error_calls": sum(pair["status"] == "error" for pair in pairs),
            "not_executed_calls": sum(pair["output"].get("error", {}).get("code") == "NOT_EXECUTED" for pair in pairs),
            "successful_section_retrievals": [pair["tool_use_id"] for pair in pairs if pair["tool_name"] == "retrieve_sections" and pair["status"] == "success" and pair["output"].get("ok") is True],
            "queries": queries, "named_table_declared_time_union_covers_scope": covered,
            "coverage_limitation": "Declared successful query intervals only; filters, row/byte limits and alternative investigations require semantic review. Coverage is not proof of complete evidence.",
            "agent_tokens": {"input": None, "output": None, "reason": "Available only in CloudWatch; this evaluator does not read CloudWatch."}}
