import type { AgentConcurrencyWaitSnapshot } from "../agents/concurrency";
import type { Json } from "../hash";
import type { EffectType, JournalStatus, RunStatus } from "../journal/types";

export type { AgentConcurrencyWaitSnapshot };
export type { EffectType, JournalStatus, RunStatus };

export interface NodeView {
  stableKey: string;
  effectType: EffectType;
  status: JournalStatus;
  attempt: number;
  /** Durable journal row start time. Surfaces derive pending age from their own clock. */
  startedAtMs: number | null;
  /** Dependency edges recorded during execution. */
  dependsOn: string[];
  /** True if the result is stored as an artifact rather than inline. */
  artifactBacked: boolean;
  /** Durable progress payload for completed checkpoint nodes. */
  checkpoint: { message: string; data: Json } | null;
}

export interface RunStats {
  steps: number;
  agents: number;
  checkpointCount: number;
  artifacts: number;
}

export interface RunSummary {
  runId: string;
  workflowName: string | null;
  status: RunStatus;
  runTarget?: string | null;
  createdAtMs: number;
  finishedAtMs: number | null;
  parentRunId: string | null;
}

export interface RunSummaryPage {
  runs: RunSummary[];
  total: number;
}

export interface RunProjection extends RunSummary {
  definitionVersion: string;
  nodes: NodeView[];
  /** The current phase, if any. */
  phase: string | null;
  error: { name: string; message: string } | null;
  stats: RunStats;
}

export interface ReportNodeView extends NodeView {
  result?: unknown;
  resultOmitted?: true;
  resultByteLength?: number;
}

export interface RunReport {
  runId: string;
  workflowName: string | null;
  status: RunStatus;
  createdAtMs: number;
  finishedAtMs: number | null;
  output?: unknown;
  outputOmitted?: true;
  outputByteLength?: number;
  error: { name: string; message: string } | null;
  blockage?: Blockage;
  nodes: ReportNodeView[];
  stats: RunStats;
}

export type BlockageReason =
  | "none"
  | "running"
  | "agent_concurrency"
  | "stalled_no_heartbeat"
  | "waiting_human"
  | "waiting_signal"
  | "waiting_timer"
  | "waiting_child"
  | "interrupted";

export interface InterruptionBlockageDetails {
  reason?: string;
  previousStatus: string;
  phase: string | null;
  wait: { kind?: string; key?: string; until?: number } | null;
}

export interface Blockage {
  reason: BlockageReason;
  blockedOn: { stableKey: string; since: number } | null;
  context: string;
  interrupted?: InterruptionBlockageDetails;
  agentConcurrency?: AgentConcurrencyWaitSnapshot;
}

export type ScheduleErrorProjection =
  | { kind: "none" }
  | { kind: "error"; error: { name?: string; message: string } }
  | { kind: "parse-error"; raw: string; message: string };

export interface ScheduleSummary {
  name: string;
  enabled: boolean;
  workflowRef: string;
  definitionState: "available" | "missing";
  workflowName: string | null;
  workflowKind: string | null;
  target: string | null;
  intervalMs: number;
  nextFireMs: number;
  lastRunId: string | null;
  lastRunStatus: RunStatus | null;
  lastFailedAtMs: number | null;
  lastError: ScheduleErrorProjection;
}

export interface ScheduleView extends ScheduleSummary {
  input: unknown;
  inputJson: string | null;
  source?: WorkflowDefinitionSourceView | null;
}

export type WorkflowDefinitionSourceLookup =
  | { kind: "run"; runId: string }
  | { kind: "definition"; definitionHash: string };

export interface WorkflowDefinitionSourceView {
  kind: "workflow-definition-source";
  lookup: WorkflowDefinitionSourceLookup;
  definitionHash: string;
  definitionName: string | null;
  createdAtMs: number;
  entry: string;
  files: Array<{ path: string; code: string; entry: boolean }>;
}

export interface EventCursor {
  kind: "after-seq";
  runId: string;
  seq: number;
}

export type EventCursorInput =
  | { kind: "beginning" }
  | { kind: "after-seq"; seq: number }
  | { kind: "tail"; count: number }
  | { kind: "now" };

export interface DurableEventEnvelope {
  kind: "durable";
  seq: number;
  type: string;
  payload: unknown;
  atMs: number;
}

export interface EphemeralEventEnvelope {
  kind: "ephemeral";
  type: string;
  payload: unknown;
  atMs: number;
}

export type EventEnvelope = DurableEventEnvelope | EphemeralEventEnvelope;

export type StreamControlFrame =
  | { kind: "control"; type: "caught-up"; cursor: EventCursor }
  | { kind: "control"; type: "closed"; cursor: EventCursor; status: string }
  | {
      kind: "control";
      type: "authorization.failed";
      cursor: EventCursor;
      payload: { message: string };
    };

export type EventStreamFrame = EventEnvelope | StreamControlFrame;

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  output?: unknown;
  error?: { name: string; message: string } | null;
}

export interface RunStart {
  runId: string;
  status: RunStatus;
  attachCursor: EventCursor;
}

export interface InterruptRunResult {
  runId: string;
  status: "interrupted";
}

export interface RunLaunchResult {
  runId: string;
  attachCursor: EventCursor;
  capability?: string;
  capabilityId?: string;
}

export interface RunWorkspaceView {
  runId: string;
  workspaceId: string;
  mode: "direct" | "worktree" | "copy" | "clone";
  ownerKind: "workflow" | "agent" | "agent_session" | "command" | "setup";
  key: string;
  lastAttempt: number | null;
  retentionPolicy: "remove" | "retain-on-failure" | "retain" | null;
  workspacePath: string;
  setupStatus: "none" | "pending" | "completed" | "failed";
  setupIdentityHash: string | null;
  setupStartedAtMs: number | null;
  setupFinishedAtMs: number | null;
  setupError: unknown | null;
  sourceKind:
    | "direct-path"
    | "local-copy"
    | "worktree-git"
    | "local-clone-git"
    | "remote-git"
    | null;
  sourcePath: string | null;
  sourceUri: string | null;
  sourceBare: boolean | null;
  sourceMergeEligible: boolean;
  suppliedPath: string | null;
  sourceRef: string | null;
  resolvedRef: string | null;
  checkoutBranch: string | null;
  worktreeCheckoutKind?: "detached" | "branch" | null;
  worktreeBranchOwned?: boolean;
  baseCommit: string | null;
  copyBaselinePath: string | null;
  owned: boolean;
  status: string;
  failureSeen: boolean;
  lastTurnKey: string | null;
  lastTurnAttempt: number | null;
  activeHolderKind: "workflow" | "agent" | "agent_session" | "command" | "setup" | null;
  activeHolderKey: string | null;
  activeHolderAttempt: number | null;
  activeStartedAtMs: number | null;
  lastDiffEventSeq: number | null;
  lastErrorEventSeq: number | null;
  cleanupError: unknown | null;
  mergeSupported: boolean;
  discardSupported: boolean;
  diffSupported: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  mergedAtMs: number | null;
  discardedAtMs: number | null;
  removedAtMs: number | null;
}

export interface RunWorkspaceDiff {
  workspace: RunWorkspaceView;
  modified: string[];
  added: string[];
  deleted: string[];
  omittedPathCounts: {
    modified: number;
    added: number;
    deleted: number;
  };
  pathLimit: number;
  contentDiff: string;
  mode: "worktree" | "copy" | "clone";
  diffKind: "git-patch" | "recursive-copy";
  baseLabel: string;
  workspaceLabel: string;
  fileChanges: Array<{
    path: string;
    status: "added" | "modified" | "deleted" | "type_changed";
    oldMode?: string | null;
    newMode?: string | null;
    oldSymlinkTarget?: string | null;
    newSymlinkTarget?: string | null;
    binary?: boolean;
    textDiffIncluded?: boolean;
  }>;
}

export interface WorkspaceGcResult {
  removed: RunWorkspaceView[];
}
