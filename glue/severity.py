"""Versioned application severity from independently inspected request evidence."""

import json
import re
from collections.abc import Iterator
from urllib.parse import unquote_plus

RULE_VERSION = "app_rules_v2"
LABELS = ("Unknown", "Informational", "Low", "Medium", "High", "Critical")

# Adapted from the local CSIC extractor; a bare URL fragment or comment marker
# is insufficient SQL evidence. Patterns never combine unrelated request fields.
# HTML/SSI comment terminators (-->), including command payloads, are not SQL.
_SIGNATURES = tuple(
    (attack_type, indicator, re.compile(pattern, re.I | re.DOTALL))
    for attack_type, indicator, pattern in (
        ("sqli", "drop_table", r"\bdrop\s+table\b"),
        ("sqli", "union_select", r"\bunion\s+(?:all\s+)?select\b"),
        ("sqli", "select_from", r"\bselect\b.{0,80}\bfrom\b"),
        ("sqli", "sql_comment", r"(?:['\"]|;)\s*(?:--(?!>)|#|/\*)|\b(?:select|union|drop|insert|update|delete)\b[^\r\n]{0,80}(?:--(?!>)|/\*)"),
        ("sqli", "quoted_or", r"['\"]\s*(?:or|and)\s+['\"]?\w+['\"]?\s*=\s*['\"]?\w+"),
        ("sqli", "or_tautology", r"\bor\s+1\s*=\s*1\b"),
        ("sqli", "information_schema", r"\binformation_schema\b"),
        ("sqli", "sql_sleep", r"\b(?:sleep|benchmark)\s*\("),
        ("xss", "script_tag", r"(?:<\s*/?\s*script\b|%3c\s*/?\s*script\b)"),
        ("xss", "encoded_script_tag", r"%3c(?:%2f)?script"),
        ("xss", "alert_call", r"\balert\s*\("),
        ("xss", "javascript_uri", r"javascript\s*:"),
        ("xss", "event_handler", r"\bon(?:error|load|mouseover|focus|click)\s*="),
        ("xss", "iframe_tag", r"(?:<\s*iframe\b|%3ciframe\b)"),
        ("crlf", "encoded_crlf", r"%0d%0a"),
        ("crlf", "double_encoded_crlf", r"%250d%250a"),
        ("crlf", "encoded_lf", r"%0a"),
        ("crlf", "double_encoded_lf", r"%250a"),
        ("crlf", "encoded_cr", r"%0d"),
        ("crlf", "double_encoded_cr", r"%250d"),
        ("crlf", "header_injection", r"[\r\n]+[ \t]*(?:set-cookie|location|content-length|content-type|refresh|x-[a-z0-9-]+)\s*:"),
        ("sensitive_file_access", "web_inf", r"(?:/|\\|\b)WEB-INF(?:/|\\|%2f|%5c)"),
        ("sensitive_file_access", "meta_inf", r"(?:/|\\|\b)META-INF(?:/|\\|%2f|%5c)"),
        ("sensitive_file_access", "web_xml", r"\bweb\.xml\b"),
        ("sensitive_file_access", "etc_passwd", r"(?:/|\\)etc(?:/|\\)passwd\b|%2fetc%2fpasswd"),
        ("sensitive_file_access", "etc_shadow", r"(?:/|\\)etc(?:/|\\)shadow\b|%2fetc%2fshadow"),
        ("sensitive_file_access", "windows_ini", r"\b(?:win\.ini|boot\.ini)\b"),
        ("sensitive_file_access", "backup_probe", r"\.(?:bak|old|backup|orig|swp)(?:$|[?&#\s])|~(?:$|[?&#\s])"),
        ("sensitive_file_access", "path_traversal", r"\.\.[/\\]"),
        ("sensitive_file_access", "dotenv", r"[/\\]\.env\b"),
        ("sensitive_file_access", "git_directory", r"[/\\]\.git[/\\]"),
        ("sensitive_file_access", "wp_config", r"[/\\]wp-config\.php\b"),
        ("command_execution", "ssi_exec", r"#exec\s+cmd\s*="),
        ("command_execution", "cat_passwd", r";\s*cat\s+/etc/passwd\b"),
    )
)


def _safe_evidence_key(key: object) -> bool:
    """
    decides whether a dictionary key can be shown by name in a matched location.
    It returns True only when all three conditions pass:

    1. The key is a Python string.
    2. It matches [A-Za-z_][A-Za-z0-9_-]{0,63}: between 1 and 64 characters, starting with a letter or underscore, followed only by ASCII letters, digits, underscores, or hyphens.
    3. None of the attack signatures match the key itself.

    The collector then uses a safe name like body_params.login[0],
    or falls back to an indexed location like body_params[3].value[0].
    """
    return (
        isinstance(key, str)
        and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,63}", key) is not None
        and not any(pattern.search(key) for _, _, pattern in _SIGNATURES)
    )


def _evidence_values(value, location: str) -> Iterator[tuple[str, str]]:
    """Yield separate keys/values with safe names or positional fallback locations."""
    if isinstance(value, dict):
        for index, (key, item) in enumerate(value.items()):
            if _safe_evidence_key(key):
                entry_location = f"{location}.{key}"
                yield from _evidence_values(key, f"{entry_location}.key")
                yield from _evidence_values(item, entry_location)

            else:
                yield from _evidence_values(key, f"{location}[{index}].key")
                yield from _evidence_values(item, f"{location}[{index}].value")

    elif isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            yield from _evidence_values(item, f"{location}[{index}]")

    elif value is not None:
        yield location, str(value)


def request_evidence(record: dict) -> Iterator[tuple[str, str]]:
    """Collect only observed request fields, never synthetic classification fields."""
    for field in (
        "path", "raw_url", "query_string", "body", "raw_request_line",
        "headers", "query_params", "body_params",
    ):
        yield from _evidence_values(record.get(field), field)


def _decoded_forms(value: str) -> Iterator[str]:
    """Yield the original evidence and at most three successive URL decodings."""
    yield value
    for _ in range(3):
        decoded = unquote_plus(value)
        if decoded == value:
            break
        yield decoded
        value = decoded


def request_matches(record: dict) -> list[dict[str, str]]:
    """Deduplicate every category/signature/location match without storing payloads."""
    matches = set()
    for location, original in request_evidence(record):
        # A normal request-line terminator is framing, not header injection.
        if location == "raw_request_line":
            original = original.rstrip("\r\n")

        for value in _decoded_forms(original):
            for attack_type, indicator, pattern in _SIGNATURES:
                if pattern.search(value):
                    matches.add((attack_type, indicator, location))

            # Body text can legitimately contain newlines. In a URL, parameter
            # from the query, or header they violate the expected field format.
            if location.startswith(("path", "raw_url", "query_string", "query_params", "headers", "raw_request_line")) and re.search(r"[\r\n]", value):
                matches.add(("crlf", "literal_newline", location))

    return [
        {"attack_type": attack_type, "indicator": indicator, "location": location}
        for attack_type, indicator, location in sorted(matches)
    ]


def application_severity(record: dict) -> tuple[int, str, str]:
    """Rate observable request content and response only, never synthetic labels."""
    matches = request_matches(record)
    status = record["status_code"]

    if matches:
        score = 4 if status == 200 else 3
        rule = "suspicious_request_http_200" if score == 4 else "suspicious_request_other_status"

    elif status >= 500:
        score, rule = 2, "server_error"

    elif status in (401, 403):
        score, rule = 2, "authentication_or_access_denied"

    else:
        score, rule = 1, "routine_request"

    source = json.dumps(
        {"rule_version": RULE_VERSION, "rule": rule, "matches": matches},
        separators=(",", ":"),
    )
    return score, LABELS[score], source
