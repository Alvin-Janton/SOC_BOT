"""Validated arguments for the shared, on-demand normalization job."""

from dataclasses import dataclass
from datetime import date
import re
import sys
from urllib.parse import urlparse

SUPPORTED_SOURCES = ("app", "waf")


@dataclass(frozen=True)
class JobConfig:
    """Hold the validated S3 locations, run mode, dates, and rejection limit."""

    input_prefix: str
    output_prefix: str
    quarantine_prefix: str
    mode: str
    dates: frozenset[str]
    max_invalid_fraction: float

    @property
    def sources(self) -> tuple[str, ...]:
        """Select both supported sources or only the explicitly requested one."""
        key = urlparse(self.input_prefix).path.strip("/")
        return SUPPORTED_SOURCES if key == "raw" else (key.split("/")[1],)

    def source_input(self, source: str) -> str:
        """Return a supported source root without listing the shared raw root."""
        if source not in self.sources:
            raise ValueError("Source is outside the selected input scope")

        bucket = urlparse(self.input_prefix).netloc
        return f"s3://{bucket}/raw/{source}/"


def validate_prefixes(arguments: dict[str, str]) -> dict[str, str]:
    """Validate exact S3 roots, normalize trailing slashes, and enforce one bucket."""
    allowed = {
        "input_prefix": {"raw", "raw/app", "raw/waf"},
        "output_prefix": {"normalized"},
        "quarantine_prefix": {"quarantine"},
    }
    result = {}
    buckets = set()
    for name, keys in allowed.items():
        parsed = urlparse(arguments[name])
        key = parsed.path.removesuffix("/").removeprefix("/")

        if (
            parsed.scheme != "s3" or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", parsed.netloc)
            or parsed.query or parsed.fragment or key not in keys
        ):
            raise ValueError(f"{name} must be an S3 URI with an approved root: {sorted(keys)}")

        result[name] = f"s3://{parsed.netloc}/{key}/"
        buckets.add(parsed.netloc)

    if len(buckets) != 1:
        raise ValueError("all data prefixes must use the same bucket")

    return result


def parse_config() -> JobConfig:
    """Read Glue job arguments and reject unsupported or unsafe input locations."""

    from awsglue.utils import getResolvedOptions

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

    prefixes = validate_prefixes(arguments)
    return JobConfig(
        **prefixes,
        mode=mode,
        dates=dates,
        max_invalid_fraction=threshold,
    )
