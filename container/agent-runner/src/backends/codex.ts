import type { AgentBackend, BackendQueryConfig, BackendMessage } from '../backend.js';

const DEFAULT_PROXY_URL = 'http://nix-tail:8741/v1';
const DEFAULT_MODEL = 'gpt-5.5';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
}

export class CodexBackend implements AgentBackend {
  name = 'codex';

  async *query(config: BackendQueryConfig): AsyncIterable<BackendMessage> {
    const proxyUrl = config.env.CODEX_PROXY_URL || DEFAULT_PROXY_URL;
    const model = config.env.CODEX_MODEL || DEFAULT_MODEL;
    const sessionId = `codex-${Date.now()}`;

    yield { type: 'system', subtype: 'init', session_id: sessionId };

    const promptText = await this.extractPrompt(config.prompt);

    const messages: ChatMessage[] = [];

    if (config.systemPrompt?.append) {
      messages.push({ role: 'system', content: config.systemPrompt.append });
    }

    messages.push({ role: 'user', content: promptText });

    try {
      const response = await fetch(`${proxyUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer codex' },
        body: JSON.stringify({ model, messages }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        const status = response.status;
        let errorMsg = `Codex proxy error (${status}): ${errorBody}`;
        if (status === 429) {
          errorMsg = 'All Codex proxy accounts are rate-limited. Try again later.';
        }
        yield { type: 'result', subtype: 'error_system', result: errorMsg };
        return;
      }

      const data = await response.json() as ChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        yield { type: 'result', subtype: 'error_system', result: 'Codex returned an empty response.' };
        return;
      }

      yield { type: 'result', subtype: 'success', result: content };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'result', subtype: 'error_system', result: `Codex backend error: ${msg}` };
    }
  }

  private async extractPrompt(prompt: string | AsyncIterable<unknown>): Promise<string> {
    if (typeof prompt === 'string') return prompt;

    const parts: string[] = [];
    for await (const msg of prompt) {
      const m = msg as { message?: { content?: string } };
      if (m.message?.content) parts.push(m.message.content);
      if (parts.length > 0) break;
    }
    return parts.join('\n');
  }
}
