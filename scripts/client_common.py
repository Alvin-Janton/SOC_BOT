"""Shared, origin-bound session primitives for the two explicit manual clients.

Importing this module does not read credentials, parse arguments or send requests.
Cookie adoption and same-directory persistence require a validated auth response.
"""

import argparse
from datetime import datetime
from email.utils import parsedate_to_datetime
import getpass
import http.cookiejar
from http.cookies import CookieError, SimpleCookie
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import warnings
from typing import Callable, TextIO

SOCKET_TIMEOUT_SECONDS = 60
MAX_HTTP_ERROR_BYTES = 8192
MAX_SESSION_BYTES = 4096
SESSION_COOKIE = "__Host-soc_bot_session"
SESSION_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
SESSION_FILE = re.compile(r"\.soc-bot-chat-session(?:-[A-Za-z0-9_-]+)?\.json")
LABEL = re.compile(r"[A-Za-z0-9_-]{1,128}")
AUTH_PATHS = {"login": "/api/auth/login", "me": "/api/auth/me", "logout": "/api/auth/logout", "chat": "/api/chat"}
ROUTES = {
    ("POST", "/api/auth/login"): "login", ("GET", "/api/auth/me"): "me",
    ("POST", "/api/auth/logout"): "logout", ("POST", "/api/chat"): "chat",
    ("GET", "/api/health"): "health", ("GET", "/api/conversations"): "conversations",
    **{("POST", "/api/auth/" + action): action for action in (
        "signup", "confirm-signup", "resend-confirmation", "forgot-password", "reset-password", "change-password",
    )},
}


def route_action(method: str, path: str) -> str:
    """Admit exact method/path pairs, including one bounded ASCII messages identifier."""
    action = ROUTES.get((method, path))
    if action is None and method == "GET" and re.fullmatch(r"/api/conversations/[A-Za-z0-9_-]{1,128}/messages", path):
        action = "messages"
    if action is None:
        raise ClientError("Method/path is not an allowed project API operation; no request was sent.")
    return action


def route_target(method: str, path: str, cursor: str | None = None) -> str:
    """Construct a single-page target without accepting caller-supplied URLs or query syntax."""
    action = route_action(method, path)
    if cursor is None:
        return path
    if action not in {"conversations", "messages"} or not re.fullmatch(r"[A-Za-z0-9_-]{1,2048}", cursor):
        raise ClientError("Cursor is valid only for history GETs and must be 1-2048 opaque base64url characters.")
    return path + "?" + urllib.parse.urlencode({"cursor": cursor})

class ClientError(Exception):
    """Describe a local protocol problem without including raw response content."""


class NoRedirects(urllib.request.HTTPRedirectHandler):
    """Refuse redirect follow-ups, which could resend or disclose the message."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        """Leave every redirect as an HTTP error rather than issuing another request."""
        return None


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

    def __init__(self, session: SessionState, timeout: int = SOCKET_TIMEOUT_SECONDS,
                 allowed_actions: frozenset[str] = frozenset({"chat", "login"})):
        """Keep every request bound to its validated CloudFront origin and explicit cookie state."""
        self.session = session
        self.opener = urllib.request.build_opener(NoRedirects())
        self.attempted = False
        self.confirmed_action = None
        self.timeout = timeout
        self.allowed_actions = allowed_actions

    def open(self, url: str, method: str, payload: bytes | None, accept: str):
        """Recheck origin, method, route and canonical cursor before attaching the one cookie."""
        headers = {"Accept": accept}
        if payload is not None:
            headers["Content-Type"] = "application/json"
        try:
            parsed = urllib.parse.urlsplit(url)
            origin = base_argument(self.session.origin)
            query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True)
            if query and (set(query) != {"cursor"} or len(query["cursor"]) != 1):
                raise ValueError("Invalid query.")
            cursor = query["cursor"][0] if query else None
            target = route_target(method, parsed.path, cursor)
            if (url != origin + target or route_action(method, parsed.path) not in self.allowed_actions
                    or (method == "GET" and payload is not None) or (method == "POST" and payload is None)
                    or (payload is not None and len(payload) > (32768 if parsed.path == "/api/chat" else 8192))):
                raise ValueError("Invalid scope or payload.")
        except (ValueError, argparse.ArgumentTypeError):
            raise ClientError("Refusing a request outside the configured CloudFront origin/method/routes.") from None
        headers["Origin"] = self.session.origin
        request = urllib.request.Request(url, data=payload, method=method, headers=headers)
        self.session.cookie_jar().add_cookie_header(request)
        self.attempted = True
        return self.opener.open(request, timeout=self.timeout)


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


def bounded_json(response, limit: int = MAX_HTTP_ERROR_BYTES) -> dict:
    """Read cap+1 bytes before parsing one strict JSON object, without dumping raw content."""
    body = response.read(limit + 1)
    if len(body) > limit or response.headers.get_content_type() != "application/json":
        raise ClientError("Expected bounded auth/API JSON; raw response omitted.")
    value = decode_object(body)
    try:
        # Keep decode_object's evaluator-compatible behavior; reject unrepresentable API values here.
        json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (ValueError, UnicodeEncodeError, RecursionError):
        raise ClientError("API JSON contains invalid Unicode or unrepresentable numeric values; raw response omitted.") from None
    return value


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


def login_payload(email: str) -> bytes:
    """Prompt without any echoing fallback and encode only the bounded email/password login body."""
    password = hidden_password("Password (hidden): ")
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


def hidden_password(prompt: str) -> str:
    """Prompt privately, refusing getpass's visible-input fallback."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            return getpass.getpass(prompt)
    except (getpass.GetPassWarning, EOFError):
        raise ClientError("Hidden password input is unavailable; use an interactive terminal. No request was sent.") from None


def http_status(status: int) -> None:
    """Report only the numeric status and authored failure guidance to stderr."""
    write_text(sys.stderr, f"HTTP {status}\n")
    if status == 403:
        write_text(sys.stderr, "Denied: authorization, Origin or WAF may be involved; 403 does not identify a single cause.\n")
    elif status == 429:
        write_text(sys.stderr, "Throttled; no automatic retry was sent.\n")
    elif status >= 500:
        write_text(sys.stderr, "Service failure; dispatched mutations may have an unknown outcome. No automatic retry was sent.\n")


def send_login(transport: HttpsTransport, payload: bytes, emit_json: Callable[[dict], None]) -> int:
    """Validate/persist one login; the calling CLI owns JSON presentation, not session adoption."""
    session = transport.session
    try:
        with transport.open(session.origin + AUTH_PATHS["login"], "POST", payload, "application/json") as response:
            http_status(response.status)
            if response.status != 200:
                raise ClientError("Unexpected login success status; saved credential was retained.")
            value = public_session(response)
            cookie = response_cookie(response, session.origin, required=True)
            expiry = int(datetime.fromisoformat(value["expiresAt"].replace("Z", "+00:00")).timestamp())
            if cookie is None or cookie["expires"] != expiry or expiry <= time.time():
                raise ClientError("Login did not establish a matching unexpired reusable session; local file was not changed.")
            transport.confirmed_action = "Login"
            save_confirmed_session(session, cookie, "Login")
            emit_json(value)
            return 0
    except urllib.error.HTTPError as error:
        with error:
            http_status(error.code)
            # The public error object is output, never raw bytes/headers or request credentials.
            value = bounded_json(error)
            emit_json(value)
            if error.headers.get_all("Set-Cookie", []):
                raise ClientError("Failed login unexpectedly returned cookies; saved credential was retained.")
            if error.code == 401:
                write_text(sys.stderr, "Login credentials/challenge were rejected; this is not session expiry. Local state was retained.\n")
        return 1
