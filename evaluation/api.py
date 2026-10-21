"""One structured, non-retrying HTTPS chat request; no AWS credentials forwarded."""

import http.client
import re
import socket
import ssl
import threading
import time
from urllib.parse import urlsplit

from .common import EvaluationError, diagnostic, encoded, now, object_json, require, text

LIMITS = {"inactivity_seconds": 60, "deadline_seconds": 900, "line_bytes": 262144,
          "stream_bytes": 1048576, "answer_bytes": 32768, "activity_events": 1024}
IDENTIFIER = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
ACTIVITY_FIELDS = {"type", "turnId", "stage", "operation", "table", "toolUseId", "toolName", "documentId",
                   "requestedSections", "documentsReturned", "sectionsReturned", "rowsReturned", "code", "message"}


def initial(turn_id: str) -> dict:
    """Create a persisted request identity before dispatch is allowed."""

    return {"status": "not_run", "turn_id": turn_id, "conversation_id": None, "http_status": None,
            "answer": "", "events": [], "heartbeat_count": 0, "terminal": None,
            "received_bytes": 0, "wall_seconds": None, "error": None,
            "started_at": None, "finished_at": None,
            "transport_omissions": "Heartbeats are counted, not individually archived."}


def accept(event: dict, capture: dict) -> bool:
    """Validate and retain one protocol event; return whether it is terminal."""

    kind = event.get("type")
    require(event.get("turnId", capture["turn_id"]) == capture["turn_id"], "Conflicting stream turn ID.", "STREAM_PROTOCOL")

    if kind == "conversation":
        require(set(event) == {"type", "turnId", "conversationId"}, "Invalid conversation event.")
        conversation = event["conversationId"]
        require(isinstance(conversation, str) and bool(IDENTIFIER.fullmatch(conversation)), "Invalid conversation ID.")
        require(capture["conversation_id"] in (None, conversation), "Conflicting conversation ID.")
        capture["conversation_id"] = conversation

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
        capture["status"] = "unexpected_replay" if event["replayed"] else "truncated" if event["truncated"] else "completed"

    elif kind == "error":
        require(set(event) == {"type", "turnId", "code", "message", "retryable", "correlationId"}
                and type(event["retryable"]) is bool and text(event["code"], 128)
                and text(event["message"], 2048) and text(event["correlationId"], 128), "Invalid error event.")
        capture["status"] = "failed"

    else:
        raise EvaluationError("STREAM_PROTOCOL", "Unknown stream event type.")
    capture["events"].append(event)

    if kind in {"complete", "error"}:
        capture["terminal"] = event
        return True

    return False


def collect(endpoint: str, question: str, capture: dict) -> None:
    """POST only turnId/question, preserving exact deltas even on a partial failure."""

    started = time.monotonic()
    capture["started_at"] = now()
    deadline = started + LIMITS["deadline_seconds"]
    target = urlsplit(endpoint)
    connection = http.client.HTTPSConnection(target.hostname, target.port or 443,
                                            timeout=LIMITS["inactivity_seconds"], context=ssl.create_default_context())
    active_socket = None

    def expire():
        """Interrupt a slow/trickling socket at the absolute transport deadline."""
        if active_socket is not None:
            try:
                active_socket.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        connection.close()

    timer = threading.Timer(LIMITS["deadline_seconds"], expire)
    timer.daemon = True
    capture["status"] = "incomplete"
    timer.start()

    try:
        connection.connect()
        active_socket = connection.sock
        require(time.monotonic() < deadline, "API deadline exceeded.", "API_DEADLINE")
        body = encoded({"turnId": capture["turn_id"], "message": question})
        connection.request("POST", target.path, body=body,
                           headers={"Content-Type": "application/json", "Accept": "application/x-ndjson"})
        response = connection.getresponse()
        capture["http_status"] = response.status

        if response.status != 200:
            capture["status"] = "failed"

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

    finally:
        timer.cancel()
        connection.close()
        capture["wall_seconds"] = round(time.monotonic() - started, 6)
        capture["finished_at"] = now()
