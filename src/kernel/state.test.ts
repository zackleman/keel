import { describe, expect, test } from "bun:test";
import { JournalStore } from "../journal/store.ts";
import { WorkflowCtx } from "./ctx.ts";

function ctx(store: JournalStore, fault?: ConstructorParameters<typeof WorkflowCtx>[2]["fault"]) {
  return new WorkflowCtx(store, "run_state", { clock: () => 1_000, rng: () => 0.5, fault });
}

describe("ctx.state strict-effect lifecycle", () => {
  test("folds writes synchronously with LWW and namespace isolation", async () => {
    const store = JournalStore.memory();
    const workflow = ctx(store);
    const first = workflow.state<{ value: number }>("first");
    const second = workflow.state<{ value: number }>("second");
    expect(first.get("value")).toBeUndefined();
    expect(first.snapshot()).toEqual({});
    await first.set({ key: "first.1", name: "value", value: 1 });
    await second.set({ key: "second.1", name: "value", value: 9 });
    await first.set({ key: "first.2", name: "value", value: 2 });
    expect(first.get("value")).toBe(2);
    expect(first.snapshot()).toEqual({ value: 2 });
    expect(second.snapshot()).toEqual({ value: 9 });
  });

  test("pending writes fail closed on changed identity and commit state atomically", async () => {
    const store = JournalStore.memory();
    const crashing = ctx(store, (point, key) => {
      if (point === "before-commit" && key === "write") throw new Error("CRASH");
    });
    await expect(
      crashing.state<{ value: number }>("test").set({ key: "write", name: "value", value: 1 }),
    ).rejects.toThrow("CRASH");
    expect(store.getJournalRow("run_state", "write", 1)).toMatchObject({
      status: "pending",
      effectType: "state_write",
    });
    expect(store.getRunState("run_state")).toEqual([]);

    const healthy = ctx(store);
    await expect(
      healthy.state<{ value: number }>("test").set({ key: "write", name: "value", value: 2 }),
    ).rejects.toThrow(/pending state_write "write" identity changed/);
    await healthy.state<{ value: number }>("test").set({ key: "write", name: "value", value: 1 });
    expect(store.getJournalRow("run_state", "write", 1)?.status).toBe("completed");
    expect(store.getRunState("run_state")).toEqual([
      expect.objectContaining({
        namespace: "test",
        name: "value",
        valueInline: "1",
        writtenKey: "write#1",
      }),
    ]);
  });

  test("replay-touch follows program order instead of journal insertion order", async () => {
    const store = JournalStore.memory();
    const firstPass = ctx(store).state<{ value: string }>("ordering");
    await firstPass.set({ key: "early", name: "value", value: "early-v1" });
    await firstPass.set({ key: "later", name: "value", value: "later" });

    const rerun = ctx(store).state<{ value: string }>("ordering");
    await rerun.set({ key: "early", name: "value", value: "early-v2" });
    await rerun.set({ key: "later", name: "value", value: "later" });

    expect(rerun.get("value")).toBe("later");
    expect(store.getRunState("run_state")[0]).toMatchObject({
      valueInline: JSON.stringify("later"),
      writtenKey: "later#1",
    });
    expect(store.getJournalRow("run_state", "early", 2)?.status).toBe("completed");
    expect(store.getJournalRow("run_state", "later", 2)).toBeNull();
  });

  test("large values borrow the journal artifact and survive GC", async () => {
    const store = JournalStore.memory();
    const value = "x".repeat(2_000);
    await ctx(store).state<{ value: string }>("large").set({ key: "large", name: "value", value });
    const row = store.getRunState("run_state")[0];
    expect(row?.valueInline).toBeNull();
    expect(row?.valueArtifact).toBe(store.getJournalRow("run_state", "large", 1)?.resultArtifact);
    expect(store.gcArtifacts()).toBe(0);
    expect(store.getArtifactData(row?.valueArtifact ?? "")).not.toBeNull();
  });

  test("rejects invalid namespaces, names, and set specs", async () => {
    const workflow = ctx(JournalStore.memory());
    expect(() => workflow.state("__reserved")).toThrow(/reserved/);
    expect(() => workflow.state("x".repeat(129))).toThrow(/at most 128/);
    const state = workflow.state<{ value: number }>("valid");
    await expect(
      state.set({ key: "write", name: "__reserved" as "value", value: 1 }),
    ).rejects.toThrow(/reserved/);
    await expect(state.set({ key: "", name: "value", value: 1 })).rejects.toThrow(/non-empty/);
  });
});
