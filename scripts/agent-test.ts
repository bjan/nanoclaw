#!/usr/bin/env node
/**
 * Agent Quality Test Suite
 *
 * Spawns real agent-runner processes with test prompts and validates responses.
 * Tests tool use, file operations, system access, and reasoning.
 *
 * Usage:
 *   npx tsx scripts/agent-test.ts              # run all tests
 *   npx tsx scripts/agent-test.ts --filter bash # run tests matching "bash"
 *   npx tsx scripts/agent-test.ts --model glm   # test with a specific model
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// ── Test definitions ─────────────────────────────────────────────

interface TestCase {
  name: string;
  prompt: string;
  /** Validate the agent's text response. Return null if pass, error string if fail. */
  validate: (result: string) => string | null;
  /** Timeout in ms (default 120s) */
  timeout?: number;
}

const TESTS: TestCase[] = [
  {
    name: 'bash: basic command',
    prompt: 'Run `echo hello_from_agent` in bash and tell me the output. Reply with ONLY the output, nothing else.',
    validate: (r) => r.includes('hello_from_agent') ? null : `Expected "hello_from_agent" in response: ${r.slice(0, 200)}`,
  },
  {
    name: 'bash: system info',
    prompt: 'Run `uname -m` and tell me the architecture. Reply with just the architecture.',
    validate: (r) => r.includes('aarch64') ? null : `Expected "aarch64" in response: ${r.slice(0, 200)}`,
  },
  {
    name: 'file: write and read',
    prompt: 'Create a file called /data/data/com.termux/files/usr/tmp/nanoclaw-test-write.txt with the content "test_sentinel_42". Then read it back and confirm the content. Reply with the file content.',
    validate: (r) => {
      // Check both the response and the actual file
      const fileExists = fs.existsSync('/data/data/com.termux/files/usr/tmp/nanoclaw-test-write.txt');
      if (!fileExists) return 'File was not created at /data/data/com.termux/files/usr/tmp/nanoclaw-test-write.txt';
      const content = fs.readFileSync('/data/data/com.termux/files/usr/tmp/nanoclaw-test-write.txt', 'utf-8');
      if (!content.includes('test_sentinel_42')) return `File content wrong: ${content}`;
      return null;
    },
  },
  {
    name: 'file: read existing',
    prompt: 'Read the file /data/data/com.termux/files/usr/tmp/nanoclaw-test-read.txt and tell me its content. Reply with ONLY the content.',
    validate: (r) => r.includes('quality_test_input') ? null : `Expected "quality_test_input" in response: ${r.slice(0, 200)}`,
  },
  {
    name: 'glob: find files',
    prompt: 'Use glob to find all .ts files in src/channels/. List their filenames.',
    validate: (r) => r.includes('telegram') ? null : `Expected "telegram" in file listing: ${r.slice(0, 300)}`,
  },
  {
    name: 'grep: search code',
    prompt: 'Search for "MODEL_REGISTRY" in the codebase. Which file defines it? Reply with just the filename.',
    validate: (r) => r.includes('models.ts') ? null : `Expected "models.ts" in response: ${r.slice(0, 200)}`,
  },
  {
    name: 'multi-step: calculate',
    prompt: 'Create a file /data/data/com.termux/files/usr/tmp/nanoclaw-test-calc.txt with the number 7. Then read it, multiply the number by 6, and tell me the result.',
    validate: (r) => r.includes('42') ? null : `Expected "42" in response: ${r.slice(0, 200)}`,
  },
  {
    name: 'reasoning: summarize',
    prompt: 'Read src/models.ts and tell me how many local (non-Anthropic) models are configured. Reply with just the number.',
    validate: (r) => {
      const num = parseInt(r.replace(/\D/g, ''));
      return num >= 8 ? null : `Expected 8+ local models, got: ${r.slice(0, 200)}`;
    },
  },
];

// ── Runner ───────────────────────────────────────────────────────

interface ContainerInput {
  prompt: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  assistantName: string;
}

interface AgentResult {
  status: 'success' | 'error';
  result: string | null;
  error?: string;
}

async function runAgent(prompt: string, timeoutMs: number): Promise<AgentResult> {
  const testGroupDir = path.join(PROJECT_ROOT, 'groups', '_test');
  const testIpcDir = path.join(PROJECT_ROOT, 'data', 'ipc', '_test');
  const testSessionDir = path.join(PROJECT_ROOT, 'data', 'sessions', '_test');
  const testClaudeDir = path.join(testSessionDir, '.claude');

  // Ensure dirs
  for (const d of [testGroupDir, testIpcDir, path.join(testIpcDir, 'input'), testClaudeDir]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // Write minimal CLAUDE.md for test group
  const claudeMd = path.join(testGroupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) {
    fs.writeFileSync(claudeMd, '# Test Agent\nYou are a test agent. Be concise.\n');
  }

  // Symlink credentials
  const realCreds = path.join(process.env.HOME || '', '.claude', '.credentials.json');
  const testCreds = path.join(testClaudeDir, '.credentials.json');
  if (fs.existsSync(realCreds) && !fs.existsSync(testCreds)) {
    try { fs.symlinkSync(realCreds, testCreds); } catch { /* */ }
  }

  // Settings
  const settingsFile = path.join(testClaudeDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    },
  }, null, 2) + '\n');

  const entrypoint = path.join(PROJECT_ROOT, 'container', 'agent-runner', 'dist', 'index.js');
  const mcpServer = path.join(PROJECT_ROOT, 'container', 'agent-runner', 'dist', 'ipc-mcp-stdio.js');

  // Build env — inherit model override from CLI args
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: testSessionDir,
    CLAUDE_CONFIG_DIR: testClaudeDir,
    NANOCLAW_IPC_DIR: testIpcDir,
    NANOCLAW_GROUP_DIR: testGroupDir,
    NANOCLAW_GLOBAL_DIR: path.join(PROJECT_ROOT, 'groups', 'global'),
    NANOCLAW_EXTRA_DIR: path.join(testGroupDir, 'extra'),
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000',
  };

  // Apply model override if specified
  if (process.env.TEST_MODEL_BASE_URL) {
    env.ANTHROPIC_BASE_URL = process.env.TEST_MODEL_BASE_URL;
    env.ANTHROPIC_MODEL = process.env.TEST_MODEL_ID;
    env.ANTHROPIC_API_KEY = process.env.TEST_MODEL_API_KEY || 'dummy';
  }

  const input: ContainerInput = {
    prompt,
    groupFolder: '_test',
    chatJid: 'test:0',
    isMain: false,
    assistantName: 'TestAgent',
  };

  return new Promise((resolve) => {
    const proc = spawn('node', [entrypoint], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: testGroupDir,
      env,
    });

    // Write _close sentinel immediately so agent exits after first response
    setTimeout(() => {
      const closeFile = path.join(testIpcDir, 'input', '_close');
      try { fs.writeFileSync(closeFile, ''); } catch { /* */ }
    }, 2000);

    let stdout = '';
    let stderr = '';

    proc.stdin.write(JSON.stringify(input));
    proc.stdin.end();

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ status: 'error', result: null, error: `Timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    proc.on('close', () => {
      clearTimeout(timer);

      // Parse last output block
      const lastStart = stdout.lastIndexOf(OUTPUT_START_MARKER);
      const lastEnd = stdout.lastIndexOf(OUTPUT_END_MARKER);

      if (lastStart === -1 || lastEnd === -1 || lastEnd < lastStart) {
        // Check stderr for errors
        const errLine = stderr.split('\n').find(l => l.includes('error') || l.includes('Error'));
        resolve({
          status: 'error',
          result: null,
          error: errLine || 'No output markers found',
        });
        return;
      }

      const json = stdout.slice(lastStart + OUTPUT_START_MARKER.length, lastEnd).trim();
      try {
        resolve(JSON.parse(json));
      } catch {
        resolve({ status: 'error', result: null, error: `Failed to parse output: ${json.slice(0, 200)}` });
      }
    });
  });
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const filterIdx = args.indexOf('--filter');
  const filter = filterIdx !== -1 ? args[filterIdx + 1]?.toLowerCase() : null;
  const modelIdx = args.indexOf('--model');
  const modelAlias = modelIdx !== -1 ? args[modelIdx + 1] : null;

  // Resolve model if specified
  if (modelAlias) {
    // Dynamic import to get model registry
    const { MODEL_REGISTRY } = await import(path.join(PROJECT_ROOT, 'dist', 'models.js'));
    const config = MODEL_REGISTRY[modelAlias];
    if (!config) {
      console.error(`Unknown model: ${modelAlias}`);
      console.error(`Available: ${Object.keys(MODEL_REGISTRY).join(', ')}`);
      process.exit(1);
    }
    if (config.baseUrl) {
      process.env.TEST_MODEL_BASE_URL = config.baseUrl;
      process.env.TEST_MODEL_ID = config.id;
      process.env.TEST_MODEL_API_KEY = config.apiKey || '';
    }
    console.log(`\n  Model: ${config.label} (${modelAlias})\n`);
  } else {
    console.log(`\n  Model: default (OAuth)\n`);
  }

  // Setup: create test input file
  fs.writeFileSync('/data/data/com.termux/files/usr/tmp/nanoclaw-test-read.txt', 'quality_test_input');

  const tests = filter
    ? TESTS.filter(t => t.name.toLowerCase().includes(filter))
    : TESTS;

  let passed = 0;
  let failed = 0;

  interface TestResult {
    name: string;
    pass: boolean;
    time: number;
    prompt: string;
    response: string | null;
    error?: string;
  }
  const results: TestResult[] = [];

  for (const test of tests) {
    const start = Date.now();
    process.stdout.write(`  ${test.name} ... `);

    try {
      const result = await runAgent(test.prompt, test.timeout || 120_000);
      const elapsed = Date.now() - start;

      if (result.status === 'error') {
        console.log(`\x1b[31mERROR\x1b[0m (${(elapsed / 1000).toFixed(1)}s)`);
        console.log(`    ${result.error}`);
        failed++;
        results.push({ name: test.name, pass: false, time: elapsed, prompt: test.prompt, response: null, error: result.error });
        continue;
      }

      const text = result.result || '';
      const validation = test.validate(text);

      if (validation === null) {
        console.log(`\x1b[32mPASS\x1b[0m (${(elapsed / 1000).toFixed(1)}s)`);
        passed++;
        results.push({ name: test.name, pass: true, time: elapsed, prompt: test.prompt, response: text });
      } else {
        console.log(`\x1b[31mFAIL\x1b[0m (${(elapsed / 1000).toFixed(1)}s)`);
        console.log(`    ${validation}`);
        failed++;
        results.push({ name: test.name, pass: false, time: elapsed, prompt: test.prompt, response: text, error: validation });
      }
    } catch (err) {
      const elapsed = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`\x1b[31mERROR\x1b[0m (${(elapsed / 1000).toFixed(1)}s)`);
      console.log(`    ${msg}`);
      failed++;
      results.push({ name: test.name, pass: false, time: elapsed, prompt: test.prompt, response: null, error: msg });
    }
  }

  // Summary
  const totalTime = results.reduce((s, r) => s + r.time, 0);
  console.log(`\n  ${passed} passed, ${failed} failed, ${tests.length} total (${(totalTime / 1000).toFixed(1)}s)\n`);

  // Write log file
  const logsDir = path.join(PROJECT_ROOT, 'logs', 'agent-tests');
  fs.mkdirSync(logsDir, { recursive: true });
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const modelLabel = modelAlias || 'default';
  const logFile = path.join(logsDir, `${ts}_${modelLabel}.md`);

  const lines: string[] = [];
  lines.push(`# Agent Test Run — ${now.toLocaleString()}`);
  lines.push('');
  lines.push(`Model: **${modelAlias ? `${modelAlias}` : 'default (OAuth)'}**`);
  lines.push(`Result: ${passed}/${tests.length} passed (${(totalTime / 1000).toFixed(1)}s)`);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const r of results) {
    const status = r.pass ? 'PASS' : 'FAIL';
    lines.push(`## ${status}: ${r.name} (${(r.time / 1000).toFixed(1)}s)`);
    lines.push('');
    lines.push('**Prompt:**');
    lines.push(`> ${r.prompt}`);
    lines.push('');
    if (r.response !== null) {
      lines.push('**Response:**');
      lines.push('```');
      lines.push(r.response);
      lines.push('```');
    }
    if (r.error) {
      lines.push('');
      lines.push(`**Error:** ${r.error}`);
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  fs.writeFileSync(logFile, lines.join('\n'));
  console.log(`  Log: ${path.relative(PROJECT_ROOT, logFile)}\n`);

  // Cleanup
  try { fs.unlinkSync('/data/data/com.termux/files/usr/tmp/nanoclaw-test-write.txt'); } catch { /* */ }
  try { fs.unlinkSync('/data/data/com.termux/files/usr/tmp/nanoclaw-test-read.txt'); } catch { /* */ }
  try { fs.unlinkSync('/data/data/com.termux/files/usr/tmp/nanoclaw-test-calc.txt'); } catch { /* */ }

  process.exit(failed > 0 ? 1 : 0);
}

main();
