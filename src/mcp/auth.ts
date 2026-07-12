import { readFileSync } from "node:fs";

export interface McpCredentialEnvironment {
  KEEL_ADMIN_TOKEN?: string;
  KEEL_SUBMITTER_TOKEN?: string;
  KEEL_RUN_CAP?: string;
  KEEL_CAP_FILE?: string;
}

/** Use the same credential precedence as the CLI, but fail closed for MCP. */
export function loadMcpCredential(
  env: McpCredentialEnvironment = process.env as McpCredentialEnvironment,
): string {
  if (env.KEEL_ADMIN_TOKEN) return env.KEEL_ADMIN_TOKEN;
  if (env.KEEL_SUBMITTER_TOKEN) return env.KEEL_SUBMITTER_TOKEN;
  if (env.KEEL_RUN_CAP) return env.KEEL_RUN_CAP;
  if (env.KEEL_CAP_FILE) return loadCapabilityFile(env.KEEL_CAP_FILE);
  throw new Error(
    "keel mcp requires KEEL_ADMIN_TOKEN, KEEL_SUBMITTER_TOKEN, KEEL_RUN_CAP, or KEEL_CAP_FILE",
  );
}

function loadCapabilityFile(path: string): string {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { capability?: unknown };
  if (typeof parsed.capability !== "string") {
    throw new Error(`capability file ${path} is missing capability`);
  }
  return parsed.capability;
}
