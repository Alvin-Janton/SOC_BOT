"""Normalize local fixtures without Spark or AWS; source keys are placeholders."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from typing import TextIO

# Match the Glue library's module layout when this script is run directly.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import SUPPORTED_SOURCES
from routing import classify, source_key

LOCAL_BUCKET = "soc-bot-local-fixtures"


def serialize_datetime(value: object) -> str:
    """Represent the normalizer's UTC datetime as an ISO 8601 JSON string."""
    if not isinstance(value, datetime):
        raise TypeError(f"Unsupported JSON value: {type(value).__name__}")
    timestamp = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
    return timestamp.isoformat().replace("+00:00", "Z")


def convert_file(input_path: Path, uri: str, output: TextIO, quarantine: TextIO) -> tuple[int, int]:
    """Route nonblank records through production classification into separate outputs."""
    normalized_count = rejected_count = 0
    with input_path.open(encoding="utf-8-sig") as source:
        for line_number, line in enumerate(source, 1):
            if not line.strip():
                continue

            try:
                _, disposition, record = classify(line, uri, LOCAL_BUCKET)
                encoded = json.dumps(
                    record, ensure_ascii=False, separators=(",", ":"),
                    default=serialize_datetime, allow_nan=False,
                )

            except (ValueError, TypeError, KeyError, RecursionError) as error:
                raise ValueError(f"{input_path}:{line_number}: {error}") from error

            if disposition == "valid":
                output.write(encoded + "\n")
                normalized_count += 1
            else:
                quarantine.write(encoded + "\n")
                rejected_count += 1
    return normalized_count, rejected_count


def reject_input_overwrite(output_path: Path, inputs: list[Path]) -> None:
    """Protect fixture paths, including symlink and existing hard-link aliases."""
    for input_path in inputs:
        if output_path == input_path or (
            output_path.exists() and output_path.samefile(input_path)
        ):
            raise ValueError(f"Output would overwrite input fixture: {input_path}")


def main() -> int:
    """Normalize selected app/WAF fixture folders without Spark or AWS access."""
    directory = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)

    parser.add_argument(
        "--input-dir", type=Path, default=directory,
        help="Fixture root containing sample_logs_app/ and sample_logs_waf/ (default: glue/test).",
    )

    parser.add_argument(
        "--input-prefix", default="raw/",
        choices=("raw", "raw/", "raw/app", "raw/app/", "raw/waf", "raw/waf/"),
        help="Logical raw source selection (default: raw/).",
    )
    parser.add_argument(
        "--output-dir", type=Path, default=directory,
        help="Root for output_<source>/ and quarantine_<source>/ (default: glue/test).",
    )

    args = parser.parse_args()

    try:
        root = args.input_dir.resolve()
        prefix = args.input_prefix.rstrip("/")
        sources = SUPPORTED_SOURCES if prefix == "raw" else (prefix.split("/")[1],)
        fixture_dirs = [(root / f"sample_logs_{source}").resolve() for source in SUPPORTED_SOURCES]
        inputs = [path.resolve() for folder in fixture_dirs for path in folder.rglob("*.jsonl") if path.is_file()]
        outputs = []
        for source in sources:
            folder = root / f"sample_logs_{source}"
            if not folder.is_dir():
                if prefix != "raw":
                    raise ValueError(f"Selected fixture directory is missing: {folder}")
                print(f"{source}: skipping absent fixture directory {folder}")
                continue
            files = sorted(path for path in folder.rglob("*.jsonl") if path.is_file())
            if not files:
                raise ValueError(f"No JSONL inputs found in {folder}")
            for path in files:
                relative = path.relative_to(folder)
                uri = f"s3://{LOCAL_BUCKET}/raw/{source}/test/{relative.as_posix()}"
                source_key(uri, LOCAL_BUCKET)
                output = (args.output_dir / f"output_{source}" / relative).resolve()
                quarantine = (args.output_dir / f"quarantine_{source}" / relative).resolve()
                outputs.append((source, path, uri, output, quarantine))
        if not outputs:
            raise ValueError(f"No supported JSONL inputs found in {root}")

        # Check every destination before creating or truncating any output.
        destinations: list[Path] = []
        for _, _, _, output, quarantine in outputs:
            for destination in (output, quarantine):
                if any(destination.is_relative_to(folder) for folder in fixture_dirs):
                    raise ValueError(f"Output must stay outside fixture directories: {destination}")
                reject_input_overwrite(destination, inputs)
                reject_input_overwrite(destination, destinations)
                destinations.append(destination)

        print("Local provenance: raw/<source>/test/<relative-filename> is a placeholder, not an S3 object.")
        totals = {source: [0, 0, 0] for source in sources}
        for source, input_path, uri, output_path, quarantine_path in outputs:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            quarantine_path.parent.mkdir(parents=True, exist_ok=True)
            with output_path.open("w", encoding="utf-8", newline="\n") as output, \
                    quarantine_path.open("w", encoding="utf-8", newline="\n") as quarantine:
                normalized, rejected = convert_file(input_path, uri, output, quarantine)
            totals[source][0] += 1
            totals[source][1] += normalized
            totals[source][2] += rejected
            print(f"{source}/{input_path.name}: {normalized} normalized, {rejected} rejected -> "
                  f"{output_path}; quarantine -> {quarantine_path}")
        for source, (files, normalized, rejected) in totals.items():
            print(f"{source}: {files} files, {normalized + rejected} input records, "
                  f"{normalized} normalized, {rejected} rejected.")
    except (OSError, ValueError, UnicodeError) as error:
        print(f"Normalization failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
