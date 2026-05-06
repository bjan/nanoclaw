export interface BackendMessage {
  type: string;
  subtype?: string;
  session_id?: string;
  uuid?: string;
  result?: string;
  task_id?: string;
  status?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface HookConfig {
  matcher?: string;
  hooks: Array<(...args: unknown[]) => Promise<unknown>>;
  timeout?: number;
}

export interface BackendQueryConfig {
  prompt: string | AsyncIterable<unknown>;
  cwd: string;
  resume?: string;
  resumeSessionAt?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  systemPrompt?: {
    type: 'preset';
    preset: 'claude_code';
    append?: string;
  };
  allowedTools: string[];
  mcpServers: Record<string, McpServerConfig>;
  env: Record<string, string | undefined>;
  permissionMode: string;
  allowDangerouslySkipPermissions: boolean;
  settingSources: readonly string[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hooks?: Record<string, any[]>;
  additionalDirectories?: string[];
}

export interface AgentBackend {
  name: string;
  query(config: BackendQueryConfig): AsyncIterable<BackendMessage>;
}

import { ClaudeCodeBackend } from './backends/claude-code.js';
import { CodexBackend } from './backends/codex.js';

export function createBackend(name: string): AgentBackend {
  switch (name) {
    case 'claude-code':
      return new ClaudeCodeBackend();
    case 'codex':
      return new CodexBackend();
    default:
      throw new Error(`Unknown backend: ${name}. Available: claude-code, codex`);
  }
}
