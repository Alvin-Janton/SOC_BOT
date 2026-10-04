"""Map validated CloudTrail events to API evidence with source-native provenance."""

from datetime import datetime, timezone
from hashlib import sha256
import json
import re

from severity import cloudtrail_severity, cloudtrail_status


def normalize_cloudtrail(record: dict, timestamp: datetime, source_key: str) -> dict:
    """Preserve an event's identity, sparse API details, and original JSON evidence."""
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
