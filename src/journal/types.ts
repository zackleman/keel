// Journal row types (DESIGN.md §5.1, §8.1, Appendix A).
//
// These mirror the SQLite schema in schema.ts. Times are epoch milliseconds.
// Effectful results live either inline (<=1KB) or as an artifact reference
// (>1KB, Phase 8); for now both columns exist and inline is used.

export type EffectType =
  | "pure"
  | "effectful"
  | "command"
  | "completion_check"
  | "checkpoint"
  | "drain_signals"
  | "state_write"
  | "spawn"
  | "wait_run"
  | "workspace_setup"
  | "ambient";

export type JournalStatus = "pending" | "completed" | "failed";

export type RunStatus =
  | "running"
  | "waiting-human"
  | "waiting-signal"
  | "waiting-timer"
  | "waiting-approval"
  | "interrupted"
  | "finished"
  | "failed"
  | "cancelled"
  | "continued";

export interface RunRow {
  runId: string;
  workflowName: string | null;
  definitionVersion: string;
  /** Display-only workflow provenance. Execution uses definitionVersion. */
  workflowRef: string | null;
  /** Default daemon-resolvable target path inherited by agents in this run. */
  runTarget: string | null;
  status: RunStatus;
  parentRunId: string | null;
  tenantId: string | null;
  inputRef: string | null;
  outputRef: string | null;
  errorJson: string | null;
  heartbeatAtMs: number | null;
  runtimeOwnerId: string | null;
  createdAtMs: number;
  finishedAtMs: number | null;
}

export type NewRunRow = Omit<RunRow, "finishedAtMs" | "workflowRef" | "runTarget"> &
  Partial<Pick<RunRow, "finishedAtMs" | "workflowRef" | "runTarget">>;

/** A dependency edge: a prior step output this row's inputHash incorporated. */
export interface InputDep {
  stepKey: string;
  contentHash: string;
}

export interface JournalRow {
  runId: string;
  stableKey: string;
  attempt: number;
  effectType: EffectType;
  status: JournalStatus;
  version: string;
  inputHash: string;
  inputDeps: InputDep[] | null;
  keySetHash: string | null;
  /** Inline result JSON (<=1KB). Mutually exclusive with resultArtifact. */
  resultInline: string | null;
  /** Artifact hash for results >1KB (Phase 8). */
  resultArtifact: string | null;
  /** Vendor mid-call resume token (effectful agents, Phase 10). */
  sessionToken: string | null;
  errorJson: string | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
}

export interface StateRow {
  runId: string;
  namespace: string;
  name: string;
  valueInline: string | null;
  valueArtifact: string | null;
  writtenKey: string;
  updatedAtMs: number;
}

export interface AgentSessionRow {
  runId: string;
  agentKey: string;
  identityHash: string;
  identityJson: string;
  currentSessionToken: string | null;
  latestCompletedTurnKey: string | null;
  latestCompletedAttempt: number | null;
  activeTurnKey: string | null;
  activeTurnAttempt: number | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface AgentSessionTurnRow {
  runId: string;
  agentKey: string;
  turnKey: string;
  attempt: number;
  stableKey: string;
  status: JournalStatus;
  startedSessionToken: string | null;
  observedSessionToken: string | null;
  completedSessionToken: string | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
}

export type WorkspaceRetention = "remove" | "retain-on-failure" | "retain";

export type WorkspaceMode = "direct" | "worktree" | "copy" | "clone";
export type WorktreeCheckoutKind = "detached" | "branch";

export type WorkspaceSourceKind =
  | "direct-path"
  | "local-copy"
  | "worktree-git"
  | "local-clone-git"
  | "remote-git";

export type AgentWorkspaceOwnerKind = "workflow" | "agent" | "agent_session" | "command" | "setup";

export type AgentWorkspaceStatus =
  | "creating"
  | "active"
  | "idle"
  | "pending_review"
  | "merged"
  | "discarded"
  | "diff_error"
  | "abandoned"
  | "removed"
  | "cleanup_error";

export type WorkspaceSetupStatus = "none" | "pending" | "completed" | "failed";

export interface AgentWorkspaceRow {
  runId: string;
  workspaceId: string;
  mode: WorkspaceMode;
  ownerKind: AgentWorkspaceOwnerKind;
  key: string;
  lastAttempt: number | null;
  retentionPolicy: WorkspaceRetention | null;
  workspacePath: string;
  sourceKind: WorkspaceSourceKind | null;
  sourcePath: string | null;
  sourceUri: string | null;
  sourceBare: boolean | null;
  sourceMergeEligible: boolean;
  suppliedPath: string | null;
  sourceRef: string | null;
  resolvedRef: string | null;
  checkoutBranch: string | null;
  worktreeCheckoutKind: WorktreeCheckoutKind | null;
  worktreeBranchOwned: boolean;
  baseCommit: string | null;
  copyBaselinePath: string | null;
  creationErrorJson: string | null;
  workspaceIdentityJson: string;
  workspaceIdentityHash: string;
  setupIdentityJson: string | null;
  setupIdentityHash: string | null;
  setupStatus: WorkspaceSetupStatus;
  setupStartedAtMs: number | null;
  setupFinishedAtMs: number | null;
  setupErrorJson: string | null;
  owned: boolean;
  status: AgentWorkspaceStatus;
  failureSeen: boolean;
  lastTurnKey: string | null;
  lastTurnAttempt: number | null;
  activeHolderKind: AgentWorkspaceOwnerKind | null;
  activeHolderKey: string | null;
  activeHolderAttempt: number | null;
  activeStartedAtMs: number | null;
  lastDiffEventSeq: number | null;
  lastErrorEventSeq: number | null;
  cleanupErrorJson: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  mergedAtMs: number | null;
  discardedAtMs: number | null;
  removedAtMs: number | null;
}

export type NewJournalRow = Omit<
  JournalRow,
  | "attempt"
  | "inputDeps"
  | "keySetHash"
  | "resultInline"
  | "resultArtifact"
  | "sessionToken"
  | "errorJson"
  | "startedAtMs"
  | "finishedAtMs"
> &
  Partial<
    Pick<
      JournalRow,
      | "attempt"
      | "inputDeps"
      | "keySetHash"
      | "resultInline"
      | "resultArtifact"
      | "sessionToken"
      | "errorJson"
      | "startedAtMs"
      | "finishedAtMs"
    >
  >;

export interface EventRow {
  runId: string;
  seq: number;
  type: string;
  payloadJson: string;
  emittedAtMs: number;
}

export interface ArtifactRow {
  hash: string;
  byteLen: number;
  refCount: number;
  createdAtMs: number;
  data: Uint8Array | null;
}

export interface WorkflowDefinitionRow {
  hash: string;
  name: string | null;
  kind: string;
  code: string;
  sourceMap: string | null;
  manifestJson: string | null;
  createdAtMs: number;
}

export type NewWorkflowDefinitionRow = WorkflowDefinitionRow;

export interface ScheduleRow {
  name: string;
  workflowRef: string;
  inputJson: string | null;
  scheduleTarget: string | null;
  intervalMs: number;
  nextFireMs: number;
  enabled: boolean;
  lastRunId: string | null;
  lastErrorJson: string | null;
  lastFailedAtMs: number | null;
}

export interface SavedWorkflowRow {
  name: string;
  title: string | null;
  description: string | null;
  tagsJson: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  disabledAtMs: number | null;
  deletedAtMs: number | null;
}

export interface SavedWorkflowVersionRow {
  name: string;
  version: number;
  definitionHash: string;
  workflowName: string | null;
  inputSchemaJson: string | null;
  defaultInputJson: string | null;
  defaultTarget: string | null;
  metadataJson: string | null;
  sourceProvenanceJson: string | null;
  createdBy: string | null;
  createdAtMs: number;
  enabled: boolean;
  deprecatedAtMs: number | null;
  deprecationMessage: string | null;
  deletedAtMs: number | null;
}

export interface CapabilityRow {
  id: string;
  secretHash: string;
  resourceJson: string;
  actionsJson: string;
  createdAtMs: number;
  expiresAtMs: number | null;
  revokedAtMs: number | null;
  note: string | null;
}

export type NewCapabilityRow = CapabilityRow;

export type AgentProfileSource = "catalog" | "programmatic";

export interface AgentProfileCatalogRow {
  name: string;
  configJson: string;
  configHash: string;
  generation: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface DaemonSettingCatalogRow {
  key: string;
  valueJson: string;
  generation: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface RunProfileSnapshotSetRow {
  runId: string;
  catalogHash: string;
  capturedAtMs: number;
}

export interface RunProfileSnapshotRow {
  runId: string;
  name: string;
  source: AgentProfileSource;
  configJson: string;
  configHash: string;
  catalogGeneration: number | null;
  capturedAtMs: number;
}

export interface RunSettingSnapshotSetRow {
  runId: string;
  settingsHash: string;
  capturedAtMs: number;
}

export interface RunSettingSnapshotRow {
  runId: string;
  key: string;
  class: "workflow-visible" | "daemon-operational";
  valueJson: string;
  defaultJson: string;
  source: "catalog" | "default";
  catalogGeneration: number | null;
  capturedAtMs: number;
}
