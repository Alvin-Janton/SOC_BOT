"""Validate untrusted application JSONL without mutating source records."""

from datetime import datetime, timedelta, timezone
from ipaddress import ip_address
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


def parse_waf_record(raw_line: str) -> tuple[dict, datetime]:
    """Validate WAF evidence and require any ISO time to equal the epoch time."""
    try:
        record = json.loads(raw_line)

    except (TypeError, ValueError) as error:
        raise ValueError("malformed_json") from error

    if not isinstance(record, dict):
        raise ValueError("record_not_object")

    request = record.get("httpRequest")
    if not isinstance(request, dict):
        raise ValueError("invalid_httpRequest")

    for key in ("requestId", "clientIp", "httpMethod", "uri"):
        if not isinstance(request.get(key), str) or not request[key].strip():
            raise ValueError(f"invalid_httpRequest_{key}")

    try:
        ip_address(request["clientIp"])

    except ValueError as error:
        raise ValueError("invalid_httpRequest_clientIp") from error

    if not isinstance(record.get("action"), str) or not record["action"].strip():
        raise ValueError("invalid_action")

    if type(record.get("timestamp")) is not int or record["timestamp"] < 0:
        raise ValueError("invalid_timestamp")

    try:
        timestamp = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(milliseconds=record["timestamp"])

    except (OverflowError, ValueError) as error:
        raise ValueError("invalid_timestamp") from error

    if "event_time" in record:
        try:
            iso = datetime.fromisoformat(record["event_time"].replace("Z", "+00:00"))

        except (AttributeError, TypeError, ValueError) as error:
            raise ValueError("invalid_event_time") from error

        if iso.tzinfo is None:
            raise ValueError("event_time_missing_timezone")

        if iso.astimezone(timezone.utc) != timestamp:
            raise ValueError("conflicting_event_time")

    for key in ("terminatingRuleId", "terminatingRuleType", "webaclId", "httpSourceName", "httpSourceId"):
        if record.get(key) is not None and not isinstance(record[key], str):
            raise ValueError(f"invalid_{key}")

    for key in ("args", "country", "httpVersion"):
        if request.get(key) is not None and not isinstance(request[key], str):
            raise ValueError(f"invalid_httpRequest_{key}")

    for key in (
        "labels", "terminatingRuleMatchDetails", "nonTerminatingMatchingRules",
        "ruleGroupList", "rateBasedRuleList",
    ):
        if key in record and (not isinstance(record[key], list) or any(not isinstance(item, dict) for item in record[key])):
            raise ValueError(f"invalid_{key}")

    headers = request.get("headers", [])
    if not isinstance(headers, list) or any(
        not isinstance(item, dict) or not isinstance(item.get("name"), str)
        or not isinstance(item.get("value"), str) for item in headers
    ):
        raise ValueError("invalid_httpRequest_headers")

    for key in ("formatVersion", "responseCodeSent"):
        value = record.get(key)
        if value is not None and type(value) is not int:
            raise ValueError(f"invalid_{key}")

    if record.get("responseCodeSent") is not None and not 100 <= record["responseCodeSent"] <= 599:
        raise ValueError("invalid_responseCodeSent")

    return record, timestamp
