#!/usr/bin/env node
// Thin proxy around signet-mcp that filters out agent messaging tools.
// - Removes agent_peers, agent_message_send, agent_message_inbox from tools/list
// - Rejects tools/call for those tools before they reach signet

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { join } from 'path';

const BLOCKED_TOOLS = new Set([
  'agent_peers',
  'agent_message_send',
  'agent_message_inbox',
]);

const HOME = process.env.NANOCLAW_HOST_HOME || process.env.HOME || '/data/data/com.termux/files/home';
const signetDist = process.env.SIGNET_DIST || join(HOME, 'signetai/packages/signetai/dist');
const signetPath = join(signetDist, 'mcp-stdio.js');

const bunPath = join(HOME, '.bun/bin/bun');
const child = spawn(bunPath, [signetPath], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});

// Intercept stdin: block tools/call for blocked tools, forward everything else
const stdinRl = createInterface({ input: process.stdin, terminal: false });

stdinRl.on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    child.stdin.write(line + '\n');
    return;
  }

  if (req.method === 'tools/call' && BLOCKED_TOOLS.has(req.params?.name)) {
    const err = JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32601, message: `Tool "${req.params.name}" is not available.` },
    });
    process.stdout.write(err + '\n');
    return;
  }

  child.stdin.write(line + '\n');
});

stdinRl.on('close', () => {
  child.stdin.end();
});

// Intercept child stdout: filter blocked tools from tools/list responses
const childRl = createInterface({ input: child.stdout, terminal: false });

childRl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stdout.write(line + '\n');
    return;
  }

  if (msg.result?.tools && Array.isArray(msg.result.tools)) {
    msg.result.tools = msg.result.tools.filter((t) => !BLOCKED_TOOLS.has(t.name));
    process.stdout.write(JSON.stringify(msg) + '\n');
    return;
  }

  process.stdout.write(line + '\n');
});

child.on('exit', (code) => {
  process.exit(code || 0);
});

process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
