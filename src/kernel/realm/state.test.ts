import { describe, expect, test } from "bun:test";
import { JournalStore } from "../../journal/store.ts";
import { buildProjection, buildRunState } from "../../rpc/projection.ts";
import { captureWorkflowFile } from "../../workflow-definitions/capture.ts";
import { RealmKernel } from "./realm-host.ts";

const workflow = captureWorkflowFile(
  new URL("./fixtures/state.workflow.ts", import.meta.url).pathname,
);
const TARGET = process.cwd();

function kernel(store: JournalStore, extra: ConstructorParameters<typeof RealmKernel>[1] = {}) {
  return new RealmKernel(store, { idgen: () => "run_state", clock: () => 1_000, ...extra });
}

const expected = {
  before: null,
  research: { count: 3, history: [1, 2, 3] },
  auxiliary: { count: 99 },
};

describe("ctx.state realm integration", () => {
  test("replays a crashed loop without new rows and rebuilds the materialized snapshot", async () => {
    const store = JournalStore.memory();
    await kernel(store, {
      fault: (point, key) => {
        if (point === "before-commit" && key === "state.history:3") throw new Error("CRASH");
      },
    })
      .run(workflow, null, { target: TARGET })
      .catch(() => null);

    const rowsBefore = store.listJournalRows("run_state").length;
    expect(store.getJournalRow("run_state", "state.history:3", 1)?.status).toBe("pending");
    store.db.query("DELETE FROM state WHERE run_id = ?").run("run_state");

    const resumed = await kernel(store).resume("run_state");
    expect(resumed).toMatchObject({ status: "finished", output: expected });
    expect(store.listJournalRows("run_state")).toHaveLength(rowsBefore);
    expect(buildRunState(store, "run_state")).toEqual({
      auxiliary: { count: 99 },
      research: { count: 3, history: [1, 2, 3] },
    });
    expect(buildProjection(store, "run_state")).toMatchObject({
      state: { auxiliary: { count: 99 }, research: { count: 3, history: [1, 2, 3] } },
      nodes: expect.arrayContaining([
        expect.objectContaining({ stableKey: "state.count.init", effectType: "state_write" }),
        expect.objectContaining({ stableKey: "state.history:3", effectType: "state_write" }),
      ]),
    });
  });

  test("rewind deletes state and replay-touch rematerializes it", async () => {
    const store = JournalStore.memory();
    const k = kernel(store);
    expect((await k.run(workflow, null, { target: TARGET })).output).toEqual(expected);

    const rewound = await k.rewind("run_state", "state.count:1");
    expect(rewound.output).toEqual(expected);
    expect(buildRunState(store, "run_state")).toEqual({
      auxiliary: { count: 99 },
      research: { count: 3, history: [1, 2, 3] },
    });
  });

  test("fork copies no materialized state and rebuilds it on first resume", async () => {
    const store = JournalStore.memory();
    const k = kernel(store);
    await k.run(workflow, null, { target: TARGET });
    const source = buildRunState(store, "run_state");

    expect(k.fork("run_state", { newRunId: "run_fork" })).toBe("run_fork");
    expect(store.getRunState("run_fork")).toEqual([]);
    expect((await k.resume("run_fork")).output).toEqual(expected);
    expect(buildRunState(store, "run_fork")).toEqual(source);
    expect(buildRunState(store, "run_state")).toEqual(source);
  });
});
