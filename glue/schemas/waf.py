"""WAF-native request and rule evidence retained in the normalized WAF table."""

from schemas.common import COMMON_COLUMNS

WAF_COLUMNS = COMMON_COLUMNS + (
    ("timestamp", "bigint"),
    ("format_version", "int"),
    ("web_acl_id", "string"),
    ("action", "string"),
    ("terminating_rule_id", "string"),
    ("terminating_rule_type", "string"),
    ("response_code_sent", "int"),
    ("labels", "string"),
    ("terminating_rule_match_details", "string"),
    ("non_terminating_matching_rules", "string"),
    ("rule_group_list", "string"),
    ("rate_based_rule_list", "string"),
    ("http_source_name", "string"),
    ("http_source_id", "string"),
    ("method", "string"),
    ("path", "string"),
    ("query_string", "string"),
    ("country", "string"),
    ("headers", "string"),
    ("http_version", "string"),
)
