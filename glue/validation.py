"""Validate untrusted source records without mutating their raw evidence."""

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


def parse_cloudtrail_record(raw_line: str) -> tuple[dict, datetime]:
    """Validate CloudTrail identity and typed evidence while allowing sparse events."""
    try:
        record = json.loads(raw_line)
        # Reject nonstandard NaN/Infinity, including inside retained raw details.
        json.dumps(record, allow_nan=False)
    except (TypeError, ValueError) as error:
        raise ValueError("malformed_json") from error

    if not isinstance(record, dict):
        raise ValueError("record_not_object")

    for key in ("eventTime", "eventSource", "eventName", "eventID"):
        if not isinstance(record.get(key), str) or not record[key].strip():
            raise ValueError(f"invalid_{key}")

    identity = record.get("userIdentity")
    if not isinstance(identity, dict):
        raise ValueError("invalid_userIdentity")

    for key in ("requestParameters", "responseElements", "additionalEventData"):
        if record.get(key) is not None and not isinstance(record[key], dict):
            raise ValueError(f"invalid_{key}")

    context = identity.get("sessionContext")
    if context is not None and not isinstance(context, dict):
        raise ValueError("invalid_userIdentity_sessionContext")

    issuer = (context or {}).get("sessionIssuer")
    if issuer is not None and not isinstance(issuer, dict):
        raise ValueError("invalid_userIdentity_sessionContext_sessionIssuer")

    s3_parameters = (record.get("requestParameters") or {}) if record["eventSource"] == "s3.amazonaws.com" else {}

    for fields, container, prefix in (
        (("eventVersion", "awsRegion", "userAgent", "sourceIPAddress", "requestID",
          "recipientAccountId", "errorCode", "errorMessage"), record, ""),
        (("type", "arn", "accountId", "userName"), identity, "userIdentity_"),
        (("arn",), issuer or {}, "sessionIssuer_"),
        (("bucketName", "key", "prefix"), s3_parameters, "requestParameters_"),
        (("ConsoleLogin",), record.get("responseElements") or {}, "responseElements_"),
    ):
        for key in fields:
            if container.get(key) is not None and not isinstance(container[key], str):
                raise ValueError(f"invalid_{prefix}{key}")

    transferred = (record.get("additionalEventData") or {}).get("bytesTransferredOut")

    if transferred is not None and (type(transferred) is not int or not 0 <= transferred < 2 ** 63):
        raise ValueError("invalid_bytesTransferredOut")

    try:
        timestamp = datetime.fromisoformat(record["eventTime"].replace("Z", "+00:00"))
        if timestamp.tzinfo is None:
            raise ValueError("missing_timezone")

        timestamp = timestamp.astimezone(timezone.utc)
    except (ValueError, OverflowError) as error:
        raise ValueError("invalid_eventTime") from error

    return record, timestamp


def _vpc_integer(value: str | None, field: str, maximum: int, required: bool = False) -> int | None:
    """Parse an available unsigned VPC field within its normalized integer range."""
    if value is None:
        if required:
            raise ValueError(f"missing_{field}")
        return None

    if not value.isascii() or not value.isdecimal():
        raise ValueError(f"invalid_{field}")

    try:
        number = int(value)
    except ValueError as error:
        raise ValueError(f"invalid_{field}") from error

    if number > maximum:
        raise ValueError(f"invalid_{field}")
    return number


def parse_vpc_record(raw_line: str) -> tuple[dict, datetime]:
    """Validate the 14-field version-2 flow format and return its UTC start time.

    A positional ``-`` becomes null for unavailable native evidence. Version and
    start/end are required because unsupported versions and undated records
    cannot be safely mapped to the explicit schema and UTC output partitions.
    Account IDs remain strings, including AWS's ``unknown`` service-owned value.
    """
    if not isinstance(raw_line, str):
        raise ValueError("invalid_vpc_record")

    fields = (
        "flow_log_version", "account_id", "interface_id", "srcaddr", "dstaddr",
        "srcport", "dstport", "protocol", "packets", "bytes", "start", "end",
        "action", "log_status",
    )
    values = raw_line.split()
    if len(values) != len(fields):
        raise ValueError("invalid_vpc_field_count")

    record = {field: None if value == "-" else value for field, value in zip(fields, values)}
    record["flow_log_version"] = _vpc_integer(record["flow_log_version"], "flow_log_version", 2147483647, True)
    if record["flow_log_version"] != 2:
        raise ValueError("unsupported_flow_log_version")

    account_id = record["account_id"]
    if account_id not in (None, "unknown") and (
        len(account_id) != 12 or not account_id.isascii() or not account_id.isdecimal()
    ):
        raise ValueError("invalid_account_id")

    interface_id = record["interface_id"]
    if interface_id is not None and (
        not interface_id.startswith("eni-") or not interface_id[4:].isascii() or not interface_id[4:].isalnum()
    ):
        raise ValueError("invalid_interface_id")

    for field in ("srcaddr", "dstaddr"):
        if record[field] is not None:
            try:
                ip_address(record[field])
            except ValueError as error:
                raise ValueError(f"invalid_{field}") from error

    for field in ("srcport", "dstport"):
        record[field] = _vpc_integer(record[field], field, 65535)
    record["protocol"] = _vpc_integer(record["protocol"], "protocol", 255)
    for field in ("packets", "bytes", "start", "end"):
        record[field] = _vpc_integer(record[field], field, 9223372036854775807, field in ("start", "end"))

    timestamps = {}
    for field in ("start", "end"):
        try:
            timestamps[field] = datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=record[field])
        except (OverflowError, ValueError) as error:
            raise ValueError(f"invalid_{field}") from error

    if record["end"] < record["start"]:
        raise ValueError("end_before_start")
    if record["action"] not in (None, "ACCEPT", "REJECT"):
        raise ValueError("invalid_action")
    if record["log_status"] not in (None, "OK", "NODATA", "SKIPDATA"):
        raise ValueError("invalid_log_status")

    return record, timestamps["start"]
