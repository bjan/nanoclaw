/**
 * Container Runner for NanoClaw
 * Spawns agent execution natively (no container) and handles IPC
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  ONECLI_API_KEY,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { resolveGroupModelConfig } from './models.js';
import { getGroupEffort, isGroupPlanMode, clearGroupPlanMode } from './channels/telegram.js';
import { OneCLI } from '@onecli-sh/sdk';
import { RegisteredGroup } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY });

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

/**
 * Prepare the group's session directory, IPC dirs, and agent-runner build.
 * Returns the environment variables and paths needed to spawn the agent natively.
 */
function prepareAgentEnvironment(
  group: RegisteredGroup,
  isMain: boolean,
): { env: Record<string, string | undefined>; cwd: string; entrypoint: string } {
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(group.folder);
  const globalDir = path.join(GROUPS_DIR, 'global');
  const groupIpcDir = resolveGroupIpcPath(group.folder);

  // Ensure directories exist
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

  // Per-group Claude sessions directory
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    group.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  // Symlink real OAuth credentials into per-group config dir so the SDK can authenticate
  const realCredentials = path.join(process.env.HOME || '', '.claude', '.credentials.json');
  const groupCredentials = path.join(groupSessionsDir, '.credentials.json');
  if (fs.existsSync(realCredentials) && !fs.existsSync(groupCredentials)) {
    try {
      fs.symlinkSync(realCredentials, groupCredentials);
    } catch {
      // If symlink fails (e.g. already exists as file), copy instead
      try { fs.copyFileSync(realCredentials, groupCredentials); } catch { /* ignore */ }
    }
  }

  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  // Always rewrite settings to keep model preference in sync
  const settingsObj: Record<string, unknown> = {
    env: {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    },
  };
  // Apply Anthropic model preference (non-baseUrl models use settings, not env override)
  const groupModelConfig = resolveGroupModelConfig(group.folder);
  if (groupModelConfig && !groupModelConfig.baseUrl) {
    settingsObj.model = groupModelConfig.id;
  }
  fs.writeFileSync(settingsFile, JSON.stringify(settingsObj, null, 2) + '\n');

  // Sync skills into each group's .claude/skills/ from three sources.
  // Later sources override earlier ones (per-group wins over global).
  const skillsDst = path.join(groupSessionsDir, 'skills');
  const skillSources = [
    path.join(projectRoot, 'skills'),               // global
    path.join(groupDir, 'skills'),                   // per-group
  ];
  for (const skillsSrc of skillSources) {
    if (!fs.existsSync(skillsSrc)) continue;
    for (const entry of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, entry);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, entry);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  // Build the agent-runner if needed
  const agentRunnerDir = path.join(projectRoot, 'container', 'agent-runner');
  const agentRunnerDist = path.join(agentRunnerDir, 'dist');
  const entrypoint = path.join(agentRunnerDist, 'index.js');

  // Extra mount dirs (if any)
  const extraDir = path.join(groupDir, 'extra');

  // Build env for the native agent process
  const env: Record<string, string | undefined> = {
    ...process.env,
    TZ: TIMEZONE,
    HOME: groupSessionsDir.replace(/\/.claude$/, ''),
    CLAUDE_CONFIG_DIR: groupSessionsDir,
    NANOCLAW_IPC_DIR: groupIpcDir,
    NANOCLAW_GROUP_DIR: groupDir,
    NANOCLAW_GLOBAL_DIR: globalDir,
    NANOCLAW_EXTRA_DIR: extraDir,
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: '165000',
  };

  return { env, cwd: groupDir, entrypoint };
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const { env: agentEnv, cwd, entrypoint } = prepareAgentEnvironment(group, input.isMain);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;

  // Inject IPC env vars for the MCP server
  agentEnv.NANOCLAW_CHAT_JID = input.chatJid;
  agentEnv.NANOCLAW_GROUP_FOLDER = input.groupFolder;
  agentEnv.NANOCLAW_IS_MAIN = input.isMain ? '1' : '0';

  // Apply OneCLI credentials to env via getContainerConfig
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');
  try {
    const config = await onecli.getContainerConfig(agentIdentifier);
    if (config?.env) {
      Object.assign(agentEnv, config.env);
      // Write CA cert to a temp file if provided
      if (config.caCertificate) {
        const certPath = path.join(DATA_DIR, 'sessions', group.folder, 'onecli-ca.pem');
        fs.writeFileSync(certPath, config.caCertificate);
        agentEnv.NODE_EXTRA_CA_CERTS = certPath;
      }
      logger.info({ containerName }, 'OneCLI credentials applied to env');
    }
  } catch {
    logger.warn(
      { containerName },
      'OneCLI gateway not reachable — agent will have no credentials',
    );
  }

  // Apply per-group model override (set via /model command)
  // Only override env vars for non-Anthropic models (those with a custom baseUrl).
  // For Anthropic models, let the SDK use its default OAuth flow and model selection.
  const modelConfig = resolveGroupModelConfig(group.folder);
  if (modelConfig?.baseUrl) {
    agentEnv.ANTHROPIC_BASE_URL = modelConfig.baseUrl;
    agentEnv.ANTHROPIC_MODEL = modelConfig.id;
    if (modelConfig.apiKey) {
      agentEnv.ANTHROPIC_API_KEY = modelConfig.apiKey;
    }
    logger.info(
      { containerName, model: modelConfig.id, baseUrl: modelConfig.baseUrl },
      'Model override applied (custom endpoint)',
    );
  }

  // Apply per-group effort level (set via /effort Telegram command)
  const effort = getGroupEffort(group.folder);
  if (effort) {
    agentEnv.NANOCLAW_EFFORT = effort;
  }

  // Apply plan mode prefix (set via /plan Telegram command)
  if (isGroupPlanMode(group.folder)) {
    input.prompt = `[PLAN MODE] Think step by step. Present a detailed plan before executing anything. Explain what you will do and why, then ask for confirmation before proceeding.\n\n${input.prompt}`;
    clearGroupPlanMode(group.folder);
  }

  logger.info(
    {
      group: group.name,
      containerName,
      isMain: input.isMain,
      entrypoint,
      cwd,
      effort: effort || 'default',
    },
    'Spawning native agent',
  );

  const logsDir = path.join(resolveGroupFolderPath(group.folder), 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn('node', [entrypoint], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env: agentEnv,
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the hard timeout
            resetTimeout();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Agent timeout, stopping gracefully',
      );
      container.kill('SIGTERM');
      // Force kill after 5s if SIGTERM doesn't work
      setTimeout(() => {
        if (!container.killed) {
          container.kill('SIGKILL');
        }
      }, 5000);
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // Reset the timeout whenever there's activity (streaming output)
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // Timeout after output = idle cleanup, not failure.
        // The agent already sent its response; this is just the
        // container being reaped after the idle period expired.
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Entrypoint ===`,
          entrypoint,
          ``,
          `=== Working Directory ===`,
          cwd,
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line (backwards compatibility)
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // Write filtered tasks to the group's IPC directory
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all tasks, others only see their own
  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * Write available groups snapshot for the container to read.
 * Only main group can see all available groups (for activation).
 * Non-main groups only see their own registration status.
 */
export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // Main sees all groups; others see nothing (they can't activate groups)
  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
