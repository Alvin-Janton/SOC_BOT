"""Normalize local fixtures without Spark or AWS; source keys are placeholders."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from typing import TextIO

# Match the Glue library's module layout when this script is run directly.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from transforms.app import normalize_application
from validation import parse_application_record


def serialize_datetime(value: object) -> str:
    """Represent the normalizer's UTC datetime as an ISO 8601 JSON string."""
    if not isinstance(value, datetime):
        raise TypeError(f"Unsupported JSON value: {type(value).__name__}")
    timestamp = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
    return timestamp.isoformat().replace("+00:00", "Z")


def convert_file(input_path: Path, output: TextIO) -> int:
    """Write normalized nonblank records, stopping at the first invalid input."""
    count = 0
    source_key = f"raw/app/test/{input_path.name}"
    with input_path.open(encoding="utf-8-sig") as source:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                continue

            try:
                record, timestamp = parse_application_record(line)
                normalized = normalize_application(record, timestamp, source_key)
                encoded = json.dumps(
                    normalized, ensure_ascii=False, separators=(",", ":"),
                    default=serialize_datetime, allow_nan=False,
                )

            except (ValueError, TypeError, KeyError, RecursionError) as error:
                raise ValueError(f"{input_path.name}:{line_number}: {error}") from error

            output.write(encoded + "\n")
            count += 1
    return count


def reject_input_overwrite(output_path: Path, inputs: list[Path]) -> None:
    """Protect fixture paths, including symlink and existing hard-link aliases."""
    for input_path in inputs:
        if output_path == input_path or (
            output_path.exists() and output_path.samefile(input_path)
        ):
            raise ValueError(f"Output would overwrite input fixture: {input_path}")


def main() -> int:
    """Convert sorted local JSONL fixtures to separate or combined output files."""
    directory = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)

    parser.add_argument(
        "--input-dir", type=Path, default=directory / "sample_logs",
        help="Directory containing top-level JSONL inputs (default: glue/test/sample_logs).",
    )

    parser.add_argument(
        "--output", type=Path,
        help="Optional combined JSONL file; default: glue/test/output/<input-filename>.",
    )

    args = parser.parse_args()

    try:
        inputs = [path.resolve() for path in sorted(args.input_dir.glob("*.jsonl")) if path.is_file()]

        if not inputs:
            raise ValueError(f"No top-level JSONL inputs found in {args.input_dir}")

        outputs = (
            [(args.output.resolve(), inputs)] if args.output else
            [((directory / "output" / path.name).resolve(), [path]) for path in inputs]
        )

        # Check every destination before creating or truncating any output.
        for output_path, _ in outputs:
            reject_input_overwrite(output_path, inputs)

        print("Local provenance: raw/app/test/<input-filename> is a placeholder, not an S3 object.")
        total = 0
        for output_path, sources in outputs:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with output_path.open("w", encoding="utf-8", newline="\n") as output:
                for input_path in sources:
                    count = convert_file(input_path, output)
                    total += count
                    print(f"{input_path.name}: {count} records -> {output_path}")

        print(f"Converted {total} records from {len(inputs)} input files.")
    except (OSError, ValueError, UnicodeError) as error:
        print(f"Normalization failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
