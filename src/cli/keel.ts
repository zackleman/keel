#!/usr/bin/env bun
// Thin Keel CLI (DESIGN.md §6.1) — sends one RPC to the daemon and prints the
// result. The daemon (never the CLI) hosts the realm and spawns agents (L4).
//
//   keel daemon                         start the daemon (foreground)
//   keel launch [workflow.ts] [--input json]     launch a run and watch it
//   keel run [workflow.ts] [--input json]        launch and print terminal output
//   keel watch <runId>                  stream a run's events until terminal
//   keel get <runId>                    print the run projection
//   keel resume <runId>                 resume a non-terminal run
//   keel list [--output text|json]      list runs
//   keel tui [runId]                   interactive run browser/detail/watch
//   keel web                           start the local browser API transport
//   keel mcp                           start the supervisor MCP server over stdio
//
// Socket + db paths default under ~/.keel (override with KEEL_SOCKET / KEEL_DB).

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TASK_REVIEW_GUIDANCE_PACKAGE,
  TASK_REVIEW_WORKFLOWS,
} from "../../workflows/task-review-guidance/package.ts";
import { ClaudeProvider } from "../agents/claude.ts";
import { CodexProvider } from "../agents/codex.ts";
import { validateEnvironmentName } from "../agents/environment.ts";
import { PiProvider } from "../agents/pi.ts";
import { AgentProviderRegistry } from "../agents/types.ts";
import { redactCapabilityTokens } from "../auth/redaction.ts";
import { DaemonClient } from "../daemon/client.ts";
import { KeelDaemon } from "../daemon/server.ts";
import { runExecuteScript } from "../execute/runtime.ts";
import { JournalStore } from "../journal/store.ts";
import { runMcpServer } from "../mcp/server.ts";
import type {
  AgentProfileCheckResult,
  AgentProfileView,
  EventCursorInput,
  RunLaunchResult,
  RunOutcome,
  RunSecrets,
  ScheduleSummary,
  ScheduleView,
  SettingView,
  SettingsDiagnostic,
  WorkflowProvenance,
} from "../rpc/contract.ts";
import type { RunReport } from "../rpc/projection.ts";
import { effectiveOperationalSettings } from "../settings/catalog.ts";
import { cliTargetPath } from "../target.ts";
import { runTui } from "../tui/index.ts";
import {
  DEFAULT_WEB_ASSETS_DIR,
  DEFAULT_WEB_HOST,
  DEFAULT_WEB_PORT,
  startWebServer,
} from "../web/server.ts";
import { captureWorkflowFile } from "../workflow-definitions/capture.ts";
import { keelPackageRoot } from "../workflow-definitions/snapshot.ts";
import type { WorkflowSourceInput } from "../workflow-definitions/source.ts";
import { DEFAULT_WORKSPACE_ID } from "../workspace/identity.ts";
import { displayName, formatDuration, formatListRuns, formatUtcTimestamp } from "./run-display.ts";
import { formatTable, tableCell } from "./table.ts";
import { compactTerminalText } from "./terminal-text.ts";
import { createTextWatchFormatter, formatNdjsonWatchEvent } from "./watch-format.ts";
import type { WatchFormatOptions } from "./watch-format.ts";

const KEEL_DIR = process.env.KEEL_DIR ?? join(homedir(), ".keel");
const SOCKET = process.env.KEEL_SOCKET ?? join(KEEL_DIR, "keel.sock");
const DB = process.env.KEEL_DB ?? join(KEEL_DIR, "keel.db");
const CAP_DIR = process.env.KEEL_CAP_DIR ?? join(KEEL_DIR, "caps");
const WORKFLOW_DEFINITION_HASH_RE = /^wf_sha256_[0-9a-f]{64}$/;
export { formatDuration, formatListRuns, formatUtcTimestamp } from "./run-display.ts";

export const OUTPUT_FORMATS = ["json", "text", "ndjson"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

// Every client opened during a command is tracked here and closed by `main`'s
// dispatch `finally`. A leaked socket keeps the event loop alive and hangs the
// CLI, so cleanup must be a structural guarantee — not per-command discipline
// that the throw path skips. Commands therefore never close their own client.
const trackedClients = new Set<DaemonClient>();

/** Connect a client, authenticating with the caller's presented capability. */
async function openClient(credential = loadCredential()): Promise<DaemonClient> {
  const c = await DaemonClient.connect(SOCKET);
  // Track before authenticate so a failed authentication is still cleaned up.
  trackedClients.add(c);
  if (credential) await c.authenticate(credential);
  return c;
}

function closeTrackedClients(): void {
  for (const c of trackedClients) c.close();
  trackedClients.clear();
}

function readOperationalSettingsForDaemonStartup(): {
  codexRpcTimeoutMs: number;
  codexConnectTimeoutMs: number;
  workflowDefinitionGcTtlMs: number;
} {
  const store = JournalStore.open(DB);
  try {
    return effectiveOperationalSettings(store.listDaemonSettingRows());
  } finally {
    store.close();
  }
}

/** [name, args, summary] — single source for help + dispatch. */
const COMMANDS: [string, string, string][] = [
  ["daemon", "", "start the daemon (foreground; owns the journal + runs workflows)"],
  ["link", "[dir]", "make <dir> (default: cwd) able to import the @kcosr/keel SDK"],
  [
    "launch",
    "[workflow.ts] [--name n] [--input json] [--target dir] [--secret NAME=VALUE] [--secret-env NAME[=ENV]] [--output json|text|ndjson] [--tools] [--detach] [--emit-capability]",
    "start a run from client-captured workflow source",
  ],
  [
    "run",
    "[workflow.ts] [--name n] [--input json] [--target dir] [--secret NAME=VALUE] [--secret-env NAME[=ENV]] [--output json|text|ndjson] [--tools]",
    "launch and print the result",
  ],
  [
    "watch",
    "<runId> [--output ndjson|text] [--from beginning|now | --after-seq n | --tail n] [--tools]",
    "stream a run's events until it finishes",
  ],
  ["get", "<runId>", "print a run's projection as JSON"],
  ["output", "<runId> [--output json|text]", "print a run's terminal output"],
  ["report", "<runId> [--output json|text]", "print a run's per-node result digest"],
  ["list", "[--output text|json]", "list runs"],
  [
    "workflow",
    "save|install|list|show|source|launch|run|disable|enable|...",
    "manage saved workflows",
  ],
  [
    "tui",
    "[runId] [--status status] [--limit n] [--output text]",
    "open the interactive run browser",
  ],
  [
    "web",
    "[--host 127.0.0.1] [--port 7879] [--socket path] [--assets dir] [--api-only]",
    "serve the local browser API transport",
  ],
  ["mcp", "", "serve supervisor tools over MCP stdio"],
  ["schedule", "put|list|show ...", "create and inspect cron schedules"],
  ["profiles", "list|get|set|delete|check ...", "manage persistent agent profile catalog"],
  ["settings", "list|get|set|unset|check ...", "manage daemon settings catalog"],
  [
    "workspace",
    "list|show|diff|merge|discard|gc ...",
    "inspect and manage retained agent workspaces",
  ],
  ["gc", "", "prune unreferenced workflow definitions and cache entries"],
  ["resume", "[--detach] [--tools] <runId>", "resume a parked or incomplete run"],
  ["interrupt", "<runId> [reason]", "interrupt a non-terminal run until explicit resume"],
  [
    "retry",
    "[--detach] [--tools] [--secret NAME=VALUE] [--secret-env NAME[=ENV]] <runId>",
    "re-run a failed run from its failed step",
  ],
  [
    "rewind",
    "[--detach] [--tools] [--secret NAME=VALUE] [--secret-env NAME[=ENV]] <runId> <stepKey>",
    "discard everything after a step and re-run",
  ],
  ["fork", "<runId> [atStepKey]", "copy a run into a new independent run"],
  [
    "execute",
    "[file] [--entry name] [--state file] [--cap-file file] [--output json] [--emit-capability] [-- args...]",
    "run a stateless TypeScript control script",
  ],
  ["approve", "<runId> <key> [note]", "approve a ctx.human gate"],
  ["deny", "<runId> <key> [note]", "deny a ctx.human gate"],
  ["signal", "<runId> <name> [json]", "deliver a ctx.signal payload"],
  ["help", "[command]", "show this help, or help for one command"],
];
const cmdNames = new Set(COMMANDS.map((c) => c[0]));

function topHelp(): string {
  const w = Math.max(...COMMANDS.map((c) => `${c[0]} ${c[1]}`.trim().length));
  const rows = COMMANDS.map(([n, a, s]) => `  ${`${n} ${a}`.trim().padEnd(w)}  ${s}`);
  return [
    "keel — durable agent-workflow orchestrator",
    "",
    "Usage: keel <command> [args]",
    "",
    "Commands:",
    ...rows,
    "",
    "Environment: KEEL_SOCKET, KEEL_DB, KEEL_DIR, KEEL_ADMIN_TOKEN, KEEL_SUBMITTER_TOKEN, KEEL_RUN_CAP, KEEL_CAP_FILE, KEEL_CAP_DIR, KEEL_WORKSPACE_STORE",
    "Run `keel help <command>` for one command.",
    "",
  ].join("\n");
}
function cmdHelp(name: string): string {
  const c = COMMANDS.find((x) => x[0] === name);
  if (!c) return topHelp();
  return `Usage: keel ${`${c[0]} ${c[1]}`.trim()}\n  ${c[2]}\n`;
}

async function main(argv: string[]): Promise<number> {
  try {
    return await dispatch(argv);
  } finally {
    closeTrackedClients();
  }
}

async function dispatch(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  // help: `keel`, `keel help [cmd]`, `keel --help`, `keel <cmd> --help`
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(rest[0] && cmdNames.has(rest[0]) ? cmdHelp(rest[0]) : topHelp());
    return 0;
  }
  if (cmdNames.has(cmd) && (rest[0] === "--help" || rest[0] === "-h")) {
    process.stdout.write(cmdHelp(cmd));
    return 0;
  }
  switch (cmd) {
    case "daemon": {
      await import("node:fs").then((fs) => fs.mkdirSync(KEEL_DIR, { recursive: true }));
      const operational = readOperationalSettingsForDaemonStartup();
      const agents = new AgentProviderRegistry()
        .register(new PiProvider())
        .register(new ClaudeProvider())
        .register(
          new CodexProvider({
            rpcTimeoutMs: operational.codexRpcTimeoutMs,
            connectTimeoutMs: operational.codexConnectTimeoutMs,
          }),
        );
      const daemon = new KeelDaemon({
        socketPath: SOCKET,
        dbPath: DB,
        agents,
        ...(process.env.KEEL_ADMIN_TOKEN ? { adminToken: process.env.KEEL_ADMIN_TOKEN } : {}),
        ...(process.env.KEEL_SUBMITTER_TOKEN
          ? { submitterToken: process.env.KEEL_SUBMITTER_TOKEN }
          : {}),
        ...(process.env.KEEL_WORKSPACE_STORE
          ? { workspaceStore: process.env.KEEL_WORKSPACE_STORE }
          : {}),
      });
      await daemon.start();
      process.stdout.write(`keel daemon listening on ${SOCKET} (owner ${daemon.ownerId})\n`);
      process.on("SIGINT", () => {
        daemon.stop();
        process.exit(0);
      });
      await new Promise(() => {}); // run forever
      return 0;
    }
    case "link": {
      // Make a directory able to `import … from "@kcosr/keel"` without a registry,
      // by symlinking the package into its node_modules. Idempotent — re-run to
      // repair/update the link (e.g. after the repo moves). Like `npm link`.
      const target = rest[0] ? resolve(rest[0]) : process.cwd();
      const repoRoot = resolve(import.meta.dir, "..", ".."); // <repo> from src/cli/
      const scopeDir = join(target, "node_modules", "@kcosr");
      const link = join(scopeDir, "keel");
      mkdirSync(scopeDir, { recursive: true });
      try {
        const existing = lstatSync(link);
        if (!existing.isSymbolicLink()) {
          process.stderr.write(
            `keel: refusing to replace non-symlink at ${link}\nremove it yourself, or choose another directory\n`,
          );
          return 2;
        }
        rmSync(link, { force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        // nothing there
      }
      symlinkSync(repoRoot, link, "dir");
      process.stdout.write(`linked @kcosr/keel → ${repoRoot}\n  ${link}\n`);
      return 0;
    }
    case "web": {
      const parsed = parseWebArgs(rest);
      const assets =
        parsed.assets ??
        (parsed.apiOnly || !existsSync(join(DEFAULT_WEB_ASSETS_DIR, "index.html"))
          ? undefined
          : DEFAULT_WEB_ASSETS_DIR);
      const server = startWebServer({
        socketPath: parsed.socket,
        host: parsed.host,
        port: parsed.port,
        ...(assets ? { assetsDir: assets } : {}),
        apiOnly: parsed.apiOnly,
      });
      process.stdout.write(`keel web listening on ${server.url}\n`);
      process.stdout.write(`daemon socket: ${parsed.socket}\n`);
      process.stdout.write(assets ? `assets: ${assets}\n` : "assets: API-only\n");
      process.on("SIGINT", () => {
        server.stop(true);
        process.exit(0);
      });
      await new Promise(() => {});
      return 0;
    }
    case "mcp": {
      await runMcpServer({ socketPath: SOCKET });
      return 0;
    }
    case "launch": {
      const launchOpts = parseLaunchArgs(rest);
      const output = launchOutputMode("launch", launchOpts.output, launchOpts.detach);
      assertToolsAllowed("launch", launchOpts.tools, output, launchOpts.detach);
      const captured = await readWorkflowSource(launchOpts.file);
      const client = await openClient();
      const launched = await client.launchRun({
        source: captured.source,
        input: launchOpts.input,
        target: launchOpts.target,
        name: launchOpts.name ?? captured.defaultName,
        provenance: captured.provenance,
        ...(nonEmptyRunSecrets(launchOpts.runSecrets) !== undefined
          ? { runSecrets: launchOpts.runSecrets }
          : {}),
      });
      return finishLaunchCommand(client, launched, {
        output,
        detach: launchOpts.detach,
        emitCapability: launchOpts.emitCapability,
        tools: launchOpts.tools,
      });
    }
    case "run": {
      const runOpts = parseRunArgs(rest);
      const output = runOpts.output ?? "json";
      assertToolsAllowed("run", runOpts.tools, output, false);
      const captured = await readWorkflowSource(runOpts.file);
      const client = await openClient();
      const launched = await client.launchRun({
        source: captured.source,
        input: runOpts.input,
        target: runOpts.target,
        name: runOpts.name ?? captured.defaultName,
        provenance: captured.provenance,
        ...(nonEmptyRunSecrets(runOpts.runSecrets) !== undefined
          ? { runSecrets: runOpts.runSecrets }
          : {}),
      });
      return finishRunCommand(client, launched, { output, tools: runOpts.tools });
    }
    case "watch": {
      const parsed = parseWatchArgs(rest);
      const { runId } = parsed;
      if (!runId) return usage("watch needs a runId");
      const client = await openClient();
      const terminal = await watchRun(client, runId, {
        output: parsed.output ?? "ndjson",
        tools: parsed.tools,
        cursor: parsed.cursor,
      });
      return statusExitCode(terminal);
    }
    case "get": {
      const [runId] = rest;
      if (!runId) return usage("get needs a runId");
      const client = await openClient();
      process.stdout.write(`${JSON.stringify(await client.getRun(runId), null, 2)}\n`);
      return 0;
    }
    case "output": {
      const parsed = parseRunIdOutputArgs(rest, "output", "json", ["json", "text"]);
      const { runId } = parsed;
      if (!runId) return usage("output needs a runId");
      const client = await openClient();
      const out = await client.getRunOutput(runId);
      if (out.status !== "finished") {
        process.stderr.write(`run ${runId} is ${out.status}; no terminal output available\n`);
        return out.status === "failed" ? 1 : 3;
      }
      process.stdout.write(
        parsed.output === "json"
          ? `${JSON.stringify(out.output ?? null)}\n`
          : formatHumanOutput(out.output),
      );
      return 0;
    }
    case "report": {
      const parsed = parseRunIdOutputArgs(rest, "report", "json", ["json", "text"]);
      const { runId } = parsed;
      if (!runId) return usage("report needs a runId");
      const client = await openClient();
      const report = await client.getRunReport(runId);
      if (!report) {
        process.stderr.write(`run ${runId} not found\n`);
        return 1;
      }
      process.stdout.write(
        parsed.output === "json" ? `${JSON.stringify(report)}\n` : formatRunReportText(report),
      );
      return statusExitCode(report.status);
    }
    case "resume": {
      const parsed = parseLifecycleArgs(rest);
      const [runId] = parsed.args;
      if (!runId) return usage("resume needs a runId");
      const client = await openClient();
      const out = await client.resumeRun(runId);
      if (!parsed.detach) process.stdout.write(formatRunHeader(out.runId));
      const terminal = parsed.detach
        ? null
        : await watchRun(client, out.runId, {
            output: "text",
            tools: parsed.tools,
            cursor: out.attachCursor,
          });
      if (parsed.detach) process.stdout.write(`${out.runId}\t${out.status}\n`);
      return parsed.detach ? 0 : statusExitCode(terminal ?? out.status);
    }
    case "interrupt": {
      const [runId, ...reasonParts] = rest;
      if (!runId) return usage("interrupt needs <runId> [reason]");
      const client = await openClient();
      const out = await client.interruptRun(
        runId,
        reasonParts.length > 0 ? reasonParts.join(" ") : undefined,
      );
      process.stdout.write(`${out.runId}\t${out.status}\n`);
      return 0;
    }
    case "list": {
      const parsed = parseListArgs(rest);
      const client = await openClient();
      const runs = await client.listRuns();
      process.stdout.write(
        parsed.output === "json"
          ? `${JSON.stringify({ runs })}\n`
          : formatListRuns(runs, Date.now()),
      );
      return 0;
    }
    case "workflow": {
      return handleWorkflow(rest);
    }
    case "profiles": {
      return handleProfiles(rest);
    }
    case "settings": {
      return handleSettings(rest);
    }
    case "schedule": {
      const [sub, ...scheduleArgs] = rest;
      switch (sub) {
        case "put": {
          const parsed = parseSchedulePutArgs(scheduleArgs);
          if (!parsed.name) return usage("schedule needs put <name> [workflow.ts]");
          const client = await openClient();
          if (parsed.workflow) {
            await client.putSchedule({
              name: parsed.name,
              savedRef: {
                name: parsed.workflow,
                version: parsed.version,
                allowDeprecated: parsed.allowDeprecated,
              },
              input: parsed.input,
              target: parsed.target,
              intervalMs: parsed.intervalMs,
              ...(parsed.firstFireMs !== undefined ? { firstFireMs: parsed.firstFireMs } : {}),
            });
          } else {
            const captured = await readWorkflowSource(parsed.file);
            await client.putSchedule({
              name: parsed.name,
              source: captured.source,
              workflowName: parsed.workflowName ?? captured.defaultName,
              input: parsed.input,
              target: parsed.target,
              intervalMs: parsed.intervalMs,
              ...(parsed.firstFireMs !== undefined ? { firstFireMs: parsed.firstFireMs } : {}),
            });
          }
          process.stdout.write(
            `${JSON.stringify({ ok: true, name: parsed.name, target: parsed.target })}\n`,
          );
          return 0;
        }
        case "list": {
          const parsed = parseScheduleListArgs(scheduleArgs);
          const client = await openClient();
          const schedules = await client.listSchedules({
            includeDisabled: !parsed.enabledOnly,
          });
          process.stdout.write(
            parsed.output === "json"
              ? `${JSON.stringify({ schedules })}\n`
              : formatScheduleList(schedules, Date.now()),
          );
          return 0;
        }
        case "show": {
          const parsed = parseScheduleShowArgs(scheduleArgs);
          if (!parsed.name) return usage("schedule needs show <name>");
          const client = await openClient();
          const schedule = await client.getSchedule({
            name: parsed.name,
            ...(parsed.source ? { includeSource: true } : {}),
          });
          if (!schedule) {
            process.stderr.write(`schedule ${parsed.name} not found\n`);
            return 1;
          }
          process.stdout.write(
            parsed.output === "json"
              ? `${JSON.stringify(schedule, null, 2)}\n`
              : formatScheduleShow(schedule),
          );
          return 0;
        }
        default:
          return usage("schedule needs put|list|show");
      }
    }
    case "workspace": {
      return await workspaceCommand(rest);
    }
    case "tui": {
      const parsed = parseTuiArgs(rest);
      return await runTui({
        ...parsed,
        clientFactory: openClient,
        stdin: process.stdin,
        stdout: process.stdout,
        knownAdmin: Boolean(process.env.KEEL_ADMIN_TOKEN),
      });
    }
    case "gc": {
      const client = await openClient();
      const out = await client.gcDefinitions();
      process.stdout.write(`${JSON.stringify(out)}\n`);
      return 0;
    }
    case "approve":
    case "deny": {
      const [runId, key, note] = rest;
      if (!runId || !key) return usage(`${cmd} needs <runId> <approvalKey> [note]`);
      const client = await openClient();
      const out = await client.decideApproval(runId, key, {
        status: cmd === "approve" ? "approved" : "denied",
        ...(note ? { note } : {}),
      });
      process.stdout.write(`${out.status}\n`);
      return 0;
    }
    case "signal": {
      const [runId, name, payloadJson] = rest;
      if (!runId || !name) return usage("signal needs <runId> <name> [json]");
      const client = await openClient();
      const out = await client.sendSignal(
        runId,
        name,
        payloadJson ? JSON.parse(payloadJson) : null,
      );
      process.stdout.write(`${out.status}\n`);
      return 0;
    }
    case "retry": {
      const parsed = parseLifecycleArgs(rest);
      const [runId] = parsed.args;
      if (!runId) return usage("retry needs a runId");
      const client = await openClient();
      const out = await client.retryRun(runId, {
        ...(nonEmptyRunSecrets(parsed.runSecrets) !== undefined
          ? { runSecrets: parsed.runSecrets }
          : {}),
      });
      if (!parsed.detach) process.stdout.write(formatRunHeader(out.runId));
      const terminal = parsed.detach
        ? null
        : await watchRun(client, out.runId, {
            output: "text",
            tools: parsed.tools,
            cursor: out.attachCursor,
          });
      if (parsed.detach) process.stdout.write(`${out.runId}\t${out.status}\n`);
      return parsed.detach ? 0 : statusExitCode(terminal ?? out.status);
    }
    case "rewind": {
      const parsed = parseLifecycleArgs(rest);
      const [runId, step] = parsed.args;
      if (!runId || !step) return usage("rewind needs <runId> <stepKey>");
      const client = await openClient();
      const out = await client.rewindRun(runId, step, {
        ...(nonEmptyRunSecrets(parsed.runSecrets) !== undefined
          ? { runSecrets: parsed.runSecrets }
          : {}),
      });
      if (!parsed.detach) process.stdout.write(formatRunHeader(out.runId));
      const terminal = parsed.detach
        ? null
        : await watchRun(client, out.runId, {
            output: "text",
            tools: parsed.tools,
            cursor: out.attachCursor,
          });
      if (parsed.detach) process.stdout.write(`${out.runId}\t${out.status}\n`);
      return parsed.detach ? 0 : statusExitCode(terminal ?? out.status);
    }
    case "fork": {
      const [runId, atStableKey] = rest;
      if (!runId) return usage("fork needs <runId> [atStepKey]");
      const client = await openClient();
      const out = await client.forkRun(runId, atStableKey ? { atStableKey } : {});
      const capabilityRef = out.capability ? writeCapabilityFile(out.runId, out.capability) : null;
      process.stdout.write(`${JSON.stringify({ runId: out.runId, capabilityRef })}\n`);
      return 0;
    }
    case "execute": {
      let client: DaemonClient | null = null;
      try {
        const parsed = parseExecuteArgs(rest);
        if (parsed.output !== "json") {
          throw new Error(`--output ${parsed.output} is not available for execute`);
        }
        const credential = parsed.capFile
          ? loadCredentialFromFile(parsed.capFile)
          : loadCredential();
        client = await openClient(credential);
        const source = await readControlScriptSource(parsed.file);
        const state = parsed.stateFile ? JSON.parse(readFileSync(parsed.stateFile, "utf8")) : null;
        const result = await runExecuteScript({
          client,
          credential,
          cwd: process.cwd(),
          source,
          ...(parsed.entry ? { entry: parsed.entry } : {}),
          args: parsed.args,
          state,
          env: process.env,
          emitCapability: parsed.emitCapability,
          writeCapability: writeCapabilityFile,
        });
        process.stdout.write(`${JSON.stringify(result ?? null)}\n`);
        return 0;
      } catch (err) {
        process.stderr.write(`${JSON.stringify({ error: structuredError(err) })}\n`);
        return 1;
      }
    }
    default:
      process.stderr.write(`keel: unknown command "${cmd}"\n\n${topHelp()}`);
      return 2;
  }
}

export function parseLifecycleArgs(args: string[]): {
  detach: boolean;
  tools: boolean;
  runSecrets: RunSecrets;
  args: string[];
} {
  let detach = false;
  let tools = false;
  const runSecrets: RunSecrets = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--detach") detach = true;
    else if (arg === "--tools") tools = true;
    else if (arg === "--secret") addCliRunSecret(runSecrets, requireFlagValue(args, i++, arg), arg);
    else if (arg === "--secret-env")
      addCliRunSecretFromEnv(runSecrets, requireFlagValue(args, i++, arg), arg);
    else if (arg.startsWith("--")) throw new Error(`unknown lifecycle flag ${arg}`);
    else positional.push(arg);
  }
  if (detach && tools) {
    throw new Error("--tools is only available for attached lifecycle --output text");
  }
  return { detach, tools, runSecrets, args: positional };
}

export function parseOutputFormat(value: string): OutputFormat {
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) return value as OutputFormat;
  throw new Error(`invalid --output ${value}; expected json, text, or ndjson`);
}

export type ListOutputFormat = "text" | "json";

export interface ListArgs {
  output: ListOutputFormat;
}

export interface WebArgs {
  host: string;
  port: number;
  socket: string;
  assets?: string;
  apiOnly: boolean;
}

export interface TuiArgs {
  runId?: string;
  status?: string;
  limit?: number;
  output: "text";
}

export function parseWebArgs(args: string[]): WebArgs {
  const out: WebArgs = {
    host: DEFAULT_WEB_HOST,
    port: DEFAULT_WEB_PORT,
    socket: SOCKET,
    apiOnly: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--host":
        out.host = requireFlagValue(args, i, "--host");
        i++;
        break;
      case "--port": {
        const value = Number(requireFlagValue(args, i, "--port"));
        if (!Number.isInteger(value) || value < 0 || value > 65_535) {
          throw new Error("--port must be an integer between 0 and 65535");
        }
        out.port = value;
        i++;
        break;
      }
      case "--socket":
        out.socket = requireFlagValue(args, i, "--socket");
        i++;
        break;
      case "--assets":
        out.assets = resolve(requireFlagValue(args, i, "--assets"));
        i++;
        break;
      case "--api-only":
        out.apiOnly = true;
        break;
      default:
        throw new Error(`unexpected argument ${arg} for web`);
    }
  }
  if (out.host.trim() === "") throw new Error("--host must be non-empty");
  if (out.socket.trim() === "") throw new Error("--socket must be non-empty");
  return out;
}

export function parseListArgs(args: string[]): ListArgs {
  let output: ListOutputFormat = "text";
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "--output") {
      output = parseListOutputFormat(requireFlagValue(args, i, "--output"));
      i += 2;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown list flag ${arg}`);
    } else {
      positional.push(arg);
      i += 1;
    }
  }
  if (positional.length > 0) {
    throw new Error(`unexpected argument ${positional[0]} for list`);
  }
  return { output };
}

function parseListOutputFormat(value: string): ListOutputFormat {
  if (value === "text" || value === "json") return value;
  if (value === "ndjson") {
    throw new Error("--output ndjson is not available for list; expected text or json");
  }
  throw new Error(`invalid --output ${value} for list; expected text or json`);
}

export function parseTuiArgs(args: string[]): TuiArgs {
  const positional: string[] = [];
  const out: TuiArgs = { output: "text" };
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "--status") {
      out.status = requireFlagValue(args, i, "--status");
      i += 2;
    } else if (arg === "--limit") {
      const value = requireFlagValue(args, i, "--limit");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--limit must be a positive integer, got ${value}`);
      }
      out.limit = parsed;
      i += 2;
    } else if (arg === "--output") {
      const value = requireFlagValue(args, i, "--output");
      if (value !== "text")
        throw new Error(`--output ${value} is not available for tui; expected text`);
      i += 2;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown tui flag ${arg}`);
    } else {
      positional.push(arg);
      i += 1;
    }
  }
  if (positional.length > 1) throw new Error(`unexpected argument ${positional[1]} for tui`);
  if (positional[0]) out.runId = positional[0];
  return out;
}

export interface LaunchArgs {
  detach: boolean;
  emitCapability: boolean;
  tools: boolean;
  output?: OutputFormat;
  file?: string;
  name?: string | null;
  input: unknown;
  target?: string;
  runSecrets: RunSecrets;
}

export interface RunArgs {
  tools: boolean;
  output?: OutputFormat;
  file?: string;
  name?: string | null;
  input: unknown;
  target?: string;
  runSecrets: RunSecrets;
}

export interface ExecuteArgs {
  file?: string;
  entry?: string;
  stateFile?: string;
  capFile?: string;
  output: OutputFormat;
  emitCapability: boolean;
  args: string[];
}

export interface SchedulePutArgs {
  name?: string;
  file?: string;
  workflow?: string;
  version?: number | "latest";
  allowDeprecated?: boolean;
  workflowName?: string | null;
  input: unknown;
  target?: string;
  intervalMs: number;
  firstFireMs?: number;
}

export interface ScheduleListArgs {
  enabledOnly: boolean;
  output: ListOutputFormat;
}

export interface ScheduleShowArgs {
  name?: string;
  output: ListOutputFormat;
  source: boolean;
}

export function parseLaunchArgs(args: string[]): LaunchArgs {
  const out: LaunchArgs = {
    detach: false,
    emitCapability: false,
    tools: false,
    input: {},
    runSecrets: {},
  };
  parseSourceArgs(args, out, { detach: true, emitCapability: true, output: true, tools: true });
  return out;
}

export function parseRunArgs(args: string[]): RunArgs {
  const out: RunArgs = { tools: false, input: {}, runSecrets: {} };
  parseSourceArgs(args, out, { detach: false, emitCapability: false, output: true, tools: true });
  return out;
}

export function parseSchedulePutArgs(args: string[]): SchedulePutArgs {
  const out: SchedulePutArgs = { input: {}, intervalMs: 0 };
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "--name") {
      out.workflowName = requireFlagValue(args, i, "--name");
      i += 2;
    } else if (arg === "--workflow") {
      out.workflow = requireFlagValue(args, i, "--workflow");
      i += 2;
    } else if (arg === "--version") {
      out.version = parseWorkflowVersion(requireFlagValue(args, i, "--version"));
      i += 2;
    } else if (arg === "--allow-deprecated") {
      out.allowDeprecated = true;
      i += 1;
    } else if (arg === "--input") {
      out.input = parseLaunchInput(requireFlagValue(args, i, "--input"));
      i += 2;
    } else if (arg === "--target") {
      out.target = resolve(cliTargetPath(requireFlagValue(args, i, "--target")));
      i += 2;
    } else if (arg === "--interval-ms") {
      const value = Number(requireFlagValue(args, i, "--interval-ms"));
      if (!Number.isFinite(value) || value <= 0) throw new Error("--interval-ms must be positive");
      out.intervalMs = value;
      i += 2;
    } else if (arg === "--first-fire-ms") {
      const value = Number(requireFlagValue(args, i, "--first-fire-ms"));
      if (!Number.isFinite(value)) throw new Error("--first-fire-ms must be a number");
      out.firstFireMs = value;
      i += 2;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown schedule put flag ${arg}`);
    } else {
      positional.push(arg);
      i += 1;
    }
  }
  if (positional.length > 2)
    throw new Error(`unexpected argument ${positional[2]} for schedule put`);
  out.name = positional[0];
  out.file = positional[1];
  if (out.workflow && out.file)
    throw new Error("schedule put accepts workflow.ts or --workflow, not both");
  if (out.intervalMs <= 0) throw new Error("schedule put requires --interval-ms ms");
  return out;
}

export function parseScheduleListArgs(args: string[]): ScheduleListArgs {
  let output: ListOutputFormat = "text";
  let enabledOnly = false;
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "--enabled-only") {
      enabledOnly = true;
      i += 1;
    } else if (arg === "--output") {
      output = parseListOutputFormat(requireFlagValue(args, i, "--output"));
      i += 2;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown schedule list flag ${arg}`);
    } else {
      positional.push(arg);
      i += 1;
    }
  }
  if (positional.length > 0) {
    throw new Error(`unexpected argument ${positional[0]} for schedule list`);
  }
  return { enabledOnly, output };
}

export function parseScheduleShowArgs(args: string[]): ScheduleShowArgs {
  let output: ListOutputFormat = "text";
  let source = false;
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "--source") {
      source = true;
      i += 1;
    } else if (arg === "--output") {
      output = parseListOutputFormat(requireFlagValue(args, i, "--output"));
      i += 2;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown schedule show flag ${arg}`);
    } else {
      positional.push(arg);
      i += 1;
    }
  }
  if (positional.length > 1) {
    throw new Error(`unexpected argument ${positional[1]} for schedule show`);
  }
  return { name: positional[0], output, source };
}

export function parseExecuteArgs(args: string[]): ExecuteArgs {
  const out: ExecuteArgs = { output: "json", emitCapability: false, args: [] };
  const script: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "--") {
      out.args = args.slice(i + 1);
      break;
    }
    if (arg === "--entry") {
      out.entry = requireFlagValue(args, i, "--entry");
      i += 2;
    } else if (arg === "--state") {
      out.stateFile = requireFlagValue(args, i, "--state");
      i += 2;
    } else if (arg === "--cap-file") {
      out.capFile = requireFlagValue(args, i, "--cap-file");
      i += 2;
    } else if (arg === "--emit-capability") {
      out.emitCapability = true;
      i += 1;
    } else if (arg === "--output") {
      out.output = parseOutputFormat(requireFlagValue(args, i, "--output"));
      i += 2;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown execute flag ${arg}`);
    } else {
      script.push(arg);
      i += 1;
    }
  }
  if (script.length > 1) throw new Error("execute accepts at most one TypeScript file");
  if (script.length === 1) {
    out.file = script[0];
  }
  return out;
}

function parseSourceArgs(
  args: string[],
  out: {
    file?: string;
    name?: string | null;
    input: unknown;
    target?: string;
    detach?: boolean;
    emitCapability?: boolean;
    tools?: boolean;
    output?: OutputFormat;
    runSecrets: RunSecrets;
  },
  flags: { detach: boolean; emitCapability: boolean; output: boolean; tools: boolean },
): void {
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "--detach" && flags.detach) {
      out.detach = true;
      i += 1;
    } else if (arg === "--emit-capability" && flags.emitCapability) {
      out.emitCapability = true;
      i += 1;
    } else if (arg === "--tools" && flags.tools) {
      out.tools = true;
      i += 1;
    } else if (arg === "--output" && flags.output) {
      out.output = parseOutputFormat(requireFlagValue(args, i, "--output"));
      i += 2;
    } else if (arg === "--name") {
      out.name = requireFlagValue(args, i, "--name");
      i += 2;
    } else if (arg === "--input") {
      out.input = parseLaunchInput(requireFlagValue(args, i, "--input"));
      i += 2;
    } else if (arg === "--target") {
      out.target = resolve(cliTargetPath(requireFlagValue(args, i, "--target")));
      i += 2;
    } else if (arg === "--secret") {
      addCliRunSecret(out.runSecrets, requireFlagValue(args, i, "--secret"), "--secret");
      i += 2;
    } else if (arg === "--secret-env") {
      addCliRunSecretFromEnv(
        out.runSecrets,
        requireFlagValue(args, i, "--secret-env"),
        "--secret-env",
      );
      i += 2;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown flag ${arg}`);
    } else {
      positional.push(arg);
      i += 1;
    }
  }
  if (positional.length > 1) {
    throw new Error(`unexpected argument ${positional[1]}; workflow input must use --input`);
  }
  if (positional.length === 1) {
    const file = positional[0] as string;
    if (looksLikeWorkflowInput(file)) {
      throw new Error(`unexpected argument ${file}; workflow input must use --input`);
    }
    out.file = file;
  }
}

function looksLikeWorkflowInput(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

export function parseLaunchInput(inputJson: string | undefined): unknown {
  if (inputJson === undefined) return {};
  if (inputJson.trim() === "") {
    throw new Error("launch input must be valid JSON; omit it for {}");
  }
  return JSON.parse(inputJson);
}

function addCliRunSecret(out: RunSecrets, assignment: string, flag: string): void {
  const equals = assignment.indexOf("=");
  if (equals <= 0) throw new Error(`${flag} must use NAME=VALUE`);
  const name = assignment.slice(0, equals);
  const value = assignment.slice(equals + 1);
  setCliRunSecret(out, name, value, flag);
}

function addCliRunSecretFromEnv(out: RunSecrets, assignment: string, flag: string): void {
  const equals = assignment.indexOf("=");
  const name = equals === -1 ? assignment : assignment.slice(0, equals);
  const source = equals === -1 ? assignment : assignment.slice(equals + 1);
  if (name.length === 0) throw new Error(`${flag} must specify a secret name`);
  if (source.length === 0) throw new Error(`${flag} must specify an environment variable name`);
  const value = process.env[source];
  if (value === undefined)
    throw new Error(`${flag} source environment variable ${source} is not set`);
  setCliRunSecret(out, name, value, flag);
}

function setCliRunSecret(out: RunSecrets, name: string, value: string, flag: string): void {
  validateEnvironmentName(name, `${flag} name`);
  if (Object.prototype.hasOwnProperty.call(out, name)) {
    throw new Error(`${flag} specifies duplicate secret ${name}`);
  }
  out[name] = value;
}

function nonEmptyRunSecrets(runSecrets: RunSecrets): RunSecrets | undefined {
  return Object.keys(runSecrets).length > 0 ? runSecrets : undefined;
}

export function parseRunIdOutputArgs(
  args: string[],
  command: string,
  defaultOutput: OutputFormat,
  allowed: readonly OutputFormat[],
): { runId?: string; output: OutputFormat } {
  let output = defaultOutput;
  const positional: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "--output") {
      output = parseOutputFormat(requireFlagValue(args, i, "--output"));
      i += 2;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown ${command} flag ${arg}`);
    } else {
      positional.push(arg);
      i += 1;
    }
  }
  if (!allowed.includes(output)) {
    throw new Error(`--output ${output} is not available for ${command}`);
  }
  if (positional.length > 1) {
    throw new Error(`unexpected argument ${positional[1]} for ${command}`);
  }
  return { runId: positional[0], output };
}

function assertToolsAllowed(
  command: string,
  tools: boolean,
  output: OutputFormat,
  detached: boolean,
): void {
  if (!tools) return;
  if (detached || output !== "text") {
    throw new Error(`--tools is only available for attached ${command} --output text`);
  }
}

function launchOutputMode(
  command: string,
  requested: OutputFormat | undefined,
  detach: boolean,
): OutputFormat {
  const output = requested ?? (detach ? "json" : "ndjson");
  if (detach && output === "ndjson") {
    throw new Error(`--output ndjson is not available for ${command} --detach`);
  }
  if (!detach && output === "json") {
    throw new Error(`--output json is not available for attached ${command}`);
  }
  return output;
}

async function finishLaunchCommand(
  client: DaemonClient,
  launched: RunLaunchResult,
  opts: { output: OutputFormat; detach: boolean; emitCapability: boolean; tools: boolean },
): Promise<number> {
  const capability = prepareLaunchCapability(launched, opts.emitCapability);
  if (launched.capability) await client.authenticate(launched.capability);
  if (opts.detach) {
    process.stdout.write(
      opts.output === "json"
        ? `${JSON.stringify(capability.payload)}\n`
        : formatLaunchText(capability.payload),
    );
    return 0;
  }
  if (opts.output === "text") {
    process.stdout.write(formatRunHeader(launched.runId));
    process.stdout.write(formatLaunchCapabilityText(capability.payload));
  } else if (opts.output === "ndjson") {
    process.stdout.write(
      `${JSON.stringify({
        seq: 0,
        type: "launch.started",
        payload: capability.payload,
        atMs: Date.now(),
      })}\n`,
    );
  }
  const terminal = await watchRun(client, launched.runId, {
    output: opts.output,
    tools: opts.tools,
    cursor: launched.attachCursor,
  });
  return statusExitCode(terminal);
}

async function finishRunCommand(
  client: DaemonClient,
  launched: RunLaunchResult,
  opts: { output: OutputFormat; tools: boolean },
): Promise<number> {
  const capability = prepareLaunchCapability(launched, false);
  if (launched.capability) await client.authenticate(launched.capability);
  if (opts.output === "json") {
    const outcome = await client.waitForRun(launched.runId);
    const blockage = isParked(outcome.status) ? await client.getBlockage(launched.runId) : null;
    process.stdout.write(`${JSON.stringify(runEnvelope(outcome, capability.payload, blockage))}\n`);
    return statusExitCode(outcome.status);
  }
  if (opts.output === "text") process.stdout.write(`run ${launched.runId}\n`);
  const terminal = await watchRun(client, launched.runId, {
    output: opts.output,
    tools: opts.tools,
    cursor: launched.attachCursor,
  });
  return statusExitCode(terminal);
}

export function resolveWorkflowPath(workflow: string, cwd = process.cwd()): string {
  if (workflow.startsWith("file:")) return fileURLToPath(workflow);
  return resolve(cwd, workflow);
}

export function workflowName(workflowUrl: string): string {
  const path = workflowUrl.startsWith("file:") ? fileURLToPath(workflowUrl) : workflowUrl;
  return basename(path) || "workflow";
}

interface CapturedCommandSource {
  source: WorkflowSourceInput;
  defaultName: string | null;
  provenance: WorkflowProvenance;
}

async function readWorkflowSource(file: string | undefined): Promise<CapturedCommandSource> {
  if (file) {
    const path = resolveWorkflowPath(file);
    const captured = captureWorkflowFile(path);
    return {
      source: captured.source,
      defaultName: captured.name,
      provenance: captured.provenance,
    };
  }
  if (process.stdin.isTTY) {
    throw new Error("no workflow source: pass a file or pipe stdin");
  }
  return {
    source: await new Response(Bun.stdin.stream()).text(),
    defaultName: null,
    provenance: { kind: "stdin" },
  };
}

async function readControlScriptSource(file: string | undefined): Promise<string> {
  if (file) return readFileSync(resolveWorkflowPath(file), "utf8");
  if (process.stdin.isTTY) {
    throw new Error("no control script source: pass a file or pipe stdin");
  }
  return await new Response(Bun.stdin.stream()).text();
}

function isParked(status: string): boolean {
  return status.startsWith("waiting-") || status === "interrupted";
}

function statusExitCode(status: string): number {
  if (status === "failed") return 1;
  return status === "finished" || status === "continued" ? 0 : 3;
}

function parkedStatus(payload: unknown): WatchStatus {
  const kind = prop(payload, "kind");
  if (kind === "timer") return "waiting-timer";
  if (kind === "human") return "waiting-human";
  return "waiting-signal";
}

function runEnvelope(
  outcome: RunOutcome,
  capability: CapabilityOutput,
  blockage: unknown,
): Record<string, unknown> {
  return {
    runId: outcome.runId,
    ...("capability" in capability
      ? { capability: capability.capability }
      : { capabilityRef: capability.capabilityRef }),
    status: outcome.status,
    ...(outcome.output !== undefined ? { output: outcome.output } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(blockage ? { blockage } : {}),
  };
}

type CapabilityOutput = { capability: string | null } | { capabilityRef: string | null };

type LaunchCapabilityPayload = { runId: string } & CapabilityOutput;

function prepareLaunchCapability(
  launched: RunLaunchResult,
  emitCapability: boolean,
): { payload: LaunchCapabilityPayload } {
  if (emitCapability) {
    return { payload: { runId: launched.runId, capability: launched.capability ?? null } };
  }
  return {
    payload: {
      runId: launched.runId,
      capabilityRef: launched.capability
        ? writeCapabilityFile(launched.runId, launched.capability)
        : null,
    },
  };
}

function formatHumanOutput(output: unknown): string {
  if (typeof output === "string") return output.endsWith("\n") ? output : `${output}\n`;
  return `${JSON.stringify(output ?? null)}\n`;
}

function formatLaunchText(payload: {
  runId: string;
  capability?: string | null;
  capabilityRef?: string | null;
}): string {
  return [
    `run ${payload.runId}`,
    ...(payload.capabilityRef ? [`capability ${payload.capabilityRef}`] : []),
    ...(payload.capability ? [`capability ${payload.capability}`] : []),
    "",
  ].join("\n");
}

function formatLaunchCapabilityText(payload: LaunchCapabilityPayload): string {
  if ("capability" in payload)
    return payload.capability ? `capability ${payload.capability}\n` : "";
  return payload.capabilityRef ? `capability ${payload.capabilityRef}\n` : "";
}

export function formatRunReportText(report: RunReport): string {
  const lines = [
    `run ${compact(report.runId)}`,
    `status ${compact(report.status)}`,
    `workflow ${compact(displayName(report.workflowName))}`,
  ];
  if (report.outputOmitted) {
    lines.push(`output omitted ${report.outputByteLength ?? 0} bytes`);
  } else if ("output" in report) {
    lines.push(`output ${compact(report.output)}`);
  }
  if (report.error)
    lines.push(`error ${compact(report.error.name)}: ${compact(report.error.message)}`);
  if (report.blockage) {
    lines.push(`blockage ${compact(report.blockage.reason)}: ${compact(report.blockage.context)}`);
  }
  lines.push(
    `stats steps=${report.stats.steps} agents=${report.stats.agents} artifacts=${report.stats.artifacts}`,
  );
  for (const node of report.nodes) {
    const label = `${compact(node.stableKey)} ${compact(node.status)} ${compact(node.effectType)} attempt=${node.attempt}`;
    if (node.resultOmitted) {
      lines.push(`${label} result omitted ${node.resultByteLength ?? 0} bytes`);
    } else if ("result" in node) {
      lines.push(`${label} result ${compact(node.result)}`);
    } else {
      lines.push(label);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function formatScheduleList(schedules: readonly ScheduleSummary[], nowMs: number): string {
  return formatTable(
    ["NAME", "STATUS", "NEXT FIRE", "INTERVAL", "LAST RUN", "TARGET"],
    schedules.map((schedule) => [
      tableCell(schedule.name, { maxWidth: 28 }),
      schedule.enabled ? "enabled" : "disabled",
      schedule.enabled ? formatNextFire(schedule.nextFireMs, nowMs) : "-",
      formatDuration(0, schedule.intervalMs),
      schedule.lastRunStatus ?? schedule.lastRunId ?? "-",
      tableCell(schedule.target ?? "-", { maxWidth: 48 }),
    ]),
  );
}

export function formatScheduleShow(schedule: ScheduleView): string {
  const lines = [
    `name ${compact(schedule.name)}`,
    `status ${schedule.enabled ? "enabled" : "disabled"}`,
    `definition ${schedule.definitionState === "missing" ? "missing" : "available"}`,
    `workflowRef ${compact(schedule.workflowRef)}`,
    `workflowName ${compact(schedule.workflowName ?? "-")}`,
    `workflowKind ${compact(schedule.workflowKind ?? "-")}`,
    `target ${compact(schedule.target ?? "-")}`,
    `interval ${formatDuration(0, schedule.intervalMs)}`,
    `nextFire ${schedule.enabled ? formatUtcTimestamp(schedule.nextFireMs) : "-"}`,
    `lastRun ${compact(schedule.lastRunId ?? "-")}`,
    `lastRunStatus ${compact(schedule.lastRunStatus ?? "-")}`,
    `lastFailedAt ${schedule.lastFailedAtMs == null ? "-" : formatUtcTimestamp(schedule.lastFailedAtMs)}`,
    `input ${compact(schedule.input)}`,
  ];
  if (schedule.lastError.kind === "error") {
    const name = schedule.lastError.error.name ? `${schedule.lastError.error.name}: ` : "";
    lines.push(`lastError ${compact(`${name}${schedule.lastError.error.message}`)}`);
  } else if (schedule.lastError.kind === "parse-error") {
    lines.push(`lastError parse-error: ${compact(schedule.lastError.message)}`);
    lines.push(`lastErrorRaw ${compact(schedule.lastError.raw)}`);
  } else {
    lines.push("lastError none");
  }
  if ("source" in schedule) {
    if (schedule.source === null) {
      lines.push("source definition missing");
    } else if (schedule.source) {
      lines.push(`sourceEntry ${compact(schedule.source.entry)}`);
      for (const file of schedule.source.files) {
        lines.push(`sourceFile ${compact(file.path)}${file.entry ? " entry" : ""}`);
        lines.push(file.code.endsWith("\n") ? file.code.slice(0, -1) : file.code);
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatNextFire(nextFireMs: number, nowMs: number): string {
  if (nextFireMs <= nowMs) return "due";
  return `in ${formatDuration(0, nextFireMs - nowMs)}`;
}

export function formatRunHeader(runId: string): string {
  return `run ${runId}\n`;
}

export function parseWatchArgs(args: string[]): {
  runId?: string;
  output: OutputFormat;
  tools: boolean;
  cursor: EventCursorInput;
} {
  let output: OutputFormat = "ndjson";
  let tools = false;
  let cursor: EventCursorInput = { kind: "beginning" };
  let cursorFlag: string | null = null;
  const positional: string[] = [];
  const setCursor = (flag: string, next: EventCursorInput): void => {
    if (cursorFlag) throw new Error(`${flag} cannot be combined with ${cursorFlag}`);
    cursorFlag = flag;
    cursor = next;
  };
  let i = 0;
  while (i < args.length) {
    const arg = args[i] as string;
    if (arg === "--output") {
      output = parseOutputFormat(requireFlagValue(args, i, "--output"));
      i += 2;
    } else if (arg === "--from") {
      const value = requireFlagValue(args, i, "--from");
      if (value !== "beginning" && value !== "now") {
        throw new Error("--from must be beginning or now");
      }
      setCursor("--from", { kind: value });
      i += 2;
    } else if (arg === "--after-seq") {
      setCursor("--after-seq", {
        kind: "after-seq",
        seq: parseNonnegativeInteger(requireFlagValue(args, i, "--after-seq"), "--after-seq"),
      });
      i += 2;
    } else if (arg === "--tail") {
      setCursor("--tail", {
        kind: "tail",
        count: parseNonnegativeInteger(requireFlagValue(args, i, "--tail"), "--tail"),
      });
      i += 2;
    } else if (arg === "--tools") {
      tools = true;
      i += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown watch flag ${arg}`);
    } else {
      positional.push(arg);
      i += 1;
    }
  }
  if (output === "json") throw new Error("--output json is not available for watch");
  if (tools && output !== "text") {
    throw new Error("--tools is only available for attached watch --output text");
  }
  if (positional.length > 1) {
    throw new Error(`unexpected argument ${positional[1]} for watch`);
  }
  return { runId: positional[0], output, tools, cursor };
}

type WatchStatus = RunOutcome["status"];

async function handleProfiles(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const client = await openClient();
  switch (sub) {
    case "list": {
      const parsed = parseProfilesListArgs(rest);
      const profiles = await client.listAgentProfiles({ source: parsed.source });
      if (parsed.output === "json") process.stdout.write(`${JSON.stringify(profiles, null, 2)}\n`);
      else process.stdout.write(formatProfileList(profiles));
      return 0;
    }
    case "get": {
      const parsed = parseProfileNameOutputArgs(rest, "profiles get");
      if (!parsed.name) return usage("profiles needs get <name> [--output text|json]");
      const profile = await client.getAgentProfile(parsed.name);
      if (!profile) throw new Error(`agent profile "${parsed.name}" does not exist`);
      if (parsed.output === "json") process.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
      else process.stdout.write(formatProfileGet(profile));
      return 0;
    }
    case "set": {
      const parsed = parseProfilesSetArgs(rest);
      if (!parsed.name || !parsed.file) {
        return usage(
          "profiles needs set <name> --file <path|-> [--if-generation n] [--create] [--update]",
        );
      }
      const config = JSON.parse(await readJsonInput(parsed.file));
      const saved = await client.putAgentProfile({
        name: parsed.name,
        config,
        ...(parsed.ifGeneration !== undefined ? { ifGeneration: parsed.ifGeneration } : {}),
        ...(parsed.createOnly ? { createOnly: true } : {}),
        ...(parsed.updateOnly ? { updateOnly: true } : {}),
      });
      process.stdout.write(`${JSON.stringify(saved, null, 2)}\n`);
      return 0;
    }
    case "delete": {
      const parsed = parseProfilesDeleteArgs(rest);
      if (!parsed.name) return usage("profiles needs delete <name> [--if-generation n]");
      const deleted = await client.deleteAgentProfile({
        name: parsed.name,
        ...(parsed.ifGeneration !== undefined ? { ifGeneration: parsed.ifGeneration } : {}),
      });
      process.stdout.write(`${JSON.stringify(deleted)}\n`);
      return 0;
    }
    case "check": {
      const parsed = parseProfilesCheckArgs(rest);
      if ((parsed.name === undefined) === (parsed.file === undefined)) {
        return usage("profiles needs check <name> OR check --file <path|->");
      }
      const result = await client.checkAgentProfile(
        parsed.file !== undefined
          ? { config: JSON.parse(await readJsonInput(parsed.file)), connect: parsed.connect }
          : { name: parsed.name, connect: parsed.connect },
      );
      if (parsed.output === "json") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(formatProfileCheck(result));
      return result.ok ? 0 : 1;
    }
    default:
      return usage("profiles needs list|get|set|delete|check");
  }
}

async function handleSettings(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const client = await openClient();
  switch (sub) {
    case "list": {
      const parsed = parseSettingsOutputArgs(rest, "settings list");
      if (parsed.key) return usage("settings needs list [--output text|json]");
      const settings = await client.listSettings();
      if (parsed.output === "json") process.stdout.write(`${JSON.stringify(settings, null, 2)}\n`);
      else process.stdout.write(formatSettingsList(settings));
      return 0;
    }
    case "get": {
      const parsed = parseSettingsOutputArgs(rest, "settings get");
      if (!parsed.key) return usage("settings needs get <key> [--output text|json]");
      const setting = await client.getSetting(parsed.key);
      if (!setting) throw new Error(`unknown setting "${parsed.key}"`);
      if (parsed.output === "json") process.stdout.write(`${JSON.stringify(setting, null, 2)}\n`);
      else process.stdout.write(formatSettingGet(setting));
      return 0;
    }
    case "set": {
      const parsed = parseSettingsMutationArgs(rest, "settings set", true);
      if (!parsed.key || parsed.valueText === undefined) {
        return usage("settings needs set <key> <json-value> [--if-generation n]");
      }
      const saved = await client.putSetting({
        key: parsed.key,
        value: parseJsonArgument(parsed.valueText, "json-value"),
        ...(parsed.ifGeneration !== undefined ? { ifGeneration: parsed.ifGeneration } : {}),
      });
      process.stdout.write(`${JSON.stringify(saved, null, 2)}\n`);
      return 0;
    }
    case "unset": {
      const parsed = parseSettingsMutationArgs(rest, "settings unset", false);
      if (!parsed.key) return usage("settings needs unset <key> [--if-generation n]");
      const result = await client.deleteSetting({
        key: parsed.key,
        ...(parsed.ifGeneration !== undefined ? { ifGeneration: parsed.ifGeneration } : {}),
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return 0;
    }
    case "check": {
      const parsed = parseSettingsOutputArgs(rest, "settings check");
      if (!parsed.key || parsed.valueText === undefined) {
        return usage("settings needs check <key> <json-value> [--output text|json]");
      }
      const result = await client.checkSetting({
        key: parsed.key,
        value: parseJsonArgument(parsed.valueText, "json-value"),
      });
      if (parsed.output === "json") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(formatSettingsCheck(result));
      return result.ok ? 0 : 1;
    }
    default:
      return usage("settings needs list|get|set|unset|check");
  }
}

function parseSettingsOutputArgs(
  args: string[],
  command: string,
): { key?: string; valueText?: string; output: "text" | "json" } {
  let output: "text" | "json" = "text";
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--output") {
      output = parseTextJsonOutput(requireFlagValue(args, i, "--output"));
      i += 1;
    } else if (arg.startsWith("--")) throw new Error(`unknown ${command} flag ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 2) throw new Error(`unexpected argument ${positional[2]} for ${command}`);
  return { key: positional[0], valueText: positional[1], output };
}

function parseSettingsMutationArgs(
  args: string[],
  command: string,
  needsValue: boolean,
): { key?: string; valueText?: string; ifGeneration?: number } {
  const positional: string[] = [];
  let ifGeneration: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--if-generation") {
      ifGeneration = parseNonnegativeInteger(
        requireFlagValue(args, i, "--if-generation"),
        "--if-generation",
      );
      i += 1;
    } else if (arg.startsWith("--")) throw new Error(`unknown ${command} flag ${arg}`);
    else positional.push(arg);
  }
  const max = needsValue ? 2 : 1;
  if (positional.length > max)
    throw new Error(`unexpected argument ${positional[max]} for ${command}`);
  return { key: positional[0], valueText: positional[1], ifGeneration };
}

function parseJsonArgument(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(
      `${label} must be valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function parseProfilesListArgs(args: string[]): {
  source: "all" | "catalog" | "programmatic";
  output: "text" | "json";
} {
  let source: "all" | "catalog" | "programmatic" = "all";
  let output: "text" | "json" = "text";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--source") {
      const value = requireFlagValue(args, i, "--source");
      if (value !== "all" && value !== "catalog" && value !== "programmatic") {
        throw new Error("--source must be all, catalog, or programmatic");
      }
      source = value;
      i += 1;
    } else if (arg === "--output") {
      output = parseTextJsonOutput(requireFlagValue(args, i, "--output"));
      i += 1;
    } else {
      throw new Error(`unknown profiles list flag ${arg}`);
    }
  }
  return { source, output };
}

function parseProfileNameOutputArgs(
  args: string[],
  command: string,
): { name?: string; output: "text" | "json" } {
  let output: "text" | "json" = "text";
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--output") {
      output = parseTextJsonOutput(requireFlagValue(args, i, "--output"));
      i += 1;
    } else if (arg.startsWith("--")) throw new Error(`unknown ${command} flag ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new Error(`unexpected argument ${positional[1]} for ${command}`);
  return { name: positional[0], output };
}

function parseProfilesSetArgs(args: string[]): {
  name?: string;
  file?: string;
  ifGeneration?: number;
  createOnly?: boolean;
  updateOnly?: boolean;
} {
  const positional: string[] = [];
  let file: string | undefined;
  let ifGeneration: number | undefined;
  let createOnly = false;
  let updateOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--file") {
      file = requireFlagValue(args, i, "--file");
      i += 1;
    } else if (arg === "--if-generation") {
      ifGeneration = parseNonnegativeInteger(
        requireFlagValue(args, i, "--if-generation"),
        "--if-generation",
      );
      i += 1;
    } else if (arg === "--create") createOnly = true;
    else if (arg === "--update") updateOnly = true;
    else if (arg.startsWith("--")) throw new Error(`unknown profiles set flag ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1)
    throw new Error(`unexpected argument ${positional[1]} for profiles set`);
  return { name: positional[0], file, ifGeneration, createOnly, updateOnly };
}

function parseProfilesDeleteArgs(args: string[]): { name?: string; ifGeneration?: number } {
  const positional: string[] = [];
  let ifGeneration: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--if-generation") {
      ifGeneration = parseNonnegativeInteger(
        requireFlagValue(args, i, "--if-generation"),
        "--if-generation",
      );
      i += 1;
    } else if (arg.startsWith("--")) throw new Error(`unknown profiles delete flag ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1)
    throw new Error(`unexpected argument ${positional[1]} for profiles delete`);
  return { name: positional[0], ifGeneration };
}

function parseProfilesCheckArgs(args: string[]): {
  name?: string;
  file?: string;
  connect: boolean;
  output: "text" | "json";
} {
  const positional: string[] = [];
  let file: string | undefined;
  let connect = false;
  let output: "text" | "json" = "text";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--file") {
      file = requireFlagValue(args, i, "--file");
      i += 1;
    } else if (arg === "--connect") connect = true;
    else if (arg === "--output") {
      output = parseTextJsonOutput(requireFlagValue(args, i, "--output"));
      i += 1;
    } else if (arg.startsWith("--")) throw new Error(`unknown profiles check flag ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1)
    throw new Error(`unexpected argument ${positional[1]} for profiles check`);
  return { name: positional[0], file, connect, output };
}

function parseTextJsonOutput(value: string): "text" | "json" {
  if (value === "text" || value === "json") return value;
  throw new Error("--output must be text or json");
}

async function handleWorkflow(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  let client: DaemonClient | null = null;
  const getClient = async (): Promise<DaemonClient> => {
    client ??= await openClient();
    return client;
  };
  switch (sub) {
    case "save": {
      const parsed = parseWorkflowSaveArgs(rest);
      if (!parsed.name) return usage("workflow needs save <name> [workflow.ts]");
      const captured = await readWorkflowSource(parsed.file);
      const client = await getClient();
      const saved = await client.saveWorkflow({
        name: parsed.name,
        source: captured.source,
        workflowName: parsed.workflowName ?? captured.defaultName,
        provenance: captured.provenance,
        title: parsed.title,
        description: parsed.description,
        tags: parsed.tags,
        ...(parsed.inputSchemaFile
          ? { inputSchema: JSON.parse(readFileSync(parsed.inputSchemaFile, "utf8")) }
          : {}),
        ...(parsed.defaultInput !== undefined ? { defaultInput: parsed.defaultInput } : {}),
        defaultTarget: parsed.defaultTarget,
        ...(parsed.version !== undefined ? { version: parsed.version } : {}),
        allowDuplicateDefinition: parsed.allowDuplicateDefinition,
        ...(parsed.reviewRun && parsed.reviewKey
          ? { reviewApproval: { runId: parsed.reviewRun, key: parsed.reviewKey } }
          : {}),
      });
      process.stdout.write(
        `${JSON.stringify({
          name: saved.name,
          version: saved.version,
          definitionHash: saved.definitionHash,
          workflowName: saved.workflowName,
          createdAtMs: saved.createdAtMs,
        })}\n`,
      );
      return 0;
    }
    case "install": {
      const parsed = parseWorkflowInstallArgs(rest);
      if (!parsed.packageName) return usage("workflow needs install <package>");
      if (parsed.packageName !== TASK_REVIEW_GUIDANCE_PACKAGE) {
        throw new Error(`unknown workflow package "${parsed.packageName}"`);
      }
      const client = await getClient();
      const result = await installWorkflowPackage(client, parsed);
      if (parsed.output === "json") process.stdout.write(`${JSON.stringify(result)}\n`);
      else process.stdout.write(formatWorkflowInstallResult(result));
      return result.workflows.some(
        (workflow) => workflow.status === "failed" || workflow.status === "conflict",
      )
        ? 1
        : 0;
    }
    case "list": {
      const parsed = parseWorkflowListArgs(rest);
      const client = await getClient();
      const workflows = await client.listSavedWorkflows({
        includeDisabled: parsed.all,
        includeDeleted: parsed.all,
        includeDeprecated: parsed.deprecated || parsed.all,
      });
      if (parsed.output === "json") process.stdout.write(`${JSON.stringify({ workflows })}\n`);
      else process.stdout.write(formatWorkflowList(workflows));
      return 0;
    }
    case "show": {
      const parsed = parseWorkflowShowArgs(rest);
      if (!parsed.name) return usage("workflow needs show <name>");
      const client = await getClient();
      if (parsed.source)
        return printWorkflowSource(client, { kind: "saved", name: parsed.name }, parsed);
      const workflow = await client.getSavedWorkflow(parsed.name);
      if (!workflow) throw new Error(`saved workflow "${parsed.name}" does not exist`);
      if (parsed.output === "json") process.stdout.write(`${JSON.stringify(workflow, null, 2)}\n`);
      else process.stdout.write(formatWorkflowShow(workflow));
      return 0;
    }
    case "source": {
      const parsed = parseWorkflowSourceArgs(rest);
      const client = await getClient();
      return printWorkflowSource(client, parsed.selector, parsed);
    }
    case "launch": {
      const parsed = parseWorkflowLaunchArgs(rest);
      if (!parsed.name) return usage("workflow needs launch <name>");
      const output = launchOutputMode("workflow launch", parsed.output, parsed.detach);
      assertToolsAllowed("workflow launch", parsed.tools, output, parsed.detach);
      const client = await getClient();
      const launched = await client.launchSavedWorkflow({
        ref: {
          name: parsed.name,
          version: parsed.version,
          allowDeprecated: parsed.allowDeprecated,
        },
        ...(parsed.input !== undefined ? { input: parsed.input } : {}),
        ...(parsed.target !== undefined ? { target: parsed.target } : {}),
        name: parsed.runName ?? null,
        ...(nonEmptyRunSecrets(parsed.runSecrets) !== undefined
          ? { runSecrets: parsed.runSecrets }
          : {}),
      });
      return finishLaunchCommand(client, launched, {
        output,
        detach: parsed.detach,
        emitCapability: parsed.emitCapability,
        tools: parsed.tools,
      });
    }
    case "run": {
      const parsed = parseWorkflowRunArgs(rest);
      if (!parsed.name) return usage("workflow needs run <name>");
      const output = parsed.output ?? "json";
      assertToolsAllowed("workflow run", parsed.tools, output, false);
      const client = await getClient();
      const launched = await client.launchSavedWorkflow({
        ref: {
          name: parsed.name,
          version: parsed.version,
          allowDeprecated: parsed.allowDeprecated,
        },
        ...(parsed.input !== undefined ? { input: parsed.input } : {}),
        ...(parsed.target !== undefined ? { target: parsed.target } : {}),
        name: parsed.runName ?? null,
        ...(nonEmptyRunSecrets(parsed.runSecrets) !== undefined
          ? { runSecrets: parsed.runSecrets }
          : {}),
      });
      return finishRunCommand(client, launched, { output, tools: parsed.tools });
    }
    case "disable":
    case "enable": {
      const [name] = rest;
      if (!name) return usage(`workflow needs ${sub} <name>`);
      const client = await getClient();
      process.stdout.write(
        `${JSON.stringify(await client.setSavedWorkflowDisabled(name, sub === "disable"))}\n`,
      );
      return 0;
    }
    case "disable-version":
    case "enable-version": {
      const [name, versionText] = rest;
      if (!name || !versionText) return usage(`workflow needs ${sub} <name> <version>`);
      const version = parsePositiveInteger(versionText, "version");
      const client = await getClient();
      process.stdout.write(
        `${JSON.stringify(await client.setSavedWorkflowVersionEnabled(name, version, sub === "enable-version"))}\n`,
      );
      return 0;
    }
    case "deprecate": {
      const [name, versionText, ...message] = rest;
      if (!name || !versionText)
        return usage("workflow needs deprecate <name> <version> [message]");
      const version = parsePositiveInteger(versionText, "version");
      const client = await getClient();
      process.stdout.write(
        `${JSON.stringify(await client.deprecateSavedWorkflowVersion({ name, version, message: message.join(" ") || null }))}\n`,
      );
      return 0;
    }
    case "delete":
    case "delete-version": {
      if (!rest.includes("--yes")) return usage(`workflow ${sub} requires --yes`);
      const positional = rest.filter((arg) => arg !== "--yes");
      const [name, versionText] = positional;
      if (!name)
        return usage(
          `workflow needs ${sub} <name> ${sub === "delete-version" ? "<version> " : ""}--yes`,
        );
      const client = await getClient();
      if (sub === "delete")
        process.stdout.write(`${JSON.stringify(await client.deleteSavedWorkflow(name))}\n`);
      else {
        if (!versionText) return usage("workflow needs delete-version <name> <version> --yes");
        process.stdout.write(
          `${JSON.stringify(await client.deleteSavedWorkflowVersion(name, parsePositiveInteger(versionText, "version")))}\n`,
        );
      }
      return 0;
    }
    default:
      return usage(
        "workflow needs save|install|list|show|source|launch|run|disable|enable|deprecate|delete",
      );
  }
}

function parseWorkflowVersion(value: string): number | "latest" {
  if (value === "latest") return "latest";
  return parsePositiveInteger(value, "--version");
}

function parsePositiveInteger(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${label} must be a positive integer`);
  return n;
}

function parseWorkflowSaveArgs(args: string[]): {
  name?: string;
  file?: string;
  title?: string | null;
  description?: string | null;
  tags: string[];
  inputSchemaFile?: string;
  defaultInput?: unknown;
  defaultTarget?: string | null;
  workflowName?: string | null;
  version?: number;
  allowDuplicateDefinition: boolean;
  reviewRun?: string;
  reviewKey?: string;
} {
  const out: {
    name?: string;
    file?: string;
    title?: string | null;
    description?: string | null;
    tags: string[];
    inputSchemaFile?: string;
    defaultInput?: unknown;
    defaultTarget?: string | null;
    workflowName?: string | null;
    version?: number;
    allowDuplicateDefinition: boolean;
    reviewRun?: string;
    reviewKey?: string;
  } = { tags: [], allowDuplicateDefinition: false };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--title") out.title = requireFlagValue(args, i++, "--title");
    else if (arg === "--description")
      out.description = requireFlagValue(args, i++, "--description");
    else if (arg === "--tag") out.tags.push(requireFlagValue(args, i++, "--tag"));
    else if (arg === "--input-schema")
      out.inputSchemaFile = requireFlagValue(args, i++, "--input-schema");
    else if (arg === "--default-input")
      out.defaultInput = parseLaunchInput(requireFlagValue(args, i++, "--default-input"));
    else if (arg === "--default-target")
      out.defaultTarget = resolve(cliTargetPath(requireFlagValue(args, i++, "--default-target")));
    else if (arg === "--workflow-name")
      out.workflowName = requireFlagValue(args, i++, "--workflow-name");
    else if (arg === "--version")
      out.version = parsePositiveInteger(requireFlagValue(args, i++, "--version"), "--version");
    else if (arg === "--allow-duplicate-definition") out.allowDuplicateDefinition = true;
    else if (arg === "--review-run") out.reviewRun = requireFlagValue(args, i++, "--review-run");
    else if (arg === "--review-key") out.reviewKey = requireFlagValue(args, i++, "--review-key");
    else if (arg.startsWith("--")) throw new Error(`unknown workflow save flag ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 2)
    throw new Error(`unexpected argument ${positional[2]} for workflow save`);
  if ((out.reviewRun === undefined) !== (out.reviewKey === undefined)) {
    throw new Error("workflow save requires --review-run and --review-key together");
  }
  out.name = positional[0];
  out.file = positional[1];
  return out;
}

type WorkflowInstallStatus = "created" | "unchanged" | "conflict" | "failed";

interface WorkflowInstallEntryResult {
  name: string;
  status: WorkflowInstallStatus;
  definitionHash?: string;
  version?: number;
  message?: string;
}

interface WorkflowInstallResult {
  package: string;
  workflows: WorkflowInstallEntryResult[];
}

function parseWorkflowInstallArgs(args: string[]): {
  packageName?: string;
  version?: number;
  allowDuplicateDefinition: boolean;
  output: "text" | "json";
} {
  const positional: string[] = [];
  let version: number | undefined;
  let allowDuplicateDefinition = false;
  let output: "text" | "json" = "text";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--version")
      version = parsePositiveInteger(requireFlagValue(args, i++, "--version"), "--version");
    else if (arg === "--allow-duplicate-definition") allowDuplicateDefinition = true;
    else if (arg === "--output")
      output = parseTextJsonOutput(requireFlagValue(args, i++, "--output"));
    else if (arg.startsWith("--")) throw new Error(`unknown workflow install flag ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1)
    throw new Error(`unexpected argument ${positional[1]} for workflow install`);
  return {
    packageName: positional[0],
    ...(version !== undefined ? { version } : {}),
    allowDuplicateDefinition,
    output,
  };
}

async function installWorkflowPackage(
  client: DaemonClient,
  opts: {
    packageName?: string;
    version?: number;
    allowDuplicateDefinition: boolean;
    output: "text" | "json";
  },
): Promise<WorkflowInstallResult> {
  if (opts.packageName !== TASK_REVIEW_GUIDANCE_PACKAGE) {
    throw new Error(`unknown workflow package "${opts.packageName}"`);
  }
  const root = keelPackageRoot();
  const existing = new Map(
    (
      await client.listSavedWorkflows({
        includeDisabled: true,
        includeDeprecated: true,
        includeDeleted: true,
      })
    ).map((workflow) => [workflow.name, workflow]),
  );
  const workflows: WorkflowInstallEntryResult[] = [];
  for (const entry of TASK_REVIEW_WORKFLOWS) {
    const result = await installWorkflowPackageEntry(client, root, existing.get(entry.name), {
      entry,
      version: opts.version,
      allowDuplicateDefinition: opts.allowDuplicateDefinition,
    });
    workflows.push(result);
  }
  return { package: TASK_REVIEW_GUIDANCE_PACKAGE, workflows };
}

async function installWorkflowPackageEntry(
  client: DaemonClient,
  root: string,
  existing: Awaited<ReturnType<DaemonClient["listSavedWorkflows"]>>[number] | undefined,
  opts: {
    entry: (typeof TASK_REVIEW_WORKFLOWS)[number];
    version?: number;
    allowDuplicateDefinition: boolean;
  },
): Promise<WorkflowInstallEntryResult> {
  const file = join(root, opts.entry.file);
  try {
    if (!existsSync(file)) {
      throw new Error(
        `built-in workflow source ${opts.entry.file} is missing; workflow install requires a source-bearing Keel checkout/package. Set KEEL_PACKAGE_ROOT to the repository root if needed.`,
      );
    }
    const captured = captureWorkflowFile(file);
    const preview = await client.previewWorkflowDefinition({ source: captured.source });
    const definitionHash = preview.definitionHash;
    const requested = opts.version;
    if (requested !== undefined) {
      const existingVersion = existing?.versions.find((version) => version.version === requested);
      if (existingVersion?.deletedAtMs === null) {
        if (existingVersion.definitionHash === definitionHash) {
          return {
            name: opts.entry.name,
            version: requested,
            status: "unchanged",
            definitionHash,
          };
        }
        return {
          name: opts.entry.name,
          version: requested,
          status: "conflict",
          definitionHash,
          message: `version ${requested} already exists with a different definition hash`,
        };
      }
    } else {
      const latest = latestSavedWorkflowVersion(existing);
      if (latest && latest.definitionHash === definitionHash && !opts.allowDuplicateDefinition) {
        return {
          name: opts.entry.name,
          version: latest.version,
          status: "unchanged",
          definitionHash,
        };
      }
    }
    const saved = await client.saveWorkflow({
      name: opts.entry.name,
      source: captured.source,
      workflowName: opts.entry.workflowName,
      provenance: captured.provenance,
      title: opts.entry.title,
      description: opts.entry.description,
      tags: [...opts.entry.tags],
      inputSchema: opts.entry.inputSchema,
      ...(requested !== undefined ? { version: requested } : {}),
      allowDuplicateDefinition: opts.allowDuplicateDefinition,
    });
    return {
      name: saved.name,
      version: saved.version,
      status: "created",
      definitionHash: saved.definitionHash,
    };
  } catch (err) {
    return {
      name: opts.entry.name,
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function latestSavedWorkflowVersion(
  workflow: Awaited<ReturnType<DaemonClient["listSavedWorkflows"]>>[number] | undefined,
): Awaited<ReturnType<DaemonClient["listSavedWorkflows"]>>[number]["versions"][number] | null {
  return workflow?.versions.find((version) => version.deletedAtMs === null) ?? null;
}

function parseWorkflowListArgs(args: string[]): {
  all: boolean;
  deprecated: boolean;
  output: "text" | "json";
} {
  let all = false;
  let deprecated = false;
  let output: "text" | "json" = "text";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--all") all = true;
    else if (arg === "--deprecated") deprecated = true;
    else if (arg === "--output")
      output = parseTextJsonOutput(requireFlagValue(args, i++, "--output"));
    else throw new Error(`unknown workflow list flag ${arg}`);
  }
  return { all, deprecated, output };
}

function parseWorkflowShowArgs(args: string[]): {
  name?: string;
  version?: number | "latest";
  output: "text" | "json";
  source: boolean;
  all?: boolean;
} {
  let output: "text" | "json" = "text";
  let version: number | "latest" | undefined;
  let source = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--version")
      version = parseWorkflowVersion(requireFlagValue(args, i++, "--version"));
    else if (arg === "--output")
      output = parseTextJsonOutput(requireFlagValue(args, i++, "--output"));
    else if (arg === "--source") source = true;
    else if (arg.startsWith("--")) throw new Error(`unknown workflow show flag ${arg}`);
    else positional.push(arg);
  }
  return { name: positional[0], version, output, source };
}

function parseWorkflowSourceArgs(args: string[]): {
  selector:
    | { kind: "saved"; name: string }
    | { kind: "run"; runId: string }
    | { kind: "definition"; definitionHash: string };
  version?: number | "latest";
  file?: string;
  all?: boolean;
  output: "text" | "json";
} {
  let version: number | "latest" | undefined;
  let file: string | undefined;
  let all = false;
  let output: "text" | "json" = "text";
  let runId: string | undefined;
  let definitionHash: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--version")
      version = parseWorkflowVersion(requireFlagValue(args, i++, "--version"));
    else if (arg === "--file") file = requireFlagValue(args, i++, "--file");
    else if (arg === "--all") all = true;
    else if (arg === "--run") runId = requireFlagValue(args, i++, "--run");
    else if (arg === "--definition") definitionHash = requireFlagValue(args, i++, "--definition");
    else if (arg === "--output")
      output = parseTextJsonOutput(requireFlagValue(args, i++, "--output"));
    else if (arg.startsWith("--")) throw new Error(`unknown workflow source flag ${arg}`);
    else positional.push(arg);
  }
  if (file !== undefined && all) throw new Error("--file and --all are mutually exclusive");
  if (runId !== undefined && runId.length === 0) {
    throw new Error("workflow source --run needs a non-empty run id");
  }
  if (definitionHash !== undefined && !WORKFLOW_DEFINITION_HASH_RE.test(definitionHash)) {
    throw new Error("workflow definition hash must match wf_sha256_<64 hex chars>");
  }
  const selectorCount =
    positional.length + (runId !== undefined ? 1 : 0) + (definitionHash !== undefined ? 1 : 0);
  if (selectorCount === 0)
    throw new Error("workflow source requires a saved name, --run, or --definition");
  if (selectorCount !== 1) throw new Error("workflow source accepts exactly one selector");
  if (version !== undefined && (runId !== undefined || definitionHash !== undefined)) {
    throw new Error("--version is only valid with a saved workflow name");
  }
  const selector =
    runId !== undefined
      ? ({ kind: "run", runId } as const)
      : definitionHash !== undefined
        ? ({ kind: "definition", definitionHash } as const)
        : ({ kind: "saved", name: positional[0] as string } as const);
  return {
    selector,
    ...(version !== undefined ? { version } : {}),
    ...(file !== undefined ? { file } : {}),
    ...(all ? { all } : {}),
    output,
  };
}

interface WorkflowStartArgs {
  name?: string;
  version?: number | "latest";
  input?: unknown;
  target?: string;
  runName?: string | null;
  allowDeprecated?: boolean;
  output?: OutputFormat;
  tools: boolean;
  runSecrets: RunSecrets;
}

interface WorkflowLaunchArgs extends WorkflowStartArgs {
  detach: boolean;
  emitCapability: boolean;
}

export function parseWorkflowLaunchArgs(args: string[]): WorkflowLaunchArgs {
  return parseSavedWorkflowStartArgs(args, {
    detach: true,
    emitCapability: true,
    command: "workflow launch",
  }) as WorkflowLaunchArgs;
}

export function parseWorkflowRunArgs(args: string[]): WorkflowStartArgs {
  return parseSavedWorkflowStartArgs(args, {
    detach: false,
    emitCapability: false,
    command: "workflow run",
  });
}

function parseSavedWorkflowStartArgs(
  args: string[],
  flags: { detach: boolean; emitCapability: boolean; command: string },
): WorkflowStartArgs & {
  detach?: boolean;
  emitCapability?: boolean;
} {
  const out: WorkflowStartArgs & { detach?: boolean; emitCapability?: boolean } = {
    ...(flags.detach ? { detach: false } : {}),
    ...(flags.emitCapability ? { emitCapability: false } : {}),
    tools: false,
    runSecrets: {},
  };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--version")
      out.version = parseWorkflowVersion(requireFlagValue(args, i++, "--version"));
    else if (arg === "--input")
      out.input = parseLaunchInput(requireFlagValue(args, i++, "--input"));
    else if (arg === "--target")
      out.target = resolve(cliTargetPath(requireFlagValue(args, i++, "--target")));
    else if (arg === "--name") out.runName = requireFlagValue(args, i++, "--name");
    else if (arg === "--allow-deprecated") out.allowDeprecated = true;
    else if (arg === "--detach" && flags.detach) out.detach = true;
    else if (arg === "--emit-capability" && flags.emitCapability) out.emitCapability = true;
    else if (arg === "--output")
      out.output = parseOutputFormat(requireFlagValue(args, i++, "--output"));
    else if (arg === "--tools") out.tools = true;
    else if (arg === "--secret")
      addCliRunSecret(out.runSecrets, requireFlagValue(args, i++, arg), arg);
    else if (arg === "--secret-env")
      addCliRunSecretFromEnv(out.runSecrets, requireFlagValue(args, i++, arg), arg);
    else if (arg.startsWith("--")) throw new Error(`unknown ${flags.command} flag ${arg}`);
    else positional.push(arg);
  }
  out.name = positional[0];
  return out;
}

async function printWorkflowSource(
  client: DaemonClient,
  selector:
    | { kind: "saved"; name: string }
    | { kind: "run"; runId: string }
    | { kind: "definition"; definitionHash: string },
  opts: { version?: number | "latest"; file?: string; all?: boolean; output?: "text" | "json" },
): Promise<number> {
  const source =
    selector.kind === "saved"
      ? await client.getSavedWorkflowSource({
          name: selector.name,
          version: opts.version,
          file: opts.file,
          all: opts.all,
        })
      : await client.getWorkflowDefinitionSource({
          lookup:
            selector.kind === "run"
              ? { kind: "run", runId: selector.runId }
              : { kind: "definition", definitionHash: selector.definitionHash },
          ...(opts.file !== undefined ? { file: opts.file } : {}),
          ...(opts.all !== undefined ? { all: opts.all } : {}),
        });
  if (opts.output === "json") process.stdout.write(`${JSON.stringify(source, null, 2)}\n`);
  else if (source.files.length === 1 && !opts.all)
    process.stdout.write(source.files[0]?.code ?? "");
  else {
    process.stdout.write(source.files.map((file) => `--- ${file.path}\n${file.code}`).join("\n"));
    process.stdout.write("\n");
  }
  return 0;
}

function formatWorkflowList(
  workflows: Awaited<ReturnType<DaemonClient["listSavedWorkflows"]>>,
): string {
  return formatTable(
    ["NAME", "LATEST", "STATE", "TITLE", "DEFINITION"],
    workflows.map((workflow) => [
      workflow.name,
      workflow.latestVersion == null ? "-" : String(workflow.latestVersion),
      workflow.deletedAtMs ? "deleted" : workflow.disabledAtMs ? "disabled" : "enabled",
      workflow.title ?? "-",
      workflow.latestDefinitionHash ?? "-",
    ]),
  );
}

function formatWorkflowInstallResult(result: WorkflowInstallResult): string {
  return formatTable(
    ["PACKAGE", "NAME", "VERSION", "STATUS", "DEFINITION", "MESSAGE"],
    result.workflows.map((workflow) => [
      result.package,
      workflow.name,
      workflow.version === undefined ? "-" : String(workflow.version),
      workflow.status,
      workflow.definitionHash ?? "-",
      workflow.message ?? "-",
    ]),
  );
}

function formatWorkflowShow(
  workflow: Awaited<ReturnType<DaemonClient["getSavedWorkflow"]>> & {},
): string {
  if (!workflow) return "";
  const lines = [
    `name: ${workflow.name}`,
    `title: ${workflow.title ?? "-"}`,
    `description: ${workflow.description ?? "-"}`,
    `tags: ${workflow.tags.join(", ") || "-"}`,
    `state: ${workflow.deletedAtMs ? "deleted" : workflow.disabledAtMs ? "disabled" : "enabled"}`,
    "versions:",
  ];
  for (const version of workflow.versions) {
    lines.push(
      `  ${version.version}\t${version.enabled ? "enabled" : "disabled"}${version.deprecatedAtMs ? ",deprecated" : ""}\t${version.definitionHash}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function parseNonnegativeInteger(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer`);
  return n;
}

async function readJsonInput(path: string): Promise<string> {
  return path === "-" ? await Bun.stdin.text() : readFileSync(path, "utf8");
}

function formatProfileList(profiles: AgentProfileView[]): string {
  return formatTable(
    ["NAME", "SOURCE", "PROVIDER", "MODEL", "TOOL POLICY", "GENERATION", "UPDATED AT"],
    profiles.map((profile) => [
      profile.name,
      profile.source,
      profile.config.provider ?? "-",
      tableCell(profile.config.model ?? "-", { maxWidth: 40 }),
      profile.config.toolPolicy ?? "-",
      profile.generation == null ? "-" : String(profile.generation),
      profile.updatedAtMs == null ? "-" : formatUtcTimestamp(profile.updatedAtMs),
    ]),
  );
}

function formatSettingsList(settings: SettingView[]): string {
  return formatTable(
    ["KEY", "CLASS", "VALUE", "DEFAULT", "READONLY", "GENERATION", "UPDATED"],
    settings.map((setting) => [
      setting.key,
      setting.class,
      setting.isDefault ? "default" : settingText(setting.value),
      settingText(setting.defaultValue),
      setting.readOnly ? "yes" : "no",
      setting.generation == null ? "-" : String(setting.generation),
      setting.updatedAtMs == null ? "-" : formatUtcTimestamp(setting.updatedAtMs),
    ]),
  );
}

function formatSettingGet(setting: SettingView): string {
  return [
    `key: ${setting.key}`,
    `class: ${setting.class}`,
    `value: ${settingText(setting.value)}`,
    `defaultValue: ${settingText(setting.defaultValue)}`,
    `isDefault: ${setting.isDefault ? "yes" : "no"}`,
    `readOnly: ${setting.readOnly ? "yes" : "no"}`,
    `generation: ${setting.generation ?? "-"}`,
    `updatedAt: ${setting.updatedAtMs == null ? "-" : formatUtcTimestamp(setting.updatedAtMs)}`,
    `description: ${setting.description}`,
    "",
  ].join("\n");
}

function formatSettingsCheck(result: {
  ok: boolean;
  diagnostics: SettingsDiagnostic[];
}): string {
  const lines = [result.ok ? "ok" : "failed"];
  for (const diagnostic of result.diagnostics) {
    lines.push(`${diagnostic.level}\t${diagnostic.path}\t${diagnostic.message}`);
  }
  return `${lines.join("\n")}\n`;
}

function settingText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function formatProfileGet(profile: AgentProfileView): string {
  return [
    `name: ${profile.name}`,
    `source: ${profile.source}`,
    `configHash: ${profile.configHash}`,
    `generation: ${profile.generation ?? "-"}`,
    `createdAt: ${profile.createdAtMs == null ? "-" : formatUtcTimestamp(profile.createdAtMs)}`,
    `updatedAt: ${profile.updatedAtMs == null ? "-" : formatUtcTimestamp(profile.updatedAtMs)}`,
    "config:",
    JSON.stringify(profile.config, null, 2),
    "",
  ].join("\n");
}

function formatProfileCheck(result: AgentProfileCheckResult): string {
  const lines = [result.ok ? "ok" : "failed"];
  for (const diagnostic of result.diagnostics) {
    lines.push(`${diagnostic.level.toUpperCase()} ${diagnostic.path}: ${diagnostic.message}`);
  }
  return `${lines.join("\n")}\n`;
}

async function workspaceCommand(args: string[]): Promise<number> {
  const [sub, runId, workspaceId, ...rest] = args;
  const client = await openClient();
  switch (sub) {
    case "list": {
      if (!runId) return usage("workspace needs list <runId> [--all]");
      const all = rest.includes("--all") || args.slice(2).includes("--all");
      const workspaces = (await client.listRunWorkspaces(runId, { includeRemoved: all })).filter(
        (workspace) => all || workspace.workspaceId !== DEFAULT_WORKSPACE_ID,
      );
      process.stdout.write(`${JSON.stringify({ workspaces })}\n`);
      return 0;
    }
    case "show": {
      if (!runId || !workspaceId) return usage("workspace needs show <runId> <workspaceId>");
      process.stdout.write(
        `${JSON.stringify(await client.getRunWorkspace(runId, workspaceId), null, 2)}\n`,
      );
      return 0;
    }
    case "diff": {
      if (!runId || !workspaceId) return usage("workspace needs diff <runId> <workspaceId>");
      const out = await client.getRunWorkspaceDiff(runId, workspaceId);
      const json = rest[0] === "--output" && rest[1] === "json";
      if (rest.length > 0 && !json) throw new Error("workspace diff supports only --output json");
      if (json) process.stdout.write(`${JSON.stringify(out)}\n`);
      else process.stdout.write(out.contentDiff);
      return 0;
    }
    case "merge": {
      if (!runId || !workspaceId) return usage("workspace needs merge <runId> <workspaceId>");
      process.stdout.write(
        `${JSON.stringify(await client.mergeRunWorkspace(runId, workspaceId))}\n`,
      );
      return 0;
    }
    case "discard": {
      if (!runId || !workspaceId) return usage("workspace needs discard <runId> <workspaceId>");
      process.stdout.write(
        `${JSON.stringify(await client.discardRunWorkspace(runId, workspaceId))}\n`,
      );
      return 0;
    }
    case "gc": {
      let includePending = false;
      let includeRemoved = false;
      let olderThanMs: number | undefined;
      for (let i = 0; i < args.slice(1).length; i += 1) {
        const arg = args.slice(1)[i];
        if (arg === "--include-pending") includePending = true;
        else if (arg === "--include-removed") includeRemoved = true;
        else if (arg === "--older-than-ms") {
          const value = Number(args.slice(1)[i + 1]);
          if (!Number.isFinite(value) || value < 0)
            throw new Error("--older-than-ms must be non-negative");
          olderThanMs = value;
          i += 1;
        } else if (arg?.startsWith("--")) throw new Error(`unknown workspace gc flag ${arg}`);
      }
      process.stdout.write(
        `${JSON.stringify(await client.gcWorkspaces({ ...(olderThanMs !== undefined ? { olderThanMs } : {}), ...(includePending ? { includePending } : {}), ...(includeRemoved ? { includeRemoved } : {}) }))}\n`,
      );
      return 0;
    }
    default:
      return usage("workspace needs list|show|diff|merge|discard|gc");
  }
}

export async function watchRun(
  client: DaemonClient,
  runId: string,
  opts: WatchFormatOptions & { cursor?: EventCursorInput },
): Promise<WatchStatus> {
  return new Promise<WatchStatus>((resolve) => {
    let caughtUp = false;
    let settled = false;
    let pendingStatus: WatchStatus | null = null;
    let unsubscribe = () => {};
    const output = opts.output ?? "text";
    if (output !== "text" && output !== "ndjson") {
      throw new Error(`watchRun only supports text or ndjson output, got ${output}`);
    }
    const textFormatter = output === "text" ? createTextWatchFormatter(opts) : null;
    const flushTextFormatter = (): void => {
      if (!textFormatter) return;
      for (const chunk of textFormatter.flush()) process.stdout.write(chunk);
    };
    const finish = (status: WatchStatus): void => {
      if (settled) return;
      settled = true;
      flushTextFormatter();
      unsubscribe();
      resolve(status);
    };
    const noteStatus = (status: WatchStatus | null): void => {
      pendingStatus = status;
      if (caughtUp && status) finish(status);
    };
    unsubscribe = client.subscribeEvents(
      { runId, cursor: opts.cursor ?? { kind: "beginning" } },
      (e) => {
        if (textFormatter) {
          for (const chunk of textFormatter.push(e)) process.stdout.write(chunk);
        } else {
          process.stdout.write(formatNdjsonWatchEvent(e));
        }
        if (e.type === "run.finished") noteStatus("finished");
        else if (e.type === "run.failed") noteStatus("failed");
        else if (e.type === "run.continued") noteStatus("continued");
        else if (e.type === "run.parked") noteStatus(parkedStatus(e.payload));
        else if (e.type === "run.interrupted") noteStatus("interrupted");
        else if (e.type === "authorization.failed") noteStatus("failed");
        else if (
          e.type === "run.resumed" ||
          e.type === "run.retry" ||
          e.type === "run.rewind" ||
          e.type === "run.rerun"
        ) {
          // A lifecycle restart supersedes any earlier terminal/parked status seen in backfill.
          noteStatus(null);
        }
      },
      (err) => {
        flushTextFormatter();
        process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
        finish("failed");
      },
      (result) => {
        caughtUp = true;
        if (!pendingStatus && result.closedStatus) noteStatus(result.closedStatus as WatchStatus);
        if (pendingStatus) finish(pendingStatus);
      },
    );
  });
}

function prop(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function compact(value: unknown, max = 300): string {
  return compactTerminalText(value, max);
}

function usage(message: string): number {
  // `message` starts with the command name (e.g. "launch needs …"); show its usage.
  const name = message.split(/\s+/)[0] ?? "";
  process.stderr.write(`keel: ${message}\n`);
  if (cmdNames.has(name)) process.stderr.write(`${cmdHelp(name)}`);
  else process.stderr.write("Run `keel help` for usage.\n");
  return 2;
}

function structuredError(err: unknown): { code: string; message: string; name: string } {
  if (err instanceof Error) {
    return { code: "execute_failed", name: err.name, message: redactCapabilityTokens(err.message) };
  }
  return { code: "execute_failed", name: "Error", message: redactCapabilityTokens(String(err)) };
}

function loadCredential(): string | null {
  if (process.env.KEEL_ADMIN_TOKEN) return process.env.KEEL_ADMIN_TOKEN;
  if (process.env.KEEL_SUBMITTER_TOKEN) return process.env.KEEL_SUBMITTER_TOKEN;
  if (process.env.KEEL_RUN_CAP) return process.env.KEEL_RUN_CAP;
  if (process.env.KEEL_CAP_FILE) return loadCredentialFromFile(process.env.KEEL_CAP_FILE);
  return null;
}

function loadCredentialFromFile(path: string): string {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    capability?: unknown;
  };
  if (typeof parsed.capability !== "string") {
    throw new Error(`capability file ${path} is missing capability`);
  }
  return parsed.capability;
}

function requireFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined) throw new Error(`${flag} needs a value`);
  return value;
}

function writeCapabilityFile(runId: string, capability: string): string {
  mkdirSync(CAP_DIR, { recursive: true, mode: 0o700 });
  chmodSync(CAP_DIR, 0o700);
  const path = join(CAP_DIR, `${runId}.cap`);
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        kind: "keel-capability",
        runId,
        capability,
        createdAtMs: Date.now(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);
  return path;
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`keel: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
