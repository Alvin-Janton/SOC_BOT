"""Map validated application records into the normalized evidence contract."""

from hashlib import sha256
import json

from severity import application_severity


def normalize_application(record: dict, timestamp, source_key: str) -> dict:
    """Normalize a validated application log into one analyst-facing event.

    Example Input:

    {
    "event_time": "2026-09-07T18:12:06Z",
    "request_id": "req-001",
    "method": "GET",
    "path": "/search",
    "raw_url": "https://example.test/search?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
    "query_string": "q=%3Cscript%3Ealert(1)%3C%2Fscript%3E",
    "body": "",
    "source_ip": "198.51.100.10",
    "status_code": 200,
    "is_malicious": True,       # synthetic label
    "attack_category": "xss",  # synthetic label
},
    datetime(2026, 9, 7, 18, 12, 6, tzinfo=timezone.utc),
    "raw/app/WEEK_2/2026-9-07.jsonl"

Example Output (matches abbreviated):
    {
    "event_uid": "<stable 64-character SHA-256 identifier>",
    "event_time": datetime(2026, 9, 7, 18, 12, 6),
    "source_type": "app",
    "activity_name": "HTTP GET",
    "activity_id": "app_http_get",
    "status": "success",
    "severity_id": 4,
    "severity": "High",
    "severity_source": '{"rule_version":"app_rules_v2",'
                       '"rule":"suspicious_request_http_200",'
                       '"matches":[{"attack_type":"xss",'
                       '"indicator":"script_tag","location":"query_string"}]}',
    "src_ip": "198.51.100.10",
    "request_id": "req-001",
    "source_s3_key": "raw/app/WEEK_2/2026-9-07.jsonl",
    "source_record_ref": "req-001",
    "schema_version": 1,
    "year": "2026",
    "month": "09",
    "day": "07",
    # Plus HTTP evidence fields and optional fields...
}
    """

    severity_id, severity, severity_source = application_severity(record)
    request_id = record["request_id"]
    status_code = record["status_code"]
    safe_raw = {
        key: record.get(key)
        for key in ("raw_request_line", "query_string", "body", "headers")
        if key in record
    }

    result = {
        "event_uid": sha256(f"app:{source_key}:{request_id}".encode()).hexdigest(),
        "event_time": timestamp.replace(tzinfo=None),
        "source_type": "app",
        "activity_name": f"HTTP {record['method'].upper()}",
        "activity_id": f"app_http_{record['method'].lower()}",
        "status": "success" if status_code < 400 else "failure",
        "severity_id": severity_id,
        "severity": severity,
        "severity_source": severity_source,
        "src_ip": record.get("source_ip"),
        "dst_ip": None,
        "actor": record.get("session_id"),
        "resource": record.get("raw_url") or record["path"],
        "request_id": request_id,
        "source_s3_key": source_key,
        "source_record_ref": request_id,
        "raw_event": json.dumps(safe_raw, ensure_ascii=False, sort_keys=True),
        "schema_version": 1,
    }

    for key in (
        "method", "path", "raw_url", "query_string", "body", "host", "scheme",
        "http_version", "user_agent", "session_id", "status_code", "latency_ms",
        "response_bytes", "source_dataset", "target_service", "target_instance_id", "alb_name",
    ):
        result[key] = record.get(key)

    for key in ("query_params", "body_params", "headers", "source_geo"):
        value = record.get(key)
        result[key] = json.dumps(value, ensure_ascii=False, sort_keys=True) if value is not None else None
    result["source_account_id"] = record.get("account_id")
    result["source_aws_region"] = record.get("aws_region")
    result["source_environment"] = record.get("environment")
    result.update(year=timestamp.strftime("%Y"), month=timestamp.strftime("%m"), day=timestamp.strftime("%d"))
    return result
