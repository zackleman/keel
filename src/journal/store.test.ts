import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JournalStore } from "./store.ts";
import type { AgentWorkspaceRow, NewRunRow } from "./types.ts";

function newRun(runId: string): NewRunRow {
  return {
    runId,
    workflowName: "demo",
    definitionVersion: "v1",
    status: "running",
    parentRunId: null,
    tenantId: null,
    inputRef: null,
    outputRef: null,
    errorJson: null,
    heartbeatAtMs: null,
    runtimeOwnerId: null,
    launchAuthorityJson: null,
    createdAtMs: 1000,
  };
}

function unnamedRun(runId: string): NewRunRow {
  return {
    ...newRun(runId),
    workflowName: null,
    workflowRef: "stdin",
  };
}

function workspaceRow(
  runId: string,
  agentKey: string,
  overrides: Partial<AgentWorkspaceRow> = {},
): AgentWorkspaceRow {
  return {
    runId,
    workspaceId: `ws_${agentKey}`,
    mode: "worktree",
    ownerKind: "agent_session",
    key: agentKey,
    lastAttempt: null,
    retentionPolicy: "retain",
    workspacePath: `/tmp/${runId}/${agentKey}`,
    sourceKind: "worktree-git",
    sourcePath: `/repo/${runId}`,
    sourceUri: null,
    sourceBare: null,
    sourceMergeEligible: true,
    suppliedPath: null,
    sourceRef: "HEAD",
    resolvedRef: null,
    checkoutBranch: null,
    worktreeCheckoutKind: "detached",
    worktreeBranchOwned: false,
    baseCommit: `base-${runId}`,
    copyBaselinePath: null,
    creationErrorJson: null,
    workspaceIdentityJson: "{}",
    workspaceIdentityHash: `${runId}-${agentKey}`,
    setupIdentityJson: null,
    setupIdentityHash: null,
    setupStatus: "none",
    setupStartedAtMs: null,
    setupFinishedAtMs: null,
    setupErrorJson: null,
    owned: true,
    status: "idle",
    failureSeen: false,
    lastTurnKey: null,
    lastTurnAttempt: null,
    activeHolderKind: null,
    activeHolderKey: null,
    activeHolderAttempt: null,
    activeStartedAtMs: null,
    lastDiffEventSeq: null,
    lastErrorEventSeq: null,
    cleanupErrorJson: null,
    createdAtMs: 100,
    updatedAtMs: 100,
    mergedAtMs: null,
    discardedAtMs: null,
    removedAtMs: null,
    ...overrides,
  } as AgentWorkspaceRow;
}

describe("JournalStore (in-memory)", () => {
  let store: JournalStore;
  beforeEach(() => {
    store = JournalStore.memory();
  });
  afterEach(() => store.close());

  test("runs round-trip", () => {
    store.insertRun(newRun("r1"));
    const got = store.getRun("r1");
    expect(got).not.toBeNull();
    expect(got?.workflowName).toBe("demo");
    expect(got?.status).toBe("running");
    expect(got?.finishedAtMs).toBeNull();
  });

  test("runs may be genuinely unnamed", () => {
    store.insertRun(unnamedRun("r_unnamed"));
    expect(store.getRun("r_unnamed")?.workflowName).toBeNull();
  });

  test("listRuns returns newest runs first with run id as a tiebreaker", () => {
    store.insertRun({ ...newRun("r_a"), createdAtMs: 1000 });
    store.insertRun({ ...newRun("r_c"), createdAtMs: 2000 });
    store.insertRun({ ...newRun("r_b"), createdAtMs: 2000 });

    expect(store.listRuns().map((run) => run.runId)).toEqual(["r_c", "r_b", "r_a"]);
  });

  test("listRunsPage returns a newest-first page with the total run count", () => {
    store.insertRun({ ...newRun("r_a"), createdAtMs: 1000 });
    store.insertRun({ ...newRun("r_c"), createdAtMs: 2000 });
    store.insertRun({ ...newRun("r_b"), createdAtMs: 2000 });

    const page = store.listRunsPage(2);

    expect(page.runs.map((run) => run.runId)).toEqual(["r_c", "r_b"]);
    expect(page.total).toBe(3);
  });

  test("updateRun patches only named columns", () => {
    store.insertRun(newRun("r1"));
    store.updateRun("r1", { status: "finished", finishedAtMs: 2000 });
    const got = store.getRun("r1");
    expect(got?.status).toBe("finished");
    expect(got?.finishedAtMs).toBe(2000);
    expect(got?.workflowName).toBe("demo");
  });

  test("journal rows round-trip with defaults", () => {
    store.insertRun(newRun("r1"));
    store.putJournalRow({
      runId: "r1",
      stableKey: "plan",
      effectType: "pure",
      status: "completed",
      version: "v",
      inputHash: "h",
      resultInline: '{"ok":true}',
    });
    const row = store.getJournalRow("r1", "plan", 1);
    expect(row?.attempt).toBe(1);
    expect(row?.status).toBe("completed");
    expect(row?.resultInline).toBe('{"ok":true}');
    expect(row?.inputDeps).toBeNull();
  });

  test("upsert replaces row at the same (key, attempt)", () => {
    store.insertRun(newRun("r1"));
    store.putJournalRow({
      runId: "r1",
      stableKey: "plan",
      effectType: "pure",
      status: "pending",
      version: "v",
      inputHash: "h",
    });
    store.putJournalRow({
      runId: "r1",
      stableKey: "plan",
      effectType: "pure",
      status: "completed",
      version: "v",
      inputHash: "h",
      resultInline: "1",
    });
    expect(store.getJournalRow("r1", "plan", 1)?.status).toBe("completed");
  });

  test("getLatestAttempt returns the highest attempt", () => {
    store.insertRun(newRun("r1"));
    for (const attempt of [1, 2, 3]) {
      store.putJournalRow({
        runId: "r1",
        stableKey: "verify",
        attempt,
        effectType: "effectful",
        status: attempt === 3 ? "pending" : "failed",
        version: "v",
        inputHash: "h",
      });
    }
    const latest = store.getLatestAttempt("r1", "verify");
    expect(latest?.attempt).toBe(3);
    expect(latest?.status).toBe("pending");
  });

  test("inputDeps serialize through JSON", () => {
    store.insertRun(newRun("r1"));
    store.putJournalRow({
      runId: "r1",
      stableKey: "synth",
      effectType: "effectful",
      status: "completed",
      version: "v",
      inputHash: "h",
      inputDeps: [{ stepKey: "dedupe", contentHash: "abc" }],
    });
    expect(store.getJournalRow("r1", "synth", 1)?.inputDeps).toEqual([
      { stepKey: "dedupe", contentHash: "abc" },
    ]);
  });

  test("events get monotonic per-run seq", () => {
    store.insertRun(newRun("r1"));
    expect(store.appendEvent("r1", "started", { a: 1 }, 100)).toBe(1);
    expect(store.appendEvent("r1", "step", { a: 2 }, 101)).toBe(2);
    const evs = store.listEvents("r1");
    expect(evs.map((e) => e.seq)).toEqual([1, 2]);
    expect(store.listEvents("r1", 1).map((e) => e.type)).toEqual(["step"]);
  });

  test("event listener failures do not affect committed journal writes", () => {
    store.insertRun(newRun("r1"));
    store.onEventAppended(() => {
      throw new Error("subscriber failed");
    });

    expect(() => store.appendEvent("r1", "one", {}, 1)).not.toThrow();
    expect(store.listEvents("r1").map((e) => e.type)).toEqual(["one"]);

    expect(() =>
      store.transaction(() => {
        store.appendEvent("r1", "two", {}, 2);
      }),
    ).not.toThrow();
    expect(store.listEvents("r1").map((e) => e.type)).toEqual(["one", "two"]);
  });

  test("event notifications from rolled-back nested transactions are not delivered", () => {
    store.insertRun(newRun("r1"));
    const delivered: string[] = [];
    store.onEventAppended((event) => delivered.push(event.type));

    store.transaction(() => {
      store.appendEvent("r1", "outer", {}, 1);
      try {
        store.transaction(() => {
          store.appendEvent("r1", "inner-rolled-back", {}, 2);
          throw new Error("rollback savepoint");
        });
      } catch {
        // outer transaction intentionally continues
      }
      store.appendEvent("r1", "outer-after", {}, 3);
    });

    expect(store.listEvents("r1").map((e) => e.type)).toEqual(["outer", "outer-after"]);
    expect(delivered).toEqual(["outer", "outer-after"]);
  });

  test("workflow definitions round-trip by hash", () => {
    store.putWorkflowDefinition({
      hash: "wf_sha256_abc",
      name: "demo",
      kind: "path",
      code: "export default async () => 1;",
      sourceMap: null,
      manifestJson: '{"format":"keel.workflow-definition.v1"}',
      createdAtMs: 1000,
    });

    const got = store.getWorkflowDefinition("wf_sha256_abc");
    expect(got?.name).toBe("demo");
    expect(got?.code).toContain("export default");
    expect(got?.manifestJson).toContain("keel.workflow-definition.v1");
  });

  test("workflow definition names are nullable and first-writer-wins by hash", () => {
    store.putWorkflowDefinition({
      hash: "wf_sha256_same",
      name: null,
      kind: "source",
      code: "export default async () => 1;",
      sourceMap: null,
      manifestJson: '{"format":"keel.workflow-definition.v1"}',
      createdAtMs: 1000,
    });
    store.putWorkflowDefinition({
      hash: "wf_sha256_same",
      name: "later",
      kind: "source",
      code: "export default async () => 1;",
      sourceMap: null,
      manifestJson: '{"format":"keel.workflow-definition.v1"}',
      createdAtMs: 2000,
    });

    const got = store.getWorkflowDefinition("wf_sha256_same");
    expect(got?.name).toBeNull();
    expect(got?.createdAtMs).toBe(1000);
  });

  test("workflow definition pruning preserves run and enabled-schedule references", () => {
    for (const hash of [
      "wf_sha256_orphan",
      "wf_sha256_run",
      "wf_sha256_schedule",
      "wf_sha256_disabled_schedule",
      "wf_sha256_fresh",
    ]) {
      store.putWorkflowDefinition({
        hash,
        name: null,
        kind: "source",
        code: "export default async () => 1;",
        sourceMap: null,
        manifestJson: '{"format":"keel.workflow-definition.v1"}',
        createdAtMs: hash === "wf_sha256_fresh" ? 95 : 1,
      });
    }
    store.insertRun({ ...newRun("r_def"), definitionVersion: "wf_sha256_run" });
    store.putSchedule({
      name: "enabled",
      workflowRef: "wf_sha256_schedule",
      inputJson: null,
      intervalMs: 1000,
      nextFireMs: 1,
    });
    store.putSchedule({
      name: "disabled",
      workflowRef: "wf_sha256_disabled_schedule",
      inputJson: null,
      intervalMs: 1000,
      nextFireMs: 1,
    });
    store.db.query("UPDATE schedules SET enabled = 0 WHERE name = 'disabled'").run();

    expect(store.pruneWorkflowDefinitions({ nowMs: 100, ttlMs: 10 })).toBe(2);
    expect(store.getWorkflowDefinition("wf_sha256_orphan")).toBeNull();
    expect(store.getWorkflowDefinition("wf_sha256_disabled_schedule")).toBeNull();
    expect(store.getWorkflowDefinition("wf_sha256_run")).not.toBeNull();
    expect(store.getWorkflowDefinition("wf_sha256_schedule")).not.toBeNull();
    expect(store.getWorkflowDefinition("wf_sha256_fresh")).not.toBeNull();
  });

  test("schedule read helpers include disabled rows by default and sort by name", () => {
    store.putSchedule({
      name: "beta",
      workflowRef: "wf_sha256_beta",
      inputJson: '{"n":2}',
      scheduleTarget: "/repo/beta",
      intervalMs: 2000,
      nextFireMs: 20,
    });
    store.putSchedule({
      name: "alpha",
      workflowRef: "wf_sha256_alpha",
      inputJson: null,
      scheduleTarget: "/repo/alpha",
      intervalMs: 1000,
      nextFireMs: 10,
    });
    store.disableScheduleWithError("alpha", '{"name":"Error","message":"disabled"}', 30);

    expect(store.listSchedules().map((schedule) => schedule.name)).toEqual(["alpha", "beta"]);
    expect(
      store.listSchedules({ includeDisabled: false }).map((schedule) => schedule.name),
    ).toEqual(["beta"]);
    expect(store.getSchedule("alpha")).toMatchObject({
      name: "alpha",
      enabled: false,
      workflowRef: "wf_sha256_alpha",
      inputJson: null,
      scheduleTarget: "/repo/alpha",
      lastErrorJson: '{"name":"Error","message":"disabled"}',
      lastFailedAtMs: 30,
    });
    expect(store.getSchedule("missing")).toBeNull();
    store.setScheduleEnabled("alpha", true);
    expect(store.getSchedule("alpha")?.enabled).toBe(true);
    expect(() => store.setScheduleEnabled("missing", false)).toThrow(/does not exist/);
    expect(store.deleteSchedule("alpha")).toBe(true);
    expect(store.deleteSchedule("alpha")).toBe(false);
  });

  test("agent workspaces insert, update, and list deterministically", () => {
    const r1b = workspaceRow("r1", "b", { workspacePath: "/work/r1/b", status: "creating" });
    const r1a = workspaceRow("r1", "a", { workspacePath: "/work/r1/a", status: "idle" });
    const r2a = workspaceRow("r2", "a", { workspacePath: "/work/r2/a", status: "pending_review" });
    store.insertAgentWorkspace(r1b);
    store.insertAgentWorkspace(r1a);
    store.insertAgentWorkspace(r2a);

    expect(store.getAgentWorkspaceByKey("r1", "agent_session", "a")).toEqual(r1a);
    expect(store.listAgentWorkspaces("r1").map((w) => w.key)).toEqual(["a", "b"]);
    expect(store.listAllAgentWorkspaces().map((w) => `${w.runId}/${w.key}`)).toEqual([
      "r1/a",
      "r1/b",
      "r2/a",
    ]);

    store.updateAgentWorkspace("r1", "ws_a", {
      status: "diff_error",
      lastTurnKey: "turn-2",
      lastTurnAttempt: 2,
      lastDiffEventSeq: 11,
      lastErrorEventSeq: 12,
      updatedAtMs: 250,
    });
    expect(store.getAgentWorkspaceByKey("r1", "agent_session", "a")).toEqual({
      ...r1a,
      status: "diff_error",
      lastTurnKey: "turn-2",
      lastTurnAttempt: 2,
      lastDiffEventSeq: 11,
      lastErrorEventSeq: 12,
      updatedAtMs: 250,
    });

    store.updateAgentWorkspace("r1", "ws_a", { status: "merged", mergedAtMs: 300 });
    expect(store.getAgentWorkspaceByKey("r1", "agent_session", "a")?.mergedAtMs).toBe(300);

    store.deleteAgentWorkspace("r1", "ws_b");
    expect(store.getAgentWorkspaceByKey("r1", "agent_session", "b")).toBeNull();
  });

  test("agent workspace status helpers transition only intended lifecycle states", () => {
    for (const status of [
      "creating",
      "active",
      "idle",
      "pending_review",
      "merged",
      "discarded",
      "diff_error",
      "abandoned",
    ] as const) {
      store.insertAgentWorkspace(workspaceRow("r", status, { status, updatedAtMs: 100 }));
    }

    store.reopenPendingReviewWorkspaces("r", 300);
    expect(store.getAgentWorkspaceByKey("r", "agent_session", "creating")?.status).toBe("creating");
    expect(store.getAgentWorkspaceByKey("r", "agent_session", "active")?.status).toBe("active");
    expect(store.getAgentWorkspaceByKey("r", "agent_session", "idle")?.status).toBe("idle");
    expect(store.getAgentWorkspaceByKey("r", "agent_session", "pending_review")?.status).toBe(
      "idle",
    );
    expect(store.getAgentWorkspaceByKey("r", "agent_session", "pending_review")?.updatedAtMs).toBe(
      300,
    );
    expect(store.getAgentWorkspaceByKey("r", "agent_session", "diff_error")?.status).toBe(
      "diff_error",
    );
    expect(store.getAgentWorkspaceByKey("r", "agent_session", "merged")?.status).toBe("merged");
    expect(store.getAgentWorkspaceByKey("r", "agent_session", "discarded")?.status).toBe(
      "discarded",
    );
    expect(store.getAgentWorkspaceByKey("r", "agent_session", "abandoned")?.status).toBe(
      "abandoned",
    );

    expect(
      store
        .gcWorkspaceRows(["merged", "discarded", "abandoned"], 1000)
        .map((w) => w.status)
        .sort(),
    ).toEqual(["abandoned", "discarded", "merged"]);
  });

  test("capabilities round-trip by secret hash without storing raw tokens", () => {
    store.putCapability({
      id: "cap_1",
      secretHash: "hash-only",
      resourceJson: '{"kind":"run","runId":"r1"}',
      actionsJson: '["run:read"]',
      createdAtMs: 1000,
      expiresAtMs: null,
      revokedAtMs: null,
      note: "test",
    });

    const got = store.getCapabilityByHash("hash-only");
    expect(got?.id).toBe("cap_1");
    expect(got?.resourceJson).toContain("r1");
    expect(got?.secretHash).toBe("hash-only");
  });

  test("transaction rolls back fully on throw (zero partial rows)", () => {
    store.insertRun(newRun("r1"));
    expect(() =>
      store.transaction(() => {
        store.putJournalRow({
          runId: "r1",
          stableKey: "a",
          effectType: "pure",
          status: "completed",
          version: "v",
          inputHash: "h",
        });
        store.putJournalRow({
          runId: "r1",
          stableKey: "b",
          effectType: "pure",
          status: "completed",
          version: "v",
          inputHash: "h",
        });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.listJournalRows("r1")).toHaveLength(0);
  });

  test("transaction commits all rows on success", () => {
    store.insertRun(newRun("r1"));
    store.transaction(() => {
      store.putJournalRow({
        runId: "r1",
        stableKey: "a",
        effectType: "pure",
        status: "completed",
        version: "v",
        inputHash: "h",
      });
      store.putJournalRow({
        runId: "r1",
        stableKey: "b",
        effectType: "pure",
        status: "completed",
        version: "v",
        inputHash: "h",
      });
    });
    expect(store.listJournalRows("r1")).toHaveLength(2);
  });
});

describe("JournalStore (file-backed durability)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "keel-journal-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("rows survive close + reopen and reload identically", () => {
    const path = join(dir, "keel.db");
    const a = JournalStore.open(path);
    a.insertRun(newRun("r1"));
    a.putJournalRow({
      runId: "r1",
      stableKey: "plan",
      effectType: "pure",
      status: "completed",
      version: "v1",
      inputHash: "hash123",
      resultInline: '{"answer":42}',
      inputDeps: [{ stepKey: "x", contentHash: "y" }],
    });
    a.appendEvent("r1", "done", { ok: true }, 5);
    a.close();

    // Simulate a process restart: a fresh store on the same file.
    const b = JournalStore.open(path);
    expect(b.getRun("r1")?.workflowName).toBe("demo");
    const row = b.getJournalRow("r1", "plan", 1);
    expect(row?.resultInline).toBe('{"answer":42}');
    expect(row?.inputHash).toBe("hash123");
    expect(row?.inputDeps).toEqual([{ stepKey: "x", contentHash: "y" }]);
    expect(b.listEvents("r1")).toHaveLength(1);
    b.close();
  });

  test("a committed transaction is durable; an aborted one leaves nothing", () => {
    const path = join(dir, "keel.db");
    const a = JournalStore.open(path);
    a.insertRun(newRun("r1"));
    a.transaction(() => {
      a.putJournalRow({
        runId: "r1",
        stableKey: "committed",
        effectType: "pure",
        status: "completed",
        version: "v",
        inputHash: "h",
      });
    });
    try {
      a.transaction(() => {
        a.putJournalRow({
          runId: "r1",
          stableKey: "rolled-back",
          effectType: "pure",
          status: "completed",
          version: "v",
          inputHash: "h",
        });
        throw new Error("abort");
      });
    } catch {
      // expected
    }
    a.close();

    const b = JournalStore.open(path);
    const keys = b.listJournalRows("r1").map((r) => r.stableKey);
    expect(keys).toEqual(["committed"]);
    b.close();
  });
});
