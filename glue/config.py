"""Validated arguments for the on-demand application normalization job."""

from dataclasses import dataclass
from datetime import date
import re
import sys

from awsglue.utils import getResolvedOptions


@dataclass(frozen=True)
class JobConfig:
    """Hold the validated S3 locations, run mode, dates, and rejection limit."""

    input_prefix: str
    output_prefix: str
    quarantine_prefix: str
    mode: str
    dates: frozenset[str]
    max_invalid_fraction: float


def parse_config() -> JobConfig:
    """Read Glue job arguments and reject unsupported or unsafe input locations."""

    required = [
        "JOB_NAME", "input_prefix", "output_prefix", "quarantine_prefix",
        "mode", "schema_version", "max_invalid_fraction",
    ]

    arguments = getResolvedOptions(sys.argv, required)
    if arguments["schema_version"] != "1":
        raise ValueError("Only normalized schema version 1 is supported")

    mode = arguments["mode"]
    if mode not in {"full", "incremental"}:
        raise ValueError("mode must be full or incremental")

    optional = getResolvedOptions(sys.argv, ["dates"])["dates"] if "--dates" in sys.argv else ""
    dates = frozenset(value.strip() for value in optional.split(",") if value.strip())

    for value in dates:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) or date.fromisoformat(value).isoformat() != value:
            raise ValueError("dates must be comma-separated UTC dates in YYYY-MM-DD format")

    if mode == "incremental" and not dates:
        raise ValueError("incremental mode requires --dates")

    if mode == "full" and dates:
        raise ValueError("full mode must not specify --dates")

    threshold = float(arguments["max_invalid_fraction"])
    if not 0 <= threshold <= 1:
        raise ValueError("max-invalid-fraction must be between 0 and 1")

    for key, suffix in [
        ("input_prefix", "/raw/app/"),
        ("output_prefix", "/normalized/app/"),
        ("quarantine_prefix", "/quarantine/app/"),
    ]:
        prefix = arguments[key]
        if not prefix.startswith("s3://") or not prefix.endswith(suffix):
            raise ValueError(f"{key} must be an S3 URI ending in {suffix}")

    buckets = {arguments[key].split("/", 3)[2] for key in (
        "input_prefix", "output_prefix", "quarantine_prefix",
    )}
    if len(buckets) != 1:
        raise ValueError("all data prefixes must use the same bucket")
    return JobConfig(
        input_prefix=arguments["input_prefix"],
        output_prefix=arguments["output_prefix"],
        quarantine_prefix=arguments["quarantine_prefix"],
        mode=mode,
        dates=dates,
        max_invalid_fraction=threshold,
    )
