import { loadCredentials, loginWithQr } from "./auth.js";
import { startMonitor } from "./monitor.js";
import { handleIncomingMessage, type OpenCodeConfig } from "./handler.js";
import { DEFAULT_BASE_URL } from "./api.js";
import { getProgressMonitor } from "./progress.js";

function parseArgs(): {
  login: boolean;
  ocServerUrl: string;
  ocPassword: string;
  ocProjectDir: string;
} {
  const args = process.argv.slice(2);
  const login = args.includes("--login");

  const urlIdx = args.indexOf("--oc-url");
  const pwdIdx = args.indexOf("--oc-password");
  const dirIdx = args.indexOf("--oc-dir");

  return {
    login,
    ocServerUrl:
      urlIdx >= 0
        ? args[urlIdx + 1] ?? "http://127.0.0.1:4096"
        : process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096",
    ocPassword:
      pwdIdx >= 0
        ? args[pwdIdx + 1] ?? ""
        : process.env.OPENCODE_SERVER_PASSWORD ?? "",
    ocProjectDir:
      dirIdx >= 0
        ? args[dirIdx + 1] ?? process.cwd()
        : process.env.OPENCODE_PROJECT_DIR ?? process.cwd(),
  };
}

async function ensureOpenCodeServer(
  serverUrl: string,
  projectDir: string,
  password: string,
): Promise<void> {
  try {
    const headers: Record<string, string> = {};
    if (password) {
      headers.Authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    }
    const res = await fetch(`${serverUrl}/global/health`, { headers, signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      console.log(`[main] OpenCode server already running at ${serverUrl}`);
      return;
    }
  } catch {
    // server not running
  }

  console.log(`[main] Starting OpenCode server in ${projectDir}...`);

  const { spawn } = await import("node:child_process");
  const env = { ...process.env } as Record<string, string>;
  if (password) env.OPENCODE_SERVER_PASSWORD = password;

  const child = spawn("opencode", ["serve", "--port", "4096", "--hostname", "127.0.0.1"], {
    cwd: projectDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  child.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[opencode] ${line}`);
  });
  child.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(`[opencode] ${line}`);
  });

  child.on("error", (err) => {
    console.error(`[main] Failed to start OpenCode server: ${err.message}`);
    process.exit(1);
  });

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const headers: Record<string, string> = {};
      if (password) {
        headers.Authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
      }
      const res = await fetch(`${serverUrl}/global/health`, { headers, signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        console.log(`[main] OpenCode server ready at ${serverUrl}`);
        return;
      }
    } catch {
      // retry
    }
  }

  console.error("[main] OpenCode server failed to start within 30s");
  process.exit(1);
}

async function main(): Promise<void> {
  const flags = parseArgs();

  if (flags.login) {
    console.log("[main] Starting QR login flow...");
    const creds = await loginWithQr();
    console.log(`[main] Login complete. accountId=${creds.accountId}`);
    console.log("[main] Now run without --login to start the bot.");
    return;
  }

  const creds = loadCredentials();
  if (!creds) {
    console.error("[main] No WeChat credentials found. Run with --login to authenticate first.");
    console.error("[main] Usage: npm run login");
    process.exit(1);
  }

  const ocConfig: OpenCodeConfig = {
    serverUrl: flags.ocServerUrl,
    password: flags.ocPassword || undefined,
  };

  await ensureOpenCodeServer(ocConfig.serverUrl, flags.ocProjectDir, ocConfig.password ?? "");

  console.log(`[main] Bot starting: accountId=${creds.accountId} opencode=${ocConfig.serverUrl} dir=${flags.ocProjectDir}`);

  const abortController = new AbortController();
  process.on("SIGINT", () => {
    console.log("\n[main] SIGINT received, shutting down...");
    abortController.abort();
    const progressMonitor = getProgressMonitor({ serverUrl: ocConfig.serverUrl, password: ocConfig.password });
    progressMonitor.shutdown();
  });
  process.on("SIGTERM", () => {
    console.log("\n[main] SIGTERM received, shutting down...");
    abortController.abort();
    const progressMonitor = getProgressMonitor({ serverUrl: ocConfig.serverUrl, password: ocConfig.password });
    progressMonitor.shutdown();
  });

  await startMonitor(
    creds,
    (msg, contextToken) => handleIncomingMessage(msg, contextToken, creds, ocConfig),
    abortController.signal,
  );
}

main().catch((err) => {
  console.error(`[main] Fatal: ${err}`);
  process.exit(1);
});
