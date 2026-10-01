"""Dispatch raw JSONL by its supported S3 source path, without Spark dependencies."""

from datetime import date
from hashlib import sha256
import re
from urllib.parse import urlparse

from config import SUPPORTED_SOURCES
from transforms.app import normalize_application
from transforms.waf import normalize_waf
from validation import parse_application_record, parse_waf_record


def source_key(uri: str, expected_bucket: str | None = None) -> str:
    """Reject unknown source paths and return the traceable raw object key."""
    parsed = urlparse(uri)
    parts = parsed.path.split("/", 3)

    if (
        parsed.scheme not in {"s3", "s3a"} or not parsed.netloc or parsed.query or parsed.fragment
        or len(parts) != 4 or parts[1] != "raw" or parts[2] not in SUPPORTED_SOURCES or not parts[3]
        or any(segment in {".", "..", ""} for segment in parts[3].split("/"))
        or (expected_bucket is not None and parsed.netloc != expected_bucket)
    ):
        raise ValueError("Unexpected raw source URI")

    return parsed.path.lstrip("/")


def fallback_date(uri: str) -> date:
    """Recover a malformed record's quarantine date from its JSONL filename."""
    match = re.search(r"(?:^|/)(\d{4})-(\d{1,2})-(\d{1,2})\.jsonl$", uri)
    if not match:
        raise ValueError("Malformed record source lacks a dated JSONL filename")

    return date(*(int(part) for part in match.groups()))


def classify(line: str, uri: str, expected_bucket: str | None = None) -> tuple[str, str, dict]:
    """Return source, disposition, and normalized or existing-contract quarantine data."""
    key = source_key(uri, expected_bucket)
    source = key.split("/")[1]

    parser, normalizer = {
        "app": (parse_application_record, normalize_application),
        "waf": (parse_waf_record, normalize_waf),
    }[source]

    try:
        record, timestamp = parser(line)
        return source, "valid", normalizer(record, timestamp, key)

    except ValueError as error:
        day = fallback_date(uri)
        return source, "invalid", {
            "source_s3_key": key, "source_record_ref": sha256(f"{key}:{line}".encode()).hexdigest(),
            "error_code": str(error), "raw_event": line,
            "year": day.strftime("%Y"), "month": day.strftime("%m"), "day": day.strftime("%d"),
        }
