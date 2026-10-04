"""CloudTrail identity, API, and S3 evidence alongside the common envelope."""

from schemas.common import COMMON_COLUMNS

CLOUDTRAIL_COLUMNS = COMMON_COLUMNS + (
    ("event_version", "string"),
    ("event_source", "string"),
    ("event_name", "string"),
    ("aws_region", "string"),
    ("user_agent", "string"),
    ("identity_type", "string"),
    ("identity_account_id", "string"),
    ("identity_user_name", "string"),
    ("error_code", "string"),
    ("error_message", "string"),
    ("s3_bucket_name", "string"),
    ("s3_object_key", "string"),
    ("s3_prefix", "string"),
    ("bytes_transferred_out", "bigint"),
)
