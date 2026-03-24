import crypto from "node:crypto";
import { sendMessage, sendTyping } from "./api.js";
import type { BotCredentials, WeixinMessage } from "./types.js";
import { MessageItemType, MessageState, MessageType, TypingStatus } from "./types.js";
import { getProgressMonitor } from "./progress.js";

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

const userSessions = new Map<string, string>();

async function getOrCreateSession(userId: string, config: OpenCodeConfig): Promise<string> {
  const existing = userSessions.get(userId);
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

  const res = await fetch(`${config.serverUrl}/session/${sessionId}/message`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      parts: [{ type: "text", text }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenCode API error ${res.status}: ${err}`);
  }

  const data = await res.json() as Record<string, unknown>;
  console.log(`[handler] OpenCode raw response: ${JSON.stringify(data).slice(0, 2000)}`);

  const parts = (data.parts ?? []) as Array<Record<string, unknown>>;
  const textParts: string[] = [];
  for (const part of parts) {
    const pType = part.type as string;
    if (pType === "text" && part.text) {
      textParts.push(String(part.text));
    } else {
      console.log(`[handler] skipped part type=${pType} keys=${Object.keys(part).join(",")}`);
      if (part.content) textParts.push(String(part.content));
      if (part.output) textParts.push(String(part.output));
      if (part.result) textParts.push(String(part.result));
      if (part.text) textParts.push(String(part.text));
    }
  }

  return textParts.join("\n") || "(empty response)";
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
  const chunks = splitMessage(plainText, 4000);

  for (const chunk of chunks) {
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
