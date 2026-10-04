"""Normalize local fixtures without Spark or AWS using Glue-equivalent source keys."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from typing import Iterator, TextIO

# Match the Glue library's module layout when this script is run directly.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import SUPPORTED_SOURCES
from routing import classify, classify_vpc_object, source_key

LOCAL_BUCKET = "soc-bot-local-fixtures"
SOURCE_PATTERNS = {"app": "*.jsonl", "waf": "*.jsonl", "vpc": "*.log", "cloudtrail": "*.jsonl"}


def serialize_datetime(value: object) -> str:
    """Represent the normalizer's UTC datetime as an ISO 8601 JSON string."""
    if not isinstance(value, datetime):
        raise TypeError(f"Unsupported JSON value: {type(value).__name__}")
    timestamp = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)
    return timestamp.isoformat().replace("+00:00", "Z")


def classify_file(input_path: Path, uri: str) -> Iterator[tuple[int, str, dict]]:
    """Use VPC's object reader and retain physical CloudTrail quarantine line references."""
    selected_source = source_key(uri, LOCAL_BUCKET).split("/")[1]
    is_vpc = selected_source == "vpc"
    preserve_lines = selected_source in {"vpc", "cloudtrail"}
    with input_path.open(encoding="utf-8" if preserve_lines else "utf-8-sig", newline="" if preserve_lines else None) as source:
        if is_vpc:
            # Preserve physical lines and their terminators just like Glue's wholetext reader.
            line_number = 1
            try:
                for _, disposition, record in classify_vpc_object(source.read(), uri, LOCAL_BUCKET):
                    yield line_number, disposition, record
                    line_number += 1
            except (ValueError, TypeError, KeyError, RecursionError) as error:
                raise ValueError(f"{input_path}:{line_number}: {error}") from error
        else:
            for line_number, line in enumerate(source, 1):
                if not line.strip():
                    continue
                try:
                    _, disposition, record = classify(line, uri, LOCAL_BUCKET, line_number=line_number)
                except (ValueError, TypeError, KeyError, RecursionError) as error:
                    raise ValueError(f"{input_path}:{line_number}: {error}") from error
                yield line_number, disposition, record


def convert_file(input_path: Path, uri: str, output: TextIO, quarantine: TextIO) -> tuple[int, int]:
    """Serialize classified records into source-separated normalized and quarantine JSONL."""
    normalized_count = rejected_count = 0
    for line_number, disposition, record in classify_file(input_path, uri):
        try:
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
    """Normalize selected App/WAF/VPC/CloudTrail fixture folders without AWS access."""
    directory = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)

    parser.add_argument(
        "--input-dir", type=Path, default=directory,
        help="Fixture root containing sample_logs_app/, sample_logs_waf/, sample_logs_vpc/, and sample_logs_cloudtrail/ (default: glue/test).",
    )

    parser.add_argument(
        "--input-prefix", default="raw/",
        choices=("raw", "raw/", "raw/app", "raw/app/", "raw/waf", "raw/waf/", "raw/vpc", "raw/vpc/",
                 "raw/cloudtrail", "raw/cloudtrail/"),
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
        inputs = [path.resolve() for source, folder in zip(SUPPORTED_SOURCES, fixture_dirs)
                  for path in folder.rglob(SOURCE_PATTERNS[source]) if path.is_file()]
        outputs = []
        for source in sources:
            folder = root / f"sample_logs_{source}"
            if not folder.is_dir():
                if prefix != "raw":
                    raise ValueError(f"Selected fixture directory is missing: {folder}")
                print(f"{source}: skipping absent fixture directory {folder}")
                continue
            files = sorted(path for path in folder.rglob(SOURCE_PATTERNS[source]) if path.is_file())
            if not files:
                raise ValueError(f"No {SOURCE_PATTERNS[source]} inputs found in {folder}")
            for path in files:
                relative = path.relative_to(folder)
                uri = f"s3://{LOCAL_BUCKET}/raw/{source}/{relative.as_posix()}"
                source_key(uri, LOCAL_BUCKET)
                output_relative = relative.with_suffix(".jsonl")
                output = (args.output_dir / f"output_{source}" / output_relative).resolve()
                quarantine = (args.output_dir / f"quarantine_{source}" / output_relative).resolve()
                outputs.append((source, path, uri, output, quarantine))
        if not outputs:
            raise ValueError(f"No supported inputs found in {root}")

        # Check every destination before creating or truncating any output.
        destinations: list[Path] = []
        for _, _, _, output, quarantine in outputs:
            for destination in (output, quarantine):
                if any(destination.is_relative_to(folder) for folder in fixture_dirs):
                    raise ValueError(f"Output must stay outside fixture directories: {destination}")
                reject_input_overwrite(destination, inputs)
                reject_input_overwrite(destination, destinations)
                destinations.append(destination)

        print(f"Local provenance: bucket {LOCAL_BUCKET} is a local placeholder; "
              "raw/<source>/<relative-filename> mirrors Glue's source key.")
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
