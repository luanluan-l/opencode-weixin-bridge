import { getUpdates } from "./api.js";
import type { BotCredentials } from "./types.js";
import type { WeixinMessage } from "./types.js";

type MessageHandler = (msg: WeixinMessage, contextToken?: string) => Promise<void>;

const SESSION_EXPIRED_ERRCODE = -14;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
  });
}

function extractText(msg: WeixinMessage): string {
  if (!msg.item_list?.length) return "";
  for (const item of msg.item_list) {
    if (item.type === 1 && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
    if (item.type === 3 && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

export async function startMonitor(
  creds: BotCredentials,
  handleMessage: MessageHandler,
  abortSignal?: AbortSignal,
): Promise<void> {
  let syncBuf = "";
  let nextTimeoutMs = 35_000;
  let consecutiveFailures = 0;

  console.log(`[monitor] Starting WeChat bot: accountId=${creds.accountId}`);

  while (!abortSignal?.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl: creds.baseUrl,
        token: creds.token,
        get_updates_buf: syncBuf,
        timeoutMs: nextTimeoutMs,
      });

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        if (resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE) {
          console.error(`[monitor] Session expired (errcode ${SESSION_EXPIRED_ERRCODE}), pausing 60 min`);
          consecutiveFailures = 0;
          await sleep(60 * 60 * 1000, abortSignal);
          continue;
        }

        consecutiveFailures++;
        console.error(
          `[monitor] getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        );

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`[monitor] ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`);
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        syncBuf = resp.get_updates_buf;
      }

      for (const msg of resp.msgs ?? []) {
        if (msg.message_type !== 1) continue;
        const text = extractText(msg);
        console.log(`[monitor] <- ${msg.from_user_id}: ${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`);

        try {
          await handleMessage(msg, msg.context_token);
        } catch (err) {
          console.error(`[monitor] handle message error: ${err}`);
        }
      }
    } catch (err) {
      if (abortSignal?.aborted) return;
      consecutiveFailures++;
      console.error(`[monitor] error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${err}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(30_000, abortSignal);
      } else {
        await sleep(2_000, abortSignal);
      }
    }
  }

  console.log("[monitor] Stopped");
}
