import { sendMessage } from "./api.js";
import type { WeixinMessage, BotCredentials } from "./types.js";
import { MessageItemType, MessageType, MessageState } from "./types.js";

export interface ProgressConfig {
  serverUrl: string;
  password?: string;
}

export interface ProgressHandler {
  sendProgress: (text: string) => Promise<void>;
}

export interface OpenCodeEvent {
  type: string;
  properties?: {
    sessionID?: string;
    directory?: string;
    [key: string]: any;
  };
  data?: any;
}

export interface PartEvent {
  type: "text" | "reasoning" | "tool" | "step-start" | "step-finish" | "patch" | "error";
  sessionID: string;
  messageID: string;
  text?: string;
  tool?: string;
  reason?: string;
  state?: {
    status: "pending" | "running" | "completed" | "error";
  };
}

export class ProgressMonitor {
  private active: Map<string, ProgressHandler> = new Map();
  private abortController?: AbortController;
  private sessionIdMap: Map<string, string> = new Map();
  private lastProgressTime: Map<string, number> = new Map();
  private readonly PROGRESS_THROTTLE_MS = 2000;

  constructor(private config: ProgressConfig) {}

  setSessionForUser(userId: string, sessionId: string): void {
    this.sessionIdMap.set(userId, sessionId);
  }

  getHandler(userId: string): ProgressHandler | undefined {
    return this.active.get(userId);
  }

  async start(userId: string, sessionId: string, creds: BotCredentials): Promise<void> {
    if (this.active.has(userId)) {
      console.log(`[progress] Handler already exists for user ${userId}`);
      return;
    }

    this.sessionIdMap.set(userId, sessionId);

    const handler: ProgressHandler = {
      sendProgress: async (text: string) => {
        const now = Date.now();
        const lastTime = this.lastProgressTime.get(userId) ?? 0;
        
        if (now - lastTime < this.PROGRESS_THROTTLE_MS && text.includes("...")) {
          return;
        }
        
        this.lastProgressTime.set(userId, now);

        try {
          await sendMessage({
            baseUrl: creds.baseUrl,
            token: creds.token,
            body: {
              msg: {
                from_user_id: "",
                to_user_id: userId,
                client_id: `progress-${Date.now()}`,
                message_type: MessageType.BOT,
                message_state: MessageState.FINISH,
                item_list: [{ type: MessageItemType.TEXT, text_item: { text: `⏳ ${text}` } }],
              },
            },
          });
          console.log(`[progress] Sent to ${userId}: ${text}`);
        } catch (err) {
          console.error(`[progress] Failed to send progress:`, err);
        }
      },
    };

    this.active.set(userId, handler);
    console.log(`[progress] Started monitoring for user ${userId}, session ${sessionId}`);

    if (!this.abortController) {
      this.abortController = new AbortController();
      this.startSSEStream(this.abortController.signal).catch((err) => {
        console.error("[progress] SSE stream error:", err);
      });
    }
  }

  stop(userId: string): void {
    this.active.delete(userId);
    this.lastProgressTime.delete(userId);
    console.log(`[progress] Stopped monitoring for user ${userId}`);
  }

  private async startSSEStream(abortSignal: AbortSignal): Promise<void> {
    const headers: Record<string, string> = {
      "Accept": "text/event-stream",
      "Cache-Control": "no-cache",
    };

    if (this.config.password) {
      headers.Authorization = `Basic ${Buffer.from(`opencode:${this.config.password}`).toString("base64")}`;
    }

    try {
      console.log(`[progress] Connecting to SSE at ${this.config.serverUrl}/event`);
      const response = await fetch(`${this.config.serverUrl}/event`, {
        headers,
        signal: abortSignal,
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const decoder = new TextDecoder();
      let buffer = "";

      while (!abortSignal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();
            if (data === "" || data === "[DONE]") continue;
            
            try {
              const event = JSON.parse(data) as OpenCodeEvent;
              await this.handleEvent(event);
            } catch (err) {
              console.error("[progress] Failed to parse SSE event:", err);
            }
          }
        }
      }
    } catch (err) {
      if (!abortSignal.aborted) {
        console.error("[progress] SSE stream error:", err);
      }
    } finally {
      console.log("[progress] SSE stream closed");
    }
  }

  private async handleEvent(event: OpenCodeEvent): Promise<void> {
    const { type, properties } = event;

    if (!properties?.sessionID) return;

    const userId = this.findUserBySession(properties.sessionID);
    if (!userId) return;

    const handler = this.active.get(userId);
    if (!handler) return;

    let progressText = "";

    switch (type) {
      case "session.status":
        const status = properties.status;
        if (status?.type === "busy") {
          progressText = "开始处理...";
        } else if (status?.type === "idle") {
          progressText = "处理完成";
        } else if (status?.type === "retry") {
          progressText = `重试中 (${status.attempt}次)...`;
        }
        break;

      case "session.part":
        const part = properties.part as PartEvent;
        if (!part) break;

        switch (part.type) {
          case "reasoning":
            if (part.text) {
              progressText = `思考中...`;
            }
            break;

          case "tool":
            if (part.tool && part.state) {
              if (part.state.status === "pending") {
                progressText = `准备执行: ${part.tool}`;
              } else if (part.state.status === "running") {
                progressText = `执行中: ${part.tool}...`;
              } else if (part.state.status === "completed") {
                progressText = `✓ ${part.tool} 完成`;
              } else if (part.state.status === "error") {
                progressText = `✗ ${part.tool} 失败`;
              }
            }
            break;

          case "step-start":
            progressText = "开始工作步骤...";
            break;

          case "step-finish":
            progressText = "工作步骤完成";
            break;

          case "text":
            if (part.text && part.text.length > 0) {
              progressText = "生成回复中...";
            }
            break;

          case "patch":
            if (properties.files?.length > 0) {
              progressText = `修改 ${properties.files.length} 个文件...`;
            }
            break;

          case "error":
            progressText = `⚠️ 发生错误`;
            break;
        }
        break;

      case "session.message":
        const msg = properties;
        if (msg?.role === "assistant") {
          progressText = "收到AI回复";
        }
        break;
    }

    if (progressText) {
      await handler.sendProgress(progressText);
    }
  }

  private findUserBySession(sessionId: string): string | undefined {
    for (const [userId, sid] of this.sessionIdMap.entries()) {
      if (sid === sessionId) return userId;
    }
    return undefined;
  }

  shutdown(): void {
    this.abortController?.abort();
    this.abortController = undefined;
    this.active.clear();
    this.lastProgressTime.clear();
    console.log("[progress] Shutdown complete");
  }
}

let globalProgressMonitor: ProgressMonitor | undefined;

export function getProgressMonitor(config: ProgressConfig): ProgressMonitor {
  if (!globalProgressMonitor) {
    globalProgressMonitor = new ProgressMonitor(config);
  }
  return globalProgressMonitor;
}
