"""On-demand PySpark entry point for App/WAF/CloudTrail JSONL and VPC text."""

from urllib.parse import urlparse

from pyspark import StorageLevel
from pyspark.sql import SparkSession, functions as F
from pyspark.sql.types import IntegerType, LongType, StringType, StructField, StructType, TimestampType

from config import parse_config
from routing import classify, classify_cloudtrail_object, classify_vpc_object
from schemas.app import APP_COLUMNS, PARTITION_COLUMNS
from schemas.cloudtrail import CLOUDTRAIL_COLUMNS
from schemas.waf import WAF_COLUMNS
from schemas.vpc import VPC_COLUMNS

SOURCE_COLUMNS = {"app": APP_COLUMNS, "waf": WAF_COLUMNS, "vpc": VPC_COLUMNS, "cloudtrail": CLOUDTRAIL_COLUMNS}
QUARANTINE_COLUMNS = (
    ("source_s3_key", "string"), ("source_record_ref", "string"),
    ("error_code", "string"), ("raw_event", "string"),
)


def spark_schema(columns: tuple[tuple[str, str], ...]) -> StructType:
    """Convert the explicit catalog-style column contract to a Spark schema."""
    types = {"string": StringType(), "int": IntegerType(), "bigint": LongType(), "timestamp": TimestampType()}
    return StructType([StructField(name, types[kind], True) for name, kind in columns])


def source_frames(spark: SparkSession, rows, source: str):
    """Build separate typed valid and quarantine frames without deduplicating rows."""
    frames = []
    for disposition, columns in (
        ("valid", SOURCE_COLUMNS[source] + PARTITION_COLUMNS),
        ("invalid", QUARANTINE_COLUMNS + PARTITION_COLUMNS),
    ):
        frame = spark.createDataFrame(
            rows.filter(lambda item, selected_source=source, selected_disposition=disposition:
                        item[0] == selected_source and item[1] == selected_disposition).map(
                lambda item, selected_columns=columns: tuple(item[2].get(name) for name, _ in selected_columns),
            ), spark_schema(columns),
        ).persist(StorageLevel.MEMORY_AND_DISK)
        frames.append(frame)
    return frames


def main() -> None:
    """Validate selected sources before replacing only their input-backed date partitions."""
    config = parse_config()
    spark = SparkSession.builder.appName("SOC Bot shared normalization").getOrCreate()
    spark.conf.set("spark.sql.session.timeZone", "UTC")
    bucket = urlparse(config.input_prefix).netloc
    inputs = []
    vpc_inputs = []
    cloudtrail_inputs = []
    frames = []
    rows = None

    try:
        for source in config.sources:
            prefix = config.source_input(source)
            # Check only approved source roots, never list raw/ or the bucket root.
            path = spark._jvm.org.apache.hadoop.fs.Path(prefix)
            filesystem = path.getFileSystem(spark._jsc.hadoopConfiguration())

            if not filesystem.exists(path):
                if len(config.sources) == 1:
                    raise ValueError(f"Selected input prefix does not exist: {prefix}")
                print(f"Skipping absent supported source: {source}")
                continue

            if source == "vpc":
                vpc_inputs.append(prefix)

            elif source == "cloudtrail":
                cloudtrail_inputs.append(prefix)
                
            else:
                inputs.append(prefix)
        if not inputs and not vpc_inputs and not cloudtrail_inputs:
            raise ValueError("No supported input prefixes found")

        source_rows = []
        if inputs:
            source_rows.append(spark.read.option("recursiveFileLookup", "true").option("pathGlobFilter", "*.jsonl").text(inputs).select(
                F.col("value"), F.input_file_name().alias("source_uri"),
            ).rdd.map(lambda row: classify(row.value, row.source_uri, bucket)))

        if cloudtrail_inputs:
            # Whole objects preserve rejected records' physical line numbers.
            # Prepared daily CloudTrail objects must fit in executor memory.
            source_rows.append(spark.read.option("recursiveFileLookup", "true").option("pathGlobFilter", "*.jsonl").text(
                cloudtrail_inputs, wholetext=True,
            ).select(F.col("value"), F.input_file_name().alias("source_uri")).rdd.flatMap(
                lambda row: classify_cloudtrail_object(row.value, row.source_uri, bucket),
            ))

        if vpc_inputs:
            # One row per object retains file-relative line order; these prepared
            # daily files must fit in executor memory. JSONL readers stay unchanged.
            source_rows.append(spark.read.option("recursiveFileLookup", "true").option("pathGlobFilter", "*.log").text(
                vpc_inputs, wholetext=True,
            ).select(F.col("value"), F.input_file_name().alias("source_uri")).rdd.flatMap(
                lambda row: classify_vpc_object(row.value, row.source_uri, bucket),
            ))
        rows = spark.sparkContext.union(source_rows).persist(StorageLevel.MEMORY_AND_DISK)

        batches = []
        for source in config.sources:
            valid, invalid = source_frames(spark, rows, source)
            frames.extend((valid, invalid))
            available = {
                f"{row.year}-{row.month}-{row.day}"
                for frame in (valid, invalid)
                for row in frame.select("year", "month", "day").distinct().collect()
            }
            dates = frozenset(available) if config.mode == "full" else config.dates.intersection(available)

            if len(dates) > 366:
                raise ValueError("Job exceeds the 366-day batch safety limit")

            if not dates:
                continue

            selected_dates = F.concat_ws("-", "year", "month", "day").isin(*dates)
            valid_count = valid.filter(selected_dates).count()
            invalid_count = invalid.filter(selected_dates).count()
            total = valid_count + invalid_count
            if invalid_count / total > config.max_invalid_fraction:
                raise ValueError(f"{source}: rejected-record fraction {invalid_count}/{total} exceeds configured threshold")

            batches.append((source, valid, invalid, dates, valid_count, invalid_count))
        if not batches:
            raise ValueError("No supported records found for requested dates")

        # All sources pass validation before any source is written.
        for source, valid, invalid, dates, valid_count, invalid_count in batches:
            for selected in sorted(dates):
                year, month, day = selected.split("-")
                predicate = (F.col("year") == year) & (F.col("month") == month) & (F.col("day") == day)
                suffix = f"{source}/year={year}/month={month}/day={day}/"

                for frame, columns, root in (
                    (valid, SOURCE_COLUMNS[source], config.output_prefix),
                    (invalid, QUARANTINE_COLUMNS, config.quarantine_prefix),
                ):
                    frame.filter(predicate).select(*[name for name, _ in columns]).write.mode("overwrite").option(
                        "compression", "snappy",
                    ).parquet(root + suffix)
            print(
                f"{source} normalization: input={valid_count + invalid_count} output={valid_count} "
                f"rejected={invalid_count} partitions={len(dates)}"
            )
    finally:
        for frame in frames:
            frame.unpersist()
        if rows is not None:
            rows.unpersist()


if __name__ == "__main__":
    main()
