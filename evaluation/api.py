"""Bounded authenticated CloudFront session inspection and non-retrying chat; no AWS credentials forwarded."""

import http.client
from argparse import ArgumentTypeError
import queue
import re
import socket
import ssl
import threading
import time
from urllib.parse import urlsplit
from urllib.request import Request

from scripts.client_common import AUTH_PATHS, SessionState, base_argument, public_session
from scripts.chat_client import turn_argument

from .common import EvaluationError, diagnostic, encoded, now, object_json, require, text, utc

LIMITS = {"inactivity_seconds": 60, "deadline_seconds": 900, "line_bytes": 262144,
          "stream_bytes": 1048576, "answer_bytes": 32768, "activity_events": 1024,
          "error_bytes": 8192, "session_inactivity_seconds": 10, "session_deadline_seconds": 15}
IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
ACTIVITY_FIELDS = {"type", "turnId", "stage", "operation", "table", "toolUseId", "toolName", "documentId",
                   "requestedSections", "documentsReturned", "sectionsReturned", "rowsReturned", "code", "message"}


def initial(turn_id: str) -> dict:
    """Create a persisted request identity before dispatch is allowed."""

    return {"status": "not_run", "turn_id": turn_id, "conversation_id": None, "attempt_id": None, "http_status": None,
            "admission_rejected": False,
            "answer": "", "events": [], "heartbeat_count": 0, "terminal": None,
            "received_bytes": 0, "wall_seconds": None, "error": None,
            "started_at": None, "finished_at": None,
            "transport_omissions": "Heartbeats are counted, not individually archived."}


def accept(event: dict, capture: dict) -> bool:
    """Validate and retain one protocol event; return whether it is terminal."""

    kind = event.get("type")
    require(event.get("turnId", capture["turn_id"]) == capture["turn_id"], "Conflicting stream turn ID.", "STREAM_PROTOCOL")

    if kind == "conversation":
        require({"type", "turnId", "conversationId"} <= set(event)
                <= {"type", "turnId", "conversationId", "attemptId"}, "Invalid conversation event.")
        conversation = event["conversationId"]
        require(isinstance(conversation, str) and bool(IDENTIFIER.fullmatch(conversation)), "Invalid conversation ID.")
        require(capture["conversation_id"] in (None, conversation), "Conflicting conversation ID.")
        if "attemptId" in event:
            require(isinstance(event["attemptId"], str), "Invalid attempt ID.")
            try:
                turn_argument(event["attemptId"])
            except ArgumentTypeError as exc:
                raise EvaluationError("STREAM_PROTOCOL", "Invalid attempt ID.") from exc
        if capture["conversation_id"] is not None:
            require(capture["attempt_id"] == event.get("attemptId"), "Conflicting acquired attempt identity.")
        capture["conversation_id"] = conversation
        capture["attempt_id"] = event.get("attemptId")

    elif kind == "text_delta":
        require(set(event) <= {"type", "text", "turnId"} and text(event.get("text"), 32768, empty=True), "Invalid answer delta.")
        require(capture["conversation_id"] is not None, "Answer preceded conversation identity.")
        answer = capture["answer"] + event["text"]
        require(len(answer.encode("utf-8")) <= LIMITS["answer_bytes"], "Answer exceeds 32 KiB; no score produced.", "STREAM_LIMIT")
        capture["answer"] = answer

    elif kind == "heartbeat":
        require(set(event) == {"type", "turnId", "stage"} and event["stage"] == "processing", "Invalid heartbeat.")
        capture["heartbeat_count"] += 1
        return False

    elif kind == "activity":
        require(set(event) <= ACTIVITY_FIELDS and text(event.get("stage"), 128), "Invalid activity event.")

        for key, value in event.items():
            require((type(value) is int and 0 <= value <= 100000) or text(value, 2048), "Invalid activity field.")
        require(sum(item["type"] == "activity" for item in capture["events"]) < LIMITS["activity_events"], "Activity cap exceeded.", "STREAM_LIMIT")

    elif kind == "complete":
        require(set(event) == {"type", "turnId", "conversationId", "replayed", "truncated"}
                and type(event["replayed"]) is bool and type(event["truncated"]) is bool, "Invalid completion event.")
        require(capture["conversation_id"] is not None and event["conversationId"] == capture["conversation_id"], "Completion identity mismatch.")
        require(bool(capture["answer"]), "Completion has no answer.")
        require((capture["attempt_id"] is None) if event["replayed"] else capture["attempt_id"] is not None,
                "Completion does not match acquired versus replay identity.", "STREAM_PROTOCOL")
        capture["status"] = "unexpected_replay" if event["replayed"] else "truncated" if event["truncated"] else "completed"

    elif kind == "error":
        required = {"type", "turnId", "code", "message", "retryable", "correlationId"}
        require(required <= set(event) <= required | {"conversationId"}
                and type(event["retryable"]) is bool and text(event["code"], 128)
                and text(event["message"], 2048) and text(event["correlationId"], 128), "Invalid error event.")
        if event["code"] == "TURN_CANCELLED":
            require(event["retryable"] is False, "Cancellation cannot be retryable.")
        if "conversationId" in event:
            require(event["code"] == "TURN_CANCELLED" and isinstance(event["conversationId"], str)
                    and bool(IDENTIFIER.fullmatch(event["conversationId"]))
                    and capture["conversation_id"] == event["conversationId"], "Invalid cancellation identity.")
        capture["status"] = "failed"

    else:
        raise EvaluationError("STREAM_PROTOCOL", "Unknown stream event type.")
    capture["events"].append(event)

    if kind in {"complete", "error"}:
        capture["terminal"] = event
        return True

    return False


def require_active_session(session: SessionState, expires_at: str | None = None) -> None:
    """Reject an absent/expired pinned cookie before dispatch; the server still authorizes every request."""
    require(session.cookie is not None, "An existing authenticated session is required.", "SESSION_REQUIRED")
    expiry = session.cookie["expires"]
    if expires_at is not None:
        expiry = min(expiry, utc(expires_at).timestamp())
    require(time.time() < expiry, "The pinned session expired; authenticate explicitly and start a new run.", "SESSION_EXPIRED")


def request_headers(session: SessionState, action: str, accept: str) -> dict:
    """Attach the pinned host-only cookie through the shared jar to one fixed CloudFront route."""
    require_active_session(session)
    require(action in {"me", "chat"} and base_argument(session.origin) == session.origin,
            "Unexpected authenticated endpoint configuration.", "SESSION_CONFIGURATION")
    headers = {"Origin": session.origin, "Accept": accept}
    if action == "chat":
        headers["Content-Type"] = "application/json"
    request = Request(session.origin + AUTH_PATHS[action], method="GET" if action == "me" else "POST", headers=headers)
    session.cookie_jar().add_cookie_header(request)
    require(request.has_header("Cookie"), "The pinned session cannot authorize this request.", "SESSION_EXPIRED")
    return dict(request.header_items())


def http_failure(response) -> dict:
    """Inspect at most 8 KiB, accepting exact auth/requestId or orchestrator/correlationId error envelopes."""
    try:
        if response.headers.get_content_type() != "application/json":
            return {"body_status": "non_json"}
        body = response.read(LIMITS["error_bytes"] + 1)
        if len(body) > LIMITS["error_bytes"]:
            return {"body_status": "oversized"}
        value = object_json(body)
        error = value.get("error")
        if (set(value) not in ({"error", "requestId"}, {"error", "correlationId"}) or not isinstance(error, dict)
                or set(error) != {"code", "message"} or not isinstance(error["code"], str)
                or not re.fullmatch(r"[A-Z_]{1,64}", error["code"]) or not text(error["message"], 2048)):
            return {"body_status": "unrecognized"}
        result = {"body_status": "recognized", "code": error["code"]}
        if "requestId" in value:
            request_id = value["requestId"]
            if not isinstance(request_id, str) or not IDENTIFIER.fullmatch(request_id):
                return {"body_status": "unrecognized"}
            result["requestId"] = request_id
        else:
            correlation = value["correlationId"]
            if not isinstance(correlation, str):
                return {"body_status": "unrecognized"}
            try:
                turn_argument(correlation)
            except ArgumentTypeError:
                return {"body_status": "unrecognized"}
            result["correlationId"] = correlation
        return result
    except Exception:
        return {"body_status": "unreadable"}


def inspect_session(session: SessionState, capture: dict) -> None:
    """Check /auth/me once within 15 seconds, retaining only validated public identity and safe failures.

    A daemon worker bounds even an OS resolver wait; late results are discarded.
    Deadline cleanup interrupts established sockets, and a late connection checks
    shutdown/deadline before it can issue the GET. No cookie is adopted or saved.
    """
    started = time.monotonic()
    deadline = started + LIMITS["session_deadline_seconds"]
    capture.update(status="checking", http_status=None)
    headers = request_headers(session, "me", "application/json")
    target = urlsplit(session.origin)
    connection = http.client.HTTPSConnection(target.hostname, timeout=LIMITS["session_inactivity_seconds"],
                                            context=ssl.create_default_context())
    connection.auto_open = 0  # Manual connect only: deadline cleanup must not trigger an implicit reconnect.
    active_socket = None
    response = None
    stopped = threading.Event()
    mailbox = queue.Queue(maxsize=1)
    observed = {"http_status": None}

    def close_connection():
        """Stop established I/O without adopting response cookies or accepting late identity results."""
        stopped.set()
        if active_socket is not None:
            try:
                active_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        try:
            connection.close()
        except OSError:
            pass

    def inspect():
        """Perform one bounded read-only GET; publish no raw errors, headers or private response data."""
        nonlocal active_socket, response
        status, value, failure, details = None, None, None, None
        try:
            connection.connect()
            active_socket = connection.sock
            require(not stopped.is_set() and time.monotonic() < deadline, "Session check deadline exceeded.", "SESSION_CHECK_DEADLINE")
            active_socket.settimeout(min(LIMITS["session_inactivity_seconds"], max(0.001, deadline - time.monotonic())))
            require_active_session(session)
            connection.request("GET", AUTH_PATHS["me"], headers=headers)
            response = connection.getresponse()
            status = response.status
            observed["http_status"] = status
            if status != 200:
                details = http_failure(response)
                code = "SESSION_REJECTED" if status == 401 else "AUTHORIZATION_DENIED" if status == 403 else "SESSION_CHECK_HTTP"
                raise EvaluationError(code, "Session check was rejected; no cases were dispatched and no session was changed.")
            require(not response.headers.get_all("Set-Cookie", []), "Unexpected cookie on session inspection.", "SESSION_PROTOCOL")
            value = public_session(response)
            expiry = utc(value["expiresAt"]).timestamp()
            require(expiry > time.time() and int(expiry) == session.cookie["expires"],
                    "Public session expiry does not match the pinned active cookie.", "SESSION_PROTOCOL")
            require(not stopped.is_set() and time.monotonic() < deadline, "Session check deadline exceeded.", "SESSION_CHECK_DEADLINE")
        except Exception as exc:
            failure = diagnostic(exc) if isinstance(exc, EvaluationError) else {
                "code": "SESSION_CHECK_FAILED", "message": "Session check failed; no raw network or protocol diagnostic was archived."}
        finally:
            try:
                if response is not None:
                    response.close()
                connection.close()
            except Exception:
                failure = failure or {"code": "SESSION_CHECK_FAILED", "message": "Session check cleanup could not be confirmed."}
            mailbox.put((status, value, failure, details))

    worker = threading.Thread(target=inspect, daemon=True)
    try:
        worker.start()
        try:
            status, value, failure, details = mailbox.get(timeout=max(0, deadline - time.monotonic()))
        except queue.Empty as exc:
            capture["http_status"] = observed["http_status"]
            if observed["http_status"] in {401, 403}:
                code = "SESSION_REJECTED" if observed["http_status"] == 401 else "AUTHORIZATION_DENIED"
                raise EvaluationError(code, "Session check was rejected; bounded error inspection did not complete.") from exc
            raise EvaluationError("SESSION_CHECK_DEADLINE", "Session check exceeded its absolute deadline; no cases were dispatched.") from exc
        capture["http_status"] = status
        if details is not None:
            capture["http_error"] = details
        if failure is not None:
            raise EvaluationError(failure["code"], failure["message"])
        require(time.monotonic() < deadline, "Session check deadline exceeded.", "SESSION_CHECK_DEADLINE")
        require_active_session(session, value["expiresAt"])
        capture.update(status="confirmed", userId=value["userId"], expiresAt=value["expiresAt"], checked_at=now())
    except KeyboardInterrupt:
        capture.update(status="interrupted", error={"code": "INTERRUPTED", "message": "Session inspection interrupted; no case dispatched."})
        raise
    except Exception as exc:
        capture.update(status="error", error=diagnostic(exc))
        raise
    finally:
        close_connection()
        if worker.ident is not None:
            worker.join(timeout=0)
        capture["wall_seconds"] = round(time.monotonic() - started, 6)


def collect(session: SessionState, question: str, capture: dict) -> None:
    """POST only turnId/question, preserving exact deltas even on a partial failure."""

    started = time.monotonic()
    capture["started_at"] = now()
    deadline = started + LIMITS["deadline_seconds"]
    target = urlsplit(session.origin)
    connection = http.client.HTTPSConnection(target.hostname, target.port or 443,
                                            timeout=LIMITS["inactivity_seconds"], context=ssl.create_default_context())
    connection.auto_open = 0  # Preserve exactly one explicit connect/request after timer shutdown.
    active_socket = None
    response = None

    def expire():
        """Interrupt a slow/trickling socket at the absolute transport deadline."""
        if active_socket is not None:
            try:
                active_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        connection.close()

    timer = threading.Timer(max(0, deadline - time.monotonic()), expire)
    timer.daemon = True
    capture["status"] = "incomplete"
    timer.start()

    try:
        headers = request_headers(session, "chat", "application/x-ndjson")
        connection.connect()
        active_socket = connection.sock
        require(time.monotonic() < deadline, "API deadline exceeded.", "API_DEADLINE")
        body = encoded({"turnId": capture["turn_id"], "message": question})
        require_active_session(session)
        connection.request("POST", AUTH_PATHS["chat"], body=body, headers=headers)
        response = connection.getresponse()
        capture["http_status"] = response.status

        if response.status != 200:
            capture["status"] = "failed"
            capture["admission_rejected"] = response.status in {401, 403}
            capture["http_error"] = http_failure(response)
            if response.status in {401, 403}:
                code = "CHAT_SESSION_REJECTED" if response.status == 401 else "CHAT_AUTHORIZATION_DENIED"
                raise EvaluationError(code, "Chat admission was rejected; no retry or session change was attempted.")

        require(response.status == 200, "Chat endpoint returned a non-200 status; no redirect or retry attempted.", "HTTP_STATUS")
        content_type = response.getheader("Content-Type", "").lower().replace(" ", "")
        require(content_type in {"application/x-ndjson", "application/x-ndjson;charset=utf-8"}, "Unexpected chat content type.", "STREAM_PROTOCOL")
        buffer = b""

        while True:
            remaining = deadline - time.monotonic()
            require(remaining > 0, "API deadline exceeded; remote work may continue.", "API_DEADLINE")
            active_socket.settimeout(min(LIMITS["inactivity_seconds"], remaining))
            chunk = response.read1(8192)
            capture["received_bytes"] += len(chunk)
            require(capture["received_bytes"] <= LIMITS["stream_bytes"], "Stream exceeds 1 MiB; no data silently clipped.", "STREAM_LIMIT")
            buffer += chunk

            while b"\n" in buffer or (not chunk and buffer):
                line, _, buffer = buffer.partition(b"\n")
                require(len(line) <= LIMITS["line_bytes"], "NDJSON line exceeds cap.", "STREAM_LIMIT")
                require(bool(line.strip()), "Blank NDJSON event.", "STREAM_PROTOCOL")
                if accept(object_json(line), capture):
                    return

            require(len(buffer) <= LIMITS["line_bytes"], "NDJSON line exceeds cap.", "STREAM_LIMIT")
            if not chunk:
                raise EvaluationError("STREAM_EOF", "Stream ended without a terminal event; remote completion is unknown.")

    except KeyboardInterrupt:
        capture["status"] = "interrupted"
        raise

    except Exception as exc:
        capture["error"] = diagnostic(exc)
        if isinstance(exc, EvaluationError) and exc.code in {"SESSION_REQUIRED", "SESSION_EXPIRED"}:
            capture["admission_rejected"] = True

    finally:
        timer.cancel()
        expire()
        timer.join()
        if response is not None:
            response.close()
        connection.close()
        capture["wall_seconds"] = round(time.monotonic() - started, 6)
        capture["finished_at"] = now()
