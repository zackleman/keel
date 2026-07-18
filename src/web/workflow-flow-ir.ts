export interface SourceLoc {
  file: string;
  line: number;
  column: number;
}

export type ExprKind =
  | "literal"
  | "template"
  | "identifier"
  | "object"
  | "array"
  | "call"
  | "function"
  | "expression"
  | "missing";

export interface ExprSummary {
  kind: ExprKind;
  text: string;
  static: boolean;
  value?: unknown;
}

export interface ImportInfo {
  specifier: string;
  bindings: string[];
  location: SourceLoc;
}

export interface EntryInfo {
  name: string | null;
  async: boolean;
  params: string[];
  location: SourceLoc | null;
}

export interface InputFieldInfo {
  name: string;
  type: string;
  optional: boolean;
  default?: ExprSummary;
  used: boolean;
  location?: SourceLoc;
}

export interface InputInfo {
  paramName: string;
  type: string | null;
  fields: InputFieldInfo[];
}

export type OperationKind =
  | "phase"
  | "step"
  | "agent"
  | "agentSession"
  | "agentTurn"
  | "sleep"
  | "human"
  | "signal"
  | "checkpoint"
  | "drainSignals"
  | "stateSet"
  | "spawn"
  | "waitRun"
  | "return";

export interface WorkflowOperation {
  id: string;
  kind: OperationKind;
  key?: ExprSummary;
  title?: ExprSummary;
  prompt?: ExprSummary;
  schema?: ExprSummary;
  provider?: ExprSummary;
  model?: ExprSummary;
  profile?: ExprSummary;
  toolPolicy?: ExprSummary;
  reasoning?: ExprSummary;
  target?: ExprSummary;
  status?: ExprSummary;
  result?: ExprSummary;
  condition?: ExprSummary;
  /** ctx.checkpoint message text. */
  message?: ExprSummary;
  /** ctx.drainSignals signal name (second argument). */
  signalName?: ExprSummary;
  /** ctx.state(namespace) handle namespace for a `.set` write. */
  namespace?: ExprSummary;
  /** ctx.state(...).set({ name }) state field name. */
  stateName?: ExprSummary;
  /** ctx.spawn saved-workflow reference. */
  workflowRef?: ExprSummary;
  sessionRef?: string;
  containers: string[];
  parallelLane?: number;
  location: SourceLoc;
}

export interface Diagnostic {
  severity: "info" | "warning";
  message: string;
  location?: SourceLoc;
}

export interface WorkflowDocIR {
  format: "keel.workflow-doc-ir.v1";
  sourceFile: string;
  source: string;
  entry: EntryInfo;
  input: InputInfo | null;
  imports: ImportInfo[];
  operations: WorkflowOperation[];
  diagnostics: Diagnostic[];
}
