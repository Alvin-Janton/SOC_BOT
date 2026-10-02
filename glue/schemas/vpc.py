"""Version-2 VPC flow evidence retained separately from HTTP source tables."""

from schemas.common import COMMON_COLUMNS

VPC_COLUMNS = COMMON_COLUMNS + (
    ("flow_log_version", "int"),
    ("account_id", "string"),
    ("interface_id", "string"),
    ("srcaddr", "string"),
    ("dstaddr", "string"),
    ("srcport", "int"),
    ("dstport", "int"),
    ("protocol", "int"),
    ("packets", "bigint"),
    ("bytes", "bigint"),
    ("start", "bigint"),
    ("end", "bigint"),
    ("action", "string"),
    ("log_status", "string"),
)
