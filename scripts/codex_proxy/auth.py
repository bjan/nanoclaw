"""OAuth 2.0 + PKCE flow against auth.openai.com."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
TOKEN_URL = "https://auth.openai.com/oauth/token"
CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
REDIRECT_URI = "http://localhost:1455/auth/callback"
SCOPE = "openid profile email offline_access"


def generate_pkce() -> tuple[str, str]:
    verifier = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
    digest = hashlib.sha256(verifier.encode()).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return verifier, challenge


def build_authorize_url(state: str, challenge: str) -> str:
    params = {
        "response_type": "code",
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "scope": SCOPE,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        "id_token_add_organizations": "true",
        "codex_cli_simplified_flow": "true",
        "originator": "codex_cli_rs",
    }
    return f"{AUTHORIZE_URL}?{urlencode(params)}"


def exchange_code(code: str, verifier: str) -> dict[str, Any]:
    with httpx.Client(timeout=30) as c:
        r = c.post(
            TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "client_id": CLIENT_ID,
                "code": code,
                "code_verifier": verifier,
                "redirect_uri": REDIRECT_URI,
            },
        )
        r.raise_for_status()
        return r.json()


def refresh_access_token(refresh_token: str) -> dict[str, Any]:
    with httpx.Client(timeout=30) as c:
        r = c.post(
            TOKEN_URL,
            data={
                "grant_type": "refresh_token",
                "client_id": CLIENT_ID,
                "refresh_token": refresh_token,
            },
        )
        r.raise_for_status()
        return r.json()


def extract_account_id(access_token: str) -> str:
    parts = access_token.split(".")
    if len(parts) < 2:
        raise ValueError("access_token is not a JWT")
    payload = parts[1]
    padding = 4 - len(payload) % 4
    if padding != 4:
        payload += "=" * padding
    data = json.loads(base64.urlsafe_b64decode(payload))
    auth_claim = data.get("https://api.openai.com/auth", {})
    aid = auth_claim.get("chatgpt_account_id")
    if not aid:
        raise ValueError("no chatgpt_account_id in JWT")
    return aid


def run_auth_flow(label: str = "", *, manual: bool = False) -> dict[str, Any]:
    """Interactive OAuth flow. Use manual=True on headless hosts."""
    verifier, challenge = generate_pkce()
    state = secrets.token_hex(16)
    url = build_authorize_url(state, challenge)

    if manual:
        return _run_auth_flow_manual(url, state, verifier, label)
    return _run_auth_flow_browser(url, state, verifier, label)


def _run_auth_flow_browser(url: str, state: str, verifier: str,
                            label: str) -> dict[str, Any]:
    result: dict[str, Any] = {}
    error: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path != "/auth/callback":
                self.send_response(404)
                self.end_headers()
                return
            qs = parse_qs(parsed.query)
            cb_state = qs.get("state", [""])[0]
            code = qs.get("code", [""])[0]
            if cb_state != state:
                error.append("state mismatch")
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"State mismatch. Close this tab.")
                return
            if not code:
                error.append("no code received")
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b"No code received. Close this tab.")
                return
            try:
                tokens = exchange_code(code, verifier)
                account_id = extract_account_id(tokens["access_token"])
                result.update(tokens)
                result["account_id"] = account_id
                result["label"] = label
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(
                    b"<h2>Authenticated. You can close this tab.</h2>"
                )
            except Exception as e:
                error.append(str(e))
                self.send_response(500)
                self.end_headers()
                self.wfile.write(f"Error: {e}".encode())

        def log_message(self, format, *args):
            pass

    server = HTTPServer(("127.0.0.1", 1455), Handler)
    server.timeout = 120

    print(f"Opening browser for OAuth login...")
    print(f"  URL: {url}")
    webbrowser.open(url)

    while not result and not error:
        server.handle_request()

    server.server_close()

    if error:
        raise RuntimeError(f"auth failed: {error[0]}")

    return result


def _run_auth_flow_manual(url: str, state: str, verifier: str,
                           label: str) -> dict[str, Any]:
    print()
    print("=" * 70)
    print("HEADLESS OAUTH — open this URL in a browser on any machine:")
    print()
    print(url)
    print()
    print("After approving, your browser will redirect to a URL starting")
    print("with http://localhost:1455/auth/callback?... — the connection")
    print("will fail (expected). Copy the FULL URL from the browser's")
    print("address bar and paste it below.")
    print("=" * 70)
    print()
    redirect_url = input("Paste redirect URL: ").strip()
    if not redirect_url:
        raise RuntimeError("no redirect URL provided")
    parsed = urlparse(redirect_url)
    qs = parse_qs(parsed.query)
    cb_state = qs.get("state", [""])[0]
    code = qs.get("code", [""])[0]
    if cb_state != state:
        raise RuntimeError(f"state mismatch")
    if not code:
        raise RuntimeError("no code in redirect URL")
    tokens = exchange_code(code, verifier)
    account_id = extract_account_id(tokens["access_token"])
    tokens["account_id"] = account_id
    tokens["label"] = label
    return tokens
