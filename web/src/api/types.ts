import type {
  Blockage,
  EventCursor,
  EventStreamFrame,
  RunProjection,
  RunReport,
  RunSummary,
  RunWorkspaceView,
  WorkflowDefinitionSourceView,
} from "../../../src/rpc/view-contract";

export type {
  Blockage,
  BlockageReason,
  DurableEventEnvelope,
  EffectType,
  EphemeralEventEnvelope,
  EventCursor,
  EventCursorInput,
  EventEnvelope,
  EventStreamFrame,
  InterruptionBlockageDetails,
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
  RunStats,
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
} from "../../../src/rpc/view-contract";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface GatewayErrorEnvelope {
  code?: string;
  message: string;
  action?: string;
  resource?: unknown;
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

export interface HealthResponse {
  ok: boolean;
  web: { ok: boolean; apiOnly: boolean };
  daemon: {
    reachable: boolean;
    ok?: boolean;
    ownerId?: string;
    error?: GatewayErrorEnvelope;
    [key: string]: unknown;
  };
  bundle: {
    available: boolean;
    indexMtimeMs?: number;
    indexSizeBytes?: number;
  };
}

export interface RunListItem extends RunSummary {
  run: RunProjection | null;
  blockage: Blockage | null;
  workspaceSummary: { count: number };
}

export interface RunsResponse {
  runs: RunListItem[];
  page: {
    limit: number;
    defaultLimit: number;
    maxLimit: number;
    returned: number;
    total: number;
    truncated: boolean;
  };
}

export interface RunDetailResponse {
  run: RunProjection | null;
  report: RunReport | null;
  blockage: Blockage | null;
  workspaces: RunWorkspaceView[];
  source: WorkflowDefinitionSourceView | null;
  flow: WorkflowFlowView | null;
  events: EventStreamFrame[];
  eventCursor: EventCursor | null;
  rawEvents: { href: string };
  actionAuthorization: Record<RunActionName, boolean>;
}

export type RunActionName =
  | "resume"
  | "interrupt"
  | "retry"
  | "rerun"
  | "rewind"
  | "fork"
  | "signal"
  | "decideApproval";

export type WorkflowOperationKind =
  | "phase"
  | "step"
  | "agent"
  | "agentSession"
  | "agentTurn"
  | "sleep"
  | "human"
  | "signal"
  | "return";

export interface WorkflowExprSummary {
  kind: string;
  text: string;
  static: boolean;
  value?: unknown;
}

export interface WorkflowFlowOperation {
  id: string;
  kind: WorkflowOperationKind;
  key?: WorkflowExprSummary;
  title?: WorkflowExprSummary;
  prompt?: WorkflowExprSummary;
  provider?: WorkflowExprSummary;
  model?: WorkflowExprSummary;
  profile?: WorkflowExprSummary;
  toolPolicy?: WorkflowExprSummary;
  reasoning?: WorkflowExprSummary;
  target?: WorkflowExprSummary;
  status?: WorkflowExprSummary;
  result?: WorkflowExprSummary;
  condition?: WorkflowExprSummary;
  sessionRef?: string;
  containers: string[];
  parallelLane?: number;
}

export interface WorkflowFlowView {
  entry: { name: string | null; async: boolean; params: string[] };
  input: {
    paramName: string;
    type: string | null;
    fields: Array<{
      name: string;
      type: string;
      optional: boolean;
      default?: WorkflowExprSummary;
      used: boolean;
    }>;
  } | null;
  operations: WorkflowFlowOperation[];
  diagnostics: Array<{ severity: "info" | "warning"; message: string }>;
}

export interface ApprovalView {
  runId: string;
  runName: string | null;
  status: string;
  gateId: string | null;
  prompt: string;
  createdAtMs: number | null;
  requiredAuthority: "admin";
  cli: string | null;
}

export interface ApprovalsResponse {
  approvals: ApprovalView[];
  decisionAuthority: "admin";
  decisionAuthorized: boolean;
}

export interface WorkspacesResponse {
  workspaces: RunWorkspaceView[];
  mutationAuthority: "admin";
  mutationAuthorized: boolean;
}

export interface SavedWorkflowVersionView {
  name: string;
  version: number;
  definitionHash: string;
  workflowName: string | null;
  inputSchema: unknown | null;
  inputSchemaSet: boolean;
  defaultInput: unknown | null;
  defaultInputSet: boolean;
  defaultTarget: string | null;
  metadata: unknown | null;
  sourceProvenance: unknown | null;
  createdBy: string | null;
  createdAtMs: number;
  enabled: boolean;
  deprecatedAtMs: number | null;
  deprecationMessage: string | null;
  deletedAtMs: number | null;
}

export interface SavedWorkflowView {
  name: string;
  title: string | null;
  description: string | null;
  tags: string[];
  createdAtMs: number;
  updatedAtMs: number;
  disabledAtMs: number | null;
  deletedAtMs: number | null;
  versions: SavedWorkflowVersionView[];
}

export interface SavedWorkflowSummary extends SavedWorkflowView {
  latestVersion: number | null;
  latestDefinitionHash: string | null;
}

export interface SavedWorkflowSourceView {
  name: string;
  version: number;
  definitionHash: string;
  entry: string;
  files: Array<{ path: string; code: string; entry: boolean }>;
}

export interface AgentProfileDiagnostic {
  level: "error" | "warning" | "info";
  path: string;
  message: string;
}

export interface AgentProfileCheckResult {
  ok: boolean;
  diagnostics: AgentProfileDiagnostic[];
}

export interface AgentProfileView {
  name: string;
  source: "catalog" | "programmatic";
  config: Record<string, unknown>;
  configHash: string;
  generation: number | null;
  createdAtMs: number | null;
  updatedAtMs: number | null;
}

export interface SettingsDiagnostic {
  level: "error" | "warning" | "info";
  path: string;
  message: string;
}

export interface SettingView {
  key: string;
  class: "workflow-visible" | "daemon-operational";
  value: unknown;
  defaultValue: unknown;
  isDefault: boolean;
  readOnly: boolean;
  generation: number | null;
  updatedAtMs: number | null;
  description: string;
}

export interface SettingCheckResult {
  ok: boolean;
  diagnostics: SettingsDiagnostic[];
}

export interface SystemProjection {
  daemon: Record<string, unknown>;
  profiles: AgentProfileView[];
  settings: SettingView[];
  warnings: string[];
}
