// Public authoring SDK (the `keel` package entry).
//
// This is the ONLY surface a workflow file imports. Runtime values: the schema
// helpers (self-contained, dependency-free). Everything else is type-only and
// erased at runtime — the real `ctx` is injected by the engine. So a workflow's
// only runtime dependency is the two tiny schema helpers; with raw JSON Schema it
// has none at all.

export { jsonSchema, passthrough, type Schema } from "./kernel/schema.ts";
export type {
  AgentSession,
  AgentSessionSpec,
  AgentSpec,
  AgentTurnSpec,
  BranchPushedCompletionCheck,
  CommandCompletionCheck,
  CommandResult,
  CompletionCheck,
  CompletionCheckAttempt,
  CompletionCheckEffectSpec,
  CompletionCheckFailureAction,
  CompletionCheckFailureKind,
  CompletionCheckResult,
  CompletionCheckStatus,
  CompletionCheckTrigger,
  CheckpointSpec,
  Ctx,
  GitCleanCompletionCheck,
  HasCommitsCompletionCheck,
  NormalizedCompletionCheck,
  HumanDecision,
  HumanSpec,
  StateNamespace,
  StateSchemas,
  StateSetSpec,
  StepOpts,
  WorkflowCommandSpec,
  WorkspaceHandle,
  WorkspaceMode,
  WorkspaceRetention,
  WorkspaceSpec,
  WorkspaceSetupCommand,
  WorkspaceSetupSpec,
} from "./kernel/ctx.ts";
export { CommandFailure } from "./kernel/command.ts";
export {
  completionCheckPromptSummary,
  completionCheckStableKey,
  normalizeCompletionCheckFailureAction,
  normalizeCompletionChecks,
} from "./kernel/completion-check.ts";
export type {
  BoundedText,
  CommandResultStatus,
  WorkflowCommandBase,
} from "./kernel/command.ts";
export type { AgentEnvironmentSpec } from "./agents/environment.ts";
export type { Capabilities, ToolPolicy } from "./agents/capabilities.ts";
export type { ProviderConfigMap, ProviderConfigValue } from "./agents/types.ts";
