"""Validate untrusted application JSONL without mutating source records."""

from datetime import datetime, timezone
import json


def parse_application_record(raw_line: str) -> tuple[dict, datetime]:
    """Parse required HTTP fields and return a timestamp normalized to UTC."""

    try:
        record = json.loads(raw_line)
    except (TypeError, ValueError) as error:
        raise ValueError("malformed_json") from error

    if not isinstance(record, dict):
        raise ValueError("record_not_object")

    for key in ("event_time", "request_id", "method", "path", "status_code"):
        if key not in record or record[key] is None or record[key] == "":
            raise ValueError(f"missing_{key}")

    for key in ("request_id", "method", "path"):
        if not isinstance(record[key], str):
            raise ValueError(f"invalid_{key}")

    if type(record["status_code"]) is not int or not 100 <= record["status_code"] <= 599:
        raise ValueError("invalid_status_code")

    for key in ("latency_ms", "response_bytes", "source_line_start", "source_line_end"):
        if record.get(key) is not None and type(record[key]) is not int:
            raise ValueError(f"invalid_{key}")

    for key in ("query_params", "body_params", "headers", "source_geo"):
        if record.get(key) is not None and not isinstance(record[key], dict):
            raise ValueError(f"invalid_{key}")
    try:
        timestamp = datetime.fromisoformat(record["event_time"].replace("Z", "+00:00"))
    except (AttributeError, TypeError, ValueError) as error:
        raise ValueError("invalid_event_time") from error

    if timestamp.tzinfo is None:
        raise ValueError("event_time_missing_timezone")

    return record, timestamp.astimezone(timezone.utc)
