"""Compare downloaded, source-specific Parquet with expected local runner JSONL.

Install dependencies: python -m pip install -r glue/test/requirements-test.txt
Usage: python glue/test/compare_parquet.py --parquet downloaded/part-00000.parquet \
    downloaded/part-00001.parquet --expected glue/test/output_waf/2026-9-11.jsonl

Pass one source per invocation and only matching input objects/partitions. All
persisted fields, including JSON-text evidence, are compared exactly as a row
multiset: ordering is irrelevant, but repeated rows are not discarded. Naive
Parquet timestamps represent UTC, matching the Glue job's Spark configuration.
Expected date helpers and any downloaded Hive partition paths/columns must agree
with event_time. Flattened downloads without partition columns cannot prove the
original S3 partition placement. This utility reads local files only.
"""

import argparse
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
import json
import math
from numbers import Integral, Real
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from schemas.app import APP_COLUMNS
from schemas.waf import WAF_COLUMNS

SOURCE_COLUMNS = {"app": APP_COLUMNS, "waf": WAF_COLUMNS}
PARTITION_NAMES = ("year", "month", "day")


@dataclass(frozen=True)
class ComparisonResult:
    """Describe row-count parity and duplicate-preserving differences for one source."""

    source: str
    expected_count: int
    parquet_count: int
    missing: Counter
    unexpected: Counter

    @property
    def matches(self) -> bool:
        """Return whether every expected occurrence has an identical Parquet occurrence."""
        return not self.missing and not self.unexpected


def normalize_value(value: object, kind: str, location: str) -> object:
    """Canonicalize scalar nulls, exact integers and UTC timestamps without rounding."""
    import pandas as pd

    if not pd.api.types.is_scalar(value):
        raise ValueError(f"{location}: expected a scalar {kind} value")
    if value is None or bool(pd.isna(value)):
        return None
    if kind == "string":
        if not isinstance(value, str):
            raise ValueError(f"{location}: expected a string; JSON-text fields must remain strings")
        return value
    if kind == "timestamp":
        if not isinstance(value, (str, datetime, pd.Timestamp)):
            raise ValueError(f"{location}: expected an ISO timestamp or datetime")
        try:
            timestamp = pd.Timestamp(value)
            if pd.isna(timestamp):
                raise ValueError("event timestamp cannot be NaT")
            timestamp = (
                timestamp.tz_localize("UTC") if timestamp.tzinfo is None
                else timestamp.tz_convert("UTC")
            )
            return timestamp.isoformat()
        except (ValueError, TypeError, OverflowError) as error:
            raise ValueError(f"{location}: invalid timestamp") from error
    if kind in ("int", "bigint"):
        if isinstance(value, bool):
            raise ValueError(f"{location}: boolean is not an integer")
        if isinstance(value, Integral):
            number = int(value)
        elif isinstance(value, Real):
            # Nullable numeric columns sometimes arrive as floats. Do not round
            # fractions or accept magnitudes where a float may have lost digits.
            numeric = float(value)
            if not math.isfinite(numeric) or not numeric.is_integer() or abs(numeric) >= 2 ** 53:
                raise ValueError(f"{location}: integer is fractional or not safely represented")
            number = int(numeric)
        else:
            raise ValueError(f"{location}: expected an integer")
        bits = 32 if kind == "int" else 64
        if not -(2 ** (bits - 1)) <= number < 2 ** (bits - 1):
            raise ValueError(f"{location}: value exceeds the {kind} range")
        return number
    raise ValueError(f"{location}: unsupported schema type {kind}")


def validate_columns(names, source: str, location: str, require_partitions: bool = False) -> None:
    """Reject omitted or extra persisted fields and incomplete partition-helper sets."""
    names = list(names)
    if len(names) != len(set(names)):
        raise ValueError(f"{location}: duplicate column names")
    fields = {name for name, _ in SOURCE_COLUMNS[source]}
    supplied = set(names)
    missing = fields - supplied
    extra = supplied - fields - set(PARTITION_NAMES)
    partitions = supplied.intersection(PARTITION_NAMES)
    if missing or extra:
        raise ValueError(f"{location}: schema mismatch; missing={sorted(missing)}, extra={sorted(extra)}")
    if partitions and partitions != set(PARTITION_NAMES):
        raise ValueError(f"{location}: year/month/day helpers must appear together")
    if require_partitions and partitions != set(PARTITION_NAMES):
        raise ValueError(f"{location}: expected JSONL must include year/month/day helpers")


def partition_from_path(path: Path) -> dict[str, str]:
    """Extract complete Hive date directories when downloads preserve partition paths."""
    result = {}
    for part in path.parent.parts:
        for name in PARTITION_NAMES:
            if part.startswith(name + "="):
                if name in result:
                    raise ValueError(f"{path}: repeated {name} partition directory")
                result[name] = part.split("=", 1)[1]
    if result and set(result) != set(PARTITION_NAMES):
        raise ValueError(f"{path}: partition path must include year, month and day")
    return result


def validate_date(parts: dict, timestamp: str, location: str) -> None:
    """Require a supplied date partition/helper triple to equal the UTC event date."""
    import pandas as pd

    if not parts:
        return
    event_time = pd.Timestamp(timestamp)
    expected = (event_time.year, event_time.month, event_time.day)
    supplied = []
    for name in PARTITION_NAMES:
        value = parts[name]
        if isinstance(value, str) and value.isascii() and value.isdecimal():
            supplied.append(int(value))
        else:
            normalized = normalize_value(value, "int", f"{location}.{name}")
            if normalized is None:
                raise ValueError(f"{location}: date partition cannot be null")
            supplied.append(normalized)
    if tuple(supplied) != expected:
        raise ValueError(f"{location}: date partition {tuple(supplied)} disagrees with UTC event date {expected}")


def canonical_row(record: dict, source: str, location: str, path_parts: dict | None = None) -> tuple:
    """Create an exact persisted-field row after validating source and date provenance."""
    if record.get("source_type") != source:
        raise ValueError(f"{location}: mixed sources; compare app and WAF in separate invocations")
    columns = SOURCE_COLUMNS[source]
    values = tuple(normalize_value(record[name], kind, f"{location}.{name}") for name, kind in columns)
    timestamp = values[[name for name, _ in columns].index("event_time")]
    if timestamp is None:
        raise ValueError(f"{location}: event_time cannot be null")
    helpers = {name: record[name] for name in PARTITION_NAMES if name in record}
    validate_date(helpers, timestamp, location)
    validate_date(path_parts or {}, timestamp, f"{location} partition path")
    return values


def reject_json_constant(value: str) -> None:
    """Reject nonstandard NaN/Infinity constants in expected runner JSONL."""
    raise ValueError(f"Non-finite JSON constant: {value}")


def read_expected(paths: list[Path]) -> tuple[str, Counter]:
    """Load one source's normalized JSONL with exact persisted columns and date helpers."""
    source = None
    rows = Counter()
    for path in paths:
        if not path.is_file():
            raise ValueError(f"Not a readable local expected JSONL file: {path}")
        with path.open(encoding="utf-8-sig") as stream:
            for line_number, line in enumerate(stream, 1):
                if not line.strip():
                    continue
                location = f"{path}:{line_number}"
                try:
                    record = json.loads(line, parse_constant=reject_json_constant)
                except ValueError as error:
                    raise ValueError(f"{location}: invalid JSON") from error
                if not isinstance(record, dict):
                    raise ValueError(f"{location}: expected a JSON object")
                record_source = record.get("source_type")
                if record_source not in SOURCE_COLUMNS:
                    raise ValueError(f"{location}: source_type must be app or waf")
                source = source or record_source
                validate_columns(record, source, location, require_partitions=True)
                rows[canonical_row(record, source, location)] += 1
    if source is None:
        raise ValueError("Expected JSONL has no normalized rows; provide a nonempty source selection")
    return source, rows


def read_parquet(paths: list[Path], source: str) -> Counter:
    """Read compatible local Parquet without losing nullable integer precision."""
    import pandas as pd

    rows = Counter()
    for path in paths:
        if not path.is_file():
            raise ValueError(f"Not a readable local Parquet file: {path}")
        try:
            frame = pd.read_parquet(path, engine="pyarrow", dtype_backend="pyarrow")
        except ImportError:
            raise
        except Exception as error:
            raise ValueError(f"Cannot read Parquet file {path}: {error}") from error
        validate_columns(frame.columns, source, str(path))
        parts = partition_from_path(path)
        for row_number, record in enumerate(frame.to_dict(orient="records"), 1):
            rows[canonical_row(record, source, f"{path}:row {row_number}", parts)] += 1
    return rows


def compare_files(parquet_paths: list[Path], expected_paths: list[Path]) -> ComparisonResult:
    """Compare every persisted field as multisets, including duplicate occurrences."""
    if not parquet_paths or not expected_paths:
        raise ValueError("Supply at least one Parquet file and one expected JSONL file")
    source, expected = read_expected(expected_paths)
    actual = read_parquet(parquet_paths, source)
    return ComparisonResult(source, expected.total(), actual.total(), expected - actual, actual - expected)


def print_differences(label: str, rows: Counter, source: str) -> None:
    """Show a bounded provenance-only summary without printing request payloads."""
    names = [name for name, _ in SOURCE_COLUMNS[source]]
    print(f"{label}: {rows.total()} rows")
    for row, count in list(rows.items())[:5]:
        key = str(row[names.index("source_s3_key")])[:160]
        request_id = str(row[names.index("request_id")])[:80]
        print(f"  {count} occurrence(s): source_s3_key={key!r}, request_id={request_id!r}")
    if len(rows) > 5:
        print(f"  ... {len(rows) - 5} additional distinct rows")


def main() -> int:
    """Report offline Parquet parity, failing clearly on schema or row differences."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--parquet", type=Path, nargs="+", required=True, help="Matching downloaded local Parquet files.")
    parser.add_argument("--expected", type=Path, nargs="+", required=True, help="Matching normalized runner JSONL files; one source only.")
    args = parser.parse_args()
    try:
        result = compare_files(args.parquet, args.expected)
        print(f"{result.source}: expected={result.expected_count}, parquet={result.parquet_count}")
        if result.matches:
            print("Parity passed: all persisted fields and duplicate counts match.")
            return 0
        print_differences("Missing from Parquet", result.missing, result.source)
        print_differences("Unexpected in Parquet", result.unexpected, result.source)
        return 1
    except ImportError:
        print(
            "Parquet comparison requires pandas and pyarrow. Install with: "
            "python -m pip install -r glue/test/requirements-test.txt", file=sys.stderr,
        )
    except (OSError, ValueError, TypeError, OverflowError) as error:
        print(f"Parquet comparison failed: {error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
