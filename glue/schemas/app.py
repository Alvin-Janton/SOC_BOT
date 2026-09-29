"""Application HTTP evidence columns retained for analyst queries."""

from schemas.common import COMMON_COLUMNS

APP_COLUMNS = COMMON_COLUMNS + (
    ("method", "string"),
    ("path", "string"),
    ("raw_url", "string"),
    ("query_string", "string"),
    ("body", "string"),
    ("query_params", "string"),
    ("body_params", "string"),
    ("headers", "string"),
    ("host", "string"),
    ("scheme", "string"),
    ("http_version", "string"),
    ("user_agent", "string"),
    ("session_id", "string"),
    ("status_code", "int"),
    ("latency_ms", "int"),
    ("response_bytes", "bigint"),
    ("source_dataset", "string"),
    ("source_geo", "string"),
    ("source_account_id", "string"),
    ("source_aws_region", "string"),
    ("source_environment", "string"),
    ("target_service", "string"),
    ("target_instance_id", "string"),
    ("alb_name", "string"),
)

PARTITION_COLUMNS = (("year", "string"), ("month", "string"), ("day", "string"))
