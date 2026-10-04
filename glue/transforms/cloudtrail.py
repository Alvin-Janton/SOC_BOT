"""Map validated CloudTrail events to API evidence with source-native provenance."""

from datetime import datetime, timezone
from hashlib import sha256
import json
import re

from severity import cloudtrail_severity, cloudtrail_status


def normalize_cloudtrail(record: dict, timestamp: datetime, source_key: str) -> dict:
    """Preserve an event's identity, sparse API details, and original JSON evidence.

    Example Input:
  {
  "eventVersion": "1.08",
  "eventTime": "2026-09-25T18:30:37Z",
  "eventSource": "s3.amazonaws.com",
  "eventName": "GetObject",
  "eventID": "event-001",
  "requestID": "request-001",
  "awsRegion": "us-east-1",
  "sourceIPAddress": "203.0.113.77",
  "userAgent": "aws-cli/2.0",
  "userIdentity": {
    "type": "IAMUser",
    "arn": "arn:aws:iam::123456789012:user/example-user",
    "accountId": "123456789012",
    "userName": "example-user"
  },
  "requestParameters": {
    "bucketName": "example-evidence-bucket",
    "key": "reports/report.csv"
  },
  "responseElements": null,
  "additionalEventData": {
    "bytesTransferredOut": 2048
  }
  },
  datetime(2026, 9, 7, 18, 12, 6, tzinfo=timezone.utc),
  "raw/cloudtrail/WEEK_2/2026-9-07.jsonl"

  Example Output:

  {
  "event_uid": "<SHA-256 of source type, source key, and event ID>",
  "event_time": "2026-09-25T18:30:37Z",
  "source_type": "cloudtrail",
  "activity_name": "GetObject",
  "activity_id": "s3_getobject",
  "status": "success",

  "severity_id": 5,
  "severity": "Critical",
  "severity_source": "<JSON text explaining the indicator match and rule>",

  "src_ip": "203.0.113.77",
  "dst_ip": null,
  "actor": "arn:aws:iam::123456789012:user/example-user",
  "resource": "s3://example-evidence-bucket/reports/report.csv",
  "request_id": "request-001",

  "source_s3_key": "raw/cloudtrail/2026-9-25.jsonl",
  "source_record_ref": "event-001",
  "raw_event": "<complete original input serialized as JSON text>",
  "schema_version": 1,

  "event_version": "1.08",
  "event_source": "s3.amazonaws.com",
  "event_name": "GetObject",
  "aws_region": "us-east-1",
  "user_agent": "aws-cli/2.0",
  "identity_type": "IAMUser",
  "identity_account_id": "123456789012",
  "identity_user_name": "example-user",
  "error_code": null,
  "error_message": null,
  "s3_bucket_name": "example-evidence-bucket",
  "s3_object_key": "reports/report.csv",
  "s3_prefix": null,
  "bytes_transferred_out": 2048,

  "year": "2026",
  "month": "09",
  "day": "25"
  }

    """
    timestamp = timestamp.astimezone(timezone.utc)
    identity = record["userIdentity"]
    parameters = (record.get("requestParameters") or {}) if record["eventSource"] == "s3.amazonaws.com" else {}
    additional = record.get("additionalEventData") or {}
    score, label, severity_source = cloudtrail_severity(record)
    resource = None
    native_resources = record.get("resources")

    if isinstance(native_resources, list):
        resource = next((item["ARN"] for item in native_resources if isinstance(item, dict)
                         and isinstance(item.get("ARN"), str) and item["ARN"]), None)

    if resource is None and parameters.get("bucketName"):
        resource = f"s3://{parameters['bucketName']}"
        if parameters.get("key"):
            resource += f"/{parameters['key']}"

    service = record["eventSource"].removesuffix(".amazonaws.com")
    activity = re.sub(r"[^a-z0-9]+", "_", f"{service}_{record['eventName']}".lower()).strip("_")
    result = {
        "event_uid": sha256(f"cloudtrail:{source_key}:{record['eventID']}".encode()).hexdigest(),
        "event_time": timestamp.replace(tzinfo=None), "source_type": "cloudtrail",
        "activity_name": record["eventName"], "activity_id": activity,
        "status": cloudtrail_status(record),
        "severity_id": score, "severity": label, "severity_source": severity_source,
        "src_ip": record.get("sourceIPAddress"), "dst_ip": None,
        "actor": identity.get("arn") or identity.get("userName") or None,
        "resource": resource, "request_id": record.get("requestID"),
        "source_s3_key": source_key, "source_record_ref": record["eventID"],
        "raw_event": json.dumps(record, ensure_ascii=False, sort_keys=True, allow_nan=False),
        "schema_version": 1,
        "event_version": record.get("eventVersion"), "event_source": record["eventSource"],
        "event_name": record["eventName"], "aws_region": record.get("awsRegion"),
        "user_agent": record.get("userAgent"), "identity_type": identity.get("type"),
        "identity_account_id": identity.get("accountId") or record.get("recipientAccountId"),
        "identity_user_name": identity.get("userName"),
        "error_code": record.get("errorCode"), "error_message": record.get("errorMessage"),
        "s3_bucket_name": parameters.get("bucketName"), "s3_object_key": parameters.get("key"),
        "s3_prefix": parameters.get("prefix"), "bytes_transferred_out": additional.get("bytesTransferredOut"),
    }
    result.update(year=timestamp.strftime("%Y"), month=timestamp.strftime("%m"), day=timestamp.strftime("%d"))
    return result
