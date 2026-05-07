"""Model name mapping and reasoning configuration."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ModelConfig:
    backend_model: str
    reasoning_effort: str | None = None


MODEL_MAP: dict[str, ModelConfig] = {
    # GPT-5.5
    "gpt-5.5": ModelConfig("gpt-5.5", "medium"),
    "gpt-5.5-none": ModelConfig("gpt-5.5", None),
    "gpt-5.5-low": ModelConfig("gpt-5.5", "low"),
    "gpt-5.5-medium": ModelConfig("gpt-5.5", "medium"),
    "gpt-5.5-high": ModelConfig("gpt-5.5", "high"),
    "gpt-5.5-xhigh": ModelConfig("gpt-5.5", "xhigh"),

    # GPT-5.4
    "gpt-5.4": ModelConfig("gpt-5.4", "medium"),
    "gpt-5.4-none": ModelConfig("gpt-5.4", None),
    "gpt-5.4-low": ModelConfig("gpt-5.4", "low"),
    "gpt-5.4-medium": ModelConfig("gpt-5.4", "medium"),
    "gpt-5.4-high": ModelConfig("gpt-5.4", "high"),
    "gpt-5.4-xhigh": ModelConfig("gpt-5.4", "xhigh"),

    # GPT-5.4 Mini
    "gpt-5.4-mini": ModelConfig("gpt-5.4-mini", "medium"),
    "gpt-5.4-mini-none": ModelConfig("gpt-5.4-mini", None),
    "gpt-5.4-mini-low": ModelConfig("gpt-5.4-mini", "low"),
    "gpt-5.4-mini-medium": ModelConfig("gpt-5.4-mini", "medium"),
    "gpt-5.4-mini-high": ModelConfig("gpt-5.4-mini", "high"),

    # GPT-5.3 Codex
    "gpt-5.3-codex": ModelConfig("gpt-5.3-codex", "medium"),
    "gpt-5.3-codex-low": ModelConfig("gpt-5.3-codex", "low"),
    "gpt-5.3-codex-medium": ModelConfig("gpt-5.3-codex", "medium"),
    "gpt-5.3-codex-high": ModelConfig("gpt-5.3-codex", "high"),
    "gpt-5.3-codex-xhigh": ModelConfig("gpt-5.3-codex", "xhigh"),

    # GPT-5.2
    "gpt-5.2": ModelConfig("gpt-5.2", "medium"),
    "gpt-5.2-none": ModelConfig("gpt-5.2", None),
    "gpt-5.2-low": ModelConfig("gpt-5.2", "low"),
    "gpt-5.2-medium": ModelConfig("gpt-5.2", "medium"),
    "gpt-5.2-high": ModelConfig("gpt-5.2", "high"),
    "gpt-5.2-xhigh": ModelConfig("gpt-5.2", "xhigh"),
}

AVAILABLE_MODELS = sorted(MODEL_MAP.keys())


def resolve(name: str) -> ModelConfig:
    cfg = MODEL_MAP.get(name)
    if cfg:
        return cfg
    raise KeyError(f"unknown codex model: {name!r}; available: {AVAILABLE_MODELS}")
