"""Read only the exact conversation's base-table events and select causal evidence."""

from decimal import Decimal
from pathlib import Path
import re
import time

from .common import encoded, integer, object_json, require, sdk_call, text, utc

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
VALIDATION_CONTRACT = object_json((Path(__file__).resolve().parents[1]
                                 / "infra/lib/shared/tool-validation-contract.json").read_bytes())


def valid_tool_validation(value: object) -> bool:
    """Validate correction metadata using the runtime's shared fields, messages, paths and limits.

    This accepts no raw tool values or free-form messages. It does not make a
    rejected call successful evidence or relax any dispatch/pairing check.
    """
    if (not isinstance(value, dict) or not {"stage", "issues"} <= set(value)
            or not set(value) <= {"stage", "issues", "omitted"}
            or ("omitted" in value and value["omitted"] is not True)
            or not isinstance(value["stage"], str) or value["stage"] not in VALIDATION_CONTRACT["stages"]
            or not isinstance(value["issues"], list)
            or not 1 <= len(value["issues"]) <= VALIDATION_CONTRACT["max_issues"]):
        return False

    messages = VALIDATION_CONTRACT["stages"][value["stage"]]

    for issue in value["issues"]:

        if (not isinstance(issue, dict) or set(issue) != {"path", "code", "message"}
                or not isinstance(issue["code"], str) or issue["code"] not in messages
                or issue["message"] != messages[issue["code"]] or not isinstance(issue["path"], list)):
            return False

        if not any(len(shape) == len(issue["path"]) and all(
                (type(part) is int and 0 <= part <= VALIDATION_CONTRACT["max_index"])
                if segment == "#" else (isinstance(part, str) and part == segment)
                for segment, part in zip(shape, issue["path"])) for shape in VALIDATION_CONTRACT["path_shapes"]):
            return False
            
    return len(encoded(value)) <= VALIDATION_CONTRACT["max_bytes"]


def decoded(value, depth: int = 0):
    """Convert a DynamoDB value into JSON-compatible Python values without losing precision.

    Recursively copy dictionaries/lists, converting integral Decimals to integers
    and fractional Decimals to exact decimal strings while retaining other allowed
    scalar values. Reject unsupported types, non-string dictionary keys, non-finite
    numbers and nesting deeper than the supported limit.

    Example input:
        value = {
            "event_sequence": Decimal("3"),
            "ratio": Decimal("0.1234567890123456789"),
            "output": {"rows": [{"count_rows": Decimal("12")}], "ok": True},
        }
        depth = 0

    Example output:
        {
            "event_sequence": 3,
            "ratio": "0.1234567890123456789",
            "output": {"rows": [{"count_rows": 12}], "ok": True},
        }
    """

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
    """Read a conversation's EVT# records using strongly consistent base-table queries.

    Follow every pagination cursor, including those on empty pages, normalize
    DynamoDB values with decoded(), and update statistics with page/record/byte
    counts and SDK attempts. Enforce the read limits here; event validation and
    filtering to a particular turn happen later in select().

    Example input:
        session = boto3.Session(
            profile_name="soc-bot-evaluator", region_name="us-east-1",
        )
        table = "SOC-BOT-DEV-CHAT-HISTORY"
        conversation_id = "conversation-001"
        statistics = {}

    Example output (one record shown; remaining stored fields/records omitted):
        [
            {
                "PK": "CONV#conversation-001",
                "entity_type": "USER_MESSAGE",
                "conversation_id": "conversation-001",
                "event_sequence": 1,
                "role": "user",
                "content": "Describe waf_events.",
                # SK, UUIDs, schema version and timestamps omitted.
            },
        ]

    statistics after a successful one-page read (illustrative sizes):
        {"pages": 1, "records": 1, "decoded_bytes": 480, "service_attempts": 1}
    """

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
                isinstance(preparation, dict) and {"status", "code"} <= set(preparation)
                and set(preparation) <= {"status", "code", "validation"}
                and preparation["status"] == "rejected" and preparation["code"] in {
                    "INVALID_TOOL", "INVALID_TOOL_INPUT", "TOOL_LIMIT_REACHED", "FINALIZATION_REQUIRED"}
                and ("validation" not in preparation or (preparation["code"] == "INVALID_TOOL_INPUT"
                     and valid_tool_validation(preparation["validation"])))
                and event["arguments"] == {}), "Invalid durable preparation.")

        else:
            require(event.get("status") in {"success", "error"} and isinstance(event.get("output"), dict)
                    and len(encoded(event["output"])) <= 65536, "Invalid tool result.")
            error = event["output"].get("error")
            if isinstance(error, dict) and "validation" in error:
                require(event["status"] == "error" and event["output"].get("ok") is False
                        and error.get("code") == "INVALID_TOOL_INPUT" and valid_tool_validation(error["validation"]),
                        "Invalid tool correction metadata.")

    else:
        require(event.get("outcome") in {"failed", "timed_out", "cancelled", "abandoned"}
                and type(event.get("retryable")) is bool and text(event.get("failure_phase"), 64)
                and text(event.get("error_code"), 64) and (event["outcome"] != "abandoned" or not event["retryable"]), "Invalid turn outcome.")


def reference(event: dict) -> dict:
    """Extract the event metadata needed to locate and order a stored evidence item.

    Copy only the available event ID, sequence, turn ID, attempt ID, timestamp and
    entity type, leaving message text, tool payloads and table keys behind.
    Missing optional fields, such as a user message's attempt_id, stay absent.

    Example input:
        event = {
            "event_id": "11111111-1111-4111-8111-111111111111",
            "event_sequence": 3,
            "turn_id": "22222222-2222-4222-8222-222222222222",
            "attempt_id": "33333333-3333-4333-8333-333333333333",
            "created_at": "2026-10-20T12:00:00.000Z",
            "entity_type": "TOOL_RESULT",
            "tool_use_id": "tool-001",
            "output": {"ok": True, "rows": []},
        }

    Example output:
        {
            "event_id": "11111111-1111-4111-8111-111111111111",
            "event_sequence": 3,
            "turn_id": "22222222-2222-4222-8222-222222222222",
            "attempt_id": "33333333-3333-4333-8333-333333333333",
            "created_at": "2026-10-20T12:00:00.000Z",
            "entity_type": "TOOL_RESULT",
        }
    """

    return {key: event[key] for key in ("event_id", "event_sequence", "turn_id", "attempt_id", "created_at", "entity_type") if key in event}


def terminal(event: dict) -> bool:
    """Decide whether a TOOL_RESULT is final evidence rather than a pending checkpoint.

    Error-status results are always terminal, while success-status results with
    SUBMITTED, QUEUED, RUNNING or UNKNOWN states remain pending. Other successful
    results are terminal, including tools such as describe_table that have no state.

    Example input:
        event = {"status": "success", "output": {"state": "SUBMITTED"}}
    Example output:
        False

    Another input:
        event = {"status": "success", "output": {"ok": True, "state": "SUCCEEDED"}}
    Corresponding output:
        True
    """

    return event["status"] == "error" or event["output"].get("state") not in PENDING


def select(records: list[dict], case: dict, application: dict) -> dict:
    """Validate conversation events and select the requested turn's causal evidence.

    Require the matching user message and, for completed/truncated streams, exact
    agreement with the persisted assistant answer before applying its event cutoff.
    Pair calls with compatible terminal results across attempts, retaining pending
    checkpoints for audit and rejecting conflicting or invalid associations.

    Example input (repeated stored envelopes and some payload fields abbreviated):
        records = [
            {
                "entity_type": "USER_MESSAGE", "event_sequence": 1,
                "role": "user", "content": "Describe waf_events.",
            },
            {
                "entity_type": "TOOL_CALL", "event_sequence": 2,
                "assistant_message_id": "group-001", "content_block_index": 0,
                "tool_use_id": "tool-001", "tool_name": "describe_table",
                "arguments": {"table": "waf_events"},
                "preparation": {"status": "approved"},
            },
            {
                "entity_type": "TOOL_RESULT", "event_sequence": 3,
                "tool_use_id": "tool-001", "tool_name": "describe_table",
                "status": "success",
                "output": {"ok": True, "table": "waf_events", "columns": []},
            },
            {
                "entity_type": "ASSISTANT_MESSAGE", "event_sequence": 4,
                "role": "assistant", "content": "The table contains WAF events.",
                "model_id": "us.anthropic.claude-sonnet-4-6",
                "stop_reason": "end_turn",
            },
        ]
        # Actual records also include valid PK/SK, schema_version, conversation_id,
        # UUID event_id/turn_id, created_at, and attempt_id for non-user events.
        case = {"question": "Describe waf_events."}  # Other case fields omitted.
        application = {
            "conversation_id": "conversation-001",
            "turn_id": "22222222-2222-4222-8222-222222222222",
            "status": "completed",
            "answer": "The table contains WAF events.",
            "terminal": {"type": "complete", "truncated": False, "replayed": False},
        }
    """

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
            if error["code"] == preparation["code"]:
                require(error.get("validation") == preparation.get("validation"), "Rejected correction metadata disagrees with preparation.")

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
    """Summarize application status, tool outcomes and declared query-time coverage.

    Compare successful named-table query intervals with the case scope using the
    query tool's exclusive-end semantics, while allowing corroborating tables and
    subwindows. Report counts, preparation decisions and available usage without
    treating time coverage as proof that filters or bounded rows captured every event.

    Example input (case, stream and selected-pair metadata abbreviated):
        case = {
            "scope": {
                "table": "waf_events",
                "start_time": "2026-10-20T00:00:00Z",
                "end_time": "2026-10-21T00:00:00Z",
                "end_inclusive": False,
            },
        }
        application = {
            "status": "completed",
            "terminal": {"type": "complete", "truncated": False, "replayed": False},
        }
        evidence = {
            "answer_agrees": True,
            "pairs": [
                {
                    "tool_use_id": "tool-001", "tool_name": "query_events",
                    "arguments": {
                        "table": "waf_events",
                        "start_time": "2026-10-20T00:00:00Z",
                        "end_time": "2026-10-21T00:00:00Z",
                    },
                    "preparation": {"status": "approved"}, "status": "success",
                    "output": {
                        "ok": True, "state": "SUCCEEDED", "duration_ms": 1200,
                        "bytes_scanned": 2048, "result_count": 1, "truncated": False,
                    },
                },
            ],
            "unresolved_calls": [],
        }
    """

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
