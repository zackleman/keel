// Realm host (DESIGN.md §6) — the main-thread side of the worker bridge.
//
// Spawns one Worker per execution, answers its journaled effect requests through
// the shared StepEngine, and resolves when the body returns. The journal and all
// fault hooks live here on the host, so crash semantics match the in-process
// path (the StepEngine is identical, validated under real kill -9 in Phase 3).

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Capabilities } from "../../agents/capabilities.ts";
import type { AgentConcurrencyLimiter } from "../../agents/concurrency.ts";
import {
  type NormalizedAgentEnvironment,
  hasAgentEnvironment,
  normalizeRunSecrets,
} from "../../agents/environment.ts";
import { AgentFailure, executeAgent, runAgentWithStall } from "../../agents/execute.ts";
import {
  type AgentProfileSnapshotEntry,
  type AgentProfiles,
  agentProfileConfigHash,
  agentProfilesFromSnapshot,
  assertValidAgentProfileName,
  compareAgentProfileNames,
  effectiveProfileCatalogHash,
  normalizeAgentProfileConfig,
} from "../../agents/profiles.ts";
import { normalizeProviderConfigValue } from "../../agents/provider-config.ts";
import type { SecretStore } from "../../agents/secrets.ts";
import type {
  AgentProvider,
  AgentProviderRegistry,
  ProviderConfigValue,
  TraceEvent,
} from "../../agents/types.ts";
import { type CapabilityAction, issueRunCapability } from "../../auth/capabilities.ts";
import { redactCapabilityTokens } from "../../auth/redaction.ts";
import { type Json, canonicalJson, hashJson } from "../../hash.ts";
import type { JournalStore } from "../../journal/store.ts";
import type {
  AgentWorkspaceOwnerKind,
  AgentWorkspaceRow,
  InputDep,
  RunRow,
  RunStatus,
} from "../../journal/types.ts";
import {
  type LaunchAuthority,
  assertCapabilitiesWithinAuthority,
  grantCapabilities,
  parseLaunchAuthority,
} from "../../policy/launch-authority.ts";
import type { WorkflowProvenance } from "../../rpc/contract.ts";
import {
  captureWorkflowVisibleSettingsSnapshot,
  workflowVisibleSettingsFromSnapshot,
} from "../../settings/catalog.ts";
import type { WorkflowVisibleSettings } from "../../settings/catalog.ts";
import { requireRunTarget } from "../../target.ts";
import {
  WORKFLOW_SDK_ABI_VERSION,
  defaultDefinitionCacheRoot,
  isWorkflowDefinitionHash,
  materializeWorkflowDefinition,
  resolveKeelPackageRoot,
  snapshotWorkflowSource,
} from "../../workflow-definitions/snapshot.ts";
import type { WorkflowSourceInput } from "../../workflow-definitions/source.ts";
import {
  DEFAULT_WORKSPACE_ID,
  workflowWorkspaceId,
  workspaceIdentity,
} from "../../workspace/identity.ts";
import {
  DEFAULT_WORKSPACE_RETENTION,
  cleanupTerminalRunWorkspaces,
  validateWorkspaceRetention,
} from "../../workspace/retention.ts";
import {
  BranchAlreadyExistsError,
  assertUsableTargetDirectory,
  attachBranchBackedWorktree,
  branchContainsCommit,
  branchExists,
  classifyCloneSource,
  copyBaselinePath,
  createBranchBackedWorktree,
  createRetainedClone,
  createRetainedCopy,
  createRetainedWorktree,
  diffCopyWorkspace,
  diffGitFinalTree,
  generatedWorktreeBranchName,
  resolveGitRootTarget,
  resolveUsableDirectory,
  retainedWorkspacePath,
} from "../../workspace/worktree.ts";
import { type DurableAgentEvent, finalAgentMessageEvents } from "../agent-events.ts";
import {
  CommandFailure,
  type CommandResult,
  type NormalizedWorkflowCommandSpec,
  applyCommandFailureMode,
  buildCommandEnvironment,
  commandCompletedEvent,
  commandStartedEvent,
} from "../command.ts";
import { runCompletionCheck } from "../completion-check-runner.ts";
import {
  type CompletionCheckResult,
  completionCheckCompletedEvent,
  completionCheckStartedEvent,
} from "../completion-check.ts";
import type { CtxHost, FaultPoint } from "../ctx.ts";
import { extractModuleHelpers } from "../module-helpers.ts";
import { RUN_FINISHED_INLINE_OUTPUT_BYTES } from "../output.ts";
import { CommandAbortError, runBoundedProcess } from "../process-runner.ts";
import type { ChildRunOutcome } from "../spawn.ts";
import { StepEngine, prepareStepResult, readJournalResult } from "../step-engine.ts";
import {
  type NormalizedWorkspaceSetupSpec,
  WORKSPACE_SETUP_STABLE_KEY_PREFIX,
  buildWorkspaceSetupEnvironment,
  normalizeWorkspaceSetupSpec,
  setupCommandToWorkflowCommand,
  workspaceSetupCompletedEvent,
  workspaceSetupFailedEvent,
  workspaceSetupStartedEvent,
} from "../workspace-setup.ts";
import {
  CONTROL_WORDS,
  type HostReply,
  SAB_BYTES,
  VALUE_OFFSET,
  type WorkerRequest,
} from "./protocol.ts";

export interface RunHandle<O> {
  runId: string;
  status: RunStatus;
  output?: O;
}

export interface InterruptRunResult {
  runId: string;
  status: "interrupted";
}

interface ActiveExecution {
  interrupt(): void;
}

export interface RealmKernelOptions {
  clock?: () => number;
  rng?: () => number;
  idgen?: () => string;
  fault?: (point: FaultPoint, key: string) => void;
  /** Called once per real step-fn execution (used by crash tests to count). */
  onStepExecute?: (key: string) => void;
  /** Run the determinism lint on the workflow source before spawning (default true). */
  lint?: boolean;
  /** Agent provider registry for ctx.agent (the daemon owns providers, L4). */
  agents?: AgentProviderRegistry;
  /** Side-channel secret store (§11.2); enables env injection + terminal cleanup. */
  secrets?: SecretStore;
  /** Keel-owned store for retained isolated session workspaces. */
  workspaceStore?: string;
  /** Named agent profiles resolved before version computation (§10.2). */
  agentProfiles?: Record<string, unknown>;
  /** Daemon-owned workflow definition materialization cache. */
  definitionCacheRoot?: string;
  /** Push a live, non-durable event frame to current watchers. */
  liveEvent?: CtxHost["liveEvent"];
  /** Daemon-local backpressure for provider calls. */
  agentConcurrency?: AgentConcurrencyLimiter;
  /** Register a newly created child with the owning daemon's heartbeat fence. */
  onChildRunCreated?: (runId: string) => void;
}

const TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "finished",
  "failed",
  "cancelled",
  "continued",
]);

const WORKER_URL = pathToFileURL(
  join(resolveKeelPackageRoot(), "src", "kernel", "realm", "worker-entry.ts"),
);

class AgentSessionContinuityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentSessionContinuityError";
  }
}

class RunInterruptedError extends Error {
  constructor(runId: string) {
    super(`run ${runId} interrupted`);
    this.name = "RunInterruptedError";
  }
}

class RunSettledError extends Error {
  constructor(runId: string) {
    super(`run ${runId} settled`);
    this.name = "RunSettledError";
  }
}

class ProfileSnapshotIntegrityError extends Error {
  constructor(runId: string) {
    super(`run ${runId} is missing agent profile snapshot set`);
    this.name = "ProfileSnapshotIntegrityError";
  }
}

class SettingSnapshotIntegrityError extends Error {
  constructor(runId: string) {
    super(`run ${runId} is missing daemon settings snapshot set`);
    this.name = "SettingSnapshotIntegrityError";
  }
}

interface WorkspaceSpecMessage {
  key: string;
  mode?: string | null;
  path?: string | null;
  repo?: string | null;
  ref?: string | null;
  retention?: string | null;
  branch?: unknown;
  setup?: unknown;
}

interface WorkspaceHolder {
  kind: AgentWorkspaceOwnerKind;
  key: string;
  attempt: number;
}

interface InvocationWorkspace {
  cwd: string;
  workspaceId: string;
  workspacePath: string;
  sourcePath: string | null;
  sourceRef?: string;
  baseCommit?: string;
  copyBaselinePath?: string;
  mode: AgentWorkspaceRow["mode"];
  owned: boolean;
}

interface CommandWorkspace {
  workspaceId: string;
  workspacePath: string;
  resolvedCwd: string;
  owned: boolean;
}

function normalizeRealmAgentProfiles(
  profiles: Record<string, unknown>,
  registry?: AgentProviderRegistry,
): AgentProfiles {
  const normalized: AgentProfiles = {};
  for (const [name, profile] of Object.entries(profiles)) {
    assertValidAgentProfileName(name);
    normalized[name] = normalizeAgentProfileConfig(profile, {
      path: `agent profile "${name}"`,
      providerRegistry: registry,
    });
  }
  return Object.freeze(normalized);
}

export interface ClientCapturedWorkflow {
  source: WorkflowSourceInput;
  name?: string | null;
  provenance?: WorkflowProvenance;
}

function workflowRefFromProvenance(provenance: WorkflowProvenance | undefined): string {
  if (provenance?.kind === "clientPath") return `client-file:${provenance.path}`;
  return "stdin";
}

function assertWorkflowDefinitionHash(hash: string): void {
  if (!isWorkflowDefinitionHash(hash)) {
    throw new Error(`workflow definition ${hash} is not a valid definition hash`);
  }
}

function canonicalProfileJson(profile: AgentProfileSnapshotEntry["config"]): string {
  return canonicalJson(profile);
}

function runFinishedPayload(output: unknown): unknown {
  const text = JSON.stringify(output);
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength <= RUN_FINISHED_INLINE_OUTPUT_BYTES) return { output };
  return { outputOmitted: true, outputByteLength: byteLength };
}

function jsonFileChanges(
  changes:
    | Array<{
        path: string;
        status: string;
        oldMode?: string | null;
        newMode?: string | null;
        oldSymlinkTarget?: string | null;
        newSymlinkTarget?: string | null;
        binary?: boolean;
        textDiffIncluded?: boolean;
      }>
    | undefined,
): Json {
  return (changes ?? []).map((change) => ({
    path: change.path,
    status: change.status,
    oldMode: change.oldMode ?? null,
    newMode: change.newMode ?? null,
    oldSymlinkTarget: change.oldSymlinkTarget ?? null,
    newSymlinkTarget: change.newSymlinkTarget ?? null,
    binary: change.binary ?? false,
    textDiffIncluded: change.textDiffIncluded ?? false,
  }));
}

/** Runs workflows defined as ES modules (default export) in a Worker realm. */
export class RealmKernel {
  private readonly store: JournalStore;
  private readonly host: CtxHost;
  private readonly idgen: () => string;
  private readonly onStepExecute?: (key: string) => void;
  private readonly lintEnabled: boolean;
  private readonly registry?: AgentProviderRegistry;
  private readonly definitionCacheRoot: string;
  private readonly agentConcurrency?: AgentConcurrencyLimiter;
  private readonly onChildRunCreated?: (runId: string) => void;
  private readonly activeSessionRuns = new Set<string>();
  private readonly activeWorkers = new Set<Worker>();
  private readonly activeExecutions = new Map<string, Set<ActiveExecution>>();
  private readonly activeWorkspaceSetups = new Map<string, Promise<void>>();

  constructor(store: JournalStore, opts: RealmKernelOptions = {}) {
    this.store = store;
    this.host = {
      clock: opts.clock ?? (() => Date.now()),
      rng: opts.rng ?? Math.random,
      ...(opts.fault ? { fault: opts.fault } : {}),
      ...(opts.liveEvent ? { liveEvent: opts.liveEvent } : {}),
    };
    this.idgen = opts.idgen ?? (() => `run_${randomUUID()}`);
    if (opts.onStepExecute) this.onStepExecute = opts.onStepExecute;
    this.lintEnabled = opts.lint ?? true;
    this.definitionCacheRoot = opts.definitionCacheRoot ?? defaultDefinitionCacheRoot();
    if (opts.agentConcurrency) this.agentConcurrency = opts.agentConcurrency;
    if (opts.onChildRunCreated) this.onChildRunCreated = opts.onChildRunCreated;
    if (opts.agents) this.registry = opts.agents;
    if (opts.secrets) this.secrets = opts.secrets;
    if (opts.workspaceStore) this.workspaceStore = opts.workspaceStore;
    if (opts.agentProfiles)
      this.agentProfiles = normalizeRealmAgentProfiles(opts.agentProfiles, opts.agents);
  }

  shutdown(): void {
    for (const active of this.activeExecutions.values()) {
      for (const execution of active) execution.interrupt();
    }
    for (const worker of this.activeWorkers) worker.terminate();
    this.activeWorkers.clear();
    this.activeExecutions.clear();
    this.activeSessionRuns.clear();
  }

  setLiveEventSink(liveEvent: CtxHost["liveEvent"]): void {
    this.host.liveEvent = liveEvent;
  }

  private readonly secrets?: SecretStore;
  private readonly workspaceStore?: string;
  private readonly agentProfiles?: AgentProfiles;

  getProgrammaticAgentProfiles(): AgentProfiles {
    return this.agentProfiles ?? {};
  }

  private captureEffectiveProfileSnapshot(atMs: number): {
    catalogHash: string;
    capturedAtMs: number;
    rows: Array<{
      name: string;
      source: "catalog" | "programmatic";
      configJson: string;
      configHash: string;
      catalogGeneration: number | null;
    }>;
  } {
    const entries: AgentProfileSnapshotEntry[] = [];
    for (const [name, config] of Object.entries(this.agentProfiles ?? {})) {
      entries.push({
        name,
        source: "programmatic",
        config,
        configHash: agentProfileConfigHash(config),
        catalogGeneration: null,
      });
    }
    for (const row of this.store.listAgentProfileCatalogRows()) {
      if (entries.some((entry) => entry.name === row.name)) {
        throw new Error(
          `duplicate agent profile "${row.name}" exists in programmatic and catalog sources`,
        );
      }
      entries.push({
        name: row.name,
        source: "catalog",
        config: JSON.parse(row.configJson) as AgentProfileSnapshotEntry["config"],
        configHash: row.configHash,
        catalogGeneration: row.generation,
      });
    }
    entries.sort((a, b) => compareAgentProfileNames(a.name, b.name));
    return {
      catalogHash: effectiveProfileCatalogHash(entries),
      capturedAtMs: atMs,
      rows: entries.map((entry) => ({
        name: entry.name,
        source: entry.source,
        configJson: canonicalProfileJson(entry.config),
        configHash: entry.configHash,
        catalogGeneration: entry.catalogGeneration,
      })),
    };
  }

  private profilesForRun(runId: string): AgentProfiles {
    const set = this.store.getRunProfileSnapshotSet(runId);
    if (!set) throw new ProfileSnapshotIntegrityError(runId);
    return agentProfilesFromSnapshot(
      this.store.listRunProfileSnapshots(runId).map((row) => ({
        name: row.name,
        source: row.source,
        config: JSON.parse(row.configJson) as AgentProfileSnapshotEntry["config"],
        configHash: row.configHash,
        catalogGeneration: row.catalogGeneration,
      })),
    );
  }

  private captureEffectiveSettingSnapshot(atMs: number): {
    settingsHash: string;
    capturedAtMs: number;
    rows: Array<{
      key: string;
      class: "workflow-visible" | "daemon-operational";
      valueJson: string;
      defaultJson: string;
      source: "catalog" | "default";
      catalogGeneration: number | null;
    }>;
  } {
    return captureWorkflowVisibleSettingsSnapshot(this.store.listDaemonSettingRows(), atMs);
  }

  private workflowSettingsForRun(runId: string): WorkflowVisibleSettings {
    const set = this.store.getRunSettingSnapshotSet(runId);
    if (!set) throw new SettingSnapshotIntegrityError(runId);
    return workflowVisibleSettingsFromSnapshot(runId, this.store.listRunSettingSnapshots(runId));
  }

  private launchAuthorityForRun(runId: string): LaunchAuthority | null {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    return parseLaunchAuthority(run.launchAuthorityJson);
  }

  private assertRunCapabilities(runId: string, caps: Capabilities, context: string): Capabilities {
    return assertCapabilitiesWithinAuthority(caps, this.launchAuthorityForRun(runId), context);
  }

  private grantRunCapabilities(runId: string, grantedCaps: unknown): void {
    const authority = grantCapabilities(this.launchAuthorityForRun(runId), grantedCaps);
    if (authority) this.store.updateRun(runId, { launchAuthorityJson: canonicalJson(authority) });
  }

  private assertRunSecretStoreAvailable(runSecrets: Record<string, string>, path: string): void {
    if (Object.keys(runSecrets).length > 0 && !this.secrets) {
      throw new Error(`${path} requires a RealmKernel SecretStore`);
    }
  }

  private putRunSecrets(runId: string, runSecrets: Record<string, string>): void {
    if (Object.keys(runSecrets).length === 0) return;
    this.secrets?.putMany(runId, runSecrets);
  }

  private resolveAgentEnvironmentEnv(
    runId: string,
    environment: NormalizedAgentEnvironment,
  ): Record<string, string> | undefined {
    if (!hasAgentEnvironment(environment)) return undefined;
    const env: Record<string, string> = { ...environment.vars };
    if (environment.secrets.length > 0) {
      if (!this.secrets) {
        throw new Error("agent environment.secrets requires a RealmKernel SecretStore");
      }
      for (const ref of this.secrets.resolveOrThrow(runId, environment.secrets)) {
        env[ref.name] = ref.value;
      }
    }
    return env;
  }

  private resolveCommandEnvironmentEnv(
    runId: string,
    command: NormalizedWorkflowCommandSpec,
  ): Record<string, string> {
    if (command.environment.secrets.length === 0) {
      return buildCommandEnvironment(command.environment, []);
    }
    if (!this.secrets) {
      throw new Error("command environment.secrets requires a RealmKernel SecretStore");
    }
    const refs = this.secrets.resolveOrThrow(runId, command.environment.secrets);
    return buildCommandEnvironment(command.environment, refs);
  }

  /** Start a run and return its id immediately, with a promise for completion.
   * The RPC layer/daemon uses this so launchRun returns before the run finishes. */
  launch<O>(
    workflow: ClientCapturedWorkflow,
    input: unknown,
    meta: {
      name?: string | null;
      target?: string | null;
      runSecrets?: Record<string, string>;
      launchAuthority?: LaunchAuthority | null;
    } = {},
  ): { runId: string; done: Promise<RunHandle<O>> } {
    const at = this.host.clock();
    const target = requireRunTarget(meta.target, "RealmKernel.launch");
    const runSecrets = normalizeRunSecrets(meta.runSecrets, {
      path: "RealmKernel.launch.runSecrets",
    });
    this.assertRunSecretStoreAvailable(runSecrets, "RealmKernel.launch.runSecrets");
    const name = meta.name !== undefined ? meta.name : (workflow.name ?? null);
    const { snapshot, entryPath } = snapshotWorkflowSource(this.store, workflow.source, {
      name,
      nowMs: at,
      lint: this.lintEnabled,
      cacheRoot: this.definitionCacheRoot,
    });
    const runId = this.idgen();
    const profileSnapshot = this.captureEffectiveProfileSnapshot(at);
    const settingSnapshot = this.captureEffectiveSettingSnapshot(at);
    this.store.transaction(() => {
      this.store.insertRun({
        runId,
        workflowName: name,
        definitionVersion: snapshot.hash,
        workflowRef: workflowRefFromProvenance(workflow.provenance),
        runTarget: target,
        status: "running",
        parentRunId: null,
        tenantId: null,
        inputRef: JSON.stringify(input ?? null),
        outputRef: null,
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        launchAuthorityJson: meta.launchAuthority ? canonicalJson(meta.launchAuthority) : null,
        createdAtMs: at,
      });
      this.store.replaceRunProfileSnapshot(runId, profileSnapshot, profileSnapshot.rows);
      this.store.replaceRunSettingSnapshot(runId, settingSnapshot, settingSnapshot.rows);
      this.store.appendEvent(
        runId,
        "run.started",
        { name, definitionHash: snapshot.hash, target },
        this.host.clock(),
      );
    });
    this.putRunSecrets(runId, runSecrets);
    return { runId, done: this.execute<O>(runId, entryPath, input) };
  }

  async run<O>(
    workflow: ClientCapturedWorkflow,
    input: unknown,
    meta: {
      name?: string | null;
      target?: string | null;
      runSecrets?: Record<string, string>;
    } = {},
  ): Promise<RunHandle<O>> {
    return this.launch<O>(workflow, input, meta).done;
  }

  launchDefinition<O>(
    definitionHash: string,
    input: unknown,
    meta: {
      name?: string | null;
      workflowRef?: string | null;
      target?: string | null;
      runSecrets?: Record<string, string>;
      launchAuthority?: LaunchAuthority | null;
    } = {},
  ): { runId: string; done: Promise<RunHandle<O>> } {
    const target = requireRunTarget(meta.target, "RealmKernel.launchDefinition");
    const runSecrets = normalizeRunSecrets(meta.runSecrets, {
      path: "RealmKernel.launchDefinition.runSecrets",
    });
    this.assertRunSecretStoreAvailable(runSecrets, "RealmKernel.launchDefinition.runSecrets");
    assertWorkflowDefinitionHash(definitionHash);
    const entryPath = materializeWorkflowDefinition(
      this.store,
      definitionHash,
      this.definitionCacheRoot,
    );
    const at = this.host.clock();
    const runId = this.idgen();
    const profileSnapshot = this.captureEffectiveProfileSnapshot(at);
    const settingSnapshot = this.captureEffectiveSettingSnapshot(at);
    this.store.transaction(() => {
      this.store.insertRun({
        runId,
        workflowName: meta.name ?? null,
        definitionVersion: definitionHash,
        workflowRef: meta.workflowRef ?? definitionHash,
        runTarget: target,
        status: "running",
        parentRunId: null,
        tenantId: null,
        inputRef: JSON.stringify(input ?? null),
        outputRef: null,
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        launchAuthorityJson: meta.launchAuthority ? canonicalJson(meta.launchAuthority) : null,
        createdAtMs: at,
      });
      this.store.replaceRunProfileSnapshot(runId, profileSnapshot, profileSnapshot.rows);
      this.store.replaceRunSettingSnapshot(runId, settingSnapshot, settingSnapshot.rows);
      this.store.appendEvent(
        runId,
        "run.started",
        { name: meta.name ?? null, definitionHash, target },
        this.host.clock(),
      );
    });
    this.putRunSecrets(runId, runSecrets);
    return { runId, done: this.execute<O>(runId, entryPath, input) };
  }

  interruptRun(runId: string, reason?: string): InterruptRunResult {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (TERMINAL.has(run.status)) {
      throw new Error(`cannot interrupt terminal run ${runId} (is ${run.status})`);
    }
    if (run.status === "interrupted") {
      this.store.updateRun(runId, { heartbeatAtMs: null, runtimeOwnerId: null });
      return { runId, status: "interrupted" };
    }

    const safeReason = redactInterruptionReason(reason);
    this.store.transaction(() => {
      this.store.updateRun(runId, {
        status: "interrupted",
        heartbeatAtMs: null,
        runtimeOwnerId: null,
      });
      this.store.appendEvent(
        runId,
        "run.interrupted",
        {
          previousStatus: run.status,
          ...(safeReason ? { reason: safeReason } : {}),
        },
        this.host.clock(),
      );
    });

    const active = [...(this.activeExecutions.get(runId) ?? [])];
    for (const execution of active) execution.interrupt();
    return { runId, status: "interrupted" };
  }

  async resume<O>(runId: string): Promise<RunHandle<O>> {
    return this.startResume<O>(runId).done;
  }

  startResume<O>(runId: string): { runId: string; done: Promise<RunHandle<O>> } {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (TERMINAL.has(run.status)) {
      return {
        runId,
        done: Promise.resolve({
          runId,
          status: run.status,
          output: run.outputRef ? (JSON.parse(run.outputRef) as O) : undefined,
        }),
      };
    }
    const executionPath = this.executionPathForRun(run);
    const input = run.inputRef ? JSON.parse(run.inputRef) : undefined;
    this.store.transaction(() => {
      this.store.updateRun(runId, { status: "running", errorJson: null, finishedAtMs: null });
      this.store.appendEvent(runId, "run.resumed", {}, this.host.clock());
    });
    return { runId, done: this.execute<O>(runId, executionPath, input) };
  }

  /**
   * Re-execute a run against (possibly edited) code — the §7.5 `--adopt-latest`
   * path (Phase 6). Unlike resume, this ignores terminal status: steps whose
   * (inputHash, version) still match replay; steps whose version changed (edited
   * logic/prompt) or whose inputs changed (because an upstream re-executed to a
   * different value) re-execute as a new attempt. Early cutoff is automatic — an
   * edited step that yields a byte-identical output leaves downstream inputHashes
   * unchanged, so they replay.
   */
  async rerun<O>(
    runId: string,
    opts: {
      source?: WorkflowSourceInput;
      input?: unknown;
      name?: string | null;
      provenance?: WorkflowProvenance;
      runSecrets?: Record<string, string>;
    } = {},
  ): Promise<RunHandle<O>> {
    return this.startRerun<O>(runId, opts).done;
  }

  startRerun<O>(
    runId: string,
    opts: {
      source?: WorkflowSourceInput;
      input?: unknown;
      name?: string | null;
      provenance?: WorkflowProvenance;
      runSecrets?: Record<string, string>;
    } = {},
  ): { runId: string; done: Promise<RunHandle<O>> } {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.status === "interrupted") {
      throw new Error(`cannot rerun interrupted run ${runId}; resume it first`);
    }
    if (this.store.hasAgentSessions(runId)) {
      throw new Error(
        `run ${runId} uses durable agent sessions and cannot be rerun; start a fresh run instead`,
      );
    }
    const runSecrets = normalizeRunSecrets(opts.runSecrets, {
      path: "RealmKernel.startRerun.runSecrets",
    });
    this.assertRunSecretStoreAvailable(runSecrets, "RealmKernel.startRerun.runSecrets");
    const sourceOverride = opts.source !== undefined;
    const name = opts.name !== undefined ? opts.name : run.workflowName;
    const { definitionHash, workflowRef, entryPath } = sourceOverride
      ? this.snapshotSourceForExistingRun(opts.source as WorkflowSourceInput, name, opts.provenance)
      : {
          definitionHash: run.definitionVersion,
          workflowRef: run.workflowRef,
          entryPath: this.executionPathForRun(run),
        };
    const overriding = opts.input !== undefined;
    const effectiveInput = overriding
      ? opts.input
      : run.inputRef
        ? JSON.parse(run.inputRef)
        : undefined;
    // Reset the run to running and clear the previous terminal result; persist an
    // override input so a later input-less rerun does not silently use the old one.
    const snapshotAt = this.host.clock();
    const profileSnapshot = this.captureEffectiveProfileSnapshot(snapshotAt);
    const settingSnapshot = this.captureEffectiveSettingSnapshot(snapshotAt);
    this.store.transaction(() => {
      this.store.updateRun(runId, {
        status: "running",
        finishedAtMs: null,
        outputRef: null,
        errorJson: null,
        ...(overriding ? { inputRef: JSON.stringify(opts.input ?? null) } : {}),
        ...(opts.name !== undefined ? { workflowName: name } : {}),
      });
      this.store.updateRunDefinition(runId, definitionHash, workflowRef);
      this.store.replaceRunProfileSnapshot(runId, profileSnapshot, profileSnapshot.rows);
      this.store.replaceRunSettingSnapshot(runId, settingSnapshot, settingSnapshot.rows);
      this.store.appendEvent(runId, "run.rerun", { definitionHash }, this.host.clock());
    });
    this.putRunSecrets(runId, runSecrets);
    return { runId, done: this.execute<O>(runId, entryPath, effectiveInput) };
  }

  /** Retry a FAILED run from its failed step (§18) — the failed rows are dropped
   * so they re-execute; completed upstream replays. For transient agent failures. */
  async retry<O>(
    runId: string,
    opts: { runSecrets?: Record<string, string> } = {},
  ): Promise<RunHandle<O>> {
    return this.startRetry<O>(runId, opts).done;
  }

  startRetry<O>(
    runId: string,
    opts: { runSecrets?: Record<string, string> } = {},
  ): { runId: string; done: Promise<RunHandle<O>> } {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.status !== "failed") throw new Error(`retry needs a failed run (is ${run.status})`);
    const runSecrets = normalizeRunSecrets(opts.runSecrets, {
      path: "RealmKernel.startRetry.runSecrets",
    });
    this.assertRunSecretStoreAvailable(runSecrets, "RealmKernel.startRetry.runSecrets");
    const executionPath = this.executionPathForRun(run);
    this.store.deleteFailedRows(runId);
    const at = this.host.clock();
    this.store.transaction(() => {
      this.store.updateRun(runId, { status: "running", errorJson: null, finishedAtMs: null });
      this.store.reopenPendingReviewWorkspaces(runId, at);
      this.resetFailedWorkspaceSetupsForRetry(runId, at);
      this.store.appendEvent(runId, "run.retry", {}, at);
    });
    this.putRunSecrets(runId, runSecrets);
    const input = run.inputRef ? JSON.parse(run.inputRef) : undefined;
    return { runId, done: this.execute<O>(runId, executionPath, input) };
  }

  /** Rewind a run to a chosen step (§18): discard everything journaled after it,
   * then re-execute. The kept prefix replays; the rest re-runs (may diverge). */
  async rewind<O>(
    runId: string,
    toStableKey: string,
    opts: { runSecrets?: Record<string, string> } = {},
  ): Promise<RunHandle<O>> {
    return this.startRewind<O>(runId, toStableKey, opts).done;
  }

  startRewind<O>(
    runId: string,
    toStableKey: string,
    opts: { runSecrets?: Record<string, string> } = {},
  ): { runId: string; done: Promise<RunHandle<O>> } {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    if (run.status === "interrupted") {
      throw new Error(`cannot rewind interrupted run ${runId}; resume it first`);
    }
    if (this.store.hasAgentSessions(runId)) {
      throw new Error(
        `run ${runId} uses durable agent sessions and cannot be rewound; start a fresh run instead`,
      );
    }
    if (!this.store.getLatestAttempt(runId, toStableKey)) {
      throw new Error(`cannot rewind to unknown step "${toStableKey}"`);
    }
    if (this.store.hasSpawnRowsAfter(runId, toStableKey)) {
      throw new Error(
        `run ${runId} cannot be rewound to "${toStableKey}" because the discarded suffix contains spawn rows; start a fresh run instead`,
      );
    }
    const runSecrets = normalizeRunSecrets(opts.runSecrets, {
      path: "RealmKernel.startRewind.runSecrets",
    });
    this.assertRunSecretStoreAvailable(runSecrets, "RealmKernel.startRewind.runSecrets");
    const executionPath = this.executionPathForRun(run);
    // Trim journal + decrement refcounts + clear unresolved waits as one snapshot.
    this.store.deleteRunStateAfter(runId, toStableKey);
    this.store.updateRun(runId, {
      status: "running",
      outputRef: null,
      errorJson: null,
      finishedAtMs: null,
    });
    this.store.appendEvent(runId, "run.rewind", { to: toStableKey }, this.host.clock());
    this.putRunSecrets(runId, runSecrets);
    const input = run.inputRef ? JSON.parse(run.inputRef) : undefined;
    return { runId, done: this.execute<O>(runId, executionPath, input) };
  }

  /** Fork a TERMINAL run into a new independent run sharing the journal prefix
   * and its resolved durable-wait history (§18); the new run can be rerun to
   * diverge without touching the source. */
  fork(runId: string, opts: { atStableKey?: string; newRunId?: string } = {}): string {
    const src = this.store.getRun(runId);
    if (!src) throw new Error(`fork source run ${runId} not found`);
    if (this.store.hasAgentSessions(runId)) {
      throw new Error(
        `run ${runId} uses durable agent sessions and cannot be forked; start a fresh run instead`,
      );
    }
    // Fence: only fork a terminal run, so the prefix snapshot is consistent (no
    // concurrent owner mutating it mid-copy) and all waits are resolved.
    if (!TERMINAL.has(src.status)) {
      throw new Error(
        `cannot fork a non-terminal run (is ${src.status}); fork a finished/failed/continued run, or rewind first`,
      );
    }
    if (this.store.hasSpawnRowsInPrefix(runId, opts.atStableKey ?? null)) {
      throw new Error(
        `run ${runId} cannot be forked because the copied journal prefix contains spawn rows; start a fresh run instead`,
      );
    }
    const newId = opts.newRunId ?? this.idgen();
    this.store.forkRun(runId, newId, opts.atStableKey ?? null, this.host.clock());
    this.store.appendEvent(newId, "run.forked", { from: runId }, this.host.clock());
    return newId;
  }

  private executionPathForRun(run: RunRow): string {
    if (isWorkflowDefinitionHash(run.definitionVersion)) {
      return materializeWorkflowDefinition(
        this.store,
        run.definitionVersion,
        this.definitionCacheRoot,
      );
    }
    throw new Error(
      `run ${run.runId} cannot be resumed because it has no immutable workflow definition snapshot (${run.definitionVersion})`,
    );
  }

  private snapshotSourceForExistingRun(
    source: WorkflowSourceInput,
    name: string | null,
    provenance: WorkflowProvenance | undefined,
  ): { definitionHash: string; workflowRef: string; entryPath: string } {
    const { snapshot, entryPath } = snapshotWorkflowSource(this.store, source, {
      name,
      nowMs: this.host.clock(),
      lint: this.lintEnabled,
      cacheRoot: this.definitionCacheRoot,
    });
    return {
      definitionHash: snapshot.hash,
      workflowRef: workflowRefFromProvenance(provenance),
      entryPath,
    };
  }

  private async resolveWorkspaceSpec(
    runId: string,
    spec: WorkspaceSpecMessage,
    atMs: number,
  ): Promise<{ id: string; identityHash: string; setupIdentityHash?: string | null }> {
    if (typeof spec.key !== "string" || spec.key.trim().length === 0) {
      throw new Error("WorkspaceSpec.key is required and must be a non-empty string");
    }
    if (spec.key === DEFAULT_WORKSPACE_ID) {
      throw new Error(
        `workspace key ${DEFAULT_WORKSPACE_ID} is reserved for the run default workspace`,
      );
    }
    const mode = spec.mode ?? "direct";
    if (mode !== "direct" && mode !== "worktree" && mode !== "copy" && mode !== "clone") {
      throw new Error(
        `workspace mode must be direct, worktree, copy, or clone, got ${String(mode)}`,
      );
    }
    const workspaceId = workflowWorkspaceId(spec.key);
    if (mode === "direct") {
      if (spec.branch != null) throw new Error("direct workspaces do not accept branch");
      if (spec.repo != null) throw new Error("direct workspaces do not accept repo");
      if (spec.retention != null) {
        throw new Error(
          "direct workspaces do not accept retention because Keel does not own the directory",
        );
      }
      if (spec.ref != null) throw new Error("direct workspaces do not accept ref");
      const suppliedPath = spec.path ?? null;
      const path = suppliedPath
        ? resolveUsableDirectory(suppliedPath)
        : this.ensureDefaultWorkspace(runId, atMs).workspacePath;
      const identity = workspaceIdentity({
        key: spec.key,
        mode: "direct",
        ownerKind: "workflow",
        path,
        sdkAbiVersion: WORKFLOW_SDK_ABI_VERSION,
      });
      this.store.transaction(() => {
        const existing = this.store.getAgentWorkspace(runId, workspaceId);
        if (!existing) {
          this.store.insertAgentWorkspace({
            runId,
            workspaceId,
            mode: "direct",
            ownerKind: "workflow",
            key: spec.key,
            lastAttempt: null,
            retentionPolicy: null,
            workspacePath: path,
            sourceKind: "direct-path",
            sourcePath: path,
            sourceUri: null,
            sourceBare: null,
            sourceMergeEligible: false,
            suppliedPath,
            sourceRef: null,
            resolvedRef: null,
            checkoutBranch: null,
            baseCommit: null,
            copyBaselinePath: null,
            creationErrorJson: null,
            workspaceIdentityJson: identity.json,
            workspaceIdentityHash: identity.hash,
            owned: false,
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
            createdAtMs: atMs,
            updatedAtMs: atMs,
            mergedAtMs: null,
            discardedAtMs: null,
            removedAtMs: null,
          });
          return;
        }
        if (existing.workspaceIdentityHash !== identity.hash) {
          throw new Error(
            `workspace "${spec.key}" identity changed; use a new workspace key or a fresh run`,
          );
        }
      });
      return await this.ensureWorkspaceSetup(runId, spec, workspaceId, identity.hash, atMs);
    }

    if (!this.workspaceStore) {
      throw new Error(
        `workspace "${spec.key}" requests mode ${mode} but the kernel has no workspaceStore configured`,
      );
    }
    if (mode === "copy") {
      if (spec.repo != null) throw new Error("copy workspaces do not accept repo");
      if (spec.ref != null) throw new Error("copy workspaces do not accept ref");
      if (spec.branch != null) throw new Error("copy workspaces do not accept branch");
      const suppliedPath = spec.path ?? null;
      const sourcePath = suppliedPath
        ? resolveUsableDirectory(suppliedPath)
        : this.ensureDefaultWorkspace(runId, atMs).workspacePath;
      const retentionPolicy =
        spec.retention == null
          ? DEFAULT_WORKSPACE_RETENTION
          : validateWorkspaceRetention(spec.retention);
      const defaultPath = retainedWorkspacePath(this.workspaceStore, runId, workspaceId);
      const baselinePath = copyBaselinePath(this.workspaceStore, runId, workspaceId);
      const identity = workspaceIdentity({
        key: spec.key,
        mode: "copy",
        sourcePath,
        retentionPolicy,
        sdkAbiVersion: WORKFLOW_SDK_ABI_VERSION,
      });
      let needsCreate = false;
      this.store.transaction(() => {
        const existing = this.store.getAgentWorkspace(runId, workspaceId);
        if (!existing) {
          this.store.insertAgentWorkspace({
            runId,
            workspaceId,
            mode: "copy",
            ownerKind: "workflow",
            key: spec.key,
            lastAttempt: null,
            retentionPolicy,
            workspacePath: defaultPath,
            sourceKind: "local-copy",
            sourcePath,
            sourceUri: null,
            sourceBare: null,
            sourceMergeEligible: true,
            suppliedPath,
            sourceRef: null,
            resolvedRef: null,
            checkoutBranch: null,
            baseCommit: null,
            copyBaselinePath: baselinePath,
            creationErrorJson: null,
            workspaceIdentityJson: identity.json,
            workspaceIdentityHash: identity.hash,
            owned: true,
            status: "creating",
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
            createdAtMs: atMs,
            updatedAtMs: atMs,
            mergedAtMs: null,
            discardedAtMs: null,
            removedAtMs: null,
          });
          needsCreate = true;
          return;
        }
        if (existing.workspaceIdentityHash !== identity.hash) {
          throw new Error(
            `workspace "${spec.key}" identity changed; use a new workspace key or a fresh run`,
          );
        }
        if (
          existing.status === "creating" &&
          (!existsSync(existing.workspacePath) || !existsSync(existing.copyBaselinePath ?? ""))
        ) {
          needsCreate = true;
        }
      });
      if (needsCreate) {
        try {
          createRetainedCopy(sourcePath, defaultPath, baselinePath);
          this.store.updateAgentWorkspace(runId, workspaceId, {
            status: "idle",
            updatedAtMs: atMs,
          });
        } catch (err) {
          this.store.updateAgentWorkspace(runId, workspaceId, {
            status: "abandoned",
            failureSeen: true,
            creationErrorJson: JSON.stringify(serializeError(err)),
            updatedAtMs: this.host.clock(),
          });
          throw err;
        }
      }
      return await this.ensureWorkspaceSetup(runId, spec, workspaceId, identity.hash, atMs);
    }
    if (mode === "clone") {
      if (spec.path != null) throw new Error("clone workspaces do not accept path; use repo");
      if (spec.branch != null) throw new Error("clone workspaces do not accept branch");
      if (spec.repo == null || spec.repo.trim().length === 0) {
        throw new Error("clone workspaces require repo");
      }
      const source = classifyCloneSource(spec.repo);
      const sourceRef = spec.ref && spec.ref.length > 0 ? spec.ref : null;
      const retentionPolicy =
        spec.retention == null
          ? DEFAULT_WORKSPACE_RETENTION
          : validateWorkspaceRetention(spec.retention);
      const defaultPath = retainedWorkspacePath(this.workspaceStore, runId, workspaceId);
      const identity = workspaceIdentity({
        key: spec.key,
        mode: "clone",
        repo: source.repo,
        sourceKind: source.sourceKind,
        sourcePath: source.sourcePath,
        sourceRef,
        retentionPolicy,
        sdkAbiVersion: WORKFLOW_SDK_ABI_VERSION,
      });
      let needsCreate = false;
      this.store.transaction(() => {
        const existing = this.store.getAgentWorkspace(runId, workspaceId);
        if (!existing) {
          this.store.insertAgentWorkspace({
            runId,
            workspaceId,
            mode: "clone",
            ownerKind: "workflow",
            key: spec.key,
            lastAttempt: null,
            retentionPolicy,
            workspacePath: defaultPath,
            sourceKind: source.sourceKind,
            sourcePath: source.sourcePath,
            sourceUri: source.repo,
            sourceBare: source.sourceBare,
            sourceMergeEligible: source.sourceMergeEligible,
            suppliedPath: null,
            sourceRef,
            resolvedRef: null,
            checkoutBranch: null,
            baseCommit: null,
            copyBaselinePath: null,
            creationErrorJson: null,
            workspaceIdentityJson: identity.json,
            workspaceIdentityHash: identity.hash,
            owned: true,
            status: "creating",
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
            createdAtMs: atMs,
            updatedAtMs: atMs,
            mergedAtMs: null,
            discardedAtMs: null,
            removedAtMs: null,
          });
          needsCreate = true;
          return;
        }
        if (existing.workspaceIdentityHash !== identity.hash) {
          throw new Error(
            `workspace "${spec.key}" identity changed; use a new workspace key or a fresh run`,
          );
        }
        if (existing.status === "creating" && !existsSync(existing.workspacePath))
          needsCreate = true;
      });
      if (needsCreate) {
        try {
          const result = createRetainedClone(source, defaultPath, sourceRef);
          this.store.updateAgentWorkspace(runId, workspaceId, {
            status: "idle",
            baseCommit: result.baseCommit,
            checkoutBranch: result.checkoutBranch,
            resolvedRef: result.resolvedRef,
            sourceBare: result.sourceBare,
            sourceMergeEligible: result.sourceMergeEligible,
            updatedAtMs: atMs,
          });
        } catch (err) {
          this.store.updateAgentWorkspace(runId, workspaceId, {
            status: "abandoned",
            failureSeen: true,
            creationErrorJson: JSON.stringify(serializeError(err)),
            updatedAtMs: this.host.clock(),
          });
          throw err;
        }
      }
      return await this.ensureWorkspaceSetup(runId, spec, workspaceId, identity.hash, atMs);
    }

    if (spec.repo != null) throw new Error("worktree workspaces do not accept repo");
    if (spec.branch != null && typeof spec.branch !== "boolean") {
      throw new Error("worktree branch must be boolean; object branch policies are not supported");
    }
    const suppliedPath = spec.path ?? null;
    const sourceRef = spec.ref && spec.ref.length > 0 ? spec.ref : "HEAD";
    const branchPolicy = spec.branch === true ? "generated" : "detached";
    const worktreeCheckoutKind = branchPolicy === "generated" ? "branch" : "detached";
    const retentionPolicy =
      spec.retention == null
        ? DEFAULT_WORKSPACE_RETENTION
        : validateWorkspaceRetention(spec.retention);
    const sourceInput = suppliedPath ?? this.ensureDefaultWorkspace(runId, atMs).workspacePath;
    const gitTarget = resolveGitRootTarget(sourceInput, sourceRef);
    const defaultPath = retainedWorkspacePath(this.workspaceStore, runId, workspaceId);
    const generatedBranch =
      branchPolicy === "generated" ? generatedWorktreeBranchName(runId, spec.key) : null;
    const identity = workspaceIdentity({
      key: spec.key,
      mode: "worktree",
      sourcePath: gitTarget.target,
      sourceRef,
      retentionPolicy,
      branchPolicy,
      sdkAbiVersion: WORKFLOW_SDK_ABI_VERSION,
    });
    let worktreeAction: "none" | "detached-create" | "branch-create" | "branch-attach" = "none";
    let reuseExistingBranch = false;
    let actionRepoRoot = gitTarget.repoRoot;
    let actionBaseCommit = gitTarget.baseCommit;
    let actionBranch = generatedBranch;
    this.store.transaction(() => {
      const existing = this.store.getAgentWorkspace(runId, workspaceId);
      if (!existing) {
        this.store.insertAgentWorkspace({
          runId,
          workspaceId,
          mode: "worktree",
          ownerKind: "workflow",
          key: spec.key,
          lastAttempt: null,
          retentionPolicy,
          workspacePath: defaultPath,
          sourceKind: "worktree-git",
          sourcePath: gitTarget.target,
          sourceUri: null,
          sourceBare: null,
          sourceMergeEligible: true,
          suppliedPath,
          sourceRef,
          resolvedRef: sourceRef,
          checkoutBranch: generatedBranch,
          worktreeCheckoutKind,
          worktreeBranchOwned: branchPolicy === "generated",
          baseCommit: gitTarget.baseCommit,
          copyBaselinePath: null,
          creationErrorJson: null,
          workspaceIdentityJson: identity.json,
          workspaceIdentityHash: identity.hash,
          owned: true,
          status: "creating",
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
          createdAtMs: atMs,
          updatedAtMs: atMs,
          mergedAtMs: null,
          discardedAtMs: null,
          removedAtMs: null,
        });
        worktreeAction = branchPolicy === "generated" ? "branch-create" : "detached-create";
        return;
      }
      if (existing.workspaceIdentityHash !== identity.hash) {
        throw new Error(
          `workspace "${spec.key}" identity changed; use a new workspace key or a fresh run`,
        );
      }
      if (existing.status === "creating") {
        if (branchPolicy === "generated") {
          if (
            !this.isCreatingWorkspaceBeforeProviderAcquisition(existing) ||
            existing.checkoutBranch !== generatedBranch
          ) {
            throw new Error(
              `workspace "${spec.key}" has an existing branch creation state that is not eligible for recovery`,
            );
          }
          const existingBranch = existing.checkoutBranch;
          if (!existingBranch) throw new Error(`workspace "${spec.key}" has no persisted branch`);
          actionBranch = existingBranch;
          actionBaseCommit = existing.baseCommit ?? gitTarget.baseCommit;
          reuseExistingBranch = branchExists(gitTarget.repoRoot, existingBranch);
          worktreeAction = "branch-create";
        } else if (!existsSync(existing.workspacePath)) {
          worktreeAction = "detached-create";
        }
      }
      if (existing.status === "removed") {
        if (this.store.hasAgentSessionUsingWorkspace(runId, workspaceId)) {
          throw new Error(
            `workspace "${spec.key}" was removed and is referenced by an existing agent session; start a fresh run or use retention retain-on-failure/retain`,
          );
        }
        if (branchPolicy === "generated") {
          if (!existing.checkoutBranch || !existing.sourcePath) {
            throw new Error(
              `branch-backed workspace "${spec.key}" was removed but has no persisted branch metadata`,
            );
          }
          if (!branchExists(existing.sourcePath, existing.checkoutBranch)) {
            throw new Error(
              `branch-backed workspace "${spec.key}" cannot be reattached because branch ${existing.checkoutBranch} is missing`,
            );
          }
          actionRepoRoot = existing.sourcePath;
          actionBranch = existing.checkoutBranch;
          worktreeAction = "branch-attach";
        } else {
          worktreeAction = "detached-create";
        }
        this.store.updateAgentWorkspace(runId, workspaceId, {
          status: "creating",
          workspacePath: defaultPath,
          sourcePath: gitTarget.target,
          sourceKind: "worktree-git",
          sourceUri: null,
          sourceBare: null,
          sourceMergeEligible: true,
          suppliedPath,
          sourceRef,
          resolvedRef: sourceRef,
          checkoutBranch: branchPolicy === "generated" ? existing.checkoutBranch : null,
          worktreeCheckoutKind,
          worktreeBranchOwned: branchPolicy === "generated",
          baseCommit: branchPolicy === "generated" ? existing.baseCommit : gitTarget.baseCommit,
          copyBaselinePath: null,
          creationErrorJson: null,
          workspaceIdentityJson: identity.json,
          workspaceIdentityHash: identity.hash,
          retentionPolicy,
          failureSeen: false,
          lastDiffEventSeq: null,
          lastErrorEventSeq: null,
          cleanupErrorJson: null,
          mergedAtMs: null,
          discardedAtMs: null,
          removedAtMs: null,
          updatedAtMs: atMs,
        });
      }
    });
    if (worktreeAction !== "none") {
      try {
        if (worktreeAction === "branch-create") {
          if (!actionBranch) throw new Error("generated worktree branch was not computed");
          createBranchBackedWorktree(actionRepoRoot, defaultPath, actionBaseCommit, actionBranch, {
            reuseExistingBranch,
          });
        } else if (worktreeAction === "branch-attach") {
          if (!actionBranch) throw new Error("persisted worktree branch was not recorded");
          attachBranchBackedWorktree(actionRepoRoot, defaultPath, actionBranch);
        } else {
          createRetainedWorktree(gitTarget.repoRoot, defaultPath, gitTarget.baseCommit);
        }
        this.store.updateAgentWorkspace(runId, workspaceId, {
          status: "idle",
          creationErrorJson: null,
          updatedAtMs: atMs,
        });
      } catch (err) {
        const branchAlreadyExisted =
          branchPolicy === "generated" && err instanceof BranchAlreadyExistsError;
        const patch: Partial<
          Pick<
            AgentWorkspaceRow,
            | "status"
            | "failureSeen"
            | "creationErrorJson"
            | "checkoutBranch"
            | "worktreeBranchOwned"
            | "updatedAtMs"
          >
        > = {
          status: branchPolicy === "generated" && !branchAlreadyExisted ? "creating" : "abandoned",
          failureSeen: true,
          creationErrorJson: JSON.stringify(serializeError(err)),
          ...(branchAlreadyExisted ? { checkoutBranch: null, worktreeBranchOwned: false } : {}),
          updatedAtMs: this.host.clock(),
        };
        this.store.updateAgentWorkspace(runId, workspaceId, patch);
        throw err;
      }
    }
    return await this.ensureWorkspaceSetup(runId, spec, workspaceId, identity.hash, atMs);
  }

  private ensureDefaultWorkspace(runId: string, atMs: number): AgentWorkspaceRow {
    const runTarget = requireRunTarget(
      this.store.getRun(runId)?.runTarget,
      "run default workspace target",
    );
    const path = resolveUsableDirectory(runTarget);
    const identity = workspaceIdentity({
      key: DEFAULT_WORKSPACE_ID,
      mode: "direct",
      ownerKind: "workflow",
      path,
      sdkAbiVersion: WORKFLOW_SDK_ABI_VERSION,
    });
    let row = this.store.getAgentWorkspace(runId, DEFAULT_WORKSPACE_ID);
    if (!row) {
      this.store.insertAgentWorkspace({
        runId,
        workspaceId: DEFAULT_WORKSPACE_ID,
        mode: "direct",
        ownerKind: "workflow",
        key: DEFAULT_WORKSPACE_ID,
        lastAttempt: null,
        retentionPolicy: null,
        workspacePath: path,
        sourceKind: "direct-path",
        sourcePath: path,
        sourceUri: null,
        sourceBare: null,
        sourceMergeEligible: false,
        suppliedPath: runTarget,
        sourceRef: null,
        resolvedRef: null,
        checkoutBranch: null,
        baseCommit: null,
        copyBaselinePath: null,
        creationErrorJson: null,
        workspaceIdentityJson: identity.json,
        workspaceIdentityHash: identity.hash,
        owned: false,
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
        createdAtMs: atMs,
        updatedAtMs: atMs,
        mergedAtMs: null,
        discardedAtMs: null,
        removedAtMs: null,
      });
      row = this.store.getAgentWorkspace(runId, DEFAULT_WORKSPACE_ID);
    }
    if (!row) throw new Error("failed to create run default workspace");
    if (row.workspaceIdentityHash !== identity.hash) {
      throw new Error("run default workspace identity changed; refusing to continue");
    }
    return row;
  }

  private isCreatingWorkspaceBeforeProviderAcquisition(row: AgentWorkspaceRow): boolean {
    return (
      row.status === "creating" &&
      row.activeHolderKind === null &&
      row.activeHolderKey === null &&
      row.activeHolderAttempt === null &&
      row.lastAttempt === null &&
      row.lastTurnKey === null &&
      row.lastTurnAttempt === null
    );
  }

  private async ensureWorkspaceSetup(
    runId: string,
    spec: WorkspaceSpecMessage,
    workspaceId: string,
    workspaceIdentityHash: string,
    atMs: number,
  ): Promise<{ id: string; identityHash: string; setupIdentityHash?: string | null }> {
    const row = this.store.getAgentWorkspace(runId, workspaceId);
    if (!row) throw new Error(`workspace ${runId}/${workspaceId} not found after creation`);
    const setup = normalizeWorkspaceSetupSpec(spec.setup, {
      path: `workspace "${spec.key}".setup`,
      workspaceId,
      workspaceIdentityHash,
    });
    if (!setup) {
      return {
        id: workspaceId,
        identityHash: workspaceIdentityHash,
        ...(row.setupIdentityHash ? { setupIdentityHash: row.setupIdentityHash } : {}),
      };
    }
    if (row.setupIdentityHash && row.setupIdentityHash !== setup.identityHash) {
      throw new Error(
        `workspace "${spec.key}" setup identity changed; use a new workspace key or a fresh run`,
      );
    }
    if (row.setupStatus === "completed" && row.setupIdentityHash === setup.identityHash) {
      return {
        id: workspaceId,
        identityHash: workspaceIdentityHash,
        setupIdentityHash: setup.identityHash,
      };
    }
    if (row.setupStatus === "failed" && row.setupIdentityHash === setup.identityHash) {
      const error = row.setupErrorJson ? JSON.parse(row.setupErrorJson) : null;
      throw new Error(
        `workspace "${spec.key}" setup previously failed: ${error?.message ?? "unknown error"}`,
      );
    }
    const activeKey = `${runId}\0${workspaceId}\0${setup.identityHash}`;
    const active = this.activeWorkspaceSetups.get(activeKey);
    if (active) {
      await active;
    } else {
      const running = this.runWorkspaceSetup(runId, row, setup, atMs);
      this.activeWorkspaceSetups.set(activeKey, running);
      try {
        await running;
      } finally {
        if (this.activeWorkspaceSetups.get(activeKey) === running) {
          this.activeWorkspaceSetups.delete(activeKey);
        }
      }
    }
    return {
      id: workspaceId,
      identityHash: workspaceIdentityHash,
      setupIdentityHash: setup.identityHash,
    };
  }

  private async runWorkspaceSetup(
    runId: string,
    row: AgentWorkspaceRow,
    setup: NormalizedWorkspaceSetupSpec,
    atMs: number,
  ): Promise<void> {
    this.store.transaction(() => {
      const current = this.store.getAgentWorkspace(runId, row.workspaceId);
      if (!current) throw new Error(`workspace ${runId}/${row.workspaceId} not found`);
      const staleSetupHolder =
        current.activeHolderKind === "setup" &&
        current.activeHolderKey === setup.identityHash &&
        current.setupStatus === "pending";
      if (current.activeHolderKind && !staleSetupHolder) {
        throw new Error(
          `workspace "${row.workspaceId}" is already active for ${current.activeHolderKind} "${current.activeHolderKey}" attempt ${current.activeHolderAttempt}`,
        );
      }
      this.store.updateAgentWorkspace(runId, row.workspaceId, {
        setupIdentityJson: JSON.stringify(setup.identity),
        setupIdentityHash: setup.identityHash,
        setupStatus: "pending",
        setupStartedAtMs: current.setupStartedAtMs ?? atMs,
        setupFinishedAtMs: null,
        setupErrorJson: null,
        activeHolderKind: "setup",
        activeHolderKey: setup.identityHash,
        activeHolderAttempt: null,
        activeStartedAtMs: atMs,
        updatedAtMs: atMs,
      });
      if (current.setupStatus !== "pending") {
        this.store.appendEvent(
          runId,
          "workspace.setup.started",
          workspaceSetupStartedEvent({
            workspaceId: row.workspaceId,
            workspaceKey: row.key,
            mode: row.mode,
            workspacePath: row.workspacePath,
            setupIdentityHash: setup.identityHash,
            commandCount: setup.commands.length,
          }),
          atMs,
        );
      }
    });

    try {
      for (const setupCommand of setup.commands) {
        const command = setupCommandToWorkflowCommand(
          row.workspaceId,
          row.workspaceIdentityHash,
          setup,
          setupCommand,
        );
        await this.runWorkspaceSetupCommand(runId, row, setup, command);
      }
      const finishedAtMs = this.host.clock();
      this.store.transaction(() => {
        this.store.appendEvent(
          runId,
          "workspace.setup.completed",
          workspaceSetupCompletedEvent({
            workspaceId: row.workspaceId,
            workspaceKey: row.key,
            mode: row.mode,
            workspacePath: row.workspacePath,
            setupIdentityHash: setup.identityHash,
            durationMs: Math.max(0, finishedAtMs - atMs),
          }),
          finishedAtMs,
        );
        this.store.updateAgentWorkspace(runId, row.workspaceId, {
          setupStatus: "completed",
          setupFinishedAtMs: finishedAtMs,
          setupErrorJson: null,
          activeHolderKind: null,
          activeHolderKey: null,
          activeHolderAttempt: null,
          activeStartedAtMs: null,
          updatedAtMs: finishedAtMs,
        });
      });
    } catch (err) {
      const finishedAtMs = this.host.clock();
      const error = serializeError(err);
      this.store.transaction(() => {
        this.store.appendEvent(
          runId,
          "workspace.setup.failed",
          workspaceSetupFailedEvent({
            workspaceId: row.workspaceId,
            workspaceKey: row.key,
            mode: row.mode,
            workspacePath: row.workspacePath,
            setupIdentityHash: setup.identityHash,
            error,
          }),
          finishedAtMs,
        );
        this.store.updateAgentWorkspace(runId, row.workspaceId, {
          setupStatus: "failed",
          setupFinishedAtMs: finishedAtMs,
          setupErrorJson: JSON.stringify(error),
          failureSeen: true,
          activeHolderKind: null,
          activeHolderKey: null,
          activeHolderAttempt: null,
          activeStartedAtMs: null,
          updatedAtMs: finishedAtMs,
        });
      });
      throw err;
    }
  }

  private async runWorkspaceSetupCommand(
    runId: string,
    row: AgentWorkspaceRow,
    setup: NormalizedWorkspaceSetupSpec,
    command: NormalizedWorkflowCommandSpec,
  ): Promise<void> {
    this.assertRunCapabilities(runId, setup.capabilities, `workspace "${row.key}" setup`);
    const version = hashJson(command.identity);
    const inputHash = hashJson(command.identity);
    const existing = this.store.getLatestAttempt(runId, command.stableKey);
    if (existing?.status === "completed") {
      if (existing.inputHash !== inputHash || existing.version !== version) {
        throw new Error(
          `completed workspace setup command "${command.key}" identity changed; use a new workspace key or fresh run`,
        );
      }
      const replayed = readJournalResult(this.store, existing) as CommandResult;
      if (replayed.error) throw new CommandFailure(replayed);
      return;
    }
    if (existing && existing.status !== "pending") {
      if (existing.inputHash !== inputHash || existing.version !== version) {
        throw new Error(
          `workspace setup command "${command.key}" identity changed; use a new workspace key or fresh run`,
        );
      }
    }
    const attempt =
      existing?.status === "pending" ? existing.attempt : existing ? existing.attempt + 1 : 1;
    const startedAtMs =
      existing?.status === "pending" && existing.startedAtMs
        ? existing.startedAtMs
        : this.host.clock();
    if (existing?.status !== "pending") {
      this.store.putJournalRow({
        runId,
        stableKey: command.stableKey,
        attempt,
        effectType: "workspace_setup",
        status: "pending",
        version,
        inputHash,
        inputDeps: null,
        startedAtMs,
      });
      this.host.fault?.("after-pending", command.stableKey);
    }
    this.store.appendEvent(
      runId,
      "workspace.setup.command.started",
      {
        setupIdentityHash: setup.identityHash,
        ...(commandStartedEvent(command, attempt) as Record<string, unknown>),
      },
      startedAtMs,
    );
    const cwd = this.resolveSetupCommandCwd(row, command);
    const env = this.resolveWorkspaceSetupEnvironment(runId, command);
    const result = await runBoundedProcess({
      command,
      attempt,
      cwd,
      env,
    });
    this.completeWorkspaceSetupCommand(
      runId,
      setup,
      command,
      {
        attempt,
        version,
        inputHash,
        startedAtMs,
      },
      result,
    );
    if (result.error) throw new CommandFailure(result);
  }

  private resolveSetupCommandCwd(
    row: AgentWorkspaceRow,
    command: NormalizedWorkflowCommandSpec,
  ): string {
    if (!existsSync(row.workspacePath) || !statSync(row.workspacePath).isDirectory()) {
      throw new Error(`workspace "${row.workspaceId}" is missing at ${row.workspacePath}`);
    }
    const workspacePath = realpathSync(row.workspacePath);
    const candidate = command.cwd === "." ? workspacePath : resolve(workspacePath, command.cwd);
    const resolvedCwd = realpathSync(candidate);
    if (!statSync(resolvedCwd).isDirectory()) {
      throw new Error(`workspace setup cwd "${command.cwd}" is not a directory`);
    }
    const rel = relative(workspacePath, resolvedCwd);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(
        `workspace setup cwd "${command.cwd}" escapes workspace "${row.workspaceId}"`,
      );
    }
    return resolvedCwd;
  }

  private resolveWorkspaceSetupEnvironment(
    runId: string,
    command: NormalizedWorkflowCommandSpec,
  ): Record<string, string> {
    if (command.environment.secrets.length === 0) {
      return buildWorkspaceSetupEnvironment(command.environment, []);
    }
    if (!this.secrets) {
      throw new Error("workspace setup environment.secrets requires a RealmKernel SecretStore");
    }
    const refs = this.secrets.resolveOrThrow(runId, command.environment.secrets);
    return buildWorkspaceSetupEnvironment(command.environment, refs);
  }

  private completeWorkspaceSetupCommand(
    runId: string,
    setup: NormalizedWorkspaceSetupSpec,
    command: NormalizedWorkflowCommandSpec,
    begun: {
      attempt: number;
      version: string;
      inputHash: string;
      startedAtMs: number;
    },
    result: CommandResult,
  ): CommandResult {
    this.host.fault?.("before-commit", command.stableKey);
    let completed: CommandResult = {
      ...result,
      output: { ...result.output, resultArtifactBacked: false },
    };
    let stored = prepareStepResult(completed);
    if (stored.artifact) {
      completed = {
        ...result,
        output: { ...result.output, resultArtifactBacked: true },
      };
      stored = prepareStepResult(completed);
    }
    const finishedAtMs = this.host.clock();
    this.store.transaction(() => {
      if (stored.artifact) {
        this.store.putArtifact(stored.artifact.hash, stored.artifact.bytes, finishedAtMs);
      }
      this.store.appendEvent(
        runId,
        result.error ? "workspace.setup.command.failed" : "workspace.setup.command.completed",
        {
          setupIdentityHash: setup.identityHash,
          ...(commandCompletedEvent(command, completed) as Record<string, unknown>),
        },
        finishedAtMs,
      );
      this.store.putJournalRow({
        runId,
        stableKey: command.stableKey,
        attempt: begun.attempt,
        effectType: "workspace_setup",
        status: "completed",
        version: begun.version,
        inputHash: begun.inputHash,
        inputDeps: null,
        resultInline: stored.inline,
        resultArtifact: stored.artifact?.hash ?? null,
        startedAtMs: begun.startedAtMs,
        finishedAtMs,
      });
    });
    return completed;
  }

  private beginInvocationWorkspace(
    runId: string,
    workspaceId: string,
    setupIdentityHash: string | null,
    holder: WorkspaceHolder,
    atMs: number,
  ): InvocationWorkspace {
    const row =
      workspaceId === DEFAULT_WORKSPACE_ID
        ? this.ensureDefaultWorkspace(runId, atMs)
        : this.store.getAgentWorkspace(runId, workspaceId);
    if (!row) throw new Error(`workspace handle "${workspaceId}" was not created in this run`);
    this.assertWorkspaceSetupReadyForInvocation(row, setupIdentityHash);
    if (row.mode === "direct") {
      const sameHolder =
        row.activeHolderKind === holder.kind &&
        row.activeHolderKey === holder.key &&
        row.activeHolderAttempt === holder.attempt;
      if (row.activeHolderKind && !sameHolder) {
        throw new Error(
          `workspace "${row.workspaceId}" is already active for ${row.activeHolderKind} "${row.activeHolderKey}" attempt ${row.activeHolderAttempt}`,
        );
      }
      if (row.status !== "idle" && row.status !== "diff_error" && row.status !== "active") {
        throw new Error(`workspace "${row.workspaceId}" is ${row.status} and cannot start`);
      }
      assertUsableTargetDirectory(row.workspacePath);
      return {
        cwd: row.workspacePath,
        workspaceId: row.workspaceId,
        workspacePath: row.workspacePath,
        sourcePath: row.sourcePath,
        mode: row.mode,
        owned: false,
      };
    }
    if (!row.owned) throw new Error(`workspace ${row.workspaceId} is not owned by Keel`);
    if (!existsSync(row.workspacePath)) {
      this.store.updateAgentWorkspace(runId, row.workspaceId, {
        status: "abandoned",
        failureSeen: true,
        updatedAtMs: this.host.clock(),
      });
      throw new Error(`workspace "${row.workspaceId}" is missing at ${row.workspacePath}`);
    }
    if (row.mode === "copy" && !existsSync(row.copyBaselinePath ?? "")) {
      this.store.updateAgentWorkspace(runId, row.workspaceId, {
        status: "abandoned",
        failureSeen: true,
        updatedAtMs: this.host.clock(),
      });
      throw new Error(`copy workspace "${row.workspaceId}" is missing baseline snapshot`);
    }
    if ((row.mode === "clone" || row.mode === "worktree") && !row.baseCommit) {
      throw new Error(`${row.mode} workspace "${row.workspaceId}" is missing base commit`);
    }
    if (row.mode === "worktree" && row.worktreeCheckoutKind === "branch") {
      const baseCommit = row.baseCommit;
      if (!baseCommit)
        throw new Error(`worktree workspace "${row.workspaceId}" is missing base commit`);
      if (!row.sourcePath || !row.checkoutBranch) {
        throw new Error(`branch-backed workspace "${row.workspaceId}" is missing branch metadata`);
      }
      if (!branchExists(row.sourcePath, row.checkoutBranch)) {
        throw new Error(
          `branch-backed workspace "${row.workspaceId}" expected branch ${row.checkoutBranch} but it is missing`,
        );
      }
      if (!branchContainsCommit(row.sourcePath, row.checkoutBranch, baseCommit)) {
        throw new Error(
          `branch-backed workspace "${row.workspaceId}" expected branch ${row.checkoutBranch} to contain base commit ${baseCommit}`,
        );
      }
    }
    this.store.transaction(() => {
      const current = this.store.getAgentWorkspace(runId, row.workspaceId);
      if (!current) throw new Error(`workspace ${runId}/${row.workspaceId} not found`);
      const sameHolder =
        current.activeHolderKind === holder.kind &&
        current.activeHolderKey === holder.key &&
        current.activeHolderAttempt === holder.attempt;
      if (current.activeHolderKind && !sameHolder) {
        throw new Error(
          `workspace "${row.workspaceId}" is already active for ${current.activeHolderKind} "${current.activeHolderKey}" attempt ${current.activeHolderAttempt}`,
        );
      }
      if (
        current.status !== "idle" &&
        current.status !== "diff_error" &&
        current.status !== "active" &&
        current.status !== "creating"
      ) {
        throw new Error(`workspace "${row.workspaceId}" is ${current.status} and cannot start`);
      }
      this.store.updateAgentWorkspace(runId, row.workspaceId, {
        status: "active",
        lastAttempt: holder.kind === "agent" ? holder.attempt : current.lastAttempt,
        lastTurnKey: current.lastTurnKey,
        lastTurnAttempt: current.lastTurnAttempt,
        activeHolderKind: holder.kind,
        activeHolderKey: holder.key,
        activeHolderAttempt: holder.attempt,
        activeStartedAtMs: atMs,
        updatedAtMs: atMs,
      });
    });
    return {
      cwd: row.workspacePath,
      workspaceId: row.workspaceId,
      workspacePath: row.workspacePath,
      sourcePath: row.sourcePath,
      ...(row.sourceRef ? { sourceRef: row.sourceRef } : {}),
      ...(row.baseCommit ? { baseCommit: row.baseCommit } : {}),
      ...(row.copyBaselinePath ? { copyBaselinePath: row.copyBaselinePath } : {}),
      mode: row.mode,
      owned: true,
    };
  }

  private assertWorkspaceSetupReadyForInvocation(
    row: AgentWorkspaceRow,
    setupIdentityHash: string | null,
  ): void {
    if (row.setupIdentityHash === null && row.setupStatus === "none") return;
    if (setupIdentityHash === null || row.setupIdentityHash !== setupIdentityHash) {
      throw new Error(
        `workspace "${row.workspaceId}" setup identity changed; refusing to run agent`,
      );
    }
    if (row.setupStatus === "failed") {
      throw new Error(`workspace "${row.workspaceId}" setup failed; refusing to run agent`);
    }
    if (row.setupStatus !== "completed") {
      throw new Error(
        `workspace "${row.workspaceId}" setup is ${row.setupStatus}; refusing to run agent`,
      );
    }
  }

  private resolveCommandWorkspaceCwd(
    runId: string,
    command: NormalizedWorkflowCommandSpec,
  ): CommandWorkspace {
    const row = this.store.getAgentWorkspace(runId, command.workspaceId);
    if (!row) {
      throw new Error(`workspace handle "${command.workspaceId}" was not created in this run`);
    }
    if (
      command.workspaceIdentityHash !== null &&
      row.workspaceIdentityHash !== command.workspaceIdentityHash
    ) {
      throw new Error(
        `workspace "${command.workspaceId}" identity changed; refusing to run command`,
      );
    }
    if (command.setupIdentityHash !== null && row.setupIdentityHash !== command.setupIdentityHash) {
      throw new Error(
        `workspace "${command.workspaceId}" setup identity changed; refusing to run command`,
      );
    }
    if (row.setupStatus === "failed") {
      throw new Error(`workspace "${command.workspaceId}" setup failed; refusing to run command`);
    }
    if (row.activeHolderKind !== null) {
      throw new Error(
        `workspace "${row.workspaceId}" is already active for ${row.activeHolderKind} "${row.activeHolderKey}" attempt ${row.activeHolderAttempt}`,
      );
    }
    if (row.status !== "idle" && row.status !== "diff_error") {
      throw new Error(`workspace "${row.workspaceId}" is ${row.status} and cannot run commands`);
    }
    if (!existsSync(row.workspacePath) || !statSync(row.workspacePath).isDirectory()) {
      if (row.owned) {
        this.store.updateAgentWorkspace(runId, row.workspaceId, {
          status: "abandoned",
          failureSeen: true,
          updatedAtMs: this.host.clock(),
        });
      }
      throw new Error(`workspace "${row.workspaceId}" is missing at ${row.workspacePath}`);
    }

    const workspacePath = realpathSync(row.workspacePath);
    const candidate = command.cwd === "." ? workspacePath : resolve(workspacePath, command.cwd);
    const resolvedCwd = realpathSync(candidate);
    if (!statSync(resolvedCwd).isDirectory()) {
      throw new Error(`command cwd "${command.cwd}" is not a directory`);
    }
    const rel = relative(workspacePath, resolvedCwd);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`command cwd "${command.cwd}" escapes workspace "${row.workspaceId}"`);
    }
    return {
      workspaceId: row.workspaceId,
      workspacePath,
      resolvedCwd,
      owned: row.owned,
    };
  }

  private acquireCommandWorkspace(
    runId: string,
    command: NormalizedWorkflowCommandSpec,
    attempt: number,
    atMs: number,
  ): void {
    this.store.transaction(() => {
      const current = this.store.getAgentWorkspace(runId, command.workspaceId);
      if (!current) throw new Error(`workspace ${runId}/${command.workspaceId} not found`);
      if (current.activeHolderKind) {
        throw new Error(
          `workspace "${current.workspaceId}" is already active for ${current.activeHolderKind} "${current.activeHolderKey}" attempt ${current.activeHolderAttempt}`,
        );
      }
      if (current.status !== "idle" && current.status !== "diff_error") {
        throw new Error(
          `workspace "${current.workspaceId}" is ${current.status} and cannot run commands`,
        );
      }
      this.store.updateAgentWorkspace(runId, command.workspaceId, {
        status: "active",
        activeHolderKind: "command",
        activeHolderKey: command.stableKey,
        activeHolderAttempt: attempt,
        activeStartedAtMs: atMs,
        updatedAtMs: atMs,
      });
    });
  }

  private releaseCommandWorkspaceHolderInTransaction(
    runId: string,
    workspaceId: string,
    command: NormalizedWorkflowCommandSpec,
    attempt: number,
    atMs: number,
  ): void {
    const row = this.store.getAgentWorkspace(runId, workspaceId);
    if (!row) return;
    if (
      row.activeHolderKind &&
      (row.activeHolderKind !== "command" ||
        row.activeHolderKey !== command.stableKey ||
        row.activeHolderAttempt !== attempt)
    ) {
      throw new Error(`workspace "${workspaceId}" active holder changed while command was running`);
    }
    const workspaceExists =
      existsSync(row.workspacePath) && statSync(row.workspacePath).isDirectory();
    this.store.updateAgentWorkspace(runId, workspaceId, {
      status: workspaceExists || !row.owned ? "idle" : "abandoned",
      ...(workspaceExists || !row.owned ? {} : { failureSeen: true }),
      activeHolderKind: null,
      activeHolderKey: null,
      activeHolderAttempt: null,
      activeStartedAtMs: null,
      updatedAtMs: atMs,
    });
  }

  private completeCommandResult(
    runId: string,
    command: NormalizedWorkflowCommandSpec,
    begun: {
      attempt: number;
      inputHash: string;
      startedAtMs: number;
      version: string;
      inputDeps: InputDep[] | null;
    },
    result: CommandResult,
  ): CommandResult {
    this.host.fault?.("before-commit", command.stableKey);
    let completed: CommandResult = {
      ...result,
      output: { ...result.output, resultArtifactBacked: false },
    };
    let stored = prepareStepResult(completed);
    if (stored.artifact) {
      completed = {
        ...result,
        output: { ...result.output, resultArtifactBacked: true },
      };
      stored = prepareStepResult(completed);
    }
    const finishedAtMs = this.host.clock();
    this.store.transaction(() => {
      if (stored.artifact) {
        this.store.putArtifact(stored.artifact.hash, stored.artifact.bytes, finishedAtMs);
      }
      this.store.appendEvent(
        runId,
        "command.completed",
        commandCompletedEvent(command, completed),
        finishedAtMs,
      );
      this.store.putJournalRow({
        runId,
        stableKey: command.stableKey,
        attempt: begun.attempt,
        effectType: "command",
        status: "completed",
        version: begun.version,
        inputHash: begun.inputHash,
        inputDeps: begun.inputDeps,
        resultInline: stored.inline,
        resultArtifact: stored.artifact?.hash ?? null,
        startedAtMs: begun.startedAtMs,
        finishedAtMs,
      });
      this.releaseCommandWorkspaceHolderInTransaction(
        runId,
        command.workspaceId,
        command,
        begun.attempt,
        finishedAtMs,
      );
    });
    return completed;
  }

  private completeCompletionCheckResult(
    runId: string,
    result: CompletionCheckResult,
    spec: Parameters<typeof completionCheckCompletedEvent>[0],
    begun: {
      attempt: number;
      inputHash: string;
      startedAtMs: number;
      version: string;
      inputDeps: InputDep[] | null;
    },
  ): CompletionCheckResult {
    this.host.fault?.("before-commit", spec.stableKey);
    const stored = prepareStepResult(result);
    const finishedAtMs = this.host.clock();
    this.store.transaction(() => {
      if (stored.artifact) {
        this.store.putArtifact(stored.artifact.hash, stored.artifact.bytes, finishedAtMs);
      }
      this.store.appendEvent(
        runId,
        "completion_check.completed",
        completionCheckCompletedEvent(spec, result),
        finishedAtMs,
      );
      this.store.putJournalRow({
        runId,
        stableKey: spec.stableKey,
        attempt: begun.attempt,
        effectType: "completion_check",
        status: "completed",
        version: begun.version,
        inputHash: begun.inputHash,
        inputDeps: begun.inputDeps,
        resultInline: stored.inline,
        resultArtifact: stored.artifact?.hash ?? null,
        startedAtMs: begun.startedAtMs,
        finishedAtMs,
      });
    });
    return result;
  }

  private releaseWorkspaceHolder(
    runId: string,
    workspaceId: string | undefined,
    holder: WorkspaceHolder,
    patch: Partial<
      Pick<
        AgentWorkspaceRow,
        | "status"
        | "failureSeen"
        | "lastTurnKey"
        | "lastTurnAttempt"
        | "lastDiffEventSeq"
        | "lastErrorEventSeq"
        | "updatedAtMs"
      >
    >,
  ): void {
    if (!workspaceId) return;
    const row = this.store.getAgentWorkspace(runId, workspaceId);
    if (!row?.owned) {
      if (patch.failureSeen) {
        this.store.updateAgentWorkspace(runId, workspaceId, {
          failureSeen: true,
          updatedAtMs: patch.updatedAtMs ?? this.host.clock(),
        });
      }
      return;
    }
    if (
      row.status === "removed" ||
      row.status === "pending_review" ||
      row.status === "merged" ||
      row.status === "discarded" ||
      row.status === "abandoned" ||
      row.status === "cleanup_error"
    ) {
      return;
    }
    if (
      row.activeHolderKind &&
      (row.activeHolderKind !== holder.kind ||
        row.activeHolderKey !== holder.key ||
        row.activeHolderAttempt !== holder.attempt)
    ) {
      throw new Error(
        `workspace "${workspaceId}" active holder changed while provider was running`,
      );
    }
    this.store.updateAgentWorkspace(runId, workspaceId, {
      ...patch,
      activeHolderKind: null,
      activeHolderKey: null,
      activeHolderAttempt: null,
      activeStartedAtMs: null,
    });
  }

  private recoverActiveWorkspaceHolders(runId: string, atMs: number): void {
    for (const row of this.store.listAgentWorkspaces(runId, { includeRemoved: true })) {
      if (!row.activeHolderKind) continue;
      this.store.updateAgentWorkspace(runId, row.workspaceId, {
        status: row.owned && !existsSync(row.workspacePath) ? "abandoned" : "idle",
        ...(row.owned && !existsSync(row.workspacePath) ? { failureSeen: true } : {}),
        activeHolderKind: null,
        activeHolderKey: null,
        activeHolderAttempt: null,
        activeStartedAtMs: null,
        updatedAtMs: atMs,
      });
    }
  }

  private resetFailedWorkspaceSetupsForRetry(runId: string, atMs: number): void {
    const failedWorkspaces = this.store
      .listAgentWorkspaces(runId, { includeRemoved: true })
      .filter((row) => row.setupStatus === "failed");
    if (failedWorkspaces.length === 0) return;
    this.store.deleteWorkspaceSetupRowsByStableKeyPrefix(
      runId,
      failedWorkspaces.map((row) => `${WORKSPACE_SETUP_STABLE_KEY_PREFIX}${row.workspaceId}.`),
    );
    for (const row of failedWorkspaces) {
      this.store.updateAgentWorkspace(runId, row.workspaceId, {
        setupStatus: "none",
        setupStartedAtMs: null,
        setupFinishedAtMs: null,
        setupErrorJson: null,
        activeHolderKind: null,
        activeHolderKey: null,
        activeHolderAttempt: null,
        activeStartedAtMs: null,
        updatedAtMs: atMs,
      });
    }
  }

  private beginAgentSessionTurn(
    runId: string,
    m: Extract<WorkerRequest, { type: "agent-turn" }>,
    provider: AgentProvider,
  ):
    | { kind: "replay"; value: unknown }
    | {
        kind: "execute";
        attempt: number;
        inputHash: string;
        startedAtMs: number;
        cwd: string;
        workspaceId?: string;
        workspacePath?: string;
        workspaceTarget?: string | null;
        workspaceBaseCommit?: string;
        workspaceCopyBaselinePath?: string;
        workspaceMode?: AgentWorkspaceRow["mode"];
        workspaceOwned?: boolean;
        resumeToken?: string;
      } {
    if (!provider.supportsSessions) {
      throw new Error(`agent provider "${m.provider}" does not support durable sessions`);
    }
    const inputHash = hashJson(m.inputs as Json);
    const startedAtMs = this.host.clock();
    const preflight = this.store.transaction(() => {
      let session = this.store.getAgentSession(runId, m.agentKey);
      if (!session) {
        this.store.insertAgentSession({
          runId,
          agentKey: m.agentKey,
          identityHash: m.identityHash,
          identityJson: m.identityJson,
          currentSessionToken: null,
          latestCompletedTurnKey: null,
          latestCompletedAttempt: null,
          activeTurnKey: null,
          activeTurnAttempt: null,
          createdAtMs: startedAtMs,
          updatedAtMs: startedAtMs,
        });
        session = this.store.getAgentSession(runId, m.agentKey);
      }
      if (!session) throw new Error(`failed to create agent session "${m.agentKey}"`);
      if (session.identityHash !== m.identityHash) {
        throw new Error(
          `agent session "${m.agentKey}" identity changed; use a new participant key or a fresh run`,
        );
      }

      const existing = this.store.getLatestAttempt(runId, m.stableKey);
      if (existing && (existing.inputHash !== inputHash || existing.version !== m.version)) {
        throw new Error(
          `agent session "${m.agentKey}" turn "${m.turnKey}" identity changed; use a new turn key or a fresh run`,
        );
      }
      if (existing?.status === "completed") {
        return { kind: "replay" as const, value: readJournalResult(this.store, existing) };
      }

      const resuming = existing?.status === "pending";
      const attempt = resuming ? existing.attempt : existing ? existing.attempt + 1 : 1;
      if (
        session.activeTurnKey &&
        (session.activeTurnKey !== m.turnKey || session.activeTurnAttempt !== attempt)
      ) {
        throw new Error(
          `agent session "${m.agentKey}" already has active turn "${session.activeTurnKey}"`,
        );
      }

      const turn = this.store.getLatestAgentSessionTurn(runId, m.agentKey, m.turnKey);
      const startedSessionToken = resuming
        ? (turn?.observedSessionToken ??
          turn?.startedSessionToken ??
          existing?.sessionToken ??
          null)
        : session.currentSessionToken
          ? session.currentSessionToken
          : session.latestCompletedTurnKey === null
            ? null
            : undefined;
      if (startedSessionToken === undefined) {
        throw new Error(
          `agent session "${m.agentKey}" has no current session token for new turn "${m.turnKey}"`,
        );
      }
      return {
        kind: "execute" as const,
        attempt,
        inputHash,
        startedAtMs,
        startedSessionToken,
        ...(startedSessionToken ? { resumeToken: startedSessionToken } : {}),
      };
    });
    if (preflight.kind === "replay") return preflight;

    const holder: WorkspaceHolder = {
      kind: "agent_session",
      key: m.agentKey,
      attempt: preflight.attempt,
    };
    const workspace = this.beginInvocationWorkspace(
      runId,
      m.workspaceId,
      m.setupIdentityHash,
      holder,
      startedAtMs,
    );

    this.store.transaction(() => {
      this.store.putJournalRow({
        runId,
        stableKey: m.stableKey,
        attempt: preflight.attempt,
        effectType: "effectful",
        status: "pending",
        version: m.version,
        inputHash,
        inputDeps: m.deps,
        sessionToken: preflight.startedSessionToken,
        startedAtMs,
      });
      this.store.putAgentSessionTurn({
        runId,
        agentKey: m.agentKey,
        turnKey: m.turnKey,
        attempt: preflight.attempt,
        stableKey: m.stableKey,
        status: "pending",
        startedSessionToken: preflight.startedSessionToken,
        observedSessionToken: null,
        completedSessionToken: null,
        startedAtMs,
        finishedAtMs: null,
      });
      this.store.updateAgentSessionActive(
        runId,
        m.agentKey,
        m.turnKey,
        preflight.attempt,
        startedAtMs,
      );
      if (workspace.owned) {
        this.store.updateAgentWorkspace(runId, workspace.workspaceId, {
          lastTurnKey: m.turnKey,
          lastTurnAttempt: preflight.attempt,
          updatedAtMs: startedAtMs,
        });
      }
    });
    this.host.fault?.("after-pending", m.stableKey);
    return {
      kind: "execute" as const,
      attempt: preflight.attempt,
      inputHash,
      startedAtMs,
      cwd: workspace.cwd,
      workspaceId: workspace.workspaceId,
      workspacePath: workspace.workspacePath,
      workspaceTarget: workspace.sourcePath,
      workspaceOwned: workspace.owned,
      workspaceMode: workspace.mode,
      ...(workspace.baseCommit ? { workspaceBaseCommit: workspace.baseCommit } : {}),
      ...(workspace.copyBaselinePath
        ? { workspaceCopyBaselinePath: workspace.copyBaselinePath }
        : {}),
      ...(preflight.resumeToken ? { resumeToken: preflight.resumeToken } : {}),
    };
  }

  private beginAgentWorkspace(
    runId: string,
    m: Extract<WorkerRequest, { type: "agent" }>,
    attempt: number,
    startedAtMs: number,
  ): InvocationWorkspace {
    return this.beginInvocationWorkspace(
      runId,
      m.workspaceId,
      m.setupIdentityHash,
      { kind: "agent", key: m.key, attempt },
      startedAtMs,
    );
  }

  private captureAgentWorkspaceEvents(
    m: Extract<WorkerRequest, { type: "agent" }>,
    workspace: InvocationWorkspace,
  ): { events: DurableAgentEvent[]; status: "idle" | "diff_error" } {
    if (!workspace.owned) return { events: [], status: "idle" };
    try {
      const bundle =
        workspace.mode === "copy"
          ? diffCopyWorkspace(workspace.workspacePath, workspace.copyBaselinePath ?? "")
          : workspace.mode === "clone" || workspace.mode === "worktree"
            ? diffGitFinalTree(workspace.workspacePath, workspace.baseCommit ?? "HEAD")
            : (() => {
                throw new Error(`workspace mode ${workspace.mode} does not support diff`);
              })();
      return {
        status: "idle",
        events: [
          {
            type: "agent.diff",
            payload: {
              key: m.key,
              workspaceId: workspace.workspaceId ?? null,
              workspacePath: workspace.workspacePath,
              sourcePath: workspace.sourcePath,
              baseCommit: workspace.baseCommit ?? null,
              mode: workspace.mode,
              diffKind: bundle.diffKind ?? "git-patch",
              modified: bundle.modified,
              added: bundle.added,
              deleted: bundle.deleted,
              omittedPathCounts: { ...bundle.omittedPathCounts },
              pathLimit: bundle.pathLimit,
              contentDiff: bundle.contentDiff,
              fileChanges: jsonFileChanges(bundle.fileChanges),
            },
          },
        ],
      };
    } catch (err) {
      return {
        status: "diff_error",
        events: [
          {
            type: "workspace.diff_error",
            payload: {
              key: m.key,
              workspaceId: workspace.workspaceId ?? null,
              workspacePath: workspace.workspacePath,
              error: serializeError(err),
            },
          },
        ],
      };
    }
  }

  private updateAgentWorkspaceAfterEvents(
    runId: string,
    workspaceId: string | undefined,
    holder: WorkspaceHolder,
    status: "idle" | "diff_error",
    failureSeen: boolean,
    events: DurableAgentEvent[],
    atMs: number,
  ): void {
    if (!workspaceId) return;
    this.store.transaction(() => {
      let lastDiffEventSeq: number | null = null;
      let lastErrorEventSeq: number | null = null;
      for (const event of events) {
        const seq = this.store.appendEvent(runId, event.type, event.payload, atMs);
        if (event.type === "agent.diff") lastDiffEventSeq = seq;
        if (event.type === "workspace.diff_error") lastErrorEventSeq = seq;
      }
      this.releaseWorkspaceHolder(runId, workspaceId, holder, {
        status,
        ...(failureSeen || status === "diff_error" ? { failureSeen: true } : {}),
        ...(lastDiffEventSeq !== null ? { lastDiffEventSeq } : {}),
        ...(lastErrorEventSeq !== null ? { lastErrorEventSeq } : {}),
        updatedAtMs: atMs,
      });
    });
  }

  private recordAgentSessionToken(
    engine: StepEngine,
    runId: string,
    m: Extract<WorkerRequest, { type: "agent-turn" }>,
    attempt: number,
    token: string,
    expectedToken: string | undefined,
  ): void {
    if (this.isRunInterrupted(runId)) return;
    if (expectedToken && token !== expectedToken) {
      throw new AgentSessionContinuityError(
        `agent session "${m.agentKey}" turn "${m.turnKey}" resumed with token "${expectedToken}" but provider reported "${token}"`,
      );
    }
    this.store.transaction(() => {
      engine.recordSessionToken(m.stableKey, attempt, token);
      this.store.recordAgentSessionTurnToken(runId, m.agentKey, m.turnKey, attempt, token);
    });
  }

  private emitAgentTrace(engine: StepEngine, key: string, attempt: number, ev: TraceEvent): void {
    if (ev.type === "session") return;
    engine.emitAgentTrace(key, attempt, ev);
  }

  private captureSessionWorkspaceEvents(
    m: Extract<WorkerRequest, { type: "agent-turn" }>,
    begun: {
      attempt: number;
      workspaceId?: string;
      workspacePath?: string;
      workspaceTarget?: string | null;
      workspaceBaseCommit?: string;
      workspaceCopyBaselinePath?: string;
      workspaceMode?: AgentWorkspaceRow["mode"];
      workspaceOwned?: boolean;
    },
  ): { events: DurableAgentEvent[]; status: "idle" | "diff_error" } {
    if (!begun.workspaceOwned || !begun.workspacePath) return { events: [], status: "idle" };
    try {
      const bundle =
        begun.workspaceMode === "copy"
          ? diffCopyWorkspace(begun.workspacePath, begun.workspaceCopyBaselinePath ?? "")
          : begun.workspaceMode === "clone" || begun.workspaceMode === "worktree"
            ? diffGitFinalTree(begun.workspacePath, begun.workspaceBaseCommit ?? "HEAD")
            : (() => {
                throw new Error(
                  `workspace mode ${String(begun.workspaceMode)} does not support diff`,
                );
              })();
      return {
        status: "idle",
        events: [
          {
            type: "agent.diff",
            payload: {
              key: m.stableKey,
              agentKey: m.agentKey,
              turnKey: m.turnKey,
              workspaceId: begun.workspaceId ?? null,
              workspacePath: begun.workspacePath,
              sourcePath: begun.workspaceTarget ?? null,
              baseCommit: begun.workspaceBaseCommit ?? null,
              mode: begun.workspaceMode ?? "worktree",
              diffKind: bundle.diffKind ?? "git-patch",
              modified: bundle.modified,
              added: bundle.added,
              deleted: bundle.deleted,
              omittedPathCounts: { ...bundle.omittedPathCounts },
              pathLimit: bundle.pathLimit,
              contentDiff: bundle.contentDiff,
              fileChanges: jsonFileChanges(bundle.fileChanges),
            },
          },
        ],
      };
    } catch (err) {
      return {
        status: "diff_error",
        events: [
          {
            type: "workspace.diff_error",
            payload: {
              key: m.stableKey,
              agentKey: m.agentKey,
              turnKey: m.turnKey,
              workspaceId: begun.workspaceId ?? null,
              workspacePath: begun.workspacePath,
              error: serializeError(err),
            },
          },
        ],
      };
    }
  }

  private completeAgentSessionTurn(
    runId: string,
    m: Extract<WorkerRequest, { type: "agent-turn" }>,
    begun: {
      attempt: number;
      inputHash: string;
      startedAtMs: number;
      workspaceId?: string;
      workspacePath?: string;
      resumeToken?: string;
    },
    value: unknown,
    providerSessionToken: string | undefined,
    events: DurableAgentEvent[] = [],
    workspaceStatus: "idle" | "diff_error" = "idle",
    failureSeen = false,
  ): void {
    if (this.isRunInterrupted(runId)) return;
    const journalRow = this.store.getJournalRow(runId, m.stableKey, begun.attempt);
    const turn = this.store.getLatestAgentSessionTurn(runId, m.agentKey, m.turnKey);
    const tokenAfter =
      turn?.observedSessionToken ?? providerSessionToken ?? journalRow?.sessionToken ?? null;
    if (begun.resumeToken && providerSessionToken && providerSessionToken !== begun.resumeToken) {
      throw new AgentSessionContinuityError(
        `agent session "${m.agentKey}" turn "${m.turnKey}" resumed with token "${begun.resumeToken}" but provider returned "${providerSessionToken}"`,
      );
    }
    if (!tokenAfter) {
      throw new AgentSessionContinuityError(
        `agent session "${m.agentKey}" turn "${m.turnKey}" completed without a session token`,
      );
    }
    this.host.fault?.("before-commit", m.stableKey);
    const stored = prepareStepResult(value);
    const finishedAtMs = this.host.clock();
    this.store.transaction(() => {
      if (stored.artifact) {
        this.store.putArtifact(stored.artifact.hash, stored.artifact.bytes, finishedAtMs);
      }
      let lastDiffEventSeq: number | null = null;
      let lastErrorEventSeq: number | null = null;
      for (const event of events) {
        const seq = this.store.appendEvent(runId, event.type, event.payload, finishedAtMs);
        if (event.type === "agent.diff") lastDiffEventSeq = seq;
        if (event.type === "workspace.diff_error") lastErrorEventSeq = seq;
      }
      this.store.putJournalRow({
        runId,
        stableKey: m.stableKey,
        attempt: begun.attempt,
        effectType: "effectful",
        status: "completed",
        version: m.version,
        inputHash: begun.inputHash,
        inputDeps: m.deps,
        resultInline: stored.inline,
        resultArtifact: stored.artifact?.hash ?? null,
        sessionToken: tokenAfter,
        startedAtMs: begun.startedAtMs,
        finishedAtMs,
      });
      this.store.completeAgentSessionTurn(
        runId,
        m.agentKey,
        m.turnKey,
        begun.attempt,
        tokenAfter,
        finishedAtMs,
      );
      this.store.completeAgentSession(
        runId,
        m.agentKey,
        m.turnKey,
        begun.attempt,
        tokenAfter,
        finishedAtMs,
      );
      this.releaseWorkspaceHolder(
        runId,
        begun.workspaceId,
        { kind: "agent_session", key: m.agentKey, attempt: begun.attempt },
        {
          status: workspaceStatus,
          ...(failureSeen || workspaceStatus === "diff_error" ? { failureSeen: true } : {}),
          lastTurnKey: m.turnKey,
          lastTurnAttempt: begun.attempt,
          ...(lastDiffEventSeq !== null ? { lastDiffEventSeq } : {}),
          ...(lastErrorEventSeq !== null ? { lastErrorEventSeq } : {}),
          updatedAtMs: finishedAtMs,
        },
      );
    });
    this.store.appendEvent(
      runId,
      "step.completed",
      { stableKey: m.stableKey, effectType: "effectful" },
      this.host.clock(),
    );
  }

  private failAgentSessionTurn(
    runId: string,
    m: Extract<WorkerRequest, { type: "agent-turn" }>,
    begun: {
      attempt: number;
      inputHash: string;
      startedAtMs: number;
      workspaceId?: string;
      workspacePath?: string;
    },
    err: unknown,
    events: DurableAgentEvent[] = [],
  ): void {
    if (this.isRunInterrupted(runId)) return;
    const atMs = this.host.clock();
    this.store.transaction(() => {
      let lastDiffEventSeq: number | null = null;
      let lastErrorEventSeq: number | null = null;
      for (const event of events) {
        const seq = this.store.appendEvent(runId, event.type, event.payload, atMs);
        if (event.type === "agent.diff") lastDiffEventSeq = seq;
        if (event.type === "workspace.diff_error") lastErrorEventSeq = seq;
      }
      const existing = this.store.getJournalRow(runId, m.stableKey, begun.attempt);
      this.store.putJournalRow({
        runId,
        stableKey: m.stableKey,
        attempt: begun.attempt,
        effectType: "effectful",
        status: "failed",
        version: m.version,
        inputHash: begun.inputHash,
        inputDeps: m.deps,
        sessionToken: existing?.sessionToken ?? null,
        errorJson: JSON.stringify(serializeError(err)),
        startedAtMs: begun.startedAtMs,
        finishedAtMs: atMs,
      });
      this.store.failAgentSessionTurn(runId, m.agentKey, m.turnKey, begun.attempt, atMs);
      this.releaseWorkspaceHolder(
        runId,
        begun.workspaceId,
        { kind: "agent_session", key: m.agentKey, attempt: begun.attempt },
        {
          status: lastErrorEventSeq !== null ? "diff_error" : "idle",
          failureSeen: true,
          lastTurnKey: m.turnKey,
          lastTurnAttempt: begun.attempt,
          ...(lastDiffEventSeq !== null ? { lastDiffEventSeq } : {}),
          ...(lastErrorEventSeq !== null ? { lastErrorEventSeq } : {}),
          updatedAtMs: atMs,
        },
      );
    });
  }

  private registerActiveExecution(runId: string, active: ActiveExecution): () => void {
    const set = this.activeExecutions.get(runId) ?? new Set<ActiveExecution>();
    set.add(active);
    this.activeExecutions.set(runId, set);
    return () => {
      const current = this.activeExecutions.get(runId);
      if (!current) return;
      current.delete(active);
      if (current.size === 0) this.activeExecutions.delete(runId);
    };
  }

  private isRunInterrupted(runId: string): boolean {
    return this.store.getRun(runId)?.status === "interrupted";
  }

  private async withAgentConcurrency<T>(
    runId: string,
    stableKey: string,
    provider: string,
    signal: AbortSignal,
    fn: () => Promise<T>,
  ): Promise<T> {
    const permit = await this.agentConcurrency?.acquire({ runId, stableKey, provider, signal });
    try {
      return await fn();
    } finally {
      permit?.release();
    }
  }

  private childOutcome(runId: string): ChildRunOutcome | null {
    const run = this.store.getRun(runId);
    if (!run) throw new Error(`child run ${runId} not found`);
    if (!TERMINAL.has(run.status)) return null;
    return {
      runId,
      status: run.status,
      ...(run.outputRef !== null ? { output: JSON.parse(run.outputRef) } : {}),
      ...(run.errorJson !== null
        ? { error: JSON.parse(run.errorJson) as { name: string; message: string } }
        : {}),
    };
  }

  private waitForChildOutcome(runId: string, signal: AbortSignal): Promise<ChildRunOutcome> {
    const ready = this.childOutcome(runId);
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
      };
      const settle = (): void => {
        const outcome = this.childOutcome(runId);
        if (!outcome) return;
        cleanup();
        resolve(outcome);
      };
      const onAbort = (): void => {
        cleanup();
        reject(signal.reason ?? new Error(`wait for child run ${runId} aborted`));
      };
      const unsubscribe = this.store.onEventAppended((event) => {
        if (event.runId === runId) settle();
      });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
      else settle();
    });
  }

  private execute<O>(runId: string, workflowUrl: string, input: unknown): Promise<RunHandle<O>> {
    let sessionRunGuarded = false;
    if (this.store.hasAgentSessions(runId)) {
      if (this.activeSessionRuns.has(runId)) {
        return Promise.reject(
          new Error(
            `run ${runId} uses durable agent sessions and is already executing in this kernel`,
          ),
        );
      }
      this.activeSessionRuns.add(runId);
      sessionRunGuarded = true;
    }
    const runTarget = this.store.getRun(runId)?.runTarget ?? null;
    this.recoverActiveWorkspaceHolders(runId, this.host.clock());
    const source = readSourceSafe(workflowUrl);
    const sourcePath = workflowUrl.startsWith("file:")
      ? new URL(workflowUrl).pathname
      : workflowUrl;
    const moduleHelpers = source ? extractModuleHelpers(source, sourcePath) : {};
    return new Promise<RunHandle<O>>((resolve, reject) => {
      const engine = new StepEngine(this.store, runId, this.host);
      const sab = new SharedArrayBuffer(SAB_BYTES);
      const control = new Int32Array(sab, 0, CONTROL_WORDS);
      const valueView = new Float64Array(sab, VALUE_OFFSET, 1);
      const worker = new Worker(WORKER_URL, { type: "module" });
      const runAbortController = new AbortController();
      this.activeWorkers.add(worker);
      let workflowSettings: WorkflowVisibleSettings | null = null;

      let settled = false;
      let unregisterActive = () => {};
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        if (!runAbortController.signal.aborted) {
          runAbortController.abort(new RunSettledError(runId));
        }
        if (sessionRunGuarded) this.activeSessionRuns.delete(runId);
        this.activeWorkers.delete(worker);
        unregisterActive();
        worker.terminate();
        fn();
      };
      const finishInterrupted = (): void => {
        finish(() => resolve({ runId, status: "interrupted" }));
      };
      const requireWorkflowSettings = (): WorkflowVisibleSettings => {
        if (!workflowSettings) throw new SettingSnapshotIntegrityError(runId);
        return workflowSettings;
      };
      const active: ActiveExecution = {
        interrupt: () => {
          runAbortController.abort(new RunInterruptedError(runId));
          finishInterrupted();
        },
      };
      unregisterActive = this.registerActiveExecution(runId, active);
      const reply = (id: number, payload: unknown): void => {
        // After the run settles the worker is terminated; a late reply from an
        // in-flight agent (e.g. another fan-out verifier finishing after a crash)
        // would throw on postMessage. Drop it — the journal already holds its row.
        if (settled) return;
        try {
          worker.postMessage({ type: "rpc-reply", id, payload } satisfies HostReply);
        } catch {
          // worker gone
        }
      };
      const replyError = (id: number, err: unknown): void => {
        if (settled) return;
        try {
          worker.postMessage({
            type: "rpc-error",
            id,
            error: serializeError(err),
          } satisfies HostReply);
        } catch {
          // worker gone
        }
      };
      // Settle a run as resumable (a host-side crash fault); the pending row
      // written before the fault drives re-execution on the next run.
      const abort = (err: unknown): void => {
        if (this.isRunInterrupted(runId)) {
          finishInterrupted();
          return;
        }
        this.store.appendEvent(
          runId,
          "run.aborted",
          { name: "HostFault", message: String(err) },
          this.host.clock(),
        );
        finish(() => reject(err));
      };

      worker.onmessage = async (e: MessageEvent<WorkerRequest>) => {
        if (settled) return;
        const m = e.data;
        try {
          if (m.type !== "ready" && this.isRunInterrupted(runId)) {
            finishInterrupted();
            return;
          }
          switch (m.type) {
            case "ready": {
              const agentProfiles = this.profilesForRun(runId);
              workflowSettings = this.workflowSettingsForRun(runId);
              worker.postMessage({
                type: "init",
                workflowUrl,
                input,
                sab,
                moduleHelpers,
                agentProfiles,
                workflowSettings,
                runId,
                runTarget,
              } satisfies HostReply);
              break;
            }
            case "step-begin": {
              const begun = engine.beginStep(m.key, m.inputs as Json, m.version, m.deps);
              if (begun.kind === "replay") {
                reply(m.id, {
                  action: "replay",
                  value: begun.value,
                  contentHash: hashJson(begun.value),
                });
              } else {
                reply(m.id, {
                  action: "execute",
                  attempt: begun.attempt,
                  inputHash: begun.inputHash,
                  startedAtMs: begun.startedAtMs,
                });
              }
              break;
            }
            case "step-commit": {
              this.onStepExecute?.(m.key);
              engine.completeStep(
                m.key,
                m.attempt,
                m.version,
                m.inputHash,
                m.startedAtMs,
                m.value,
                m.deps,
              );
              reply(m.id, { contentHash: hashJson(m.value) });
              break;
            }
            case "step-fail": {
              this.onStepExecute?.(m.key);
              engine.failStep(
                m.key,
                m.attempt,
                m.version,
                m.inputHash,
                m.startedAtMs,
                rebuildError(m.error),
              );
              reply(m.id, {});
              break;
            }
            case "workspace": {
              try {
                const handle = await this.resolveWorkspaceSpec(runId, m.spec, this.host.clock());
                reply(m.id, handle);
              } catch (err) {
                replyError(m.id, err);
              }
              break;
            }
            case "agent": {
              let providerConfig: Readonly<ProviderConfigValue> | undefined;
              try {
                providerConfig = m.providerConfig
                  ? normalizeProviderConfigValue(`realm agent "${m.key}"`, m.providerConfig)
                  : undefined;
              } catch (err) {
                reply(m.id, { ok: false, error: serializeError(err) });
                break;
              }
              const begun = engine.beginStep(
                m.key,
                m.inputs as Json,
                m.version,
                m.deps,
                "effectful",
              );
              if (begun.kind === "replay") {
                reply(m.id, { ok: true, output: begun.value, contentHash: hashJson(begun.value) });
                break;
              }
              this.onStepExecute?.(m.key);
              const registry = this.registry;
              if (!registry) {
                const err = new Error("ctx.agent requires an agent provider registry");
                engine.failStep(
                  m.key,
                  begun.attempt,
                  m.version,
                  begun.inputHash,
                  begun.startedAtMs,
                  err,
                  "effectful",
                );
                reply(m.id, { ok: false, error: { name: "Error", message: err.message } });
                break;
              }
              let provider: AgentProvider;
              try {
                provider = registry.get(m.provider);
              } catch (err) {
                engine.failStep(
                  m.key,
                  begun.attempt,
                  m.version,
                  begun.inputHash,
                  begun.startedAtMs,
                  err,
                  "effectful",
                );
                reply(m.id, { ok: false, error: serializeError(err) });
                break;
              }
              // §11: an explicitly isolated agent edits in a git worktree;
              // secrets are injected as invocation env from the side channel.
              let caps: Capabilities | undefined;
              try {
                caps = m.capabilities
                  ? this.assertRunCapabilities(runId, m.capabilities, `ctx.agent("${m.key}")`)
                  : undefined;
              } catch (err) {
                engine.failStep(
                  m.key,
                  begun.attempt,
                  m.version,
                  begun.inputHash,
                  begun.startedAtMs,
                  err,
                  "effectful",
                );
                reply(m.id, { ok: false, error: serializeError(err) });
                break;
              }
              let invocationEnv: Record<string, string> | undefined;
              try {
                invocationEnv = this.resolveAgentEnvironmentEnv(runId, m.environment);
              } catch (err) {
                engine.failStep(
                  m.key,
                  begun.attempt,
                  m.version,
                  begun.inputHash,
                  begun.startedAtMs,
                  err,
                  "effectful",
                );
                reply(m.id, { ok: false, error: serializeError(err) });
                break;
              }
              const workspaceHolder: WorkspaceHolder = {
                kind: "agent",
                key: m.key,
                attempt: begun.attempt,
              };
              let workspace: ReturnType<typeof this.beginAgentWorkspace>;
              try {
                workspace = this.beginAgentWorkspace(runId, m, begun.attempt, begun.startedAtMs);
              } catch (err) {
                engine.failStep(
                  m.key,
                  begun.attempt,
                  m.version,
                  begun.inputHash,
                  begun.startedAtMs,
                  err,
                  "effectful",
                );
                reply(m.id, { ok: false, error: serializeError(err) });
                break;
              }
              const settings = requireWorkflowSettings();

              void (async () => {
                try {
                  const execution = await this.withAgentConcurrency(
                    runId,
                    m.key,
                    m.provider,
                    runAbortController.signal,
                    () =>
                      runAgentWithStall(
                        (signal) =>
                          executeAgent(
                            provider,
                            {
                              key: m.key,
                              provider: m.provider,
                              prompt: m.prompt,
                              ...(providerConfig !== undefined ? { providerConfig } : {}),
                              ...(m.model ? { model: m.model } : {}),
                              toolPolicy: m.toolPolicy,
                              allowTools: m.allowTools,
                              denyTools: m.denyTools,
                              ...(m.reasoning ? { reasoning: m.reasoning } : {}),
                              ...(caps ? { capabilities: caps } : {}),
                              cwd: workspace.cwd,
                              ...(invocationEnv !== undefined ? { env: invocationEnv } : {}),
                              ...(begun.resumeToken ? { resumeToken: begun.resumeToken } : {}),
                              abortSignal: signal,
                              timeoutMs: m.timeoutMs,
                            },
                            {
                              onSessionToken: (tok) => {
                                if (!settled && !this.isRunInterrupted(runId)) {
                                  engine.recordSessionToken(m.key, begun.attempt, tok);
                                }
                              },
                              // Tool calls/results are durably appended here before
                              // returning to the adapter; text/reasoning frames are live-only.
                              onEvent: (ev) => {
                                if (!settled && !this.isRunInterrupted(runId)) {
                                  this.emitAgentTrace(engine, m.key, begun.attempt, ev);
                                }
                              },
                            },
                            {
                              ...(m.jsonSchema != null ? { jsonSchema: m.jsonSchema } : {}),
                              maxRetries: m.maxRetries,
                              ...(m.lenient ? { coerce: true } : {}),
                            },
                          ),
                        {
                          timeoutMs: m.timeoutMs,
                          stallRetries: m.stallRetries,
                          signal: runAbortController.signal,
                          onStall: (a) => engine.emit("agent.stalled", { key: m.key, attempt: a }),
                        },
                      ),
                  );
                  if (settled || this.isRunInterrupted(runId)) {
                    this.releaseWorkspaceHolder(runId, workspace.workspaceId, workspaceHolder, {
                      status: "idle",
                      updatedAtMs: this.host.clock(),
                    });
                    return;
                  }
                  const output = execution.output;
                  const workspaceCapture = this.captureAgentWorkspaceEvents(m, workspace);
                  const text = execution.text;
                  try {
                    engine.completeStep(
                      m.key,
                      begun.attempt,
                      m.version,
                      begun.inputHash,
                      begun.startedAtMs,
                      output,
                      m.deps,
                      "effectful",
                      finalAgentMessageEvents(m.key, begun.attempt, text),
                    );
                    this.updateAgentWorkspaceAfterEvents(
                      runId,
                      workspace.workspaceId,
                      workspaceHolder,
                      workspaceCapture.status,
                      false,
                      workspaceCapture.events,
                      this.host.clock(),
                    );
                  } catch (faultErr) {
                    abort(faultErr); // crash fault inside completeStep: leave pending
                    return;
                  }
                  reply(m.id, {
                    ok: true,
                    output,
                    contentHash: hashJson(output),
                  });
                } catch (agentErr) {
                  if (settled || this.isRunInterrupted(runId)) {
                    this.releaseWorkspaceHolder(runId, workspace.workspaceId, workspaceHolder, {
                      status: "idle",
                      failureSeen: true,
                      updatedAtMs: this.host.clock(),
                    });
                    return;
                  }
                  // onFailure:'null' (D7) tolerates a terminal failure: journal a
                  // COMPLETED null (with failure metadata as an event) so resume
                  // replays null instead of re-calling the agent.
                  if (m.onFailure === "null") {
                    const errJson = serializeError(agentErr) as unknown as Json;
                    engine.emit("agent.tolerated_failure", { key: m.key, error: errJson });
                    const workspaceCapture = this.captureAgentWorkspaceEvents(m, workspace);
                    try {
                      engine.completeStep(
                        m.key,
                        begun.attempt,
                        m.version,
                        begun.inputHash,
                        begun.startedAtMs,
                        null,
                        m.deps,
                        "effectful",
                      );
                      this.updateAgentWorkspaceAfterEvents(
                        runId,
                        workspace.workspaceId,
                        workspaceHolder,
                        workspaceCapture.status,
                        true,
                        workspaceCapture.events,
                        this.host.clock(),
                      );
                    } catch (faultErr) {
                      abort(faultErr);
                      return;
                    }
                    reply(m.id, { ok: true, output: null, contentHash: hashJson(null) });
                    return;
                  }
                  const workspaceCapture = this.captureAgentWorkspaceEvents(m, workspace);
                  this.updateAgentWorkspaceAfterEvents(
                    runId,
                    workspace.workspaceId,
                    workspaceHolder,
                    workspaceCapture.status,
                    true,
                    workspaceCapture.events,
                    this.host.clock(),
                  );
                  engine.failStep(
                    m.key,
                    begun.attempt,
                    m.version,
                    begun.inputHash,
                    begun.startedAtMs,
                    agentErr,
                    "effectful",
                  );
                  reply(m.id, {
                    ok: false,
                    error: serializeError(agentErr),
                    failure: agentErr instanceof AgentFailure,
                  });
                }
              })();
              break;
            }
            case "agent-turn": {
              const registry = this.registry;
              if (!registry) {
                reply(m.id, {
                  ok: false,
                  error: {
                    name: "Error",
                    message: "ctx.agentSession requires an agent provider registry",
                  },
                });
                break;
              }
              const provider = registry.get(m.provider);
              if (!sessionRunGuarded && this.activeSessionRuns.has(runId)) {
                reply(m.id, {
                  ok: false,
                  error: {
                    name: "Error",
                    message: `run ${runId} uses durable agent sessions and is already executing in this kernel`,
                  },
                });
                break;
              }
              let providerConfig: Readonly<ProviderConfigValue> | undefined;
              let begun: ReturnType<typeof this.beginAgentSessionTurn>;
              try {
                providerConfig = m.providerConfig
                  ? normalizeProviderConfigValue(
                      `realm agent session "${m.agentKey}"`,
                      m.providerConfig,
                    )
                  : undefined;
                begun = this.beginAgentSessionTurn(runId, m, provider);
              } catch (err) {
                const pending = this.store.getLatestAttempt(runId, m.stableKey);
                if (pending?.status === "pending") {
                  abort(err);
                  break;
                }
                reply(m.id, { ok: false, error: serializeError(err) });
                break;
              }
              if (begun.kind === "replay") {
                reply(m.id, { ok: true, output: begun.value, contentHash: hashJson(begun.value) });
                break;
              }
              let invocationEnv: Record<string, string> | undefined;
              try {
                invocationEnv = this.resolveAgentEnvironmentEnv(runId, m.environment);
              } catch (err) {
                this.failAgentSessionTurn(runId, m, begun, err);
                reply(m.id, { ok: false, error: serializeError(err) });
                break;
              }
              if (!sessionRunGuarded) {
                this.activeSessionRuns.add(runId);
                sessionRunGuarded = true;
              }
              this.onStepExecute?.(m.stableKey);
              let caps: Capabilities | undefined;
              try {
                caps = m.capabilities
                  ? this.assertRunCapabilities(
                      runId,
                      m.capabilities,
                      `ctx.agentSession("${m.agentKey}")`,
                    )
                  : undefined;
              } catch (err) {
                this.failAgentSessionTurn(runId, m, begun, err);
                reply(m.id, { ok: false, error: serializeError(err) });
                break;
              }
              const settings = requireWorkflowSettings();

              void (async () => {
                try {
                  const execution = await this.withAgentConcurrency(
                    runId,
                    m.stableKey,
                    m.provider,
                    runAbortController.signal,
                    () =>
                      runAgentWithStall(
                        (signal) =>
                          executeAgent(
                            provider,
                            {
                              key: m.stableKey,
                              provider: m.provider,
                              prompt: m.prompt,
                              ...(providerConfig !== undefined ? { providerConfig } : {}),
                              ...(m.model ? { model: m.model } : {}),
                              toolPolicy: m.toolPolicy,
                              allowTools: m.allowTools,
                              denyTools: m.denyTools,
                              ...(m.reasoning ? { reasoning: m.reasoning } : {}),
                              ...(caps ? { capabilities: caps } : {}),
                              cwd: begun.cwd,
                              ...(invocationEnv !== undefined ? { env: invocationEnv } : {}),
                              ...(begun.resumeToken ? { resumeToken: begun.resumeToken } : {}),
                              abortSignal: signal,
                              timeoutMs: m.timeoutMs,
                            },
                            {
                              onSessionToken: (tok) => {
                                if (!settled && !this.isRunInterrupted(runId)) {
                                  this.recordAgentSessionToken(
                                    engine,
                                    runId,
                                    m,
                                    begun.attempt,
                                    tok,
                                    begun.resumeToken,
                                  );
                                }
                              },
                              onEvent: (ev) => {
                                if (!settled && !this.isRunInterrupted(runId)) {
                                  this.emitAgentTrace(engine, m.stableKey, begun.attempt, ev);
                                }
                              },
                            },
                            {
                              ...(m.jsonSchema != null ? { jsonSchema: m.jsonSchema } : {}),
                              maxRetries: m.maxRetries,
                              ...(m.lenient ? { coerce: true } : {}),
                            },
                          ),
                        {
                          timeoutMs: m.timeoutMs,
                          stallRetries: m.stallRetries,
                          signal: runAbortController.signal,
                          onStall: (a) =>
                            engine.emit("agent.stalled", { key: m.stableKey, attempt: a }),
                        },
                      ),
                  );
                  if (settled || this.isRunInterrupted(runId)) {
                    this.releaseWorkspaceHolder(
                      runId,
                      begun.workspaceId,
                      { kind: "agent_session", key: m.agentKey, attempt: begun.attempt },
                      { status: "idle", updatedAtMs: this.host.clock() },
                    );
                    return;
                  }
                  const output = execution.output;
                  const text = execution.text;
                  const workspaceCapture = this.captureSessionWorkspaceEvents(m, begun);
                  try {
                    this.completeAgentSessionTurn(
                      runId,
                      m,
                      begun,
                      output,
                      execution.sessionToken,
                      [
                        ...workspaceCapture.events,
                        ...finalAgentMessageEvents(m.stableKey, begun.attempt, text),
                      ],
                      workspaceCapture.status,
                    );
                  } catch (err) {
                    if (!(err instanceof AgentSessionContinuityError)) {
                      abort(err);
                      return;
                    }
                    this.failAgentSessionTurn(runId, m, begun, err);
                    reply(m.id, { ok: false, error: serializeError(err) });
                    return;
                  }
                  reply(m.id, { ok: true, output, contentHash: hashJson(output) });
                } catch (agentErr) {
                  if (settled || this.isRunInterrupted(runId)) {
                    this.releaseWorkspaceHolder(
                      runId,
                      begun.workspaceId,
                      { kind: "agent_session", key: m.agentKey, attempt: begun.attempt },
                      { status: "idle", failureSeen: true, updatedAtMs: this.host.clock() },
                    );
                    return;
                  }
                  if (m.onFailure === "null" && agentErr instanceof AgentFailure) {
                    const errJson = serializeError(agentErr) as unknown as Json;
                    engine.emit("agent.tolerated_failure", { key: m.stableKey, error: errJson });
                    const workspaceCapture = this.captureSessionWorkspaceEvents(m, begun);
                    try {
                      this.completeAgentSessionTurn(
                        runId,
                        m,
                        begun,
                        null,
                        undefined,
                        workspaceCapture.events,
                        workspaceCapture.status,
                        true,
                      );
                    } catch (err) {
                      if (!(err instanceof AgentSessionContinuityError)) {
                        abort(err);
                        return;
                      }
                      this.failAgentSessionTurn(runId, m, begun, err);
                      reply(m.id, { ok: false, error: serializeError(err) });
                      return;
                    }
                    reply(m.id, { ok: true, output: null, contentHash: hashJson(null) });
                    return;
                  }
                  this.failAgentSessionTurn(
                    runId,
                    m,
                    begun,
                    agentErr,
                    this.captureSessionWorkspaceEvents(m, begun).events,
                  );
                  reply(m.id, {
                    ok: false,
                    error: serializeError(agentErr),
                    failure: agentErr instanceof AgentFailure,
                  });
                }
              })();
              break;
            }
            case "checkpoint": {
              let begun: ReturnType<StepEngine["beginCheckpoint"]>;
              try {
                begun = engine.beginCheckpoint(
                  m.checkpoint.stableKey,
                  m.checkpoint.identity,
                  m.version,
                  null,
                );
              } catch (err) {
                replyError(m.id, err);
                break;
              }
              if (begun.kind === "replay") {
                reply(m.id, {});
                break;
              }
              this.onStepExecute?.(m.checkpoint.stableKey);
              engine.completeStep(
                m.checkpoint.stableKey,
                begun.attempt,
                m.version,
                begun.inputHash,
                begun.startedAtMs,
                m.checkpoint.result,
                null,
                "checkpoint",
                [
                  {
                    type: "checkpoint",
                    payload: {
                      stableKey: m.checkpoint.stableKey,
                      attempt: begun.attempt,
                      message: m.checkpoint.message,
                      data: m.checkpoint.data,
                    },
                  },
                ],
              );
              reply(m.id, {});
              break;
            }
            case "state-write": {
              let begun: ReturnType<StepEngine["beginStateWrite"]>;
              try {
                begun = engine.beginStateWrite(
                  m.state.stableKey,
                  m.state.identity,
                  m.version,
                  m.state.namespace,
                  m.state.name,
                );
              } catch (err) {
                replyError(m.id, err);
                break;
              }
              if (begun.kind === "replay") {
                reply(m.id, { value: begun.value });
                break;
              }
              this.onStepExecute?.(m.state.stableKey);
              engine.completeStateWrite(
                m.state.stableKey,
                begun.attempt,
                m.version,
                begun.inputHash,
                begun.startedAtMs,
                m.state.namespace,
                m.state.name,
                m.state.value,
              );
              reply(m.id, { value: m.state.value });
              break;
            }
            case "drain-signals": {
              let begun: ReturnType<StepEngine["beginDrainSignals"]>;
              try {
                begun = engine.beginDrainSignals(m.key, m.inputs as Json, m.version, null);
              } catch (err) {
                replyError(m.id, err);
                break;
              }
              if (begun.kind === "replay") {
                reply(m.id, { batch: begun.value });
                break;
              }
              this.onStepExecute?.(m.key);
              const batch = engine.completeDrainSignals(
                m.key,
                begun.attempt,
                m.version,
                begun.inputHash,
                begun.startedAtMs,
                m.name,
              );
              reply(m.id, { batch });
              break;
            }
            case "spawn": {
              let begun: ReturnType<StepEngine["beginSpawn"]>;
              try {
                begun = engine.beginSpawn(
                  m.spawn.stableKey,
                  m.spawn.identity,
                  m.version,
                  this.idgen,
                );
              } catch (err) {
                replyError(m.id, err);
                break;
              }
              if (begun.kind === "replay") {
                const result = begun.value as { runId: string };
                reply(m.id, { runId: result.runId });
                break;
              }

              type SpawnReservation = {
                runId: string;
                definitionHash?: string;
                workflowName?: string | null;
                workflowRef?: string;
                target?: string;
              };
              let reservation = begun.reservation as SpawnReservation;
              if (!reservation || typeof reservation.runId !== "string") {
                replyError(
                  m.id,
                  new Error(`spawn "${m.spawn.stableKey}" has an invalid reservation`),
                );
                break;
              }
              if (!reservation.definitionHash) {
                try {
                  const saved = this.store.resolveSavedWorkflowRef(m.spawn.workflow);
                  const parent = this.store.getRun(runId);
                  if (!parent) throw new Error(`parent run ${runId} not found during spawn`);
                  reservation = {
                    runId: reservation.runId,
                    definitionHash: saved.definitionHash,
                    workflowName: saved.workflowName ?? saved.name,
                    workflowRef: `saved:${saved.name}@${saved.version} ${saved.definitionHash}`,
                    target: requireRunTarget(
                      saved.defaultTarget ?? parent.runTarget,
                      `ctx.spawn("${m.spawn.stableKey}")`,
                    ),
                  };
                  engine.recordSpawnReservation(m.spawn.stableKey, begun.attempt, reservation);
                } catch (err) {
                  replyError(m.id, err);
                  break;
                }
              }

              const definitionHash = reservation.definitionHash;
              const workflowRef = reservation.workflowRef;
              const target = reservation.target;
              if (!definitionHash || !workflowRef || !target) {
                replyError(
                  m.id,
                  new Error(`spawn "${m.spawn.stableKey}" reservation is incomplete`),
                );
                break;
              }

              let child: RunRow | null;
              try {
                child = this.store.getRun(reservation.runId);
                if (!child) {
                  const entryPath = materializeWorkflowDefinition(
                    this.store,
                    definitionHash,
                    this.definitionCacheRoot,
                  );
                  const at = this.host.clock();
                  this.store.transaction(() => {
                    this.store.insertRun({
                      runId: reservation.runId,
                      workflowName: reservation.workflowName ?? null,
                      definitionVersion: definitionHash,
                      workflowRef,
                      runTarget: target,
                      status: "running",
                      parentRunId: runId,
                      tenantId: null,
                      inputRef: JSON.stringify(m.spawn.input),
                      outputRef: null,
                      errorJson: null,
                      heartbeatAtMs: null,
                      runtimeOwnerId: null,
                      launchAuthorityJson: this.store.getRun(runId)?.launchAuthorityJson ?? null,
                      createdAtMs: at,
                    });
                    this.store.copyRunProfileSnapshot(runId, reservation.runId);
                    this.store.copyRunSettingSnapshot(runId, reservation.runId);
                    issueRunCapability(this.store, reservation.runId, at, {
                      ...(m.spawn.caps !== null
                        ? { actions: m.spawn.caps as readonly CapabilityAction[] }
                        : {}),
                      note: `child run ${reservation.runId} spawned by ${runId}`,
                    });
                    this.store.appendEvent(
                      reservation.runId,
                      "run.started",
                      {
                        name: reservation.workflowName ?? null,
                        definitionHash,
                        target,
                        spawnedFrom: runId,
                      },
                      at,
                    );
                  });
                  child = this.store.getRun(reservation.runId);
                  this.onChildRunCreated?.(reservation.runId);
                  void this.execute(reservation.runId, entryPath, m.spawn.input).catch(() => {});
                }
              } catch (err) {
                replyError(m.id, err);
                break;
              }
              if (
                !child ||
                child.parentRunId !== runId ||
                child.definitionVersion !== definitionHash
              ) {
                replyError(
                  m.id,
                  new Error(
                    `spawn "${m.spawn.stableKey}" child reservation conflicts with an existing run`,
                  ),
                );
                break;
              }

              this.onStepExecute?.(m.spawn.stableKey);
              this.host.fault?.("before-commit", m.spawn.stableKey);
              const result = { runId: reservation.runId, definitionHash };
              engine.completeStep(
                m.spawn.stableKey,
                begun.attempt,
                m.version,
                begun.inputHash,
                begun.startedAtMs,
                result,
                null,
                "spawn",
              );
              reply(m.id, { runId: reservation.runId });
              break;
            }
            case "wait-run": {
              let begun: ReturnType<StepEngine["beginWaitRun"]>;
              try {
                begun = engine.beginWaitRun(m.key, m.inputs as Json, m.version);
              } catch (err) {
                replyError(m.id, err);
                break;
              }
              if (begun.kind === "replay") {
                reply(m.id, begun.value);
                break;
              }
              const child = this.store.getRun(m.childRunId);
              if (!child || child.parentRunId !== runId) {
                replyError(
                  m.id,
                  new Error(`ctx.waitRun handle does not identify a child of run ${runId}`),
                );
                break;
              }
              this.onStepExecute?.(m.key);
              const outcome = await this.waitForChildOutcome(
                m.childRunId,
                runAbortController.signal,
              );
              engine.completeStep(
                m.key,
                begun.attempt,
                m.version,
                begun.inputHash,
                begun.startedAtMs,
                outcome,
                null,
                "wait_run",
              );
              reply(m.id, outcome);
              break;
            }
            case "command": {
              let workspace: CommandWorkspace;
              let invocationEnv: Record<string, string>;
              try {
                this.assertRunCapabilities(
                  runId,
                  m.command.capabilities,
                  `ctx.command("${m.command.stableKey}")`,
                );
                workspace = this.resolveCommandWorkspaceCwd(runId, m.command);
                invocationEnv = this.resolveCommandEnvironmentEnv(runId, m.command);
              } catch (err) {
                reply(m.id, { ok: false, error: serializeError(err) });
                break;
              }

              let begun: ReturnType<StepEngine["beginCommand"]>;
              try {
                begun = engine.beginCommand(
                  m.command.stableKey,
                  m.inputs as Json,
                  m.version,
                  m.deps,
                );
              } catch (err) {
                const pending = this.store.getLatestAttempt(runId, m.command.stableKey);
                if (
                  pending?.status === "pending" &&
                  pending.version === m.version &&
                  pending.inputHash === hashJson(m.inputs as Json)
                ) {
                  abort(err);
                  break;
                }
                reply(m.id, { ok: false, error: serializeError(err) });
                break;
              }
              if (begun.kind === "replay") {
                const result = begun.value as CommandResult;
                try {
                  applyCommandFailureMode(result, m.command.failureMode);
                  reply(m.id, {
                    ok: true,
                    result,
                    contentHash: hashJson(result as unknown as Json),
                  });
                } catch (err) {
                  reply(m.id, {
                    ok: false,
                    result,
                    error: serializeError(err),
                    contentHash: hashJson(result as unknown as Json),
                  });
                }
                break;
              }

              this.onStepExecute?.(m.command.stableKey);
              try {
                this.acquireCommandWorkspace(runId, m.command, begun.attempt, begun.startedAtMs);
                engine.emit("command.started", commandStartedEvent(m.command, begun.attempt));
              } catch (err) {
                reply(m.id, { ok: false, error: serializeError(err) });
                break;
              }

              void (async () => {
                try {
                  const result = await runBoundedProcess({
                    command: m.command,
                    attempt: begun.attempt,
                    cwd: workspace.resolvedCwd,
                    env: invocationEnv,
                    signal: runAbortController.signal,
                  });
                  if (settled || this.isRunInterrupted(runId)) {
                    this.store.transaction(() => {
                      this.releaseCommandWorkspaceHolderInTransaction(
                        runId,
                        workspace.workspaceId,
                        m.command,
                        begun.attempt,
                        this.host.clock(),
                      );
                    });
                    return;
                  }
                  let completed: CommandResult;
                  try {
                    completed = this.completeCommandResult(
                      runId,
                      m.command,
                      {
                        attempt: begun.attempt,
                        inputHash: begun.inputHash,
                        startedAtMs: begun.startedAtMs,
                        version: m.version,
                        inputDeps: m.deps,
                      },
                      result,
                    );
                  } catch (faultErr) {
                    abort(faultErr);
                    return;
                  }
                  try {
                    applyCommandFailureMode(completed, m.command.failureMode);
                    reply(m.id, {
                      ok: true,
                      result: completed,
                      contentHash: hashJson(completed as unknown as Json),
                    });
                  } catch (err) {
                    reply(m.id, {
                      ok: false,
                      result: completed,
                      error: serializeError(err),
                      contentHash: hashJson(completed as unknown as Json),
                    });
                  }
                } catch (commandErr) {
                  this.store.transaction(() => {
                    this.releaseCommandWorkspaceHolderInTransaction(
                      runId,
                      workspace.workspaceId,
                      m.command,
                      begun.attempt,
                      this.host.clock(),
                    );
                  });
                  if (
                    commandErr instanceof CommandAbortError ||
                    settled ||
                    this.isRunInterrupted(runId)
                  ) {
                    return;
                  }
                  const at = this.host.clock();
                  this.store.putJournalRow({
                    runId,
                    stableKey: m.command.stableKey,
                    attempt: begun.attempt,
                    effectType: "command",
                    status: "failed",
                    version: m.version,
                    inputHash: begun.inputHash,
                    inputDeps: m.deps,
                    errorJson: JSON.stringify(serializeError(commandErr)),
                    startedAtMs: begun.startedAtMs,
                    finishedAtMs: at,
                  });
                  reply(m.id, { ok: false, error: serializeError(commandErr) });
                }
              })();
              break;
            }
            case "completion-check": {
              try {
                this.assertRunCapabilities(
                  runId,
                  { fs: "workspace-write", shell: true, network: ["*"], secrets: [] },
                  `completionCheck("${m.completionCheck.stableKey}")`,
                );
              } catch (err) {
                reply(m.id, { ok: false, error: serializeError(err) });
                break;
              }
              let begun: ReturnType<StepEngine["beginCompletionCheck"]>;
              try {
                begun = engine.beginCompletionCheck(
                  m.completionCheck.stableKey,
                  m.inputs as Json,
                  m.version,
                  m.deps,
                );
              } catch (err) {
                const pending = this.store.getLatestAttempt(runId, m.completionCheck.stableKey);
                if (
                  pending?.status === "pending" &&
                  pending.version === m.version &&
                  pending.inputHash === hashJson(m.inputs as Json)
                ) {
                  abort(err);
                  break;
                }
                reply(m.id, { ok: false, error: serializeError(err) });
                break;
              }
              if (begun.kind === "replay") {
                const result = begun.value as CompletionCheckResult;
                reply(m.id, {
                  ok: true,
                  result,
                  contentHash: hashJson(result as unknown as Json),
                });
                break;
              }

              this.onStepExecute?.(m.completionCheck.stableKey);
              engine.emit(
                "completion_check.started",
                completionCheckStartedEvent(m.completionCheck),
              );
              void (async () => {
                try {
                  const result = await runCompletionCheck({
                    store: this.store,
                    runId,
                    spec: m.completionCheck,
                    startedAtMs: begun.startedAtMs,
                    clock: this.host.clock,
                    signal: runAbortController.signal,
                  });
                  if (settled || this.isRunInterrupted(runId)) return;
                  let completed: CompletionCheckResult;
                  try {
                    completed = this.completeCompletionCheckResult(
                      runId,
                      result,
                      m.completionCheck,
                      {
                        attempt: begun.attempt,
                        inputHash: begun.inputHash,
                        startedAtMs: begun.startedAtMs,
                        version: m.version,
                        inputDeps: m.deps,
                      },
                    );
                  } catch (faultErr) {
                    abort(faultErr);
                    return;
                  }
                  reply(m.id, {
                    ok: true,
                    result: completed,
                    contentHash: hashJson(completed as unknown as Json),
                  });
                } catch (checkErr) {
                  if (settled || this.isRunInterrupted(runId)) return;
                  const at = this.host.clock();
                  this.store.putJournalRow({
                    runId,
                    stableKey: m.completionCheck.stableKey,
                    attempt: begun.attempt,
                    effectType: "completion_check",
                    status: "failed",
                    version: m.version,
                    inputHash: begun.inputHash,
                    inputDeps: m.deps,
                    errorJson: JSON.stringify(serializeError(checkErr)),
                    startedAtMs: begun.startedAtMs,
                    finishedAtMs: at,
                  });
                  reply(m.id, { ok: false, error: serializeError(checkErr) });
                }
              })();
              break;
            }
            case "ambient": {
              const v = m.kind === "now" ? engine.now() : engine.random();
              valueView[0] = v;
              Atomics.store(control, 0, 1);
              Atomics.notify(control, 0);
              break;
            }
            case "park-check": {
              // §16: durable timer. Record (idempotent) the fire time and report
              // whether it has elapsed. Resolved against the REAL clock so a
              // resumed run wakes once due; the fireAt itself is journaled.
              if (m.kind === "timer") {
                const fireAt = this.host.clock() + (m.durationMs ?? 0);
                const t = this.store.upsertTimer(runId, m.key, fireAt);
                const ready = this.host.clock() >= t.fireAtMs;
                if (ready) this.store.markTimerFired(runId, m.key);
                reply(m.id, { ready, until: t.fireAtMs });
              } else if (m.kind === "human") {
                // §17: record a pending approval (incl. the prompt + requested caps
                // the worker sent) so a UI can render it; ready once decided.
                const ask = (m.payload ?? {}) as { prompt?: string; requestedCaps?: unknown };
                this.store.requestApproval(
                  runId,
                  m.key,
                  { prompt: ask.prompt ?? "", requestedCaps: ask.requestedCaps },
                  this.host.clock(),
                );
                const appr = this.store.getApproval(runId, m.key);
                if (appr && appr.status !== "pending") {
                  if (appr.status === "approved" && appr.grantedCaps != null) {
                    this.grantRunCapabilities(runId, appr.grantedCaps);
                  }
                  reply(m.id, {
                    ready: true,
                    value: { status: appr.status, note: appr.note, grantedCaps: appr.grantedCaps },
                  });
                } else {
                  reply(m.id, { ready: false });
                }
              } else {
                // §17 signal: replay the already-consumed payload, else consume the
                // oldest pending signal of this name; park if none has arrived.
                const name = (m.payload as { name: string }).name;
                const replayed = this.store.signalConsumedBy(runId, m.key);
                const got = replayed ?? this.store.consumeSignal(runId, name, m.key);
                if (got) reply(m.id, { ready: true, value: got.payload });
                else reply(m.id, { ready: false });
              }
              break;
            }
            case "parked": {
              const status: RunStatus =
                m.kind === "timer"
                  ? "waiting-timer"
                  : m.kind === "human"
                    ? "waiting-human"
                    : "waiting-signal";
              this.store.updateRun(runId, { status });
              this.store.appendEvent(
                runId,
                "run.parked",
                { kind: m.kind, key: m.key, until: m.until },
                this.host.clock(),
              );
              finish(() => resolve({ runId, status }));
              break;
            }
            case "log":
              engine.emit("log", { message: m.message, data: (m.data ?? null) as Json });
              break;
            case "phase":
              engine.emit("phase", { title: m.title });
              break;
            case "result": {
              const at = this.host.clock();
              this.store.transaction(() => {
                this.store.updateRun(runId, {
                  status: "finished",
                  outputRef: JSON.stringify(m.output ?? null),
                  finishedAtMs: at,
                });
                this.store.appendEvent(
                  runId,
                  "run.finished",
                  runFinishedPayload(m.output ?? null),
                  at,
                );
              });
              cleanupTerminalRunWorkspaces(this.store, runId, "finished", at);
              this.secrets?.wipe(runId); // §11.2: secrets live per-run; wipe on terminal
              finish(() => resolve({ runId, status: "finished", output: m.output as O }));
              break;
            }
            case "continue": {
              // §19: end this run (status 'continued') and chain a fresh run of
              // the same workflow with the new input — bounded journal growth.
              const run = this.store.getRun(runId);
              if (!run) throw new Error(`run ${runId} not found during continueAsNew`);
              const name = run.workflowName;
              const definitionVersion = run.definitionVersion;
              const workflowRef = run.workflowRef;
              const runTarget = run.runTarget;
              const nextId = this.idgen();
              const at = this.host.clock();
              // ATOMIC handoff: create the successor AND mark this run 'continued'
              // in one transaction. A crash between cannot leave a resumable
              // original next to an orphan successor (which would re-launch a
              // duplicate on resume — the original is now terminal 'continued').
              this.store.transaction(() => {
                this.store.insertRun({
                  runId: nextId,
                  workflowName: name,
                  definitionVersion,
                  workflowRef,
                  runTarget,
                  status: "running",
                  parentRunId: runId, // lineage
                  tenantId: null,
                  inputRef: JSON.stringify(m.input ?? null),
                  outputRef: null,
                  errorJson: null,
                  heartbeatAtMs: null,
                  runtimeOwnerId: null,
                  launchAuthorityJson: run.launchAuthorityJson,
                  createdAtMs: at,
                });
                this.store.copyRunProfileSnapshot(runId, nextId);
                this.store.copyRunSettingSnapshot(runId, nextId);
                this.store.appendEvent(nextId, "run.started", { name, continuedFrom: runId }, at);
                this.store.updateRun(runId, {
                  status: "continued",
                  outputRef: JSON.stringify({ continuedTo: nextId }),
                  finishedAtMs: at,
                });
                this.store.appendEvent(runId, "run.continued", { continuedTo: nextId }, at);
              });
              cleanupTerminalRunWorkspaces(this.store, runId, "continued", at);
              this.secrets?.wipe(runId);
              // start the successor's execution OUTSIDE the transaction
              void this.execute(nextId, workflowUrl, m.input).catch(() => {
                // Successor failures are persisted by execute; no caller owns this
                // internally chained promise.
              });
              finish(() =>
                resolve({ runId, status: "continued", output: { continuedTo: nextId } as O }),
              );
              break;
            }
            case "error": {
              const at = this.host.clock();
              this.store.transaction(() => {
                this.store.updateRun(runId, {
                  status: "failed",
                  errorJson: JSON.stringify(m.error),
                  finishedAtMs: at,
                });
                this.store.appendEvent(runId, "run.failed", m.error, at);
              });
              cleanupTerminalRunWorkspaces(this.store, runId, "failed", at);
              this.secrets?.wipe(runId); // terminal failure: wipe secrets
              finish(() => reject(rebuildError(m.error)));
              break;
            }
          }
        } catch (hostErr) {
          if (this.isRunInterrupted(runId)) {
            finishInterrupted();
            return;
          }
          if (
            hostErr instanceof ProfileSnapshotIntegrityError ||
            hostErr instanceof SettingSnapshotIntegrityError
          ) {
            const at = this.host.clock();
            const error = serializeError(hostErr);
            this.store.transaction(() => {
              this.store.updateRun(runId, {
                status: "failed",
                errorJson: JSON.stringify(error),
                finishedAtMs: at,
              });
              this.store.appendEvent(runId, "run.failed", error, at);
            });
            cleanupTerminalRunWorkspaces(this.store, runId, "failed", at);
            this.secrets?.wipe(runId);
            finish(() => reject(hostErr));
            return;
          }
          // A host-side fault (e.g. injected crash) — leave the run resumable and
          // tear down; the pending row written before the fault drives re-execution.
          this.store.appendEvent(
            runId,
            "run.aborted",
            { name: "HostFault", message: String(hostErr) },
            this.host.clock(),
          );
          finish(() => reject(hostErr));
        }
      };

      worker.onerror = (e: ErrorEvent) => {
        if (this.isRunInterrupted(runId)) {
          finishInterrupted();
          return;
        }
        const err = new Error(`realm worker error: ${e.message}`);
        const at = this.host.clock();
        const error = serializeError(err);
        this.store.transaction(() => {
          this.store.updateRun(runId, {
            status: "failed",
            errorJson: JSON.stringify(error),
            finishedAtMs: at,
          });
          this.store.appendEvent(runId, "run.failed", error, at);
        });
        cleanupTerminalRunWorkspaces(this.store, runId, "failed", at);
        this.secrets?.wipe(runId);
        finish(() => reject(err));
      };
    });
  }
}

function rebuildError(e: { name: string; message: string }): Error {
  const err = new Error(e.message);
  err.name = e.name;
  return err;
}

function redactInterruptionReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const redacted = redactCapabilityTokens(reason).trim();
  return redacted.length > 0 ? redacted : undefined;
}

function serializeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "Error", message: String(err) };
}

function readSourceSafe(workflowUrl: string): string | null {
  try {
    const path = workflowUrl.startsWith("file:") ? new URL(workflowUrl).pathname : workflowUrl;
    return readFileSync(path, "utf8");
  } catch {
    return null; // not a readable file (e.g. a bare module id) — skip the lint
  }
}
