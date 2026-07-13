import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CapabilityAction,
  type CapabilityResource,
  ensureAdminCapability,
  ensureSubmitterCapability,
  hashCapabilityToken,
} from "../auth/capabilities.ts";
import { JournalStore } from "../journal/store.ts";
import type { RunStatus } from "../journal/types.ts";
import { RealmKernel } from "../kernel/realm/realm-host.ts";
import { EventHub } from "../rpc/event-hub.ts";
import { InProcessKeel } from "../rpc/in-process.ts";
import { MAX_RUN_SUMMARY_PAGE_LIMIT } from "../rpc/projection.ts";
import { captureWorkflowFile } from "../workflow-definitions/capture.ts";
import { type GatewayEventFrame, type GatewaySession, KeelOperationGateway } from "./gateway.ts";

const FIX = new URL("../kernel/realm/fixtures/", import.meta.url);
const chainUrl = captureWorkflowFile(new URL("chain.workflow.ts", FIX).pathname);
const gateUrl = captureWorkflowFile(
  new URL("../kernel/realm/fixtures/gate.workflow.ts", import.meta.url).pathname,
);
const signalUrl = captureWorkflowFile(
  new URL("../kernel/realm/fixtures/await-signal.workflow.ts", import.meta.url).pathname,
);

const ADMIN_TOKEN = "kc_admin_gateway_test";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keel-gateway-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

class FakeGatewaySession implements GatewaySession {
  readonly id: string;
  credential: string | null = null;
  readonly events: GatewayEventFrame[] = [];
  readonly cleanups = new Set<() => void>();

  constructor(id: string) {
    this.id = id;
  }

  getCredential(): string | null {
    return this.credential;
  }

  setCredential(token: string | null): void {
    this.credential = token;
  }

  sendEvent(event: GatewayEventFrame): void {
    this.events.push(event);
  }

  addCleanup(cleanup: () => void): void {
    this.cleanups.add(cleanup);
  }

  removeCleanup(cleanup: () => void): void {
    this.cleanups.delete(cleanup);
  }

  close(): void {
    for (const cleanup of [...this.cleanups]) cleanup();
    this.cleanups.clear();
  }
}

interface GatewayHarness {
  store: JournalStore;
  eventHub: EventHub;
  api: InProcessKeel;
  gateway: KeelOperationGateway;
  launchedClaims: string[];
  fencedClaims: string[];
  rejectClaims: boolean;
  close(): void;
}

function createHarness(): GatewayHarness {
  const store = JournalStore.memory();
  ensureAdminCapability(store, ADMIN_TOKEN, 1);
  const eventHub = new EventHub();
  const clock = () => Date.now();
  const kernel = new RealmKernel(store, {
    workspaceStore: join(dir, "workspaces"),
    definitionCacheRoot: join(dir, "definitions"),
    clock,
  });
  const api = new InProcessKeel(kernel, store, eventHub, { clock });
  const harness: GatewayHarness = {
    store,
    eventHub,
    api,
    launchedClaims: [],
    fencedClaims: [],
    rejectClaims: false,
    gateway: undefined as never,
    close() {
      api.close();
      kernel.shutdown();
      store.close();
    },
  };
  harness.gateway = new KeelOperationGateway({
    ownerId: "gateway-test-owner",
    api,
    store,
    clock,
    claimLaunchedRun(runId) {
      harness.launchedClaims.push(runId);
      store.claimRun(runId, "gateway-test-owner", clock(), clock());
    },
    claimOrReject(runId) {
      harness.fencedClaims.push(runId);
      if (harness.rejectClaims) throw new Error("ownership fence rejected by test");
      if (!store.getRun(runId)) throw new Error(`run ${runId} not found`);
      store.claimRun(runId, "gateway-test-owner", 0, clock());
    },
    definitionCacheRoot: join(dir, "definitions"),
  });
  return harness;
}

async function ok<T>(
  harness: GatewayHarness,
  session: FakeGatewaySession,
  method: string,
  params: unknown = {},
  credential?: string | null,
): Promise<T> {
  const res = await harness.gateway.handle(session, {
    id: method,
    method,
    params,
    ...(credential !== undefined ? { credential } : {}),
  });
  expect(res.error).toBeUndefined();
  return res.result as T;
}

async function fail(
  harness: GatewayHarness,
  session: FakeGatewaySession,
  method: string,
  params: unknown = {},
  credential?: string | null,
): Promise<string> {
  const res = await harness.gateway.handle(session, {
    id: method,
    method,
    params,
    ...(credential !== undefined ? { credential } : {}),
  });
  expect(res.result).toBeUndefined();
  expect(res.error).toBeDefined();
  return (res.error as { message: string }).message;
}

function putCapability(
  store: JournalStore,
  token: string,
  resource: CapabilityResource,
  actions: CapabilityAction[],
  opts: { revokedAtMs?: number | null; expiresAtMs?: number | null } = {},
): void {
  store.putCapability({
    id: `cap_${token.replaceAll(/[^A-Za-z0-9_]/g, "_")}`,
    secretHash: hashCapabilityToken(token),
    resourceJson: JSON.stringify(resource),
    actionsJson: JSON.stringify(actions),
    createdAtMs: 1,
    expiresAtMs: opts.expiresAtMs ?? null,
    revokedAtMs: opts.revokedAtMs ?? null,
    note: "gateway test",
  });
}

function insertRun(
  store: JournalStore,
  runId: string,
  status: RunStatus = "running",
  definitionVersion = "wf_sha256_gateway_test",
): void {
  store.insertRun({
    runId,
    workflowName: "gateway-test",
    definitionVersion,
    workflowRef: null,
    runTarget: dir,
    status,
    parentRunId: null,
    tenantId: null,
    inputRef: "null",
    outputRef: null,
    errorJson: null,
    heartbeatAtMs: null,
    runtimeOwnerId: null,
    launchAuthorityJson: null,
    createdAtMs: 1,
    finishedAtMs: status === "finished" ? 2 : null,
  });
}

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error(message);
}

describe("KeelOperationGateway", () => {
  test("requires admin authority to browse daemon directories", async () => {
    const harness = createHarness();
    const session = new FakeGatewaySession("directory-browser");
    mkdirSync(join(dir, "project-a"));
    try {
      await expect(
        fail(harness, session, "browseDirectories", { path: dir }, null),
      ).resolves.toMatch(/admin .* not authorized/);

      await expect(
        ok(harness, session, "browseDirectories", { path: dir }, ADMIN_TOKEN),
      ).resolves.toMatchObject({
        path: dir,
        entries: [{ name: "project-a", path: join(dir, "project-a") }],
      });
    } finally {
      harness.close();
    }
  });

  test("handles session auth, health, admin auth, open launch, and run-scoped reads without a socket", async () => {
    const harness = createHarness();
    const session = new FakeGatewaySession("session-auth");
    try {
      await expect(ok(harness, session, "ping")).resolves.toMatchObject({
        ok: true,
        ownerId: "gateway-test-owner",
      });

      await expect(
        ok(harness, session, "authenticate", { token: "kc_run_invalid_gateway" }),
      ).resolves.toEqual({ ok: true });
      expect(session.getCredential()).toBe("kc_run_invalid_gateway");
      await expect(fail(harness, session, "listRuns")).resolves.toMatch(/capability is invalid/);
      await expect(fail(harness, session, "listRunsPage", { limit: 1 })).resolves.toMatch(
        /capability is invalid/,
      );

      await ok(harness, session, "authenticate", { token: ADMIN_TOKEN });
      await expect(ok(harness, session, "listRuns")).resolves.toEqual([]);
      await expect(ok(harness, session, "listRunsPage", { limit: 1 })).resolves.toEqual({
        runs: [],
        total: 0,
      });
      await expect(
        fail(harness, session, "listRunsPage", { limit: MAX_RUN_SUMMARY_PAGE_LIMIT + 1 }),
      ).resolves.toBe(`listRunsPage limit must be <= ${MAX_RUN_SUMMARY_PAGE_LIMIT}`);

      const launched = await ok<{ runId: string; capability: string; capabilityId: string }>(
        harness,
        session,
        "launchRun",
        { ...chainUrl, input: { n: 0 }, target: dir, name: "open-launch" },
        null,
      );
      expect(launched.capability).toStartWith("kc_run_");
      expect(launched.capabilityId).toStartWith("cap_");
      expect(harness.launchedClaims).toContain(launched.runId);
      expect(
        harness.store.getCapabilityByHash(hashCapabilityToken(launched.capability)),
      ).toMatchObject({ id: launched.capabilityId });

      const run = await ok<{ runId: string }>(
        harness,
        session,
        "getRun",
        { runId: launched.runId },
        launched.capability,
      );
      expect(run.runId).toBe(launched.runId);
    } finally {
      harness.close();
    }
  });

  test("web surface rejects raw runSecrets before dispatch", async () => {
    const harness = createHarness();
    const session = new FakeGatewaySession("web-run-secrets");
    try {
      const topLevel = await harness.gateway.handle(session, {
        id: "web-launch-secret",
        method: "launchRun",
        surface: "web",
        credential: ADMIN_TOKEN,
        params: {
          ...chainUrl,
          input: { n: 0 },
          target: dir,
          runSecrets: { TOKEN: "top-level-secret" },
        },
      });
      expect(topLevel.result).toBeUndefined();
      expect(topLevel.error?.message).toBe("runSecrets are not accepted from the web surface");
      expect(JSON.stringify(topLevel)).not.toContain("top-level-secret");

      const nested = await harness.gateway.handle(session, {
        id: "web-rerun-secret",
        method: "rerunRun",
        surface: "web",
        credential: ADMIN_TOKEN,
        params: {
          runId: "run_missing_web_secret",
          opts: { runSecrets: { TOKEN: "nested-secret" } },
        },
      });
      expect(nested.result).toBeUndefined();
      expect(nested.error?.message).toBe("runSecrets are not accepted from the web surface");
      expect(JSON.stringify(nested)).not.toContain("nested-secret");
    } finally {
      harness.close();
    }
  });

  test("enforces workflow-scoped save/read/run authorization with version semantics", async () => {
    const harness = createHarness();
    const session = new FakeGatewaySession("workflow-auth");
    const saveToken = "kc_run_gateway_workflow_save";
    const readToken = "kc_run_gateway_workflow_read";
    const runV1Token = "kc_run_gateway_workflow_run_v1";
    try {
      putCapability(harness.store, saveToken, { kind: "workflow", name: "review-loop" }, [
        "workflow:save",
      ]);
      putCapability(harness.store, readToken, { kind: "workflow", name: "review-loop" }, [
        "workflow:read",
      ]);
      putCapability(
        harness.store,
        runV1Token,
        { kind: "workflow", name: "review-loop", version: 1 },
        ["workflow:run"],
      );

      await ok(
        harness,
        session,
        "saveWorkflow",
        {
          name: "review-loop",
          version: 1,
          source: chainUrl.source,
          defaultTarget: dir,
        },
        saveToken,
      );
      await expect(
        ok(harness, session, "getSavedWorkflow", { name: "review-loop" }, readToken),
      ).resolves.toMatchObject({ name: "review-loop" });

      const launched = await ok<{ runId: string; capability: string }>(
        harness,
        session,
        "launchSavedWorkflow",
        { ref: { name: "review-loop", version: 1 }, input: { n: 0 } },
        runV1Token,
      );
      expect(launched.capability).toStartWith("kc_run_");

      await ok(
        harness,
        session,
        "saveWorkflow",
        {
          name: "review-loop",
          version: 2,
          source: chainUrl.source,
          defaultTarget: dir,
          allowDuplicateDefinition: true,
        },
        saveToken,
      );
      await expect(
        fail(
          harness,
          session,
          "launchSavedWorkflow",
          {
            ref: { name: "review-loop" },
            input: { n: 0 },
          },
          runV1Token,
        ),
      ).resolves.toMatch(/different resource/);
    } finally {
      harness.close();
    }
  });

  test("requires a dedicated matching review before any save under submitter governance", async () => {
    const harness = createHarness();
    const session = new FakeGatewaySession("promotion-review");
    try {
      ensureSubmitterCapability(
        harness.store,
        "kc_submitter_gateway_promotion",
        "untrusted-default",
        1,
      );

      await expect(
        fail(
          harness,
          session,
          "saveWorkflow",
          { name: "reviewed-chain", source: chainUrl.source, defaultTarget: dir },
          ADMIN_TOKEN,
        ),
      ).resolves.toMatch(/requires reviewApproval/);

      const preview = harness.api.previewWorkflowDefinition({ source: chainUrl.source });
      insertRun(harness.store, "run_promotion_review", "finished", preview.definitionHash);
      harness.store.requestApproval(
        "run_promotion_review",
        "ship",
        { prompt: "Ship this workflow?" },
        2,
      );
      harness.store.decideApproval("run_promotion_review", "ship", { status: "approved" }, 3);
      await expect(
        fail(
          harness,
          session,
          "saveWorkflow",
          {
            name: "reviewed-chain",
            source: chainUrl.source,
            defaultTarget: dir,
            reviewApproval: { runId: "run_promotion_review", key: "ship" },
          },
          ADMIN_TOKEN,
        ),
      ).resolves.toMatch(/review key must start with "review:"/);

      harness.store.requestApproval(
        "run_promotion_review",
        "review:promotion",
        { prompt: "Promote this definition?" },
        4,
      );
      harness.store.decideApproval(
        "run_promotion_review",
        "review:promotion",
        { status: "approved" },
        5,
      );
      await expect(
        ok<{ definitionHash: string }>(
          harness,
          session,
          "saveWorkflow",
          {
            name: "reviewed-chain",
            source: chainUrl.source,
            defaultTarget: dir,
            reviewApproval: { runId: "run_promotion_review", key: "review:promotion" },
          },
          ADMIN_TOKEN,
        ),
      ).resolves.toMatchObject({ definitionHash: preview.definitionHash });
    } finally {
      harness.close();
    }
  });

  test("submitter credentials still require workflow-scoped run authorization", async () => {
    const harness = createHarness();
    const session = new FakeGatewaySession("submitter-saved-workflow");
    const submitterToken = "kc_submitter_gateway_saved_workflow";
    try {
      await ok(
        harness,
        session,
        "saveWorkflow",
        { name: "saved-chain", source: chainUrl.source, defaultTarget: dir },
        ADMIN_TOKEN,
      );
      ensureSubmitterCapability(harness.store, submitterToken, "untrusted-default", 1);

      await expect(
        fail(
          harness,
          session,
          "launchSavedWorkflow",
          { ref: { name: "saved-chain" }, input: { n: 0 } },
          submitterToken,
        ),
      ).resolves.toMatch(/does not grant workflow:run/);
      expect(harness.store.listRuns()).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test("issues fork capabilities and redacts capability-looking values in gateway errors", async () => {
    const harness = createHarness();
    const session = new FakeGatewaySession("fork-redaction");
    try {
      const launched = await ok<{ runId: string; capability: string }>(
        harness,
        session,
        "launchRun",
        { ...chainUrl, input: { n: 0 }, target: dir, name: "fork-source" },
        null,
      );
      await ok(harness, session, "waitForRun", { runId: launched.runId }, launched.capability);

      const forked = await ok<{ runId: string; capability: string; capabilityId: string }>(
        harness,
        session,
        "forkRun",
        { runId: launched.runId },
        launched.capability,
      );
      expect(forked.runId).not.toBe(launched.runId);
      expect(forked.capability).toStartWith("kc_run_");
      expect(
        harness.store.getCapabilityByHash(hashCapabilityToken(forked.capability)),
      ).toMatchObject({ id: forked.capabilityId });

      const message = await fail(
        harness,
        session,
        "getRunWorkspaceDiff",
        { runId: launched.runId, workspaceId: "kc_run_secret_in_path" },
        launched.capability,
      );
      expect(message).toContain("«redacted-capability»");
      expect(message).not.toContain("kc_run_secret_in_path");
    } finally {
      harness.close();
    }
  });

  test("wakes parked approval and signal runs through gateway-owned daemon operations", async () => {
    const harness = createHarness();
    const session = new FakeGatewaySession("wake-parked");
    try {
      const gate = await ok<{ runId: string; capability: string }>(
        harness,
        session,
        "launchRun",
        { ...gateUrl, input: null, target: dir, name: "gate" },
        null,
      );
      await expect(
        ok(harness, session, "waitForRun", { runId: gate.runId }, gate.capability),
      ).resolves.toMatchObject({ status: "waiting-human" });
      const approvalWake = await ok(
        harness,
        session,
        "decideApproval",
        {
          runId: gate.runId,
          key: "approve-deploy",
          decision: { status: "approved" },
        },
        ADMIN_TOKEN,
      );
      expect(approvalWake).toMatchObject({
        runId: gate.runId,
        status: "running",
        attachCursor: { kind: "after-seq", runId: gate.runId, seq: 3 },
      });
      await expect(
        ok(harness, session, "waitForRun", { runId: gate.runId }, gate.capability),
      ).resolves.toMatchObject({ status: "finished" });

      const signal = await ok<{ runId: string; capability: string }>(
        harness,
        session,
        "launchRun",
        { ...signalUrl, input: null, target: dir, name: "signal" },
        null,
      );
      await expect(
        ok(harness, session, "waitForRun", { runId: signal.runId }, signal.capability),
      ).resolves.toMatchObject({ status: "waiting-signal" });
      const signalWake = await ok<{
        runId: string;
        status: string;
        attachCursor: { kind: "after-seq"; runId: string; seq: number };
      }>(
        harness,
        session,
        "sendSignal",
        {
          runId: signal.runId,
          name: "proceed",
          payload: { go: true, by: "gateway" },
        },
        signal.capability,
      );
      expect(signalWake).toMatchObject({
        runId: signal.runId,
        status: "running",
        attachCursor: { kind: "after-seq", runId: signal.runId, seq: 2 },
      });
      expect(harness.fencedClaims).toContain(gate.runId);
      expect(harness.fencedClaims).toContain(signal.runId);
      await expect(
        ok(harness, session, "waitForRun", { runId: signal.runId }, signal.capability),
      ).resolves.toMatchObject({ status: "finished" });
      const signalAttach = await ok<{ subId: string }>(
        harness,
        session,
        "subscribeEvents",
        { runId: signal.runId, cursor: signalWake.attachCursor },
        signal.capability,
      );
      const attachedSignalEvents = session.events
        .filter((event) => event.subId === signalAttach.subId)
        .map((event) => event.type);
      expect(attachedSignalEvents).toContain("run.resumed");
    } finally {
      harness.close();
    }
  });

  test("coalesces concurrent delivery wakes for the same run in one daemon", async () => {
    const harness = createHarness();
    const session = new FakeGatewaySession("wake-coalesce");
    const runId = "run_gateway_coalesce";
    const token = "kc_run_gateway_coalesce";
    let resumeCalls = 0;
    try {
      insertRun(harness.store, runId, "waiting-signal");
      putCapability(harness.store, token, { kind: "run", runId }, ["run:signal"]);
      harness.api.resumeRun = async (id: string) => {
        resumeCalls += 1;
        await Bun.sleep(50);
        return {
          runId: id,
          status: "waiting-signal",
          attachCursor: { kind: "after-seq", runId: id, seq: 0 },
        };
      };
      harness.api.waitForRun = async (id: string) => {
        await Bun.sleep(50);
        return { runId: id, status: "waiting-signal", error: null };
      };

      const [first, second] = await Promise.all([
        ok(harness, session, "sendSignal", { runId, name: "proceed", payload: 1 }, token),
        ok(harness, session, "sendSignal", { runId, name: "proceed", payload: 2 }, token),
      ]);

      expect(first).toMatchObject({
        runId,
        status: "running",
        attachCursor: { kind: "after-seq", runId, seq: 0 },
      });
      expect(second).toMatchObject({
        runId,
        status: "running",
        attachCursor: { kind: "after-seq", runId, seq: 0 },
      });
      expect(resumeCalls).toBe(1);
      expect(harness.fencedClaims).toEqual([runId]);
    } finally {
      harness.close();
    }
  });

  test("keeps parked wake operations behind the ownership fence", async () => {
    const harness = createHarness();
    const session = new FakeGatewaySession("wake-fence");
    try {
      const gate = await ok<{ runId: string; capability: string }>(
        harness,
        session,
        "launchRun",
        { ...gateUrl, input: null, target: dir, name: "gate-fence" },
        null,
      );
      await ok(harness, session, "waitForRun", { runId: gate.runId }, gate.capability);
      harness.rejectClaims = true;
      await expect(
        fail(
          harness,
          session,
          "decideApproval",
          {
            runId: gate.runId,
            key: "approve-deploy",
            decision: { status: "approved" },
          },
          ADMIN_TOKEN,
        ),
      ).resolves.toBe("ownership fence rejected by test");
      expect(harness.fencedClaims).toContain(gate.runId);
      expect(harness.store.getRun(gate.runId)?.status).toBe("waiting-human");

      harness.rejectClaims = false;
      const signal = await ok<{ runId: string; capability: string }>(
        harness,
        session,
        "launchRun",
        { ...signalUrl, input: null, target: dir, name: "signal-fence" },
        null,
      );
      await ok(harness, session, "waitForRun", { runId: signal.runId }, signal.capability);
      harness.rejectClaims = true;
      await expect(
        fail(
          harness,
          session,
          "sendSignal",
          {
            runId: signal.runId,
            name: "proceed",
            payload: { go: true, by: "gateway" },
          },
          signal.capability,
        ),
      ).resolves.toBe("ownership fence rejected by test");
      expect(harness.fencedClaims).toContain(signal.runId);
      expect(harness.store.getRun(signal.runId)?.status).toBe("waiting-signal");
    } finally {
      harness.close();
    }
  });

  test("subscribes with backfill, live delivery, credential snapshot, revocation stop, cleanup, and payload redaction", async () => {
    const harness = createHarness();
    const session = new FakeGatewaySession("events");
    const runId = "run_gateway_events";
    const eventToken = "kc_run_gateway_events";
    let cleanupSession: FakeGatewaySession | null = null;
    let idleSession: FakeGatewaySession | null = null;
    try {
      insertRun(harness.store, runId);
      putCapability(harness.store, eventToken, { kind: "run", runId }, ["run:events"]);
      harness.store.appendEvent(runId, "run.started", { token: "kc_run_backfill_secret" }, 1);

      const sub = await ok<{
        subId: string;
        cursor: { kind: "after-seq"; runId: string; seq: number };
      }>(harness, session, "subscribeEvents", { runId, cursor: { kind: "beginning" } }, eventToken);
      expect(sub.cursor).toEqual({ kind: "after-seq", runId, seq: 1 });
      await expect(
        fail(harness, session, "subscribeEvents", { runId, afterSeq: 0 }, eventToken),
      ).resolves.toContain("numeric afterSeq is not supported");
      const badCursorSession = new FakeGatewaySession("bad-cursor");
      await expect(
        fail(
          harness,
          badCursorSession,
          "subscribeEvents",
          { runId, cursor: { kind: "after-seq", seq: -1 } },
          eventToken,
        ),
      ).resolves.toContain("cursor seq must be a non-negative integer");
      expect(badCursorSession.cleanups.size).toBe(0);
      expect(session.events).toEqual([
        {
          subId: sub.subId,
          kind: "durable",
          seq: 1,
          type: "run.started",
          payload: { token: "«redacted-capability»" },
          atMs: 1,
        },
      ]);
      expect(session.cleanups.size).toBe(1);

      session.setCredential(null);
      harness.store.appendEvent(runId, "run.progress", { ok: true }, 2);
      expect(session.events.at(-1)).toMatchObject({
        subId: sub.subId,
        kind: "durable",
        seq: 2,
        type: "run.progress",
      });

      harness.eventHub.publishEphemeral(runId, "agent.event", { token: "kc_run_live_secret" }, 3);
      expect(session.events.at(-1)).toMatchObject({
        subId: sub.subId,
        kind: "ephemeral",
        type: "agent.event",
        payload: { token: "«redacted-capability»" },
      });

      const controlSession = new FakeGatewaySession("control");
      putCapability(harness.store, "kc_run_gateway_events_control", { kind: "run", runId }, [
        "run:events",
      ]);
      const controlSub = await ok<{ subId: string }>(
        harness,
        controlSession,
        "subscribeEvents",
        { runId, cursor: { kind: "after-seq", seq: 2 }, includeControlFrames: true },
        "kc_run_gateway_events_control",
      );
      expect(controlSession.events).toContainEqual({
        subId: controlSub.subId,
        kind: "control",
        type: "caught-up",
        cursor: { kind: "after-seq", runId, seq: 2 },
      });
      putCapability(
        harness.store,
        "kc_run_gateway_events_control",
        { kind: "run", runId },
        ["run:events"],
        { revokedAtMs: Date.now() },
      );
      harness.store.appendEvent(runId, "run.control-revoke", { token: "kc_run_control_secret" }, 4);
      expect(controlSession.events.at(-1)).toMatchObject({
        subId: controlSub.subId,
        kind: "control",
        type: "authorization.failed",
        cursor: { kind: "after-seq", runId, seq: 2 },
      });
      expect(JSON.stringify(controlSession.events.at(-1))).not.toContain("kc_run_control_secret");
      expect(controlSession.cleanups.size).toBe(0);
      controlSession.close();

      putCapability(harness.store, eventToken, { kind: "run", runId }, ["run:events"], {
        revokedAtMs: Date.now(),
      });
      harness.store.appendEvent(runId, "run.after-revoke", {}, 5);
      expect(session.events.at(-1)).toMatchObject({
        subId: sub.subId,
        kind: "ephemeral",
        type: "authorization.failed",
      });
      expect(session.cleanups.size).toBe(0);
      const eventCountAfterFailure = session.events.length;
      harness.store.appendEvent(runId, "run.ignored", {}, 6);
      expect(session.events).toHaveLength(eventCountAfterFailure);

      const idleRunId = "run_gateway_events_idle";
      const idleToken = "kc_run_gateway_events_idle";
      insertRun(harness.store, idleRunId);
      putCapability(harness.store, idleToken, { kind: "run", runId: idleRunId }, ["run:events"]);
      idleSession = new FakeGatewaySession("idle");
      const idleSub = await ok<{ subId: string }>(
        harness,
        idleSession,
        "subscribeEvents",
        { runId: idleRunId, cursor: { kind: "beginning" } },
        idleToken,
      );
      putCapability(harness.store, idleToken, { kind: "run", runId: idleRunId }, ["run:events"], {
        revokedAtMs: Date.now(),
      });
      await waitFor(
        () =>
          idleSession?.events.some(
            (event) => event.subId === idleSub.subId && event.type === "authorization.failed",
          ) ?? false,
        "idle subscription did not fail after capability revocation",
      );
      expect(idleSession.cleanups.size).toBe(0);

      cleanupSession = new FakeGatewaySession("cleanup");
      putCapability(harness.store, "kc_run_gateway_events_2", { kind: "run", runId }, [
        "run:events",
      ]);
      const cleanupSub = await ok<{ subId: string }>(
        harness,
        cleanupSession,
        "subscribeEvents",
        { runId, cursor: { kind: "after-seq", seq: 6 } },
        "kc_run_gateway_events_2",
      );
      expect(cleanupSession.cleanups.size).toBe(1);
      cleanupSession.close();
      harness.store.appendEvent(runId, "run.after-close", {}, 7);
      expect(cleanupSession.events.some((event) => event.subId === cleanupSub.subId)).toBe(false);
      expect(cleanupSession.cleanups.size).toBe(0);
    } finally {
      session.close();
      cleanupSession?.close();
      idleSession?.close();
      harness.close();
    }
  });
});
