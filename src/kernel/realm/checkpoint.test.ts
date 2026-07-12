import { describe, expect, test } from "bun:test";
import { hashJson } from "../../hash.ts";
import { JournalStore } from "../../journal/store.ts";
import { EventHub } from "../../rpc/event-hub.ts";
import { buildProjection } from "../../rpc/projection.ts";
import { captureWorkflowFile } from "../../workflow-definitions/capture.ts";
import { RealmKernel } from "./realm-host.ts";

const workflow = captureWorkflowFile(
  new URL("./fixtures/checkpoint.workflow.ts", import.meta.url).pathname,
);
const TARGET = process.cwd();

function kernel(
  store: JournalStore,
  extra: ConstructorParameters<typeof RealmKernel>[1] = {},
): RealmKernel {
  return new RealmKernel(store, {
    idgen: () => "run_0",
    clock: () => 1_000,
    ...extra,
  });
}

function checkpointEvents(store: JournalStore) {
  return store
    .listEvents("run_0")
    .filter((event) => event.type === "checkpoint")
    .map((event) => JSON.parse(event.payloadJson) as unknown);
}

describe("ctx.checkpoint", () => {
  test("journals ordered progress without parking and exposes it in the projection", async () => {
    const store = JournalStore.memory();

    const result = await kernel(store).run<boolean>(workflow, null, {
      name: "checkpoint",
      target: TARGET,
    });

    expect(result).toMatchObject({ status: "finished", output: true });
    expect(store.listJournalRows("run_0").filter((row) => row.effectType === "checkpoint")).toEqual(
      [
        expect.objectContaining({
          stableKey: "checkpoint.first",
          attempt: 1,
          status: "completed",
          inputHash: hashJson({ message: "Started work", data: { completed: 1, total: 2 } }),
          resultInline: JSON.stringify({
            message: "Started work",
            data: { completed: 1, total: 2 },
          }),
        }),
        expect.objectContaining({
          stableKey: "checkpoint.second",
          attempt: 1,
          status: "completed",
          inputHash: hashJson({ message: "Finished work", data: null }),
          resultInline: JSON.stringify({ message: "Finished work", data: null }),
        }),
      ],
    );
    expect(checkpointEvents(store)).toEqual([
      {
        stableKey: "checkpoint.first",
        attempt: 1,
        message: "Started work",
        data: { completed: 1, total: 2 },
      },
      {
        stableKey: "checkpoint.second",
        attempt: 1,
        message: "Finished work",
        data: null,
      },
    ]);
    const backfilled: unknown[] = [];
    const subscription = new EventHub().subscribe(
      store,
      { runId: "run_0", cursor: { kind: "beginning" } },
      (event) => {
        if (event.kind === "durable" && event.type === "checkpoint") {
          backfilled.push(event.payload);
        }
      },
    );
    subscription.unsubscribe();
    expect(backfilled).toEqual(checkpointEvents(store));

    expect(buildProjection(store, "run_0")).toMatchObject({
      nodes: [
        {
          stableKey: "after-checkpoints",
          checkpoint: null,
        },
        {
          stableKey: "checkpoint.first",
          checkpoint: {
            message: "Started work",
            data: { completed: 1, total: 2 },
          },
        },
        {
          stableKey: "checkpoint.second",
          checkpoint: { message: "Finished work", data: null },
        },
      ],
      stats: { steps: 1, agents: 0, checkpointCount: 2, artifacts: 0 },
    });
  });

  test("replay after a later crash does not re-emit checkpoint events", async () => {
    const store = JournalStore.memory();
    await kernel(store, {
      fault: (point, key) => {
        if (point === "before-commit" && key === "after-checkpoints") throw new Error("CRASH");
      },
    })
      .run(workflow, null, { name: "checkpoint-replay", target: TARGET })
      .catch(() => null);

    expect(checkpointEvents(store)).toHaveLength(2);

    const resumed = await kernel(store).resume<boolean>("run_0");

    expect(resumed).toMatchObject({ status: "finished", output: true });
    expect(checkpointEvents(store)).toHaveLength(2);
  });

  test("a crash before checkpoint completion leaves it pending and re-executes it", async () => {
    const store = JournalStore.memory();
    let executions = 0;
    await kernel(store, {
      onStepExecute: (key) => {
        if (key === "checkpoint.first") executions++;
      },
      fault: (point, key) => {
        if (point === "before-commit" && key === "checkpoint.first") throw new Error("CRASH");
      },
    })
      .run(workflow, null, { name: "checkpoint-crash", target: TARGET })
      .catch(() => null);

    expect(store.getJournalRow("run_0", "checkpoint.first", 1)).toMatchObject({
      effectType: "checkpoint",
      status: "pending",
      resultInline: null,
    });
    expect(checkpointEvents(store)).toHaveLength(0);

    const resumed = await kernel(store, {
      onStepExecute: (key) => {
        if (key === "checkpoint.first") executions++;
      },
    }).resume<boolean>("run_0");

    expect(resumed.status).toBe("finished");
    expect(executions).toBe(2);
    expect(checkpointEvents(store)).toHaveLength(2);
    expect(store.getJournalRow("run_0", "checkpoint.first", 1)).toMatchObject({
      effectType: "checkpoint",
      status: "completed",
      attempt: 1,
    });
  });
});
