import { spawn, execSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { AgentBackend, BackendQueryConfig, BackendMessage, McpServerConfig } from '../backend.js';

const DEFAULT_PROXY_URL = 'http://nix-tail:8741/v1';
const DEFAULT_MODEL = 'gpt-5.5';
const MAX_TOOL_ROUNDS = 25;

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface McpConnection {
  client: Client;
  transport: StdioClientTransport;
  serverName: string;
}

function log(msg: string): void {
  process.stderr.write(`[codex] ${msg}\n`);
}

export class CodexBackend implements AgentBackend {
  name = 'codex';

  async *query(config: BackendQueryConfig): AsyncIterable<BackendMessage> {
    const proxyUrl = config.env.CODEX_PROXY_URL || DEFAULT_PROXY_URL;
    const model = config.env.CODEX_MODEL || DEFAULT_MODEL;
    const sessionId = `codex-${Date.now()}`;
    const contextWindow = parseInt(config.env.NANOCLAW_CONTEXT_WINDOW || '200000', 10);
    const compactThreshold = Math.floor(contextWindow * 0.8);

    yield { type: 'system', subtype: 'init', session_id: sessionId };

    const mcpConnections: McpConnection[] = [];
    const toolMap = new Map<string, { connection: McpConnection; mcpToolName: string }>();
    const tools: OpenAITool[] = [];

    try {
      // Connect to MCP servers and discover tools
      for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
        try {
          const conn = await this.connectMcp(name, serverConfig, config.env);
          mcpConnections.push(conn);

          const toolList = await conn.client.listTools();
          for (const tool of toolList.tools) {
            const qualifiedName = `mcp__${name}__${tool.name}`;
            toolMap.set(qualifiedName, { connection: conn, mcpToolName: tool.name });
            tools.push({
              type: 'function',
              function: {
                name: qualifiedName,
                description: tool.description || '',
                parameters: (tool.inputSchema as Record<string, unknown>) || { type: 'object', properties: {} },
              },
            });
          }
          log(`MCP ${name}: ${toolList.tools.length} tools`);
        } catch (err) {
          log(`MCP ${name} failed to connect: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Add built-in tools
      tools.push(
        {
          type: 'function',
          function: {
            name: 'bash',
            description: 'Execute a bash command and return its output.',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'string', description: 'The command to execute' },
              },
              required: ['command'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read the contents of a file.',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Absolute path to the file' },
              },
              required: ['path'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'write_file',
            description: 'Write content to a file (creates or overwrites).',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Absolute path to the file' },
                content: { type: 'string', description: 'Content to write' },
              },
              required: ['path', 'content'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'edit_file',
            description: 'Replace a string in a file. old_string must match exactly.',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Absolute path to the file' },
                old_string: { type: 'string', description: 'Text to find' },
                new_string: { type: 'string', description: 'Replacement text' },
              },
              required: ['path', 'old_string', 'new_string'],
            },
          },
        },
      );

      log(`Total tools: ${tools.length} (${mcpConnections.length} MCP servers)`);

      const promptText = await this.extractPrompt(config.prompt);

      let messages: ChatMessage[] = [];
      if (config.systemPrompt?.append) {
        messages.push({ role: 'system', content: config.systemPrompt.append });
      }
      messages.push({ role: 'user', content: promptText });

      // Tool calling loop
      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const response = await this.callProxy(proxyUrl, model, messages, tools);

        if (!response) {
          yield { type: 'result', subtype: 'error_system', result: 'Codex proxy returned no response.' };
          return;
        }

        const choice = response.choices?.[0];
        if (!choice) {
          yield { type: 'result', subtype: 'error_system', result: 'Codex returned empty choices.' };
          return;
        }

        if (choice.finish_reason === 'tool_calls' && choice.message.tool_calls?.length) {
          messages.push(choice.message);

          for (const tc of choice.message.tool_calls) {
            log(`Tool call: ${tc.function.name}`);
            const result = await this.executeTool(tc, toolMap, config.cwd);
            messages.push({
              role: 'tool',
              content: result,
              tool_call_id: tc.id,
            });
          }

          if (response.usage && response.usage.prompt_tokens > compactThreshold) {
            log(`Compacting: ${response.usage.prompt_tokens} tokens > ${compactThreshold} threshold`);
            messages = this.compactMessages(messages);
          }
          continue;
        }

        // Final text response
        const content = choice.message.content;
        yield { type: 'result', subtype: 'success', result: content || '' };
        return;
      }

      yield { type: 'result', subtype: 'error_system', result: `Exceeded ${MAX_TOOL_ROUNDS} tool rounds.` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'result', subtype: 'error_system', result: `Codex backend error: ${msg}` };
    } finally {
      for (const conn of mcpConnections) {
        try { await conn.client.close(); } catch { /* ignore */ }
      }
    }
  }

  private compactMessages(messages: ChatMessage[]): ChatMessage[] {
    const keepTail = 6;
    if (messages.length <= 2 + keepTail) return messages;
    const head = messages.slice(0, 2);
    const tail = messages.slice(-keepTail);
    log(`Truncated ${messages.length - 2 - keepTail} messages from middle`);
    return [...head, { role: 'assistant', content: '[Earlier tool interactions truncated to save context]' }, ...tail];
  }

  private async connectMcp(
    name: string,
    config: McpServerConfig,
    parentEnv: Record<string, string | undefined>,
  ): Promise<McpConnection> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(parentEnv)) {
      if (v !== undefined) env[k] = v;
    }
    if (config.env) {
      Object.assign(env, config.env);
    }

    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env,
    });

    const client = new Client({ name: `codex-${name}`, version: '1.0.0' });
    await client.connect(transport);

    return { client, transport, serverName: name };
  }

  private async callProxy(
    proxyUrl: string,
    model: string,
    messages: ChatMessage[],
    tools: OpenAITool[],
  ): Promise<ChatCompletionResponse | null> {
    const body: Record<string, unknown> = { model, messages };
    if (tools.length > 0) {
      body.tools = tools;
    }

    const response = await fetch(`${proxyUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer codex' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const status = response.status;
      if (status === 429) {
        throw new Error('All Codex proxy accounts are rate-limited. Try again later.');
      }
      throw new Error(`Codex proxy error (${status}): ${errorBody}`);
    }

    return await response.json() as ChatCompletionResponse;
  }

  private async executeTool(
    tc: ToolCall,
    toolMap: Map<string, { connection: McpConnection; mcpToolName: string }>,
    cwd: string,
  ): Promise<string> {
    const name = tc.function.name;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      return `Error: invalid JSON arguments for ${name}`;
    }

    // Built-in tools
    if (name === 'bash') {
      return this.execBash(args.command as string, cwd);
    }
    if (name === 'read_file') {
      return this.execReadFile(args.path as string);
    }
    if (name === 'write_file') {
      return this.execWriteFile(args.path as string, args.content as string);
    }
    if (name === 'edit_file') {
      return this.execEditFile(args.path as string, args.old_string as string, args.new_string as string);
    }

    // MCP tools
    const mcpTool = toolMap.get(name);
    if (mcpTool) {
      try {
        const result = await mcpTool.connection.client.callTool({
          name: mcpTool.mcpToolName,
          arguments: args,
        });
        const texts = (result.content as Array<{ type: string; text?: string }>)
          .filter(c => c.type === 'text' && c.text)
          .map(c => c.text!);
        return texts.join('\n') || '(no output)';
      } catch (err) {
        return `MCP error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return `Unknown tool: ${name}`;
  }

  private execBash(command: string, cwd: string): Promise<string> {
    try {
      const output = execSync(command, {
        cwd,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return Promise.resolve(output || '(no output)');
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      const out = [e.stdout, e.stderr].filter(Boolean).join('\n');
      return Promise.resolve(out || `Exit code: ${e.status}`);
    }
  }

  private execReadFile(filePath: string): Promise<string> {
    try {
      return Promise.resolve(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      return Promise.resolve(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private execWriteFile(filePath: string, content: string): Promise<string> {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
      return Promise.resolve(`Written ${content.length} bytes to ${filePath}`);
    } catch (err) {
      return Promise.resolve(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private execEditFile(filePath: string, oldString: string, newString: string): Promise<string> {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (!content.includes(oldString)) {
        return Promise.resolve(`Error: old_string not found in ${filePath}`);
      }
      const updated = content.replace(oldString, newString);
      fs.writeFileSync(filePath, updated);
      return Promise.resolve(`Edited ${filePath}`);
    } catch (err) {
      return Promise.resolve(`Error: ${err instanceof Error ? err.message : String(err)}`);
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
