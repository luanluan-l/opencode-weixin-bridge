import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import qrcodeTerminal from "qrcode-terminal";
const qrGen = (qrcodeTerminal as unknown as { default: typeof qrcodeTerminal }).default ?? qrcodeTerminal;
import { DEFAULT_BASE_URL } from "./api.js";
import type { BotCredentials } from "./types.js";

const BOT_TYPE = "3";
const QR_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_QR_REFRESH = 3;

const STATE_DIR = path.join(process.env.HOME ?? "/tmp", ".opencode-weixin");

function resolveStateDir(): string {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  return STATE_DIR;
}

function resolveCredPath(): string {
  return path.join(resolveStateDir(), "credentials.json");
}

export function loadCredentials(): BotCredentials | null {
  try {
    const raw = fs.readFileSync(resolveCredPath(), "utf-8");
    return JSON.parse(raw) as BotCredentials;
  } catch {
    return null;
  }
}

export function saveCredentials(creds: BotCredentials): void {
  resolveStateDir();
  const filePath = resolveCredPath();
  fs.writeFileSync(filePath, JSON.stringify(creds, null, 2), "utf-8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

async function fetchQRCode(apiBaseUrl: string): Promise<{ qrcode: string; qrcode_img_content: string }> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`, base);
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(`Failed to fetch QR code: ${res.status} ${body}`);
  }
  return await res.json();
}

async function pollQRStatus(
  apiBaseUrl: string,
  qrcode: string,
): Promise<{
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to poll QR status: ${res.status} ${body}`);
    }
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

export async function loginWithQr(baseUrl?: string): Promise<BotCredentials> {
  const apiBaseUrl = baseUrl ?? DEFAULT_BASE_URL;
  console.log("[auth] Fetching QR code...");

  let qrResp = await fetchQRCode(apiBaseUrl);
  let qrcode = qrResp.qrcode;
  let qrcodeUrl = qrResp.qrcode_img_content;

  for (let refresh = 0; refresh <= MAX_QR_REFRESH; refresh++) {
    if (refresh > 0) {
      console.log(`\n[auth] QR expired, refreshing (${refresh}/${MAX_QR_REFRESH})...`);
      qrResp = await fetchQRCode(apiBaseUrl);
      qrcode = qrResp.qrcode;
      qrcodeUrl = qrResp.qrcode_img_content;
    }

    console.log(`\n[auth] Scan this QR code with WeChat:\n`);
    qrGen.generate(qrcodeUrl, { small: true }, (qr: string) => {
      console.log(qr);
      console.log(`\nOr open: ${qrcodeUrl}\n`);
    });

    console.log("[auth] Waiting for scan...\n");
    const deadline = Date.now() + 300_000;

    while (Date.now() < deadline) {
      const status = await pollQRStatus(apiBaseUrl, qrcode);
      switch (status.status) {
        case "wait":
          process.stdout.write(".");
          break;
        case "scaned":
          console.log("\n[auth] Scanned, waiting for confirmation in WeChat...");
          break;
        case "confirmed": {
          if (!status.bot_token || !status.ilink_bot_id) {
            throw new Error("Login confirmed but missing bot_token or ilink_bot_id");
          }
          const creds: BotCredentials = {
            token: status.bot_token,
            accountId: status.ilink_bot_id,
            baseUrl: status.baseurl ?? apiBaseUrl,
            userId: status.ilink_user_id,
          };
          saveCredentials(creds);
          console.log(`\n[auth] Connected! accountId=${creds.accountId}`);
          return creds;
        }
        case "expired":
          console.log("\n[auth] QR expired.");
          break;
      }

      if (status.status === "expired") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  throw new Error("Login failed: QR expired too many times");
}
