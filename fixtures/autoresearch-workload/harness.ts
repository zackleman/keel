import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = resolve(import.meta.dir, "../..");
const DAEMON_ENTRY = resolve(import.meta.dir, "workload-daemon.ts");
const CLI_ENTRY = resolve(ROOT, "src/cli/keel.ts");

export interface CallRecord {
  key: string;
  call: number;
  prompt: string;
  output: string;
}

export interface DaemonEnvironment {
  socketPath: string;
  dbPath: string;
  callLog: string;
  adminToken: string;
  slowKey?: string;
  slowMs?: number;
}

export async function startWorkloadDaemon(config: DaemonEnvironment) {
  const proc = Bun.spawn([process.execPath, DAEMON_ENTRY], {
    env: isolatedEnv({
      KEEL_SOCKET: config.socketPath,
      KEEL_DB: config.dbPath,
      KEEL_CALL_LOG: config.callLog,
      KEEL_ADMIN_TOKEN: config.adminToken,
      KEEL_SLOW_KEY: config.slowKey,
      KEEL_SLOW_MS: config.slowMs === undefined ? undefined : String(config.slowMs),
    }),
    stdout: "pipe",
    stderr: "inherit",
  });
  await waitForReady(proc.stdout);
  return proc;
}

export async function stopProcess(
  proc: ReturnType<typeof Bun.spawn>,
  signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill(signal);
  await proc.exited;
}

export async function until(
  condition: () => Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

export function readCallLog(path: string): CallRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CallRecord);
}

export interface McpHarness {
  call<T>(name: string, args?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

export async function startMcp(config: {
  socketPath: string;
  adminToken: string;
}): Promise<McpHarness> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_ENTRY, "mcp"],
    cwd: ROOT,
    env: isolatedEnv({
      KEEL_SOCKET: config.socketPath,
      KEEL_ADMIN_TOKEN: config.adminToken,
    }),
    stderr: "inherit",
  });
  const client = new Client({ name: "autoresearch-chaos", version: "0.0.0" });
  await client.connect(transport);
  return {
    async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
      const response = (await client.callTool({ name, arguments: args })) as {
        content: unknown;
        isError?: boolean;
      };
      if (!Array.isArray(response.content)) {
        throw new Error(`MCP tool ${name} returned invalid content`);
      }
      const text = response.content.find(
        (item): item is { type: "text"; text: string } =>
          typeof item === "object" &&
          item !== null &&
          "type" in item &&
          item.type === "text" &&
          "text" in item &&
          typeof item.text === "string",
      );
      if (!text) throw new Error(`MCP tool ${name} returned no text content`);
      if (response.isError) throw new Error(text.text);
      return JSON.parse(text.text) as T;
    },
    async close(): Promise<void> {
      await client.close();
    },
  };
}

async function waitForReady(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) throw new Error(`workload daemon exited before READY: ${output}`);
      output += decoder.decode(next.value, { stream: true });
      if (output.includes("READY ")) return;
    }
  } finally {
    reader.releaseLock();
  }
}

function isolatedEnv(overrides: NodeJS.ProcessEnv): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("KEEL_")),
  );
  return Object.fromEntries(
    Object.entries({ ...inherited, ...overrides }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
