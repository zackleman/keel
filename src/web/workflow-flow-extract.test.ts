import { describe, expect, test } from "bun:test";
import { parseWorkflowSource } from "./workflow-flow-extract.ts";

describe("workflow flow extraction", () => {
  test("ignores ctx calls in helpers outside the default workflow entry", () => {
    const source = `
      function helper(ctx, input) {
        ctx.step("dead-helper", async () => input.dead ?? true);
      }

      export default async function workflow(ctx, input: { live: string }) {
        await ctx.step("live-step", async () => input.live);
      }
    `;

    const ir = parseWorkflowSource("entry-only.workflow.ts", source);

    expect(ir.operations.map((op) => op.key?.value)).toEqual(["live-step"]);
    expect(ir.input?.fields.map((field) => field.name)).toEqual(["live"]);
  });

  test("annotates literal Promise.all array elements as deterministic parallel lanes", () => {
    const source = `
      export default async function workflow(ctx) {
        await Promise.all([
          (async () => {
            await ctx.agent({ key: "proposal", prompt: "write proposal" });
            await ctx.human({ key: "approve-proposal", prompt: "approve proposal" });
            await ctx.step("proposal-approved", async () => true);
          })(),
          (async () => {
            await ctx.agent({ key: "review", prompt: "review proposal" });
            await ctx.human({ key: "approve-review", prompt: "approve review" });
            await ctx.step("review-approved", async () => true);
          })(),
        ]);
      }
    `;

    const ir = parseWorkflowSource("lane.workflow.ts", source);
    const keyed = ir.operations.map((op) => ({
      key: op.key?.value,
      kind: op.kind,
      parallelLane: op.parallelLane,
    }));

    expect(keyed).toEqual([
      { key: "proposal", kind: "agent", parallelLane: 0 },
      { key: "approve-proposal", kind: "human", parallelLane: 0 },
      { key: "proposal-approved", kind: "step", parallelLane: 0 },
      { key: "review", kind: "agent", parallelLane: 1 },
      { key: "approve-review", kind: "human", parallelLane: 1 },
      { key: "review-approved", kind: "step", parallelLane: 1 },
    ]);
  });

  test("captures the new ctx primitives inside a loop + branch with condition", () => {
    const source = `
      export default async function workflow(ctx, input: { items: string[] }) {
        const counters = ctx.state("counters");
        for (const item of input.items) {
          if (item) {
            await ctx.checkpoint({ key: "cp", message: "processing item" });
            await ctx.drainSignals("drain", "review");
            await counters.set({ key: "count", name: "processed", value: 1 });
            const child = await ctx.spawn("spawn", { workflow: "child@1", input: {} });
            await ctx.waitRun("wait", child);
          }
        }
      }
    `;

    const ir = parseWorkflowSource("ops.workflow.ts", source);
    const ops = ir.operations;

    expect(ops.map((op) => op.kind)).toEqual([
      "checkpoint",
      "drainSignals",
      "stateSet",
      "spawn",
      "waitRun",
    ]);
    // Every emitted op sees the enclosing loop + branch containers and the
    // branch condition, so loop/branch badges and condition labels work.
    for (const op of ops) {
      expect(op.containers).toEqual(["loop", "branch"]);
      expect(op.condition?.text).toBe("item");
    }

    const byKind = new Map(ops.map((op) => [op.kind, op]));
    expect(byKind.get("checkpoint")?.key?.value).toBe("cp");
    expect(byKind.get("checkpoint")?.message?.value).toBe("processing item");
    expect(byKind.get("drainSignals")?.key?.value).toBe("drain");
    expect(byKind.get("drainSignals")?.signalName?.value).toBe("review");
    expect(byKind.get("stateSet")?.key?.value).toBe("count");
    expect(byKind.get("stateSet")?.namespace?.value).toBe("counters");
    expect(byKind.get("stateSet")?.stateName?.value).toBe("processed");
    expect(byKind.get("spawn")?.key?.value).toBe("spawn");
    expect(byKind.get("spawn")?.workflowRef?.value).toBe("child@1");
    expect(byKind.get("waitRun")?.key?.value).toBe("wait");
  });

  test("does not emit nodes for pure state reads", () => {
    const source = `
      export default async function workflow(ctx) {
        const counters = ctx.state("counters");
        const current = counters.get("processed");
        const all = counters.snapshot();
        await counters.set({ key: "count", name: "processed", value: current ?? 0 });
      }
    `;

    const ir = parseWorkflowSource("state-reads.workflow.ts", source);

    expect(ir.operations.map((op) => op.kind)).toEqual(["stateSet"]);
  });

  test("leaves dynamic Promise.all fan-outs without lane metadata", () => {
    const source = `
      export default async function workflow(ctx) {
        await Promise.all(["a", "b"].map((name) => ctx.step(name, async () => name)));
      }
    `;

    const ir = parseWorkflowSource("map.workflow.ts", source);

    expect(ir.operations).toHaveLength(1);
    expect(ir.operations[0]?.containers).toContain("parallel");
    expect(ir.operations[0]?.parallelLane).toBeUndefined();
  });
});
