import { describe, expect, test } from "bun:test";
import { JournalStore } from "./store.ts";

describe("one-off run retention", () => {
  test("prunes expired terminal one-offs while saved runs remain", () => {
    const store = JournalStore.memory();
    try {
      const base = {
        workflowName: "workflow",
        definitionVersion: "wf_sha256_test",
        runTarget: "/tmp",
        status: "finished" as const,
        parentRunId: null,
        tenantId: null,
        inputRef: "null",
        outputRef: "null",
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        createdAtMs: 1,
        finishedAtMs: 2,
      };
      store.insertRun({ ...base, runId: "one-off", workflowRef: "client:test" });
      store.insertRun({ ...base, runId: "saved", workflowRef: "saved:review@1 wf_sha256_test" });
      store.appendEvent("one-off", "run.finished", {}, 2);

      expect(store.pruneOneOffRuns({ nowMs: 100, ttlMs: 10 })).toBe(1);
      expect(store.getRun("one-off")).toBeNull();
      expect(store.listEvents("one-off")).toEqual([]);
      expect(store.getRun("saved")).not.toBeNull();
    } finally {
      store.close();
    }
  });

  test("does not prune runs before the default retention cutoff", () => {
    const store = JournalStore.memory();
    try {
      store.insertRun({
        runId: "recent",
        workflowName: null,
        definitionVersion: "wf_sha256_recent",
        workflowRef: null,
        runTarget: "/tmp",
        status: "failed",
        parentRunId: null,
        tenantId: null,
        inputRef: "null",
        outputRef: null,
        errorJson: "{}",
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        createdAtMs: 90,
        finishedAtMs: 95,
      });
      expect(store.pruneOneOffRuns({ nowMs: 100, ttlMs: 10 })).toBe(0);
      expect(store.getRun("recent")).not.toBeNull();
    } finally {
      store.close();
    }
  });
});
