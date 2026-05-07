"""Starlette ASGI app exposing /v1/chat/completions backed by ChatGPT OAuth."""
from __future__ import annotations

import json
import logging
import sys
from typing import Any

import httpx
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

from .accounts import Account, AccountStore
from .models import AVAILABLE_MODELS
from .transform import (
    build_chat_completion_response,
    chat_to_responses,
    is_usage_limit_error,
    make_backend_headers,
    parse_sse_response,
    sse_to_chat_stream,
)

log = logging.getLogger("codex-proxy")

_store = AccountStore()
_client: httpx.AsyncClient | None = None


def _get_store() -> AccountStore:
    if not _store.accounts:
        _store.load()
    return _store


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(300.0, connect=10.0),
        )
    return _client


async def _try_request(
    acct: Account, url: str, body: dict[str, Any], stream: bool,
) -> httpx.Response | None:
    headers = make_backend_headers(acct.access_token, acct.account_id)
    client = _get_client()
    if stream:
        req = client.build_request("POST", url, json=body, headers=headers)
        resp = await client.send(req, stream=True)
        if resp.status_code == 404:
            peek = await resp.aread()
            if is_usage_limit_error(404, peek):
                return None
            resp = httpx.Response(
                status_code=resp.status_code,
                headers=dict(resp.headers),
                content=peek,
            )
        return resp
    else:
        resp = await client.post(url, json=body, headers=headers)
        if is_usage_limit_error(resp.status_code, resp.content):
            return None
        return resp


async def chat_completions(request: Request) -> JSONResponse | StreamingResponse:
    store = _get_store()
    if not store.accounts:
        return JSONResponse(
            {"error": {"message": "no codex accounts configured — run: codex-proxy auth add --manual", "type": "server_error"}},
            status_code=500,
        )

    body = await request.json()
    model_name = body.get("model", "gpt-5.4-mini")
    want_stream = body.get("stream", False)

    try:
        url, backend_body = chat_to_responses(body)
    except KeyError as e:
        return JSONResponse(
            {"error": {"message": str(e), "type": "invalid_request_error"}},
            status_code=400,
        )

    tried: set[str] = set()
    acct = store.get_available()
    while acct and acct.id not in tried:
        tried.add(acct.id)
        log.info("trying account %s (%s) for model %s", acct.id, acct.label, model_name)

        try:
            resp = await _try_request(acct, url, backend_body, stream=True)
        except httpx.HTTPStatusError as e:
            if e.response.status_code in (401, 403):
                try:
                    store.refresh(acct)
                    resp = await _try_request(acct, url, backend_body, stream=True)
                except Exception:
                    log.warning("refresh+retry failed for account %s", acct.id, exc_info=True)
                    store.mark_rate_limited(acct, 300)
                    acct = store.get_next_available(acct)
                    continue
            else:
                return JSONResponse(
                    {"error": {"message": f"backend error: {e}", "type": "server_error"}},
                    status_code=502,
                )
        except Exception as e:
            log.warning("request to account %s failed: %s", acct.id, e)
            store.mark_rate_limited(acct, 60)
            acct = store.get_next_available(acct)
            continue

        if resp is None:
            log.info("account %s hit usage limit, rotating", acct.id)
            store.mark_rate_limited(acct, 600)
            acct = store.get_next_available(acct)
            continue

        if resp.status_code >= 400:
            try:
                error_body = await resp.aread()
            except Exception:
                error_body = b""
            error_text = error_body.decode("utf-8", errors="replace")[:500]
            log.warning(
                "backend %s for account %s model=%s body=%s",
                resp.status_code, acct.id, model_name, error_text,
            )
            return JSONResponse(
                {"error": {"message": f"backend {resp.status_code}: {error_text}", "type": "server_error"}},
                status_code=resp.status_code,
            )

        if want_stream:
            return StreamingResponse(
                sse_to_chat_stream(model_name, resp.aiter_bytes()),
                media_type="text/event-stream",
            )
        else:
            raw = (await resp.aread()).decode("utf-8", errors="replace")
            parsed = parse_sse_response(raw)
            return JSONResponse(
                build_chat_completion_response(
                    model_name,
                    content=parsed["text"],
                    tool_calls=parsed["tool_calls"],
                ),
            )

    return JSONResponse(
        {"error": {"message": "all accounts exhausted (rate limited)", "type": "rate_limit_error"}},
        status_code=429,
    )


async def list_models(request: Request) -> JSONResponse:
    return JSONResponse({
        "object": "list",
        "data": [
            {"id": m, "object": "model", "owned_by": "openai"}
            for m in AVAILABLE_MODELS
        ],
    })


async def health(request: Request) -> JSONResponse:
    store = _get_store()
    return JSONResponse({
        "status": "ok",
        "accounts": len(store.accounts),
        "available": sum(1 for a in store.accounts if a.is_cooled_down),
    })


app = Starlette(
    routes=[
        Route("/v1/chat/completions", chat_completions, methods=["POST"]),
        Route("/v1/models", list_models, methods=["GET"]),
        Route("/health", health, methods=["GET"]),
    ],
)


def serve(host: str = "0.0.0.0", port: int = 8741) -> None:
    import uvicorn
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
        stream=sys.stderr,
    )
    log.info("starting codex proxy on %s:%d with %d account(s)",
             host, port, len(_get_store().accounts))
    uvicorn.run(app, host=host, port=port, log_level="info")
