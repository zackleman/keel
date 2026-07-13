import { describe, expect, test } from "bun:test";
import { JournalStore } from "../journal/store.ts";
import { workspaceIdentity } from "../workspace/identity.ts";
import { failRunWithError } from "./run-errors.ts";

describe("failRunWithError", () => {
  test("applies workspace retention cleanup for terminal failures", () => {
    const store = JournalStore.memory();
    try {
      const identity = workspaceIdentity({
        key: "agent",
        mode: "worktree",
        sourcePath: "/tmp/keel-missing-repo-for-run-error-test",
        sourceRef: "HEAD",
        retentionPolicy: "remove",
        branchPolicy: "detached",
        sdkAbiVersion: 6,
      });
      store.insertRun({
        runId: "r",
        workflowName: "wf",
        definitionVersion: "v",
        status: "running",
        parentRunId: null,
        tenantId: null,
        inputRef: null,
        outputRef: null,
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        launchAuthorityJson: null,
        createdAtMs: 1,
      });
      store.insertAgentWorkspace({
        runId: "r",
        workspaceId: "ws_agent",
        mode: "worktree",
        ownerKind: "agent",
        key: "agent",
        lastAttempt: 1,
        retentionPolicy: "remove",
        workspacePath: "/tmp/keel-missing-workspace-for-run-error-test",
        sourcePath: "/tmp/keel-missing-repo-for-run-error-test",
        suppliedPath: null,
        sourceRef: "HEAD",
        baseCommit: "abc",
        workspaceIdentityJson: identity.json,
        workspaceIdentityHash: identity.hash,
        owned: true,
        status: "idle",
        failureSeen: false,
        lastTurnKey: null,
        lastTurnAttempt: null,
        activeHolderKind: null,
        activeHolderKey: null,
        activeHolderAttempt: null,
        activeStartedAtMs: null,
        lastDiffEventSeq: null,
        lastErrorEventSeq: null,
        cleanupErrorJson: null,
        createdAtMs: 1,
        updatedAtMs: 1,
        mergedAtMs: null,
        discardedAtMs: null,
        removedAtMs: null,
      });

      failRunWithError(store, "r", new Error("boom"), 10);

      expect(store.getRun("r")?.status).toBe("failed");
      expect(store.getAgentWorkspace("r", "ws_agent")?.status).toBe("removed");
      expect(store.listEvents("r").map((event) => event.type)).toEqual([
        "run.failed",
        "workspace.removed",
      ]);
    } finally {
      store.close();
    }
  });
});
