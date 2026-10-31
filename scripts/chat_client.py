"""Manually log in, inspect/logout a session, or render one SOC Bot chat turn.

Assistant Markdown is plain stdout text; progress and IDs go to stderr.
Python 3.11+ standard library only; no retries, redirects or AWS credentials.
Use --base-url for authenticated CloudFront and --session-file for explicit
origin-bound cookie storage; login prompts privately and requires --email.
Without --base-url, chat retains the legacy shared-identity endpoint.
Session files contain plaintext bearer credentials: keep them private and
outside synced directories. This is not browser/security/evaluation testing.
Exit codes: 0 complete, 1 failure/incomplete, 2 invalid arguments, 3 truncated,
130 interrupted locally. The 60-second socket timeout measures inactivity,
not the complete turn; server heartbeats normally arrive every 15 seconds.
"""

import argparse
from datetime import datetime
from email.utils import parsedate_to_datetime
import getpass
import http.client
import http.cookiejar
from http.cookies import CookieError, SimpleCookie
import ipaddress
import json
import os
from pathlib import Path
import re
import ssl
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
import warnings
from typing import TextIO

DEFAULT_API_URL = "https://1vg8z8ov16.execute-api.us-east-1.amazonaws.com/dev/chat"
SOCKET_TIMEOUT_SECONDS = 60
MAX_LINE_BYTES = 256 * 1024
MAX_HTTP_ERROR_BYTES = 8192
MAX_SESSION_BYTES = 4096
SESSION_COOKIE = "__Host-soc_bot_session"
SESSION_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
SESSION_FILE = re.compile(r"\.soc-bot-chat-session(?:-[A-Za-z0-9_-]+)?\.json")
AUTH_PATHS = {"login": "/api/auth/login", "me": "/api/auth/me", "logout": "/api/auth/logout", "chat": "/api/chat"}
AUTH_ERROR_CODES = {
    "INVALID_CONFIGURATION", "AUTHENTICATION_FAILED", "AUTHENTICATION_REQUIRED", "SESSION_UNAVAILABLE",
    "INVALID_INPUT", "BODY_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE", "INVALID_ORIGIN",
    "ACCOUNT_NOT_CONFIRMED", "AUTHENTICATION_CHALLENGE", "THROTTLED",
}
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


def base_argument(value: str) -> str:
    """Normalize only an exact generated CloudFront HTTPS root, before file or network work."""
    try:
        url = urllib.parse.urlsplit(value)
        host = url.hostname or ""
        valid = (value.isascii() and not any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in value)
                 and url.scheme == "https" and re.fullmatch(r"d[a-z0-9]{1,62}\.cloudfront\.net", host)
                 and url.netloc.lower() == host and url.path in ("", "/") and "?" not in value and "#" not in value)
    except ValueError:
        valid = False
    if not valid:
        raise argparse.ArgumentTypeError("Base URL must be a generated https://d....cloudfront.net origin, with only an optional trailing slash.")
    return f"https://{host}"


def email_argument(value: str) -> str:
    """Bound and normalize the email alias; Cognito remains responsible for authentication."""
    value = value.strip().lower()
    if (len(value) > 128 or not value.isascii() or any(ord(character) < 33 or ord(character) == 127 for character in value)
            or not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value)):
        raise argparse.ArgumentTypeError("Email must be a valid address of at most 128 characters.")
    return value


def session_argument(value: str) -> Path:
    """Reserve a credential-specific filename so repository ignore rules cannot hide unrelated JSON."""
    path = Path(value)
    if any(ord(character) < 32 or ord(character) == 127 for character in value) or not SESSION_FILE.fullmatch(path.name):
        raise argparse.ArgumentTypeError("Use a session filename such as .soc-bot-chat-session-dev.json in a private directory.")
    return path


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


def session_data(value: object, origin: str) -> dict:
    """Validate the complete persisted host-only cookie shape without echoing credential data."""
    fields = {"name", "value", "host", "path", "secure", "expires"}
    if (not isinstance(value, dict) or set(value) != fields or value["name"] != SESSION_COOKIE
            or not isinstance(value["value"], str) or not SESSION_TOKEN.fullmatch(value["value"])
            or value["host"] != urllib.parse.urlsplit(origin).hostname or value["path"] != "/"
            or value["secure"] is not True or type(value["expires"]) is not int
            or not 0 < value["expires"] <= 253402300799):
        raise ClientError("Session file has an invalid cookie, scope or expiry; it was not used.")
    return value.copy()


class SessionState:
    """Hold one origin-bound credential, saving only explicit, validated auth transitions."""

    def __init__(self, origin: str, path: Path | None, creating: bool = False):
        """Read a bounded existing file; only login may begin with a deliberately new filename."""
        self.origin = origin
        self.path = path
        self.cookie = None
        if path is None:
            return
        if not path.parent.is_dir() or path.is_symlink() or (path.exists() and not path.is_file()):
            raise ClientError("Use a regular session file inside an existing private directory.")
        try:
            with path.open("rb") as source:
                raw = source.read(MAX_SESSION_BYTES + 1)
        except FileNotFoundError:
            if creating:
                return
            raise ClientError("The supplied session file is missing. Run an explicit login first.") from None
        except OSError:
            raise ClientError("The supplied session file could not be read; no request was sent.") from None
        if len(raw) > MAX_SESSION_BYTES:
            raise ClientError("Session file exceeds the 4 KiB limit; no request was sent.")
        try:
            document = decode_object(raw)
            if (set(document) != {"version", "origin", "cookie"} or type(document["version"]) is not int
                    or document["version"] != 1 or document["origin"] != origin):
                raise ClientError("Session file version, shape or origin does not match this request.")
            if document["cookie"] is not None:
                self.cookie = session_data(document["cookie"], origin)
        except ClientError:
            raise ClientError("Session file is malformed or belongs to another origin; no request was sent.") from None
        if self.cookie and self.cookie["expires"] <= time.time():
            write_text(sys.stderr, "Saved session has expired; its cookie will not be sent. No renewal or automatic login will occur.\n")

    def cookie_jar(self) -> http.cookiejar.CookieJar:
        """Use standard-library host-only HTTPS/expiry handling, never a hand-built Cookie header."""
        host = urllib.parse.urlsplit(self.origin).hostname
        jar = http.cookiejar.CookieJar(http.cookiejar.DefaultCookiePolicy(
            allowed_domains=[host], strict_ns_domain=http.cookiejar.DefaultCookiePolicy.DomainStrictNonDomain,
            secure_protocols=("https",),
        ))
        if self.cookie is not None:
            value = session_data(self.cookie, self.origin)
            jar.set_cookie(http.cookiejar.Cookie(
                version=0, name=SESSION_COOKIE, value=value["value"], port=None, port_specified=False,
                domain=host, domain_specified=False, domain_initial_dot=False, path="/", path_specified=True,
                secure=True, expires=value["expires"], discard=False, comment=None, comment_url=None,
                rest={"HttpOnly": None, "SameSite": "Lax"}, rfc2109=False,
            ))
        return jar

    def save(self) -> None:
        """Atomically replace a private same-directory temporary file; Windows inherits directory ACLs."""
        if self.path is None:
            return
        if self.path.is_symlink():
            raise ClientError("Session file became a symbolic link; local credentials were not replaced.")
        document = {"version": 1, "origin": self.origin, "cookie": self.cookie}
        encoded = json.dumps(document, separators=(",", ":")).encode("utf-8")
        temporary = None
        try:
            descriptor, temporary = tempfile.mkstemp(prefix=self.path.name + ".", suffix=".tmp", dir=self.path.parent)
            with os.fdopen(descriptor, "wb") as destination:
                if os.name != "nt":
                    os.fchmod(destination.fileno(), 0o600)
                destination.write(encoded)
                destination.flush()
                os.fsync(destination.fileno())
            os.replace(temporary, self.path)
        except OSError:
            raise ClientError("Local session-file save failed; the previous file may remain unchanged.") from None
        finally:
            if temporary is not None:
                try:
                    Path(temporary).unlink(missing_ok=True)
                except OSError:
                    write_text(sys.stderr, "Warning: a private temporary session file could not be removed; inspect the chosen directory.\n")


class HttpsTransport:
    """Make one verified HTTPS request at a time; cookies are never adopted automatically."""

    def __init__(self, session: SessionState | None = None):
        """Keep the validated origin/session separate from legacy requests and response rendering."""
        self.session = session
        self.opener = urllib.request.build_opener(NoRedirects())
        self.attempted = False
        self.confirmed_action = None

    def open(self, url: str, method: str, payload: bytes | None, accept: str):
        """Attach cookies/Origin only to fixed paths at the configured exact CloudFront origin."""
        headers = {"Accept": accept}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        if self.session is not None:
            if url not in {self.session.origin + path for path in AUTH_PATHS.values()}:
                raise ClientError("Refusing a request outside the configured CloudFront origin/routes.")
            headers["Origin"] = self.session.origin
        request = urllib.request.Request(url, data=payload, method=method, headers=headers)
        if self.session is not None:
            self.session.cookie_jar().add_cookie_header(request)
        self.attempted = True
        return self.opener.open(request, timeout=SOCKET_TIMEOUT_SECONDS)


def response_cookie(response, origin: str, required: bool = False) -> dict | None:
    """Parse one exact session Set-Cookie using cookie APIs, rejecting duplicates and unsafe scopes."""
    values = response.headers.get_all("Set-Cookie", [])
    if not values and not required:
        return None
    if len(values) != 1:
        raise ClientError("Expected one unambiguous session cookie; response headers were not displayed.")
    raw = values[0]
    if len(raw) > MAX_SESSION_BYTES or not raw.isascii() or any(ord(character) < 32 or ord(character) == 127 for character in raw):
        raise ClientError("Session cookie response is malformed; headers were not displayed.")
    # SimpleCookie overwrites repeated attributes, so reject them before asking it to parse values.
    parts = raw.split(";")
    attributes = [part.partition("=")[0].strip().lower() for part in parts[1:]]
    if (len(attributes) != len(set(attributes)) or set(attributes) != {"path", "secure", "httponly", "samesite", "max-age", "expires"}
            or not re.fullmatch(r"__Host-soc_bot_session=(?:[A-Za-z0-9_-]{43}|\"[A-Za-z0-9_-]{43}\"|\"\"|)", parts[0].strip())):
        raise ClientError("Session cookie has duplicate or unsupported scope/security attributes.")
    try:
        cookies = SimpleCookie()
        cookies.load(raw)
        if set(cookies) != {SESSION_COOKIE}:
            raise ValueError("Unexpected cookie.")
        cookie = cookies[SESSION_COOKIE]
        if (cookie["domain"] or cookie["path"] != "/" or cookie["secure"] is not True
                or cookie["httponly"] is not True or cookie["samesite"] != "Lax"
                or not re.fullmatch(r"0|[1-9][0-9]{0,4}", cookie["max-age"])):
            raise ValueError("Unexpected scope.")
        age = int(cookie["max-age"])
        expires = parsedate_to_datetime(cookie["expires"])
        if expires.tzinfo is None or expires.utcoffset().total_seconds() != 0 or age > 43200:
            raise ValueError("Unexpected expiry.")
        expiry = int(expires.timestamp())
        if age == 0 and cookie.value == "" and expiry <= time.time():
            return None
        if age == 0:
            raise ValueError("Contradictory deletion.")
        # Retain the more conservative deadline; a long Expires value cannot bypass Max-Age.
        expiry = min(expiry, int(time.time()) + age)
        return session_data({"name": SESSION_COOKIE, "value": cookie.value,
                             "host": urllib.parse.urlsplit(origin).hostname, "path": "/", "secure": True, "expires": expiry}, origin)
    except (CookieError, ValueError, TypeError, AttributeError, OverflowError):
        raise ClientError("Session cookie scope, token or expiry is invalid; headers were not displayed.") from None


def public_session(response) -> dict:
    """Accept only the public user ID and UTC expiry contract, never internal session/provider records."""
    value = bounded_json(response)
    if (set(value) != {"userId", "expiresAt"} or not isinstance(value["userId"], str)
            or not LABEL.fullmatch(value["userId"]) or not isinstance(value["expiresAt"], str)
            or not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z", value["expiresAt"])):
        raise ClientError("Auth response does not match the public session contract.")
    try:
        expiry = datetime.fromisoformat(value["expiresAt"].replace("Z", "+00:00"))
        if expiry.timestamp() <= 0:
            raise ValueError("Invalid expiry.")
    except ValueError:
        raise ClientError("Auth response has an invalid UTC expiry.") from None
    return value


def bounded_json(response) -> dict:
    """Read one small JSON response with strict UTF-8 and duplicate-key rejection, without dumping it."""
    body = response.read(MAX_HTTP_ERROR_BYTES + 1)
    if len(body) > MAX_HTTP_ERROR_BYTES or response.headers.get_content_type() != "application/json":
        raise ClientError("Expected bounded auth/API JSON; raw response omitted.")
    return decode_object(body)


def save_confirmed_session(session: SessionState, cookie: dict | None, outcome: str) -> None:
    """Distinguish remotely confirmed auth from a subsequent local credential-file failure."""
    session.cookie = cookie
    try:
        session.save()
    except ClientError:
        raise ClientError(f"{outcome} was confirmed remotely, but local session-file saving failed. Inspect the private file before reuse.") from None
    except KeyboardInterrupt:
        write_text(sys.stderr, f"{outcome} was confirmed remotely; local session-file saving was interrupted and may be incomplete.\n")
        raise


class Renderer:
    """Track stream identity and keep answer bytes separate from readable progress."""

    def __init__(self, turn_id: str, conversation_id: str | None, authenticated: bool = False):
        """Preserve the original request context separately from any returned conversation ID."""
        self.turn_id = turn_id
        self.original_conversation_id = conversation_id
        self.conversation_id = conversation_id
        self.answer_started = False
        self.answer_ends_newline = True
        self.console_line_open = False
        self.authenticated = authenticated

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
        if self.authenticated:
            self.status("Use the same authenticated account. Reauthentication, if needed, is a separate explicit login.")

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
        renderer.status("Check origin/endpoint and the dev WAF allowlisted address; a 403 is not necessarily caused by WAF.")
    if error.code == 401 and renderer.authenticated:
        renderer.status("The session was not authorized. Check expiry/login explicitly; no login, renewal or retry was sent.")
    try:
        body = error.read(MAX_HTTP_ERROR_BYTES + 1)
        if len(body) > MAX_HTTP_ERROR_BYTES or error.headers.get_content_type() != "application/json":
            return
        envelope = decode_object(body)
        public_error = envelope.get("error")
        if isinstance(public_error, dict):
            renderer.show_error({**public_error, **({"correlationId": envelope["correlationId"]} if "correlationId" in envelope else {})})
        elif set(envelope) == {"message"}:
            renderer.status("The gateway returned a generic JSON rejection; no raw response was displayed.")
    except (ClientError, OSError, http.client.HTTPException):
        renderer.status("No readable bounded API error envelope was available; raw body omitted.")


def send_turn(url: str, payload: bytes, renderer: Renderer, transport: HttpsTransport | None = None) -> int:
    """Send exactly one explicit POST and reliably close its response, including on interruption."""
    transport = transport or HttpsTransport()
    try:
        with transport.open(url, "POST", payload, "application/x-ndjson") as response:
            if transport.session is not None and response.headers.get_all("Set-Cookie", []):
                raise ClientError("Chat unexpectedly returned cookies; saved credentials were not changed.")
            return consume_response(response, renderer)
    except urllib.error.HTTPError as error:
        with error:
            report_http_error(error, renderer)
        renderer.finish_text()
        renderer.retry_context()
        return 1


def report_auth_error(response, action: str) -> str | None:
    """Render only a recognized public auth envelope; gateway/HTML bodies and headers stay private."""
    write_text(sys.stderr, f"HTTP {response.code}: {action} did not complete successfully; redirects are not followed.\n")
    if response.code == 403:
        write_text(sys.stderr, "Check Origin, endpoint and dev IPv4 WAF configuration; 403 does not identify a single cause.\n")
    try:
        envelope = bounded_json(response)
        if set(envelope) == {"error", "requestId"}:
            error = envelope["error"]
            if (isinstance(error, dict) and set(error) == {"code", "message"}
                    and isinstance(error["code"], str) and error["code"] in AUTH_ERROR_CODES
                    and isinstance(error["message"], str) and 0 < len(error["message"]) <= 1024
                    and isinstance(envelope["requestId"], str) and LABEL.fullmatch(envelope["requestId"])):
                write_text(sys.stderr, f"Auth error [{error['code']}]: {error['message']}\nRequest ID: {envelope['requestId']}\n")
                return error["code"]
        write_text(sys.stderr, "No recognized public auth error envelope; raw response omitted.\n")
    except (ClientError, OSError, http.client.HTTPException):
        write_text(sys.stderr, "No readable bounded auth JSON was available; raw response omitted.\n")
    return None


def login_payload(email: str) -> bytes:
    """Prompt without any echoing fallback and encode only the bounded email/password login body."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            password = getpass.getpass("Password (hidden): ")
    except (getpass.GetPassWarning, EOFError):
        raise ClientError("Hidden password input is unavailable; use an interactive terminal. No request was sent.") from None
    try:
        units = len(password.encode("utf-16-le")) // 2
        if not 1 <= units <= 256:
            raise ClientError("Password must contain 1-256 API string units; no request was sent.")
        payload = json.dumps({"email": email, "password": password}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except UnicodeEncodeError:
        raise ClientError("Password contains invalid Unicode; no request was sent.") from None
    finally:
        del password
    if len(payload) > 8192:
        raise ClientError("Login body exceeds the auth API limit; no request was sent.")
    return payload


def send_auth(action: str, transport: HttpsTransport, payload: bytes | None) -> int:
    """Validate one auth response completely before reporting success or mutating saved cookie state."""
    session = transport.session
    url = session.origin + AUTH_PATHS[action]
    try:
        with transport.open(url, "GET" if action == "me" else "POST", payload, "application/json") as response:
            if action == "logout":
                if response.status != 204 or response.read(MAX_HTTP_ERROR_BYTES + 1) != b"":
                    raise ClientError("Expected an empty HTTP 204 logout response; local credential was retained.")
                if response_cookie(response, session.origin, required=True) is not None:
                    raise ClientError("Logout did not return the expected deletion cookie; local credential was retained.")
                transport.confirmed_action = "Logout"
                save_confirmed_session(session, None, "Logout")
                write_text(sys.stdout, "Logged out. The local session state is cleared.\n")
                return 0
            if response.status != 200:
                raise ClientError("Unexpected authentication success status; raw response omitted.")
            value = public_session(response)
            if action == "login":
                cookie = response_cookie(response, session.origin, required=True)
                expiry = int(datetime.fromisoformat(value["expiresAt"].replace("Z", "+00:00")).timestamp())
                if cookie is None or cookie["expires"] != expiry or expiry <= time.time():
                    raise ClientError("Login did not establish a matching unexpired reusable session; local file was not changed.")
                transport.confirmed_action = "Login"
                save_confirmed_session(session, cookie, "Login")
            elif response.headers.get_all("Set-Cookie", []):
                raise ClientError("Session inspection unexpectedly returned cookies; local file was not changed.")
            write_text(sys.stdout, json.dumps(value, ensure_ascii=False) + "\n")
            return 0
    except urllib.error.HTTPError as error:
        with error:
            code = report_auth_error(error, action)
            if action in {"login", "logout"} and (error.code >= 500 or 300 <= error.code < 400):
                write_text(sys.stderr, "Remote auth outcome is unconfirmed; saved credentials were retained. No automatic retry was sent.\n")
            if action == "me" and error.code == 401 and code == "AUTHENTICATION_REQUIRED" and error.headers.get_all("Set-Cookie", []):
                if response_cookie(error, session.origin) is not None:
                    raise ClientError("Rejected session response contained a replacement cookie; local file was not changed.")
                transport.confirmed_action = "Session rejection"
                save_confirmed_session(session, None, "Session rejection")
                write_text(sys.stderr, "The recognized auth response requested cookie clearance; local session state was cleared.\n")
        return 1


def main() -> int:
    """Validate mode/arguments before file access or prompting, then make one explicit operation."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
        except (AttributeError, OSError, ValueError):
            pass
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--action", choices=("chat", "login", "me", "logout"), default="chat", help="Explicit operation; default: chat.")
    parser.add_argument("--message", type=message_argument,
                        help="One nonblank analyst message (at most 8192 API string units).")
    parser.add_argument("--conversation-id", type=conversation_argument, help="Existing conversation; omit for a new conversation.")
    parser.add_argument("--turn-id", type=turn_argument,
                        help="Original UUID for a deliberate retry/replay; otherwise a new UUID is generated.")
    endpoint = parser.add_mutually_exclusive_group()
    endpoint.add_argument("--api-url", type=endpoint_argument, help="Complete legacy HTTPS /chat endpoint; excludes --base-url.")
    endpoint.add_argument("--base-url", type=base_argument, help="Generated CloudFront HTTPS origin; fixed /api routes are derived.")
    parser.add_argument("--email", type=email_argument, help="Login email only; password is prompted privately.")
    parser.add_argument("--session-file", type=session_argument,
                        help="Explicit private .soc-bot-chat-session-<label>.json; login may create it, other actions require it to exist.")
    args = parser.parse_args()
    if (args.action != "chat" or args.session_file is not None) and args.base_url is None:
        parser.error("Auth actions and --session-file require --base-url; credentials are never sent to the legacy API.")
    if args.action == "chat" and args.message is None:
        parser.error("--message is required for chat.")
    if args.action != "chat" and any(value is not None for value in (args.message, args.conversation_id, args.turn_id)):
        parser.error("--message, --conversation-id and --turn-id apply only to chat.")
    if args.email is not None and args.action != "login":
        parser.error("--email applies only to login.")
    if args.action == "login" and (args.email is None or args.session_file is None):
        parser.error("Login requires both --email and an explicit --session-file.")
    renderer = None
    payload = None
    if args.action == "chat":
        turn_id = args.turn_id if args.turn_id is not None else str(uuid.uuid4())
        request = {"turnId": turn_id, "message": args.message}
        if args.conversation_id is not None:
            request["conversationId"] = args.conversation_id
        payload = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(payload) > 32768:
            parser.error("Serialized request exceeds the API's 32768-byte limit.")
        renderer = Renderer(turn_id, args.conversation_id, authenticated=args.base_url is not None)
    transport = None
    try:
        session = SessionState(args.base_url, args.session_file, creating=args.action == "login") if args.base_url else None
        transport = HttpsTransport(session)
        if args.action != "chat":
            payload = login_payload(args.email) if args.action == "login" else b"{}" if args.action == "logout" else None
            return send_auth(args.action, transport, payload)
        renderer.status("CloudFront session mode; no automatic login or renewal." if args.base_url
                        else "Legacy shared-identity mode; this endpoint does not authenticate individual users.")
        renderer.status(f"Turn ID: {turn_id}")
        renderer.status(f"Conversation ID: {args.conversation_id}" if args.conversation_id
                        else "New conversation: the server will return its ID.")
        url = args.base_url + AUTH_PATHS["chat"] if args.base_url else args.api_url or DEFAULT_API_URL
        return send_turn(url, payload, renderer, transport)
    except KeyboardInterrupt:
        if renderer:
            renderer.finish_text()
            renderer.status("Interrupted locally (exit 130). Closing this connection does NOT cancel Bedrock/Athena/backend execution.")
            renderer.retry_context()
        else:
            write_text(sys.stderr, "Interrupted locally (exit 130). No automatic retry was sent.\n")
            if transport and transport.attempted and transport.confirmed_action is None:
                write_text(sys.stderr, "The auth request may already have been accepted; inspect the outcome before repeating it.\n")
        return 130
    except (ClientError, urllib.error.URLError, OSError, http.client.HTTPException) as error:
        if renderer:
            renderer.finish_text()
        status = renderer.status if renderer else lambda message: write_text(sys.stderr, message + "\n")
        if isinstance(error, ClientError):
            status(f"Client error: {error}")
        elif isinstance(error, ssl.SSLError) or (isinstance(error, urllib.error.URLError) and isinstance(error.reason, ssl.SSLError)):
            status("TLS connection/verification failed; check the endpoint and trusted certificates.")
        else:
            status("Connection or local I/O failed (60-second socket inactivity timeout); no raw diagnostics were displayed.")
        if transport and transport.confirmed_action:
            status(f"{transport.confirmed_action} was confirmed remotely; local persistence may need attention.")
        elif transport and transport.attempted:
            status("Backend acceptance/completion is unknown; work may still be running. No automatic retry was sent.")
        else:
            status("No request was sent.")
        if renderer and transport and transport.attempted:
            renderer.retry_context()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
