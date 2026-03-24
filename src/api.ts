import crypto from "node:crypto";
import type {
  BaseInfo,
  GetUpdatesReq,
  GetUpdatesResp,
  SendMessageReq,
  SendTypingReq,
  GetConfigResp,
} from "./types.js";

const CHANNEL_VERSION = "1.0.0";
const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;

function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION };
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function buildHeaders(opts: { token?: string; body: string }): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(opts.body, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (opts.token?.trim()) {
    headers.Authorization = `Bearer ${opts.token.trim()}`;
  }
  return headers;
}

async function apiFetch<T>(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
  label: string;
}): Promise<T> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const hdrs = buildHeaders({ token: params.token, body: params.body });

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: hdrs,
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(t);
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText}`);
    }
    return JSON.parse(rawText) as T;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

export async function getUpdates(
  params: GetUpdatesReq & {
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
  },
): Promise<GetUpdatesResp> {
  const baseUrl = params.baseUrl ?? DEFAULT_BASE_URL;
  const timeout = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    return await apiFetch<GetUpdatesResp>({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: params.get_updates_buf ?? "",
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: timeout,
      label: "getUpdates",
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
    }
    throw err;
  }
}

export async function sendMessage(
  params: {
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
  } & { body: SendMessageReq },
): Promise<void> {
  await apiFetch<Record<string, never>>({
    baseUrl: params.baseUrl ?? DEFAULT_BASE_URL,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: "sendMessage",
  });
}

export async function getConfig(
  params: {
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
    ilinkUserId: string;
    contextToken?: string;
  },
): Promise<GetConfigResp> {
  return await apiFetch<GetConfigResp>({
    baseUrl: params.baseUrl ?? DEFAULT_BASE_URL,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? 10_000,
    label: "getConfig",
  });
}

export async function sendTyping(
  params: {
    baseUrl?: string;
    token?: string;
    timeoutMs?: number;
  } & { body: SendTypingReq },
): Promise<void> {
  await apiFetch<Record<string, never>>({
    baseUrl: params.baseUrl ?? DEFAULT_BASE_URL,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? 10_000,
    label: "sendTyping",
  });
}

export { DEFAULT_BASE_URL };
