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
        launchAuthorityJson: null,
        createdAtMs: 1,
        finishedAtMs: 2,
      };
      store.insertRun({ ...base, runId: "one-off", workflowRef: "client:test" });
      store.insertRun({ ...base, runId: "saved", workflowRef: "saved:review@1 wf_sha256_test" });
      store.insertRun({ ...base, runId: "live-workspace", workflowRef: "client:workspace" });
      store.db
        .query(
          `INSERT INTO agent_workspaces (
            run_id, workspace_id, mode, owner_kind, key, workspace_path,
            workspace_identity_json, workspace_identity_hash, owned, status,
            created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "live-workspace",
          "workspace-1",
          "worktree",
          "workflow",
          "workspace",
          "/tmp/workspace",
          "{}",
          "workspace-hash",
          1,
          "ready",
          1,
          1,
        );
      store.appendEvent("one-off", "run.finished", {}, 2);

      expect(store.pruneOneOffRuns({ nowMs: 100, ttlMs: 10 })).toBe(1);
      expect(store.getRun("one-off")).toBeNull();
      expect(store.listEvents("one-off")).toEqual([]);
      expect(store.getRun("saved")).not.toBeNull();
      expect(store.getRun("live-workspace")).not.toBeNull();
    } finally {
      store.close();
    }
  });

  test("prunes one-off parents with saved children and removes their capabilities", () => {
    const store = JournalStore.memory();
    try {
      const base = {
        workflowName: "workflow",
        definitionVersion: "wf_sha256_test",
        runTarget: "/tmp",
        status: "finished" as const,
        tenantId: null,
        inputRef: "null",
        outputRef: "null",
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        launchAuthorityJson: null,
        createdAtMs: 1,
        finishedAtMs: 2,
      };
      store.insertRun({
        ...base,
        runId: "one-off-parent",
        workflowRef: "client:parent",
        parentRunId: null,
      });
      store.insertRun({
        ...base,
        runId: "saved-child",
        workflowRef: "saved:child@1 wf_sha256_test",
        parentRunId: "one-off-parent",
      });
      store.putCapability({
        id: "cap-parent",
        secretHash: "secret-hash",
        resourceJson: JSON.stringify({ kind: "run", runId: "one-off-parent" }),
        actionsJson: JSON.stringify(["run:read"]),
        createdAtMs: 1,
        expiresAtMs: null,
        revokedAtMs: null,
        note: null,
      });

      expect(store.pruneOneOffRuns({ nowMs: 100, ttlMs: 10 })).toBe(1);
      expect(store.getRun("one-off-parent")).toBeNull();
      expect(store.getRun("saved-child")).not.toBeNull();
      expect(store.getCapabilityByHash("secret-hash")).toBeNull();
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
        launchAuthorityJson: null,
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
