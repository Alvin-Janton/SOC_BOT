"""Small shared validation, serialization and bounded SDK-call helpers."""

from datetime import datetime, timezone
from hashlib import sha256
import json
import queue
import re
import threading
import time

from scripts.chat_client import decode_object


class EvaluationError(Exception):
    """Carry a safe diagnostic, never a raw provider exception or response body."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def require(condition: bool, message: str, code: str = "INVALID_DATA") -> None:
    """Reject a contract violation with a controlled diagnostic."""

    if not condition:
        raise EvaluationError(code, message)


def encoded(value: object) -> bytes:
    """Serialize canonical, lossless JSON; reject NaN and invalid Unicode."""

    try:
        return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                          separators=(",", ":")).encode("utf-8")

    except (ValueError, TypeError, UnicodeError, RecursionError) as exc:
        raise EvaluationError("INVALID_JSON", "Value is not bounded UTF-8 JSON.") from exc


def object_json(data: bytes) -> dict:
    """Use the manual client's duplicate-key/constant/UTF-8 checks without rendering."""

    try:
        value = decode_object(data)
        encoded(value)
        return value

    except Exception as exc:
        raise EvaluationError("INVALID_JSON", "Expected a strict UTF-8 JSON object.") from exc


def text(value: object, maximum: int = 2048, empty: bool = False) -> bool:
    """Check a bounded Unicode string without coercing other data types."""

    return isinstance(value, str) and (empty or bool(value.strip())) and len(value) <= maximum


def integer(value: object, minimum: int = 0) -> bool:
    """Exclude JSON booleans from integer contracts."""
    return type(value) is int and value >= minimum


def utc(value: object) -> datetime:
    """Parse an explicit UTC ISO timestamp, rejecting implicit/local offsets."""

    require(isinstance(value, str) and bool(re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", value)), "Expected a UTC timestamp.")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))

    except ValueError as exc:
        raise EvaluationError("INVALID_DATA", "Invalid UTC timestamp.") from exc


def now() -> str:
    """Return an artifact timestamp independent of local timezone."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def digest(data: bytes) -> str:
    """Identify exact input bytes without exposing credentials or environment state."""
    return sha256(data).hexdigest()


def diagnostic(exc: BaseException) -> dict:
    """Persist only controlled errors or a generic exception class, not SDK messages."""

    if isinstance(exc, EvaluationError):
        return {"code": exc.code, "message": str(exc)}

    return {"code": type(exc).__name__, "message": "Local stage failed; no raw diagnostic was archived."}


def sdk_call(action, deadline: float, statistics: dict):
    """Bound SDK work and transient retries; never retry an unfinished worker.

    The daemon worker owns and closes its client. A local deadline/interrupt does
    not prove remote cancellation; late results are discarded, never graded.
    """

    transient_codes = {"ThrottlingException", "TooManyRequestsException", "ServiceUnavailableException",
                       "InternalServerException", "InternalServerError", "ModelNotReadyException",
                       "ModelTimeoutException", "ProvisionedThroughputExceededException", "RequestLimitExceeded"}
    transient_types = {"ConnectTimeoutError", "ReadTimeoutError", "EndpointConnectionError", "ConnectionClosedError"}

    for attempt in range(3):
        remaining = deadline - time.monotonic()
        require(remaining > 0, "Stage deadline exceeded; remote completion may be unknown.", "STAGE_DEADLINE")
        mailbox = queue.Queue(maxsize=1)

        def invoke():
            """Return one result/exception privately to the waiting stage."""
            try:
                mailbox.put((True, action(deadline)))
            except Exception as exc:
                mailbox.put((False, exc))

        statistics["service_attempts"] = statistics.get("service_attempts", 0) + 1
        threading.Thread(target=invoke, daemon=True).start()

        try:
            succeeded, result = mailbox.get(timeout=remaining)

        except queue.Empty as exc:
            raise EvaluationError("STAGE_DEADLINE", "Stage deadline exceeded; remote completion may be unknown.") from exc

        if succeeded:
            require(time.monotonic() <= deadline, "Stage deadline exceeded.", "STAGE_DEADLINE")
            return result

        if isinstance(result, EvaluationError):
            raise result

        response = getattr(result, "response", {})
        code = response.get("Error", {}).get("Code", "") if isinstance(response, dict) else ""
        transient = code in transient_codes or type(result).__name__ in transient_types
        safe_code = code if isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", code) else type(result).__name__
        statistics.setdefault("attempt_failures", []).append({"attempt": attempt + 1, "transient": transient, "code": safe_code})

        if not transient or attempt == 2:
            raise EvaluationError("SDK_REQUEST_FAILED", "SDK request failed; check profile, permissions, availability and recorded retry counts.") from result
            
        wait = 0.5 * 2 ** attempt
        require(time.monotonic() + wait < deadline, "Stage deadline exceeded.", "STAGE_DEADLINE")
        time.sleep(wait)
    raise AssertionError("Unreachable SDK retry state")
