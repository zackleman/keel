import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "../agents/mock.ts";
import { AgentProviderRegistry } from "../agents/types.ts";
import type { DaemonClient } from "../daemon/client.ts";
import { KeelDaemon } from "../daemon/server.ts";
import { JournalStore } from "../journal/store.ts";
import {
  formatListRuns,
  formatRunHeader,
  formatRunReportText,
  formatScheduleList,
  parseExecuteArgs,
  parseGcArgs,
  parseLaunchArgs,
  parseLaunchInput,
  parseLifecycleArgs,
  parseListArgs,
  parseOutputFormat,
  parseRunArgs,
  parseScheduleListArgs,
  parseScheduleShowArgs,
  parseTuiArgs,
  parseWatchArgs,
  parseWebArgs,
  parseWorkflowLaunchArgs,
  parseWorkflowRunArgs,
  resolveWorkflowPath,
  watchRun,
  workflowName,
} from "./keel.ts";

const CLI = new URL("./keel.ts", import.meta.url).pathname;
const FIX = new URL("../kernel/realm/fixtures/", import.meta.url);
const chainUrl = new URL("chain.workflow.ts", FIX).pathname;
const flakyUrl = new URL("flaky.workflow.ts", FIX).pathname;
const gateUrl = new URL("gate.workflow.ts", FIX).pathname;
const signalThenAgentUrl = new URL("signal-then-agent.workflow.ts", FIX).pathname;
const TASK_REVIEW = new URL("../../workflows/task-review-guidance/", import.meta.url);
const taskCodeReviewUrl = new URL("code-review.workflow.ts", TASK_REVIEW).pathname;
const taskPlanReviewUrl = new URL("plan-review.workflow.ts", TASK_REVIEW).pathname;
const DAEMON_TEST_TIMEOUT_MS = 20_000;

async function runCli(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  stdin?: string,
  timeoutMs?: number,
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
  const baseEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("KEEL_")),
  ) as Record<string, string>;
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd,
    env: { ...baseEnv, ...env },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timeout =
    timeoutMs === undefined
      ? null
      : setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr, timedOut };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function createSourceBearingPackageRoot(dir: string, opts: { mutateDocs?: boolean } = {}): string {
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "workflows", "task-review-guidance", "guidance"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name":"@kcosr/keel"}\n');
  writeFileSync(join(dir, "src", "sdk.ts"), "export {};\n");
  for (const file of ["code-review.workflow.ts", "plan-review.workflow.ts"]) {
    writeFileSync(
      join(dir, "workflows", "task-review-guidance", file),
      readFileSync(new URL(file, TASK_REVIEW), "utf8"),
    );
  }
  const docs = readFileSync(new URL("docs-review.workflow.ts", TASK_REVIEW), "utf8");
  writeFileSync(
    join(dir, "workflows", "task-review-guidance", "docs-review.workflow.ts"),
    opts.mutateDocs ? `${docs}\n// test source change\n` : docs,
  );
  for (const file of ["checklist.ts", "finding.ts", "prompt.ts", "rubric.ts", "types.ts"]) {
    writeFileSync(
      join(dir, "workflows", "task-review-guidance", "guidance", file),
      readFileSync(new URL(`guidance/${file}`, TASK_REVIEW), "utf8"),
    );
  }
  return dir;
}

describe("keel CLI", () => {
  test("help is a daemon-free install smoke", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-cli-help-"));
    try {
      const out = await runCli(["help"], dir);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain("Usage: keel <command>");
      expect(out.stdout).toContain("list [--output text|json]");
      expect(out.stdout).toContain("tui [runId] [--status status] [--limit n] [--output text]");
      expect(out.stdout).toContain("mcp");
      expect(out.stdout).toContain("gc [--prune-runs [--run-ttl duration]]");
      expect(out.stdout).toContain("run history only with --prune-runs");
      expect(out.stdout).toContain("interrupt <runId> [reason]");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gc arguments make run pruning explicit and parse duration units", () => {
    expect(parseGcArgs([])).toEqual({});
    expect(parseGcArgs(["--prune-runs"])).toEqual({ runTtlMs: 7 * 24 * 60 * 60 * 1000 });
    expect(parseGcArgs(["--prune-runs", "--run-ttl=24h"])).toEqual({ runTtlMs: 86_400_000 });
    expect(() => parseGcArgs(["--run-ttl", "1d"])).toThrow("--run-ttl requires --prune-runs");
  });

  test("link creates an @kcosr/keel SDK symlink for out-of-repo workflows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-link-"));
    try {
      const out = await runCli(["link", dir], dir);
      expect(out.code).toBe(0);

      const link = join(dir, "node_modules", "@kcosr", "keel");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);

      const workflow = join(dir, "wf.ts");
      await Bun.write(
        workflow,
        `import { passthrough } from "@kcosr/keel";\nexport const schema = passthrough<number>();\n`,
      );
      const imported = (await import(`${workflow}?t=${Date.now()}`)) as {
        schema: { parse(value: unknown): number };
      };
      expect(imported.schema.parse(3)).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("link refuses to replace a real package directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-link-existing-"));
    try {
      const existing = join(dir, "node_modules", "@kcosr", "keel");
      mkdirSync(existing, { recursive: true });
      await Bun.write(join(existing, "package.json"), '{"name":"real-package"}\n');

      const out = await runCli(["link", dir], dir);
      expect(out.code).toBe(2);
      expect(out.stderr).toContain("refusing to replace non-symlink");
      expect(existsSync(join(existing, "package.json"))).toBe(true);
      expect(readFileSync(join(existing, "package.json"), "utf8")).toContain("real-package");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("list args default to text and reject unsupported output modes", () => {
    expect(parseListArgs([])).toEqual({ output: "text" });
    expect(parseListArgs(["--output", "text"])).toEqual({ output: "text" });
    expect(parseListArgs(["--output", "json"])).toEqual({ output: "json" });
    expect(() => parseListArgs(["--output", "ndjson"])).toThrow(
      "--output ndjson is not available for list",
    );
    expect(() => parseListArgs(["--output", "xml"])).toThrow("invalid --output xml for list");
    expect(() => parseListArgs(["run_123"])).toThrow("unexpected argument run_123 for list");
  });

  test("web args default to localhost API transport settings", () => {
    const parsed = parseWebArgs([]);
    expect(parsed.host).toBe("127.0.0.1");
    expect(parsed.port).toBe(7879);
    expect(parsed.socket).toEndWith("keel.sock");
    expect(parsed.apiOnly).toBe(false);

    const explicit = parseWebArgs([
      "--host",
      "0.0.0.0",
      "--port",
      "0",
      "--socket",
      "/tmp/keel.sock",
      "--assets",
      ".",
      "--api-only",
    ]);
    expect(explicit).toMatchObject({
      host: "0.0.0.0",
      port: 0,
      socket: "/tmp/keel.sock",
      apiOnly: true,
    });
    expect(explicit.assets).toBe(process.cwd());

    expect(() => parseWebArgs(["--port", "70000"])).toThrow(
      "--port must be an integer between 0 and 65535",
    );
    expect(() => parseWebArgs(["--host", ""])).toThrow("--host must be non-empty");
    expect(() => parseWebArgs(["extra"])).toThrow("unexpected argument extra for web");
  });

  test("list formatter renders deterministic UTC timestamps and durations", () => {
    expect(
      formatListRuns(
        [
          {
            runId: "run_older",
            status: "finished",
            workflowName: "chain",
            createdAtMs: Date.UTC(2026, 5, 14, 1, 2, 3, 4),
            finishedAtMs: Date.UTC(2026, 5, 14, 1, 14, 3, 4),
            parentRunId: null,
          },
          {
            runId: "run_active",
            status: "waiting-signal",
            workflowName: "very long workflow name that is truncated for humans only",
            createdAtMs: Date.UTC(2026, 5, 14, 2, 0, 0, 0),
            finishedAtMs: null,
            parentRunId: "run_older",
          },
        ],
        Date.UTC(2026, 5, 14, 2, 0, 5, 0),
      ),
    ).toBe(
      [
        "RUN ID      STATUS          WORKFLOW                                  CREATED                   DURATION",
        "run_older   finished        chain                                     2026-06-14T01:02:03.004Z  12m",
        "run_active  waiting-signal  very long workflow name that is truncat…  2026-06-14T02:00:00.000Z  5s",
        "",
      ].join("\n"),
    );
  });

  test("schedule list/show parsers and formatter are deterministic", () => {
    expect(parseScheduleListArgs([])).toEqual({ enabledOnly: false, output: "text" });
    expect(parseScheduleListArgs(["--enabled-only", "--output", "json"])).toEqual({
      enabledOnly: true,
      output: "json",
    });
    expect(() => parseScheduleListArgs(["hourly"])).toThrow(
      "unexpected argument hourly for schedule list",
    );
    expect(parseScheduleShowArgs(["hourly", "--source", "--output", "json"])).toEqual({
      name: "hourly",
      output: "json",
      source: true,
    });
    expect(() => parseScheduleShowArgs(["hourly", "extra"])).toThrow(
      "unexpected argument extra for schedule show",
    );

    expect(
      formatScheduleList(
        [
          {
            name: "hourly-review",
            enabled: true,
            workflowRef: "wf_sha256_hourly",
            definitionState: "available",
            workflowName: "review",
            workflowKind: "source",
            target: "/repo",
            intervalMs: 3_600_000,
            nextFireMs: 4_200_000,
            lastRunId: "run_1",
            lastRunStatus: "finished",
            lastFailedAtMs: null,
            lastError: { kind: "none" },
          },
          {
            name: "nightly-docs",
            enabled: false,
            workflowRef: "wf_sha256_missing",
            definitionState: "missing",
            workflowName: null,
            workflowKind: null,
            target: "/repo",
            intervalMs: 86_400_000,
            nextFireMs: 0,
            lastRunId: null,
            lastRunStatus: null,
            lastFailedAtMs: 1,
            lastError: { kind: "error", error: { message: "disabled" } },
          },
        ],
        1_680_000,
      ),
    ).toBe(
      [
        "NAME           STATUS    NEXT FIRE  INTERVAL  LAST RUN  TARGET",
        "hourly-review  enabled   in 42m     1h        finished  /repo",
        "nightly-docs   disabled  -          1d        -         /repo",
        "",
      ].join("\n"),
    );
  });

  test("report formatter sanitizes terminal-bound text", () => {
    const text = formatRunReportText({
      runId: "run_1\u001b[31m",
      workflowName: "wf\nname",
      status: "failed",
      createdAtMs: 1,
      finishedAtMs: 2,
      output: "out\u001b[2J\nnext kc_run_secretValue",
      error: { name: "Error\u001b[31m", message: "bad\rthing" },
      stats: { steps: 1, agents: 0, checkpointCount: 0, artifacts: 0 },
      nodes: [
        {
          stableKey: "step\u001b[31m.one\nkey",
          status: "failed",
          effectType: "effectful",
          attempt: 1,
          startedAtMs: 1,
          dependsOn: [],
          artifactBacked: false,
          checkpoint: null,
          result: "result\u0000value",
        },
      ],
    });

    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("kc_run_secretValue");
    expect(text).toContain("workflow wf\\nname");
    expect(text).toContain("output out\\nnext «redacted-capability»");
    expect(text).toContain("error Error: bad\\rthing");
    expect(text).toContain("step.one\\nkey failed effectful attempt=1 result resultvalue");
  });

  test("tui args parse direct run, filters, and reject non-text output", () => {
    expect(parseTuiArgs([])).toEqual({ output: "text" });
    expect(parseTuiArgs(["run_123", "--status", "running", "--limit", "25"])).toEqual({
      output: "text",
      runId: "run_123",
      status: "running",
      limit: 25,
    });
    expect(parseTuiArgs(["--output", "text"])).toEqual({ output: "text" });
    expect(() => parseTuiArgs(["--output", "json"])).toThrow("not available for tui");
    expect(() => parseTuiArgs(["--limit", "0"])).toThrow("positive integer");
    expect(() => parseTuiArgs(["run_1", "run_2"])).toThrow("unexpected argument run_2");
  });

  test("watch args default to ndjson and parse --output", () => {
    expect(parseWatchArgs(["run_123"])).toEqual({
      runId: "run_123",
      output: "ndjson",
      tools: false,
      cursor: { kind: "beginning" },
    });
    expect(parseWatchArgs(["run_123", "--output", "text"])).toEqual({
      runId: "run_123",
      output: "text",
      tools: false,
      cursor: { kind: "beginning" },
    });
    expect(parseWatchArgs(["run_123", "--output", "text", "--tools"])).toEqual({
      runId: "run_123",
      output: "text",
      tools: true,
      cursor: { kind: "beginning" },
    });
    expect(parseWatchArgs(["run_123", "--from", "now"]).cursor).toEqual({ kind: "now" });
    expect(parseWatchArgs(["run_123", "--after-seq", "12"]).cursor).toEqual({
      kind: "after-seq",
      seq: 12,
    });
    expect(parseWatchArgs(["run_123", "--tail", "0"]).cursor).toEqual({
      kind: "tail",
      count: 0,
    });
    expect(() => parseWatchArgs(["run_123", "--from", "tail"])).toThrow(
      "--from must be beginning or now",
    );
    expect(() => parseWatchArgs(["run_123", "--from", "now", "--tail", "5"])).toThrow(
      "--tail cannot be combined with --from",
    );
    expect(() => parseWatchArgs(["run_123", "--after-seq", "1", "--tail", "5"])).toThrow(
      "--tail cannot be combined with --after-seq",
    );
    expect(() => parseWatchArgs(["run_123", "--from", "now", "--after-seq", "1"])).toThrow(
      "--after-seq cannot be combined with --from",
    );
    expect(() => parseWatchArgs(["run_123", "--tools"])).toThrow("attached watch --output text");
    expect(parseOutputFormat("json")).toBe("json");
    expect(() => parseOutputFormat("events")).toThrow("expected json, text, or ndjson");
  });

  test("lifecycle args default to attached mode and support --detach", () => {
    expect(parseLifecycleArgs(["wf.ts", '{"n":1}'])).toEqual({
      detach: false,
      tools: false,
      runSecrets: {},
      args: ["wf.ts", '{"n":1}'],
    });
    expect(parseLifecycleArgs(["--detach", "run_123"])).toEqual({
      detach: true,
      tools: false,
      runSecrets: {},
      args: ["run_123"],
    });
    expect(parseLifecycleArgs(["--tools", "run_123"])).toEqual({
      detach: false,
      tools: true,
      runSecrets: {},
      args: ["run_123"],
    });
    const previousSecretSource = process.env.KEEL_TEST_SECRET_SOURCE;
    try {
      process.env.KEEL_TEST_SECRET_SOURCE = "from-env";
      expect(
        parseLifecycleArgs([
          "--secret",
          "TOKEN=inline",
          "--secret-env",
          "FROM_ENV=KEEL_TEST_SECRET_SOURCE",
          "run_123",
        ]),
      ).toEqual({
        detach: false,
        tools: false,
        runSecrets: { FROM_ENV: "from-env", TOKEN: "inline" },
        args: ["run_123"],
      });
    } finally {
      if (previousSecretSource === undefined)
        Reflect.deleteProperty(process.env, "KEEL_TEST_SECRET_SOURCE");
      else process.env.KEEL_TEST_SECRET_SOURCE = previousSecretSource;
    }
    expect(() => parseLifecycleArgs(["--detach", "--tools", "run_123"])).toThrow(
      "attached lifecycle --output text",
    );
    expect(() => parseLifecycleArgs(["--secret", "BAD"])).toThrow("--secret must use NAME=VALUE");
  });

  test("launch args parse source path, input, name, detach, and capability emission", () => {
    expect(
      parseLaunchArgs([
        "--emit-capability",
        "--detach",
        "--name",
        "review",
        "wf.ts",
        "--input",
        '{"n":1}',
      ]),
    ).toEqual({
      detach: true,
      emitCapability: true,
      tools: false,
      file: "wf.ts",
      name: "review",
      input: { n: 1 },
      runSecrets: {},
    });
    expect(parseLaunchArgs(["--detach", "--output", "text", "wf.ts"])).toEqual({
      detach: true,
      emitCapability: false,
      tools: false,
      output: "text",
      file: "wf.ts",
      input: {},
      runSecrets: {},
    });
    expect(parseLaunchArgs(["--output", "text", "--tools", "wf.ts"])).toEqual({
      detach: false,
      emitCapability: false,
      tools: true,
      output: "text",
      file: "wf.ts",
      input: {},
      runSecrets: {},
    });
    expect(parseLaunchArgs(["--detach", "wf.ts"])).toEqual({
      detach: true,
      emitCapability: false,
      tools: false,
      file: "wf.ts",
      input: {},
      runSecrets: {},
    });
    expect(parseLaunchArgs(["--secret", "TOKEN=inline", "wf.ts"])).toEqual({
      detach: false,
      emitCapability: false,
      tools: false,
      file: "wf.ts",
      input: {},
      runSecrets: { TOKEN: "inline" },
    });
    expect(() => parseLaunchArgs(["wf.ts", '{"n":1}'])).toThrow("workflow input must use --input");
    expect(() => parseLaunchArgs(['{"n":1}'])).toThrow("workflow input must use --input");
    expect(() => parseLaunchArgs(["--secret", "__proto__=x", "wf.ts"])).toThrow("reserved");
  });

  test("run args parse output mode with optional source path", () => {
    expect(parseRunArgs(["--output", "ndjson", "--input", "null"])).toEqual({
      tools: false,
      output: "ndjson",
      input: null,
      runSecrets: {},
    });
    expect(parseRunArgs(["--output", "text", "--tools"])).toEqual({
      tools: true,
      output: "text",
      input: {},
      runSecrets: {},
    });
    expect(() => parseRunArgs(["--json"])).toThrow("unknown flag --json");
    expect(() => parseRunArgs(['{"n":1}'])).toThrow("workflow input must use --input");
  });

  test("workflow launch args parse saved launch parity flags", () => {
    expect(
      parseWorkflowLaunchArgs([
        "--detach",
        "--emit-capability",
        "--output",
        "text",
        "--version",
        "2",
        "--target",
        ".",
        "--input",
        '{"n":1}',
        "review-loop",
      ]),
    ).toMatchObject({
      name: "review-loop",
      version: 2,
      detach: true,
      emitCapability: true,
      output: "text",
      input: { n: 1 },
    });
    expect(parseWorkflowLaunchArgs(["review-loop"])).toMatchObject({
      name: "review-loop",
      detach: false,
      emitCapability: false,
      tools: false,
      runSecrets: {},
    });
  });

  test("workflow run args keep attached convenience semantics", () => {
    expect(parseWorkflowRunArgs(["review-loop"])).toMatchObject({
      name: "review-loop",
      tools: false,
      runSecrets: {},
    });
    expect(() => parseWorkflowRunArgs(["review-loop", "--detach"])).toThrow(
      "unknown workflow run flag --detach",
    );
    expect(() => parseWorkflowRunArgs(["review-loop", "--emit-capability"])).toThrow(
      "unknown workflow run flag --emit-capability",
    );
  });

  test("execute args parse source, state, cap file, entry, and script args", () => {
    expect(
      parseExecuteArgs([
        "--entry",
        "resume",
        "--state",
        "state.json",
        "--cap-file",
        "run.cap",
        "--emit-capability",
        "control.ts",
        "--",
        "a",
        "b",
      ]),
    ).toEqual({
      file: "control.ts",
      entry: "resume",
      stateFile: "state.json",
      capFile: "run.cap",
      output: "json",
      emitCapability: true,
      args: ["a", "b"],
    });
    expect(parseExecuteArgs(["--output", "json", "control.ts"])).toMatchObject({
      file: "control.ts",
      output: "json",
    });
    expect(parseExecuteArgs(["--output", "text", "control.ts"]).output).toBe("text");
  });

  test("attached lifecycle commands print the run id before streaming events", () => {
    expect(formatRunHeader("run_123")).toBe("run run_123\n");
  });

  test("watchRun flushes partial text streams before terminal events", async () => {
    const client = fakeWatchClient(({ req, onEvent, onCaughtUp }) => {
      expect(req).toEqual({
        runId: "run_terminal_flush",
        cursor: { kind: "beginning" },
      });
      onEvent({
        kind: "ephemeral",
        type: "agent.event",
        payload: { key: "review", event: { type: "text", data: "partial" } },
        atMs: 1,
      });
      onEvent({ kind: "durable", seq: 2, type: "run.finished", payload: {}, atMs: 2 });
      onCaughtUp?.({
        subId: "sub_1",
        cursor: { kind: "after-seq", runId: "run_terminal_flush", seq: 2 },
        closedStatus: null,
      });
    });

    const captured = await captureProcessWrites(() =>
      watchRun(client, "run_terminal_flush", { output: "text" }),
    );

    expect(captured.result).toBe("finished");
    expect(captured.writes).toEqual([
      { stream: "stdout", text: "[live] agent review text: " },
      { stream: "stdout", text: "partial" },
      { stream: "stdout", text: "\n" },
      { stream: "stdout", text: "[2] run.finished\n" },
    ]);
  });

  test("watchRun flushes partial text streams before subscription errors", async () => {
    const client = fakeWatchClient(({ onEvent, onError }) => {
      onEvent({
        kind: "ephemeral",
        type: "agent.event",
        payload: { key: "review", event: { type: "text", data: "partial" } },
        atMs: 1,
      });
      onError?.(new Error("subscribe failed"));
    });

    const captured = await captureProcessWrites(() =>
      watchRun(client, "run_error_flush", { output: "text" }),
    );

    expect(captured.result).toBe("failed");
    expect(captured.writes).toEqual([
      { stream: "stdout", text: "[live] agent review text: " },
      { stream: "stdout", text: "partial" },
      { stream: "stdout", text: "\n" },
      { stream: "stderr", text: "subscribe failed\n" },
    ]);
  });

  test("watchRun exits from closed subscription status after catch-up", async () => {
    const client = fakeWatchClient(({ req, onCaughtUp }) => {
      expect(req).toEqual({
        runId: "run_closed_now",
        cursor: { kind: "now" },
      });
      onCaughtUp?.({
        subId: "sub_1",
        cursor: { kind: "after-seq", runId: "run_closed_now", seq: 9 },
        closedStatus: "finished",
      });
    });

    const captured = await captureProcessWrites(() =>
      watchRun(client, "run_closed_now", { output: "ndjson", cursor: { kind: "now" } }),
    );

    expect(captured.result).toBe("finished");
    expect(captured.writes).toEqual([]);
  });

  test("launch input defaults to an object and rejects empty --input values", () => {
    expect(parseLaunchInput(undefined)).toEqual({});
    expect(parseLaunchInput('{"n":1}')).toEqual({ n: 1 });
    expect(parseLaunchInput("null")).toBeNull();
    expect(() => parseLaunchInput("")).toThrow("omit it for {}");
    expect(() => parseLaunchInput("  ")).toThrow("omit it for {}");
  });

  test("launch workflow paths are normalized before RPC", () => {
    expect(resolveWorkflowPath("fixtures/demo.workflow.ts", "/repo")).toBe(
      "/repo/fixtures/demo.workflow.ts",
    );
    expect(resolveWorkflowPath("/repo/demo.workflow.ts", "/other")).toBe("/repo/demo.workflow.ts");
    expect(resolveWorkflowPath("file:///repo/demo.workflow.ts", "/other")).toBe(
      "/repo/demo.workflow.ts",
    );
    expect(workflowName("/repo/demo.workflow.ts")).toBe("demo.workflow.ts");
    expect(workflowName("file:///repo/demo.workflow.ts")).toBe("demo.workflow.ts");
  });

  test("launch rejects empty --input before connecting to the daemon", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-launch-empty-input-"));
    try {
      const out = await runCli(["launch", "wf.ts", "--input", ""], dir, {
        KEEL_SOCKET: join(dir, "missing.sock"),
      });
      expect(out.code).toBe(1);
      expect(out.stderr).toContain("omit it for {}");
      expect(out.stderr).not.toContain("Failed to connect");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(
    "detached launch writes a capability file that authorizes follow-up get",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-launch-cap-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const capDir = join(dir, "caps");
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(new MockProvider()),
      });
      await daemon.start();
      try {
        const env = {
          KEEL_SOCKET: socketPath,
          KEEL_DB: dbPath,
          KEEL_DIR: dir,
          KEEL_CAP_DIR: capDir,
        };
        const launched = await runCli(
          ["launch", "--detach", chainUrl, "--input", '{"n":1}'],
          dir,
          env,
        );
        expect(launched.code).toBe(0);
        expect(launched.stdout).not.toContain("kc_run_");
        const payload = JSON.parse(launched.stdout) as { runId: string; capabilityRef: string };
        expect(payload.capabilityRef).toBe(join(capDir, `${payload.runId}.cap`));
        const capFile = JSON.parse(readFileSync(payload.capabilityRef, "utf8")) as {
          capability: string;
        };
        expect(capFile.capability.startsWith("kc_run_")).toBe(true);

        const got = await runCli(["get", payload.runId], dir, {
          ...env,
          KEEL_CAP_FILE: payload.capabilityRef,
        });
        expect(got.code).toBe(0);
        expect(JSON.parse(got.stdout).runId).toBe(payload.runId);
        const unauthorizedWatch = await runCli(["watch", payload.runId], dir, env);
        expect(unauthorizedWatch.code).toBe(1);
        expect(unauthorizedWatch.stderr).toContain("not authorized");
        await waitForCliStatus(payload.runId, dir, {
          ...env,
          KEEL_CAP_FILE: payload.capabilityRef,
        });
        const output = await runCli(["output", payload.runId], dir, {
          ...env,
          KEEL_CAP_FILE: payload.capabilityRef,
        });
        expect(output.code).toBe(0);
        expect(output.stdout).toBe("1\n");

        const raw = await runCli(
          ["launch", "--detach", "--emit-capability", chainUrl, "--input", '{"n":3}'],
          dir,
          env,
        );
        expect(raw.code).toBe(0);
        const rawPayload = JSON.parse(raw.stdout) as { runId: string; capability: string };
        expect(rawPayload.capability.startsWith("kc_run_")).toBe(true);
        expect(raw.stdout).not.toContain("capabilityRef");
        await waitForCliStatus(rawPayload.runId, dir, {
          ...env,
          KEEL_RUN_CAP: rawPayload.capability,
        });

        const attached = await runCli(["launch", chainUrl, "--input", '{"n":2}'], dir, env);
        expect(attached.code).toBe(0);
        expect(attached.stdout.startsWith("run ")).toBe(false);
        const attachedEvents = attached.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
        expect(attachedEvents[0]).toMatchObject({
          type: "launch.started",
          payload: { capabilityRef: join(capDir, `${attachedEvents[0]?.payload.runId}.cap`) },
        });
        expect(attachedEvents.find((e) => e.type === "run.finished")?.payload).toEqual({
          output: 2,
        });
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "run launches a workflow file and prints a JSON envelope by default",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-run-json-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(new MockProvider()),
      });
      await daemon.start();
      try {
        const env = { KEEL_SOCKET: socketPath, KEEL_DB: dbPath, KEEL_DIR: dir };
        const out = await runCli(["run", chainUrl, "--input", '{"n":2}'], dir, env);
        expect(out.code).toBe(0);
        const payload = JSON.parse(out.stdout) as {
          runId: string;
          capabilityRef: string;
          status: string;
          output: number;
        };
        expect(payload.status).toBe("finished");
        expect(payload.output).toBe(2);
        expect(payload.capabilityRef).toBe(join(dir, "caps", `${payload.runId}.cap`));

        const streamed = await runCli(
          ["run", "--output", "ndjson", chainUrl, "--input", '{"n":2}'],
          dir,
          env,
        );
        expect(streamed.code).toBe(0);
        const events = streamed.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { type: string; subId?: string; payload: unknown });
        expect(events.find((e) => e.type === "run.finished")?.payload).toEqual({ output: 2 });
        expect(events.length).toBeGreaterThan(0);
        expect(events.every((e) => e.subId === undefined)).toBe(true);
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "run captures local helper modules from workflow files",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-run-helper-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(new MockProvider()),
      });
      await daemon.start();
      try {
        mkdirSync(join(dir, "workflows", "shared"), { recursive: true });
        mkdirSync(join(dir, "workflows", "review"), { recursive: true });
        const workflow = join(dir, "workflows", "review", "review.workflow.ts");
        writeFileSync(join(dir, "workflows", "shared", "tasks.ts"), "export const value = 7;\n");
        writeFileSync(
          workflow,
          `
            import { value } from "../shared/tasks";
            export default async function wf() { return value; }
          `,
        );
        const env = { KEEL_SOCKET: socketPath, KEEL_DB: dbPath, KEEL_DIR: dir };
        const out = await runCli(["run", workflow], dir, env);
        expect(out.code).toBe(0);
        const payload = JSON.parse(out.stdout) as { status: string; output: number };
        expect(payload.status).toBe("finished");
        expect(payload.output).toBe(7);
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "run closes the client and exits when the daemon rejects the launch",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-run-reject-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(new MockProvider()),
      });
      await daemon.start();
      try {
        const env = { KEEL_SOCKET: socketPath, KEEL_DB: dbPath, KEEL_DIR: dir };
        // A forbidden import makes the daemon reject launchRun mid-command. The CLI
        // must close the socket and exit rather than hang on the dangling handle —
        // the bounded timeout trips `timedOut` if the leak regresses.
        const rejected = await runCli(
          ["run", "--output", "json"],
          dir,
          env,
          'import fs from "node:fs";\nexport default async () => fs;\n',
          5_000,
        );
        expect(rejected.timedOut).toBe(false);
        expect(rejected.code).toBe(1);
        expect(rejected.stderr).toContain('workflow import "node:fs" from entry.ts is not allowed');
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "report prints a per-node result digest",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-report-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(new MockProvider()),
      });
      await daemon.start();
      try {
        const env = { KEEL_SOCKET: socketPath, KEEL_DB: dbPath, KEEL_DIR: dir };
        const run = await runCli(["run", chainUrl, "--input", '{"n":2}'], dir, env);
        const { runId, capabilityRef } = JSON.parse(run.stdout) as {
          runId: string;
          capabilityRef: string;
        };

        const report = await runCli(["report", runId], dir, {
          ...env,
          KEEL_CAP_FILE: capabilityRef,
        });
        expect(report.code).toBe(0);
        const payload = JSON.parse(report.stdout) as {
          runId: string;
          output: number;
          stats: { steps: number; agents: number; checkpointCount: number; artifacts: number };
          nodes: Array<{ stableKey: string; result: number; artifactBacked: boolean }>;
        };
        expect(payload.runId).toBe(runId);
        expect(payload.output).toBe(2);
        expect(payload.stats).toEqual({ steps: 2, agents: 0, checkpointCount: 0, artifacts: 0 });
        expect(payload.nodes.map((n) => [n.stableKey, n.result])).toEqual([
          ["s0", 1],
          ["s1", 2],
        ]);

        const text = await runCli(["report", runId, "--output", "text"], dir, {
          ...env,
          KEEL_CAP_FILE: capabilityRef,
        });
        expect(text.code).toBe(0);
        expect(text.stdout).toContain(`run ${runId}`);
        expect(text.stdout).toContain("s0 completed pure attempt=1 result 1");

        const unauthorized = await runCli(["report", runId], dir, env, undefined, 1_000);
        expect(unauthorized.timedOut).toBe(false);
        expect(unauthorized.code).toBe(1);
        expect(unauthorized.stderr).toContain("not authorized");

        const invalid = await runCli(["report", runId, "--output", "ndjson"], dir, {
          ...env,
          KEEL_CAP_FILE: capabilityRef,
        });
        expect(invalid.code).toBe(1);
        expect(invalid.stderr).toContain("--output ndjson is not available for report");
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "schedule list and show print text, JSON, and opt-in source",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-schedule-read-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        adminToken: "kc_admin_schedule_read_test",
      });
      await daemon.start();
      try {
        const env = {
          KEEL_SOCKET: socketPath,
          KEEL_DB: dbPath,
          KEEL_DIR: dir,
          KEEL_ADMIN_TOKEN: "kc_admin_schedule_read_test",
        };
        const put = await runCli(
          ["schedule", "put", "hourly-review", chainUrl, "--interval-ms", "3600000"],
          dir,
          env,
        );
        expect(put.code).toBe(0);

        const list = await runCli(["schedule", "list"], dir, env);
        expect(list.code).toBe(0);
        expect(list.stdout).toContain("NAME");
        expect(list.stdout).toContain("hourly-review");
        expect(list.stdout).toContain("enabled");
        expect(list.stdout).toContain("1h");

        const listJson = await runCli(["schedule", "list", "--output", "json"], dir, env);
        expect(listJson.code).toBe(0);
        const listed = JSON.parse(listJson.stdout) as { schedules: Array<{ name: string }> };
        expect(listed.schedules.map((schedule) => schedule.name)).toEqual(["hourly-review"]);

        const show = await runCli(["schedule", "show", "hourly-review"], dir, env);
        expect(show.code).toBe(0);
        expect(show.stdout).toContain("definition available");
        expect(show.stdout).not.toContain("sourceEntry");

        const source = await runCli(["schedule", "show", "hourly-review", "--source"], dir, env);
        expect(source.code).toBe(0);
        expect(source.stdout).toContain("sourceEntry");
        expect(source.stdout).toContain("export default async function chain");

        const showJson = await runCli(
          ["schedule", "show", "hourly-review", "--source", "--output", "json"],
          dir,
          env,
        );
        expect(showJson.code).toBe(0);
        const shown = JSON.parse(showJson.stdout) as {
          name: string;
          source?: { files: Array<{ code: string }> };
        };
        expect(shown.name).toBe("hourly-review");
        expect(shown.source?.files[0]?.code).toContain("export default async function chain");
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "attached lifecycle commands exit 3 when the run parks",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-lifecycle-parked-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(new MockProvider()),
        adminToken: "kc_admin_lifecycle_test",
      });
      await daemon.start();
      try {
        const env = {
          KEEL_SOCKET: socketPath,
          KEEL_DB: dbPath,
          KEEL_DIR: dir,
          KEEL_ADMIN_TOKEN: "kc_admin_lifecycle_test",
        };
        const launched = await runCli(["launch", "--detach", gateUrl], dir, env);
        expect(launched.code).toBe(0);
        const payload = JSON.parse(launched.stdout) as { runId: string; capabilityRef: string };
        await waitForCliStatus(payload.runId, dir, env, "waiting-human");

        const detached = await runCli(["resume", "--detach", payload.runId], dir, env);
        expect(detached.code).toBe(0);
        expect(detached.stdout).toContain(`${payload.runId}\t`);
        await waitForCliStatus(payload.runId, dir, env, "waiting-human");

        const resumed = await runCli(["resume", payload.runId], dir, env);
        expect(resumed.code).toBe(3);
        expect(resumed.stdout).toContain(`run ${payload.runId}`);
        expect(resumed.stdout).toContain("run.resumed");
        expect(resumed.stdout).toContain("run.parked human approve-deploy");
        expect(resumed.stdout.indexOf("run.resumed")).toBeLessThan(
          resumed.stdout.indexOf("run.parked human approve-deploy"),
        );

        const approved = await runCli(["approve", payload.runId, "approve-deploy"], dir, env);
        expect(approved.code).toBe(0);
        expect(approved.stdout).toBe("running\n");
        await waitForCliStatus(payload.runId, dir, env);

        const watched = await runCli(["watch", payload.runId, "--output", "text"], dir, env);
        expect(watched.code).toBe(0);
        expect(watched.stdout).toContain("run.parked human approve-deploy");
        expect(watched.stdout).toContain("run.resumed");
        expect(watched.stdout).toContain("run.finished");
        expect(watched.stdout.indexOf("run.parked human approve-deploy")).toBeLessThan(
          watched.stdout.indexOf("run.resumed"),
        );
        expect(watched.stdout.indexOf("run.resumed")).toBeLessThan(
          watched.stdout.indexOf("run.finished"),
        );
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "interrupt command parks a run, reports redacted reason, and resume is explicit",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-interrupt-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(new MockProvider()),
        adminToken: "kc_admin_interrupt_test",
      });
      await daemon.start();
      try {
        const env = {
          KEEL_SOCKET: socketPath,
          KEEL_DB: dbPath,
          KEEL_DIR: dir,
          KEEL_ADMIN_TOKEN: "kc_admin_interrupt_test",
        };
        const launched = await runCli(["launch", "--detach", gateUrl], dir, env);
        expect(launched.code).toBe(0);
        const payload = JSON.parse(launched.stdout) as { runId: string };
        await waitForCliStatus(payload.runId, dir, env, "waiting-human");

        const interrupted = await runCli(
          ["interrupt", payload.runId, "inspect", "kc_run_secretValue"],
          dir,
          env,
        );
        expect(interrupted.code).toBe(0);
        expect(interrupted.stdout).toBe(`${payload.runId}\tinterrupted\n`);
        await waitForCliStatus(payload.runId, dir, env, "interrupted");

        const watched = await runCli(["watch", payload.runId, "--output", "text"], dir, env);
        expect(watched.code).toBe(3);
        expect(watched.stdout).toContain("run.interrupted: inspect «redacted-capability»");
        expect(watched.stdout).not.toContain("kc_run_secretValue");

        const report = await runCli(["report", payload.runId, "--output", "text"], dir, env);
        expect(report.code).toBe(3);
        expect(report.stdout).toContain("blockage interrupted");
        expect(report.stdout).toContain("inspect «redacted-capability»");

        const approved = await runCli(["approve", payload.runId, "approve-deploy"], dir, env);
        expect(approved.code).toBe(0);
        expect(approved.stdout).toBe("interrupted\n");
        await waitForCliStatus(payload.runId, dir, env, "interrupted");

        const resumed = await runCli(["resume", payload.runId], dir, env);
        expect(resumed.code).toBe(0);
        expect(resumed.stdout).toContain("run.resumed");
        expect(resumed.stdout).toContain("run.finished");
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "signal command acknowledges delivery without waiting for resumed work",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-signal-ack-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(
          new MockProvider({ default: { outputs: ['{"value":5}'], delayMs: 2_000 } }),
        ),
      });
      await daemon.start();
      try {
        const env = {
          KEEL_SOCKET: socketPath,
          KEEL_DB: dbPath,
          KEEL_DIR: dir,
        };
        const launched = await runCli(["launch", "--detach", signalThenAgentUrl], dir, env);
        expect(launched.code).toBe(0);
        const payload = JSON.parse(launched.stdout) as { runId: string; capabilityRef: string };
        const runEnv = { ...env, KEEL_CAP_FILE: payload.capabilityRef };
        await waitForCliStatus(payload.runId, dir, runEnv, "waiting-signal");

        const signaled = await runCli(
          ["signal", payload.runId, "proceed", '{"go":true}'],
          dir,
          runEnv,
          undefined,
          1_500,
        );
        expect(signaled.timedOut).toBe(false);
        expect(signaled.code).toBe(0);
        expect(signaled.stdout).toBe("running\n");
        const immediate = await runCli(["get", payload.runId], dir, runEnv);
        expect(JSON.parse(immediate.stdout).status).toBe("running");
        await waitForCliStatus(payload.runId, dir, runEnv);
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "attached retry ignores stale backfilled failure while the new attempt is running",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-lifecycle-retry-tail-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(
          new MockProvider({
            responses: {
              flaky: { outputs: ["bad", "bad", "bad", '{"ok":true}'], delayMs: 400 },
            },
          }),
        ),
        adminToken: "kc_admin_lifecycle_retry_test",
      });
      await daemon.start();
      try {
        const env = {
          KEEL_SOCKET: socketPath,
          KEEL_DB: dbPath,
          KEEL_DIR: dir,
          KEEL_ADMIN_TOKEN: "kc_admin_lifecycle_retry_test",
        };
        const launched = await runCli(["launch", "--detach", flakyUrl], dir, env);
        expect(launched.code).toBe(0);
        const payload = JSON.parse(launched.stdout) as { runId: string };
        await waitForCliStatus(payload.runId, dir, env, "failed");

        const retried = await runCli(["retry", payload.runId], dir, env);
        expect(retried.code).toBe(0);
        expect(retried.stdout).toContain(`run ${payload.runId}`);
        expect(retried.stdout).toContain("run.retry");
        expect(retried.stdout).toContain("run.finished");
        expect(retried.stdout).not.toContain("run.failed");
        expect(retried.stdout.indexOf("run.retry")).toBeLessThan(
          retried.stdout.indexOf("run.finished"),
        );
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "launch reads workflow source from stdin when no file is passed",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-launch-stdin-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(new MockProvider()),
        adminToken: "kc_admin_cli_test",
      });
      await daemon.start();
      try {
        const env = {
          KEEL_SOCKET: socketPath,
          KEEL_DB: dbPath,
          KEEL_DIR: dir,
          KEEL_ADMIN_TOKEN: "kc_admin_cli_test",
        };
        const launched = await runCli(
          ["launch", "--detach", "--input", '{"n":2}'],
          dir,
          env,
          readFileSync(chainUrl, "utf8"),
        );
        expect(launched.code).toBe(0);
        const payload = JSON.parse(launched.stdout) as { runId: string; capabilityRef: string };
        await waitForCliStatus(payload.runId, dir, {
          ...env,
          KEEL_CAP_FILE: payload.capabilityRef,
        });

        const listed = await runCli(["list"], dir, env);
        expect(listed.code).toBe(0);
        expect(listed.stdout).toContain("(unnamed)");
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "list renders a table by default and JSON envelope on request",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-list-output-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(new MockProvider()),
        adminToken: "kc_admin_list_test",
      });
      await daemon.start();
      try {
        const env = {
          KEEL_SOCKET: socketPath,
          KEEL_DB: dbPath,
          KEEL_DIR: dir,
          KEEL_ADMIN_TOKEN: "kc_admin_list_test",
        };

        const emptyText = await runCli(["list"], dir, env);
        expect(emptyText.code).toBe(0);
        expect(emptyText.stdout).toBe("RUN ID  STATUS  WORKFLOW  CREATED  DURATION\n");

        const emptyJson = await runCli(["list", "--output", "json"], dir, env);
        expect(emptyJson.code).toBe(0);
        expect(JSON.parse(emptyJson.stdout)).toEqual({ runs: [] });

        const first = await runCli(
          ["run", "--name", "older", chainUrl, "--input", '{"n":1}'],
          dir,
          env,
        );
        expect(first.code).toBe(0);
        const firstRun = JSON.parse(first.stdout) as { runId: string };

        const second = await runCli(
          ["run", "--name", "newer", chainUrl, "--input", '{"n":2}'],
          dir,
          env,
        );
        expect(second.code).toBe(0);
        const secondRun = JSON.parse(second.stdout) as { runId: string };

        const listedJson = await runCli(["list", "--output", "json"], dir, env);
        expect(listedJson.code).toBe(0);
        const payload = JSON.parse(listedJson.stdout) as {
          runs: Array<{
            runId: string;
            status: string;
            workflowName: string | null;
            createdAtMs: number;
            finishedAtMs: number | null;
            parentRunId: string | null;
            runTarget?: string | null;
          }>;
        };
        expect(payload.runs.map((run) => run.runId)).toEqual([secondRun.runId, firstRun.runId]);
        expect(Object.keys(payload.runs[0] ?? {}).sort()).toEqual([
          "createdAtMs",
          "finishedAtMs",
          "parentRunId",
          "runId",
          "runTarget",
          "status",
          "workflowName",
        ]);
        expect(payload.runs[0]).toMatchObject({
          runId: secondRun.runId,
          status: "finished",
          workflowName: "newer",
          parentRunId: null,
        });
        expect(typeof payload.runs[0]?.createdAtMs).toBe("number");
        expect(typeof payload.runs[0]?.finishedAtMs).toBe("number");

        const listedText = await runCli(["list"], dir, env);
        expect(listedText.code).toBe(0);
        const lines = listedText.stdout.trimEnd().split("\n");
        expect(lines[0]).toContain("RUN ID");
        expect(lines[0]).toContain("STATUS");
        expect(lines[0]).toContain("WORKFLOW");
        expect(lines[0]).toContain("CREATED");
        expect(lines[0]).toContain("DURATION");
        expect(lines[1]).toMatch(
          new RegExp(
            `^${escapeRegExp(secondRun.runId)}\\s{2,}finished\\s{2,}newer\\s{2,}\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z\\s{2,}\\d+(?:ms|s|m|h|d)$`,
          ),
        );
        expect(lines[2]).toMatch(
          new RegExp(
            `^${escapeRegExp(firstRun.runId)}\\s{2,}finished\\s{2,}older\\s{2,}\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z\\s{2,}\\d+(?:ms|s|m|h|d)$`,
          ),
        );
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "gc preserves run history by default and prunes runs and artifacts only when requested",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-gc-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const seed = JournalStore.open(dbPath);
      seed.insertRun({
        runId: "expired-one-off",
        workflowName: "one-off",
        definitionVersion: "wf_sha256_expired",
        workflowRef: "client:test",
        runTarget: dir,
        status: "finished",
        parentRunId: null,
        tenantId: null,
        inputRef: "null",
        outputRef: "null",
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        launchAuthorityJson: null,
        createdAtMs: 1,
        finishedAtMs: 2,
      });
      const artifactBytes = new TextEncoder().encode("x".repeat(2_000));
      seed.putArtifact("expired-artifact", artifactBytes, 0);
      seed.putJournalRow({
        runId: "expired-one-off",
        stableKey: "large-result",
        effectType: "pure",
        status: "completed",
        version: "v1",
        inputHash: "input",
        resultArtifact: "expired-artifact",
      });
      seed.close();

      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(new MockProvider()),
        adminToken: "kc_admin_gc_test",
      });
      await daemon.start();
      try {
        const env = {
          KEEL_SOCKET: socketPath,
          KEEL_DB: dbPath,
          KEEL_DIR: dir,
          KEEL_ADMIN_TOKEN: "kc_admin_gc_test",
        };
        const kept = await runCli(["gc"], dir, env);
        expect(kept.code).toBe(0);
        expect(JSON.parse(kept.stdout).oneOffRunsRemoved).toBe(0);

        const afterDefaultGc = JournalStore.open(dbPath);
        expect(afterDefaultGc.getRun("expired-one-off")).not.toBeNull();
        expect(afterDefaultGc.getArtifactData("expired-artifact")).toEqual(artifactBytes);
        afterDefaultGc.close();

        const pruned = await runCli(["gc", "--prune-runs", "--run-ttl", "1ms"], dir, env);
        expect(pruned.code).toBe(0);
        expect(JSON.parse(pruned.stdout).oneOffRunsRemoved).toBe(1);

        const afterRunGc = JournalStore.open(dbPath);
        expect(afterRunGc.getRun("expired-one-off")).toBeNull();
        expect(afterRunGc.getArtifactData("expired-artifact")).toBeNull();
        afterRunGc.close();
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "profiles commands manage catalog entries as admin",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-profiles-cli-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(new MockProvider()),
        adminToken: "kc_admin_profiles_test",
      });
      await daemon.start();
      try {
        const env = {
          KEEL_SOCKET: socketPath,
          KEEL_DB: dbPath,
          KEEL_DIR: dir,
          KEEL_ADMIN_TOKEN: "kc_admin_profiles_test",
        };
        const config = JSON.stringify({
          provider: "mock",
          model: "review-v1",
          toolPolicy: "read-only",
        });

        const set = await runCli(["profiles", "set", "reviewer", "--file", "-"], dir, env, config);
        expect(set.code).toBe(0);
        expect(JSON.parse(set.stdout)).toMatchObject({
          name: "reviewer",
          source: "catalog",
          generation: 1,
        });

        const listed = await runCli(["profiles", "list"], dir, env);
        expect(listed.code).toBe(0);
        const lines = listed.stdout.trimEnd().split("\n");
        expect(lines[0]).toContain("NAME");
        expect(lines[0]).toContain("TOOL POLICY");
        expect(lines[1]).toMatch(/^reviewer\s{2,}catalog\s{2,}mock\s{2,}review-v1\s{2,}read-only/);

        const checked = await runCli(["profiles", "check", "reviewer"], dir, env);
        expect(checked.code).toBe(0);
        expect(checked.stdout).toBe("ok\n");

        const deleted = await runCli(
          ["profiles", "delete", "reviewer", "--if-generation", "1"],
          dir,
          env,
        );
        expect(deleted.code).toBe(0);
        expect(JSON.parse(deleted.stdout)).toEqual({ name: "reviewer", deleted: true });
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "settings commands manage daemon catalog entries as admin",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-settings-cli-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(new MockProvider()),
        adminToken: "kc_admin_settings_test",
      });
      await daemon.start();
      try {
        const env = {
          KEEL_SOCKET: socketPath,
          KEEL_DB: dbPath,
          KEEL_DIR: dir,
          KEEL_ADMIN_TOKEN: "kc_admin_settings_test",
        };

        const listed = await runCli(["settings", "list"], dir, env);
        expect(listed.code).toBe(0);
        expect(listed.stdout).toContain("KEY");
        expect(listed.stdout).toContain("agent.defaultTimeoutMs");

        const set = await runCli(
          ["settings", "set", "agent.defaultTimeoutMs", "7200000"],
          dir,
          env,
        );
        expect(set.code).toBe(0);
        expect(JSON.parse(set.stdout)).toMatchObject({
          key: "agent.defaultTimeoutMs",
          value: 7200000,
          generation: 1,
        });

        const got = await runCli(
          ["settings", "get", "agent.defaultTimeoutMs", "--output", "json"],
          dir,
          env,
        );
        expect(got.code).toBe(0);
        expect(JSON.parse(got.stdout)).toMatchObject({
          key: "agent.defaultTimeoutMs",
          value: 7200000,
          isDefault: false,
        });

        const bad = await runCli(["settings", "check", "agent.defaultTimeoutMs", "-1"], dir, env);
        expect(bad.code).toBe(1);
        expect(bad.stdout).toContain("failed");
        expect(bad.stdout).toContain("expected integer > 0");

        const unset = await runCli(
          ["settings", "unset", "agent.defaultTimeoutMs", "--if-generation", "1"],
          dir,
          env,
        );
        expect(unset.code).toBe(0);
        expect(JSON.parse(unset.stdout)).toEqual({
          key: "agent.defaultTimeoutMs",
          deleted: true,
        });
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "workflow commands save, list, source, run, and update lifecycle",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-cli-workflow-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        adminToken: "kc_admin_workflow_test",
      });
      await daemon.start();
      try {
        const env = {
          KEEL_SOCKET: socketPath,
          KEEL_DB: dbPath,
          KEEL_CAP_DIR: join(dir, "caps"),
          KEEL_ADMIN_TOKEN: "kc_admin_workflow_test",
        };
        const saved = await runCli(
          [
            "workflow",
            "save",
            "review-loop",
            chainUrl,
            "--default-input",
            '{"n":2}',
            "--default-target",
            dir,
            "--title",
            "Review Loop",
          ],
          dir,
          env,
        );
        expect(saved.code).toBe(0);
        const payload = JSON.parse(saved.stdout) as { version: number; definitionHash: string };
        expect(payload.version).toBe(1);
        expect(payload.definitionHash.startsWith("wf_sha256_")).toBe(true);

        const listed = await runCli(["workflow", "list", "--output", "json"], dir, env);
        expect(listed.code).toBe(0);
        expect(JSON.parse(listed.stdout).workflows[0]).toMatchObject({
          name: "review-loop",
          latestVersion: 1,
          title: "Review Loop",
        });

        const source = await runCli(["workflow", "source", "review-loop", "--all"], dir, env);
        expect(source.code).toBe(0);
        expect(source.stdout).toContain("--- chain.workflow.ts");
        expect(source.stdout).toContain("export default async function chain");
        const savedJson = await runCli(
          ["workflow", "source", "review-loop", "--output", "json"],
          dir,
          env,
        );
        expect(savedJson.code).toBe(0);
        expect(JSON.parse(savedJson.stdout)).toMatchObject({
          name: "review-loop",
          version: 1,
          definitionHash: payload.definitionHash,
        });

        const codeReviewSaved = await runCli(
          ["workflow", "save", "task-code-review", taskCodeReviewUrl, "--version", "1"],
          dir,
          env,
        );
        expect(codeReviewSaved.code).toBe(0);
        const planReviewSaved = await runCli(
          ["workflow", "save", "task-plan-review", taskPlanReviewUrl, "--version", "1"],
          dir,
          env,
        );
        expect(planReviewSaved.code).toBe(0);
        const planSource = await runCli(
          ["workflow", "source", "task-plan-review", "--version", "1", "--all"],
          dir,
          env,
        );
        expect(planSource.code).toBe(0);
        const planFiles = [...planSource.stdout.matchAll(/^--- (.+)$/gm)].map((match) => match[1]);
        expect(planFiles).toEqual([
          "plan-review.workflow.ts",
          "guidance/checklist.ts",
          "guidance/finding.ts",
          "guidance/prompt.ts",
          "guidance/rubric.ts",
          "guidance/types.ts",
        ]);
        const codeSourceJson = await runCli(
          ["workflow", "source", "task-code-review", "--version", "1", "--all", "--output", "json"],
          dir,
          env,
        );
        expect(codeSourceJson.code).toBe(0);
        expect(
          (JSON.parse(codeSourceJson.stdout) as { files: Array<{ path: string }> }).files.map(
            (file) => file.path,
          ),
        ).toEqual([
          "code-review.workflow.ts",
          "guidance/checklist.ts",
          "guidance/finding.ts",
          "guidance/prompt.ts",
          "guidance/rubric.ts",
          "guidance/types.ts",
        ]);

        const run = await runCli(["workflow", "run", "review-loop"], dir, env);
        expect(run.code).toBe(0);
        const runPayload = JSON.parse(run.stdout) as { runId: string; output: unknown };
        expect(runPayload.output).toBe(2);

        const attachedLaunch = await runCli(["workflow", "launch", "review-loop"], dir, env);
        expect(attachedLaunch.code).toBe(0);
        const attachedLaunchEvents = attachedLaunch.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });
        expect(attachedLaunchEvents[0]).toMatchObject({
          type: "launch.started",
          payload: {
            capabilityRef: join(env.KEEL_CAP_DIR, `${attachedLaunchEvents[0]?.payload.runId}.cap`),
          },
        });
        expect(attachedLaunchEvents.find((e) => e.type === "run.finished")?.payload).toEqual({
          output: 2,
        });

        const detached = await runCli(["workflow", "launch", "review-loop", "--detach"], dir, env);
        expect(detached.code).toBe(0);
        expect(detached.stdout).not.toContain("kc_run_");
        const detachedPayload = JSON.parse(detached.stdout) as {
          runId: string;
          capabilityRef: string;
        };
        expect(detachedPayload.capabilityRef).toBe(
          join(env.KEEL_CAP_DIR, `${detachedPayload.runId}.cap`),
        );
        await waitForCliStatus(detachedPayload.runId, dir, {
          ...env,
          KEEL_CAP_FILE: detachedPayload.capabilityRef,
        });

        const rawDetached = await runCli(
          ["workflow", "launch", "review-loop", "--detach", "--emit-capability"],
          dir,
          env,
        );
        expect(rawDetached.code).toBe(0);
        const rawDetachedPayload = JSON.parse(rawDetached.stdout) as {
          runId: string;
          capability: string;
        };
        expect(rawDetachedPayload.capability.startsWith("kc_run_")).toBe(true);
        expect(rawDetached.stdout).not.toContain("capabilityRef");
        await waitForCliStatus(rawDetachedPayload.runId, dir, {
          ...env,
          KEEL_RUN_CAP: rawDetachedPayload.capability,
        });

        const invalidDetached = await runCli(
          ["workflow", "launch", "review-loop", "--detach", "--output", "ndjson"],
          dir,
          env,
        );
        expect(invalidDetached.code).toBe(1);
        expect(invalidDetached.stderr).toContain(
          "--output ndjson is not available for workflow launch --detach",
        );

        const runSource = await runCli(["workflow", "source", "--run", runPayload.runId], dir, env);
        expect(runSource.code).toBe(0);
        expect(runSource.stdout).toContain("export default async function chain");
        const runSourceJson = await runCli(
          ["workflow", "source", "--run", runPayload.runId, "--output", "json"],
          dir,
          env,
        );
        expect(runSourceJson.code).toBe(0);
        expect(JSON.parse(runSourceJson.stdout)).toMatchObject({
          kind: "workflow-definition-source",
          lookup: { kind: "run", runId: runPayload.runId },
          definitionHash: payload.definitionHash,
        });
        const definitionSource = await runCli(
          ["workflow", "source", "--definition", payload.definitionHash, "--all"],
          dir,
          env,
        );
        expect(definitionSource.code).toBe(0);
        expect(definitionSource.stdout).toContain("--- chain.workflow.ts");
        const definitionSourceJson = await runCli(
          ["workflow", "source", "--definition", payload.definitionHash, "--output", "json"],
          dir,
          env,
        );
        expect(definitionSourceJson.code).toBe(0);
        expect(JSON.parse(definitionSourceJson.stdout)).toMatchObject({
          kind: "workflow-definition-source",
          lookup: { kind: "definition", definitionHash: payload.definitionHash },
          definitionName: "chain.workflow.ts",
        });
        const conflict = await runCli(
          ["workflow", "source", "review-loop", "--run", runPayload.runId],
          dir,
          env,
        );
        expect(conflict.code).toBe(1);
        expect(conflict.stderr).toContain("workflow source accepts exactly one selector");
        const invalidHash = await runCli(
          ["workflow", "source", "--definition", "wf_sha256_nothex"],
          dir,
          env,
        );
        expect(invalidHash.code).toBe(1);
        expect(invalidHash.stderr).toContain(
          "workflow definition hash must match wf_sha256_<64 hex chars>",
        );
        const invalidVersion = await runCli(
          ["workflow", "source", "--run", runPayload.runId, "--version", "1"],
          dir,
          env,
        );
        expect(invalidVersion.code).toBe(1);
        expect(invalidVersion.stderr).toContain(
          "--version is only valid with a saved workflow name",
        );
        const invalidFileAll = await runCli(
          ["workflow", "source", "review-loop", "--file", "chain.workflow.ts", "--all"],
          dir,
          env,
        );
        expect(invalidFileAll.code).toBe(1);
        expect(invalidFileAll.stderr).toContain("--file and --all are mutually exclusive");

        const deprecated = await runCli(
          ["workflow", "deprecate", "review-loop", "1", "audit"],
          dir,
          env,
        );
        expect(deprecated.code).toBe(0);
        const deprecatedSource = await runCli(
          ["workflow", "source", "review-loop", "--version", "1"],
          dir,
          env,
        );
        expect(deprecatedSource.code).toBe(0);
        expect(deprecatedSource.stdout).toContain("export default async function chain");

        const disabled = await runCli(
          ["workflow", "disable-version", "review-loop", "1"],
          dir,
          env,
        );
        expect(disabled.code).toBe(0);
        const disabledSource = await runCli(
          ["workflow", "source", "review-loop", "--version", "1"],
          dir,
          env,
        );
        expect(disabledSource.code).toBe(0);
        expect(disabledSource.stdout).toContain("export default async function chain");
        const deleted = await runCli(
          ["workflow", "delete-version", "review-loop", "1", "--yes"],
          dir,
          env,
        );
        expect(deleted.code).toBe(0);
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "execute runs a stateless TypeScript control script over the daemon",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-execute-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const capDir = join(dir, "caps");
      const script = join(dir, "control.ts");
      writeControlScript(script, chainUrl);
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(new MockProvider()),
      });
      await daemon.start();
      try {
        const env = {
          KEEL_SOCKET: socketPath,
          KEEL_DB: dbPath,
          KEEL_DIR: dir,
          KEEL_CAP_DIR: capDir,
        };
        const out = await runCli(["execute", script], dir, env);
        expect(out.code).toBe(0);
        const result = JSON.parse(out.stdout) as {
          runId: string;
          status: string;
          output: number;
          capabilityRef: string;
          reportNodeCount: number;
        };
        expect(result.status).toBe("finished");
        expect(result.output).toBe(2);
        expect(result.reportNodeCount).toBe(2);
        expect(result.capabilityRef).toBe(join(capDir, `${result.runId}.cap`));
        expect(readFileSync(result.capabilityRef, "utf8")).toContain("kc_run_");

        const raw = await runCli(["execute", "--emit-capability", script], dir, env);
        expect(raw.code).toBe(0);
        const rawResult = JSON.parse(raw.stdout) as { capability: string; capabilityRef?: string };
        expect(rawResult.capability.startsWith("kc_run_")).toBe(true);
        expect(rawResult.capabilityRef).toBeUndefined();
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "execute approve reuses the original admin credential after launching a child run",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-execute-approve-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const script = join(dir, "approve.ts");
      writeFileSync(
        script,
        `
        const run = await keel.launch({ workflow: ${JSON.stringify(gateUrl)}, input: null });
        await keel.wait(run.runId, { timeoutMs: 2000 });
        const decision = await keel.approve(run.runId, "approve-deploy");
        const done = await keel.wait(run.runId);
        return { decision: decision.status, output: done.output };
      `,
      );
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(new MockProvider()),
        adminToken: "kc_admin_execute_test",
      });
      await daemon.start();
      try {
        const out = await runCli(["execute", script], dir, {
          KEEL_SOCKET: socketPath,
          KEEL_DB: dbPath,
          KEEL_DIR: dir,
          KEEL_ADMIN_TOKEN: "kc_admin_execute_test",
        });
        expect(out.code).toBe(0);
        expect(JSON.parse(out.stdout)).toEqual({
          decision: "running",
          output: "deploy:approved",
        });
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "execute report restores the original credential for externally supplied runs",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-execute-report-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const script = join(dir, "report-parent.ts");
      writeFileSync(
        script,
        `
        const parentRunId = args[0];
        if (!parentRunId) throw new Error("missing parent run id");
        const child = await keel.launch({ workflow: ${JSON.stringify(chainUrl)}, input: { n: 1 } });
        await keel.wait(child.runId);
        const report = await keel.report(parentRunId);
        return { parentRunId, nodeCount: report.nodes.length };
      `,
      );
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(new MockProvider()),
        adminToken: "kc_admin_report_test",
      });
      await daemon.start();
      try {
        const env = {
          KEEL_SOCKET: socketPath,
          KEEL_DB: dbPath,
          KEEL_DIR: dir,
          KEEL_ADMIN_TOKEN: "kc_admin_report_test",
        };
        const parent = await runCli(["run", chainUrl, "--input", '{"n":2}'], dir, env);
        expect(parent.code).toBe(0);
        const parentRunId = (JSON.parse(parent.stdout) as { runId: string }).runId;

        const out = await runCli(["execute", script, "--", parentRunId], dir, env);
        expect(out.code).toBe(0);
        expect(JSON.parse(out.stdout)).toEqual({ parentRunId, nodeCount: 2 });
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "execute writes structured errors to stderr",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-execute-error-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const script = join(dir, "bad.ts");
      writeFileSync(script, 'throw new Error("bad control script kc_run_secretValue");\n');
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        agents: new AgentProviderRegistry().register(new MockProvider()),
      });
      await daemon.start();
      try {
        const out = await runCli(["execute", script], dir, {
          KEEL_SOCKET: socketPath,
          KEEL_DB: dbPath,
          KEEL_DIR: dir,
        });
        expect(out.code).toBe(1);
        expect(JSON.parse(out.stderr).error).toMatchObject({
          code: "execute_failed",
          message: "bad control script «redacted-capability»",
        });
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test(
    "workflow install task-review-guidance classifies created, unchanged, and conflicts",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-cli-workflow-install-"));
      const socketPath = join(dir, "keel.sock");
      const dbPath = join(dir, "keel.db");
      const daemon = new KeelDaemon({
        socketPath,
        dbPath,
        adminToken: "kc_admin_workflow_install_test",
      });
      await daemon.start();
      try {
        const env = {
          KEEL_SOCKET: socketPath,
          KEEL_DB: dbPath,
          KEEL_CAP_DIR: join(dir, "caps"),
          KEEL_ADMIN_TOKEN: "kc_admin_workflow_install_test",
        };
        const first = await runCli(
          ["workflow", "install", "task-review-guidance", "--output", "json"],
          dir,
          env,
        );
        expect(first.code).toBe(0);
        const firstPayload = JSON.parse(first.stdout) as {
          workflows: Array<{ name: string; version: number; status: string }>;
        };
        expect(firstPayload.workflows.map((workflow) => workflow.name)).toEqual([
          "task-code-review",
          "task-plan-review",
          "task-docs-review",
        ]);
        expect(firstPayload.workflows.map((workflow) => workflow.status)).toEqual([
          "created",
          "created",
          "created",
        ]);
        expect(firstPayload.workflows.map((workflow) => workflow.version)).toEqual([1, 1, 1]);

        const rerun = await runCli(
          ["workflow", "install", "task-review-guidance", "--output", "json"],
          dir,
          env,
        );
        expect(rerun.code).toBe(0);
        expect(
          (JSON.parse(rerun.stdout) as { workflows: Array<{ status: string }> }).workflows.map(
            (workflow) => workflow.status,
          ),
        ).toEqual(["unchanged", "unchanged", "unchanged"]);

        const docsSource = await runCli(
          ["workflow", "source", "task-docs-review", "--version", "1", "--all"],
          dir,
          env,
        );
        expect(docsSource.code).toBe(0);
        const docsFiles = [...docsSource.stdout.matchAll(/^--- (.+)$/gm)].map((match) => match[1]);
        expect(docsFiles).toEqual([
          "docs-review.workflow.ts",
          "guidance/checklist.ts",
          "guidance/finding.ts",
          "guidance/prompt.ts",
          "guidance/rubric.ts",
          "guidance/types.ts",
        ]);

        const changedRoot = createSourceBearingPackageRoot(join(dir, "changed-root"), {
          mutateDocs: true,
        });
        const changed = await runCli(
          ["workflow", "install", "task-review-guidance", "--output", "json"],
          dir,
          { ...env, KEEL_PACKAGE_ROOT: changedRoot },
        );
        expect(changed.code).toBe(0);
        const changedPayload = JSON.parse(changed.stdout) as {
          workflows: Array<{ name: string; version: number; status: string }>;
        };
        expect(changedPayload.workflows).toMatchObject([
          { name: "task-code-review", version: 1, status: "unchanged" },
          { name: "task-plan-review", version: 1, status: "unchanged" },
          { name: "task-docs-review", version: 2, status: "created" },
        ]);

        const conflict = await runCli(
          ["workflow", "install", "task-review-guidance", "--version", "1", "--output", "json"],
          dir,
          { ...env, KEEL_PACKAGE_ROOT: changedRoot },
        );
        expect(conflict.code).toBe(1);
        const conflictPayload = JSON.parse(conflict.stdout) as {
          workflows: Array<{ name: string; status: string; message?: string }>;
        };
        expect(conflictPayload.workflows).toMatchObject([
          { name: "task-code-review", status: "unchanged" },
          { name: "task-plan-review", status: "unchanged" },
          { name: "task-docs-review", status: "conflict" },
        ]);
        expect(conflictPayload.workflows[2]?.message).toContain(
          "version 1 already exists with a different definition hash",
        );

        const missingRoot = createSourceBearingPackageRoot(join(dir, "missing-root"));
        rmSync(join(missingRoot, "workflows"), { recursive: true, force: true });
        const missing = await runCli(
          ["workflow", "install", "task-review-guidance", "--output", "json"],
          dir,
          { ...env, KEEL_PACKAGE_ROOT: missingRoot },
        );
        expect(missing.code).toBe(1);
        const missingPayload = JSON.parse(missing.stdout) as {
          workflows: Array<{ status: string; message?: string }>;
        };
        expect(missingPayload.workflows.map((workflow) => workflow.status)).toEqual([
          "failed",
          "failed",
          "failed",
        ]);
        expect(missingPayload.workflows[0]?.message).toContain(
          "requires a source-bearing Keel checkout/package",
        );
      } finally {
        daemon.stop();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );

  test("execute writes structured errors for argument/setup failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-execute-arg-error-"));
    try {
      const out = await runCli(["execute", "--unknown"], dir, {
        KEEL_SOCKET: join(dir, "missing.sock"),
      });
      expect(out.code).toBe(1);
      expect(JSON.parse(out.stderr).error).toMatchObject({
        code: "execute_failed",
        message: "unknown execute flag --unknown",
      });
      expect(out.stderr).not.toContain("keel:");

      const output = await runCli(["execute", "--output", "text"], dir, {
        KEEL_SOCKET: join(dir, "missing.sock"),
      });
      expect(output.code).toBe(1);
      expect(JSON.parse(output.stderr).error.message).toContain(
        "--output text is not available for execute",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test(
    "unsupported output combinations fail before daemon connection",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "keel-output-combos-"));
      try {
        const env = { KEEL_SOCKET: join(dir, "missing.sock") };
        const listNdjson = await runCli(["list", "--output", "ndjson"], dir, env);
        expect(listNdjson.code).toBe(1);
        expect(listNdjson.stderr).toContain("--output ndjson is not available for list");

        const listInvalid = await runCli(["list", "--output", "xml"], dir, env);
        expect(listInvalid.code).toBe(1);
        expect(listInvalid.stderr).toContain("invalid --output xml for list");

        const watch = await runCli(["watch", "run_123", "--output", "json"], dir, env);
        expect(watch.code).toBe(1);
        expect(watch.stderr).toContain("--output json is not available for watch");

        const watchTools = await runCli(["watch", "run_123", "--tools"], dir, env);
        expect(watchTools.code).toBe(1);
        expect(watchTools.stderr).toContain(
          "--tools is only available for attached watch --output text",
        );

        const runTools = await runCli(["run", "--tools", "wf.ts"], dir, env);
        expect(runTools.code).toBe(1);
        expect(runTools.stderr).toContain(
          "--tools is only available for attached run --output text",
        );

        const workflowSourceMissing = await runCli(["workflow", "source"], dir, env);
        expect(workflowSourceMissing.code).toBe(1);
        expect(workflowSourceMissing.stderr).toContain(
          "workflow source requires a saved name, --run, or --definition",
        );

        const workflowSourceInvalidHash = await runCli(
          ["workflow", "source", "--definition", "wf_sha256_nothex"],
          dir,
          env,
        );
        expect(workflowSourceInvalidHash.code).toBe(1);
        expect(workflowSourceInvalidHash.stderr).toContain(
          "workflow definition hash must match wf_sha256_<64 hex chars>",
        );

        const workflowSourceEmptyHash = await runCli(
          ["workflow", "source", "--definition", ""],
          dir,
          env,
        );
        expect(workflowSourceEmptyHash.code).toBe(1);
        expect(workflowSourceEmptyHash.stderr).toContain(
          "workflow definition hash must match wf_sha256_<64 hex chars>",
        );

        const workflowSourceEmptyRun = await runCli(["workflow", "source", "--run", ""], dir, env);
        expect(workflowSourceEmptyRun.code).toBe(1);
        expect(workflowSourceEmptyRun.stderr).toContain(
          "workflow source --run needs a non-empty run id",
        );
        const workflowInstallUnknown = await runCli(
          ["workflow", "install", "unknown-package"],
          dir,
          env,
        );
        expect(workflowInstallUnknown.code).toBe(1);
        expect(workflowInstallUnknown.stderr).toContain(
          'unknown workflow package "unknown-package"',
        );
        expect(workflowInstallUnknown.stderr).not.toContain("Failed to connect");

        const attached = await runCli(["launch", "--output", "json", "wf.ts"], dir, env);
        expect(attached.code).toBe(1);
        expect(attached.stderr).toContain("--output json is not available for attached launch");

        const detachedTextTools = await runCli(
          ["launch", "--detach", "--output", "text", "--tools", "wf.ts"],
          dir,
          env,
        );
        expect(detachedTextTools.code).toBe(1);
        expect(detachedTextTools.stderr).toContain(
          "--tools is only available for attached launch --output text",
        );

        const detached = await runCli(
          ["launch", "--detach", "--output", "ndjson", "wf.ts"],
          dir,
          env,
        );
        expect(detached.code).toBe(1);
        expect(detached.stderr).toContain("--output ndjson is not available for launch --detach");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  );
});

type FakeWatchSubscription = {
  req: Parameters<DaemonClient["subscribeEvents"]>[0];
  onEvent: Parameters<DaemonClient["subscribeEvents"]>[1];
  onError: Parameters<DaemonClient["subscribeEvents"]>[2];
  onCaughtUp: Parameters<DaemonClient["subscribeEvents"]>[3];
};

function fakeWatchClient(run: (subscription: FakeWatchSubscription) => void): DaemonClient {
  return {
    subscribeEvents(
      req: FakeWatchSubscription["req"],
      onEvent: FakeWatchSubscription["onEvent"],
      onError?: FakeWatchSubscription["onError"],
      onCaughtUp?: FakeWatchSubscription["onCaughtUp"],
    ) {
      queueMicrotask(() => run({ req, onEvent, onError, onCaughtUp }));
      return () => {};
    },
  } as DaemonClient;
}

async function captureProcessWrites<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; writes: Array<{ stream: "stdout" | "stderr"; text: string }> }> {
  const writes: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const decoder = new TextDecoder();
  const text = (chunk: string | Uint8Array): string =>
    typeof chunk === "string" ? chunk : decoder.decode(chunk);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push({ stream: "stdout", text: text(chunk) });
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push({ stream: "stderr", text: text(chunk) });
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, writes };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeControlScript(path: string, workflowUrl: string): void {
  writeFileSync(
    path,
    `
      const run = await keel.launch({
        workflow: ${JSON.stringify(workflowUrl)},
        input: { n: 2 },
      });
      const settled = await keel.wait(run.runId);
      const report = await keel.report(run.runId);
        return {
          runId: run.runId,
          capabilityRef: run.capabilityRef,
          capability: run.capability,
          status: settled.status,
          output: settled.output,
          reportNodeCount: report.nodes.length,
        };
    `,
  );
}

async function waitForCliStatus(
  runId: string,
  cwd: string,
  env: Record<string, string>,
  status = "finished",
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 4000) {
    const out = await runCli(["get", runId], cwd, env);
    if (out.code === 0 && JSON.parse(out.stdout).status === status) return;
    await Bun.sleep(50);
  }
  throw new Error(`run ${runId} did not reach ${status}`);
}
