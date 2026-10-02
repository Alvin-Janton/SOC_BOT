"""Map validated WAF records to source-specific native evidence."""

from datetime import datetime
from hashlib import sha256
import json

from severity import waf_severity

WAF_EVIDENCE_FIELDS = {
    "timestamp": "timestamp", "format_version": "formatVersion",
    "web_acl_id": "webaclId", "action": "action",
    "terminating_rule_id": "terminatingRuleId", "terminating_rule_type": "terminatingRuleType",
    "response_code_sent": "responseCodeSent", "labels": "labels",
    "terminating_rule_match_details": "terminatingRuleMatchDetails",
    "non_terminating_matching_rules": "nonTerminatingMatchingRules",
    "rule_group_list": "ruleGroupList", "rate_based_rule_list": "rateBasedRuleList",
    "http_source_name": "httpSourceName", "http_source_id": "httpSourceId",
}
JSON_FIELDS = {
    "labels", "terminating_rule_match_details", "non_terminating_matching_rules",
    "rule_group_list", "rate_based_rule_list",
}
def normalize_waf(record: dict, timestamp: datetime, source_key: str) -> dict:
    """Preserve each input occurrence with native rule, request, and object provenance.

    Example Input:
    {
    "timestamp": 1788264245000,
    "event_time": "2026-09-01T12:04:05Z",
    "action": "BLOCK",
    "terminatingRuleId": "SQLiRule",
    "terminatingRuleType": "REGULAR",
    "terminatingRuleMatchDetails": [
        {
            "conditionType": "SQL_INJECTION",
            "location": "QUERY_STRING",
            "matchedData": ["UNION SELECT"],
        }
    ],
    "responseCodeSent": 403,
    "httpRequest": {
        "requestId": "req-001",
        "clientIp": "198.51.100.10",
        "httpMethod": "GET",
        "uri": "/search",
        "args": "q=UNION+SELECT",
        "headers": [],
    },
    datetime(2026, 9, 7, 18, 12, 6, tzinfo=timezone.utc),
    "raw/waf/WEEK_2/2026-9-07.jsonl"
    }

    Example Output:
    {
    "event_uid": "<SHA-256 of source type, object key, and request ID>",
    "event_time": datetime(2026, 9, 1, 12, 4, 5),
    "source_type": "waf",
    "activity_name": "WAF BLOCK",
    "activity_id": "waf_block",
    "status": "blocked",

    "severity_id": 3,
    "severity": "Medium",
    "severity_source": (
        '{"action":"BLOCK","evidence":{'
        '"terminatingRuleId":"SQLiRule",'
        '"terminatingRuleMatchDetails":[{'
        '"conditionType":"SQL_INJECTION",'
        '"location":"QUERY_STRING",'
        '"matchedData":["UNION SELECT"]}],'
        '"terminatingRuleType":"REGULAR"},'
        '"rule":"blocked_rule_match","rule_version":"waf_rules_v1"}'
    ),

    "src_ip": "198.51.100.10",
    "resource": "/search",
    "request_id": "req-001",
    "source_s3_key": "raw/waf/WEEK_1/2026-9-01.jsonl",
    "source_record_ref": "req-001",

    "timestamp": 1788264245000,
    "action": "BLOCK",
    "terminating_rule_id": "SQLiRule",
    "terminating_rule_type": "REGULAR",
    "response_code_sent": 403,
    "method": "GET",
    "path": "/search",
    "query_string": "q=UNION+SELECT",
    "headers": "[]",

    "schema_version": 1,
    "year": "2026",
    "month": "09",
    "day": "01",

    # Additional evidence columns and raw_event omitted here.
    }
    """
    score, label, severity_source = waf_severity(record)
    request = record["httpRequest"]
    request_id = request["requestId"]
    safe_raw = {key: record[key] for key in WAF_EVIDENCE_FIELDS.values() if key in record}
    safe_raw["httpRequest"] = {
        key: request[key] for key in (
            "requestId", "clientIp", "httpMethod", "uri", "args", "country", "headers", "httpVersion",
        ) if key in request
    }
    result = {
        "event_uid": sha256(f"waf:{source_key}:{request_id}".encode()).hexdigest(),
        "event_time": timestamp.replace(tzinfo=None), "source_type": "waf",
        "activity_name": f"WAF {record['action']}", "activity_id": f"waf_{record['action'].lower()}",
        "status": {"ALLOW": "allowed", "BLOCK": "blocked"}.get(record["action"], "unknown"),
        "severity_id": score, "severity": label, "severity_source": severity_source,
        "src_ip": request["clientIp"], "dst_ip": None, "actor": None,
        "resource": request["uri"], "request_id": request_id,
        "source_s3_key": source_key, "source_record_ref": request_id,
        "raw_event": json.dumps(safe_raw, ensure_ascii=False, sort_keys=True, allow_nan=False), "schema_version": 1,
    }

    for column, field in WAF_EVIDENCE_FIELDS.items():
        value = record.get(field)
        result[column] = (
            json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)
            if column in JSON_FIELDS and value is not None else value
        )

    for column, field in (
        ("method", "httpMethod"), ("path", "uri"), ("query_string", "args"),
        ("country", "country"), ("http_version", "httpVersion"),
    ):
        result[column] = request.get(field)

    result["headers"] = json.dumps(request.get("headers", []), ensure_ascii=False, sort_keys=True, allow_nan=False)
    result.update(year=timestamp.strftime("%Y"), month=timestamp.strftime("%m"), day=timestamp.strftime("%d"))
    return result
