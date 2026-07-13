import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AgentProviderRegistry } from "../agents/types.ts";
import { DaemonClient } from "../daemon/client.ts";
import { KeelDaemon } from "../daemon/server.ts";
import { JournalStore } from "../journal/store.ts";
import { captureWorkflowFile } from "../workflow-definitions/capture.ts";
import { createSupervisorMcpServer } from "./server.ts";
import { SupervisorTools } from "./tools.ts";

const ADMIN_TOKEN = "kc_admin_mcp_test";
const FIXTURES = new URL("../kernel/realm/fixtures/", import.meta.url);
const chainSource = captureWorkflowFile(new URL("chain.workflow.ts", FIXTURES).pathname);
const gateSource = captureWorkflowFile(new URL("gate.workflow.ts", FIXTURES).pathname);
const signalSource = captureWorkflowFile(new URL("await-signal.workflow.ts", FIXTURES).pathname);
const stateSource = captureWorkflowFile(new URL("state.workflow.ts", FIXTURES).pathname);

describe("supervisor MCP tools", () => {
  let dir: string;
  let socketPath: string;
  let dbPath: string;
  let daemon: KeelDaemon;
  let tools: SupervisorTools;
  let admin: DaemonClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "keel-mcp-"));
    socketPath = join(dir, "keel.sock");
    dbPath = join(dir, "keel.db");
    daemon = new KeelDaemon({
      socketPath,
      dbPath,
      agents: new AgentProviderRegistry(),
      adminToken: ADMIN_TOKEN,
    });
    await daemon.start();
    tools = await SupervisorTools.connect({ socketPath, credential: ADMIN_TOKEN });
    admin = await DaemonClient.connect(socketPath);
    await admin.authenticate(ADMIN_TOKEN);
  });

  afterEach(() => {
    admin.close();
    tools.close();
    daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("returns canonical detail and bounded, cursor-resumable durable event pages", async () => {
    const launched = await admin.launchRun({
      source: chainSource.source,
      input: { n: 2 },
      target: process.cwd(),
    });
    await admin.waitForRun(launched.runId);

    const canonical = await admin.getRun(launched.runId);
    if (!canonical) throw new Error("launched run projection is missing");
    expect(await tools.getRunDetail(launched.runId)).toEqual(canonical);
    expect(await tools.watchRun(launched.runId)).toMatchObject({
      runId: launched.runId,
      status: "finished",
      phase: canonical.phase,
    });
    expect((await tools.listRuns(1)).runs[0]?.runId).toBe(launched.runId);

    const stateRun = await admin.launchRun({
      source: stateSource.source,
      input: null,
      target: process.cwd(),
    });
    await admin.waitForRun(stateRun.runId);
    const rpcState = await admin.getRunState(stateRun.runId, "research");
    if (!rpcState) throw new Error("state run is missing");
    expect(await tools.getState(stateRun.runId, "research")).toEqual(rpcState);
    expect(rpcState).toEqual({ research: { count: 3, history: [1, 2, 3] } });

    const first = await tools.tailEvents(launched.runId, 0, undefined, 1);
    const second = await tools.tailEvents(launched.runId, first.nextCursor, undefined, 500);
    expect(first.frames).toHaveLength(1);
    expect(first.frames.every((frame) => frame.kind === "durable")).toBe(true);
    expect(second.frames.every((frame) => frame.seq > first.nextCursor)).toBe(true);
    expect(new Set([...first.frames, ...second.frames].map((frame) => frame.seq)).size).toBe(
      first.frames.length + second.frames.length,
    );

    const store = JournalStore.open(dbPath);
    try {
      store.insertRun({
        runId: "run_mcp_child",
        workflowName: "child",
        definitionVersion: canonical.definitionVersion,
        workflowRef: canonical.definitionVersion,
        runTarget: process.cwd(),
        status: "finished",
        parentRunId: launched.runId,
        tenantId: null,
        inputRef: "null",
        outputRef: "null",
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        launchAuthorityJson: null,
        createdAtMs: Date.now(),
        finishedAtMs: Date.now(),
      });
      store.appendEvent(
        launched.runId,
        "checkpoint",
        { stableKey: "cp", attempt: 1, message: "safe", data: null },
        Date.now(),
      );
      store.appendEvent(launched.runId, "diagnostic", { token: "kc_run_mcp_secret" }, Date.now());
    } finally {
      store.close();
    }
    expect(await tools.listRuns(500, launched.runId)).toMatchObject({
      runs: [{ runId: "run_mcp_child", parentRunId: launched.runId }],
      total: 1,
    });
    const checkpoints = await tools.tailCheckpoints(launched.runId);
    expect(checkpoints.frames.map((frame) => frame.type)).toEqual(["checkpoint"]);
    const diagnostics = await tools.tailEvents(launched.runId, 0, ["diagnostic"]);
    expect(JSON.stringify(diagnostics)).not.toContain("kc_run_mcp_secret");
    expect(JSON.stringify(diagnostics)).toContain("redacted-capability");
  });

  test("launches, signals, approves, interrupts, resumes, and enforces run-scoped authority", async () => {
    await admin.saveWorkflow({
      name: "mcp-chain",
      source: chainSource.source,
      defaultTarget: process.cwd(),
    });
    const saved = await tools.launchSavedWorkflow("mcp-chain@1", { n: 1 });
    expect(Object.keys(saved)).toEqual(["runId"]);
    expect(await tools.waitForRun(saved.runId)).toMatchObject({ status: "finished", output: 1 });

    const signal = await admin.launchRun({
      source: signalSource.source,
      input: null,
      target: process.cwd(),
    });
    await admin.waitForRun(signal.runId);
    expect((await tools.sendSignal(signal.runId, "proceed", { go: true, by: "mcp" })).runId).toBe(
      signal.runId,
    );
    expect(await tools.waitForRun(signal.runId)).toMatchObject({
      status: "finished",
      output: { go: true, by: "mcp" },
    });

    const gate = await admin.launchRun({
      source: gateSource.source,
      input: null,
      target: process.cwd(),
    });
    await admin.waitForRun(gate.runId);
    const blockage = await tools.getRunBlockage(gate.runId);
    expect(blockage).toMatchObject({ reason: "waiting_human" });
    expect(blockage.approvalId).toBe(`${gate.runId}:approve-deploy`);

    await tools.interruptRun(gate.runId);
    expect((await tools.watchRun(gate.runId)).status).toBe("interrupted");
    await tools.decideApproval(blockage.approvalId as string, "approved", "ship it");
    expect((await tools.watchRun(gate.runId)).status).toBe("interrupted");
    await tools.resumeRun(gate.runId);
    expect(await tools.waitForRun(gate.runId)).toMatchObject({
      status: "finished",
      output: "deploy:approved",
    });

    const scoped = await SupervisorTools.connect({
      socketPath,
      credential: gate.capability as string,
    });
    try {
      expect((await scoped.watchRun(gate.runId)).runId).toBe(gate.runId);
      await expect(scoped.listRuns()).rejects.toThrow(/admin/);
      await expect(scoped.watchRun(signal.runId)).rejects.toThrow(/different resource/);
    } finally {
      scoped.close();
    }
  });

  test("registers the complete tool set with the MCP protocol", async () => {
    const server = createSupervisorMcpServer(tools);
    const client = new Client({ name: "keel-mcp-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual(
        [
          "decide_approval",
          "get_run_blockage",
          "get_run_detail",
          "get_state",
          "interrupt_run",
          "launch_saved_workflow",
          "list_runs",
          "resume_run",
          "send_signal",
          "tail_checkpoints",
          "tail_events",
          "wait_for_run",
          "watch_run",
        ].sort(),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
