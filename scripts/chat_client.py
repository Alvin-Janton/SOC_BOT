"""Render one SOC Bot chat turn using only the Python 3.11+ standard library.

Assistant Markdown is plain stdout text; progress and IDs go to stderr.
No retries, redirects, authentication, AWS credentials, or local state are used.
Exit codes: 0 complete, 1 failure/incomplete, 2 invalid arguments, 3 truncated,
130 interrupted locally. The 60-second socket timeout measures inactivity,
not the complete turn; server heartbeats normally arrive every 15 seconds.
"""

import argparse
import http.client
import ipaddress
import json
import re
import ssl
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import TextIO

DEFAULT_API_URL = "https://1vg8z8ov16.execute-api.us-east-1.amazonaws.com/dev/chat"
SOCKET_TIMEOUT_SECONDS = 60
MAX_LINE_BYTES = 256 * 1024
MAX_HTTP_ERROR_BYTES = 8192
CONVERSATION_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
LABEL = re.compile(r"[A-Za-z0-9_-]{1,128}")
STAGES = {
    "investigating": "Investigating...", "finalizing": "Preparing the final answer...",
    "summarizing": "Summarizing earlier context...", "query_started": "Query tool started...",
    "query_completed": "Query tool completed.", "rag_started": "Playbook tool started...",
    "rag_completed": "Playbook tool completed.", "tool_request_rejected": "Tool request rejected.",
    "tool_error": "Tool returned an application error.", "tool_invocation_failed": "Tool invocation could not be confirmed.",
    "tool_response_invalid": "Tool response was invalid.", "tool_not_executed": "Tool call was not executed.",
}


class ClientError(Exception):
    """Describe a local protocol problem without including raw response content."""


class NoRedirects(urllib.request.HTTPRedirectHandler):
    """Refuse redirect follow-ups, which could resend or disclose the message."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        """Leave every redirect as an HTTP error rather than issuing another request."""
        return None


def message_argument(value: str) -> str:
    """Match nonblank input and the API's JavaScript UTF-16 string-length limit."""
    try:
        units = len(value.encode("utf-16-le")) // 2
    except UnicodeEncodeError as error:
        raise argparse.ArgumentTypeError("Message contains invalid Unicode.") from error
    if not value.strip() or units > 8192:
        raise argparse.ArgumentTypeError("Message must be nonblank and at most 8192 UTF-16 code units.")
    return value


def conversation_argument(value: str) -> str:
    """Accept the server's bounded conversation identifier without rewriting it."""
    if not CONVERSATION_ID.fullmatch(value):
        raise argparse.ArgumentTypeError("Conversation ID requires 1-128 letters, digits, underscores, or hyphens.")
    return value


def turn_argument(value: str) -> str:
    """Validate a hyphenated RFC UUID (or nil/max UUID), preserving the supplied text."""
    try:
        parsed = uuid.UUID(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("Turn ID must be a hyphenated UUID.") from error
    if value.lower() != str(parsed) or (parsed.int not in (0, (1 << 128) - 1)
            and (parsed.variant != uuid.RFC_4122 or parsed.version not in range(1, 9))):
        raise argparse.ArgumentTypeError("Turn ID must match the API's hyphenated RFC UUID format.")
    return value


def endpoint_argument(value: str) -> str:
    """Require a complete absolute HTTPS endpoint with no credentials or fragment."""
    try:
        url = urllib.parse.urlsplit(value)
        valid = (
            url.scheme == "https" and url.hostname and url.username is None and url.password is None
            and not url.fragment and (url.port is None or 1 <= url.port <= 65535) and value.isascii()
            and not any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in value)
        )
    except ValueError as error:
        raise argparse.ArgumentTypeError("Invalid HTTPS endpoint.") from error
    if not valid:
        raise argparse.ArgumentTypeError("Use a full absolute HTTPS chat endpoint without credentials, whitespace, or a fragment.")
    try:
        ipaddress.ip_address(url.hostname)
    except ValueError:
        hostname = url.hostname.rstrip(".")
        labels_valid = all(
            re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
            for label in hostname.split(".")
        )
        if len(hostname) > 253 or not labels_valid:
            raise argparse.ArgumentTypeError("HTTPS endpoint hostname is invalid.")
    return value


def terminal_text(value: str) -> str:
    """Strip terminal control/format characters, keeping ordinary Unicode, newlines, and tabs."""
    return "".join(character for character in value if character in "\n\t" or unicodedata.category(character) not in ("Cc", "Cf", "Cs"))


def write_text(stream: TextIO, value: str) -> None:
    """Flush plain text, escaping unsupported characters if UTF-8 reconfiguration was unavailable."""
    value = terminal_text(value)
    try:
        stream.write(value)
    except UnicodeEncodeError:
        encoding = stream.encoding or "ascii"
        stream.write(value.encode(encoding, errors="backslashreplace").decode(encoding))
    stream.flush()


def string_field(event: dict, key: str, limit: int, optional: bool = False) -> str | None:
    """Read a bounded string without copying malformed fields into an error message."""
    if optional and key not in event:
        return None
    value = event.get(key)
    if not isinstance(value, str) or len(value) > limit:
        raise ClientError(f"Response field {key} must be a bounded string.")
    return value


def boolean_field(event: dict, key: str, optional: bool = False) -> bool | None:
    """Reject truthy strings/numbers where the current protocol requires a boolean."""
    if optional and key not in event:
        return None
    value = event.get(key)
    if type(value) is not bool:
        raise ClientError(f"Response field {key} must be a boolean.")
    return value


def invalid_constant(_value: str) -> None:
    """Reject Python JSON extensions such as NaN rather than accepting invalid JSON."""
    raise ValueError("Non-JSON constant.")


def unique_fields(pairs: list[tuple[str, object]]) -> dict:
    """Reject duplicate JSON keys rather than silently hiding contradictory identifiers."""
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON field.")
        result[key] = value
    return result


def decode_object(line: bytes) -> dict:
    """Decode one bounded UTF-8 JSON object with safe protocol errors."""
    try:
        value = json.loads(line.decode("utf-8"), parse_constant=invalid_constant, object_pairs_hook=unique_fields)
    except (UnicodeDecodeError, ValueError, RecursionError) as error:
        raise ClientError("Response contains invalid UTF-8 or JSON.") from error
    if not isinstance(value, dict):
        raise ClientError("Response event must be a JSON object.")
    return value


class Renderer:
    """Track stream identity and keep answer bytes separate from readable progress."""

    def __init__(self, turn_id: str, conversation_id: str | None):
        """Preserve the original request context separately from any returned conversation ID."""
        self.turn_id = turn_id
        self.original_conversation_id = conversation_id
        self.conversation_id = conversation_id
        self.answer_started = False
        self.answer_ends_newline = True
        self.console_line_open = False

    def status(self, message: str) -> None:
        """Print one safe stderr status without inserting characters between stdout deltas."""
        if self.console_line_open:
            write_text(sys.stderr, "\n")
            self.console_line_open = False
        message = terminal_text(message).replace("\n", " ").replace("\t", " ")
        write_text(sys.stderr, message + "\n")

    def finish_text(self) -> None:
        """End a partial/final answer cleanly without printing the accumulated answer again."""
        if self.answer_started and not self.answer_ends_newline:
            write_text(sys.stdout, "\n")
            self.answer_ends_newline = True
        self.console_line_open = False

    def retry_context(self) -> None:
        """Explain deliberate replay using the original request context, never a new turn ID."""
        self.status(f"Original turn ID: {self.turn_id}")
        if self.original_conversation_id:
            self.status(f"Original conversation ID: {self.original_conversation_id}")
        else:
            self.status("Original request was a new conversation: omit --conversation-id when retrying it.")
        self.status("No retry was sent. A deliberate retry must reuse --turn-id above, "
                    "the exact original message, and original conversation context.")

    def check_ids(self, event: dict) -> None:
        """Reject contradictory IDs before rendering event contents or reporting completion."""
        if "turnId" in event and string_field(event, "turnId", 36) != self.turn_id:
            raise ClientError("Response turn ID does not match the sent turn ID.")
        if "conversationId" in event:
            identifier = string_field(event, "conversationId", 128)
            if not CONVERSATION_ID.fullmatch(identifier):
                raise ClientError("Response conversation ID is invalid.")
            if self.conversation_id is not None and identifier != self.conversation_id:
                raise ClientError("Response contains contradictory conversation IDs.")
            if self.conversation_id is None:
                self.conversation_id = identifier

    def show_error(self, event: dict) -> None:
        """Display only typed, bounded public error fields, never an arbitrary body or traceback."""
        code = string_field(event, "code", 128)
        message = string_field(event, "message", 1024)
        retryable = boolean_field(event, "retryable", optional=True)
        correlation = string_field(event, "correlationId", 128, optional=True)
        if not LABEL.fullmatch(code) or (correlation is not None and not LABEL.fullmatch(correlation)):
            raise ClientError("Response error identifiers are invalid.")
        self.finish_text()
        self.status(f"Error [{code}]: {message}")
        if retryable is not None:
            self.status(f"Server retryable: {str(retryable).lower()} (no automatic retry).")
        if correlation:
            self.status(f"Correlation ID: {correlation}")

    def activity(self, event: dict) -> None:
        """Render friendly stage/message text and optional bounded tool/code labels."""
        stage = string_field(event, "stage", 64)
        message = string_field(event, "message", 512, optional=True)
        tool = string_field(event, "toolName", 64, optional=True)
        code = string_field(event, "code", 128, optional=True)
        if not LABEL.fullmatch(stage) or any(value is not None and not LABEL.fullmatch(value) for value in (tool, code)):
            raise ClientError("Response activity identifiers are invalid.")
        details = ", ".join(value for value in (tool, code) if value)
        self.status((f"[{details}] " if details else "") + (message or STAGES.get(stage, "Processing...")))

    def event(self, event: dict) -> int | None:
        """Render one event; return an exit status only for the first recognized terminal event."""
        kind = string_field(event, "type", 64)
        if not LABEL.fullmatch(kind):
            raise ClientError("Response event type is invalid.")
        self.check_ids(event)
        if kind == "conversation":
            string_field(event, "turnId", 36)
            identifier = string_field(event, "conversationId", 128)
            self.status(f"Conversation: {identifier}")
        elif kind == "activity":
            self.activity(event)
        elif kind == "heartbeat":
            pass
        elif kind == "text_delta":
            text = terminal_text(string_field(event, "text", MAX_LINE_BYTES))
            if text:
                if not self.answer_started:
                    self.status("Assistant:")
                    self.answer_started = True
                write_text(sys.stdout, text)
                self.answer_ends_newline = text.endswith("\n")
                self.console_line_open = not self.answer_ends_newline
        elif kind == "complete":
            string_field(event, "turnId", 36)
            identifier = string_field(event, "conversationId", 128)
            replayed = boolean_field(event, "replayed")
            truncated = boolean_field(event, "truncated")
            self.finish_text()
            self.status(f"Complete. Conversation ID: {identifier}; turn ID: {self.turn_id}")
            if replayed:
                self.status("Replay: this is the saved response, not a fresh investigation.")
            if truncated:
                self.status("WARNING: The completed answer is truncated/incomplete (exit 3). No continuation was requested.")
                return 3
            return 0
        elif kind == "error":
            string_field(event, "turnId", 36)
            self.show_error(event)
            self.retry_context()
            return 1
        else:
            self.status(f"Warning: skipped unknown informational event type {kind}; still awaiting complete/error.")
        return None


def consume_response(response, renderer: Renderer) -> int:
    """Read capped NDJSON lines incrementally and reject EOF without a terminal event."""
    if response.status != 200 or response.headers.get_content_type() != "application/x-ndjson":
        raise ClientError("Expected HTTP 200 with application/x-ndjson; response body was not displayed.")
    while True:
        line = response.readline(MAX_LINE_BYTES + 1)
        if not line:
            raise ClientError("Stream ended before complete/error; the displayed answer is incomplete.")
        if len(line) > MAX_LINE_BYTES:
            raise ClientError("Response line exceeds the 256 KiB byte limit.")
        if line.strip():
            result = renderer.event(decode_object(line))
            if result is not None:
                return result


def report_http_error(error: urllib.error.HTTPError, renderer: Renderer) -> None:
    """Read at most a small error body and recognize only the API's public JSON error envelope."""
    renderer.status(f"HTTP {error.code}: request did not complete successfully; redirects are not followed.")
    if error.code == 403:
        renderer.status("Check the dev WAF allowlisted address and endpoint; a 403 is not necessarily caused by WAF.")
    try:
        body = error.read(MAX_HTTP_ERROR_BYTES + 1)
        if len(body) > MAX_HTTP_ERROR_BYTES or error.headers.get_content_type() != "application/json":
            return
        envelope = decode_object(body)
        public_error = envelope.get("error")
        if isinstance(public_error, dict):
            renderer.show_error({**public_error, **({"correlationId": envelope["correlationId"]} if "correlationId" in envelope else {})})
    except (ClientError, OSError, http.client.HTTPException):
        renderer.status("No readable bounded API error envelope was available; raw body omitted.")


def send_turn(url: str, payload: bytes, renderer: Renderer) -> int:
    """Send exactly one explicit POST and reliably close its response, including on interruption."""
    request = urllib.request.Request(url, data=payload, method="POST", headers={
        "Content-Type": "application/json", "Accept": "application/x-ndjson",
    })
    opener = urllib.request.build_opener(NoRedirects())
    try:
        with opener.open(request, timeout=SOCKET_TIMEOUT_SECONDS) as response:
            return consume_response(response, renderer)
    except urllib.error.HTTPError as error:
        with error:
            report_http_error(error, renderer)
        renderer.finish_text()
        renderer.retry_context()
        return 1


def main() -> int:
    """Validate arguments before network access, then render one manual chat request."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
        except (AttributeError, OSError, ValueError):
            pass
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--message", required=True, type=message_argument,
                        help="One nonblank analyst message (at most 8192 API string units).")
    parser.add_argument("--conversation-id", type=conversation_argument, help="Existing conversation; omit for a new conversation.")
    parser.add_argument("--turn-id", type=turn_argument,
                        help="Original UUID for a deliberate retry/replay; otherwise a new UUID is generated.")
    parser.add_argument("--api-url", type=endpoint_argument, default=DEFAULT_API_URL, help="Complete HTTPS /chat endpoint, not a base URL.")
    args = parser.parse_args()
    turn_id = args.turn_id if args.turn_id is not None else str(uuid.uuid4())
    request = {"turnId": turn_id, "message": args.message}
    if args.conversation_id is not None:
        request["conversationId"] = args.conversation_id
    payload = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > 32768:
        parser.error("Serialized request exceeds the API's 32768-byte limit.")
    renderer = Renderer(turn_id, args.conversation_id)
    try:
        renderer.status(f"Turn ID: {turn_id}")
        renderer.status(f"Conversation ID: {args.conversation_id}" if args.conversation_id
                        else "New conversation: the server will return its ID.")
        return send_turn(args.api_url, payload, renderer)
    except KeyboardInterrupt:
        renderer.finish_text()
        renderer.status("Interrupted locally (exit 130). Closing this connection does NOT cancel Bedrock/Athena/backend execution.")
        renderer.retry_context()
        return 130
    except (ClientError, urllib.error.URLError, OSError, http.client.HTTPException) as error:
        renderer.finish_text()
        if isinstance(error, ClientError):
            renderer.status(f"Protocol error: {error}")
        elif isinstance(error, ssl.SSLError) or (isinstance(error, urllib.error.URLError) and isinstance(error.reason, ssl.SSLError)):
            renderer.status("TLS connection/verification failed; check the endpoint and trusted certificates.")
        else:
            renderer.status("Connection or local I/O failed (60-second socket inactivity timeout); response incomplete.")
        renderer.status("Backend acceptance/completion is unknown; work may still be running. No automatic retry was sent.")
        renderer.retry_context()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
