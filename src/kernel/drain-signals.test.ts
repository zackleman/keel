import { describe, expect, test } from "bun:test";
import { JournalStore } from "../journal/store.ts";
import { WorkflowCtx } from "./ctx.ts";

describe("ctx.drainSignals strict-effect lifecycle", () => {
  test("a pending drain retries only with the same signal-name identity", async () => {
    const store = JournalStore.memory();
    store.putSignal("run_1", "steer", "queued", 1);
    const crashing = new WorkflowCtx(store, "run_1", {
      clock: () => 1_000,
      rng: () => 0.5,
      fault: (point, key) => {
        if (point === "before-commit" && key === "drain") throw new Error("CRASH");
      },
    });

    await expect(crashing.drainSignals("drain", "steer")).rejects.toThrow("CRASH");
    expect(store.getJournalRow("run_1", "drain", 1)).toMatchObject({
      effectType: "drain_signals",
      status: "pending",
    });

    const healthy = new WorkflowCtx(store, "run_1", {
      clock: () => 2_000,
      rng: () => 0.5,
    });
    await expect(healthy.drainSignals("drain", "other")).rejects.toThrow(
      /pending drain_signals "drain" identity changed/,
    );

    await expect(healthy.drainSignals("drain", "steer")).resolves.toEqual(["queued"]);
  });
});
