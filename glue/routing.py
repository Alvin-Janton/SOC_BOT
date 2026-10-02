"""Dispatch raw JSONL and VPC text by source path, without Spark dependencies."""

from datetime import date
from hashlib import sha256
from io import StringIO
import re
from typing import Iterator
from urllib.parse import urlparse

from config import SUPPORTED_SOURCES
from transforms.app import normalize_application
from transforms.waf import normalize_waf
from transforms.vpc import normalize_vpc
from validation import parse_application_record, parse_waf_record, parse_vpc_record


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
    """Recover a malformed record's quarantine date from its dated source filename."""
    match = re.search(r"(?:^|/)(\d{4})-(\d{1,2})-(\d{1,2})\.(?:jsonl|log)$", uri)
    if not match:
        raise ValueError("Malformed record source lacks a dated JSONL or log filename")

    return date(*(int(part) for part in match.groups()))


def classify(line: str, uri: str, expected_bucket: str | None = None, line_number: int | None = None) -> tuple[str, str, dict]:
    """Return source, disposition, and normalized or existing-contract quarantine data."""
    key = source_key(uri, expected_bucket)
    source = key.split("/")[1]

    if source == "vpc":
        # Missing object-relative provenance is a reader error, not an invalid log.
        if type(line_number) is not int or line_number < 1:
            raise ValueError("VPC records require a positive object-relative line number")

        try:
            record, timestamp = parse_vpc_record(line)
            return source, "valid", normalize_vpc(record, timestamp, key, line_number, line)

        except ValueError as error:
            day = fallback_date(uri)
            return source, "invalid", {
                "source_s3_key": key, "source_record_ref": str(line_number),
                "error_code": str(error), "raw_event": line,
                "year": day.strftime("%Y"), "month": day.strftime("%m"), "day": day.strftime("%d"),
            }

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


def classify_vpc_object(content: str, uri: str, expected_bucket: str | None = None) -> Iterator[tuple[str, str, dict]]:
    """Number every physical VPC line within its object, retaining blanks and terminators."""
    key = source_key(uri, expected_bucket)
    if key.split("/")[1] != "vpc" or not key.endswith(".log"):
        raise ValueError("VPC object reader requires a raw/vpc/ .log object")
        
    # Whole-object enumeration is stable across Spark task/split ordering. Universal
    # newline handling retains original LF/CRLF/CR delimiters in raw_event.
    with StringIO(content, newline="") as stream:
        for line_number, line in enumerate(stream, 1):
            yield classify(line, uri, expected_bucket, line_number=line_number)
