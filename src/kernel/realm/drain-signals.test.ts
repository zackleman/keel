import { describe, expect, test } from "bun:test";
import type {
  AgentHooks,
  AgentInvocation,
  AgentProvider,
  AgentResult,
} from "../../agents/types.ts";
import { AgentProviderRegistry } from "../../agents/types.ts";
import { JournalStore } from "../../journal/store.ts";
import { captureWorkflowFile } from "../../workflow-definitions/capture.ts";
import { RealmKernel } from "./realm-host.ts";

const drainOnce = {
  source: `
    import { type Ctx } from "@kcosr/keel";
    export default async function workflow(ctx: Ctx): Promise<unknown[]> {
      return await ctx.drainSignals("drain", "steer");
    }
  `,
  name: "drain-once",
};

const drainAfterStep = {
  source: `
    import { type Ctx, passthrough } from "@kcosr/keel";
    const value = passthrough<string>();
    export default async function workflow(ctx: Ctx): Promise<unknown[]> {
      await ctx.step("before", value, "ready", (input) => input);
      return await ctx.drainSignals("drain", "steer");
    }
  `,
  name: "drain-after-step",
};

const drainThenPark = {
  source: `
    import { type Ctx } from "@kcosr/keel";
    export default async function workflow(ctx: Ctx): Promise<unknown[][]> {
      const before = await ctx.drainSignals("steer:0", "steer");
      await ctx.signal("proceed");
      const after = await ctx.drainSignals("steer:1", "steer");
      return [before, after];
    }
  `,
  name: "drain-then-park",
};

const supervisedWorker = captureWorkflowFile(
  new URL("./fixtures/supervised-worker.workflow.ts", import.meta.url).pathname,
);

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

function pendingPayloads(store: JournalStore, name: string): unknown[] {
  return store.db
    .query<{ payload_ref: string | null }, [string, string]>(
      "SELECT payload_ref FROM signals WHERE run_id = ? AND name = ? AND consumed_key IS NULL ORDER BY seq",
    )
    .all("run_0", name)
    .map((row) => (row.payload_ref === null ? null : JSON.parse(row.payload_ref)));
}

class PromptRecordingProvider implements AgentProvider {
  readonly name = "session";
  readonly supportsSessions = true;
  readonly calls: AgentInvocation[] = [];

  async generate(invocation: AgentInvocation, hooks: AgentHooks): Promise<AgentResult> {
    this.calls.push(invocation);
    const token = invocation.resumeToken ?? "session-1";
    hooks.onSessionToken?.(token);
    return {
      text: JSON.stringify({ summary: `turn-${this.calls.length}` }),
      transcript: [],
      sessionToken: token,
    };
  }
}

describe("ctx.drainSignals", () => {
  test("returns an empty batch without parking when no signal is pending", async () => {
    const store = JournalStore.memory();

    const result = await kernel(store).run<unknown[]>(drainOnce, null, { target: process.cwd() });

    expect(result).toMatchObject({ status: "finished", output: [] });
    expect(store.getJournalRow("run_0", "drain", 1)).toMatchObject({
      effectType: "drain_signals",
      status: "completed",
      resultInline: "[]",
    });
  });

  test("drains every currently pending occurrence in FIFO delivery order", async () => {
    const store = JournalStore.memory();
    store.putSignal("run_0", "steer", { n: 1 }, 1);
    store.putSignal("run_0", "other", { ignored: true }, 2);
    store.putSignal("run_0", "steer", { n: 2 }, 3);

    const result = await kernel(store).run<Array<{ n: number }>>(drainOnce, null, {
      target: process.cwd(),
    });

    expect(result.output).toEqual([{ n: 1 }, { n: 2 }]);
    expect(pendingPayloads(store, "steer")).toEqual([]);
    expect(pendingPayloads(store, "other")).toEqual([{ ignored: true }]);
  });

  test("replay returns the recorded batch without consuming later arrivals", async () => {
    const store = JournalStore.memory();
    store.putSignal("run_0", "steer", "first", 1);

    const parked = await kernel(store).run(drainThenPark, null, { target: process.cwd() });
    expect(parked.status).toBe("waiting-signal");
    expect(store.getJournalRow("run_0", "steer:0", 1)?.resultInline).toBe('["first"]');

    store.putSignal("run_0", "steer", "later", 2);
    expect((await kernel(store).resume("run_0")).status).toBe("waiting-signal");

    expect(store.getJournalRow("run_0", "steer:0", 1)?.resultInline).toBe('["first"]');
    expect(pendingPayloads(store, "steer")).toEqual(["later"]);
  });

  test("a crash before completion leaves signals pending for the retried drain", async () => {
    const store = JournalStore.memory();
    store.putSignal("run_0", "steer", "one", 1);
    store.putSignal("run_0", "steer", "two", 2);

    await kernel(store, {
      fault: (point, key) => {
        if (point === "before-commit" && key === "drain") throw new Error("CRASH");
      },
    })
      .run(drainOnce, null, { target: process.cwd() })
      .catch(() => null);

    expect(store.getJournalRow("run_0", "drain", 1)).toMatchObject({
      effectType: "drain_signals",
      status: "pending",
      resultInline: null,
    });
    expect(pendingPayloads(store, "steer")).toEqual(["one", "two"]);

    store.putSignal("run_0", "steer", "three", 3);
    const resumed = await kernel(store).resume<string[]>("run_0");

    expect(resumed.output).toEqual(["one", "two", "three"]);
  });

  test("rewind restores signals consumed by discarded drain results", async () => {
    const store = JournalStore.memory();
    store.putSignal("run_0", "steer", "again", 1);
    const k = kernel(store);

    expect((await k.run<string[]>(drainAfterStep, null, { target: process.cwd() })).output).toEqual(
      ["again"],
    );

    const rewound = await k.rewind<string[]>("run_0", "before");

    expect(rewound.output).toEqual(["again"]);
  });

  test("interleaves with a parked ctx.signal on a different name", async () => {
    const store = JournalStore.memory();
    store.putSignal("run_0", "steer", "before", 1);

    const parked = await kernel(store).run(drainThenPark, null, { target: process.cwd() });
    expect(parked.status).toBe("waiting-signal");

    store.putSignal("run_0", "steer", "after", 2);
    store.putSignal("run_0", "proceed", true, 3);
    const resumed = await kernel(store).resume<string[][]>("run_0");

    expect(resumed).toMatchObject({
      status: "finished",
      output: [["before"], ["after"]],
    });
  });

  test("supervised loop drains steers into the next turn, checkpoints, then parks", async () => {
    const store = JournalStore.memory();
    const provider = new PromptRecordingProvider();
    const agents = new AgentProviderRegistry().register(provider);
    store.putSignal("run_0", "steer", { message: "focus on parser" }, 1);

    const parked = await kernel(store, { agents }).run(supervisedWorker, null, {
      target: process.cwd(),
    });

    expect(parked.status).toBe("waiting-signal");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.prompt).toContain('Steers: [{"message":"focus on parser"}]');
    expect(
      store.listJournalRows("run_0").filter((row) => row.effectType === "checkpoint"),
    ).toHaveLength(1);

    store.putSignal("run_0", "steer", { message: "add regression coverage" }, 2);
    store.putSignal("run_0", "next", true, 3);
    const resumed = await kernel(store, { agents }).resume("run_0");

    expect(resumed.status).toBe("finished");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]?.prompt).toContain('Steers: [{"message":"focus on parser"}]');
    expect(provider.calls[1]?.prompt).toContain('Steers: [{"message":"add regression coverage"}]');
    expect(
      store.listJournalRows("run_0").filter((row) => row.effectType === "checkpoint"),
    ).toHaveLength(2);
    expect(store.getJournalRow("run_0", "__session.worker.turn_0", 1)?.inputHash).not.toBe(
      store.getJournalRow("run_0", "__session.worker.turn_1", 1)?.inputHash,
    );
  });
});
