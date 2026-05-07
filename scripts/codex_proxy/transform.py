"""Request/response transformation between OpenAI Chat Completions
format and ChatGPT backend Responses API format."""
from __future__ import annotations

import json
import time
import uuid
from typing import Any, AsyncIterator

from .models import resolve

BACKEND_BASE = "https://chatgpt.com/backend-api"


def make_backend_headers(access_token: str, account_id: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {access_token}",
        "chatgpt-account-id": account_id,
        "OpenAI-Beta": "responses=experimental",
        "originator": "codex_cli_rs",
        "accept": "text/event-stream",
        "Content-Type": "application/json",
    }


def chat_to_responses(body: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    """Convert Chat Completions request body to Responses API body."""
    model_name = body.get("model", "gpt-5.4-mini")
    cfg = resolve(model_name)

    messages = body.get("messages", [])
    instructions = None
    input_items: list[dict[str, Any]] = []

    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if role == "system":
            if instructions is None:
                instructions = content
            else:
                instructions += "\n\n" + content
        else:
            item: dict[str, Any] = {
                "type": "message",
                "role": role,
                "content": content if isinstance(content, str) else content,
            }
            input_items.append(item)

    out: dict[str, Any] = {
        "model": cfg.backend_model,
        "input": input_items,
        "stream": True,
        "store": False,
        "include": ["reasoning.encrypted_content"],
        "text": {"verbosity": "medium"},
    }

    out["instructions"] = instructions or "You are a helpful assistant."
    if cfg.reasoning_effort:
        out["reasoning"] = {
            "effort": cfg.reasoning_effort,
            "summary": "auto",
        }

    url = f"{BACKEND_BASE}/codex/responses"
    return url, out


def is_usage_limit_error(status: int, body: bytes) -> bool:
    if status != 404:
        return False
    text = body.decode("utf-8", errors="replace").lower()
    return any(s in text for s in (
        "usage_limit_reached",
        "usage_not_included",
        "rate_limit_exceeded",
        "usage limit",
    ))


def parse_sse_to_text(raw: str) -> str:
    """Parse SSE stream text and extract the assistant's response."""
    output_text_parts: list[str] = []
    full_response: dict[str, Any] | None = None

    for line in raw.split("\n"):
        if not line.startswith("data: "):
            continue
        data_str = line[6:].strip()
        if not data_str or data_str == "[DONE]":
            continue
        try:
            event = json.loads(data_str)
        except json.JSONDecodeError:
            continue

        event_type = event.get("type", "")

        if event_type == "response.output_text.delta":
            delta = event.get("delta", "")
            if delta:
                output_text_parts.append(delta)

        if event_type in ("response.completed", "response.done"):
            full_response = event.get("response", event)

    if output_text_parts:
        return "".join(output_text_parts)

    if full_response:
        for item in full_response.get("output", []):
            if item.get("type") == "message":
                for part in item.get("content", []):
                    if part.get("type") == "output_text":
                        return part.get("text", "")

    return ""


def build_chat_completion_response(
    model: str, content: str, usage: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content},
            "finish_reason": "stop",
        }],
        "usage": usage or {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
    }


async def sse_to_chat_stream(
    model: str, sse_stream: AsyncIterator[bytes],
) -> AsyncIterator[bytes]:
    """Convert backend SSE to Chat Completions streaming format."""
    chunk_id = f"chatcmpl-{uuid.uuid4().hex[:12]}"

    async for raw_chunk in sse_stream:
        text = raw_chunk.decode("utf-8", errors="replace")
        for line in text.split("\n"):
            if not line.startswith("data: "):
                continue
            data_str = line[6:].strip()
            if not data_str or data_str == "[DONE]":
                continue
            try:
                event = json.loads(data_str)
            except json.JSONDecodeError:
                continue

            event_type = event.get("type", "")
            if event_type == "response.output_text.delta":
                delta = event.get("delta", "")
                if delta:
                    chunk = {
                        "id": chunk_id,
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "delta": {"content": delta},
                            "finish_reason": None,
                        }],
                    }
                    yield f"data: {json.dumps(chunk)}\n\n".encode()

            elif event_type in ("response.completed", "response.done"):
                chunk = {
                    "id": chunk_id,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": model,
                    "choices": [{
                        "index": 0,
                        "delta": {},
                        "finish_reason": "stop",
                    }],
                }
                yield f"data: {json.dumps(chunk)}\n\n".encode()
                yield b"data: [DONE]\n\n"
