"""On-demand PySpark entry point for application JSONL normalization."""

from datetime import date
from hashlib import sha256
import re
from urllib.parse import urlparse

from pyspark import StorageLevel
from pyspark.sql import SparkSession, functions as F
from pyspark.sql.types import IntegerType, LongType, StringType, StructField, StructType, TimestampType

from config import parse_config
from schemas.app import APP_COLUMNS, PARTITION_COLUMNS
from transforms.app import normalize_application
from validation import parse_application_record


def source_key(uri: str) -> str:
    """Extract a traceable raw/app object key from a Spark source URI."""

    parsed = urlparse(uri)
    if parsed.scheme not in {"s3", "s3a"} or not parsed.netloc or not parsed.path.startswith("/raw/app/"):
        raise ValueError("Unexpected application source URI")
    return parsed.path.lstrip("/")


def fallback_date(uri: str) -> date:
    """Recover the input file's UTC date when a record cannot be parsed."""

    match = re.search(r"(?:^|/)(\d{4})-(\d{1,2})-(\d{1,2})\.jsonl$", uri)
    if not match:
        raise ValueError("Malformed record source lacks a dated JSONL filename")
    return date(*(int(part) for part in match.groups()))


def classify(line: str, uri: str) -> tuple[str, dict]:
    """Normalize one JSONL record or package it for the quarantine output."""

    key = source_key(uri)
    try:
        record, timestamp = parse_application_record(line)
        return "valid", normalize_application(record, timestamp, key)
    except ValueError as error:
        day = fallback_date(uri)
        return "invalid", {
            "source_s3_key": key,
            "source_record_ref": sha256(f"{key}:{line}".encode()).hexdigest(),
            "error_code": str(error),
            "raw_event": line,
            "year": day.strftime("%Y"),
            "month": day.strftime("%m"),
            "day": day.strftime("%d"),
        }


def spark_schema(columns: tuple[tuple[str, str], ...]) -> StructType:
    """Convert the explicit catalog-style column contract to a Spark schema."""

    types = {"string": StringType(), "int": IntegerType(), "bigint": LongType(), "timestamp": TimestampType()}
    return StructType([StructField(name, types[kind], True) for name, kind in columns])


def main() -> None:
    """Run a bounded application batch and replace only its selected date partitions."""

    config = parse_config()
    spark = SparkSession.builder.appName("SOC Bot application normalization").getOrCreate()
    spark.conf.set("spark.sql.session.timeZone", "UTC")

    rows = spark.read.option("recursiveFileLookup", "true").option("pathGlobFilter", "*.jsonl").text(config.input_prefix).select(
        F.col("value"), F.input_file_name().alias("source_uri"),
    ).rdd.map(lambda row: classify(row.value, row.source_uri)).persist(StorageLevel.MEMORY_AND_DISK)

    valid_columns = APP_COLUMNS + PARTITION_COLUMNS

    invalid_columns = (
        ("source_s3_key", "string"), ("source_record_ref", "string"),
        ("error_code", "string"), ("raw_event", "string"),
    ) + PARTITION_COLUMNS

    valid = spark.createDataFrame(
        rows.filter(lambda item: item[0] == "valid").map(
            lambda item: tuple(item[1].get(name) for name, _ in valid_columns),
        ),
        spark_schema(valid_columns),
    ).persist()

    invalid = spark.createDataFrame(
        rows.filter(lambda item: item[0] == "invalid").map(
            lambda item: tuple(item[1].get(name) for name, _ in invalid_columns),
        ),
        spark_schema(invalid_columns),
    ).persist()

    available = {
        f"{row.year}-{row.month}-{row.day}"
        for frame in (valid, invalid)
        for row in frame.select("year", "month", "day").distinct().collect()
    }

    dates = config.dates if config.mode == "incremental" else frozenset(available)

    if len(dates) > 366:
        raise ValueError("Job exceeds the 366-day batch safety limit")

    valid_count = valid.filter(F.concat_ws("-", "year", "month", "day").isin(*dates)).count()
    invalid_count = invalid.filter(F.concat_ws("-", "year", "month", "day").isin(*dates)).count()
    total = valid_count + invalid_count

    if total == 0:
        raise ValueError("No application records found for requested dates")

    if invalid_count / total > config.max_invalid_fraction:
        raise ValueError(f"Rejected-record fraction {invalid_count}/{total} exceeds configured threshold")

    data_columns = [name for name, _ in APP_COLUMNS]
    quarantine_columns = ["source_s3_key", "source_record_ref", "error_code", "raw_event"]
    
    for selected in sorted(dates):
        year, month, day = selected.split("-")
        predicate = (F.col("year") == year) & (F.col("month") == month) & (F.col("day") == day)
        suffix = f"year={year}/month={month}/day={day}/"
        valid.filter(predicate).select(*data_columns).write.mode("overwrite").option("compression", "snappy").parquet(
            config.output_prefix + suffix,
        )
        invalid.filter(predicate).select(*quarantine_columns).write.mode("overwrite").option("compression", "snappy").parquet(
            config.quarantine_prefix + suffix,
        )
    print(f"application normalization: input={total} output={valid_count} rejected={invalid_count} partitions={len(dates)}")
    valid.unpersist()
    invalid.unpersist()
    rows.unpersist()


if __name__ == "__main__":
    main()
