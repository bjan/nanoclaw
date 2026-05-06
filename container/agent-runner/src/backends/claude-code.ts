import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { AgentBackend, BackendQueryConfig, BackendMessage } from '../backend.js';

export class ClaudeCodeBackend implements AgentBackend {
  name = 'claude-code';

  async *query(config: BackendQueryConfig): AsyncIterable<BackendMessage> {
    const options: Options = {
      cwd: config.cwd,
      additionalDirectories: config.additionalDirectories,
      resume: config.resume,
      resumeSessionAt: config.resumeSessionAt,
      effort: config.effort,
      systemPrompt: config.systemPrompt,
      allowedTools: config.allowedTools,
      env: config.env,
      permissionMode: config.permissionMode as 'bypassPermissions',
      allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions,
      settingSources: config.settingSources as ['project', 'user'],
      mcpServers: config.mcpServers,
      hooks: config.hooks as Options['hooks'],
    };

    for await (const message of query({
      prompt: config.prompt as Parameters<typeof query>[0]['prompt'],
      options,
    })) {
      yield message as BackendMessage;
    }
  }
}
