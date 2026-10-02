"""Map validated VPC flows to informational network evidence and line provenance."""

from datetime import datetime, timezone
from hashlib import sha256
import json

from schemas.common import COMMON_COLUMNS
from schemas.vpc import VPC_COLUMNS


def normalize_vpc(record: dict, timestamp: datetime, source_key: str, line_number: int, raw_line: str) -> dict:
    """Preserve one flow occurrence with its exact source object and 1-based line.

    Severity stays informational: network acceptance/rejection, IP addresses,
    and flow counters alone do not establish maliciousness. An account owns
    the interface rather than identifying a request actor, so actor is null.

    Example Input:
    {
    "flow_log_version": 2,
    "account_id": "123456789012",
    "interface_id": "eni-abc123",
    "srcaddr": "198.51.100.10",
    "dstaddr": "10.0.2.25",
    "srcport": 54321,
    "dstport": 443,
    "protocol": 6,
    "packets": 10,
    "bytes": 8000,
    "start": 1788264240,
    "end": 1788264300,
    "action": "ACCEPT",
    "log_status": "OK",
    },
    datetime(2026, 9, 7, 18, 12, 6, tzinfo=timezone.utc),
    "raw/vpc/WEEK_2/2026-9-07.jsonl",
    1,
    2 123456789012 eni-abc123 198.51.100.10 10.0.2.25 54321 443 6 10 8000 1788264240 1788264300 ACCEPT OK

    Example Output:
    {
    "event_uid": "7eec232884de810fe34a15807348bd66a290f0ac1ac00c8e228770cacd053785",
    "event_time": datetime(2026, 9, 1, 12, 4),
    "source_type": "vpc_flow",
    "activity_name": "VPC Flow ACCEPT",
    "activity_id": "vpc_flow_accept",
    "status": "allowed",
    "severity_id": 1,
    "severity": "Informational",
    "severity_source": (
        '{"reason":"Flow action and IP addresses alone do not establish maliciousness",'
        '"rule":"flow_context_only","rule_version":"vpc_rules_v1"}'
    ),
    "src_ip": "198.51.100.10",
    "dst_ip": "10.0.2.25",
    "actor": None,
    "resource": "eni-abc123",
    "request_id": None,
    "source_s3_key": "raw/vpc/2026-9-01.log",
    "source_record_ref": "1",
    "raw_event": raw_line,
    "schema_version": 1,

    # Original parsed VPC fields are retained.
    "flow_log_version": 2,
    "account_id": "123456789012",
    "interface_id": "eni-abc123",
    "srcaddr": "198.51.100.10",
    "dstaddr": "10.0.2.25",
    "srcport": 54321,
    "dstport": 443,
    "protocol": 6,
    "packets": 10,
    "bytes": 8000,
    "start": 1788264240,
    "end": 1788264300,
    "action": "ACCEPT",
    "log_status": "OK",

    # Helpers used to select the output partition.
    "year": "2026",
    "month": "09",
    "day": "01",
    }

    """
    if type(line_number) is not int or line_number < 1:
        raise ValueError("invalid_source_line_number")

    timestamp = timestamp.astimezone(timezone.utc)
    action = record["action"]
    result = {
        "event_uid": sha256(f"vpc:{source_key}:{line_number}:{raw_line}".encode()).hexdigest(),
        "event_time": timestamp.replace(tzinfo=None), "source_type": "vpc_flow",
        "activity_name": f"VPC Flow {action or 'UNKNOWN'}",
        "activity_id": f"vpc_flow_{(action or 'unknown').lower()}",
        "status": {"ACCEPT": "allowed", "REJECT": "blocked"}.get(action, "unknown"),
        "severity_id": 1, "severity": "Informational",
        "severity_source": json.dumps({
            "rule_version": "vpc_rules_v1", "rule": "flow_context_only",
            "reason": "Flow action and IP addresses alone do not establish maliciousness",
        }, sort_keys=True, separators=(",", ":")),
        "src_ip": record["srcaddr"], "dst_ip": record["dstaddr"], "actor": None,
        "resource": record["interface_id"], "request_id": None,
        "source_s3_key": source_key, "source_record_ref": str(line_number),
        "raw_event": raw_line, "schema_version": 1,
    }
    for column, _ in VPC_COLUMNS[len(COMMON_COLUMNS):]:
        result[column] = record[column]
    result.update(year=timestamp.strftime("%Y"), month=timestamp.strftime("%m"), day=timestamp.strftime("%d"))
    return result
