// Phase 13: liveness — per-attempt stall timeout + stall-retry, StepTimeoutError,
// and the blockage diagnosis API.

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_AGENT_LENIENT,
  DEFAULT_AGENT_ON_FAILURE,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_SCHEMA_MAX_RETRIES,
  DEFAULT_STALL_RETRIES,
} from "../../agents/defaults.ts";
import { StepTimeoutError, runAgentWithStall } from "../../agents/execute.ts";
import { MockProvider } from "../../agents/mock.ts";
import { AgentProviderRegistry } from "../../agents/types.ts";
import { JournalStore } from "../../journal/store.ts";
import { buildProjection, buildRunReport, getBlockage } from "../../rpc/projection.ts";
import { captureWorkflowFile } from "../../workflow-definitions/capture.ts";
import { RealmKernel } from "./realm-host.ts";

const stallUrl = captureWorkflowFile(
  new URL("./fixtures/stall.workflow.ts", import.meta.url).pathname,
);

function kernel(store: JournalStore, mock: MockProvider, extra: Record<string, unknown> = {}) {
  return new RealmKernel(store, {
    idgen: () => "r",
    agents: new AgentProviderRegistry().register(mock),
    ...extra,
  });
}

describe("runAgentWithStall", () => {
  test("agent defaults are centralized", () => {
    expect(DEFAULT_AGENT_PROVIDER).toBe("pi");
    expect(DEFAULT_SCHEMA_MAX_RETRIES).toBe(2);
    expect(DEFAULT_AGENT_TIMEOUT_MS).toBe(60 * 60_000);
    expect(DEFAULT_STALL_RETRIES).toBe(1);
    expect(DEFAULT_AGENT_LENIENT).toBe(false);
    expect(DEFAULT_AGENT_ON_FAILURE).toBe("throw");
  });

  test("a stalled attempt is detected and retried, then succeeds", async () => {
    let attempt = 0;
    const stalls: number[] = [];
    const result = await runAgentWithStall(
      () => {
        const a = attempt++;
        // attempt 0 stalls (never resolves within timeout); attempt 1 is instant
        return a === 0
          ? new Promise(() => {})
          : Promise.resolve({
              output: { value: 1 },
              text: '{"value":1}',
              transcript: [],
              attempts: 1,
            });
      },
      { timeoutMs: 50, stallRetries: 2, onStall: (n) => stalls.push(n) },
    );
    expect(result.output).toEqual({ value: 1 });
    expect(stalls).toEqual([0]); // one stall detected on attempt 0
  });

  test("a perpetual stall throws StepTimeoutError after the retries", async () => {
    await expect(
      runAgentWithStall(() => new Promise(() => {}), { timeoutMs: 40, stallRetries: 1 }),
    ).rejects.toBeInstanceOf(StepTimeoutError);
  });
});

describe("ctx.agent stall-retry through the realm", () => {
  test("a stalling agent is detected, retried, and completes", async () => {
    const store = JournalStore.memory();
    // first call stalls (delay 5s >> 150ms timeout); second call is instant valid
    const mock = new MockProvider({
      responses: { slow: { outputs: ['{"value":7}', '{"value":7}'], delayMs: 5000 } },
    });
    // make only the FIRST generate slow: delayMs applies to every call, so instead
    // script two responses where attempt 0 is slow via a wrapper.
    let calls = 0;
    const wrapped = new Proxy(mock, {
      get(t, p) {
        if (p === "generate") {
          return async (...a: Parameters<typeof t.generate>) => {
            const n = calls++;
            if (n === 0) await Bun.sleep(5000); // stall the first attempt
            return { text: '{"value":7}', transcript: [] };
          };
        }
        return Reflect.get(t, p);
      },
    });
    const handle = await kernel(store, wrapped as MockProvider).run<{ value: number }>(
      stallUrl,
      {},
      { name: "stall", target: process.cwd() },
    );
    expect(handle.status).toBe("finished");
    expect(handle.output).toEqual({ value: 7 });
    // an agent.stalled event was emitted
    const stalled = store.listEvents("r").some((e) => e.type === "agent.stalled");
    expect(stalled).toBe(true);
  }, 20000);

  test("a perpetual stall fails the run with StepTimeoutError (unless tolerated)", async () => {
    const store = JournalStore.memory();
    const mock = new MockProvider({
      responses: { slow: { outputs: ['{"value":1}'], delayMs: 5000 } },
    });
    await expect(
      kernel(store, mock).run(stallUrl, {}, { name: "stall", target: process.cwd() }),
    ).rejects.toThrow(/stalled past/);
    expect(store.getRun("r")?.status).toBe("failed");
  }, 20000);

  test("a perpetual stall with onFailure:null is tolerated as null", async () => {
    const store = JournalStore.memory();
    const mock = new MockProvider({
      responses: { slow: { outputs: ['{"value":1}'], delayMs: 5000 } },
    });
    const handle = await kernel(store, mock).run<{ value: number } | null>(
      stallUrl,
      { onFailure: "null" },
      { name: "stall", target: process.cwd() },
    );
    expect(handle.status).toBe("finished");
    expect(handle.output).toBeNull();
  }, 20000);
});

describe("getBlockage", () => {
  function seedRun(
    store: JournalStore,
    status: string,
    opts: { heartbeatAtMs?: number | null; runtimeOwnerId?: string | null } = {},
  ) {
    store.insertRun({
      runId: "r",
      workflowName: "w",
      definitionVersion: "v0",
      status: status as never,
      parentRunId: null,
      tenantId: null,
      inputRef: "null",
      outputRef: null,
      errorJson: null,
      heartbeatAtMs: opts.heartbeatAtMs ?? null,
      runtimeOwnerId: opts.runtimeOwnerId ?? null,
      launchAuthorityJson: null,
      createdAtMs: 0,
    });
  }

  function seedPendingStep(store: JournalStore, startedAtMs: number) {
    store.putJournalRow({
      runId: "r",
      stableKey: "verify:x",
      effectType: "effectful",
      status: "pending",
      version: "v",
      inputHash: "h",
      startedAtMs,
    });
  }

  test("fresh owner heartbeat plus an old pending step reads as running and report omits blockage", () => {
    const store = JournalStore.memory();
    seedRun(store, "running", { runtimeOwnerId: "daemon_a", heartbeatAtMs: 39_000 });
    seedPendingStep(store, 1_000);

    expect(getBlockage(store, "r", 41_000, 30_000)).toMatchObject({
      reason: "running",
      blockedOn: null,
    });
    expect(
      buildRunReport(store, "r", { nowMs: 41_000, ownerStaleWindowMs: 30_000 })?.blockage,
    ).toBe(undefined);
    expect(buildProjection(store, "r")?.nodes[0]).toMatchObject({ startedAtMs: 1_000 });
    expect(
      buildRunReport(store, "r", { nowMs: 41_000, ownerStaleWindowMs: 30_000 })?.nodes[0],
    ).toMatchObject({ startedAtMs: 1_000 });
  });

  test("unowned in-process running runs read as running even with old pending work", () => {
    const store = JournalStore.memory();
    seedRun(store, "running");
    seedPendingStep(store, 1_000);

    expect(getBlockage(store, "r", 41_000, 30_000)).toMatchObject({
      reason: "running",
      blockedOn: null,
    });
  });

  test("stale owned heartbeat reports stalled_no_heartbeat without blaming a step", () => {
    const store = JournalStore.memory();
    seedRun(store, "running", { runtimeOwnerId: "daemon_a", heartbeatAtMs: 1_000 });
    seedPendingStep(store, 1_000);

    const b = getBlockage(store, "r", 41_000, 30_000);
    expect(b.reason).toBe("stalled_no_heartbeat");
    expect(b.blockedOn).toBeNull();
    expect(b.context).toContain("daemon_a");
    expect(b.context).toContain("stale by 10000ms");
  });

  test("owned running run with null heartbeat is stale owner state", () => {
    const store = JournalStore.memory();
    seedRun(store, "running", { runtimeOwnerId: "daemon_a", heartbeatAtMs: null });

    const b = getBlockage(store, "r", 1_000, 30_000);
    expect(b.reason).toBe("stalled_no_heartbeat");
    expect(b.blockedOn).toBeNull();
    expect(b.context).toContain("has no heartbeat");
  });

  test("running owner heartbeat can be diagnosed without pending journal rows", () => {
    const store = JournalStore.memory();
    seedRun(store, "running", { runtimeOwnerId: "daemon_a", heartbeatAtMs: 39_000 });

    expect(getBlockage(store, "r", 41_000, 30_000).reason).toBe("running");
  });

  test("report-embedded blockage uses the supplied owner stale window", () => {
    const store = JournalStore.memory();
    seedRun(store, "running", { runtimeOwnerId: "daemon_a", heartbeatAtMs: 1_000 });

    const standalone = getBlockage(store, "r", 12_000, 10_000);
    const report = buildRunReport(store, "r", { nowMs: 12_000, ownerStaleWindowMs: 10_000 });

    expect(standalone.reason).toBe("stalled_no_heartbeat");
    expect(report?.blockage?.reason).toBe(standalone.reason);
    expect(report?.blockage?.context).toBe(standalone.context);
  });

  test("waiting-human maps to waiting_human; terminal maps to none", () => {
    const s1 = JournalStore.memory();
    seedRun(s1, "waiting-human");
    s1.requestApproval("r", "approve-deploy", { prompt: "Deploy?" }, 1_234);
    expect(getBlockage(s1, "r", 1)).toMatchObject({
      reason: "waiting_human",
      blockedOn: { stableKey: "approve-deploy", since: 1_234 },
    });
    const s2 = JournalStore.memory();
    seedRun(s2, "finished");
    expect(getBlockage(s2, "r", 1).reason).toBe("none");
  });
});
