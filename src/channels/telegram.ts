import { execSync, spawn } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';

import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  MODEL_REGISTRY,
  getGroupModel,
  setGroupModel,
  clearGroupModel,
} from '../models.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  onModelChange?: (chatJid: string) => void;
  onSessionClear?: (chatJid: string) => void;
  onCloseStdin?: (chatJid: string) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

// Dynamic MCP tool listing — queries MCP servers and caches the result
let cachedToolList: string | null = null;

function queryMcpTools(command: string, args: string[], env: Record<string, string> = {}): Promise<Array<{ name: string; description: string }>> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    let buffer = '';
    let resolved = false;

    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        logger.warn({ command, args: args[0], stderr: stderr.slice(0, 200) }, 'MCP tool query timed out');
        child.kill();
        resolve([]);
      }
    }, 10000);

    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString();
      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 1 && msg.result) {
            // Initialize response received — now send tools/list
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
          } else if (msg.id === 2 && msg.result?.tools) {
            // Got tools — resolve and clean up
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              resolve(msg.result.tools.map((t: any) => ({
                name: t.name,
                description: (t.description || '').split('\n')[0].slice(0, 80),
              })));
              try { child.stdin.end(); } catch {}
              child.kill();
            }
          }
        } catch {}
      }
    });

    // Send initialize
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tools-query', version: '0.1' } },
    }) + '\n');

    child.on('close', (code) => {
      clearTimeout(timer);
      if (!resolved) {
        logger.warn({ command, args: args[0], code, stderr: stderr.slice(0, 200) }, 'MCP tool query closed without result');
        resolved = true;
        resolve([]);
      }
    });
  });
}

async function getToolList(): Promise<string> {
  if (cachedToolList) return cachedToolList;

  const nanoclaw_dir = process.env.NANOCLAW_DIR || path.join(process.env.HOME || '', 'nanoclaw');
  const mcpServerPath = path.join(nanoclaw_dir, 'container/agent-runner/dist/ipc-mcp-stdio.js');
  const signetProxyPath = path.join(nanoclaw_dir, 'scripts/mcp/signet-filtered.mjs');

  const signetExists = fs.existsSync(signetProxyPath);
  logger.info({ mcpServerPath, signetProxyPath, signetExists }, 'Querying MCP tools');

  const [nanoclawTools, signetTools] = await Promise.all([
    queryMcpTools('node', [mcpServerPath], {
      NANOCLAW_CHAT_JID: 'tg:0',
      NANOCLAW_GROUP_FOLDER: '_query',
      NANOCLAW_IS_MAIN: '0',
    }),
    signetExists
      ? queryMcpTools('node', [signetProxyPath], {
          SIGNET_AGENT_ID: 'default',
          SIGNET_HOST: '127.0.0.1',
          SIGNET_PORT: '3850',
        })
      : Promise.resolve([]),
  ]);

  logger.info({ nanoclawCount: nanoclawTools.length, signetCount: signetTools.length }, 'MCP tools queried');

  // Format tool name + short description as a compact line
  const fmt = (t: { name: string; description: string }) => {
    // Truncate description to first sentence or 60 chars
    let desc = t.description.split(/\.\s/)[0];
    if (desc.length > 60) desc = desc.slice(0, 57) + '...';
    return `  \`${t.name}\` — ${desc}`;
  };

  const sections: string[] = [
    '*Built-in*',
    '  `Bash` `Read` `Write` `Edit` `Glob` `Grep`',
    '  `WebSearch` `WebFetch`',
    '  `Task` `TeamCreate` `SendMessage`',
  ];

  if (nanoclawTools.length > 0) {
    sections.push('', '*NanoClaw*');
    for (const t of nanoclawTools) sections.push(fmt(t));
  }

  if (signetTools.length > 0) {
    // Skip compatibility aliases and internal management tools
    const skip = new Set(['entity_list', 'entity_get', 'entity_aspects', 'entity_groups',
      'entity_claims', 'entity_attributes', 'mcp_server_list', 'mcp_server_search',
      'mcp_server_enable', 'mcp_server_disable', 'mcp_server_scope_get', 'mcp_server_scope_set',
      'mcp_server_policy_get', 'mcp_server_policy_set', 'mcp_server_call', 'session_bypass']);
    const filtered = signetTools.filter(t => !skip.has(t.name));

    const memoryTools = filtered.filter(t => t.name.startsWith('memory_'));
    const knowledgeTools = filtered.filter(t => t.name.startsWith('knowledge_') || t.name === 'lcm_expand');
    const otherTools = filtered.filter(t =>
      !t.name.startsWith('memory_') && !t.name.startsWith('knowledge_') && t.name !== 'lcm_expand'
    );

    if (memoryTools.length > 0) {
      sections.push('', '*Memory*');
      for (const t of memoryTools) sections.push(fmt(t));
    }
    if (knowledgeTools.length > 0) {
      sections.push('', '*Knowledge Graph*');
      for (const t of knowledgeTools) sections.push(fmt(t));
    }
    if (otherTools.length > 0) {
      sections.push('', '*Secrets & Other*');
      for (const t of otherTools) sections.push(fmt(t));
    }
  }

  const result = sections.join('\n');
  // Only cache if all MCP sources responded — don't cache partial results
  const signetExpected = fs.existsSync(signetProxyPath);
  if (!signetExpected || signetTools.length > 0) {
    cachedToolList = result;
  }
  return result;
}

// Bot pool for agent teams: send-only Api instances (no polling)
const poolApis: Api[] = [];
const senderBotMap = new Map<string, number>();
let nextPoolIndex = 0;

// Per-group transient settings (reset on restart)
const groupEffort = new Map<string, string>(); // folder → 'low' | 'medium' | 'high'
const groupPlanMode = new Set<string>(); // folders with plan mode active

export function getGroupEffort(folder: string): string | undefined {
  return groupEffort.get(folder);
}

export function isGroupPlanMode(folder: string): boolean {
  return groupPlanMode.has(folder);
}

export function clearGroupPlanMode(folder: string): void {
  groupPlanMode.delete(folder);
}

/**
 * Scan skills directories and return Telegram bot command entries.
 * Reads SKILL.md frontmatter for the description.
 */
function discoverSkillCommands(): { command: string; description: string }[] {
  const projectRoot = process.cwd();
  const skillDirs = [
    path.join(projectRoot, 'skills'),
  ];

  // Also scan all group skills directories
  const groupsDir = path.join(projectRoot, 'groups');
  if (fs.existsSync(groupsDir)) {
    for (const folder of fs.readdirSync(groupsDir)) {
      const groupSkills = path.join(groupsDir, folder, 'skills');
      if (fs.existsSync(groupSkills)) skillDirs.push(groupSkills);
    }
  }

  const seen = new Map<string, string>(); // command → description
  for (const dir of skillDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const skillMd = path.join(dir, entry, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const content = fs.readFileSync(skillMd, 'utf-8');
      // Parse description from frontmatter
      const match = content.match(/^---\s*\n[\s\S]*?description:\s*(.+)\n[\s\S]*?---/m);
      const desc = match?.[1]?.trim() || `Run ${entry} skill`;
      // Telegram commands: 1-32 lowercase alphanumeric + underscores only
      const command = entry.replace(/-/g, '_').toLowerCase();
      if (/^[a-z0-9_]{1,32}$/.test(command)) {
        seen.set(command, desc.slice(0, 256));
      }
    }
  }

  return [...seen.entries()].map(([command, description]) => ({ command, description }));
}

export async function initBotPool(tokens: string[]): Promise<void> {
  for (const token of tokens) {
    try {
      const api = new Api(token);
      const me = await api.getMe();
      poolApis.push(api);
      logger.info(
        { username: me.username, id: me.id, poolSize: poolApis.length },
        'Pool bot initialized',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to initialize pool bot');
    }
  }
  if (poolApis.length > 0) {
    logger.info({ count: poolApis.length }, 'Telegram bot pool ready');
  }
}

export async function sendPoolMessage(
  chatId: string,
  text: string,
  sender: string,
  groupFolder: string,
): Promise<void> {
  if (poolApis.length === 0) {
    // No pool bots — fall back to main bot send
    return;
  }

  const key = `${groupFolder}:${sender}`;
  let idx = senderBotMap.get(key);
  if (idx === undefined) {
    idx = nextPoolIndex % poolApis.length;
    nextPoolIndex++;
    senderBotMap.set(key, idx);
    try {
      await poolApis[idx].setMyName(sender);
      await new Promise((r) => setTimeout(r, 2000));
      logger.info({ sender, groupFolder, poolIndex: idx }, 'Assigned and renamed pool bot');
    } catch (err) {
      logger.warn({ sender, err }, 'Failed to rename pool bot (sending anyway)');
    }
  }

  const api = poolApis[idx];
  try {
    const numericId = chatId.replace(/^tg:/, '');
    await sendTelegramMessage({ sendMessage: api.sendMessage.bind(api) }, numericId, text);
    logger.info({ chatId, sender, poolIndex: idx, length: text.length }, 'Pool message sent');
  } catch (err) {
    logger.error({ chatId, sender, err }, 'Failed to send pool message');
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /**
   * Download a Telegram file to the group's attachments directory.
   * Returns the container-relative path (e.g. /workspace/group/attachments/photo_123.jpg)
   * or null if the download fails.
   */
  private async downloadFile(
    fileId: string,
    groupFolder: string,
    filename: string,
  ): Promise<string | null> {
    if (!this.bot) return null;

    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) {
        logger.warn({ fileId }, 'Telegram getFile returned no file_path');
        return null;
      }

      const groupDir = resolveGroupFolderPath(groupFolder);
      const attachDir = path.join(groupDir, 'attachments');
      fs.mkdirSync(attachDir, { recursive: true });

      // Sanitize filename and add extension from Telegram's file_path if missing
      const tgExt = path.extname(file.file_path);
      const localExt = path.extname(filename);
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalName = localExt ? safeName : `${safeName}${tgExt}`;
      const destPath = path.join(attachDir, finalName);

      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const resp = await fetch(fileUrl);
      if (!resp.ok) {
        logger.warn({ fileId, status: resp.status }, 'Telegram file download failed');
        return null;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(destPath, buffer);

      logger.info({ fileId, dest: destPath }, 'Telegram file downloaded');
      return `/workspace/group/attachments/${finalName}`;
    } catch (err) {
      logger.error({ fileId, err }, 'Failed to download Telegram file');
      return null;
    }
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Command to switch model
    this.bot.command('model', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const groups = this.opts.registeredGroups();
      const group = groups[chatJid];
      if (!group) {
        ctx.reply('This chat is not registered.');
        return;
      }

      const arg = ctx.message?.text?.split(/\s+/).slice(1).join(' ').trim();

      if (!arg) {
        // Show current model and list available
        const current = getGroupModel(group.folder);
        const models = Object.entries(MODEL_REGISTRY)
          .map(([alias, cfg]) => `  \`${alias}\` — ${cfg.label}`)
          .join('\n');
        const status = current
          ? `Current: \`${current}\` (${MODEL_REGISTRY[current]?.label || 'unknown'})`
          : 'Current: default (Claude via OAuth)';
        ctx.reply(`${status}\n\nAvailable models:\n${models}\n\nUsage: \`/model <name>\` or \`/model default\``, {
          parse_mode: 'Markdown',
        });
        return;
      }

      if (arg === 'default' || arg === 'reset') {
        clearGroupModel(group.folder);
        this.opts.onModelChange?.(chatJid);
        ctx.reply('Model reset to default (Claude via OAuth).');
        return;
      }

      if (!MODEL_REGISTRY[arg]) {
        const available = Object.keys(MODEL_REGISTRY).join(', ');
        ctx.reply(`Unknown model \`${arg}\`.\nAvailable: ${available}`, {
          parse_mode: 'Markdown',
        });
        return;
      }

      setGroupModel(group.folder, arg);
      this.opts.onModelChange?.(chatJid);
      ctx.reply(`Model switched to *${MODEL_REGISTRY[arg].label}* (\`${arg}\`)`, {
        parse_mode: 'Markdown',
      });
    });

    this.bot.command('new', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const groups = this.opts.registeredGroups();
      const group = groups[chatJid];
      if (!group) {
        ctx.reply('This chat is not registered.');
        return;
      }
      this.opts.onSessionClear?.(chatJid);
      ctx.reply('Session cleared. Next message starts a fresh conversation.');
    });

    this.bot.command('effort', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const groups = this.opts.registeredGroups();
      const group = groups[chatJid];
      if (!group) {
        ctx.reply('This chat is not registered.');
        return;
      }
      const arg = ctx.message?.text?.split(/\s+/)[1]?.toLowerCase();
      const valid = ['low', 'medium', 'high'];
      if (!arg || !valid.includes(arg)) {
        const current = groupEffort.get(group.folder) || 'default';
        ctx.reply(
          `Current effort: \`${current}\`\nUsage: \`/effort low|medium|high\``,
          { parse_mode: 'Markdown' },
        );
        return;
      }
      groupEffort.set(group.folder, arg);
      ctx.reply(`Effort set to *${arg}*.`, { parse_mode: 'Markdown' });
    });

    this.bot.command('plan', (ctx) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const groups = this.opts.registeredGroups();
      const group = groups[chatJid];
      if (!group) {
        ctx.reply('This chat is not registered.');
        return;
      }
      if (groupPlanMode.has(group.folder)) {
        groupPlanMode.delete(group.folder);
        ctx.reply('Plan mode *off*. Agent will execute normally.', {
          parse_mode: 'Markdown',
        });
      } else {
        groupPlanMode.add(group.folder);
        ctx.reply(
          'Plan mode *on*. Agent will plan before executing. Send `/plan` again to turn off.',
          { parse_mode: 'Markdown' },
        );
      }
    });

    this.bot.command('skills', (ctx) => {
      const skills = discoverSkillCommands();

      const builtinLines = [
        '/model - Switch AI model',
        '/new - Clear session, start fresh',
        '/compact - Compact conversation context',
        '/effort - Set reasoning effort (low/medium/high)',
        '/plan - Toggle plan-before-execute mode',
        '/skills - List available commands and skills',
        '/tools - List available agent tools',
        '/tg_swarm - Launch agent team in swarm group',
        '/background_swarm - Launch agent team silently',
      ];
      const skillLines = skills.map((s) => {
        // Truncate long descriptions for readability
        const desc = s.description.length > 60
          ? s.description.slice(0, 57) + '...'
          : s.description;
        return `/${s.command} - ${desc}`;
      });
      const sections = ['Built-in Commands:', ...builtinLines];
      if (skillLines.length > 0) {
        sections.push('', 'Skills:', ...skillLines);
      }
      ctx.reply(sections.join('\n'));
    });

    this.bot.command('tools', async (ctx) => {
      try {
        const toolList = await getToolList();
        const chatId = ctx.chat.id;
        // Split if over Telegram's 4096 char limit
        const MAX = 4096;
        if (toolList.length <= MAX) {
          await sendTelegramMessage(this.bot!.api, chatId, toolList);
        } else {
          const chunks: string[] = [];
          let current = '';
          for (const line of toolList.split('\n')) {
            if (current.length + line.length + 1 > MAX) {
              chunks.push(current);
              current = line;
            } else {
              current += (current ? '\n' : '') + line;
            }
          }
          if (current) chunks.push(current);
          for (const chunk of chunks) {
            await sendTelegramMessage(this.bot!.api, chatId, chunk);
          }
        }
      } catch (err) {
        logger.error({ err }, 'Failed to query tool list');
        ctx.reply('Failed to load tool list. Try again later.');
      }
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set([
      'chatid', 'ping', 'model', 'new', 'effort', 'plan', 'skills', 'tools',
    ]);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;

      // Telegram commands use underscores, but CLAUDE.md uses hyphens.
      // Convert /tg_swarm → /tg-swarm, /background_swarm → /background-swarm
      if (content.startsWith('/tg_swarm'))
        content = content.replace('/tg_swarm', '/tg-swarm');
      if (content.startsWith('/background_swarm'))
        content = content.replace('/background_swarm', '/background-swarm');
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;

      const replyTo = ctx.message.reply_to_message;
      const replyToMessageId = replyTo?.message_id?.toString();
      const replyToContent = replyTo?.text || replyTo?.caption;
      const replyToSenderName = replyTo
        ? replyTo.from?.first_name ||
          replyTo.from?.username ||
          replyTo.from?.id?.toString() ||
          'Unknown'
        : undefined;

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId ? threadId.toString() : undefined,
        reply_to_message_id: replyToMessageId,
        reply_to_message_content: replyToContent,
        reply_to_sender_name: replyToSenderName,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages: download files when possible, fall back to placeholders.
    const storeMedia = (
      ctx: any,
      placeholder: string,
      opts?: { fileId?: string; filename?: string },
    ) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      const deliver = (content: string) => {
        this.opts.onMessage(chatJid, {
          id: ctx.message.message_id.toString(),
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });
      };

      // If we have a file_id, attempt to download; deliver asynchronously
      if (opts?.fileId) {
        const msgId = ctx.message.message_id.toString();
        const filename =
          opts.filename ||
          `${placeholder.replace(/[\[\] ]/g, '').toLowerCase()}_${msgId}`;
        this.downloadFile(opts.fileId, group.folder, filename).then(
          (filePath) => {
            if (filePath) {
              deliver(`${placeholder} (${filePath})${caption}`);
            } else {
              deliver(`${placeholder}${caption}`);
            }
          },
        );
        return;
      }

      deliver(`${placeholder}${caption}`);
    };

    this.bot.on('message:photo', (ctx) => {
      // Telegram sends multiple sizes; last is largest
      const photos = ctx.message.photo;
      const largest = photos?.[photos.length - 1];
      storeMedia(ctx, '[Photo]', {
        fileId: largest?.file_id,
        filename: `photo_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:video', (ctx) => {
      storeMedia(ctx, '[Video]', {
        fileId: ctx.message.video?.file_id,
        filename: `video_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:voice', (ctx) => {
      storeMedia(ctx, '[Voice message]', {
        fileId: ctx.message.voice?.file_id,
        filename: `voice_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:audio', (ctx) => {
      const name =
        ctx.message.audio?.file_name || `audio_${ctx.message.message_id}`;
      storeMedia(ctx, '[Audio]', {
        fileId: ctx.message.audio?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      storeMedia(ctx, `[Document: ${name}]`, {
        fileId: ctx.message.document?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeMedia(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeMedia(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeMedia(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: async (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );

          // Register slash commands with Telegram for autocomplete menu
          try {
            const builtinCommands = [
              { command: 'model', description: 'Switch AI model' },
              { command: 'new', description: 'Clear session, start fresh' },
              { command: 'compact', description: 'Compact conversation context' },
              { command: 'effort', description: 'Set reasoning effort (low/medium/high)' },
              { command: 'plan', description: 'Toggle plan-before-execute mode' },
              { command: 'skills', description: 'List available commands and skills' },
              { command: 'tools', description: 'List available agent tools' },
              { command: 'tg_swarm', description: 'Launch agent team with live output in swarm group' },
              { command: 'background_swarm', description: 'Launch agent team silently, report results here' },
              { command: 'chatid', description: 'Show this chat\'s registration ID' },
              { command: 'ping', description: 'Check if bot is online' },
            ];
            const skillCommands = discoverSkillCommands();
            const allCommands = [...builtinCommands, ...skillCommands];
            await this.bot!.api.setMyCommands(allCommands);
            logger.info(
              { count: allCommands.length, skills: skillCommands.length },
              'Telegram commands registered',
            );
          } catch (err) {
            logger.warn({ err }, 'Failed to register Telegram commands');
          }

          resolve();
        },
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    threadId?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const options = threadId
        ? { message_thread_id: parseInt(threadId, 10) }
        : {};

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text, options);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            options,
          );
        }
      }
      logger.info(
        { jid, length: text.length, threadId },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
