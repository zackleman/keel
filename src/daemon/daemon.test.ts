// Phase 12: the out-of-process daemon + thin clients.
// - multi-client: launch from one connection, observe from a second, resume.
// - CAS ownership fence prevents two daemons double-driving a run.
// - kill -9 the daemon mid-run, restart, and the run recovers and finishes.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockProvider } from "../agents/mock.ts";
import { AgentProviderRegistry } from "../agents/types.ts";
import { hashCapabilityToken } from "../auth/capabilities.ts";
import { JournalStore } from "../journal/store.ts";
import { SupervisorTools } from "../mcp/tools.ts";
import { captureWorkflowFile } from "../workflow-definitions/capture.ts";
import {
  WORKFLOW_SDK_ABI_VERSION,
  snapshotWorkflowSource,
} from "../workflow-definitions/snapshot.ts";
import { DaemonClient } from "./client.ts";
import { KeelDaemon } from "./server.ts";

const FIX = new URL("../kernel/realm/fixtures/", import.meta.url);
const chainUrl = captureWorkflowFile(new URL("chain.workflow.ts", FIX).pathname);
const spawnChildUrl = captureWorkflowFile(new URL("spawn-child.workflow.ts", FIX).pathname);
const spawnParkParentUrl = captureWorkflowFile(
  new URL("spawn-park-parent.workflow.ts", FIX).pathname,
);
const TEST_DAEMON = new URL("./test-daemon.ts", import.meta.url).pathname;
const onceUrl = captureWorkflowFile(
  new URL("./fixtures/once-pi.workflow.ts", import.meta.url).pathname,
);
const napUrl = captureWorkflowFile(
  new URL("../kernel/realm/fixtures/nap.workflow.ts", import.meta.url).pathname,
);
const signalUrl = captureWorkflowFile(
  new URL("../kernel/realm/fixtures/await-signal.workflow.ts", import.meta.url).pathname,
);
const gateUrl = captureWorkflowFile(
  new URL("../kernel/realm/fixtures/gate.workflow.ts", import.meta.url).pathname,
);
const gateThenAgentUrl = captureWorkflowFile(
  new URL("../kernel/realm/fixtures/gate-then-agent.workflow.ts", import.meta.url).pathname,
);
const signalThenAgentUrl = captureWorkflowFile(
  new URL("../kernel/realm/fixtures/signal-then-agent.workflow.ts", import.meta.url).pathname,
);
const ADMIN_TOKEN = "kc_admin_test";
const SUBMITTER_TOKEN = "kc_submitter_test";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keel-daemon-"));
});

describe("submission hardening", () => {
  test("submitter over-asks fail at launch with a structured ceiling error", async () => {
    const socketPath = join(dir, "submitter-ceiling.sock");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "submitter-ceiling.db"),
      adminToken: ADMIN_TOKEN,
      submitterToken: SUBMITTER_TOKEN,
    });
    await daemon.start();
    try {
      const response = await rawFrame(socketPath, {
        id: 1,
        method: "launchRun",
        credential: SUBMITTER_TOKEN,
        params: {
          source: `export default async function workflow(ctx) {
            return ctx.agent({ key: "unsafe", prompt: "x", toolPolicy: "unrestricted" });
          }`,
          input: null,
          target: dir,
        },
      });
      expect(response.error).toMatchObject({
        code: "capability_ceiling_exceeded",
        details: { profile: "untrusted-default" },
      });
      const store = JournalStore.open(join(dir, "submitter-ceiling.db"));
      expect(store.listRuns()).toEqual([]);
      store.close();
    } finally {
      daemon.stop();
    }
  });

  test("MCP approval grants caps and the reviewed definition can be promoted", async () => {
    const socketPath = join(dir, "submitter-escalation.sock");
    const dbPath = join(dir, "submitter-escalation.db");
    const source = `
      import { type Capabilities, type Ctx } from "@kcosr/keel";
      export default async function workflow(ctx: Ctx): Promise<string> {
        const decision = await ctx.human({
          key: "review:escalation",
          prompt: "Allow a reviewed host command?",
          requestedCaps: { fs: "workspace-write", shell: true, network: "none" },
        });
        if (decision.status !== "approved") return "denied";
        const workspace = await ctx.workspace({
          key: "workspace",
          mode: "direct",
          path: ctx.run.target,
        });
        const result = await ctx.command({
          key: "after-review",
          workspace,
          cwd: ".",
          mode: "argv",
          argv: ["/bin/sh", "-c", "printf granted"],
          capabilities: decision.grantedCaps as Partial<Capabilities>,
          timeoutMs: 5_000,
          maxStdoutBytes: 1_000,
          maxStderrBytes: 1_000,
        });
        return result.stdout;
      }
    `;
    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      adminToken: ADMIN_TOKEN,
      submitterToken: SUBMITTER_TOKEN,
      superviseMs: 100_000,
    });
    await daemon.start();
    let tools: SupervisorTools | null = null;
    try {
      const submitter = await DaemonClient.connect(socketPath);
      await submitter.authenticate(SUBMITTER_TOKEN);
      const launched = await submitter.launchRun({ source, input: null, target: dir });
      await submitter.authenticate(launched.capability as string);
      await submitter.waitForRun(launched.runId);
      expect((await submitter.getRun(launched.runId))?.status).toBe("waiting-human");

      tools = await SupervisorTools.connect({ socketPath, credential: ADMIN_TOKEN });
      const blockage = await tools.getRunBlockage(launched.runId);
      expect(blockage.approvalId).toBeTruthy();
      await tools.decideApproval(blockage.approvalId as string, "approved", "reviewed", {
        fs: "workspace-write",
        shell: true,
        network: "none",
        secrets: [],
      });
      await expect(submitter.waitForRun(launched.runId)).resolves.toMatchObject({
        status: "finished",
        output: { text: "granted", truncated: false },
      });

      await submitter.authenticate(ADMIN_TOKEN);
      await expect(submitter.saveWorkflow({ name: "reviewed-command", source })).rejects.toThrow(
        /requires reviewApproval/,
      );
      const saved = await submitter.saveWorkflow({
        name: "reviewed-command",
        source,
        reviewApproval: { runId: launched.runId, key: "review:escalation" },
      });
      const reviewedRun = await submitter.getRun(launched.runId);
      if (!reviewedRun) throw new Error("reviewed run missing");
      expect(saved.definitionHash).toBe(reviewedRun.definitionVersion);
      submitter.close();
    } finally {
      tools?.close();
      daemon.stop();
    }
  }, 15_000);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function rawRpc(
  socketPath: string,
  method: string,
  params: unknown,
): Promise<{ result?: unknown; error?: { message: string } }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buf = "";
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, method, params })}\n`));
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      socket.end();
      resolve(JSON.parse(line) as { result?: unknown; error?: { message: string } });
    });
    socket.on("error", reject);
  });
}

function rawFrame(socketPath: string, frame: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buf = "";
    socket.on("connect", () => socket.write(`${JSON.stringify(frame)}\n`));
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      socket.end();
      resolve(JSON.parse(line) as Record<string, unknown>);
    });
    socket.on("error", reject);
  });
}

function rawAdminRpc(
  socketPath: string,
  method: string,
  params: unknown,
): Promise<{ result?: unknown; error?: { message: string } }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buf = "";
    const fail = (err: unknown) => {
      socket.destroy();
      reject(err);
    };
    socket.on("connect", () =>
      socket.write(
        `${JSON.stringify({ id: 1, method: "authenticate", params: { token: ADMIN_TOKEN } })}\n`,
      ),
    );
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = JSON.parse(line) as {
          id?: number;
          result?: unknown;
          error?: { message: string };
        };
        if (msg.id === 1) {
          if (msg.error) return fail(new Error(msg.error.message));
          socket.write(`${JSON.stringify({ id: 2, method, params })}\n`);
        } else if (msg.id === 2) {
          socket.end();
          resolve(msg);
        }
        nl = buf.indexOf("\n");
      }
    });
    socket.on("error", fail);
  });
}

const migratedOldAbiSource =
  'import { passthrough } from "@kcosr/keel";\nexport default async () => passthrough<number>().parse(1);\n';
const NEXT_WORKFLOW_SDK_ABI_VERSION = WORKFLOW_SDK_ABI_VERSION + 1;

function oldAbiWorkflowManifest() {
  return {
    format: "keel.workflow-definition.v1",
    entry: "entry.ts",
    modules: [{ path: "entry.ts", code: migratedOldAbiSource }],
    externalImports: ["@kcosr/keel"],
    externalPackages: [{ name: "@kcosr/keel", root: "/old/keel", integrity: "sha256-old" }],
    sourceRoot: "client-captured://source",
    runtime: {
      bunVersion: Bun.version,
      keelDefinitionAbi: 1,
    },
  };
}

function makeV11OldAbiDueTimerDb(path: string): void {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE runs (
      run_id             TEXT PRIMARY KEY,
      workflow_name      TEXT,
      definition_version TEXT NOT NULL,
      workflow_ref       TEXT,
      status             TEXT NOT NULL,
      parent_run_id      TEXT,
      tenant_id          TEXT,
      input_ref          TEXT,
      output_ref         TEXT,
      error_json         TEXT,
      heartbeat_at_ms    INTEGER,
      runtime_owner_id   TEXT,
      created_at_ms      INTEGER NOT NULL,
      finished_at_ms     INTEGER
    );
    CREATE TABLE schedules (
      name         TEXT PRIMARY KEY,
      workflow_ref TEXT NOT NULL,
      input_json   TEXT,
      interval_ms  INTEGER NOT NULL,
      next_fire_ms INTEGER NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      last_run_id  TEXT
    );
    CREATE TABLE timers (
      run_id     TEXT NOT NULL,
      stable_key TEXT NOT NULL,
      fire_at_ms INTEGER NOT NULL,
      fired      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (run_id, stable_key)
    );
    CREATE TABLE workflow_definitions (
      hash          TEXT PRIMARY KEY,
      name          TEXT,
      kind          TEXT NOT NULL,
      code          TEXT NOT NULL,
      source_map    TEXT,
      manifest_json TEXT,
      created_at_ms INTEGER NOT NULL
    );
  `);
  db.query("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '11')").run();
  db.query(
    `INSERT INTO workflow_definitions (
      hash, name, kind, code, source_map, manifest_json, created_at_ms
    ) VALUES ('wf_sha256_old_sdk_daemon', 'old-abi', 'source', ?, NULL, ?, 1)`,
  ).run(migratedOldAbiSource, JSON.stringify(oldAbiWorkflowManifest()));
  db.query(
    `INSERT INTO runs (
      run_id, workflow_name, definition_version, workflow_ref, status,
      input_ref, created_at_ms
    ) VALUES ('old-abi-timer', 'old-abi', 'wf_sha256_old_sdk_daemon', 'stdin', 'waiting-timer', 'null', 1)`,
  ).run();
  db.query(
    "INSERT INTO timers (run_id, stable_key, fire_at_ms, fired) VALUES ('old-abi-timer', 'sleep', 0, 0)",
  ).run();
  db.close();
}

describe("daemon multi-client over the socket", () => {
  test("raw socket responses preserve request ids and unknown-method precedence", async () => {
    const socketPath = join(dir, "raw-wire.sock");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "raw-wire.db"),
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      const weirdId = { nested: ["id"] };
      const unknown = await rawFrame(socketPath, {
        id: weirdId,
        method: "doesNotExist",
        params: "not-an-object",
      });
      expect(unknown.id).toEqual(weirdId);
      expect((unknown.error as { message?: string } | undefined)?.message).toBe(
        "unknown method doesNotExist",
      );

      const missingId = await rawFrame(socketPath, { method: "ping", params: {} });
      expect("id" in missingId).toBe(false);
      expect(missingId.result).toMatchObject({ ok: true, ownerId: daemon.ownerId });
    } finally {
      daemon.stop();
    }
  });

  test("raw launchRun rejects missing or blank targets", async () => {
    const socketPath = join(dir, "target.sock");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "target.db"),
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      const missing = await rawRpc(socketPath, "launchRun", {
        source: chainUrl.source,
        input: null,
        name: "missing",
      });
      expect(missing.error?.message).toMatch(/launchRun requires target/);

      const blank = await rawRpc(socketPath, "launchRun", {
        source: chainUrl.source,
        input: null,
        name: "blank",
        target: "   ",
      });
      expect(blank.error?.message).toMatch(/non-empty target/);
    } finally {
      daemon.stop();
    }
  });

  test("raw putSchedule rejects missing or blank targets", async () => {
    const socketPath = join(dir, "schedule-target.sock");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "schedule-target.db"),
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      const missing = await rawAdminRpc(socketPath, "putSchedule", {
        name: "missing-target",
        source: chainUrl.source,
        input: null,
        intervalMs: 60_000,
      });
      expect(missing.error?.message).toMatch(/putSchedule requires target/);

      const blank = await rawAdminRpc(socketPath, "putSchedule", {
        name: "blank-target",
        source: chainUrl.source,
        input: null,
        target: "   ",
        intervalMs: 60_000,
      });
      expect(blank.error?.message).toMatch(/non-empty target/);

      const legacy = await rawAdminRpc(socketPath, "putSchedule", {
        name: "legacy-target",
        source: chainUrl.source,
        input: null,
        clientDefaultTarget: dir,
        intervalMs: 60_000,
      });
      expect(legacy.error?.message).toMatch(/putSchedule requires target/);
    } finally {
      daemon.stop();
    }
  });

  test("raw launch and schedule reject malformed workflow bundles before persistence", async () => {
    const socketPath = join(dir, "malformed-bundle.sock");
    const dbPath = join(dir, "malformed-bundle.db");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      const malformed = [
        {
          label: "bad-path",
          source: {
            kind: "bundle",
            entry: "../entry.ts",
            modules: [{ path: "../entry.ts", code: "export default async () => 1;\n" }],
          },
        },
        {
          label: "duplicate",
          source: {
            kind: "bundle",
            entry: "entry.ts",
            modules: [
              { path: "entry.ts", code: "export default async () => 1;\n" },
              { path: "entry.ts", code: "export default async () => 2;\n" },
            ],
          },
        },
        {
          label: "missing-entry",
          source: {
            kind: "bundle",
            entry: "missing.ts",
            modules: [{ path: "entry.ts", code: "export default async () => 1;\n" }],
          },
        },
        {
          label: "unreachable-extra",
          source: {
            kind: "bundle",
            entry: "entry.ts",
            modules: [
              { path: "entry.ts", code: "export default async () => 1;\n" },
              { path: "extra.ts", code: "export const extra = 1;\n" },
            ],
          },
        },
      ];

      for (const { label, source } of malformed) {
        const launched = await rawRpc(socketPath, "launchRun", {
          source,
          input: null,
          target: dir,
          name: label,
        });
        expect(launched.error?.message).toBeTruthy();

        const scheduled = await rawAdminRpc(socketPath, "putSchedule", {
          name: label,
          source,
          input: null,
          target: dir,
          intervalMs: 60_000,
        });
        expect(scheduled.error?.message).toBeTruthy();
      }

      expect((await rawAdminRpc(socketPath, "listRuns", {})).result).toEqual([]);
    } finally {
      daemon.stop();
    }

    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query("SELECT count(*) AS count FROM schedules").get() as { count: number };
      expect(row.count).toBe(0);
    } finally {
      db.close();
    }
  });

  test("startup reconciles stale retained workspace rows", async () => {
    const socketPath = join(dir, "reconcile.sock");
    const dbPath = join(dir, "reconcile.db");
    const workspaceStore = join(dir, "workspaces");
    mkdirSync(join(workspaceStore, "r-active"), { recursive: true });
    const activePath = join(workspaceStore, "r-active", "agent");
    mkdirSync(activePath, { recursive: true });

    const store = JournalStore.open(dbPath);
    const insertSessionWorkspaceFixture = (opts: {
      runId: string;
      workspacePath: string;
      status: "creating" | "active";
      lastTurnKey?: string | null;
      lastTurnAttempt?: number | null;
    }) =>
      store.insertAgentWorkspace({
        runId: opts.runId,
        workspaceId: "ws_agent",
        mode: "worktree",
        ownerKind: "agent_session",
        key: "agent",
        lastAttempt: null,
        retentionPolicy: "retain",
        workspacePath: opts.workspacePath,
        sourceKind: "worktree-git",
        sourcePath: dir,
        sourceUri: null,
        sourceBare: null,
        sourceMergeEligible: true,
        suppliedPath: null,
        sourceRef: "HEAD",
        resolvedRef: null,
        checkoutBranch: null,
        worktreeCheckoutKind: "detached",
        worktreeBranchOwned: false,
        baseCommit: "base",
        copyBaselinePath: null,
        creationErrorJson: null,
        workspaceIdentityJson: "{}",
        workspaceIdentityHash: `${opts.runId}-agent`,
        owned: true,
        status: opts.status,
        failureSeen: false,
        lastTurnKey: opts.lastTurnKey ?? null,
        lastTurnAttempt: opts.lastTurnAttempt ?? null,
        activeHolderKind: null,
        activeHolderKey: null,
        activeHolderAttempt: null,
        activeStartedAtMs: null,
        lastDiffEventSeq: null,
        lastErrorEventSeq: null,
        cleanupErrorJson: null,
        createdAtMs: 1,
        updatedAtMs: 1,
        mergedAtMs: null,
        discardedAtMs: null,
        removedAtMs: null,
      });
    store.insertRun({
      runId: "r-creating",
      workflowName: "wf",
      definitionVersion: "wf_sha256_fixture",
      workflowRef: null,
      runTarget: dir,
      status: "waiting-timer",
      parentRunId: null,
      tenantId: null,
      inputRef: "null",
      outputRef: null,
      errorJson: null,
      heartbeatAtMs: 0,
      runtimeOwnerId: "dead-daemon",
      launchAuthorityJson: null,
      createdAtMs: 1,
      finishedAtMs: null,
    });
    insertSessionWorkspaceFixture({
      runId: "r-creating",
      workspacePath: join(workspaceStore, "r-creating", "agent"),
      status: "creating",
    });
    store.insertRun({
      runId: "r-active",
      workflowName: "wf",
      definitionVersion: "wf_sha256_fixture",
      workflowRef: null,
      runTarget: dir,
      status: "finished",
      parentRunId: null,
      tenantId: null,
      inputRef: "null",
      outputRef: null,
      errorJson: null,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      launchAuthorityJson: null,
      createdAtMs: 1,
      finishedAtMs: 2,
    });
    insertSessionWorkspaceFixture({
      runId: "r-active",
      workspacePath: activePath,
      status: "active",
      lastTurnKey: "turn",
      lastTurnAttempt: 1,
    });
    store.insertRun({
      runId: "r-terminal-missing",
      workflowName: "wf",
      definitionVersion: "wf_sha256_fixture",
      workflowRef: null,
      runTarget: dir,
      status: "failed",
      parentRunId: null,
      tenantId: null,
      inputRef: "null",
      outputRef: null,
      errorJson: null,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      launchAuthorityJson: null,
      createdAtMs: 1,
      finishedAtMs: 2,
    });
    insertSessionWorkspaceFixture({
      runId: "r-terminal-missing",
      workspacePath: join(workspaceStore, "missing", "agent"),
      status: "creating",
    });
    store.close();

    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      workspaceStore,
      adminToken: ADMIN_TOKEN,
      clock: () => 100_000,
      superviseMs: 100_000,
    });
    await daemon.start();
    daemon.stop();

    const reopened = JournalStore.open(dbPath);
    try {
      expect(reopened.getAgentWorkspaceByKey("r-creating", "agent_session", "agent")).toBeNull();
      expect(reopened.getAgentWorkspaceByKey("r-active", "agent_session", "agent")?.status).toBe(
        "pending_review",
      );
      expect(
        reopened.getAgentWorkspaceByKey("r-terminal-missing", "agent_session", "agent")?.status,
      ).toBe("abandoned");
    } finally {
      reopened.close();
    }
  });

  test("launch from one client, observe + result from a second", async () => {
    const socketPath = join(dir, "k.sock");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "k.db"),
      agents: new AgentProviderRegistry().register(new MockProvider()),
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      const a = await DaemonClient.connect(socketPath);
      const b = await DaemonClient.connect(socketPath);

      const { runId, capability } = await a.launchRun({
        ...chainUrl,
        input: { n: 3 },
        name: "chain",
      });
      expect(capability?.startsWith("kc_run_")).toBe(true);
      await expect(b.waitForRun(runId)).rejects.toThrow(/no capability presented/);
      await b.authenticate(capability as string);
      const out = await b.waitForRun(runId); // a different connection awaits it
      expect(out.status).toBe("finished");
      expect(out.output).toBe(3);

      const projection = await b.getRun(runId);
      expect(projection?.stats).toEqual({ steps: 3, agents: 0, checkpointCount: 0, artifacts: 0 });
      await a.authenticate(ADMIN_TOKEN);
      const runs = await a.listRuns();
      expect(Array.isArray(runs)).toBe(true);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        runId,
        workflowName: "chain",
        status: "finished",
        parentRunId: null,
      });
      expect(typeof runs[0]?.createdAtMs).toBe("number");
      expect(typeof runs[0]?.finishedAtMs).toBe("number");
      a.close();
      b.close();
    } finally {
      daemon.stop();
    }
  });

  test("saved workflow save, source, launch, and saved-ref schedule pin one definition hash", async () => {
    const socketPath = join(dir, "saved.sock");
    const dbPath = join(dir, "saved.db");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      adminToken: ADMIN_TOKEN,
      clock: () => 1000,
    });
    await daemon.start();
    try {
      const admin = await DaemonClient.connect(socketPath);
      await admin.authenticate(ADMIN_TOKEN);
      const preview = await admin.previewWorkflowDefinition({ source: chainUrl.source });
      expect(preview.definitionHash.startsWith("wf_sha256_")).toBe(true);
      expect(new Database(dbPath).query("SELECT name FROM saved_workflows").all()).toEqual([]);
      const saved = await admin.saveWorkflow({
        name: "review-loop",
        source: chainUrl.source,
        workflowName: "review",
        defaultInput: { n: 2 },
        defaultTarget: dir,
        title: "Review loop",
      });
      expect(saved.version).toBe(1);
      expect(saved.definitionHash).toBe(preview.definitionHash);
      expect(saved.definitionHash.startsWith("wf_sha256_")).toBe(true);
      const source = await admin.getSavedWorkflowSource({ name: "review-loop", all: true });
      expect(source.files.some((file) => file.path.endsWith("chain.workflow.ts"))).toBe(true);

      const launched = await admin.launchSavedWorkflow({ ref: { name: "review-loop" } });
      if (launched.capability) await admin.authenticate(launched.capability);
      const out = await admin.waitForRun(launched.runId);
      expect(out.status).toBe("finished");
      expect(out.output).toBe(2);
      await admin.authenticate(ADMIN_TOKEN);
      const run = await admin.getRun(launched.runId);
      expect(run?.definitionVersion).toBe(saved.definitionHash);
      const runRow = new Database(dbPath)
        .query<{ workflow_ref: string | null }, [string]>(
          "SELECT workflow_ref FROM runs WHERE run_id = ?",
        )
        .get(launched.runId);
      expect(runRow?.workflow_ref).toBe(`saved:review-loop@1 ${saved.definitionHash}`);

      await admin.putSchedule({
        name: "hourly-review",
        savedRef: { name: "review-loop", version: 1 },
        intervalMs: 60_000,
      });
      const row = new Database(dbPath)
        .query<{ workflow_ref: string }, [string]>(
          "SELECT workflow_ref FROM schedules WHERE name = ?",
        )
        .get("hourly-review");
      expect(row?.workflow_ref).toBe(saved.definitionHash);
      expect(await admin.setScheduleEnabled("hourly-review", false)).toEqual({
        name: "hourly-review",
        enabled: false,
      });
      expect((await admin.getSchedule({ name: "hourly-review" }))?.enabled).toBe(false);
      expect(await admin.deleteSchedule("hourly-review")).toEqual({
        name: "hourly-review",
        deleted: true,
      });
      expect(await admin.getSchedule({ name: "hourly-review" })).toBeNull();
      await admin.deprecateSavedWorkflowVersion({
        name: "review-loop",
        version: 1,
        message: "audit",
      });
      await admin.setSavedWorkflowVersionEnabled("review-loop", 1, false);
      expect(
        (await admin.getSavedWorkflowSource({ name: "review-loop", version: 1 })).files[0]?.code,
      ).toContain("export default async function chain");
      admin.close();
    } finally {
      daemon.stop();
    }
  });

  test("saved workflow schedule validates selector exclusivity before writing", async () => {
    const socketPath = join(dir, "saved-schedule-invalid.sock");
    const dbPath = join(dir, "saved-schedule-invalid.db");
    const daemon = new KeelDaemon({ socketPath, dbPath, adminToken: ADMIN_TOKEN });
    await daemon.start();
    try {
      const both = await rawAdminRpc(socketPath, "putSchedule", {
        name: "bad",
        source: chainUrl.source,
        savedRef: { name: "missing" },
        target: dir,
        intervalMs: 60_000,
      });
      expect(both.error?.message).toMatch(/exactly one/);
      const neither = await rawAdminRpc(socketPath, "putSchedule", {
        name: "bad",
        target: dir,
        intervalMs: 60_000,
      });
      expect(neither.error?.message).toMatch(/exactly one/);
      const invalidEnabled = await rawAdminRpc(socketPath, "setScheduleEnabled", {
        name: "bad",
        enabled: "yes",
      });
      expect(invalidEnabled.error?.message).toMatch(/boolean enabled/);
      const invalidDelete = await rawAdminRpc(socketPath, "deleteSchedule", { name: "" });
      expect(invalidDelete.error?.message).toMatch(/non-empty schedule name/);
      const count = new Database(dbPath)
        .query<{ count: number }, []>("SELECT count(*) AS count FROM schedules")
        .get();
      expect(count?.count).toBe(0);
    } finally {
      daemon.stop();
    }
  });

  test("saved workflow schedule validates referenced definitions before writing", async () => {
    const socketPath = join(dir, "saved-schedule-definition.sock");
    const dbPath = join(dir, "saved-schedule-definition.db");
    const daemon = new KeelDaemon({ socketPath, dbPath, adminToken: ADMIN_TOKEN });
    await daemon.start();
    try {
      const admin = await DaemonClient.connect(socketPath);
      await admin.authenticate(ADMIN_TOKEN);
      const saved = await admin.saveWorkflow({
        name: "review-loop",
        source: chainUrl.source,
        defaultTarget: dir,
      });
      const db = new Database(dbPath);
      db.query("DELETE FROM workflow_definitions WHERE hash = ?").run(saved.definitionHash);
      db.close();
      await expect(
        admin.putSchedule({
          name: "bad-saved-ref",
          savedRef: { name: "review-loop" },
          intervalMs: 60_000,
        }),
      ).rejects.toThrow(/not found/);
      const count = new Database(dbPath)
        .query<{ count: number }, []>("SELECT count(*) AS count FROM schedules")
        .get();
      expect(count?.count).toBe(0);
      admin.close();
    } finally {
      daemon.stop();
    }
  });

  test("saved workflow raw auth, default target, and disabled launch fail closed", async () => {
    const socketPath = join(dir, "saved-fail-closed.sock");
    const dbPath = join(dir, "saved-fail-closed.db");
    const daemon = new KeelDaemon({ socketPath, dbPath, adminToken: ADMIN_TOKEN });
    await daemon.start();
    try {
      const unauthSave = await rawRpc(socketPath, "saveWorkflow", {
        name: "hidden",
        source: chainUrl.source,
      });
      expect(unauthSave.error?.message).toMatch(/no capability presented/);
      const unauthRun = await rawRpc(socketPath, "launchSavedWorkflow", {
        ref: { name: "hidden" },
      });
      expect(unauthRun.error?.message).toMatch(/no capability presented/);
      const unauthSource = await rawRpc(socketPath, "getSavedWorkflowSource", {
        name: "hidden",
      });
      expect(unauthSource.error?.message).toMatch(/no capability presented/);
      const unauthList = await rawRpc(socketPath, "listSavedWorkflows", {});
      expect(unauthList.error?.message).toMatch(/no capability presented/);
      const unauthPreview = await rawRpc(socketPath, "previewWorkflowDefinition", {
        source: chainUrl.source,
      });
      expect(unauthPreview.error?.message).toMatch(/no capability presented/);

      const admin = await DaemonClient.connect(socketPath);
      await admin.authenticate(ADMIN_TOKEN);
      await admin.saveWorkflow({
        name: "bad-target",
        source: chainUrl.source,
        defaultTarget: "   ",
      });
      await expect(admin.launchSavedWorkflow({ ref: { name: "bad-target" } })).rejects.toThrow(
        /non-empty target/,
      );
      await admin.saveWorkflow({
        name: "disabled-name",
        source: chainUrl.source,
        defaultTarget: dir,
      });
      await admin.setSavedWorkflowDisabled("disabled-name", true);
      await expect(admin.launchSavedWorkflow({ ref: { name: "disabled-name" } })).rejects.toThrow(
        /disabled/,
      );
      await admin.saveWorkflow({
        name: "no-target",
        source: chainUrl.source,
      });
      const legacyTarget = await rawAdminRpc(socketPath, "launchSavedWorkflow", {
        ref: { name: "no-target" },
        clientDefaultTarget: dir,
      });
      expect(legacyTarget.error?.message).toMatch(/launchSavedWorkflow requires target/);
      await expect(admin.launchSavedWorkflow({ ref: { name: "no-target" } })).rejects.toThrow(
        /launchSavedWorkflow requires target/,
      );
      admin.close();
    } finally {
      daemon.stop();
    }
  });
});

describe("capability auth", () => {
  test("a run capability scopes access to one run; admin is required for daemon-wide list", async () => {
    const socketPath = join(dir, "auth.sock");
    const dbPath = join(dir, "auth.db");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      agents: new AgentProviderRegistry().register(new MockProvider()),
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      // unauthenticated → rejected
      const anon = await DaemonClient.connect(socketPath);
      await expect(anon.listRuns()).rejects.toThrow(/no capability presented/);
      await expect(anon.listSchedules()).rejects.toThrow(/no capability presented/);
      anon.close();

      const launcher = await DaemonClient.connect(socketPath);
      const first = await launcher.launchRun({
        ...chainUrl,
        input: { n: 1 },
        name: "chain",
      });
      expect(first.capability?.startsWith("kc_run_")).toBe(true);
      await launcher.authenticate(first.capability as string);
      await launcher.waitForRun(first.runId);

      await launcher.authenticate(ADMIN_TOKEN);
      const second = await launcher.launchRun({
        ...chainUrl,
        input: { n: 2 },
        name: "chain",
      });
      await launcher.authenticate(second.capability as string);
      await launcher.waitForRun(second.runId);

      const scoped = await DaemonClient.connect(socketPath);
      await scoped.authenticate(first.capability as string);
      expect((await scoped.getRun(first.runId))?.status).toBe("finished");
      const firstSource = await scoped.getWorkflowDefinitionSource({
        lookup: { kind: "run", runId: first.runId },
      });
      expect(firstSource.files[0]?.entry).toBe(true);
      await expect(scoped.getRun(second.runId)).rejects.toThrow(/different resource/);
      await expect(
        scoped.getWorkflowDefinitionSource({ lookup: { kind: "run", runId: second.runId } }),
      ).rejects.toThrow(/different resource/);
      await expect(
        scoped.getWorkflowDefinitionSource({
          lookup: { kind: "definition", definitionHash: firstSource.definitionHash },
        }),
      ).rejects.toThrow(/admin/);
      await expect(scoped.getBlockage(second.runId)).rejects.toThrow(/different resource/);
      await expect(scoped.waitForRun(second.runId)).rejects.toThrow(/different resource/);
      await expect(scoped.resumeRun(second.runId)).rejects.toThrow(/different resource/);
      await expect(scoped.interruptRun(second.runId)).rejects.toThrow(/different resource/);
      await expect(scoped.retryRun(second.runId)).rejects.toThrow(/different resource/);
      await expect(scoped.rewindRun(second.runId, "compute")).rejects.toThrow(/different resource/);
      await expect(scoped.forkRun(second.runId)).rejects.toThrow(/different resource/);
      await expect(scoped.sendSignal(second.runId, "go", null)).rejects.toThrow(
        /different resource/,
      );
      await expect(scoped.listRuns()).rejects.toThrow(/admin/);
      await expect(scoped.listSchedules()).rejects.toThrow(/admin/);
      await expect(scoped.getSchedule({ name: "hourly" })).rejects.toThrow(/admin/);
      await expect(scoped.listSettings()).rejects.toThrow(/admin/);
      await expect(scoped.getSetting("agent.defaultTimeoutMs")).rejects.toThrow(/admin/);
      await expect(
        scoped.putSetting({ key: "agent.defaultTimeoutMs", value: 7200000 }),
      ).rejects.toThrow(/admin/);
      await expect(scoped.deleteSetting({ key: "agent.defaultTimeoutMs" })).rejects.toThrow(
        /admin/,
      );
      await expect(
        scoped.checkSetting({ key: "agent.defaultTimeoutMs", value: 7200000 }),
      ).rejects.toThrow(/admin/);

      const capStore = JournalStore.open(dbPath);
      const readOnlyToken = "kc_run_read_only_source";
      try {
        const capRow = capStore.getCapabilityByHash(
          hashCapabilityToken(first.capability as string),
        );
        expect(JSON.parse(capRow?.actionsJson ?? "[]")).toContain("run:source");
        capStore.putCapability({
          id: "cap_run_read_only_source",
          secretHash: hashCapabilityToken(readOnlyToken),
          resourceJson: JSON.stringify({ kind: "run", runId: first.runId }),
          actionsJson: JSON.stringify(["run:read"]),
          createdAtMs: 1,
          expiresAtMs: null,
          revokedAtMs: null,
          note: null,
        });
      } finally {
        capStore.close();
      }
      const readOnly = await DaemonClient.connect(socketPath);
      await readOnly.authenticate(readOnlyToken);
      expect((await readOnly.getRun(first.runId))?.runId).toBe(first.runId);
      await expect(
        readOnly.getWorkflowDefinitionSource({ lookup: { kind: "run", runId: first.runId } }),
      ).rejects.toThrow(/run:source/);

      const admin = await DaemonClient.connect(socketPath);
      await admin.authenticate(ADMIN_TOKEN);
      await admin.putSchedule({
        name: "hourly",
        source: chainUrl.source,
        workflowName: "hourly",
        input: { n: 1 },
        intervalMs: 60_000,
      });
      expect((await admin.listSchedules()).map((schedule) => schedule.name)).toEqual(["hourly"]);
      expect(await admin.getSchedule({ name: "hourly" })).toMatchObject({
        name: "hourly",
        definitionState: "available",
        workflowName: "chain",
      });
      expect((await admin.listRuns()).map((r) => r.runId).sort()).toEqual(
        [first.runId, second.runId].sort(),
      );
      expect(
        (
          await admin.getWorkflowDefinitionSource({
            lookup: { kind: "definition", definitionHash: firstSource.definitionHash },
          })
        ).definitionHash,
      ).toBe(firstSource.definitionHash);
      expect(await admin.getSetting("agent.defaultTimeoutMs")).toMatchObject({
        key: "agent.defaultTimeoutMs",
        value: 3600000,
      });
      launcher.close();
      scoped.close();
      readOnly.close();
      admin.close();
    } finally {
      daemon.stop();
    }
  });

  test("saved workflow scoped capabilities separate read, save, run, list, and delete", async () => {
    const socketPath = join(dir, "workflow-auth.sock");
    const dbPath = join(dir, "workflow-auth.db");
    const store = JournalStore.open(dbPath);
    const readToken = "kc_workflow_read";
    const saveToken = "kc_workflow_save";
    const runToken = "kc_workflow_run";
    try {
      store.putCapability({
        id: "cap_workflow_read",
        secretHash: hashCapabilityToken(readToken),
        resourceJson: JSON.stringify({ kind: "workflow", name: "review-loop" }),
        actionsJson: JSON.stringify(["workflow:read"]),
        createdAtMs: 1,
        expiresAtMs: null,
        revokedAtMs: null,
        note: null,
      });
      store.putCapability({
        id: "cap_workflow_save",
        secretHash: hashCapabilityToken(saveToken),
        resourceJson: JSON.stringify({ kind: "workflow", name: "review-loop" }),
        actionsJson: JSON.stringify(["workflow:save"]),
        createdAtMs: 1,
        expiresAtMs: null,
        revokedAtMs: null,
        note: null,
      });
      store.putCapability({
        id: "cap_workflow_run",
        secretHash: hashCapabilityToken(runToken),
        resourceJson: JSON.stringify({ kind: "workflow", name: "review-loop", version: 1 }),
        actionsJson: JSON.stringify(["workflow:run"]),
        createdAtMs: 1,
        expiresAtMs: null,
        revokedAtMs: null,
        note: null,
      });
    } finally {
      store.close();
    }
    const daemon = new KeelDaemon({ socketPath, dbPath, adminToken: ADMIN_TOKEN });
    await daemon.start();
    try {
      const saver = await DaemonClient.connect(socketPath);
      await saver.authenticate(saveToken);
      await saver.saveWorkflow({
        name: "review-loop",
        version: 1,
        source: chainUrl.source,
        defaultTarget: dir,
      });
      await expect(saver.previewWorkflowDefinition({ source: chainUrl.source })).rejects.toThrow(
        /admin/,
      );
      await expect(saver.getSavedWorkflow("review-loop")).rejects.toThrow(/workflow:read/);
      await expect(saver.deleteSavedWorkflow("review-loop")).rejects.toThrow(/admin/);

      const reader = await DaemonClient.connect(socketPath);
      await reader.authenticate(readToken);
      expect(await reader.getSavedWorkflow("review-loop")).toMatchObject({ name: "review-loop" });
      await expect(reader.listSavedWorkflows()).rejects.toThrow(/admin/);

      await saver.authenticate(ADMIN_TOKEN);
      await saver.saveWorkflow({
        name: "review-loop",
        version: 2,
        source: chainUrl.source,
        defaultTarget: dir,
        allowDuplicateDefinition: true,
      });

      const runner = await DaemonClient.connect(socketPath);
      await runner.authenticate(runToken);
      await expect(runner.launchSavedWorkflow({ ref: { name: "review-loop" } })).rejects.toThrow(
        /different resource/,
      );
      const launched = await runner.launchSavedWorkflow({
        ref: { name: "review-loop", version: 1 },
        input: { n: 1 },
      });
      expect(launched.capability?.startsWith("kc_run_")).toBe(true);
      await runner.authenticate(launched.capability as string);
      expect((await runner.waitForRun(launched.runId)).output).toBe(1);
      saver.close();
      reader.close();
      runner.close();
    } finally {
      daemon.stop();
    }
  });

  test("revocation interrupts long-lived waits and event streams", async () => {
    const socketPath = join(dir, "revoke.sock");
    const dbPath = join(dir, "revoke.db");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      agents: new AgentProviderRegistry().register(
        new MockProvider({ default: { outputs: ['{"value":1}'], delayMs: 1000 } }),
      ),
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      const client = await DaemonClient.connect(socketPath);
      const { runId, capability } = await client.launchRun({
        ...onceUrl,
        input: null,
        name: "once",
      });
      await client.authenticate(capability as string);

      const events: string[] = [];
      const unsubscribe = client.subscribeEvents(
        { runId: runId, cursor: { kind: "beginning" } },
        (event) => events.push(event.type),
      );
      const waiting = client.waitForRun(runId);
      await Bun.sleep(150);

      const store = JournalStore.open(dbPath);
      const capRow = store.getCapabilityByHash(hashCapabilityToken(capability as string));
      store.revokeCapability(capRow?.id as string, Date.now());
      store.close();

      await expect(waiting).rejects.toThrow(/revoked/);
      await until(() => Promise.resolve(events.includes("authorization.failed")), 2000);
      unsubscribe();
      await client.authenticate(ADMIN_TOKEN);
      await client.waitForRun(runId);
      client.close();
    } finally {
      daemon.stop();
    }
  }, 8000);

  test("subscriptions backfill existing durable events over the socket", async () => {
    const socketPath = join(dir, "backfill.sock");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "backfill.db"),
      agents: new AgentProviderRegistry().register(new MockProvider()),
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      const client = await DaemonClient.connect(socketPath);
      const { runId, capability } = await client.launchRun({
        ...chainUrl,
        input: { n: 2 },
        name: "chain",
      });
      await client.authenticate(capability as string);
      await client.waitForRun(runId);

      const events: string[] = [];
      let finishedSeq = 0;
      const controls: string[] = [];
      const caughtUp: Array<string | null> = [];
      const unsubscribe = client.subscribeEvents(
        { runId: runId, cursor: { kind: "beginning" }, includeControlFrames: true },
        (event) => {
          events.push(event.type);
          if (event.kind === "durable" && event.type === "run.finished") finishedSeq = event.seq;
        },
        undefined,
        (result) => caughtUp.push(result.closedStatus),
        (frame) => controls.push(`${frame.type}:${frame.cursor.seq}`),
      );
      await until(() => Promise.resolve(events.includes("run.finished")), 2000);
      await until(
        () => Promise.resolve(controls.some((frame) => frame.startsWith("closed:"))),
        2000,
      );
      unsubscribe();

      expect(events[0]).toBe("run.started");
      expect(events).toContain("step.completed");
      expect(events).toContain("run.finished");
      expect(controls).toContain(`caught-up:${finishedSeq}`);
      expect(controls).toContain(`closed:${finishedSeq}`);
      expect(caughtUp).toEqual(["finished"]);
      client.close();
    } finally {
      daemon.stop();
    }
  });

  test("long-lived subscriptions keep their original credential after re-authentication", async () => {
    const socketPath = join(dir, "credential-race.sock");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "credential-race.db"),
      agents: new AgentProviderRegistry().register(
        new MockProvider({ default: { outputs: ['{"value":1}'], delayMs: 350 } }),
      ),
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      const client = await DaemonClient.connect(socketPath);
      const first = await client.launchRun({ ...onceUrl, input: null, name: "first" });
      await client.authenticate(first.capability as string);
      const firstEvents: string[] = [];
      const unsubscribe = client.subscribeEvents(
        { runId: first.runId, cursor: { kind: "beginning" } },
        (event) => firstEvents.push(event.type),
      );
      await until(() => Promise.resolve(firstEvents.includes("run.started")), 2000);

      await client.authenticate(ADMIN_TOKEN);
      const second = await client.launchRun({
        ...chainUrl,
        input: { n: 2 },
        name: "second",
      });
      await client.authenticate(second.capability as string);
      await client.waitForRun(second.runId);

      await until(() => Promise.resolve(firstEvents.includes("run.finished")), 3000);
      expect(firstEvents).not.toContain("authorization.failed");
      unsubscribe();
      await client.authenticate(first.capability as string);
      await client.waitForRun(first.runId);
      client.close();
    } finally {
      daemon.stop();
    }
  }, 8000);
});

describe("CAS ownership fence", () => {
  test("retrying a missing run reports not found instead of ownership fence", async () => {
    const socketPath = join(dir, "missing.sock");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "missing.db"),
      agents: new AgentProviderRegistry().register(new MockProvider()),
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      const c = await DaemonClient.connect(socketPath);
      await c.authenticate(ADMIN_TOKEN);
      await expect(c.retryRun("missing")).rejects.toThrow(/run missing not found/);
      c.close();
    } finally {
      daemon.stop();
    }
  });

  test("a fresh owner blocks a second claimant; a stale one is reclaimable", () => {
    const store = JournalStore.open(join(dir, "cas.db"));
    try {
      store.insertRun({
        runId: "r",
        workflowName: "w",
        definitionVersion: "v0",
        status: "running",
        parentRunId: null,
        tenantId: null,
        inputRef: "null",
        outputRef: null,
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        launchAuthorityJson: null,
        createdAtMs: 0,
      });
      // daemon A claims with a fresh heartbeat
      expect(store.claimRun("r", "A", 100, 1000)).toBe(true);
      // daemon B cannot claim (A is fresh: heartbeat 1000 >= stale-before 900)
      expect(store.claimRun("r", "B", 900, 2000)).toBe(false);
      expect(store.getRun("r")?.runtimeOwnerId).toBe("A");
      // later, A is stale (heartbeat 1000 < stale-before 5000) → B reclaims
      expect(store.claimRun("r", "B", 5000, 6000)).toBe(true);
      expect(store.getRun("r")?.runtimeOwnerId).toBe("B");
    } finally {
      store.close();
    }
  });

  test("a second daemon's resumeRun is rejected while the owner is live", async () => {
    const dbPath = join(dir, "fence.db");
    const onceUrl2 = onceUrl;
    // daemon A owns a (paused) run with a fresh heartbeat
    const a = new KeelDaemon({
      socketPath: join(dir, "a.sock"),
      dbPath,
      ownerId: "A",
      agents: new AgentProviderRegistry().register(new MockProvider()),
      heartbeatMs: 10_000,
    });
    await a.start();
    const ca = await DaemonClient.connect(join(dir, "a.sock"));
    const { runId, capability } = await ca.launchRun({
      ...onceUrl2,
      input: null,
      name: "once",
    });
    await ca.authenticate(capability as string);
    await ca.waitForRun(runId); // finishes; A owns it with a fresh heartbeat

    // mark it running again (simulate a non-terminal owned run) for the fence test
    const probe = JournalStore.open(dbPath);
    probe.updateRun(runId, { status: "running" });
    probe.close();

    // daemon B (different owner) pointed at the same DB cannot drive it
    const b = new KeelDaemon({
      socketPath: join(dir, "b.sock"),
      dbPath,
      ownerId: "B",
      agents: new AgentProviderRegistry().register(new MockProvider()),
      heartbeatMs: 10_000,
    });
    await b.start();
    const cb = await DaemonClient.connect(join(dir, "b.sock"));
    await cb.authenticate(capability as string);
    await expect(cb.resumeRun(runId)).rejects.toThrow(/ownership fence/);

    ca.close();
    cb.close();
    a.stop();
    b.stop();
  });
});

describe("daemon interruptRun over the socket", () => {
  test("signal delivery does not wake an interrupted waiting-signal run until resume", async () => {
    const socketPath = join(dir, "interrupt-signal.sock");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "interrupt-signal.db"),
      agents: new AgentProviderRegistry().register(new MockProvider()),
      superviseMs: 100_000,
    });
    await daemon.start();
    try {
      const c = await DaemonClient.connect(socketPath);
      const { runId, capability } = await c.launchRun({
        ...signalUrl,
        input: null,
        name: "signal",
      });
      await c.authenticate(capability as string);
      await c.waitForRun(runId);
      expect((await c.getRun(runId))?.status).toBe("waiting-signal");

      await expect(c.interruptRun(runId, "inspect kc_run_secret")).resolves.toEqual({
        runId,
        status: "interrupted",
      });
      expect((await c.getRun(runId))?.status).toBe("interrupted");
      expect((await c.getBlockage(runId)).reason).toBe("interrupted");

      await expect(c.sendSignal(runId, "proceed", { go: true })).resolves.toEqual({
        runId,
        status: "interrupted",
        attachCursor: { kind: "after-seq", runId, seq: 3 },
      });
      expect((await c.getRun(runId))?.status).toBe("interrupted");
      const report = await c.getRunReport(runId);
      expect(report?.blockage?.interrupted?.reason).toBe("inspect «redacted-capability»");

      await c.resumeRun(runId);
      expect((await c.waitForRun(runId)).status).toBe("finished");
      c.close();
    } finally {
      daemon.stop();
    }
  }, 10000);

  test("approval delivery does not wake an interrupted waiting-human run until resume", async () => {
    const socketPath = join(dir, "interrupt-human.sock");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "interrupt-human.db"),
      agents: new AgentProviderRegistry().register(new MockProvider()),
      superviseMs: 100_000,
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      const c = await DaemonClient.connect(socketPath);
      const { runId, capability } = await c.launchRun({
        ...gateUrl,
        input: null,
        name: "gate",
      });
      await c.authenticate(capability as string);
      await c.waitForRun(runId);
      expect((await c.getRun(runId))?.status).toBe("waiting-human");

      await c.interruptRun(runId, "pause for review");
      await c.authenticate(ADMIN_TOKEN);
      const decided = await c.decideApproval(runId, "approve-deploy", { status: "denied" });
      expect(decided.status).toBe("interrupted");
      expect((await c.getRun(runId))?.status).toBe("interrupted");

      await c.resumeRun(runId);
      expect((await c.waitForRun(runId)).status).toBe("finished");
      c.close();
    } finally {
      daemon.stop();
    }
  }, 10000);

  test("timer supervisor and restart recovery skip interrupted runs", async () => {
    const socketPath = join(dir, "interrupt-timer.sock");
    const dbPath = join(dir, "interrupt-timer.db");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      agents: new AgentProviderRegistry().register(new MockProvider()),
      superviseMs: 100,
    });
    let interruptedRunId = "";
    let interruptedCapability = "";
    await daemon.start();
    try {
      const c = await DaemonClient.connect(socketPath);
      const { runId, capability } = await c.launchRun({
        ...napUrl,
        input: null,
        name: "nap",
      });
      interruptedRunId = runId;
      interruptedCapability = capability as string;
      await c.authenticate(capability as string);
      await c.waitForRun(runId);
      expect((await c.getRun(runId))?.status).toBe("waiting-timer");

      await c.interruptRun(runId, "timer pause");
      await Bun.sleep(1300);
      expect((await c.getRun(runId))?.status).toBe("interrupted");
      c.close();
    } finally {
      daemon.stop();
    }

    const restarted = new KeelDaemon({
      socketPath: join(dir, "interrupt-timer-restarted.sock"),
      dbPath,
      agents: new AgentProviderRegistry().register(new MockProvider()),
      superviseMs: 100,
    });
    await restarted.start();
    try {
      await Bun.sleep(300);
      const store = JournalStore.open(dbPath);
      try {
        expect(store.getRun(interruptedRunId)?.status).toBe("interrupted");
      } finally {
        store.close();
      }
      const c = await DaemonClient.connect(join(dir, "interrupt-timer-restarted.sock"));
      await c.authenticate(interruptedCapability);
      await c.resumeRun(interruptedRunId);
      expect((await c.waitForRun(interruptedRunId)).status).toBe("finished");
      c.close();
    } finally {
      restarted.stop();
    }
  }, 10000);
});

describe("daemon supervisor tick over the socket", () => {
  test("a run parked on ctx.sleep is woken by the daemon's supervisor and finishes", async () => {
    const socketPath = join(dir, "sup.sock");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "sup.db"),
      agents: new AgentProviderRegistry().register(new MockProvider()),
      superviseMs: 150, // tick fast so the test stays short
    });
    await daemon.start();
    try {
      const c = await DaemonClient.connect(socketPath);
      const { runId, capability } = await c.launchRun({
        ...napUrl,
        input: null,
        name: "nap",
      });
      await c.authenticate(capability as string);
      await c.waitForRun(runId);
      expect((await c.getRun(runId))?.status).toBe("waiting-timer");
      // the nap sleeps 1000ms real-time; the supervisor wakes it once due
      await until(async () => (await c.getRun(runId))?.status === "finished", 4000);
      expect((await c.getRun(runId))?.status).toBe("finished");
      c.close();
    } finally {
      daemon.stop();
    }
  }, 10000);

  test("a due schedule launch is claimed by the daemon owner", async () => {
    const socketPath = join(dir, "cron-owner.sock");
    const dbPath = join(dir, "cron-owner.db");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      ownerId: "daemon-cron",
      agents: new AgentProviderRegistry().register(new MockProvider()),
      superviseMs: 100,
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      const c = await DaemonClient.connect(socketPath);
      await c.authenticate(ADMIN_TOKEN);
      await c.putSchedule({
        name: "hourly",
        source: chainUrl.source,
        workflowName: "hourly",
        input: { n: 1 },
        intervalMs: 60_000,
        firstFireMs: Date.now() - 1000,
      });
      await until(async () => (await c.listRuns()).some((r) => r.workflowName === "hourly"), 4000);
      const runId = (await c.listRuns()).find((r) => r.workflowName === "hourly")?.runId;
      await until(async () => (await c.getRun(runId as string))?.status === "finished", 4000);
      const probe = JournalStore.open(dbPath);
      try {
        const row = probe.getRun(runId as string);
        expect(row?.runtimeOwnerId).toBe("daemon-cron");
        expect(typeof row?.heartbeatAtMs).toBe("number");
      } finally {
        probe.close();
      }
      c.close();
    } finally {
      daemon.stop();
    }
  }, 10000);

  test("migrated ABI-1 due timer run fails once durably under the daemon supervisor", async () => {
    const socketPath = join(dir, "old-abi-supervisor.sock");
    const dbPath = join(dir, "old-abi-supervisor.db");
    makeV11OldAbiDueTimerDb(dbPath);
    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      ownerId: "old-abi-supervisor",
      agents: new AgentProviderRegistry().register(new MockProvider()),
      superviseMs: 50,
      adminToken: ADMIN_TOKEN,
      clock: () => 1_000,
    });
    await daemon.start();
    try {
      await until(async () => {
        const probe = JournalStore.open(dbPath);
        try {
          return probe.getRun("old-abi-timer")?.status === "failed";
        } finally {
          probe.close();
        }
      }, 4000);
      await Bun.sleep(150);
      const listed = await rawAdminRpc(socketPath, "listRuns", {});
      expect(listed.error).toBeUndefined();
      const probe = JournalStore.open(dbPath);
      try {
        const failed = probe.getRun("old-abi-timer");
        expect(failed?.status).toBe("failed");
        expect(failed?.runtimeOwnerId).toBe("old-abi-supervisor");
        expect(failed?.finishedAtMs).toBe(1_000);
        expect(JSON.parse(failed?.errorJson ?? "{}").message).toContain(
          `requires workflow SDK ABI 1, but this daemon supports ABI ${WORKFLOW_SDK_ABI_VERSION}`,
        );
        const failedEvents = probe.db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM events WHERE run_id = 'old-abi-timer' AND type = 'run.failed'",
          )
          .get();
        expect(failedEvents?.count).toBe(1);
      } finally {
        probe.close();
      }
    } finally {
      daemon.stop();
    }
  }, 10000);
});

describe("HITL over the socket", () => {
  test("signal delivery acknowledges wake start without waiting for resumed work", async () => {
    const socketPath = join(dir, "signal-ack.sock");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "signal-ack.db"),
      agents: new AgentProviderRegistry().register(
        new MockProvider({ default: { outputs: ['{"value":7}'], delayMs: 1000 } }),
      ),
      superviseMs: 100_000,
    });
    await daemon.start();
    try {
      const c = await DaemonClient.connect(socketPath);
      const { runId, capability } = await c.launchRun({
        ...signalThenAgentUrl,
        input: null,
        name: "signal-ack",
      });
      await c.authenticate(capability as string);
      await c.waitForRun(runId);
      expect((await c.getRun(runId))?.status).toBe("waiting-signal");

      const ack = await c.sendSignal(runId, "proceed", { go: true });
      expect(ack).toMatchObject({
        runId,
        status: "running",
        attachCursor: { kind: "after-seq", runId, seq: 2 },
      });
      expect((await c.getRun(runId))?.status).toBe("running");
      await expect(c.waitForRun(runId)).resolves.toMatchObject({ status: "finished", output: 7 });
      c.close();
    } finally {
      daemon.stop();
    }
  }, 10000);

  test("approval delivery acknowledges wake start without waiting for resumed work", async () => {
    const socketPath = join(dir, "approval-ack.sock");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "approval-ack.db"),
      agents: new AgentProviderRegistry().register(
        new MockProvider({ default: { outputs: ['{"value":11}'], delayMs: 1000 } }),
      ),
      superviseMs: 100_000,
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      const c = await DaemonClient.connect(socketPath);
      const { runId, capability } = await c.launchRun({
        ...gateThenAgentUrl,
        input: null,
        name: "approval-ack",
      });
      await c.authenticate(capability as string);
      await c.waitForRun(runId);
      expect((await c.getRun(runId))?.status).toBe("waiting-human");

      await c.authenticate(ADMIN_TOKEN);
      const ack = await c.decideApproval(runId, "approve-deploy", { status: "approved" });
      expect(ack).toMatchObject({
        runId,
        status: "running",
        attachCursor: { kind: "after-seq", runId, seq: 2 },
      });
      expect((await c.getRun(runId))?.status).toBe("running");
      await c.authenticate(capability as string);
      await expect(c.waitForRun(runId)).resolves.toMatchObject({ status: "finished", output: 11 });
      c.close();
    } finally {
      daemon.stop();
    }
  }, 10000);

  test("a run parks on ctx.human and a decideApproval over the socket finishes it", async () => {
    const socketPath = join(dir, "h.sock");
    const gateUrl = captureWorkflowFile(
      new URL("../kernel/realm/fixtures/gate.workflow.ts", import.meta.url).pathname,
    );
    const daemon = new KeelDaemon({
      socketPath,
      dbPath: join(dir, "h.db"),
      agents: new AgentProviderRegistry().register(new MockProvider()),
      superviseMs: 100_000, // don't auto-tick; drive the decision explicitly
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      const c = await DaemonClient.connect(socketPath);
      const { runId, capability } = await c.launchRun({
        ...gateUrl,
        input: null,
        name: "gate",
      });
      await c.authenticate(capability as string);
      await c.waitForRun(runId);
      expect((await c.getRun(runId))?.status).toBe("waiting-human");
      expect((await c.getBlockage(runId)).reason).toBe("waiting_human");

      await expect(
        c.decideApproval(runId, "approve-deploy", { status: "approved" }),
      ).rejects.toThrow(/admin/);
      await c.authenticate(ADMIN_TOKEN);
      const out = await c.decideApproval(runId, "approve-deploy", { status: "denied" });
      expect(out.status).toBe("running");
      await c.authenticate(capability as string);
      await expect(c.waitForRun(runId)).resolves.toMatchObject({ status: "finished" });
      expect((await c.getRun(runId))?.status).toBe("finished");
      c.close();
    } finally {
      daemon.stop();
    }
  });

  test("unsupported workflow SDK ABI on approval wake fails the run and surfaces the error", async () => {
    const socketPath = join(dir, "h-abi.sock");
    const dbPath = join(dir, "h-abi.db");
    const gateUrl = captureWorkflowFile(
      new URL("../kernel/realm/fixtures/gate.workflow.ts", import.meta.url).pathname,
    );
    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      agents: new AgentProviderRegistry().register(new MockProvider()),
      superviseMs: 100_000,
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      const c = await DaemonClient.connect(socketPath);
      const { runId, capability } = await c.launchRun({
        ...gateUrl,
        input: null,
        name: "gate",
      });
      await c.authenticate(capability as string);
      await c.waitForRun(runId);
      expect((await c.getRun(runId))?.status).toBe("waiting-human");
      requireUnsupportedSdkAbiForRun(dbPath, runId);

      await c.authenticate(ADMIN_TOKEN);
      await expect(
        c.decideApproval(runId, "approve-deploy", { status: "approved" }),
      ).rejects.toThrow(
        `requires workflow SDK ABI ${NEXT_WORKFLOW_SDK_ABI_VERSION}, but this daemon supports ABI ${WORKFLOW_SDK_ABI_VERSION}`,
      );
      const failed = await c.getRun(runId);
      expect(failed?.status).toBe("failed");
      expect(failed?.error?.message).toContain(
        `requires workflow SDK ABI ${NEXT_WORKFLOW_SDK_ABI_VERSION}, but this daemon supports ABI ${WORKFLOW_SDK_ABI_VERSION}`,
      );
      c.close();
    } finally {
      daemon.stop();
    }
  });

  test("unsupported workflow SDK ABI on signal wake fails the run and surfaces the error", async () => {
    const socketPath = join(dir, "signal-abi.sock");
    const dbPath = join(dir, "signal-abi.db");
    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      agents: new AgentProviderRegistry().register(new MockProvider()),
      superviseMs: 100_000,
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    try {
      const c = await DaemonClient.connect(socketPath);
      const { runId, capability } = await c.launchRun({
        ...signalUrl,
        input: null,
        name: "signal",
      });
      await c.authenticate(capability as string);
      await c.waitForRun(runId);
      expect((await c.getRun(runId))?.status).toBe("waiting-signal");
      requireUnsupportedSdkAbiForRun(dbPath, runId);

      await expect(c.sendSignal(runId, "proceed", { go: true, by: "test" })).rejects.toThrow(
        `requires workflow SDK ABI ${NEXT_WORKFLOW_SDK_ABI_VERSION}, but this daemon supports ABI ${WORKFLOW_SDK_ABI_VERSION}`,
      );
      const failed = await c.getRun(runId);
      expect(failed?.status).toBe("failed");
      expect(failed?.error?.message).toContain(
        `requires workflow SDK ABI ${NEXT_WORKFLOW_SDK_ABI_VERSION}, but this daemon supports ABI ${WORKFLOW_SDK_ABI_VERSION}`,
      );
      c.close();
    } finally {
      daemon.stop();
    }
  });
});

describe("kill -9 daemon recovery", () => {
  test("a spawned child is not duplicated when the daemon dies before the parent waits", async () => {
    const socketPath = join(dir, "spawn-recovery.sock");
    const dbPath = join(dir, "spawn-recovery.db");
    const setup = JournalStore.open(dbPath);
    const childDefinition = snapshotWorkflowSource(setup, spawnChildUrl.source, {
      name: "spawn-child",
      nowMs: 1,
      cacheRoot: join(dir, "definitions"),
    }).snapshot;
    setup.putSavedWorkflowVersion({
      name: "spawn-child",
      definitionHash: childDefinition.hash,
      workflowName: "spawn-child",
      defaultTarget: process.cwd(),
      createdAtMs: 2,
    });
    setup.close();

    const env = {
      ...process.env,
      KEEL_SOCKET: socketPath,
      KEEL_DB: dbPath,
      KEEL_DELAY: "0",
    };
    const d1 = Bun.spawn([process.execPath, TEST_DAEMON], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForLine(d1.stdout, "READY");
    const c1 = await DaemonClient.connect(socketPath);
    const { runId, capability } = await c1.launchRun({
      ...spawnParkParentUrl,
      input: { workflow: "spawn-child@1" },
      name: "spawn-parent",
    });
    await c1.authenticate(capability as string);
    await until(async () => (await c1.getRun(runId))?.status === "waiting-signal", 8000);
    c1.close();
    d1.kill("SIGKILL");
    await d1.exited;

    const mid = JournalStore.open(dbPath);
    const childRunId = mid.listRuns().find((run) => run.parentRunId === runId)?.runId;
    expect(childRunId).toBeDefined();
    expect(mid.getJournalRow(runId, "spawn-child", 1)?.status).toBe("completed");
    mid.close();

    await Bun.sleep(800);
    const d2 = Bun.spawn([process.execPath, TEST_DAEMON], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForLine(d2.stdout, "READY");
    const c2 = await DaemonClient.connect(socketPath);
    await c2.authenticate(capability as string);
    try {
      await c2.sendSignal(runId, "continue-to-wait", null);
      await until(async () => (await c2.getRun(runId))?.status === "finished", 8000);
      expect(await c2.getRunOutput(runId)).toMatchObject({
        status: "finished",
        output: { runId: childRunId, status: "finished", output: 10 },
      });
      const final = JournalStore.open(dbPath);
      expect(final.listRuns().filter((run) => run.parentRunId === runId)).toHaveLength(1);
      final.close();
    } finally {
      c2.close();
      d2.kill("SIGTERM");
      await d2.exited;
    }
  }, 30000);

  test("a run in flight when the daemon dies is recovered on restart", async () => {
    const socketPath = join(dir, "r.sock");
    const dbPath = join(dir, "r.db");
    const env = {
      ...process.env,
      KEEL_SOCKET: socketPath,
      KEEL_DB: dbPath,
      KEEL_DELAY: "4000", // the agent sleeps 4s, so we can kill mid-flight
    };

    // 1) start daemon, launch a run, wait until the agent is pending, then SIGKILL.
    const d1 = Bun.spawn([process.execPath, TEST_DAEMON], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForLine(d1.stdout, "READY");
    const c1 = await DaemonClient.connect(socketPath);
    const { runId, capability } = await c1.launchRun({
      ...onceUrl,
      input: null,
      name: "once",
    });
    await c1.authenticate(capability as string);
    // poll until the agent row is pending (mid-flight)
    await until(
      async () => (await c1.getRun(runId))?.nodes.some((n) => n.status === "pending"),
      4000,
    );
    c1.close();
    d1.kill("SIGKILL");
    await d1.exited;

    // the run is left non-terminal with a pending agent
    const mid = JournalStore.open(dbPath);
    expect(mid.getRun(runId)?.status).toBe("running");
    expect(mid.getJournalRow(runId, "ask", 1)?.status).toBe("pending");
    mid.close();

    // wait past the stale-owner window (3 * heartbeatMs = 600ms) so the dead
    // daemon's claim is reclaimable.
    await Bun.sleep(800);

    // 2) restart a fresh daemon with NO delay → recovery resumes to completion.
    const d2 = Bun.spawn([process.execPath, TEST_DAEMON], {
      env: { ...env, KEEL_DELAY: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForLine(d2.stdout, "READY");
    const c2 = await DaemonClient.connect(socketPath);
    await c2.authenticate(capability as string);
    try {
      await until(async () => (await c2.getRun(runId))?.status === "finished", 8000);
      const final = await c2.getRun(runId);
      expect(final?.status).toBe("finished");
      expect(final?.nodes.find((n) => n.stableKey === "ask")?.status).toBe("completed");
    } finally {
      c2.close();
      d2.kill("SIGTERM");
      await d2.exited;
    }
  }, 30000);

  test("unsupported workflow SDK ABI during orphan recovery fails the reclaimed run", async () => {
    const socketPath = join(dir, "orphan-abi.sock");
    const dbPath = join(dir, "orphan-abi.db");
    const setup = JournalStore.open(dbPath);
    try {
      const { snapshot } = snapshotWorkflowSource(
        setup,
        'import { passthrough } from "@kcosr/keel";\nexport default async () => passthrough<number>().parse(1);\n',
        {
          name: "orphan",
          nowMs: 1,
          cacheRoot: join(dir, "setup-definitions"),
        },
      );
      setup.insertRun({
        runId: "orphan",
        workflowName: "orphan",
        definitionVersion: snapshot.hash,
        workflowRef: "stdin",
        status: "running",
        parentRunId: null,
        tenantId: null,
        inputRef: "null",
        outputRef: null,
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        launchAuthorityJson: null,
        createdAtMs: 1,
      });
      requireUnsupportedSdkAbi(setup, snapshot.hash);
    } finally {
      setup.close();
    }

    const daemon = new KeelDaemon({
      socketPath,
      dbPath,
      ownerId: "orphan-reclaimer",
      agents: new AgentProviderRegistry().register(new MockProvider()),
      superviseMs: 100_000,
    });
    await daemon.start();
    try {
      await until(async () => {
        const probe = JournalStore.open(dbPath);
        try {
          return probe.getRun("orphan")?.status === "failed";
        } finally {
          probe.close();
        }
      }, 4000);
      const probe = JournalStore.open(dbPath);
      try {
        const failed = probe.getRun("orphan");
        expect(failed?.runtimeOwnerId).toBe("orphan-reclaimer");
        expect(JSON.parse(failed?.errorJson ?? "{}").message).toContain(
          `requires workflow SDK ABI ${NEXT_WORKFLOW_SDK_ABI_VERSION}, but this daemon supports ABI ${WORKFLOW_SDK_ABI_VERSION}`,
        );
      } finally {
        probe.close();
      }
    } finally {
      daemon.stop();
    }
  });
});

async function waitForLine(stream: ReadableStream, prefix: string): Promise<void> {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += dec.decode(chunk as Uint8Array);
    if (buf.includes(prefix)) return;
  }
  throw new Error(`stream ended before "${prefix}"`);
}

async function until(cond: () => Promise<boolean | undefined>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await Bun.sleep(50);
  }
  throw new Error("condition not met in time");
}

function requireUnsupportedSdkAbiForRun(dbPath: string, runId: string): void {
  const store = JournalStore.open(dbPath);
  try {
    const run = store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    requireUnsupportedSdkAbi(store, run.definitionVersion);
  } finally {
    store.close();
  }
}

function requireUnsupportedSdkAbi(store: JournalStore, hash: string): void {
  const row = store.getWorkflowDefinition(hash);
  if (!row?.manifestJson) throw new Error(`missing manifest for ${hash}`);
  const manifest = JSON.parse(row.manifestJson) as { runtime: { workflowSdkAbi: number } };
  manifest.runtime.workflowSdkAbi = NEXT_WORKFLOW_SDK_ABI_VERSION;
  store.db
    .query("UPDATE workflow_definitions SET manifest_json = ? WHERE hash = ?")
    .run(JSON.stringify(manifest), hash);
}
