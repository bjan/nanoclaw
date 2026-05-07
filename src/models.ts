/**
 * Model registry — maps friendly aliases to provider config.
 * Used by /model command and container-runner to route agent requests.
 */

import { getRouterState, setRouterState } from './db.js';

export interface ModelConfig {
  id: string; // Model ID sent to the API (e.g. "claude-opus-4-6")
  contextWindow: number; // Max tokens for this specific model
  baseUrl?: string; // Override ANTHROPIC_BASE_URL (undefined = default Anthropic API)
  apiKey?: string; // Override ANTHROPIC_API_KEY (undefined = use OAuth/default)
  backend?: string; // Agent backend override (e.g. "codex"). Default: "claude-code"
  label: string; // Human-friendly display name
}

export function getCompactThreshold(config: ModelConfig): number {
  return Math.floor(config.contextWindow * 0.8);
}

const LOCAL_BASE_URL = 'http://nix-tail:3456';
const LOCAL_API_KEY = 'dummy';
const LOCAL_PROVIDER = 'llama-swap'; // CCR provider prefix — bypasses default routing

/**
 * Model registry. Add entries here to make them available via /model.
 * Models without a baseUrl use the default Anthropic API (OAuth).
 * Local models route through Claude Code Router on nix-tail.
 */
export const MODEL_REGISTRY: Record<string, ModelConfig> = {
  // Anthropic models (use default API + OAuth)
  'opus': {
    id: 'claude-opus-4-6',
    contextWindow: 200_000,
    label: 'Claude Opus 4.6',
  },
  'sonnet': {
    id: 'claude-sonnet-4-6',
    contextWindow: 200_000,
    label: 'Claude Sonnet 4.6',
  },
  'haiku': {
    id: 'claude-haiku-4-5-20251001',
    contextWindow: 200_000,
    label: 'Claude Haiku 4.5',
  },

  // Local models via Claude Code Router (nix-tail:3456 → llama-swap)
  // CCR requires "provider,model" format to bypass its default routing.
  'glm-4.7-flash': { id: `${LOCAL_PROVIDER},glm-4.7-flash`, contextWindow: 131_072, baseUrl: LOCAL_BASE_URL, apiKey: LOCAL_API_KEY, label: 'GLM 4.7 Flash' },
  'glm': { id: `${LOCAL_PROVIDER},glm`, contextWindow: 131_072, baseUrl: LOCAL_BASE_URL, apiKey: LOCAL_API_KEY, label: 'GLM (default)' },
  'glm-neo': { id: `${LOCAL_PROVIDER},glm-4.7-flash-neo-code`, contextWindow: 131_072, baseUrl: LOCAL_BASE_URL, apiKey: LOCAL_API_KEY, label: 'GLM Neo Code' },
  'qwen-large': { id: `${LOCAL_PROVIDER},qwen3.5-35b-a3b`, contextWindow: 32_768, baseUrl: LOCAL_BASE_URL, apiKey: LOCAL_API_KEY, label: 'Qwen 3.5 35B' },
  'medgemma': { id: `${LOCAL_PROVIDER},medgemma`, contextWindow: 8_192, baseUrl: LOCAL_BASE_URL, apiKey: LOCAL_API_KEY, label: 'MedGemma 27B' },
  'gemma4-large': { id: `${LOCAL_PROVIDER},gemma-4-26b-a4b`, contextWindow: 32_768, baseUrl: LOCAL_BASE_URL, apiKey: LOCAL_API_KEY, label: 'Gemma 4 26B' },
  'gemma4-small': { id: `${LOCAL_PROVIDER},gemma-4-26b-a4b-q2`, contextWindow: 8_192, baseUrl: LOCAL_BASE_URL, apiKey: LOCAL_API_KEY, label: 'Gemma 4 Small (Q2)' },
  'gemma4-medium': { id: `${LOCAL_PROVIDER},gemma-4-26b-a4b-medium`, contextWindow: 32_768, baseUrl: LOCAL_BASE_URL, apiKey: LOCAL_API_KEY, label: 'Gemma 4 Medium' },
  'qwen-mini': { id: `${LOCAL_PROVIDER},qwen3-1.7b`, contextWindow: 32_768, baseUrl: LOCAL_BASE_URL, apiKey: LOCAL_API_KEY, label: 'Qwen 3 1.7B' },
  'gemma4-uncensored-large': { id: `${LOCAL_PROVIDER},gemma-4-a4b-uncensored`, contextWindow: 32_768, baseUrl: LOCAL_BASE_URL, apiKey: LOCAL_API_KEY, label: 'Gemma 4 Uncensored Large' },
  'gemma4-uncensored': { id: `${LOCAL_PROVIDER},gemma-4-e4b-uncensored`, contextWindow: 8_192, baseUrl: LOCAL_BASE_URL, apiKey: LOCAL_API_KEY, label: 'Gemma 4 Uncensored' },

  // Codex models via pct-codex-proxy (ChatGPT OAuth → OpenAI Chat Completions)
  'gpt-5.5': { id: 'gpt-5.5', contextWindow: 200_000, backend: 'codex', label: 'GPT-5.5' },
  'gpt-5.5-high': { id: 'gpt-5.5-high', contextWindow: 200_000, backend: 'codex', label: 'GPT-5.5 High' },
  'gpt-5.5-low': { id: 'gpt-5.5-low', contextWindow: 200_000, backend: 'codex', label: 'GPT-5.5 Low' },
  'gpt-5.4': { id: 'gpt-5.4', contextWindow: 200_000, backend: 'codex', label: 'GPT-5.4' },
  'gpt-5.4-mini': { id: 'gpt-5.4-mini', contextWindow: 128_000, backend: 'codex', label: 'GPT-5.4 Mini' },
};

const MODEL_STATE_PREFIX = 'model:';

/** Get the currently selected model alias for a group (undefined = default) */
export function getGroupModel(groupFolder: string): string | undefined {
  return getRouterState(`${MODEL_STATE_PREFIX}${groupFolder}`);
}

/** Set the model for a group */
export function setGroupModel(groupFolder: string, alias: string): void {
  setRouterState(`${MODEL_STATE_PREFIX}${groupFolder}`, alias);
}

/** Clear model override (revert to default) */
export function clearGroupModel(groupFolder: string): void {
  setRouterState(`${MODEL_STATE_PREFIX}${groupFolder}`, '');
}

/** Resolve a group's model config. Returns undefined if using default. */
export function resolveGroupModelConfig(
  groupFolder: string,
): ModelConfig | undefined {
  const alias = getGroupModel(groupFolder);
  if (!alias) return undefined;
  return MODEL_REGISTRY[alias];
}

/** List all available model aliases */
export function listModels(): string[] {
  return Object.keys(MODEL_REGISTRY);
}
