"""Exercise offline parity with temporary synthetic JSONL and Parquet files."""

from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from compare_parquet import SOURCE_COLUMNS, compare_files, normalize_value


class ParquetComparisonTests(unittest.TestCase):
    """Lock down scalar normalization, strict schemas, dates and duplicate counts."""

    def setUp(self) -> None:
        """Allocate an isolated workspace that never touches downloaded/user fixtures."""
        self.workspace = tempfile.TemporaryDirectory()
        self.addCleanup(self.workspace.cleanup)
        self.root = Path(self.workspace.name)

    def row(self, source: str = "app") -> dict:
        """Build a complete synthetic normalized row with nullable optional fields."""
        record = {name: None for name, _ in SOURCE_COLUMNS[source]}
        record.update(
            source_type=source, event_time="2026-09-11T12:00:00Z",
            event_uid="synthetic-event", request_id="synthetic-request",
            source_record_ref="synthetic-request", source_s3_key=f"raw/{source}/2026-9-11.jsonl",
            severity_id=1, severity="Informational", severity_source='{"matches":[]}',
            schema_version=1, year="2026", month="09", day="11",
        )
        return record

    def write_expected(self, rows: list[dict], name: str = "expected.jsonl") -> Path:
        """Serialize synthetic expected rows using the local runner's JSONL convention."""
        path = self.root / name
        path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
        return path

    def write_parquet(self, rows: list[dict], source: str = "app", path: Path | None = None) -> Path:
        """Write exact schema types, retaining nullable integers and timestamp precision."""
        path = path or self.root / "part-00000.parquet"
        path.parent.mkdir(parents=True, exist_ok=True)
        types = {"string": pa.string(), "int": pa.int32(), "bigint": pa.int64(), "timestamp": pa.timestamp("ns")}
        fields = pa.schema([(name, types[kind]) for name, kind in SOURCE_COLUMNS[source]])
        persisted = []
        for row in rows:
            record = {name: row[name] for name, _ in SOURCE_COLUMNS[source]}
            record["event_time"] = pd.Timestamp(record["event_time"])
            persisted.append(record)
        pq.write_table(pa.Table.from_pylist(persisted, schema=fields), path)
        return path

    def test_timestamp_nullable_integer_and_null_normalization(self) -> None:
        """Preserve nanoseconds and large nullable integers while normalizing UTC/nulls."""
        first = self.row()
        first.update(event_time="2026-09-11T14:00:00.123456789+02:00", response_bytes=2 ** 53 + 1)
        second = self.row()
        second["request_id"] = "nullable-request"
        expected = self.write_expected([first, second])
        parquet = self.write_parquet([first, second])
        result = compare_files([parquet], [expected])
        self.assertTrue(result.matches)
        self.assertEqual(result.expected_count, 2)
        self.assertIsNone(normalize_value(pd.NA, "int", "optional"))
        self.assertIsNone(normalize_value(float("nan"), "string", "optional"))
        self.assertEqual(normalize_value(200.0, "int", "status_code"), 200)
        changed = deepcopy(first)
        changed["event_time"] = "2026-09-11T12:00:00.123456788Z"
        mismatched = compare_files([self.write_parquet([changed, second])], [expected])
        self.assertFalse(mismatched.matches)

    def test_duplicate_rows_and_json_text_are_compared_exactly(self) -> None:
        """Treat repeated occurrences as significant and avoid parsing/reformatting evidence."""
        record = self.row("waf")
        expected = self.write_expected([record, record])
        result = compare_files([self.write_parquet([record, record], "waf")], [expected])
        self.assertTrue(result.matches)
        result = compare_files([self.write_parquet([record], "waf")], [expected])
        self.assertFalse(result.matches)
        self.assertEqual(result.missing.total(), 1)
        changed = deepcopy(record)
        changed["severity_source"] = '{"matches": []}'
        result = compare_files([self.write_parquet([record, changed], "waf")], [expected])
        self.assertEqual(result.missing.total(), 1)
        self.assertEqual(result.unexpected.total(), 1)

    def test_partition_helpers_and_preserved_paths_must_match_utc_date(self) -> None:
        """Validate both local date helpers and downloaded Hive directory placement."""
        record = self.row()
        expected = self.write_expected([record])
        valid = self.root / "year=2026" / "month=09" / "day=11" / "part.parquet"
        self.assertTrue(compare_files([self.write_parquet([record], path=valid)], [expected]).matches)
        wrong = self.root / "year=2026" / "month=09" / "day=12" / "part.parquet"
        with self.assertRaisesRegex(ValueError, "disagrees with UTC event date"):
            compare_files([self.write_parquet([record], path=wrong)], [expected])
        flat = self.write_parquet([record])
        table = pq.read_table(flat)
        for name in ("year", "month", "day"):
            table = table.append_column(name, pa.array([record[name]]))
        pq.write_table(table, flat)
        self.assertTrue(compare_files([flat], [expected]).matches)
        table = table.set_column(table.schema.get_field_index("day"), "day", pa.array(["12"]))
        pq.write_table(table, flat)
        with self.assertRaisesRegex(ValueError, "disagrees with UTC event date"):
            compare_files([flat], [expected])
        record["day"] = "12"
        with self.assertRaisesRegex(ValueError, "disagrees with UTC event date"):
            compare_files([valid], [self.write_expected([record])])

    def test_schema_and_mixed_sources_fail_clearly(self) -> None:
        """Reject missing/extra persisted columns instead of silently comparing a subset."""
        record = self.row()
        expected = self.write_expected([record])
        parquet = self.write_parquet([record])
        table = pq.read_table(parquet).drop_columns(["raw_event"])
        table = table.append_column("unexpected_column", pa.array(["not-approved"]))
        pq.write_table(table, parquet)
        with self.assertRaisesRegex(ValueError, "schema mismatch"):
            compare_files([parquet], [expected])
        with self.assertRaisesRegex(ValueError, "schema mismatch|mixed sources"):
            compare_files([parquet], [self.write_expected([record, self.row("waf")])])

    def test_invalid_scalars_and_missing_files_fail_clearly(self) -> None:
        """Reject booleans/fractions/unsafe floats and provide actionable local-file errors."""
        for value in (True, 1.5, float(2 ** 53)):
            with self.subTest(value=value), self.assertRaises(ValueError):
                normalize_value(value, "bigint", "response_bytes")
        with self.assertRaises(ValueError):
            normalize_value({"matches": []}, "string", "severity_source")
        expected = self.write_expected([self.row()])
        with self.assertRaisesRegex(ValueError, "Not a readable local Parquet file"):
            compare_files([self.root / "missing.parquet"], [expected])


if __name__ == "__main__":
    unittest.main()
