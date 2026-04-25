#!/usr/bin/env node
// MCP stdio server wrapping remote-message for Claude Code dev sessions.
// Tools: send_remote_message, list_agents

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { createInterface } from 'readline';

const NANOCLAW_DIR = process.env.NANOCLAW_DIR || join(process.env.HOME, 'nanoclaw');
const AGENTS_CONFIG = join(NANOCLAW_DIR, 'data/agents.json');

function loadConfig() {
  return JSON.parse(readFileSync(AGENTS_CONFIG, 'utf-8'));
}

// JSON-RPC helpers
function respond(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(`${msg}\n`);
}

function respondError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(`${msg}\n`);
}

function notify(method, params) {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  process.stdout.write(`${msg}\n`);
}

const TOOLS = [
  {
    name: 'send_remote_message',
    description: 'Send a message to another NanoClaw agent (local or remote via SSH). Delivery depends on target type: Service agents get one-way IPC injection (they must call send_agent_message back to reply). Dev agents get synchronous claude -c -p delivery — their response is returned inline as this tool\'s result, so do NOT call send_remote_message to reply, your output IS the reply.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Agent target ID (e.g. "nix:dev", "phone:telegram_main"). Use list_agents to see available targets.',
        },
        message: {
          type: 'string',
          description: 'The message content to send.',
        },
      },
      required: ['target', 'message'],
    },
  },
  {
    name: 'list_agents',
    description: 'List all known NanoClaw agents across instances with their type, host, and description.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

function handleSendMessage(args) {
  const { target, message } = args;
  try {
    const output = execSync(
      `bash "${join(NANOCLAW_DIR, 'scripts/remote-message')}" "${target}" ${JSON.stringify(message)}`,
      {
        env: { ...process.env, NANOCLAW_DIR },
        encoding: 'utf-8',
        timeout: 120000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    return { content: [{ type: 'text', text: output || `Message delivered to ${target}.` }] };
  } catch (err) {
    const stderr = err.stderr || '';
    const stdout = err.stdout || '';
    return {
      content: [{ type: 'text', text: `Error sending to ${target}: ${stderr || stdout || err.message}` }],
      isError: true,
    };
  }
}

function handleListAgents() {
  const config = loadConfig();
  const agents = config.agents || {};
  const self = config.self || 'unknown';
  const lines = [`Self: ${self}`, ''];
  for (const [id, a] of Object.entries(agents)) {
    lines.push(`${id}`);
    lines.push(`  Type: ${a.type} | Host: ${a.host} | Dir: ${a.nanoclaw_dir}`);
    if (a.description) lines.push(`  ${a.description}`);
    if (a.group) lines.push(`  Group: ${a.group}`);
    lines.push('');
  }
  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

// Main loop
const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = req;

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'remote-message', version: '1.1.0' },
      });
      notify('notifications/initialized', {});
      break;

    case 'tools/list':
      respond(id, { tools: TOOLS });
      break;

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments || {};
      let result;
      switch (toolName) {
        case 'send_remote_message':
          result = handleSendMessage(args);
          break;
        case 'list_agents':
          result = handleListAgents();
          break;
        default:
          respondError(id, -32601, `Unknown tool: ${toolName}`);
          return;
      }
      respond(id, result);
      break;
    }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      break;

    default:
      if (id !== undefined) {
        respondError(id, -32601, `Method not found: ${method}`);
      }
  }
});
