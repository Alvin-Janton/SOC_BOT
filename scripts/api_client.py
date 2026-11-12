"""Invoke one allowlisted SOC Bot JSON API operation through CloudFront.

Python 3.11+ standard library only. Parsed JSON goes to stdout; HTTP status and
safe guidance go to stderr. No retries, redirects, pagination or automatic login.
Credentials and body files belong in private, nonsynchronized directories.
Use chat_client.py for streaming chat; Google routes are browser-only.
"""

import argparse
import http.client
import json
from pathlib import Path
import re
import ssl
import sys
import urllib.error

if __package__:
    from .client_common import (
        AUTH_PATHS, LABEL, ClientError, HttpsTransport, SessionState, base_argument,
        bounded_json, decode_object, email_argument, hidden_password, http_status,
        login_payload, public_session, response_cookie, route_action,
        route_target, save_confirmed_session, send_login, session_argument, write_text,
    )
else:
    from client_common import (
        AUTH_PATHS, LABEL, ClientError, HttpsTransport, SessionState, base_argument,
        bounded_json, decode_object, email_argument, hidden_password, http_status,
        login_payload, public_session, response_cookie, route_action,
        route_target, save_confirmed_session, send_login, session_argument, write_text,
    )

SOCKET_TIMEOUT_SECONDS = 75
AUTH_BYTES = 8192
# Match JavaScript's \s used by the backend, including BOM but excluding unrelated control characters.
AUTH_WHITESPACE = re.compile(r"[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]")
RESPONSE_LIMITS = {"health": 1024, "conversations": 32768, "messages": 262144}
API_ACTIONS = frozenset({"login", "me", "logout", "health", "conversations", "messages",
                         "signup", "confirm-signup", "resend-confirmation", "forgot-password",
                         "reset-password", "change-password"})
PASSWORD_ACTIONS = {"reset-password", "change-password"}
BODY_FIELDS = {
    "signup": {"email", "password"}, "confirm-signup": {"email", "code"},
    "resend-confirmation": {"email"}, "forgot-password": {"email"},
    "reset-password": {"email", "code", "newPassword"},
    "change-password": {"currentPassword", "newPassword"},
}
SECRET_FIELDS = {
    "signup": ("password",), "reset-password": ("newPassword",),
    "change-password": ("currentPassword", "newPassword"),
}
REGISTRATION_MESSAGE = ("If account confirmation is needed, check your email for a confirmation code. "
                        "You can request another code if needed.")
SUCCESS_BODIES = {
    "signup": (202, {"message": REGISTRATION_MESSAGE}),
    "resend-confirmation": (202, {"message": REGISTRATION_MESSAGE}),
    "confirm-signup": (200, {"message": "Account confirmed. Sign in to continue."}),
    "forgot-password": (202, {"message": "If this account is eligible for password recovery, check your email for a reset code."}),
    "reset-password": (200, {"message": "Password updated. Sign in again."}),
    "change-password": (200, {"message": "Password updated. Sign in again."}),
}
PARTIAL_CODE = "PASSWORD_CHANGED_SESSION_REVOCATION_UNCONFIRMED"
PARTIAL_MESSAGE = "Your password was changed, but signing out existing sessions could not be confirmed. Contact the administrator."


def print_json(value: dict) -> None:
    """Escape terminal controls as JSON escapes, preserving the parsed strings exactly."""
    sys.stdout.write(json.dumps(value, ensure_ascii=True, allow_nan=False, indent=2) + "\n")
    sys.stdout.flush()


def string_units(value: str) -> int:
    """Count the backend's UTF-16 units, rejecting lone surrogates without printing input."""
    try:
        return len(value.encode("utf-16-le")) // 2
    except UnicodeEncodeError:
        raise ClientError("Input contains invalid Unicode; no request was sent.") from None


def read_body(filename: str) -> dict:
    """Read at most 8 KiB from one regular UTF-8 file or explicitly selected stdin."""
    if filename == "-":
        raw = sys.stdin.buffer.read(AUTH_BYTES + 1)
    else:
        path = Path(filename)
        if not path.is_file():
            raise ClientError("Body input must be a readable regular UTF-8 JSON file, or '-' for explicit stdin.")
        with path.open("rb") as source:
            raw = source.read(AUTH_BYTES + 1)
    if len(raw) > AUTH_BYTES:
        raise ClientError("Body input exceeds the 8 KiB limit; no request was sent.")
    try:
        value = decode_object(raw)
    except ClientError:
        raise ClientError("Body input must be one strict UTF-8 JSON object without duplicate keys or non-JSON constants.") from None
    return value


def encode_body(value: dict) -> bytes:
    """Serialize a validated auth object without changing passwords or confirmation codes."""
    try:
        payload = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    except (UnicodeEncodeError, ValueError, RecursionError):
        raise ClientError("Body contains invalid Unicode or JSON values; no request was sent.") from None
    if len(payload) > AUTH_BYTES:
        raise ClientError("Serialized auth body exceeds 8 KiB; no request was sent.")
    return payload


def validate_body(action: str, value: dict, allow_missing_secrets: bool) -> dict:
    """Validate all supplied fields and required nonsecrets before any hidden prompt."""
    expected = BODY_FIELDS[action]
    missing = expected - set(value)
    permitted_missing = set(SECRET_FIELDS.get(action, ())) if allow_missing_secrets else set()
    if set(value) - expected or missing - permitted_missing:
        raise ClientError("Body fields do not match this operation; no request was sent.")
    result = value.copy()
    for field, supplied in value.items():
        if not isinstance(supplied, str):
            raise ClientError("Every auth body value must be a string; no request was sent.")
        units = string_units(supplied)
        if field == "email":
            try:
                result[field] = email_argument(supplied)
            except argparse.ArgumentTypeError:
                raise ClientError("Body email is invalid; no request was sent.") from None
        elif field == "code":
            if not 1 <= units <= 2048 or AUTH_WHITESPACE.search(supplied):
                raise ClientError("Code must contain 1-2048 non-whitespace UTF-16 units; no request was sent.")
        else:
            minimum = 1 if field == "currentPassword" else 15
            if not minimum <= units <= 256 or (minimum == 15 and AUTH_WHITESPACE.search(supplied)):
                raise ClientError("Password is outside this operation's length/whitespace bounds; no request was sent.")
    encode_body(result)
    return result


def complete_body(action: str, value: dict) -> bytes:
    """Prompt once for each omitted secret only, then recheck the complete serialized body."""
    for field in SECRET_FIELDS.get(action, ()):
        if field not in value:
            value[field] = hidden_password(f"{field} (hidden): ")
    return encode_body(validate_body(action, value, allow_missing_secrets=False))


def error_code(value: dict) -> str | None:
    """Recognize only the bounded public error envelope for credential transition decisions."""
    error = value.get("error")
    if (set(value) == {"error", "requestId"} and isinstance(value["requestId"], str)
            and LABEL.fullmatch(value["requestId"]) and isinstance(error, dict)
            and set(error) == {"code", "message"} and isinstance(error["code"], str)
            and re.fullmatch(r"[A-Z_]{1,64}", error["code"]) and isinstance(error["message"], str)
            and 0 < len(error["message"]) <= 1024):
        return error["code"]
    return None


def clear_session(response, transport: HttpsTransport, outcome: str) -> None:
    """Require the exact deletion cookie before clearing only the supplied local session."""
    if response_cookie(response, transport.session.origin, required=True) is not None:
        raise ClientError("Expected a deletion cookie; saved credentials were retained.")
    transport.confirmed_action = outcome
    save_confirmed_session(transport.session, None, outcome)
    if transport.session.path is None:
        write_text(sys.stderr, "Validated deletion cookie; no session file was supplied, so nothing was saved.\n")
    else:
        write_text(sys.stderr, "Validated deletion cookie; only the supplied local session state was cleared.\n")


def handle_error(response, action: str, transport: HttpsTransport) -> int:
    """Preserve JSON failures and handle only specifically validated cookie-clear outcomes."""
    value = bounded_json(response)
    print_json(value)
    code = error_code(value)
    has_cookie = bool(response.headers.get_all("Set-Cookie", []))
    if (action in PASSWORD_ACTIONS and response.code == 503 and code == PARTIAL_CODE
            and value["error"]["message"] == PARTIAL_MESSAGE):
        clear_session(response, transport, "Password change with unconfirmed server-wide session revocation")
        write_text(sys.stderr, "Password change is confirmed; server-wide session revocation is NOT confirmed. Seek administrator review; do not retry.\n")
    elif (action == "me" and response.code == 401 and code == "AUTHENTICATION_REQUIRED"
          and value["error"]["message"] == "Authentication required."):
        if has_cookie:
            clear_session(response, transport, "Session rejection")
        else:
            write_text(sys.stderr, "Session rejected without a deletion cookie; local state was retained.\n")
    else:
        if has_cookie:
            raise ClientError("Unexpected response cookies; saved credentials were retained.")
        if action in PASSWORD_ACTIONS and code == "PASSWORD_UPDATE_UNCONFIRMED":
            write_text(sys.stderr, "Remote password outcome is unknown; local credential retained. Do not blindly repeat the mutation.\n")
        elif response.code == 401:
            write_text(sys.stderr, "Authentication/proof was rejected; no local logout or automatic login was performed.\n")
    return 1


def send_api(action: str, target: str, method: str, payload: bytes | None, transport: HttpsTransport) -> int:
    """Send one bounded JSON request and close success/error responses on every exit."""
    try:
        with transport.open(transport.session.origin + target, method, payload, "application/json") as response:
            http_status(response.status)
            if action == "logout":
                if response.status != 204 or response.read(AUTH_BYTES + 1) != b"":
                    raise ClientError("Expected an empty HTTP 204 logout response; saved credentials were retained.")
                clear_session(response, transport, "Logout")
                return 0
            expected = SUCCESS_BODIES.get(action)
            if response.status != (expected[0] if expected else 200):
                raise ClientError("Unexpected API success status; saved credentials were retained.")
            value = public_session(response) if action == "me" else bounded_json(response, RESPONSE_LIMITS.get(action, AUTH_BYTES))
            if expected and value != expected[1]:
                raise ClientError("Response does not match the documented public auth result; saved credentials were retained.")
            if action in PASSWORD_ACTIONS:
                # All remote protocol checks precede the only permitted local credential mutation.
                clear_session(response, transport, "Password update")
                print_json(value)
            else:
                if response.headers.get_all("Set-Cookie", []):
                    raise ClientError("Unexpected response cookies; saved credentials were retained.")
                print_json(value)
            return 0
    except urllib.error.HTTPError as response:
        with response:
            http_status(response.code)
            return handle_error(response, action, transport)


def main() -> int:
    """Validate one explicit action, then load state/prompt and dispatch exactly once."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--action", choices=("login", "me", "logout", "request"), required=True)
    parser.add_argument("--base-url", type=base_argument, required=True, help="Generated CloudFront HTTPS origin only.")
    parser.add_argument("--session-file", type=session_argument, help="Existing private session file; only login may create it.")
    parser.add_argument("--email", type=email_argument, help="Login only; password is prompted privately.")
    parser.add_argument("--method", choices=("GET", "POST"), help="Request action only.")
    parser.add_argument("--path", help="Exact allowlisted /api path without query/fragment; Google and chat are excluded.")
    parser.add_argument("--cursor", help="Opaque history cursor; fetches one page only.")
    parser.add_argument("--body-file", help="Bounded UTF-8 JSON file, or '-' for explicit stdin; no inline secrets.")
    args = parser.parse_args()
    if args.action != "request" and any(value is not None for value in (args.method, args.path, args.cursor, args.body_file)):
        parser.error("--method, --path, --cursor and --body-file apply only to request.")
    if args.email is not None and args.action != "login":
        parser.error("--email applies only to login.")
    if args.action == "login" and (args.email is None or args.session_file is None):
        parser.error("Login requires --email and an explicit --session-file.")
    action = args.action
    method = "GET" if action == "me" else "POST"
    target = AUTH_PATHS.get(action)
    body = None
    transport = None
    try:
        if action == "request":
            if args.method is None or args.path is None:
                parser.error("Request requires --method and --path.")
            method = args.method
            action = route_action(method, args.path)
            if action not in API_ACTIONS - {"login", "me", "logout"}:
                parser.error("Use dedicated login/me/logout actions, or chat_client.py for chat.")
            target = route_target(method, args.path, args.cursor)
            if method == "GET" and args.body_file is not None:
                parser.error("GET does not accept a body file.")
            if method == "POST":
                if args.body_file is None:
                    parser.error("POST requires --body-file, with missing secret fields prompted privately.")
                body = validate_body(action, read_body(args.body_file), allow_missing_secrets=True)
        session = SessionState(args.base_url, args.session_file, creating=action == "login")
        transport = HttpsTransport(session, timeout=SOCKET_TIMEOUT_SECONDS, allowed_actions=API_ACTIONS)
        if action == "login":
            return send_login(transport, login_payload(args.email), print_json)
        payload = complete_body(action, body) if body is not None else b"{}" if action == "logout" else None
        write_text(sys.stderr, "Sending one explicit API request; no retries, renewal or pagination.\n")
        return send_api(action, target, method, payload, transport)
    except KeyboardInterrupt:
        write_text(sys.stderr, "Interrupted locally (exit 130); closing the connection does not undo a remote request.\n")
        if transport and transport.confirmed_action:
            write_text(sys.stderr, "Remote outcome was confirmed; local persistence may need attention.\n")
        elif transport and transport.attempted:
            write_text(sys.stderr, "Remote outcome is unknown; saved credentials retained. No automatic retry was sent.\n")
        return 130
    except (ClientError, urllib.error.URLError, OSError, http.client.HTTPException) as error:
        if isinstance(error, ClientError):
            write_text(sys.stderr, f"Client error: {error}\n")
        elif isinstance(error, ssl.SSLError) or (isinstance(error, urllib.error.URLError) and isinstance(error.reason, ssl.SSLError)):
            write_text(sys.stderr, "TLS connection/verification failed; no raw diagnostics displayed.\n")
        else:
            write_text(sys.stderr, "Connection or local I/O failed (75-second socket inactivity timeout); no raw diagnostics displayed.\n")
        if transport and transport.confirmed_action:
            write_text(sys.stderr, f"{transport.confirmed_action} was confirmed remotely; local persistence may need attention.\n")
        elif transport and transport.attempted:
            write_text(sys.stderr, "Remote acceptance/completion is unknown; credentials retained. No automatic retry was sent.\n")
        else:
            write_text(sys.stderr, "No request was sent.\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
