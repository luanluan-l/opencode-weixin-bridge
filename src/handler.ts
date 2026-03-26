import crypto from "node:crypto";
import { sendMessage, sendTyping } from "./api.js";
import type { BotCredentials, WeixinMessage } from "./types.js";
import { MessageItemType, MessageState, MessageType, TypingStatus } from "./types.js";
import { getProgressMonitor } from "./progress.js";
import { restartOpenCodeServer } from "./index.js";
import path from "node:path";
import fs from "node:fs";

function generateClientId(): string {
  return `oc-${crypto.randomBytes(8).toString("hex")}`;
}

function stripMarkdown(text: string): string {
  let r = text;
  r = r.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  r = r.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  r = r.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  r = r.replace(/^\|[\s:|-]+\|$/gm, "");
  r = r.replace(/^\|(.+)\|$/gm, (_, inner: string) =>
    inner.split("|").map((c) => c.trim()).join("  "),
  );
  r = r.replace(/#{1,6}\s+/g, "");
  r = r.replace(/\*\*(.+?)\*\*/g, "$1");
  r = r.replace(/__(.+?)__/g, "$1");
  r = r.replace(/`([^`]+)`/g, "$1");
  return r;
}

function extractText(msg: WeixinMessage): string {
  if (!msg.item_list?.length) return "";
  for (const item of msg.item_list) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item?.text_item?.text) parts.push(ref.message_item.text_item.text);
      if (!parts.length) return text;
      return `[引用: ${parts.join(" | ")}]\n${text}`;
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "(media message)";
}

export interface OpenCodeConfig {
  serverUrl: string;
  password?: string;
}

export const userSessions = new Map<string, string>();

async function getOrCreateSession(userId: string, config: OpenCodeConfig): Promise<string> {
  const existing = userSessions.get(userId);
  console.log(`[handler] getOrCreateSession: userId=${userId}, existing=${existing || "none"}, total sessions=${userSessions.size}`);
  if (existing) return existing;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.password) {
    headers.Authorization = `Basic ${Buffer.from(`opencode:${config.password}`).toString("base64")}`;
  }

  const res = await fetch(`${config.serverUrl}/session`, {
    method: "POST",
    headers,
    body: JSON.stringify({ title: `WeChat:${userId.slice(0, 20)}` }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to create session: ${res.status} ${err}`);
  }

  const session = (await res.json()) as { id: string };
  userSessions.set(userId, session.id);
  console.log(`[handler] Created new session: ${userId} -> ${session.id}`);
  return session.id;
}

async function callOpenCode(
  sessionId: string,
  text: string,
  config: OpenCodeConfig,
): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.password) {
    headers.Authorization = `Basic ${Buffer.from(`opencode:${config.password}`).toString("base64")}`;
  }

  console.log(`[handler] Calling OpenCode API: ${config.serverUrl}/session/${sessionId}/message`);
  console.log(`[handler] Request text: ${text}`);

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    console.error(`[handler] OpenCode API timeout after 120 seconds`);
    abortController.abort();
  }, 120000);

  try {
    const res = await fetch(`${config.serverUrl}/session/${sessionId}/message`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        parts: [{ type: "text", text }],
      }),
      signal: abortController.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OpenCode API error ${res.status}: ${err}`);
    }

    const data = await res.json() as Record<string, unknown>;
    const info = data.info as { role?: string; parentID?: string } | undefined;
    console.log(`[handler] OpenCode response info: role=${info?.role}, parentID=${info?.parentID}`);

    const parts = (data.parts ?? []) as Array<Record<string, unknown>>;
    console.log(`[handler] OpenCode response has ${parts.length} parts`);
    const textParts: string[] = [];
    for (const part of parts) {
      const pType = part.type as string;
      console.log(`[handler] Part type: ${pType}, has text: ${!!part.text}, has content: ${!!part.content}`);

      switch (pType) {
        case "text":
          if (part.text) {
            textParts.push(String(part.text));
          }
          break;

        case "reasoning":
          console.log(`[handler] Skipping reasoning part content`);
          break;

        case "step-start":
        case "step-finish":
        case "tool":
        case "error":
          console.log(`[handler] Skipping ${pType} part`);
          break;

        default:
          if (part.content) {
            console.log(`[handler] Including content from part type ${pType}`);
            textParts.push(String(part.content));
          }
          if (part.output) {
            textParts.push(String(part.output));
          }
          if (part.result) {
            textParts.push(String(part.result));
          }
      }
    }

    const finalText = textParts.join("\n").trim();
    console.log(`[handler] Final reply (${textParts.length} text parts, ${finalText.length} chars): ${finalText.slice(0, 100)}...`);
    return finalText || "(empty response)";
  } catch (error: unknown) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`OpenCode API timeout (120s): ${text.slice(0, 50)}...`);
    }

    throw error;
  }
}

function isCommand(text: string): boolean {
  return text.trim().startsWith("/");
}

function extractProjectPath(text: string): string | null {
  const patterns = [
    /(?:切换|switch|change)[到到]?[项目project]*[:\s]*([~\.\-\w\/\\]+)/i,
    /(?:切换|switch|change)[到到]?[项目project]*[:\s]*['"]([^'"]+)['"]/i,
    /(?:帮我|请|帮我)[切换switch][到到]?[项目project]*[:\s]*([~\.\-\w\/\\]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      return match[1].trim();
    }
  }

  const pathMatch = text.match(/[~\.\-\w\/\\]+(?:\/|\\)[~\.\-\w\/\\]+|[~\/].+|\/[\w\/\-\.\~]+/);
  if (pathMatch) {
    return pathMatch[0].trim();
  }

  return null;
}

async function handleSwitchProject(
  text: string,
  fromUserId: string,
  creds: BotCredentials,
  ocConfig: OpenCodeConfig,
): Promise<boolean> {
  const projectPath = extractProjectPath(text);

  if (!projectPath) {
    await sendMessage({
      baseUrl: creds.baseUrl,
      token: creds.token,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: fromUserId,
          client_id: generateClientId(),
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text: "请提供项目路径，例如：\n切换到 /path/to/project\n或\n切换到 ~/Documents/my-project" } }],
        },
      },
    });
    return true;
  }

  let resolvedPath = projectPath;
  if (!path.isAbsolute(projectPath)) {
    resolvedPath = path.resolve(process.cwd(), projectPath);
  }

  if (!fs.existsSync(resolvedPath)) {
    await sendMessage({
      baseUrl: creds.baseUrl,
      token: creds.token,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: fromUserId,
          client_id: generateClientId(),
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text: `项目目录不存在: ${resolvedPath}` } }],
        },
      },
    });
    return true;
  }

  try {
    await sendTyping({
      baseUrl: creds.baseUrl,
      token: creds.token,
      body: {
        ilink_user_id: fromUserId,
        typing_ticket: "",
        status: TypingStatus.TYPING,
      },
    });

    const newPath = await restartOpenCodeServer(resolvedPath, ocConfig.serverUrl, ocConfig.password ?? "");

    await sendMessage({
      baseUrl: creds.baseUrl,
      token: creds.token,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: fromUserId,
          client_id: generateClientId(),
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text: `✓ 已切换到项目: ${newPath}\n✓ 所有用户会话已清空` } }],
        },
      },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await sendMessage({
      baseUrl: creds.baseUrl,
      token: creds.token,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: fromUserId,
          client_id: generateClientId(),
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text: `切换项目失败: ${errMsg}` } }],
        },
      },
    });
  }

  return true;
}

async function handleCommand(
  text: string,
  fromUserId: string,
  creds: BotCredentials,
  ocConfig: OpenCodeConfig,
): Promise<boolean> {
  const trimmed = text.trim();

  if (trimmed.startsWith("/switch ")) {
    return await handleSwitchProject(text, fromUserId, creds, ocConfig);
  }

  if (trimmed === "/help" || trimmed === "/?") {
    await sendMessage({
      baseUrl: creds.baseUrl,
      token: creds.token,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: fromUserId,
          client_id: generateClientId(),
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{
            type: MessageItemType.TEXT,
            text_item: {
              text: "可用指令:\n" +
              "/switch <路径> - 切换到指定项目目录\n" +
              "/help - 显示帮助信息\n\n" +
              "也可以用自然语言，例如：\n" +
              "切换到 /path/to/project\n" +
              "帮我切换到 ~/Documents/my-project"
            }
          }],
        },
      },
    });
    return true;
  }

  return false;
}

export async function handleIncomingMessage(
  msg: WeixinMessage,
  contextToken: string | undefined,
  creds: BotCredentials,
  ocConfig: OpenCodeConfig,
): Promise<void> {
  const fromUserId = msg.from_user_id ?? "";
  const text = extractText(msg);

  if (!text.trim()) return;

  if (isCommand(text)) {
    const handled = await handleCommand(text, fromUserId, creds, ocConfig);
    if (handled) return;
  }

  const switchPatterns = [
    /切换[到到]?[项目project]?/i,
    /switch\s*(to)?\s*project?/i,
    /change\s*(to)?\s*project?/i,
    /帮我[切换switch][到到]?[项目project]?/i,
  ];

  for (const pattern of switchPatterns) {
    if (pattern.test(text)) {
      const handled = await handleSwitchProject(text, fromUserId, creds, ocConfig);
      if (handled) return;
    }
  }

  try {
    await sendTyping({
      baseUrl: creds.baseUrl,
      token: creds.token,
      body: {
        ilink_user_id: fromUserId,
        typing_ticket: "",
        status: TypingStatus.TYPING,
      },
    });
  } catch {
    // typing indicator is optional
  }

  const sessionId = await getOrCreateSession(fromUserId, ocConfig);
  console.log(`[handler] -> OpenCode session=${sessionId}: ${text.slice(0, 60)}`);

  const progressMonitor = getProgressMonitor({
    serverUrl: ocConfig.serverUrl,
    password: ocConfig.password,
  });

  await progressMonitor.start(fromUserId, sessionId, creds);

  const reply = await callOpenCode(sessionId, text, ocConfig);

  progressMonitor.stop(fromUserId);

  const plainText = stripMarkdown(reply);
  console.log(`[handler] OpenCode reply length: ${plainText.length} chars, preview: ${plainText.slice(0, 100)}`);
  const chunks = splitMessage(plainText, 4000);
  console.log(`[handler] Sending ${chunks.length} chunk(s) to user ${fromUserId}`);

  for (const chunk of chunks) {
    console.log(`[handler] Sending chunk ${chunks.length > 1 ? `(${chunks.indexOf(chunk) + 1}/${chunks.length})` : ""}: ${chunk.slice(0, 50)}...`);
    await sendMessage({
      baseUrl: creds.baseUrl,
      token: creds.token,
      body: {
        msg: {
          from_user_id: "",
          to_user_id: fromUserId,
          client_id: generateClientId(),
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          item_list: [{ type: MessageItemType.TEXT, text_item: { text: chunk } }],
          context_token: contextToken ?? undefined,
        },
      },
    });
  }

  try {
    await sendTyping({
      baseUrl: creds.baseUrl,
      token: creds.token,
      body: {
        ilink_user_id: fromUserId,
        typing_ticket: "",
        status: TypingStatus.CANCEL,
      },
    });
  } catch {
    // ignore
  }
}

function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < limit * 0.5) splitAt = remaining.lastIndexOf("。", limit);
    if (splitAt < limit * 0.5) splitAt = remaining.lastIndexOf(".", limit);
    if (splitAt < limit * 0.5) splitAt = limit;
    else splitAt += 1;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}
