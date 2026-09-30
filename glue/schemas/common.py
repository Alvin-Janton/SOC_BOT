"""OCSF-aligned fields shared by normalized source tables."""

COMMON_COLUMNS = (
    ("event_uid", "string"),
    ("event_time", "timestamp"),
    ("source_type", "string"),
    ("activity_name", "string"),
    ("activity_id", "string"),
    ("status", "string"),
    ("severity_id", "int"),
    ("severity", "string"),
    ("severity_source", "string"),
    ("src_ip", "string"),
    ("dst_ip", "string"),
    ("actor", "string"),
    ("resource", "string"),
    ("request_id", "string"),
    ("source_s3_key", "string"),
    ("source_record_ref", "string"),
    ("raw_event", "string"),
    ("schema_version", "int"),
)
