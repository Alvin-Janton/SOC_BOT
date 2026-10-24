"""Authoritative versioned JSON and inert, escaped HTML from the same run data."""

from html import escape
import errno
import json
import os
from pathlib import Path
import re
import tempfile
import time

from .common import EvaluationError, encoded, require
from .judge import CRITERIA

ARTIFACT_BYTES = 16777216
RESULT_SCHEMA_VERSION = 1
REPLACE_DELAYS = (0.1, 0.3)
# Win32 ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION only; never generic access denied.
# https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--0-499-
SHARING_WINERRORS = frozenset({32, 33})
ARTIFACT_OPERATIONS = frozenset({"json_encode", "json_limit", "html_render", "html_limit", "temp_create",
                                "temp_open", "temp_write", "temp_flush", "temp_fsync", "temp_close",
                                "replace", "cleanup_unlink", "directory_create", "save"})
ARTIFACT_NAMES = frozenset({"results.json", "report.html", "not_selected"})
LOCAL_ERROR_CODES = frozenset({"INVALID_JSON", "INVALID_DATA", "ARTIFACT_LIMIT"})
ARTIFACT_MESSAGE = ('Could not save both artifacts; prior results.json may be the latest usable snapshot. '
                    'No further dispatch is allowed.')


def failure_details(operation: str, artifact: str, exc: BaseException, attempts: int) -> dict:
    """Project only owned labels, a bounded class token and numeric OS codes, never exception text/paths."""
    name = type(exc).__name__
    details = {"operation": operation if operation in ARTIFACT_OPERATIONS else "save",
               "artifact": artifact if artifact in ARTIFACT_NAMES else "not_selected",
               "exception_type": name if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", name) else "OtherError",
               "replacement_attempts": max(0, min(attempts, len(REPLACE_DELAYS) + 1))}
    if isinstance(exc, OSError):
        for key in ("errno", "winerror"):
            value = getattr(exc, key, None)
            if type(value) is int and -2147483648 <= value <= 2147483647:
                details[key] = value
    if isinstance(exc, EvaluationError) and isinstance(exc.code, str) and exc.code in LOCAL_ERROR_CODES:
        details["evaluation_code"] = exc.code
    return details


class ArtifactWriteError(EvaluationError):
    """Keep local write diagnostics separate from private report contents and raw chained exceptions."""

    def __init__(self, operation: str, artifact: str, exc: BaseException, attempts: int = 0):
        """Capture only the safe projection; callers chain the original exception without displaying it."""
        super().__init__("ARTIFACT_WRITE", ARTIFACT_MESSAGE)
        self.details = failure_details(operation, artifact, exc, attempts)
        self.cleanup_failures = []

    def add_cleanup(self, error) -> None:
        """Retain at most the handle-close and exact-temp unlink failures without replacing the primary."""
        if len(self.cleanup_failures) < 2:
            self.cleanup_failures.append(dict(error.details))

    def diagnostic(self) -> dict:
        """Return bounded optional error metadata only; never serialize the cause, traceback or filename."""
        details = dict(self.details)
        if self.cleanup_failures:
            details["cleanup_failures"] = [dict(item) for item in self.cleanup_failures]
        return {"code": "ARTIFACT_WRITE", "message": ARTIFACT_MESSAGE, "artifact_failure": details}


def summary(run: dict) -> dict:
    """Aggregate only scored cases and keep all excluded statuses visible."""
    cases = run["cases"]
    scored = [case for case in cases if case["status"] == "scored"]
    return {"selected": len(cases), "attempted": sum(case["application"]["status"] != "not_run" for case in cases),
            "application_completed": sum(case["application"]["status"] == "completed" for case in cases),
            "application_failed": sum(case["application"]["status"] == "failed" for case in cases),
            "application_truncated": sum(case["application"]["status"] == "truncated" for case in cases),
            "scored": len(scored), "failed": sum(case["status"] == "error" for case in cases),
            "incomplete": sum(case["status"] in {"incomplete", "interrupted", "running", "not_run"} for case in cases),
            "excluded_cases": [case["case_id"] for case in cases if case["status"] != "scored"],
            "scored_cases_total": ({"earned": sum(case["total"]["earned"] for case in scored),
                                    "applicable_maximum": sum(case["total"]["applicable_maximum"] for case in scored)} if scored else None),
            "policy": "Descriptive unweighted total for scored cases only; no pass threshold and no CI gate."}


def pretty(value: object) -> str:
    """Display strict JSON as inert escaped text, never active Markdown/HTML."""
    return escape(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2), quote=True)


def detail(title: str, value: object, anchor: str = "") -> str:
    """Render one native disclosure; anchors are generated by this module only."""

    identifier = f' id="{anchor}"' if anchor else ""
    return f'<details{identifier}><summary>{escape(title)}</summary><pre>{pretty(value)}</pre></details>'


def render(run: dict) -> bytes:
    """Build a self-contained report with safe internal links and no external resources."""

    overview = summary(run)
    pieces = ['<!doctype html><html lang="en"><head><meta charset="utf-8">',
              '<meta name="viewport" content="width=device-width,initial-scale=1">',
              '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">',
              '<title>SOC Bot — local investigation evaluation</title><style>',
              'body{font:16px/1.5 system-ui,sans-serif;color:#172337;background:#f5f7fa;margin:0}main{max-width:1200px;margin:auto;padding:24px}',
              'h1,h2,h3{line-height:1.2}section,header{background:white;border:1px solid #cdd7e2;border-radius:8px;padding:20px;margin:18px 0}',
              'pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,monospace;background:#f4f6f8;padding:12px}',
              'table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #cdd7e2;padding:8px;text-align:left;vertical-align:top}',
              '.scroll{overflow:auto}details{margin:12px 0;border-top:1px solid #dbe1e8;padding-top:8px}summary{cursor:pointer;font-weight:600}',
              '.warning{border-left:5px solid #a33;padding:12px;background:#fff3ef}a{color:#164e94;overflow-wrap:anywhere}',
              '@media(max-width:650px){main{padding:10px}section,header{padding:12px}}',
              '</style></head><body><main><header><h1>Investigation evaluation</h1>',
              '<p>Evaluator-only reference keys and evidence — keep this report private. No score proves production safety.</p>',
              f'<p><strong>Run status: {escape(run["status"])}</strong></p>',
              f'<pre>{pretty(overview)}</pre>',
              detail('Run identity, versions, hashes, configuration and limits', run['metadata']),
              detail('Run errors', run.get('errors', [])), '</header>',
              '<div class="scroll"><table><thead><tr><th>Case</th><th>Detection</th><th>Outcomes</th><th>Guidance</th><th>Answer quality</th><th>Earned / applicable</th><th>Application / evidence / judge</th></tr></thead><tbody>']

    for index, case in enumerate(run["cases"]):
        judgment = case["judge"].get("judgment")
        scores = [judgment["criteria"][key]["score"] if judgment else "Unscored" for key in CRITERIA]
        cells = ''.join(f'<td>{"N/A" if item is None else escape(str(item))}</td>' for item in scores)
        total = case.get("total")
        total_text = f'{total["earned"]} / {total["applicable_maximum"]}' if total else 'Unscored'
        stages = ' / '.join(case[key]["status"] for key in ("application", "evidence", "judge"))
        pieces.append(f'<tr><td><a href="#case-{index}">{escape(case["case_id"])}</a> ({escape(case["status"])})</td>{cells}<td>{total_text}</td><td>{escape(stages)}</td></tr>')

    pieces.append('</tbody></table></div>')

    for index, case in enumerate(run["cases"]):
        judgment = case["judge"].get("judgment")
        pieces.extend([f'<section id="case-{index}"><h2>{escape(case["case_id"])}</h2>',
                       '<h3>Question</h3><pre>' + escape(case["reference_key"]["question"]) + '</pre>',
                       '<h3>Exact answer (partial if execution was incomplete)</h3><pre>' + escape(case["application"]["answer"]) + '</pre>'])

        if (case["application"]["terminal"] or {}).get("truncated") is True:
            pieces.append('<p class="warning">TRUNCATED ANSWER — INCOMPLETE: partial answer and evidence are preserved; Bedrock judging was skipped. No scores or total; excluded from the aggregate.</p>')

        elif case["status"] != "scored":
            pieces.append('<p class="warning">UNSCORED / INCOMPLETE: excluded from the aggregate. See stage diagnostics below.</p>')

        if judgment:

            if judgment["unsupported_claims"] or judgment["false_positives"]:
                pieces.append('<div class="warning"><h3>Unsupported claims / false positives</h3><pre>' + pretty({key: judgment[key] for key in ('unsupported_claims', 'false_positives')}) + '</pre></div>')

            for key in CRITERIA:

                item = judgment["criteria"][key]
                label = 'N/A' if item['score'] is None else f'{item["score"]} / 2' + (' — LOW / PARTIAL CREDIT' if item['score'] < 2 else '')
                pieces.append(f'<h3>{escape(key)}: {label}</h3><p>{escape(item["justification"])}</p><ul>')

                for ref in item['references']:
                    pieces.append(f'<li><a href="#case-{index}-bundle">{escape(ref["origin"] + ": " + ref["path"])}</a></li>')

                pieces.append('</ul>')

            pieces.append(detail('Expected versus observed findings and missed findings', {key: judgment[key] for key in ('expected_findings', 'observed_findings', 'missed_findings')}))

        if case["judge"].get("rejected_judgment") is not None:
            pieces.append(detail('Rejected judgment - UNVALIDATED / UNSCORED (untrusted diagnostic only)', case["judge"]["rejected_judgment"]))

        pairs = case["evidence"].get("data", {}).get("pairs", [])
        guidance = [pair for pair in pairs if pair["tool_name"] == "retrieve_sections"]

        pieces.extend([detail('Expected guidance versus actual retrieval', {"expected": case["reference_key"]["expected_guidance"], "retrievals": guidance}),
                       detail('Evidence pointer target: complete judge input (observed versus ground_truth)', case["judge"].get("input"), f'case-{index}-bundle'),
                       detail('Durable selected pairs, checkpoints, attempt references and stage diagnostics', case["evidence"]),
                       detail('Execution checks, declared scope coverage and available agent/query usage', case.get("execution_checks")),
                       detail('Stream events, omissions, identifiers and API timing', case["application"]),
                       detail('Judge settings, usage, timing, validation errors and result', {key: value for key, value in case["judge"].items() if key not in {"input", "rejected_judgment"}}),
                       detail('Reference key snapshot (never sent to the application)', case["reference_key"]),
                       '</section>'])

    pieces.append('<footer><p>Local Git revision does not establish the deployed revision. SDK retries may bill multiple judge attempts. Human calibration and deployed data/reference parity remain operator responsibilities.</p></footer></main></body></html>')
    result = ''.join(pieces).encode('utf-8')
    require(len(result) <= ARTIFACT_BYTES, 'HTML exceeds 16 MiB; prior artifacts preserved.', 'ARTIFACT_LIMIT')
    return result


def atomic(path: Path, data: bytes) -> None:
    """Flush/close one same-directory temp, then atomically replace with bounded Windows sharing retries.

    Retry only replacement winerror 32/33, using the identical closed file after
    100/300 ms. Cleanup touches only this write's temp and cannot hide its primary
    failure; KeyboardInterrupt remains an interruption, including during cleanup.
    """
    artifact = path.name if path.name in ARTIFACT_NAMES else "not_selected"
    operation = "temp_create"
    descriptor = temporary = output = None
    primary = cause = None
    attempts = 0
    try:
        descriptor, temporary = tempfile.mkstemp(prefix='.evaluation-', suffix='.tmp', dir=path.parent)
        operation = "temp_open"
        output = os.fdopen(descriptor, 'wb')
        descriptor = None  # The stream now owns this descriptor.
        operation = "temp_write"
        if output.write(data) != len(data):
            raise OSError(errno.EIO, "Incomplete local artifact write.")
        operation = "temp_flush"
        output.flush()
        operation = "temp_fsync"
        os.fsync(output.fileno())
        operation = "temp_close"
        output.close()
        output = None
        operation = "replace"
        for attempts in range(1, len(REPLACE_DELAYS) + 2):
            try:
                os.replace(temporary, path)
                break
            except OSError as exc:
                winerror = getattr(exc, 'winerror', None)
                if (os.name != 'nt' or type(winerror) is not int or winerror not in SHARING_WINERRORS
                        or attempts > len(REPLACE_DELAYS)):
                    raise
                time.sleep(REPLACE_DELAYS[attempts - 1])
    except BaseException as exc:
        cause = exc
        primary = ArtifactWriteError(operation, artifact, exc, attempts) if isinstance(exc, Exception) else exc
        if isinstance(primary, ArtifactWriteError):
            primary.__cause__ = exc  # Also retain it if cleanup is interrupted before the final raise.

    def cleanup(action, label: str) -> None:
        """Record a secondary close/unlink failure, or report it as primary if writing succeeded."""
        try:
            action()
        except FileNotFoundError as exc:
            if label != 'cleanup_unlink':
                retain(exc, label)
        except KeyboardInterrupt as exc:
            if primary is not None:
                raise exc from primary
            raise
        except Exception as exc:
            retain(exc, label)

    def retain(exc: Exception, label: str) -> None:
        """Preserve primary precedence and a bounded cleanup cause even when the primary is an interrupt."""
        nonlocal primary, cause
        error = ArtifactWriteError(label, artifact, exc, attempts)
        error.__cause__ = exc
        if primary is None:
            primary, cause = error, exc
        elif isinstance(primary, ArtifactWriteError):
            primary.add_cleanup(error)
        else:
            if isinstance(primary.__cause__, ArtifactWriteError):
                primary.__cause__.add_cleanup(error)
            else:
                primary.__cause__ = error

    if output is not None:
        cleanup(output.close, 'temp_close')
    elif descriptor is not None:
        cleanup(lambda: os.close(descriptor), 'temp_close')
    if temporary is not None:
        cleanup(lambda: os.unlink(temporary), 'cleanup_unlink')
    if isinstance(primary, ArtifactWriteError):
        raise primary from cause
    if primary is not None:
        raise primary


def save(directory: Path, run: dict) -> None:
    """Prepare/check both artifacts first; JSON precedes HTML and the pair is not one transaction.

    Failures retain only safe local diagnostics. A successful final best-effort
    save cannot authorize resuming a run stopped by an earlier checkpoint error.
    """
    operation, artifact = 'json_encode', 'results.json'
    try:
        run['summary'] = summary(run)
        data = encoded(run) + b'\n'
        operation = 'json_limit'
        require(len(data) <= ARTIFACT_BYTES, 'JSON exceeds 16 MiB; prior artifacts preserved.', 'ARTIFACT_LIMIT')
        operation, artifact = 'html_render', 'report.html'
        html = render(run)
    except Exception as exc:
        if operation == 'html_render' and isinstance(exc, EvaluationError) and exc.code == 'ARTIFACT_LIMIT':
            operation = 'html_limit'
        raise ArtifactWriteError(operation, artifact, exc) from exc
    atomic(directory / 'results.json', data)
    atomic(directory / 'report.html', html)
