"""Independent bounded Bedrock judge; no tools, repair loop or model-owned totals."""

import json
import re
import time

from .common import EvaluationError, digest, encoded, integer, object_json, require, sdk_call, text

PROMPT_VERSION = "investigation_judge_v2"
PROJECTION_VERSION = "complete_terminal_pairs_v1"
DEFAULT_MODEL = "us.anthropic.claude-sonnet-4-6"
CRITERIA = ("detection_and_false_positives", "evidence_and_outcomes", "retrieved_and_applied_guidance",
            "accuracy_grounding_usefulness_and_uncertainty")
LIMITS = {"request_bytes": 524288, "response_bytes": 65536, "max_tokens": 4096,
          "connect_seconds": 10, "read_seconds": 120, "deadline_seconds": 400, "attempts": 3}


class QuoteValidationError(EvaluationError):
    """Carry private quote diagnostics while keeping the public error text controlled."""

    def __init__(self, judgment_path: str, quote: str, answer: str):
        """Describe the first bounded mismatch without placing model text in exception args."""
        super().__init__("INVALID_DATA", "Discrepancy quote is not in the exact answer.")
        self.details = {"reason": "QUOTE_NOT_IN_ANSWER", "comparison": "exact_substring",
                        "judgment_path": judgment_path, "quote_length": len(quote), "answer_length": len(answer),
                        "quote_json": json.dumps(quote, ensure_ascii=True)}


class MissedFindingsValidationError(EvaluationError):
    """Describe inconsistent missed IDs privately without repairing or scoring the response."""

    def __init__(self, reported: object, findings: dict):
        """Classify the first failed condition and derive expected IDs from validated assessments."""
        super().__init__("INVALID_DATA", "Inconsistent missed findings.")
        if not isinstance(reported, list) or not all(isinstance(item, str) for item in reported):
            mismatch_type = "type_mismatch"
        elif len(set(reported)) != len(reported):
            mismatch_type = "duplicate_ids"
        else:
            mismatch_type = "set_mismatch"
        self.details = {"reason": "MISSED_FINDINGS_INCONSISTENT", "judgment_path": "/missed_findings",
                        "expected_missed_ids": sorted(key for key, finding in findings.items() if finding["assessment"] == "missed"),
                        "mismatch_type": mismatch_type}


class ReferenceValidationError(EvaluationError):
    """Carry private reference-check locations without exposing judge/evidence text in errors."""

    def __init__(self, message: str, failed_check: str, judgment_path: str | None,
                 pointer: dict | None = None, traversal_index: int | None = None):
        """Attach supplied pointer strings only after shape validation; never include traversed values."""
        super().__init__("INVALID_DATA", message)
        self.details = {"reason": "INVALID_JUDGE_REFERENCE", "failed_check": failed_check, "judgment_path": judgment_path}
        if pointer is not None:
            self.details.update(reference_origin=pointer["origin"], reference_path=pointer["path"])
        if traversal_index is not None:
            self.details["traversal_index"] = traversal_index


def reference_require(condition: bool, message: str, failed_check: str, judgment_path: str | None,
                      pointer: dict | None = None, traversal_index: int | None = None) -> None:
    """Keep existing reference predicates fail-fast while handing private locations to grade()."""
    if not condition:
        raise ReferenceValidationError(message, failed_check, judgment_path, pointer, traversal_index)


def judgment_segment(key: str) -> str:
    """Escape a returned-judgment object key for diagnostics, never modify evidence pointers."""
    return key.replace("~", "~0").replace("/", "~1")


def settings(model: str) -> dict:
    """Send model-specific controls only for the reviewed Sonnet 4.6 identifier."""

    configuration = {"inferenceConfig": {"maxTokens": LIMITS["max_tokens"]}}

    if model == DEFAULT_MODEL or model.endswith("/" + DEFAULT_MODEL):
        configuration["inferenceConfig"]["temperature"] = 0
        configuration["additionalModelRequestFields"] = {"thinking": {"type": "disabled"}}

    return configuration


def bundle(case: dict, application: dict, evidence: dict, checks: dict) -> dict:
    """Keep all selected terminal evidence; omit only transport and pending audit data."""

    return {"projection_version": PROJECTION_VERSION, "case_id": case["case_id"],
            "ground_truth": case,
            "observed": {"question": case["question"], "answer": application["answer"],
                         "user_message": evidence["user_message"], "assistant_message": evidence["assistant_message"],
                         "pairs": evidence["pairs"], "execution_checks": checks}}


def request(model: str, prompt: str, data: dict) -> dict:
    """Bound the complete Converse payload, never truncate rows or retrieved sections."""

    payload = {"modelId": model, "system": [{"text": prompt}],
               "messages": [{"role": "user", "content": [{"text": encoded(data).decode("utf-8")}]}], **settings(model)}
    require(len(encoded(payload)) <= LIMITS["request_bytes"], "Complete judge request exceeds 512 KiB; no partial-grounding score.", "JUDGE_INPUT_LIMIT")
    return payload


def resolve_pointer(pointer: dict, data: dict, judgment_path: str | None = None):
    """Locate the exact value identified by a judge's evidence or ground-truth reference.

    Require the path prefix to agree with its origin, then walk dictionary keys
    and zero-based list indices, decoding RFC 6901 escapes (~1 for / and ~0 for ~).
    Return the value at that location, whether scalar, list or dictionary, and
    raise ReferenceValidationError (an EvaluationError) for controlled invalid
    syntax, missing keys or out-of-range indices. Optional judgment_path locates
    the returned reference for private diagnostics, not the evidence being read.

    Example input:
        pointer = {
            "origin": "observed",
            "path": "/observed/pairs/0/output/rows/0/request_id",
        }
        data = {
            "observed": {
                "pairs": [
                    {"output": {"rows": [{"request_id": "request-001"}]}},
                ],
            },
        }

    Example output:
        "request-001"
    """

    reference_require(isinstance(pointer, dict) and set(pointer) == {"origin", "path"}
                      and pointer["origin"] in {"observed", "ground_truth"} and text(pointer["path"], 1024),
                      "Invalid judge reference.", "reference_shape", judgment_path)

    path = pointer["path"]
    reference_require(path.startswith("/" + pointer["origin"] + "/"), "Reference origin/path disagree.",
                      "origin_path", judgment_path, pointer)
    value = data

    for traversal_index, component in enumerate(path[1:].split("/")):

        # Only RFC 6901's two escapes are valid; no forgiving path repair.
        reference_require(not re.search(r"~(?![01])", component), "Invalid JSON pointer escape.",
                          "pointer_escape", judgment_path, pointer, traversal_index)
        key = component.replace("~1", "/").replace("~0", "~")

        if isinstance(value, list):
            reference_require(bool(re.fullmatch(r"0|[1-9][0-9]*", key)) and int(key) < len(value),
                              "Unresolvable judge array reference.", "array_index", judgment_path, pointer, traversal_index)
            value = value[int(key)]

        else:
            reference_require(isinstance(value, dict) and key in value, "Unresolvable judge object reference.",
                              "object_key", judgment_path, pointer, traversal_index)
            value = value[key]

    return value


def references(values: object, data: dict, judgment_path: str | None = None) -> None:
    """Validate an assessment's supporting reference list against the judge input bundle.

    Require one to eight distinct pointers and pass each to resolve_pointer() so
    its origin and path resolve to supplied evidence or ground truth. Allow any
    valid supplied evidence location, rather than only the answer key's exemplars.
    Optional judgment_path locates the returned reference list; each indexed
    reference inherits that diagnostic location without changing its evidence path.

    Example input (other judge-bundle fields omitted):
        values = [
            {
                "origin": "observed",
                "path": "/observed/pairs/0/output/rows/0/request_id",
            },
            {
                "origin": "ground_truth",
                "path": "/ground_truth/acceptable_evidence/0/source_record_ref",
            },
        ]
        data = {
            "observed": {
                "pairs": [
                    {"output": {"rows": [{"request_id": "request-001"}]}},
                ],
            },
            "ground_truth": {
                "acceptable_evidence": [
                    {"source_record_ref": "request-001"},
                ],
            },
        }
    """

    reference_require(isinstance(values, list) and 1 <= len(values) <= 8, "Expected one to eight judge references.",
                      "list_cardinality", judgment_path)
    reference_require(len({encoded(item) for item in values}) == len(values), "Duplicate judge references.",
                      "list_uniqueness", judgment_path)
    for index, value in enumerate(values):
        resolve_pointer(value, data, f"{judgment_path}/{index}" if judgment_path is not None else None)


def validate(value: dict, data: dict) -> dict:
    """Validate the entire judgment before calculating any dimension or total."""

    case = data["ground_truth"]
    expected_keys = {"case_id", "criteria", "expected_findings", "observed_findings", "missed_findings", "false_positives", "unsupported_claims"}
    require(set(value) == expected_keys and value["case_id"] == case["case_id"], "Judge case/fields mismatch.")
    require(isinstance(value["criteria"], dict) and set(value["criteria"]) == set(CRITERIA), "Judge criterion identities mismatch.")

    for key, score in value["criteria"].items():

        expected = case["scoring_notes"]["criteria"][key]["applicability"]
        require(isinstance(score, dict) and set(score) == {"applicability", "score", "justification", "references"}
                and score["applicability"] == expected and text(score["justification"], 1500), "Invalid criterion assessment.")

        require((score["score"] is None if expected == "not_applicable" else type(score["score"]) is int and 0 <= score["score"] <= 2), "Invalid criterion score/applicability.")
        references(score["references"], data, f"/criteria/{judgment_segment(key)}/references")

    finding_ids = {finding["finding_id"] for finding in case["expected_findings"]}
    require(isinstance(value["expected_findings"], dict) and set(value["expected_findings"]) == finding_ids, "Judge finding identities mismatch.")

    for finding_id, finding in value["expected_findings"].items():

        require(isinstance(finding, dict) and set(finding) == {"assessment", "justification", "references"}
                and finding["assessment"] in {"detected", "partial", "missed"} and text(finding["justification"], 1500), "Invalid finding assessment.")

        references(finding["references"], data, f"/expected_findings/{judgment_segment(finding_id)}/references")

    missed = value["missed_findings"]

    if not (isinstance(missed, list) and all(isinstance(item, str) for item in missed)
            and len(set(missed)) == len(missed) and set(missed) == {
                key for key, finding in value["expected_findings"].items() if finding["assessment"] == "missed"}):
        raise MissedFindingsValidationError(missed, value["expected_findings"])

    for name in ("observed_findings", "false_positives", "unsupported_claims"):

        items = value[name]
        require(isinstance(items, list) and len(items) <= 16, "Judge finding/discrepancy array exceeds cap.")

        for index, item in enumerate(items):

            field = "description" if name == "observed_findings" else "answer_quote"
            require(isinstance(item, dict) and set(item) == {field, "justification", "references"}
                    and text(item[field], 1500) and text(item["justification"], 1500), "Invalid finding/discrepancy description.")

            if field == "answer_quote" and item[field] not in data["observed"]["answer"]:
                raise QuoteValidationError(f"/{name}/{index}/answer_quote", item[field], data["observed"]["answer"])

            references(item["references"], data, f"/{name}/{index}/references")

    return value


def total(judgment: dict) -> dict:
    """Compute a descriptive unweighted earned/applicable total, with no threshold."""

    scores = [item["score"] for item in judgment["criteria"].values() if item["applicability"] == "applicable"]
    return {"earned": sum(scores), "applicable_maximum": 2 * len(scores)}


def grade(session, payload: dict, data: dict, stage: dict) -> dict:
    """Submit the prepared Converse request and validate the returned case judgment.

    Use bounded SDK attempts, record attempt/stop-reason/token metadata in stage,
    and join all response text blocks before strict JSON, rubric and reference
    validation. Return the validated judgment without a total, raising on malformed
    or unfinished output; the caller handles eligibility, totals and stage status.
    Only valid-JSON exact-quote, missed-findings consistency or controlled reference
    failures preserve bounded text/parsed JSON in stage.rejected_judgment. Its
    validation_failure identifies the quote, missed IDs or returned reference
    location; no rejected judgment is scored, repaired or automatically regraded.

    Example input (payload text and reference/evidence snapshots abbreviated):
        session = boto3.Session(
            profile_name="soc-bot-evaluator", region_name="us-east-1",
        )
        payload = {
            "modelId": "us.anthropic.claude-sonnet-4-6",
            "system": [{"text": "...versioned judge instructions..."}],
            "messages": [
                {"role": "user", "content": [{"text": "...complete data as JSON..."}]},
            ],
            "inferenceConfig": {"maxTokens": 4096, "temperature": 0},
            "additionalModelRequestFields": {"thinking": {"type": "disabled"}},
        }
        data = {
            "case_id": "app-benign-001",
            "ground_truth": {
                "case_id": "app-benign-001", "expected_findings": [],
                "scoring_notes": {
                    "criteria": {
                        "detection_and_false_positives": {
                            "applicability": "applicable",
                            # The full 0/1/2 anchors and other three criteria omitted.
                        },
                    },
                },
                # Other reviewed case fields omitted.
            },
            "observed": {
                "answer": "No clear malicious activity in the inspected records.",
                "pairs": [],  # Full selected tool evidence omitted here.
            },
            # Other bundle fields omitted; payload contains the complete snapshot.
        }
        stage = {"status": "incomplete", "usage": None}

    Example possible output (criterion entries abbreviated; no model-owned total):
        {
            "case_id": "app-benign-001",
            "criteria": {
                "detection_and_false_positives": {
                    "applicability": "applicable", "score": 2,
                    "justification": "The answer makes a bounded negative finding.",
                    "references": [{"origin": "observed", "path": "/observed/answer"}],
                },
                # Other three assessments omitted; benign guidance has score None.
            },
            "expected_findings": {}, "observed_findings": [],
            "missed_findings": [], "false_positives": [], "unsupported_claims": [],
        }

    stage additions after that response (illustrative usage, existing fields retained):
        {
            "service_attempts": 1, "stop_reason": "end_turn",
            "usage": {"inputTokens": 1200, "outputTokens": 400, "totalTokens": 1600},
        }
    """

    from botocore.config import Config

    deadline = time.monotonic() + LIMITS["deadline_seconds"]

    def converse(stop_at):
        """Own the SDK client in the worker; do not return private transport metadata."""

        client = session.client("bedrock-runtime", config=Config(connect_timeout=10, read_timeout=120,
                                retries={"total_max_attempts": 1}))

        try:
            require(time.monotonic() < stop_at, "Judge deadline exceeded.", "STAGE_DEADLINE")
            return client.converse(**payload)

        finally:
            client.close()

    response = sdk_call(converse, deadline, stage)
    stage["stop_reason"] = response.get("stopReason")
    usage = response.get("usage", {})
    require(isinstance(usage, dict), "Invalid judge usage metadata.")
    stage["usage"] = {key: usage[key] for key in ("inputTokens", "outputTokens", "totalTokens", "cacheReadInputTokens", "cacheWriteInputTokens") if key in usage}
    require(all(integer(item) for item in stage["usage"].values()), "Invalid judge token count.")
    require(stage["stop_reason"] in {"end_turn", "stop_sequence"}, "Judge did not finish normally (truncation/tool use is not a score).", "JUDGE_RESPONSE")
    message = response.get("output", {}).get("message", {})
    blocks = message.get("content")
    require(message.get("role") == "assistant" and isinstance(blocks, list) and 1 <= len(blocks) <= 128, "Invalid judge message.")
    require(all(isinstance(block, dict) and set(block) == {"text"} and text(block["text"], 65536, empty=True) for block in blocks), "Judge returned non-text/tool/reasoning content.", "JUDGE_RESPONSE")
    response_text = "".join(block["text"] for block in blocks)
    response_bytes = response_text.encode("utf-8")
    require(len(response_bytes) <= LIMITS["response_bytes"], "Judge response exceeds cap.", "JUDGE_RESPONSE")
    output = response_text.strip()

    if output.startswith("```json\n") and output.endswith("\n```"):
        output = output[len("```json\n"):-len("\n```")]

    parsed = object_json(output.encode("utf-8"))
    try:
        return validate(parsed, data)

    except (QuoteValidationError, MissedFindingsValidationError, ReferenceValidationError) as exc:
        stage["rejected_judgment"] = {"response_text": response_text, "response_text_bytes": len(response_bytes),
                                      "response_text_sha256": digest(response_bytes), "parsed_unvalidated_judgment": parsed,
                                      "validation_failure": exc.details}
        raise
