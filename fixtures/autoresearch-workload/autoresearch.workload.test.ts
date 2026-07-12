import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentProviderRegistry } from "../../src/agents/types.ts";
import { DaemonClient } from "../../src/daemon/client.ts";
import { JournalStore } from "../../src/journal/store.ts";
import { RealmKernel } from "../../src/kernel/realm/realm-host.ts";
import { captureWorkflowFile } from "../../src/workflow-definitions/capture.ts";
import { readCallLog, startMcp, startWorkloadDaemon, stopProcess, until } from "./harness.ts";
import { ScriptedWorkloadProvider } from "./scripted-provider.ts";

const ADMIN_TOKEN = "kc_admin_autoresearch_workload";
const ROOT = realpathSync(resolve(import.meta.dir, "../.."));
const workflow = captureWorkflowFile(
  resolve(ROOT, "workflows/autoresearch/autoresearch.workflow.ts"),
);
const workflowV2 = captureWorkflowFile(resolve(import.meta.dir, "autoresearch-v2.workflow.ts"));
const baseInput = { iterations: 3, cooldownMs: 0, requireApproval: false };

interface CheckpointPayload {
  stableKey: string;
  attempt: number;
  message: string;
  data: {
    steers?: Array<{ message: string }>;
    best?: { score: number; candidate: string };
  };
}

interface McpFrame {
  kind: "durable";
  seq: number;
  type: string;
  payload: CheckpointPayload;
}

interface McpPage {
  frames: McpFrame[];
  nextCursor: number;
}

function tempPaths() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "keel-ar-")));
  return {
    dir,
    socketPath: join(dir, "k.sock"),
    dbPath: join(dir, "k.db"),
    callLog: join(dir, "calls.ndjson"),
  };
}

async function admin(socketPath: string): Promise<DaemonClient> {
  const client = await DaemonClient.connect(socketPath);
  await client.authenticate(ADMIN_TOKEN);
  return client;
}

async function saveAndLaunch(
  client: DaemonClient,
  input: typeof baseInput,
): Promise<{ runId: string }> {
  await client.saveWorkflow({
    name: "autoresearch",
    source: workflow.source,
    defaultTarget: ROOT,
  });
  return client.launchSavedWorkflow({ ref: { name: "autoresearch", version: 1 }, input });
}

function checkpointPayloads(store: JournalStore, runId: string): CheckpointPayload[] {
  return store
    .listEvents(runId)
    .filter((event) => event.type === "checkpoint")
    .map((event) => JSON.parse(event.payloadJson) as CheckpointPayload);
}

describe("autoresearch workload", () => {
  test("runs the typed keep/revert loop with durable checkpoints", async () => {
    const store = JournalStore.memory();
    const kernel = new RealmKernel(store, {
      idgen: () => "run_autoresearch",
      agents: new AgentProviderRegistry().register(new ScriptedWorkloadProvider()),
    });

    const result = await kernel.run<{
      best: { score: number; candidate: string };
      history: Array<{ result: unknown; accepted: boolean }>;
    }>(workflow, baseInput, { name: "autoresearch", target: ROOT });

    expect(result.status).toBe("finished");
    expect(result.output?.best).toMatchObject({ score: 12, candidate: "candidate-c" });
    expect(result.output?.history.map((entry) => entry.accepted)).toEqual([true, false, true]);
    expect(result.output?.history[1]?.result).toBeNull();
    expect(checkpointPayloads(store, result.runId).map((payload) => payload.stableKey)).toEqual([
      "checkpoint:0",
      "checkpoint:1",
      "checkpoint:2",
      "checkpoint.final",
    ]);
  });

  test("SIGKILL mid-turn resumes with a replayed prefix and no duplicate checkpoints", async () => {
    const paths = tempPaths();
    let first:
      | Awaited<ReturnType<typeof startWorkloadDaemon>>
      | undefined;
    let second:
      | Awaited<ReturnType<typeof startWorkloadDaemon>>
      | undefined;
    try {
      first = await startWorkloadDaemon({
        ...paths,
        adminToken: ADMIN_TOKEN,
        slowKey: "experiment:1",
        slowMs: 3_000,
      });
      const client = await admin(paths.socketPath);
      const launched = await saveAndLaunch(client, baseInput);
      await until(async () =>
        Boolean(
          (await client.getRun(launched.runId))?.nodes.some(
            (node) => node.stableKey === "experiment:1" && node.status === "pending",
          ),
        ),
      );
      client.close();
      await stopProcess(first, "SIGKILL");
      first = undefined;

      const mid = JournalStore.open(paths.dbPath);
      expect(mid.getRun(launched.runId)?.status).toBe("running");
      expect(mid.getJournalRow(launched.runId, "experiment:1", 1)?.status).toBe("pending");
      expect(checkpointPayloads(mid, launched.runId)).toHaveLength(1);
      mid.close();

      await Bun.sleep(400);
      second = await startWorkloadDaemon({ ...paths, adminToken: ADMIN_TOKEN });
      const resumed = await admin(paths.socketPath);
      await until(async () => (await resumed.getRun(launched.runId))?.status === "finished");
      const projection = await resumed.getRun(launched.runId);
      resumed.close();

      const calls = readCallLog(paths.callLog);
      expect(calls.map((call) => call.key)).toEqual([
        "setup",
        "experiment:0",
        "experiment:1",
        "experiment:1",
        "experiment:2",
        "recorder",
      ]);
      expect(projection?.stats.checkpointCount).toBe(4);

      const finalStore = JournalStore.open(paths.dbPath);
      const checkpoints = checkpointPayloads(finalStore, launched.runId);
      expect(checkpoints).toHaveLength(4);
      expect(new Set(checkpoints.map((payload) => payload.stableKey)).size).toBe(4);
      expect(finalStore.getJournalRow(launched.runId, "experiment:1", 1)?.status).toBe(
        "completed",
      );
      finalStore.close();
    } finally {
      if (first) await stopProcess(first);
      if (second) await stopProcess(second);
      rmSync(paths.dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a delayed restart resumes a due sleep and drains steers queued while down", async () => {
    const paths = tempPaths();
    let first:
      | Awaited<ReturnType<typeof startWorkloadDaemon>>
      | undefined;
    let second:
      | Awaited<ReturnType<typeof startWorkloadDaemon>>
      | undefined;
    try {
      first = await startWorkloadDaemon({ ...paths, adminToken: ADMIN_TOKEN });
      const client = await admin(paths.socketPath);
      const launched = await saveAndLaunch(client, { ...baseInput, cooldownMs: 700 });
      await until(async () => (await client.getRun(launched.runId))?.status === "waiting-timer");
      client.close();
      await stopProcess(first, "SIGKILL");
      first = undefined;

      const downStore = JournalStore.open(paths.dbPath);
      downStore.putSignal(launched.runId, "steer", { message: "queued-one" }, 1);
      downStore.putSignal(launched.runId, "steer", { message: "queued-two" }, 2);
      downStore.close();

      await Bun.sleep(800);
      second = await startWorkloadDaemon({ ...paths, adminToken: ADMIN_TOKEN });
      const resumed = await admin(paths.socketPath);
      await until(async () => (await resumed.getRun(launched.runId))?.status === "finished");
      resumed.close();

      const calls = readCallLog(paths.callLog);
      const nextExperiment = calls.find((call) => call.key === "experiment:1");
      expect(nextExperiment?.prompt).toContain("queued-one");
      expect(nextExperiment?.prompt).toContain("queued-two");
      const finalStore = JournalStore.open(paths.dbPath);
      const checkpoints = checkpointPayloads(finalStore, launched.runId);
      expect(checkpoints).toHaveLength(4);
      const iteration = checkpoints.find((payload) => payload.stableKey === "checkpoint:1");
      expect(iteration?.data.steers?.map((steer) => steer.message)).toEqual([
        "queued-one",
        "queued-two",
      ]);
      finalStore.close();
    } finally {
      if (first) await stopProcess(first);
      if (second) await stopProcess(second);
      rmSync(paths.dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("source override invalidates only the edited late-loop suffix", async () => {
    const paths = tempPaths();
    let daemon:
      | Awaited<ReturnType<typeof startWorkloadDaemon>>
      | undefined;
    try {
      daemon = await startWorkloadDaemon({ ...paths, adminToken: ADMIN_TOKEN });
      const client = await admin(paths.socketPath);
      const launched = await saveAndLaunch(client, baseInput);
      await until(async () => (await client.getRun(launched.runId))?.status === "finished");
      const before = readCallLog(paths.callLog).length;

      await client.rerunRun(launched.runId, { source: workflowV2.source });
      await until(async () => (await client.getRun(launched.runId))?.status === "finished");
      client.close();

      expect(readCallLog(paths.callLog).slice(before).map((call) => call.key)).toEqual([
        "experiment:2",
      ]);
      const store = JournalStore.open(paths.dbPath);
      expect(store.getJournalRow(launched.runId, "experiment:0", 2)).toBeNull();
      expect(store.getJournalRow(launched.runId, "experiment:1", 2)).toBeNull();
      expect(store.getJournalRow(launched.runId, "experiment:2", 2)?.status).toBe("completed");
      expect(store.getJournalRow(launched.runId, "recorder", 2)).toBeNull();
      expect(
        checkpointPayloads(store, launched.runId).filter(
          (payload) => payload.stableKey === "checkpoint:0",
        ),
      ).toHaveLength(1);
      store.close();
    } finally {
      if (daemon) await stopProcess(daemon);
      rmSync(paths.dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("real MCP stdio steers, approves, and resumes checkpoint cursors without gaps", async () => {
    const paths = tempPaths();
    let daemon:
      | Awaited<ReturnType<typeof startWorkloadDaemon>>
      | undefined;
    let mcp: Awaited<ReturnType<typeof startMcp>> | undefined;
    try {
      daemon = await startWorkloadDaemon({
        ...paths,
        adminToken: ADMIN_TOKEN,
        slowKey: "experiment:1",
        slowMs: 1_500,
      });
      const client = await admin(paths.socketPath);
      await client.saveWorkflow({
        name: "autoresearch",
        source: workflow.source,
        defaultTarget: ROOT,
      });
      mcp = await startMcp({ socketPath: paths.socketPath, adminToken: ADMIN_TOKEN });
      const launched = await mcp.call<{ runId: string }>("launch_saved_workflow", {
        ref: "autoresearch@1",
        input: { ...baseInput, requireApproval: true },
      });
      expect(Object.keys(launched)).toEqual(["runId"]);

      await until(async () =>
        Boolean(
          (await client.getRun(launched.runId))?.nodes.some(
            (node) => node.stableKey === "experiment:1" && node.status === "pending",
          ),
        ),
      );
      await mcp.call("send_signal", {
        runId: launched.runId,
        name: "steer",
        payload: { message: "focus on parser", from: "phase-4" },
      });
      await until(async () => (await client.getRun(launched.runId))?.status === "waiting-human");

      const blockage = await mcp.call<{ reason: string; approvalId: string }>("get_run_blockage", {
        runId: launched.runId,
      });
      expect(blockage).toMatchObject({
        reason: "waiting_human",
        approvalId: `${launched.runId}:ship`,
      });
      const firstPage = await mcp.call<McpPage>("tail_checkpoints", {
        runId: launched.runId,
        afterSeq: 0,
        limit: 2,
      });
      expect(firstPage.frames).toHaveLength(2);
      await mcp.close();
      mcp = undefined;

      mcp = await startMcp({ socketPath: paths.socketPath, adminToken: ADMIN_TOKEN });
      const secondPage = await mcp.call<McpPage>("tail_checkpoints", {
        runId: launched.runId,
        afterSeq: firstPage.nextCursor,
        limit: 20,
      });
      const allFrames = [...firstPage.frames, ...secondPage.frames];
      expect(allFrames).toHaveLength(4);
      expect(new Set(allFrames.map((frame) => frame.seq)).size).toBe(4);
      expect(
        allFrames
          .find((frame) => frame.payload.stableKey === "checkpoint:2")
          ?.payload.data.steers?.map((steer) => steer.message),
      ).toEqual(["focus on parser"]);

      await mcp.call("decide_approval", {
        approvalId: blockage.approvalId,
        decision: "approved",
        note: "ship it",
      });
      await until(async () => (await client.getRun(launched.runId))?.status === "finished");
      const report = await client.getRunReport(launched.runId);
      expect(report?.output).toMatchObject({ approval: { status: "approved", note: "ship it" } });
      expect(
        readCallLog(paths.callLog).find((call) => call.key === "experiment:2")?.prompt,
      ).toContain("focus on parser");
      client.close();
    } finally {
      if (mcp) await mcp.close();
      if (daemon) await stopProcess(daemon);
      rmSync(paths.dir, { recursive: true, force: true });
    }
  }, 30_000);
});
