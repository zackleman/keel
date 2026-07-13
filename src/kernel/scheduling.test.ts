// Phase 16: durable ctx.sleep (park/wake), supervisor wake after restart, cron.

import { describe, expect, test } from "bun:test";
import { JournalStore } from "../journal/store.ts";
import { captureWorkflowFile } from "../workflow-definitions/capture.ts";
import {
  WORKFLOW_SDK_ABI_VERSION,
  snapshotWorkflowSource,
} from "../workflow-definitions/snapshot.ts";
import { RealmKernel } from "./realm/realm-host.ts";
import { Supervisor } from "./supervisor.ts";

const napUrl = captureWorkflowFile(
  new URL("./realm/fixtures/nap.workflow.ts", import.meta.url).pathname,
);
const chainUrl = captureWorkflowFile(
  new URL("./realm/fixtures/chain.workflow.ts", import.meta.url).pathname,
);
const NEXT_WORKFLOW_SDK_ABI_VERSION = WORKFLOW_SDK_ABI_VERSION + 1;

describe("durable ctx.sleep park/wake", () => {
  test("a run parks at sleep and a supervisor tick wakes it to finish", async () => {
    const store = JournalStore.memory();
    let t = 0;
    const clock = () => t;
    const kernel = new RealmKernel(store, { idgen: () => "r", clock });

    const handle = await kernel.run<number>(napUrl, null, {
      name: "nap",
      target: process.cwd(),
    });
    expect(handle.status).toBe("waiting-timer"); // parked at sleep
    expect(store.getJournalRow("r", "before", 1)?.status).toBe("completed");
    expect(store.getJournalRow("r", "after", 1)).toBeNull(); // not reached yet

    // not due yet → supervisor does nothing
    t = 500;
    expect((await new Supervisor({ store, kernel, clock }).tick()).woken).toEqual([]);
    expect(store.getRun("r")?.status).toBe("waiting-timer");

    // timer due → supervisor wakes it; the run finishes
    t = 1500;
    const res = await new Supervisor({ store, kernel, clock }).tick();
    expect(res.woken).toEqual(["r"]);
    expect(store.getRun("r")?.status).toBe("finished");
    expect(JSON.parse(store.getRun("r")?.outputRef ?? "null")).toBe(2);
  });

  test("a due timer fires after a 'daemon restart' (fresh kernel + supervisor)", async () => {
    const store = JournalStore.memory();
    let t = 0;
    const clock = () => t;
    // park with one kernel…
    await new RealmKernel(store, { idgen: () => "r2", clock }).run(napUrl, null, {
      name: "nap",
      target: process.cwd(),
    });
    expect(store.getRun("r2")?.status).toBe("waiting-timer");

    // …a brand-new kernel + supervisor (simulating restart) reads the journaled
    // timer and wakes it. Nothing in memory carried over.
    t = 2000;
    const fresh = new RealmKernel(store, { idgen: () => "r2", clock });
    const res = await new Supervisor({ store, kernel: fresh, clock }).tick();
    expect(res.woken).toEqual(["r2"]);
    expect(store.getRun("r2")?.status).toBe("finished");
  });

  test("unsupported workflow SDK ABI fails a due timer run instead of retrying every tick", async () => {
    const store = JournalStore.memory();
    let t = 0;
    const clock = () => t;
    const kernel = new RealmKernel(store, { idgen: () => "r_abi", clock });

    await kernel.run(napUrl, null, { name: "nap", target: process.cwd() });
    expect(store.getRun("r_abi")?.status).toBe("waiting-timer");
    requireUnsupportedSdkAbi(store, store.getRun("r_abi")?.definitionVersion as string);

    t = 1500;
    const supervisor = new Supervisor({ store, kernel, clock });
    expect((await supervisor.tick()).woken).toEqual([]);
    const failed = store.getRun("r_abi");
    expect(failed?.status).toBe("failed");
    expect(JSON.parse(failed?.errorJson ?? "{}").message).toContain(
      `requires workflow SDK ABI ${NEXT_WORKFLOW_SDK_ABI_VERSION}, but this daemon supports ABI ${WORKFLOW_SDK_ABI_VERSION}`,
    );
    expect((await supervisor.tick()).woken).toEqual([]);
  });
});

describe("cron schedules", () => {
  test("a due schedule launches a run and advances to the next slot", async () => {
    const store = JournalStore.memory();
    const t = 1000;
    let n = 0;
    const kernel = new RealmKernel(store, { idgen: () => `cron-${n++}`, clock: () => t });
    const { snapshot } = snapshotWorkflowSource(store, chainUrl.source, {
      name: "hourly",
      nowMs: t,
    });
    store.putSchedule({
      name: "hourly",
      workflowRef: snapshot.hash,
      inputJson: JSON.stringify({ n: 2 }),
      scheduleTarget: process.cwd(),
      intervalMs: 3_600_000,
      nextFireMs: 500, // already due at t=1000
    });

    const res = await new Supervisor({
      store,
      kernel,
      clock: () => t,
      claim: (runId) => store.claimRun(runId, "daemon-A", 0, t),
    }).tick();
    expect(res.fired).toEqual(["hourly"]);
    const run = store.listRuns().find((r) => r.workflowName === "hourly");
    expect(run?.runtimeOwnerId).toBe("daemon-A");
    expect(run?.heartbeatAtMs).toBe(t);
    // advanced ~one interval forward, so not due again immediately
    const after = await new Supervisor({ store, kernel, clock: () => t }).tick();
    expect(after.fired).toEqual([]);
  });

  test("invalid persisted schedule target disables only the offending due schedule", async () => {
    const store = JournalStore.memory();
    const t = 1000;
    let n = 0;
    const kernel = new RealmKernel(store, { idgen: () => `cron-${n++}`, clock: () => t });
    const bad = snapshotWorkflowSource(store, "export default async () => 0;\n", {
      name: "bad-target",
      nowMs: t,
    }).snapshot.hash;
    const good = snapshotWorkflowSource(store, "export default async () => 1;\n", {
      name: "good-target",
      nowMs: t,
    }).snapshot.hash;
    store.putSchedule({
      name: "bad-target",
      workflowRef: bad,
      inputJson: "null",
      scheduleTarget: "   ",
      intervalMs: 60_000,
      nextFireMs: 500,
    });
    store.putSchedule({
      name: "good-target",
      workflowRef: good,
      inputJson: "null",
      scheduleTarget: process.cwd(),
      intervalMs: 60_000,
      nextFireMs: 500,
    });

    const res = await new Supervisor({ store, kernel, clock: () => t }).tick();
    expect(res.fired).toEqual(["good-target"]);
    const badSchedule = store.db
      .query<{ enabled: number; last_error_json: string | null }, []>(
        "SELECT enabled, last_error_json FROM schedules WHERE name = 'bad-target'",
      )
      .get();
    expect(badSchedule?.enabled).toBe(0);
    expect(JSON.parse(badSchedule?.last_error_json ?? "{}").message).toContain(
      "requires a non-empty target",
    );
    expect(store.listRuns().map((run) => run.workflowName)).toEqual(["good-target"]);
  });

  test("unsupported workflow SDK ABI disables only the offending due schedule", async () => {
    const store = JournalStore.memory();
    const t = 1000;
    let n = 0;
    const kernel = new RealmKernel(store, { idgen: () => `cron-${n++}`, clock: () => t });
    const bad = snapshotWorkflowSource(store, chainUrl.source, {
      name: "bad",
      nowMs: t,
    }).snapshot.hash;
    const good = snapshotWorkflowSource(store, "export default async () => 1;\n", {
      name: "good",
      nowMs: t,
    }).snapshot.hash;
    requireUnsupportedSdkAbi(store, bad);
    store.putSchedule({
      name: "bad",
      workflowRef: bad,
      inputJson: JSON.stringify({ n: 1 }),
      scheduleTarget: process.cwd(),
      intervalMs: 60_000,
      nextFireMs: 500,
    });
    store.putSchedule({
      name: "good",
      workflowRef: good,
      inputJson: "null",
      scheduleTarget: process.cwd(),
      intervalMs: 60_000,
      nextFireMs: 500,
    });

    const res = await new Supervisor({ store, kernel, clock: () => t }).tick();
    expect(res.fired).toEqual(["good"]);
    const badSchedule = store.db
      .query<{ enabled: number; last_error_json: string | null }, []>(
        "SELECT enabled, last_error_json FROM schedules WHERE name = 'bad'",
      )
      .get();
    expect(badSchedule?.enabled).toBe(0);
    expect(JSON.parse(badSchedule?.last_error_json ?? "{}").message).toContain(
      `requires workflow SDK ABI ${NEXT_WORKFLOW_SDK_ABI_VERSION}, but this daemon supports ABI ${WORKFLOW_SDK_ABI_VERSION}`,
    );
    expect(store.listRuns().map((run) => run.workflowName)).toEqual(["good"]);
  });
});

describe("unsupported SDK ABI direct lifecycle calls", () => {
  test("resume, retry, rewind, and rerun surface the ABI error before mutating run state", async () => {
    const store = JournalStore.memory();
    const kernel = new RealmKernel(store, { clock: () => 1000 });
    const { snapshot } = snapshotWorkflowSource(store, "export default async () => 1;\n", {
      name: "direct",
      nowMs: 1,
    });
    requireUnsupportedSdkAbi(store, snapshot.hash);
    insertLifecycleRun(store, "r_resume", snapshot.hash, "waiting-timer");
    insertLifecycleRun(store, "r_retry", snapshot.hash, "failed");
    insertLifecycleRun(store, "r_rewind", snapshot.hash, "failed");
    insertLifecycleRun(store, "r_rerun", snapshot.hash, "failed");
    store.putJournalRow({
      runId: "r_rewind",
      stableKey: "keep",
      effectType: "pure",
      status: "completed",
      version: "v",
      inputHash: "h",
      resultInline: "1",
    });

    await expect(kernel.resume("r_resume")).rejects.toThrow(
      `requires workflow SDK ABI ${NEXT_WORKFLOW_SDK_ABI_VERSION}`,
    );
    await expect(kernel.retry("r_retry")).rejects.toThrow(
      `requires workflow SDK ABI ${NEXT_WORKFLOW_SDK_ABI_VERSION}`,
    );
    await expect(kernel.rewind("r_rewind", "keep")).rejects.toThrow(
      `requires workflow SDK ABI ${NEXT_WORKFLOW_SDK_ABI_VERSION}`,
    );
    await expect(kernel.rerun("r_rerun")).rejects.toThrow(
      `requires workflow SDK ABI ${NEXT_WORKFLOW_SDK_ABI_VERSION}`,
    );

    expect(store.getRun("r_resume")?.status).toBe("waiting-timer");
    expect(store.getRun("r_retry")?.status).toBe("failed");
    expect(store.getRun("r_rewind")?.status).toBe("failed");
    expect(store.getRun("r_rerun")?.status).toBe("failed");
    store.close();
  });
});

function requireUnsupportedSdkAbi(store: JournalStore, hash: string): void {
  const row = store.getWorkflowDefinition(hash);
  if (!row?.manifestJson) throw new Error(`missing manifest for ${hash}`);
  const manifest = JSON.parse(row.manifestJson) as { runtime: { workflowSdkAbi: number } };
  manifest.runtime.workflowSdkAbi = NEXT_WORKFLOW_SDK_ABI_VERSION;
  store.db
    .query("UPDATE workflow_definitions SET manifest_json = ? WHERE hash = ?")
    .run(JSON.stringify(manifest), hash);
}

function insertLifecycleRun(
  store: JournalStore,
  runId: string,
  definitionVersion: string,
  status: "waiting-timer" | "failed",
): void {
  store.insertRun({
    runId,
    workflowName: "direct",
    definitionVersion,
    workflowRef: "stdin",
    status,
    parentRunId: null,
    tenantId: null,
    inputRef: "null",
    outputRef: null,
    errorJson: status === "failed" ? JSON.stringify({ name: "Error", message: "old" }) : null,
    heartbeatAtMs: null,
    runtimeOwnerId: null,
    launchAuthorityJson: null,
    createdAtMs: 1,
    finishedAtMs: status === "failed" ? 1 : null,
  });
}
