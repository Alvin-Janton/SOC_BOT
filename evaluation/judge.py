"""Independent bounded Bedrock judge; no tools, repair loop or model-owned totals."""

import re
import time

from .common import encoded, integer, object_json, require, sdk_call, text

PROMPT_VERSION = "investigation_judge_v1"
PROJECTION_VERSION = "complete_terminal_pairs_v1"
DEFAULT_MODEL = "us.anthropic.claude-sonnet-4-6"
CRITERIA = ("detection_and_false_positives", "evidence_and_outcomes", "retrieved_and_applied_guidance",
            "accuracy_grounding_usefulness_and_uncertainty")
LIMITS = {"request_bytes": 524288, "response_bytes": 65536, "max_tokens": 4096,
          "connect_seconds": 10, "read_seconds": 120, "deadline_seconds": 400, "attempts": 3}


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


def resolve_pointer(pointer: dict, data: dict):
    """Locate the exact value identified by a judge's evidence or ground-truth reference.

    Require the path prefix to agree with its origin, then walk dictionary keys
    and zero-based list indices, decoding RFC 6901 escapes (~1 for / and ~0 for ~).
    Return the value at that location, whether scalar, list or dictionary, and
    raise EvaluationError for invalid syntax, missing keys or out-of-range indices.

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

    require(isinstance(pointer, dict) and set(pointer) == {"origin", "path"}
            and pointer["origin"] in {"observed", "ground_truth"} and text(pointer["path"], 1024), "Invalid judge reference.")

    path = pointer["path"]
    require(path.startswith("/" + pointer["origin"] + "/"), "Reference origin/path disagree.")
    value = data

    for component in path[1:].split("/"):

        # Only RFC 6901's two escapes are valid; no forgiving path repair.
        require(not re.search(r"~(?![01])", component), "Invalid JSON pointer escape.")
        key = component.replace("~1", "/").replace("~0", "~")

        if isinstance(value, list):
            require(bool(re.fullmatch(r"0|[1-9][0-9]*", key)) and int(key) < len(value), "Unresolvable judge array reference.")
            value = value[int(key)]

        else:
            require(isinstance(value, dict) and key in value, "Unresolvable judge object reference.")
            value = value[key]

    return value


def references(values: object, data: dict) -> None:
    """Validate an assessment's supporting reference list against the judge input bundle.

    Require one to eight distinct pointers and pass each to resolve_pointer() so
    its origin and path resolve to supplied evidence or ground truth. Allow any
    valid supplied evidence location, rather than only the answer key's exemplars.

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

    require(isinstance(values, list) and 1 <= len(values) <= 8, "Expected one to eight judge references.")
    require(len({encoded(item) for item in values}) == len(values), "Duplicate judge references.")
    for value in values:
        resolve_pointer(value, data)


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
        references(score["references"], data)

    finding_ids = {finding["finding_id"] for finding in case["expected_findings"]}
    require(isinstance(value["expected_findings"], dict) and set(value["expected_findings"]) == finding_ids, "Judge finding identities mismatch.")

    for finding in value["expected_findings"].values():

        require(isinstance(finding, dict) and set(finding) == {"assessment", "justification", "references"}
                and finding["assessment"] in {"detected", "partial", "missed"} and text(finding["justification"], 1500), "Invalid finding assessment.")

        references(finding["references"], data)

    missed = value["missed_findings"]

    require(isinstance(missed, list) and all(isinstance(item, str) for item in missed)
            and len(set(missed)) == len(missed) and set(missed) == {
                key for key, finding in value["expected_findings"].items() if finding["assessment"] == "missed"}, "Inconsistent missed findings.")

    for name in ("observed_findings", "false_positives", "unsupported_claims"):

        items = value[name]
        require(isinstance(items, list) and len(items) <= 16, "Judge finding/discrepancy array exceeds cap.")

        for item in items:

            field = "description" if name == "observed_findings" else "answer_quote"
            require(isinstance(item, dict) and set(item) == {field, "justification", "references"}
                    and text(item[field], 1500) and text(item["justification"], 1500), "Invalid finding/discrepancy description.")

            if field == "answer_quote":
                require(item[field] in data["observed"]["answer"], "Discrepancy quote is not in the exact answer.")

            references(item["references"], data)

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
    output = "".join(block["text"] for block in blocks).strip()
    require(len(output.encode("utf-8")) <= LIMITS["response_bytes"], "Judge response exceeds cap.", "JUDGE_RESPONSE")

    if output.startswith("```json\n") and output.endswith("\n```"):
        output = output[len("```json\n"):-len("\n```")]

    return validate(object_json(output.encode("utf-8")), data)
