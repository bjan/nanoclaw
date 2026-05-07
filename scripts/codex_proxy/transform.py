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

        elif role == "assistant" and msg.get("tool_calls"):
            input_items.append({
                "type": "message",
                "role": "assistant",
                "content": content or "",
            })
            for tc in msg["tool_calls"]:
                input_items.append({
                    "type": "function_call",
                    "call_id": tc["id"],
                    "name": tc["function"]["name"],
                    "arguments": tc["function"]["arguments"],
                })

        elif role == "tool":
            input_items.append({
                "type": "function_call_output",
                "call_id": msg.get("tool_call_id", ""),
                "output": content if isinstance(content, str) else json.dumps(content),
            })

        else:
            input_items.append({
                "type": "message",
                "role": role,
                "content": content if isinstance(content, str) else content,
            })

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

    tools = body.get("tools")
    if tools:
        resp_tools = []
        for t in tools:
            if t.get("type") == "function":
                resp_tools.append({
                    "type": "function",
                    "name": t["function"]["name"],
                    "description": t["function"].get("description", ""),
                    "parameters": t["function"].get("parameters", {}),
                })
        if resp_tools:
            out["tools"] = resp_tools

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


def parse_sse_response(raw: str) -> dict[str, Any]:
    """Parse SSE stream and extract text content and/or tool calls."""
    output_text_parts: list[str] = []
    tool_calls: dict[str, dict[str, Any]] = {}
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

        if event_type == "response.output_item.added":
            item = event.get("item", {})
            if item.get("type") == "function_call":
                call_id = item.get("call_id", "")
                tool_calls[call_id] = {
                    "name": item.get("name", ""),
                    "arguments": "",
                }

        if event_type == "response.function_call_arguments.delta":
            call_id = event.get("call_id", "")
            if call_id in tool_calls:
                tool_calls[call_id]["arguments"] += event.get("delta", "")

        if event_type == "response.function_call_arguments.done":
            call_id = event.get("call_id", "")
            if call_id in tool_calls:
                tool_calls[call_id]["arguments"] = event.get("arguments", tool_calls[call_id]["arguments"])

        if event_type in ("response.completed", "response.done"):
            full_response = event.get("response", event)

    if not output_text_parts and not tool_calls and full_response:
        for item in full_response.get("output", []):
            if item.get("type") == "message":
                for part in item.get("content", []):
                    if part.get("type") == "output_text":
                        text = part.get("text", "")
                        if text:
                            output_text_parts.append(text)
            elif item.get("type") == "function_call":
                call_id = item.get("call_id", "")
                tool_calls[call_id] = {
                    "name": item.get("name", ""),
                    "arguments": item.get("arguments", ""),
                }

    return {
        "text": "".join(output_text_parts) if output_text_parts else None,
        "tool_calls": [
            {"id": cid, "name": tc["name"], "arguments": tc["arguments"]}
            for cid, tc in tool_calls.items()
        ] if tool_calls else None,
    }


# Keep backward compat
def parse_sse_to_text(raw: str) -> str:
    result = parse_sse_response(raw)
    return result["text"] or ""


def build_chat_completion_response(
    model: str,
    content: str | None = None,
    tool_calls: list[dict[str, Any]] | None = None,
    usage: dict[str, Any] | None = None,
) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant"}
    finish_reason = "stop"

    if tool_calls:
        message["content"] = content
        message["tool_calls"] = [
            {
                "id": tc["id"],
                "type": "function",
                "function": {
                    "name": tc["name"],
                    "arguments": tc["arguments"],
                },
            }
            for tc in tool_calls
        ]
        finish_reason = "tool_calls"
    else:
        message["content"] = content or ""

    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:12]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": finish_reason,
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
    tool_calls_acc: dict[str, dict[str, Any]] = {}
    tc_index_map: dict[str, int] = {}
    tc_next_index = 0

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

            elif event_type == "response.output_item.added":
                item = event.get("item", {})
                if item.get("type") == "function_call":
                    call_id = item.get("call_id", "")
                    idx = tc_next_index
                    tc_next_index += 1
                    tc_index_map[call_id] = idx
                    tool_calls_acc[call_id] = {"name": item.get("name", ""), "arguments": ""}
                    chunk = {
                        "id": chunk_id,
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "delta": {
                                "tool_calls": [{
                                    "index": idx,
                                    "id": call_id,
                                    "type": "function",
                                    "function": {"name": item.get("name", ""), "arguments": ""},
                                }],
                            },
                            "finish_reason": None,
                        }],
                    }
                    yield f"data: {json.dumps(chunk)}\n\n".encode()

            elif event_type == "response.function_call_arguments.delta":
                call_id = event.get("call_id", "")
                delta = event.get("delta", "")
                if call_id in tc_index_map and delta:
                    chunk = {
                        "id": chunk_id,
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "delta": {
                                "tool_calls": [{
                                    "index": tc_index_map[call_id],
                                    "function": {"arguments": delta},
                                }],
                            },
                            "finish_reason": None,
                        }],
                    }
                    yield f"data: {json.dumps(chunk)}\n\n".encode()

            elif event_type in ("response.completed", "response.done"):
                finish = "tool_calls" if tool_calls_acc else "stop"
                chunk = {
                    "id": chunk_id,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": model,
                    "choices": [{
                        "index": 0,
                        "delta": {},
                        "finish_reason": finish,
                    }],
                }
                yield f"data: {json.dumps(chunk)}\n\n".encode()
                yield b"data: [DONE]\n\n"
