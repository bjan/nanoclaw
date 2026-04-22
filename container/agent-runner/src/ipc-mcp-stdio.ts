/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_chat_message',
  "Send a message to the user or group chat immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
    chat_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) Target a different chat. Defaults to the current chat.',
      ),
  },
  async (args) => {
    const targetJid = isMain && args.chat_jid ? args.chat_jid : chatJid;

    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid: targetJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_chat_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
    script: z
      .string()
      .optional()
      .describe(
        'Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
    script: z
      .string()
      .optional()
      .describe(
        'New script for the task. Set to empty string to remove the script.',
      ),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (
      args.schedule_type === 'cron' ||
      (!args.schedule_type && args.schedule_value)
    ) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid cron: "${args.schedule_value}".`,
              },
            ],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe(
        'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    requiresTrigger: z
      .boolean()
      .optional()
      .describe(
        'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger: args.requiresTrigger ?? false,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

server.tool(
  'screenshot',
  'Take a screenshot of the phone screen. Returns the file path to the saved image. Use the Read tool to view the image after capturing.',
  {
    output_path: z
      .string()
      .optional()
      .describe(
        'Where to save the screenshot. Defaults to ./screenshots/screenshot_<timestamp>.jpg',
      ),
  },
  async (args) => {
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '')
      .replace('T', '_')
      .slice(0, 15);
    const raw = `/data/local/tmp/screen_${timestamp}.png`;

    let outputPath: string;
    if (args.output_path) {
      outputPath = path.resolve(args.output_path);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    } else {
      const screenshotsDir = path.resolve('./screenshots');
      fs.mkdirSync(screenshotsDir, { recursive: true });
      outputPath = path.join(screenshotsDir, `screenshot_${timestamp}.jpg`);
    }

    try {
      // Capture via root screencap
      execFileSync('su', ['-c', `screencap -p ${raw}`], { timeout: 10000 });

      // Resize to 900px wide JPEG (fits Claude's image size limit)
      execFileSync(
        'ffmpeg',
        ['-y', '-i', raw, '-vf', 'scale=900:-1', outputPath, '-loglevel', 'error'],
        { timeout: 15000 },
      );

      // Clean up root-owned raw file
      try {
        execFileSync('su', ['-c', `rm -f ${raw}`], { timeout: 5000 });
      } catch {
        /* best effort */
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `Screenshot saved to ${outputPath}`,
          },
        ],
      };
    } catch (err) {
      // Clean up on failure
      try {
        execFileSync('su', ['-c', `rm -f ${raw}`], { timeout: 5000 });
      } catch {
        /* best effort */
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'read_pdf',
  'Extract text from a PDF file or URL. Use this when the user sends a PDF attachment, asks about a PDF file, or wants to read a PDF from a URL. Returns the extracted text content.',
  {
    source: z
      .string()
      .describe(
        'Path to a local PDF file, or a URL starting with http:// or https://',
      ),
    info_only: z
      .boolean()
      .optional()
      .describe(
        'If true, return only PDF metadata (page count, title, etc.) instead of full text',
      ),
  },
  async (args) => {
    const isUrl = /^https?:\/\//.test(args.source);

    try {
      if (args.info_only && !isUrl) {
        const output = execFileSync('pdfinfo', [args.source], {
          timeout: 30000,
          encoding: 'utf-8',
        });
        return {
          content: [{ type: 'text' as const, text: output }],
        };
      }

      let result: string;
      if (isUrl) {
        // Download to temp file, then extract
        const tmpDir = process.env.PREFIX
          ? `${process.env.PREFIX}/tmp`
          : '/tmp';
        const tmpFile = path.join(
          tmpDir,
          `pdf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.pdf`,
        );
        try {
          execFileSync('curl', ['-fsSL', '-o', tmpFile, args.source], {
            timeout: 30000,
          });
          result = execFileSync('pdftotext', ['-layout', tmpFile, '-'], {
            timeout: 30000,
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024,
          });
        } finally {
          try {
            fs.unlinkSync(tmpFile);
          } catch {
            /* best effort */
          }
        }
      } else {
        if (!fs.existsSync(args.source)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `File not found: ${args.source}`,
              },
            ],
            isError: true,
          };
        }
        result = execFileSync('pdftotext', ['-layout', args.source, '-'], {
          timeout: 30000,
          encoding: 'utf-8',
          maxBuffer: 10 * 1024 * 1024,
        });
      }

      if (!result.trim()) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'PDF appears to be image-based (scanned). No extractable text found. Try using the Read tool directly to view the PDF.',
            },
          ],
        };
      }

      // Truncate very long PDFs to avoid context overflow
      const MAX_CHARS = 100000;
      const truncated = result.length > MAX_CHARS;
      const text = truncated
        ? result.slice(0, MAX_CHARS) +
          `\n\n[Truncated — showing first ${MAX_CHARS} of ${result.length} characters]`
        : result;

      return {
        content: [{ type: 'text' as const, text }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `PDF read failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// --- Cross-instance agent communication ---

// Load agents config (relative to nanoclaw root, passed via env)
const NANOCLAW_ROOT =
  process.env.NANOCLAW_GLOBAL_DIR
    ? path.resolve(process.env.NANOCLAW_GLOBAL_DIR, '..', '..')
    : path.resolve('.');
const AGENTS_CONFIG_PATH = path.join(NANOCLAW_ROOT, 'data', 'agents.json');

interface AgentEntry {
  host: string;
  nanoclaw_dir: string;
  type: 'dev' | 'service';
  group?: string;
  description?: string;
}

function loadAgentsConfig(): { self: string; agents: Record<string, AgentEntry> } {
  try {
    const raw = JSON.parse(fs.readFileSync(AGENTS_CONFIG_PATH, 'utf-8'));
    return { self: raw.self || 'unknown', agents: raw.agents || {} };
  } catch {
    return { self: 'unknown', agents: {} };
  }
}

/**
 * Write a message file to a directory (local or remote via SSH).
 * Returns the filename written.
 */
function writeMessageFile(
  host: string,
  dir: string,
  data: object,
): string {
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const json = JSON.stringify(data, null, 2);

  if (host === 'localhost') {
    fs.mkdirSync(dir, { recursive: true });
    const filepath = path.join(dir, filename);
    const tempPath = `${filepath}.tmp`;
    fs.writeFileSync(tempPath, json);
    fs.renameSync(tempPath, filepath);
  } else {
    // Remote: use SSH to write
    const script = `mkdir -p '${dir}' && cat > '${dir}/${filename}.tmp' && mv '${dir}/${filename}.tmp' '${dir}/${filename}'`;
    execFileSync('ssh', [host, 'bash', '-c', `'${script}'`], {
      input: json,
      timeout: 15000,
    });
  }

  return filename;
}

server.tool(
  'send_agent_message',
  `Send a message to another NanoClaw agent (local or on a remote host).

Delivery depends on target type:
- Service agents: IPC injection (one-way). To get a reply, the service agent must call send_agent_message back.
- Dev agents: claude -c -p (synchronous). The dev agent's response is returned inline as this tool's result — do NOT call send_agent_message to reply, your output IS the reply.`,
  {
    target: z
      .string()
      .describe(
        'Target agent ID (e.g., "nix:dev", "nix:telegram_main", "phone:dev", "phone:telegram_main"). Use list_agents to see available targets.',
      ),
    message: z.string().describe('The message to send'),
  },
  async (args) => {
    const config = loadAgentsConfig();
    const agent = config.agents[args.target];
    // Sender identity: group folder for service agents, "dev@host" for dev agents
    const selfId = groupFolder === 'dev' ? `dev@${config.self}` : `${groupFolder}@${config.self}`;

    if (!agent) {
      const available = Object.keys(config.agents).join(', ');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Unknown agent "${args.target}". Available: ${available || 'none (check data/agents.json)'}`,
          },
        ],
        isError: true,
      };
    }

    try {
      if (agent.type === 'service' && agent.group) {
        // Service agent: write an 'inject' IPC message to the orchestrator.
        // The orchestrator pipes it into the active agent session if one is
        // running, or wakes up a new agent session if the agent is asleep.
        // We write to the target group's IPC messages/ dir (watched by the
        // orchestrator), NOT the input/ dir (only watched by a running agent).
        const messagesDir = path.join(
          agent.nanoclaw_dir,
          'data',
          'ipc',
          agent.group,
          'messages',
        );
        const ipcData = {
          type: 'inject',
          targetGroup: agent.group,
          text: `[From ${selfId}] ${args.message}`,
        };
        writeMessageFile(agent.host, messagesDir, ipcData);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Message delivered to ${args.target} (agent will wake if not active).`,
            },
          ],
        };
      } else {
        // Dev agent: send via claude -c -p (resumes most recent session)
        const prefix = `[From ${groupFolder}]`;
        const fullMessage = `${prefix} ${args.message}`;
        let response: string;

        if (agent.host === 'localhost') {
          response = execFileSync('bash', ['-c', `cd '${agent.nanoclaw_dir}' && claude -c -p '${fullMessage.replace(/'/g, "'\\''")}'`], {
            timeout: 300000,
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024,
          });
        } else {
          response = execFileSync('ssh', [
            '-o', 'ConnectTimeout=10',
            agent.host,
            `cd '${agent.nanoclaw_dir}' && claude -c -p '${fullMessage.replace(/'/g, "'\\''")}'`,
          ], {
            timeout: 300000,
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024,
          });
        }

        const trimmed = response.trim();
        return {
          content: [
            {
              type: 'text' as const,
              text: trimmed
                ? `Response from ${args.target}:\n\n${trimmed}`
                : `Message delivered to ${args.target} (no response).`,
            },
          ],
        };
      }
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to send to ${args.target}: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'list_agents',
  'List all known agents across all NanoClaw instances.',
  {},
  async () => {
    const agents = loadAgentsConfig().agents;
    const entries = Object.entries(agents);

    if (entries.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'No agents configured. Check data/agents.json.',
          },
        ],
      };
    }

    const lines = entries.map(
      ([id, a]) =>
        `• ${id} — ${a.description || a.type} [${a.host}:${a.nanoclaw_dir}]`,
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: `Known agents:\n${lines.join('\n')}`,
        },
      ],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
