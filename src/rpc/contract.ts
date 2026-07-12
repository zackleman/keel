// The Keel RPC wire contract (DESIGN.md §6.2, §7.3) — FROZEN as of Phase 11.
//
// Every client (CLI, web, MCP, SDK) speaks exactly this. In Phase 11 it runs over
// an in-process transport; the Phase 12 daemon implements the SAME interface over
// a Unix socket, so the extraction is a transport swap, not a redesign. Adding
// methods is allowed; changing an existing method's shape is a breaking change.

import type {
  AgentProfileCheckResult,
  AgentProfileSource,
  AgentProfileView,
  PersistentAgentProfileConfig,
} from "../agents/profiles.ts";
import type {
  SavedWorkflowSummary,
  SavedWorkflowVersionView,
  SavedWorkflowView,
} from "../journal/store.ts";
import type { SettingClass, SettingView, SettingsDiagnostic } from "../settings/catalog.ts";
import type { WorkflowSourceInput } from "../workflow-definitions/source.ts";
import type {
  Blockage,
  EventCursor,
  EventCursorInput,
  EventEnvelope,
  EventStreamFrame,
  InterruptRunResult,
  RunLaunchResult,
  RunOutcome,
  RunProjection,
  RunReport,
  RunStart,
  RunStateSnapshot,
  RunSummary,
  RunSummaryPage,
  RunWorkspaceDiff,
  RunWorkspaceView,
  ScheduleErrorProjection,
  ScheduleSummary,
  ScheduleView,
  StreamControlFrame,
  WorkflowDefinitionSourceLookup,
  WorkflowDefinitionSourceView,
  WorkspaceGcResult,
} from "./view-contract.ts";

export type WorkflowProvenance = { kind: "stdin" } | { kind: "clientPath"; path: string };
export type RunSecrets = Record<string, string>;

export interface LaunchRequest {
  /** Workflow TypeScript captured by the client. The daemon never reads client paths. */
  source: WorkflowSourceInput;
  input: unknown;
  /** Daemon-resolvable default target inherited by agents in this run. */
  target?: string;
  /** Optional display label; absent/null is stored as an unnamed run. */
  name?: string | null;
  /** Display-only provenance. It is never opened or parsed for execution. */
  provenance?: WorkflowProvenance;
  /** Trusted-local secret values for this run. Keel never persists these values. */
  runSecrets?: RunSecrets;
}

export interface SaveWorkflowRequest {
  name: string;
  source: WorkflowSourceInput;
  workflowName?: string | null;
  provenance?: WorkflowProvenance;
  title?: string | null;
  description?: string | null;
  tags?: string[];
  inputSchema?: unknown;
  defaultInput?: unknown;
  defaultTarget?: string | null;
  metadata?: unknown;
  version?: number;
  allowDuplicateDefinition?: boolean;
}

export interface PreviewWorkflowDefinitionRequest {
  source: WorkflowSourceInput;
}

export interface PreviewWorkflowDefinitionResult {
  definitionHash: string;
}

export interface SavedWorkflowRef {
  name: string;
  version?: number | "latest";
  allowDeprecated?: boolean;
}

export interface LaunchSavedWorkflowRequest {
  ref: SavedWorkflowRef;
  input?: unknown;
  target?: string;
  name?: string | null;
  runSecrets?: RunSecrets;
}

export interface SavedWorkflowSourceView {
  name: string;
  version: number;
  definitionHash: string;
  entry: string;
  files: Array<{ path: string; code: string; entry: boolean }>;
}

export interface GetWorkflowDefinitionSourceRequest {
  lookup: WorkflowDefinitionSourceLookup;
  file?: string;
  all?: boolean;
}

export type PutScheduleBaseRequest = {
  name: string;
  input?: unknown;
  target?: string;
  intervalMs: number;
  firstFireMs?: number;
};

export type PutScheduleRequest =
  | (PutScheduleBaseRequest & {
      source: WorkflowSourceInput;
      workflowName?: string | null;
      savedRef?: never;
    })
  | (PutScheduleBaseRequest & {
      savedRef: SavedWorkflowRef;
      source?: never;
      workflowName?: never;
    });

export interface ListSchedulesRequest {
  includeDisabled?: boolean;
}

export interface GetScheduleRequest {
  name: string;
  includeSource?: boolean;
}

export type { SavedWorkflowSummary, SavedWorkflowVersionView, SavedWorkflowView };
export type {
  DurableEventEnvelope,
  EffectType,
  EphemeralEventEnvelope,
  EventCursor,
  EventCursorInput,
  EventEnvelope,
  EventStreamFrame,
  InterruptRunResult,
  JournalStatus,
  NodeView,
  ReportNodeView,
  RunLaunchResult,
  RunOutcome,
  RunProjection,
  RunReport,
  RunStart,
  RunStateSnapshot,
  RunStatus,
  RunSummary,
  RunSummaryPage,
  RunWorkspaceDiff,
  RunWorkspaceView,
  ScheduleErrorProjection,
  ScheduleSummary,
  ScheduleView,
  StreamControlFrame,
  WorkflowDefinitionSourceLookup,
  WorkflowDefinitionSourceView,
  WorkspaceGcResult,
} from "./view-contract.ts";

export const MAX_EVENT_TAIL_COUNT = 10_000;

export interface SubscribeEventsRequest {
  runId: string;
  cursor?: EventCursorInput;
  includeControlFrames?: boolean;
}

export interface SubscribeEventsResult {
  subId: string;
  cursor: EventCursor;
  closedStatus: string | null;
}

export interface PutAgentProfileRequest {
  name: string;
  config: PersistentAgentProfileConfig;
  ifGeneration?: number;
  createOnly?: boolean;
  updateOnly?: boolean;
}

export interface DeleteAgentProfileRequest {
  name: string;
  ifGeneration?: number;
}

export interface CheckAgentProfileRequest {
  name?: string;
  config?: PersistentAgentProfileConfig;
  connect?: boolean;
}

export type { AgentProfileCheckResult, AgentProfileSource, AgentProfileView };
export type { SettingClass, SettingView, SettingsDiagnostic };

export interface PutSettingRequest {
  key: string;
  value: unknown;
  ifGeneration?: number;
}

export interface DeleteSettingRequest {
  key: string;
  ifGeneration?: number;
}

export interface BrowseDirectoriesRequest {
  path: string;
}

export interface DirectoryBrowseEntry {
  name: string;
  path: string;
}

export interface BrowseDirectoriesResult {
  path: string;
  parentPath: string | null;
  entries: DirectoryBrowseEntry[];
  truncated: boolean;
}

export interface KeelApi {
  /** List directories on the daemon host. Requires admin authority at the gateway. */
  browseDirectories(
    req: BrowseDirectoriesRequest,
  ): Promise<BrowseDirectoriesResult> | BrowseDirectoriesResult;
  /** Start a run; returns its id immediately (the run executes in the background). */
  launchRun(req: LaunchRequest): Promise<RunLaunchResult>;
  saveWorkflow(
    req: SaveWorkflowRequest,
  ): Promise<SavedWorkflowVersionView> | SavedWorkflowVersionView;
  previewWorkflowDefinition(
    req: PreviewWorkflowDefinitionRequest,
  ): Promise<PreviewWorkflowDefinitionResult> | PreviewWorkflowDefinitionResult;
  listSavedWorkflows(opts?: {
    includeDisabled?: boolean;
    includeDeprecated?: boolean;
    includeDeleted?: boolean;
  }): Promise<SavedWorkflowSummary[]> | SavedWorkflowSummary[];
  getSavedWorkflow(name: string): Promise<SavedWorkflowView | null> | SavedWorkflowView | null;
  getSavedWorkflowSource(req: {
    name: string;
    version?: number | "latest";
    file?: string;
    all?: boolean;
    allowDeprecated?: boolean;
  }): Promise<SavedWorkflowSourceView> | SavedWorkflowSourceView;
  getWorkflowDefinitionSource(
    req: GetWorkflowDefinitionSourceRequest,
  ): Promise<WorkflowDefinitionSourceView> | WorkflowDefinitionSourceView;
  launchSavedWorkflow(req: LaunchSavedWorkflowRequest): Promise<RunLaunchResult>;
  setSavedWorkflowDisabled(
    name: string,
    disabled: boolean,
  ): Promise<SavedWorkflowView> | SavedWorkflowView;
  setSavedWorkflowVersionEnabled(
    name: string,
    version: number,
    enabled: boolean,
  ): Promise<SavedWorkflowVersionView> | SavedWorkflowVersionView;
  deprecateSavedWorkflowVersion(req: {
    name: string;
    version: number;
    message?: string | null;
  }): Promise<SavedWorkflowVersionView> | SavedWorkflowVersionView;
  deleteSavedWorkflow(name: string): Promise<SavedWorkflowView> | SavedWorkflowView;
  deleteSavedWorkflowVersion(
    name: string,
    version: number,
  ): Promise<SavedWorkflowVersionView> | SavedWorkflowVersionView;
  putSchedule(req: PutScheduleRequest): Promise<{ ok: boolean }> | { ok: boolean };
  setScheduleEnabled(
    name: string,
    enabled: boolean,
  ): Promise<{ name: string; enabled: boolean }> | { name: string; enabled: boolean };
  deleteSchedule(
    name: string,
  ): Promise<{ name: string; deleted: boolean }> | { name: string; deleted: boolean };
  listSchedules(req?: ListSchedulesRequest): Promise<ScheduleSummary[]> | ScheduleSummary[];
  getSchedule(req: GetScheduleRequest): Promise<ScheduleView | null> | ScheduleView | null;
  /** Resume a non-terminal run in the background. */
  resumeRun(runId: string): Promise<RunStart>;
  /** Park a non-terminal run until an explicit resume. */
  interruptRun(runId: string, reason?: string): Promise<InterruptRunResult>;
  /** Re-execute a run against its stored definition or a new client-captured source. */
  rerunRun(
    runId: string,
    opts?: {
      source?: WorkflowSourceInput;
      input?: unknown;
      name?: string | null;
      provenance?: WorkflowProvenance;
      runSecrets?: RunSecrets;
    },
  ): Promise<RunStart>;
  /** Re-run a failed run from its failed step in the background. */
  retryRun(runId: string, opts?: { runSecrets?: RunSecrets }): Promise<RunStart>;
  /** Discard everything after a step and re-run in the background. */
  rewindRun(
    runId: string,
    toStableKey: string,
    opts?: { runSecrets?: RunSecrets },
  ): Promise<RunStart>;
  /** Copy a terminal run into a new independent run. */
  forkRun(runId: string, opts?: { atStableKey?: string; newRunId?: string }): RunLaunchResult;
  /** The canonical projection for one run. */
  getRun(runId: string): RunProjection | null;
  /** Current run-scoped state, resolving values up to the RPC cap. */
  getRunState(runId: string, namespace?: string): RunStateSnapshot | null;
  /** Post-run result digest from journaled node results. */
  getRunReport(runId: string): RunReport | null;
  /** Why is this run stuck? (§12.2). */
  getBlockage(runId: string): Blockage;
  /** Summaries of all runs. */
  listRuns(): RunSummary[];
  /** Newest run summaries with total count for bounded browser lists. */
  listRunsPage(req: { limit: number }): RunSummaryPage;
  listRunWorkspaces(
    runId: string,
    opts?: { includeRemoved?: boolean },
  ): Promise<RunWorkspaceView[]> | RunWorkspaceView[];
  getRunWorkspace(
    runId: string,
    workspaceId: string,
  ): Promise<RunWorkspaceView | null> | RunWorkspaceView | null;
  getRunWorkspaceDiff(
    runId: string,
    workspaceId: string,
  ): Promise<RunWorkspaceDiff> | RunWorkspaceDiff;
  mergeRunWorkspace(
    runId: string,
    workspaceId: string,
  ): Promise<RunWorkspaceView> | RunWorkspaceView;
  discardRunWorkspace(
    runId: string,
    workspaceId: string,
  ): Promise<RunWorkspaceView> | RunWorkspaceView;
  gcWorkspaces(opts?: {
    olderThanMs?: number;
    includePending?: boolean;
    includeRemoved?: boolean;
  }): Promise<WorkspaceGcResult> | WorkspaceGcResult;
  listAgentProfiles(opts?: {
    source?: "all" | "catalog" | "programmatic";
  }): Promise<AgentProfileView[]> | AgentProfileView[];
  getAgentProfile(name: string): Promise<AgentProfileView | null> | AgentProfileView | null;
  putAgentProfile(req: PutAgentProfileRequest): Promise<AgentProfileView> | AgentProfileView;
  deleteAgentProfile(
    req: DeleteAgentProfileRequest,
  ): Promise<{ name: string; deleted: true }> | { name: string; deleted: true };
  checkAgentProfile(
    req: CheckAgentProfileRequest,
  ): Promise<AgentProfileCheckResult> | AgentProfileCheckResult;
  listSettings(): Promise<SettingView[]> | SettingView[];
  getSetting(key: string): Promise<SettingView | null> | SettingView | null;
  putSetting(req: PutSettingRequest): Promise<SettingView> | SettingView;
  deleteSetting(
    req: DeleteSettingRequest,
  ): Promise<{ key: string; deleted: boolean }> | { key: string; deleted: boolean };
  checkSetting(req: {
    key: string;
    value: unknown;
  }):
    | Promise<{ ok: boolean; diagnostics: SettingsDiagnostic[] }>
    | {
        ok: boolean;
        diagnostics: SettingsDiagnostic[];
      };
  /** Await a run's next terminal or parked status and return its outcome. */
  waitForRun(runId: string): Promise<RunOutcome>;
  /** Return a run's terminal output without subscribing to events. */
  getRunOutput(runId: string): Promise<RunOutcome>;
  /** Prune unreferenced workflow definition rows and cache entries. */
  gcDefinitions(opts?: { ttlMs?: number; cacheMinAgeMs?: number }): Promise<{
    workflowDefinitionsRemoved: number;
    definitionCacheEntriesRemoved: number;
  }>;
  /** Subscribe to a run's events; returns an unsubscribe fn. */
  subscribeEvents(
    req: SubscribeEventsRequest,
    onEvent: (event: EventEnvelope) => void,
    onControl?: (frame: StreamControlFrame) => void,
  ): () => void;
}
