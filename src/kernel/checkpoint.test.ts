import { describe, expect, test } from "bun:test";
import { JournalStore } from "../journal/store.ts";
import { WorkflowCtx } from "./ctx.ts";

describe("checkpoint strict-effect lifecycle", () => {
  test("pending checkpoints re-execute only with the same identity", async () => {
    const store = JournalStore.memory();
    const crashing = new WorkflowCtx(store, "run_1", {
      clock: () => 1_000,
      rng: () => 0.5,
      fault: (point, key) => {
        if (point === "after-pending" && key === "progress") throw new Error("CRASH");
      },
    });

    await expect(
      crashing.checkpoint({ key: "progress", message: "one", data: { value: 1 } }),
    ).rejects.toThrow("CRASH");
    expect(store.getJournalRow("run_1", "progress", 1)).toMatchObject({
      effectType: "checkpoint",
      status: "pending",
      attempt: 1,
    });

    const healthy = new WorkflowCtx(store, "run_1", {
      clock: () => 2_000,
      rng: () => 0.5,
    });
    await expect(
      healthy.checkpoint({ key: "progress", message: "changed", data: { value: 1 } }),
    ).rejects.toThrow(/pending checkpoint "progress" identity changed/);

    await healthy.checkpoint({ key: "progress", message: "one", data: { value: 1 } });

    expect(store.getJournalRow("run_1", "progress", 1)).toMatchObject({
      effectType: "checkpoint",
      status: "completed",
      attempt: 1,
    });
    expect(store.listEvents("run_1").filter((event) => event.type === "checkpoint")).toHaveLength(
      1,
    );
  });
});
