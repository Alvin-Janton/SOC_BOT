"""Offline checks for synthetic WAF rules and the shared JSONL runner."""

from collections import Counter
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

TEST_DIRECTORY = Path(__file__).resolve().parent
sys.path.insert(0, str(TEST_DIRECTORY.parent))

from schemas.app import APP_COLUMNS, PARTITION_COLUMNS
from schemas.waf import WAF_COLUMNS
from severity import waf_severity
from transforms.app import normalize_application
from transforms.waf import normalize_waf
from validation import parse_application_record, parse_waf_record

FIXTURES = TEST_DIRECTORY / "fixtures"
RUNNER = TEST_DIRECTORY / "run_local.py"
WAF_DISTRIBUTIONS = {
    "2026-9-01.jsonl": {"Informational": 10},
    "2026-9-07.jsonl": {"Informational": 6, "Medium": 4},
    "2026-9-11.jsonl": {"Informational": 5, "Medium": 3, "High": 2},
}


def read_jsonl(path: Path) -> list[dict]:
    """Read nonblank JSONL rows and reject non-object output records."""
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if any(not isinstance(row, dict) for row in rows):
        raise AssertionError(f"Expected JSON objects in {path}")
    return rows


def run_runner(input_root: Path, output_root: Path, prefix: str) -> subprocess.CompletedProcess:
    """Invoke the actual CLI with explicit local fixture and output directories."""
    return subprocess.run(
        [sys.executable, str(RUNNER), "--input-dir", str(input_root),
         "--output-dir", str(output_root), "--input-prefix", prefix],
        capture_output=True, text=True, encoding="utf-8", check=False,
    )


def snapshot_outputs(root: Path, source: str) -> dict[str, tuple[bytes, int]]:
    """Capture selected-source output bytes and modification times for isolation checks."""
    return {
        path.relative_to(root).as_posix(): (path.read_bytes(), path.stat().st_mtime_ns)
        for kind in ("output", "quarantine")
        for path in (root / f"{kind}_{source}").rglob("*.jsonl")
    }


class WafSeverityTests(unittest.TestCase):
    """Lock down action/evidence outcomes without external data or AWS access."""

    def test_action_and_native_evidence_rules(self) -> None:
        """Cover fallback actions and every native match-evidence signal in one table."""
        cases = [
            ({"action": "ALLOW", "terminatingRuleId": "Default_Action"}, 1, "Informational", "allow_without_match"),
            ({"action": "BLOCK", "terminatingRuleId": "Default_Action"}, 0, "Unknown", "unsupported_action_or_missing_match"),
            ({"action": "COUNT", "labels": [{"name": "synthetic-match"}]}, 0, "Unknown", "unsupported_action_or_missing_match"),
            ({"action": "CHALLENGE"}, 0, "Unknown", "unsupported_action_or_missing_match"),
        ]
        signals = (
            {"terminatingRuleId": "SyntheticRule"},
            {"terminatingRuleMatchDetails": [{"conditionType": "SQL_INJECTION"}]},
            {"nonTerminatingMatchingRules": [{"ruleId": "SyntheticCountRule", "action": "COUNT"}]},
            {"ruleGroupList": [{"terminatingRule": {"ruleId": "SyntheticRule"}}]},
            {"ruleGroupList": [{"nonTerminatingMatchingRules": [{"ruleId": "SyntheticCountRule"}]}]},
            {"rateBasedRuleList": [{"rateBasedRuleId": "SyntheticRateRule"}]},
            {"labels": [{"name": "synthetic-match"}]},
        )
        for evidence in signals:
            cases.extend((
                ({"action": "ALLOW", **evidence}, 4, "High", "allowed_rule_match"),
                ({"action": "BLOCK", **evidence}, 3, "Medium", "blocked_rule_match"),
            ))
        for record, expected_score, expected_label, expected_rule in cases:
            with self.subTest(record=record):
                score, label, source = waf_severity(record)
                self.assertEqual((score, label), (expected_score, expected_label))
                self.assertIsInstance(source, str)
                provenance = json.loads(source)
                self.assertEqual(provenance["rule_version"], "waf_rules_v1")
                self.assertEqual(provenance["rule"], expected_rule)
                self.assertEqual(provenance["action"], record["action"])
                self.assertEqual(provenance["evidence"], {key: value for key, value in record.items() if key != "action"})


class LocalRunnerTests(unittest.TestCase):
    """Exercise routing, schema, quarantine, and isolation through the real runner."""

    def assert_source_output(self, output_root: Path, source: str) -> None:
        """Check source-specific rows against the shared normalizer and fixed expectations."""
        columns = APP_COLUMNS if source == "app" else WAF_COLUMNS
        parser = parse_application_record if source == "app" else parse_waf_record
        normalizer = normalize_application if source == "app" else normalize_waf
        folder = FIXTURES / f"sample_logs_{source}"
        for fixture in sorted(folder.rglob("*.jsonl")):
            relative = fixture.relative_to(folder)
            key = f"raw/{source}/{relative.as_posix()}"
            rows = read_jsonl(output_root / f"output_{source}" / relative)
            raw_lines = [line for line in fixture.read_text(encoding="utf-8").splitlines() if line.strip()]
            self.assertEqual(len(rows), len(raw_lines))
            self.assertEqual(read_jsonl(output_root / f"quarantine_{source}" / relative), [])
            for row, line in zip(rows, raw_lines):
                with self.subTest(source=source, file=relative, request_id=row["request_id"]):
                    raw, timestamp = parser(line)
                    expected = normalizer(raw, timestamp, key)
                    expected["event_time"] = timestamp.isoformat().replace("+00:00", "Z")
                    self.assertEqual(row, expected)
                    self.assertEqual(set(row), {column for column, _ in columns + PARTITION_COLUMNS})
                    self.assertEqual(row["source_type"], source)
                    self.assertEqual(row["source_s3_key"], key)
                    request_id = raw["request_id"] if source == "app" else raw["httpRequest"]["requestId"]
                    self.assertEqual(row["source_record_ref"], request_id)
                    self.assertEqual(row["event_uid"], sha256(f"{source}:{key}:{request_id}".encode()).hexdigest())
                    event_time = datetime.fromisoformat(row["event_time"].replace("Z", "+00:00"))
                    self.assertEqual(event_time.utcoffset(), timezone.utc.utcoffset(event_time))
                    self.assertEqual(event_time, timestamp)
                    self.assertEqual((row["year"], row["month"], row["day"]),
                                     (timestamp.strftime("%Y"), timestamp.strftime("%m"), timestamp.strftime("%d")))
                    severity_source = json.loads(row["severity_source"])
                    self.assertEqual(severity_source["rule_version"], "app_rules_v2" if source == "app" else "waf_rules_v1")
                    self.assertEqual(type(row["severity_id"]), int)
                    json.loads(row["raw_event"])
            if source == "waf":
                self.assertEqual(dict(Counter(row["severity"] for row in rows)), WAF_DISTRIBUTIONS[fixture.name])
            else:
                self.assertEqual(Counter(row["severity"] for row in rows), Counter({"Informational": 1, "High": 1}))

    def test_root_and_source_selections(self) -> None:
        """Validate each CLI selection with tracked fixtures and unchanged source files."""
        before = {path: path.read_bytes() for path in FIXTURES.rglob("*.jsonl")}
        with tempfile.TemporaryDirectory(prefix="soc-bot-normalization-") as temporary:
            for prefix, selected in (("raw/", ("app", "waf")), ("raw/app/", ("app",)), ("raw/waf/", ("waf",))):
                with self.subTest(prefix=prefix):
                    output = Path(temporary) / prefix.rstrip("/").replace("/", "-")
                    result = run_runner(FIXTURES, output, prefix)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn("local placeholder", result.stdout)
                    for source in selected:
                        self.assert_source_output(output, source)
                        expected_count = 2 if source == "app" else 30
                        self.assertIn(f"{expected_count} input records, {expected_count} normalized, 0 rejected", result.stdout)
                    for source in {"app", "waf"} - set(selected):
                        self.assertFalse((output / f"output_{source}").exists())
                        self.assertFalse((output / f"quarantine_{source}").exists())
        self.assertEqual({path: path.read_bytes() for path in before}, before)

    def test_source_reruns_leave_other_outputs_untouched(self) -> None:
        """Ensure a selected-source rerun does not touch the other source's files."""
        with tempfile.TemporaryDirectory(prefix="soc-bot-isolation-") as temporary:
            output = Path(temporary) / "output"
            result = run_runner(FIXTURES, output, "raw/")
            self.assertEqual(result.returncode, 0, result.stderr)
            for selected, untouched in (("app", "waf"), ("waf", "app")):
                with self.subTest(selected=selected):
                    before = snapshot_outputs(output, untouched)
                    self.assertTrue(before)
                    result = run_runner(FIXTURES, output, f"raw/{selected}/")
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(snapshot_outputs(output, untouched), before)

    def test_malformed_record_quarantine_and_nested_key(self) -> None:
        """Quarantine bad JSON by dated source path while preserving nested valid provenance."""
        with tempfile.TemporaryDirectory(prefix="soc-bot-quarantine-") as temporary:
            root = Path(temporary)
            fixtures = root / "fixtures"
            shutil.copytree(FIXTURES, fixtures)
            waf_folder = fixtures / "sample_logs_waf"
            nested = waf_folder / "WEEK_2" / "2026-9-07.jsonl"
            nested.parent.mkdir()
            (waf_folder / nested.name).rename(nested)
            malformed = "{malformed\n"
            with nested.open("a", encoding="utf-8") as handle:
                handle.write("\n" + malformed)
            result = run_runner(fixtures, root / "outputs", "raw/")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("31 input records, 30 normalized, 1 rejected", result.stdout)
            key = "raw/waf/WEEK_2/2026-9-07.jsonl"
            normalized = read_jsonl(root / "outputs/output_waf/WEEK_2/2026-9-07.jsonl")
            self.assertEqual(len(normalized), 10)
            self.assertTrue(all(row["source_s3_key"] == key for row in normalized))
            self.assertTrue(all(row["event_uid"] == sha256(f"waf:{key}:{row['request_id']}".encode()).hexdigest() for row in normalized))
            rejected = read_jsonl(root / "outputs/quarantine_waf/WEEK_2/2026-9-07.jsonl")
            self.assertEqual(rejected, [{
                "source_s3_key": key, "source_record_ref": sha256(f"{key}:{malformed}".encode()).hexdigest(),
                "error_code": "malformed_json", "raw_event": malformed,
                "year": "2026", "month": "09", "day": "07",
            }])
            self.assertEqual(read_jsonl(root / "outputs/quarantine_app/2026-9-01.jsonl"), [])

    def test_missing_source_and_fixture_overwrite_guards(self) -> None:
        """Require explicit sources to exist and refuse destinations inside fixture folders."""
        with tempfile.TemporaryDirectory(prefix="soc-bot-guards-") as temporary:
            root = Path(temporary)
            fixtures = root / "fixtures"
            shutil.copytree(FIXTURES / "sample_logs_app", fixtures / "sample_logs_app")
            result = run_runner(fixtures, root / "outputs", "raw/waf/")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Selected fixture directory is missing", result.stderr)
            result = run_runner(fixtures, root / "outputs", "raw/")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("skipping absent fixture directory", result.stdout)
            self.assertFalse((root / "outputs/output_waf").exists())
            before = {path: path.read_bytes() for path in fixtures.rglob("*.jsonl")}
            result = run_runner(fixtures, fixtures / "sample_logs_app", "raw/app/")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Output must stay outside fixture directories", result.stderr)
            self.assertEqual({path: path.read_bytes() for path in before}, before)


if __name__ == "__main__":
    unittest.main()
