import type { AgentBackend, BackendQueryConfig, BackendMessage } from '../backend.js';

export class CodexBackend implements AgentBackend {
  name = 'codex';

  async *query(_config: BackendQueryConfig): AsyncIterable<BackendMessage> {
    // TODO: Implement Codex/OpenAI backend integration
    // This will wrap the Codex SDK similar to how ClaudeCodeBackend wraps claude-agent-sdk
    yield {
      type: 'result',
      subtype: 'error_system',
      result: 'Codex backend is not yet implemented. Switch back to claude-code.',
    } satisfies BackendMessage;
  }
}
