"""Initial deterministic application severity rules; revise in a later pass."""

import re
from urllib.parse import unquote_plus

RULE_VERSION = "app_rules_v1"
LABELS = ("Unknown", "Informational", "Low", "Medium", "High", "Critical")

_XSS = re.compile(r"<\s*script\b|onerror\s*=|onload\s*=|javascript\s*:", re.I)
_SQLI = re.compile(r"\bunion\s+select\b|\bor\s+1\s*=\s*1\b|\bdrop\s+table\b", re.I)
_CRLF = re.compile(r"[\r\n]|%0[ad]", re.I)
_FILE = re.compile(r"(?:\.\./|/etc/passwd\b|/\.env\b|/\.git/|/wp-config\.php\b)", re.I)
_COMMAND = re.compile(r"(?:#exec\s+cmd\s*=|;\s*cat\s+/etc/passwd\b)", re.I)


def application_severity(record: dict) -> tuple[int, str, str]:
    """Rate observable request content and response only, never synthetic labels."""
    encoded = " ".join(str(record.get(key) or "") for key in ("path", "query_string", "body"))
    evidence = unquote_plus(encoded)
    status = record["status_code"]

    if _XSS.search(evidence) or _SQLI.search(evidence) or _CRLF.search(evidence) or _FILE.search(evidence) or _COMMAND.search(evidence):
        score = 4 if 200 <= status < 400 else 3
        rule = "suspicious_request_allowed" if score == 4 else "suspicious_request_rejected"

    elif status >= 500:
        score, rule = 2, "server_error"

    elif status in (401, 403):

        score, rule = 2, "authentication_or_access_denied"
    else:
        score, rule = 1, "routine_request"
        
    return score, LABELS[score], f"{RULE_VERSION}:{rule}"
