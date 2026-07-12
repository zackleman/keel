import { describe, expect, test } from "bun:test";
import { JournalStore } from "../../journal/store.ts";
import { captureWorkflowFile } from "../../workflow-definitions/capture.ts";
import { snapshotWorkflowSource } from "../../workflow-definitions/snapshot.ts";
import { RealmKernel } from "./realm-host.ts";

const FIXTURES = new URL("./fixtures/", import.meta.url);
const parent = captureWorkflowFile(new URL("spawn-parent.workflow.ts", FIXTURES).pathname);
const child = captureWorkflowFile(new URL("spawn-child.workflow.ts", FIXTURES).pathname);
const failingChild = captureWorkflowFile(
  new URL("spawn-failing-child.workflow.ts", FIXTURES).pathname,
);
const TARGET = process.cwd();

function saveChild(store: JournalStore): string {
  const definition = snapshotWorkflowSource(store, child.source, {
    name: "spawn-child",
    nowMs: 1,
  }).snapshot;
  store.putSavedWorkflowVersion({
    name: "spawn-child",
    definitionHash: definition.hash,
    workflowName: "spawn-child",
    defaultTarget: TARGET,
    createdAtMs: 2,
  });
  return definition.hash;
}

describe("ctx.spawn durable child workflows", () => {
  test("spawns and awaits two pinned children with durable lineage", async () => {
    const store = JournalStore.memory();
    const definitionHash = saveChild(store);
    let id = 0;
    const claimedChildren: string[] = [];
    const kernel = new RealmKernel(store, {
      idgen: () => `run_${id++}`,
      clock: (() => {
        let now = 10;
        return () => now++;
      })(),
      onChildRunCreated: (runId) => claimedChildren.push(runId),
    });

    const parentRun = await kernel.run<Array<{ runId: string; status: string; output?: number }>>(
      parent,
      { workflow: "spawn-child@1" },
      { name: "spawn-parent", target: TARGET },
    );

    expect(parentRun.output).toEqual([
      { runId: "run_1", status: "finished", output: 4 },
      { runId: "run_2", status: "finished", output: 6 },
    ]);
    expect(claimedChildren).toEqual(["run_1", "run_2"]);
    expect(store.getRun("run_1")).toMatchObject({
      definitionVersion: definitionHash,
      parentRunId: "run_0",
    });
    expect(store.getRun("run_2")).toMatchObject({
      definitionVersion: definitionHash,
      parentRunId: "run_0",
    });
    expect(JSON.parse(store.getJournalRow("run_0", "spawn-a", 1)?.resultInline ?? "null")).toEqual({
      runId: "run_1",
      definitionHash,
    });
    expect(
      store
        .listJournalRows("run_0")
        .filter((row) => row.effectType === "spawn" || row.effectType === "wait_run")
        .map((row) => [row.stableKey, row.effectType, row.status]),
    ).toEqual([
      ["spawn-a", "spawn", "completed"],
      ["spawn-b", "spawn", "completed"],
      ["wait-a", "wait_run", "completed"],
      ["wait-b", "wait_run", "completed"],
    ]);
  });

  test("returns child failure as the journaled waitRun outcome", async () => {
    const store = JournalStore.memory();
    const definition = snapshotWorkflowSource(store, failingChild.source, {
      name: "spawn-failing-child",
      nowMs: 1,
    }).snapshot;
    store.putSavedWorkflowVersion({
      name: "spawn-failing-child",
      definitionHash: definition.hash,
      workflowName: "spawn-failing-child",
      defaultTarget: TARGET,
      createdAtMs: 2,
    });
    let id = 0;
    const kernel = new RealmKernel(store, { idgen: () => `run_${id++}` });

    const result = await kernel.run<
      Array<{
        runId: string;
        status: string;
        error?: { name: string; message: string };
      }>
    >(parent, { workflow: "spawn-failing-child@1" }, { name: "spawn-parent", target: TARGET });

    expect(result.output).toEqual([
      {
        runId: "run_1",
        status: "failed",
        error: { name: "Error", message: "child failed intentionally" },
      },
      {
        runId: "run_2",
        status: "failed",
        error: { name: "Error", message: "child failed intentionally" },
      },
    ]);
  });

  test("reuses the reserved child after a crash between child creation and spawn completion", async () => {
    const store = JournalStore.memory();
    saveChild(store);
    let id = 0;
    let crashed = false;
    const crashing = new RealmKernel(store, {
      idgen: () => `run_${id++}`,
      fault: (point, key) => {
        if (!crashed && point === "before-commit" && key === "spawn-a") {
          crashed = true;
          throw new Error("INJECTED SPAWN CRASH");
        }
      },
    });

    await expect(
      crashing.run(parent, { workflow: "spawn-child@1" }, { target: TARGET }),
    ).rejects.toThrow("INJECTED SPAWN CRASH");

    const reserved = store.getJournalRow("run_0", "spawn-a", 1);
    expect(reserved).toMatchObject({ status: "pending", effectType: "spawn" });
    expect(store.listRuns().filter((run) => run.parentRunId === "run_0")).toHaveLength(1);

    const resumed = new RealmKernel(store, {
      idgen: () => `run_${id++}`,
    });
    const result =
      await resumed.resume<Array<{ runId: string; status: string; output?: number }>>("run_0");

    expect(result.output?.map((outcome) => outcome.output)).toEqual([4, 6]);
    const children = store.listRuns().filter((run) => run.parentRunId === "run_0");
    expect(children).toHaveLength(2);
    expect(new Set(children.map((run) => run.runId)).size).toBe(2);
  });
});
