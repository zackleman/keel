// The `ctx` authoring surface (DESIGN.md §9.1).
//
// WorkflowCtx is the host-local implementation used by focused tests and
// adapter-level helpers. Production workflow execution goes through RealmKernel,
// which runs workflow modules in a Worker while sharing the same StepEngine.

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type Capabilities,
  type ToolPolicy,
  resolveToolPolicy,
  validateProviderToolPolicy,
} from "../agents/capabilities.ts";
import {
  DEFAULT_AGENT_LENIENT,
  DEFAULT_AGENT_ON_FAILURE,
  DEFAULT_AGENT_PROVIDER,
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_SCHEMA_MAX_RETRIES,
  DEFAULT_STALL_RETRIES,
} from "../agents/defaults.ts";
import {
  type AgentEnvironmentSpec,
  assertEnvironmentSecretsGranted,
  hasAgentEnvironment,
  normalizeAgentEnvironment,
} from "../agents/environment.ts";
import { AgentFailure, executeAgent, runAgentWithStall } from "../agents/execute.ts";
import { type AgentProfiles, resolveProfile } from "../agents/profiles.ts";
import { resolveSelectedProviderConfig } from "../agents/provider-config.ts";
import type { AgentProviderRegistry, ProviderConfigMap } from "../agents/types.ts";
import type { Json } from "../hash.ts";
import type { JournalStore } from "../journal/store.ts";
import { requireRunTarget } from "../target.ts";
import { WORKFLOW_SDK_ABI_VERSION } from "../workflow-definitions/abi.ts";
import { DEFAULT_WORKSPACE_ID, workspaceIdentity } from "../workspace/identity.ts";
import { resolveUsableDirectory } from "../workspace/worktree.ts";
import { finalAgentMessageEvents } from "./agent-events.ts";
import {
  type CheckpointSpec,
  checkpointVersionIdentity,
  normalizeCheckpoint,
} from "./checkpoint.ts";
import {
  type CommandResult,
  type NormalizedWorkflowCommandSpec,
  type WorkflowCommandSpec,
  applyCommandFailureMode,
  buildCommandEnvironment,
  commandCompletedEvent,
  commandStartedEvent,
  normalizeWorkflowCommandSpec,
} from "./command.ts";
import { runCompletionCheck } from "./completion-check-runner.ts";
import {
  type CompletionCheckEffectSpec,
  type CompletionCheckResult,
  completionCheckCompletedEvent,
  completionCheckStartedEvent,
  normalizeCompletionCheckEffectSpec,
} from "./completion-check.ts";
import { drainSignalsVersionIdentity, normalizeDrainSignals } from "./drain-signals.ts";
import { runBoundedProcess } from "./process-runner.ts";
import type { Schema } from "./schema.ts";
import type { ChildRunOutcome, SpawnHandle, SpawnSpec } from "./spawn.ts";
import {
  type StateNamespace,
  type StateSchemas,
  normalizeStateNamespace,
  normalizeStateWrite,
  stateVersionIdentity,
} from "./state.ts";
import { StepEngine, prepareStepResult } from "./step-engine.ts";
import { computeVersion } from "./version.ts";
import type { WorkspaceSetupSpec } from "./workspace-setup.ts";

export type {
  BoundedText,
  CommandResult,
  CommandResultStatus,
  WorkflowCommandBase,
  WorkflowCommandSpec,
} from "./command.ts";
export type {
  BranchPushedCompletionCheck,
  CommandCompletionCheck,
  CompletionCheck,
  CompletionCheckAttempt,
  CompletionCheckEffectSpec,
  CompletionCheckFailureAction,
  CompletionCheckFailureKind,
  CompletionCheckResult,
  CompletionCheckStatus,
  CompletionCheckTrigger,
  GitCleanCompletionCheck,
  HasCommitsCompletionCheck,
  NormalizedCompletionCheck,
} from "./completion-check.ts";
export type { CheckpointSpec } from "./checkpoint.ts";
export type { StateNamespace, StateSchemas, StateSetSpec } from "./state.ts";
export type {
  ChildRunCapability,
  ChildRunOutcome,
  SpawnHandle,
  SpawnSpec,
} from "./spawn.ts";
export type { WorkspaceSetupCommand, WorkspaceSetupSpec } from "./workspace-setup.ts";

const SESSION_STABLE_KEY_PREFIX = "__session.";

interface AgentControls {
  maxRetries: number;
  lenient: boolean;
  onFailure: "throw" | "null";
  timeoutMs: number;
  stallRetries: number;
}

function resolveInProcessAgentControls(spec: {
  maxRetries?: number;
  lenient?: boolean;
  onFailure?: "throw" | "null";
  timeoutMs?: number;
  stallRetries?: number;
}): AgentControls {
  return {
    maxRetries: spec.maxRetries ?? DEFAULT_SCHEMA_MAX_RETRIES,
    lenient: spec.lenient ?? DEFAULT_AGENT_LENIENT,
    onFailure: spec.onFailure ?? DEFAULT_AGENT_ON_FAILURE,
    timeoutMs: spec.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS,
    stallRetries: spec.stallRetries ?? DEFAULT_STALL_RETRIES,
  };
}

function assertNotReservedAuthorKey(key: string, kind: string): void {
  if (key.startsWith(SESSION_STABLE_KEY_PREFIX)) {
    throw new Error(`${kind} key "${key}" uses reserved prefix ${SESSION_STABLE_KEY_PREFIX}`);
  }
}

/** Optional per-step controls. `version` pins an explicit version (tests);
 * `bump` is the author's manual structural-invalidation knob (§5.2). */
export interface StepOpts {
  version?: string;
  bump?: string | number;
}

/** ctx.agent specification (DESIGN.md §9.1). */
export interface AgentSpec<T> {
  /** Stable step key (use ctx.stepKey for fan-out). */
  key: string;
  prompt: string;
  /** Named profile (daemon-configured) whose settings this spec inherits; the
   * resolved fields enter the version hash, the name does not. */
  profile?: string;
  /** Provider name; defaults to "pi" in v0 (L19). */
  provider?: string;
  /** Provider-keyed, JSON-only config; only the selected provider's entry is used. */
  providerConfig?: ProviderConfigMap;
  schema?: Schema<T>;
  model?: string;
  /** Reasoning/thinking effort (Pi: off|minimal|low|medium|high|xhigh). */
  reasoning?: string;
  /** Semantic tool baseline; provider adapters map it to native tool flags. */
  toolPolicy?: ToolPolicy;
  /** Provider-native tools to add on top of `toolPolicy`. */
  allowTools?: string[];
  /** Provider-native tools to remove from the final provider allowlist. */
  denyTools?: string[];
  /** Resolved workspace handle. Defaults to the scoped/default run workspace. */
  workspace?: WorkspaceHandle;
  /** Explicit capabilities; overrides the default read-only policy (§11). */
  capabilities?: Partial<Capabilities>;
  /** Literal env vars and named secret refs to inject at invocation (§11.2). */
  environment?: AgentEnvironmentSpec;
  /** Terminal-failure policy after retries (D7): default 'throw'. */
  onFailure?: "throw" | "null";
  /** In-session validation retries (default 2). */
  maxRetries?: number;
  /** Opt into tolerant schema coercion (default strict). Use for loose models. */
  lenient?: boolean;
  /** Per-attempt stall timeout in ms (default 1 hour, §12.2). */
  timeoutMs?: number;
  /** Stall retries before StepTimeoutError (default 1). */
  stallRetries?: number;
  bump?: string | number;
  version?: string;
}

export type AgentSessionSpec = Omit<
  AgentSpec<unknown>,
  | "key"
  | "prompt"
  | "schema"
  | "onFailure"
  | "maxRetries"
  | "lenient"
  | "timeoutMs"
  | "stallRetries"
  | "bump"
  | "version"
> & {
  key: string;
};

export interface AgentTurnSpec<T> {
  key: string;
  prompt: string;
  schema?: Schema<T>;
  onFailure?: "throw" | "null";
  maxRetries?: number;
  lenient?: boolean;
  timeoutMs?: number;
  stallRetries?: number;
  bump?: string | number;
  version?: string;
}

export type WorkspaceMode = "direct" | "worktree" | "copy" | "clone";

export type WorkspaceRetention = "remove" | "retain-on-failure" | "retain";

export type WorkspaceSpec =
  | {
      key: string;
      mode?: "direct";
      path?: string;
      setup?: WorkspaceSetupSpec;
    }
  | {
      key: string;
      mode: "worktree";
      path?: string;
      ref?: string;
      retention?: WorkspaceRetention;
      branch?: boolean;
      setup?: WorkspaceSetupSpec;
    }
  | {
      key: string;
      mode: "copy";
      path?: string;
      retention?: WorkspaceRetention;
      setup?: WorkspaceSetupSpec;
    }
  | {
      key: string;
      mode: "clone";
      repo: string;
      ref?: string;
      retention?: WorkspaceRetention;
      setup?: WorkspaceSetupSpec;
    };

export interface WorkspaceHandle {
  readonly id: string;
  readonly identityHash?: string;
  readonly setupIdentityHash?: string | null;
}

export interface AgentSession {
  turn<T>(spec: AgentTurnSpec<T>): Promise<T>;
}

export interface HumanSpec {
  /** Stable key for the approval request (durable across resume). */
  key: string;
  /** What the human is being asked to decide. */
  prompt: string;
  /** Optional capabilities this gate may grant on approval (§11.3). */
  requestedCaps?: Partial<Capabilities>;
}

export interface HumanDecision {
  status: "approved" | "denied";
  note: string | null;
  grantedCaps: unknown;
}

export interface Ctx {
  readonly run: {
    readonly id: string;
    readonly target: string;
  };

  /** Resolve a run-scoped workspace handle for agents/sessions. */
  workspace(spec: WorkspaceSpec): Promise<WorkspaceHandle>;

  /** Bind a workspace as the scoped default for agents/sessions in `fn`. */
  withWorkspace<T>(specOrHandle: WorkspaceSpec | WorkspaceHandle, fn: () => Promise<T>): Promise<T>;

  /** Pure, memoized step. `fn` must be deterministic in its explicit `inputs`.
   * `inputs` must be JSON-serializable at runtime (hashJson enforces it); the
   * type is left open so typed domain objects read cleanly. */
  step<T, I>(
    key: string,
    schema: Schema<T>,
    inputs: I,
    fn: (inputs: I) => T | Promise<T>,
    opts?: StepOpts,
  ): Promise<T>;

  /** Effectful agent call: journaled; a completed one never re-runs on resume. */
  agent<T>(spec: AgentSpec<T>): Promise<T>;

  /** Durable host-side command effect in an explicit workspace. */
  command(spec: WorkflowCommandSpec): Promise<CommandResult>;

  /** Durable host-side completion gate in an explicit workspace. */
  completionCheck(spec: CompletionCheckEffectSpec): Promise<CompletionCheckResult>;

  /** Journal a durable, strictly ordered progress update. */
  checkpoint(spec: CheckpointSpec): Promise<void>;

  /** Open a run-scoped state namespace. The handle itself is pure and synchronous. */
  state<S extends Record<string, Json>>(
    namespace: string,
    schemas?: StateSchemas<S>,
  ): StateNamespace<S>;

  /** Atomically consume all currently pending signals of `name` without parking. */
  drainSignals<T = unknown>(key: string, name: string): Promise<T[]>;

  /** Start a saved workflow as a durable child run. */
  spawn(key: string, spec: SpawnSpec): Promise<SpawnHandle>;

  /** Await and journal a durable child run's terminal outcome. */
  waitRun<T = unknown>(key: string, handle: SpawnHandle): Promise<ChildRunOutcome<T>>;

  /** Realm-only durable logical agent session. */
  agentSession(spec: AgentSessionSpec): AgentSession;

  /** Journaled wall-clock — the only time source in workflow scope. */
  now(): number;
  /** Journaled entropy — the only randomness in workflow scope. */
  random(): number;

  /** Durably sleep `ms` (§16). `key` is a stable author-supplied identity (like a
   * step key) so reordering/inserting waits never reattaches a persisted timer to
   * the wrong site; the duration is folded into the identity, so changing it is a
   * new timer. The run parks (waiting-timer) at zero cost; survives restarts. */
  sleep(key: string, ms: number): Promise<void>;

  /** Park (waiting-human) until a decision is delivered via the API (§17). */
  human(spec: HumanSpec): Promise<HumanDecision>;

  /** Park (waiting-signal) until a named external signal arrives; returns its
   * payload (§17). Ordered: the Nth ctx.signal(name) consumes the Nth signal. */
  signal<T = unknown>(name: string): Promise<T>;

  /** End this run (status 'continued') and start a fresh run of the same
   * workflow with `input` — bounds journal growth for long-lived/cron
   * workflows (§19). Never returns. */
  continueAsNew(input: unknown): Promise<never>;

  /** Stable fan-out key from a semantic name + a content-derived id. */
  stepKey(semanticName: string, stableId: string): string;

  /** Narration persisted to the event log (advisory, not control flow). */
  log(message: string, data?: Json): void;
  phase(title: string): void;
}

/**
 * Fault-injection points around the write-ahead protocol (§5.5), used by the
 * crash harness to die at precise boundaries:
 *  - "after-pending": the pending row is committed but `fn` has not run.
 *  - "before-commit": `fn` has run but the completed row is not yet committed.
 */
export type FaultPoint = "after-pending" | "before-commit";

export interface CtxHost {
  /** Wall-clock source the kernel injects (deterministic in tests). */
  clock: () => number;
  /** Entropy source the kernel injects (deterministic in tests). */
  rng: () => number;
  /** Optional crash/fault hook; a no-op in production. */
  fault?: (point: FaultPoint, key: string) => void;
  /** Push a live, non-durable event frame to current watchers. */
  liveEvent?: (runId: string, type: string, payload: Json, atMs: number) => void;
}

/** In-process `ctx`: runs step fns locally, journals via StepEngine. */
export class WorkflowCtx implements Ctx {
  private readonly engine: StepEngine;
  private readonly stateValues = new Map<string, Map<string, Json>>();
  private readonly registry: AgentProviderRegistry | undefined;
  private readonly agentProfiles: Record<string, unknown> | undefined;
  private readonly workspaceScope = new AsyncLocalStorage<WorkspaceHandle>();
  private readonly host: CtxHost;

  constructor(
    private readonly store: JournalStore,
    private readonly runId: string,
    host: CtxHost,
    registry?: AgentProviderRegistry,
    agentProfiles?: Record<string, unknown>,
    private readonly runTarget: string | null = null,
  ) {
    this.host = host;
    this.engine = new StepEngine(store, runId, host);
    this.registry = registry;
    this.agentProfiles = agentProfiles;
  }

  get run(): { readonly id: string; readonly target: string } {
    return Object.freeze({
      id: this.runId,
      target: requireRunTarget(this.runTarget, "ctx.run.target"),
    });
  }

  async workspace(spec: WorkspaceSpec): Promise<WorkspaceHandle> {
    const normalized = normalizeWorkspaceSpec(spec, this.runTarget);
    if (normalized.key === DEFAULT_WORKSPACE_ID) {
      throw new Error(
        `workspace key ${DEFAULT_WORKSPACE_ID} is reserved for the run default workspace`,
      );
    }
    if (normalized.mode !== "direct") {
      throw new Error(`ctx.workspace({ mode: "${normalized.mode}" }) requires the realm kernel`);
    }
    if (normalized.setup !== undefined) {
      throw new Error("ctx.workspace({ setup }) requires the realm kernel");
    }
    const now = Date.now();
    const identity = workspaceIdentity({
      key: normalized.key,
      mode: "direct",
      ownerKind: "workflow",
      path: normalized.path,
      sdkAbiVersion: WORKFLOW_SDK_ABI_VERSION,
    });
    const existing = this.store.getAgentWorkspace(this.runId, normalized.key);
    if (existing) {
      if (existing.workspaceIdentityHash !== identity.hash) {
        throw new Error(
          `workspace "${normalized.key}" identity changed; use a new workspace key or a fresh run`,
        );
      }
      return Object.freeze({
        id: existing.workspaceId,
        identityHash: existing.workspaceIdentityHash,
      });
    }
    this.store.insertAgentWorkspace({
      runId: this.runId,
      workspaceId: normalized.key,
      mode: "direct",
      ownerKind: "workflow",
      key: normalized.key,
      lastAttempt: null,
      retentionPolicy: null,
      workspacePath: normalized.path,
      sourceKind: "direct-path",
      sourcePath: normalized.path,
      sourceUri: null,
      sourceBare: null,
      sourceMergeEligible: false,
      suppliedPath: normalized.suppliedPath,
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
      createdAtMs: now,
      updatedAtMs: now,
      mergedAtMs: null,
      discardedAtMs: null,
      removedAtMs: null,
    });
    return Object.freeze({ id: normalized.key, identityHash: identity.hash });
  }

  async withWorkspace<T>(
    specOrHandle: WorkspaceSpec | WorkspaceHandle,
    fn: () => Promise<T>,
  ): Promise<T> {
    const handle = isWorkspaceHandle(specOrHandle)
      ? specOrHandle
      : await this.workspace(specOrHandle);
    return await this.workspaceScope.run(handle, fn);
  }

  async step<T, I>(
    key: string,
    schema: Schema<T>,
    inputs: I,
    fn: (inputs: I) => T | Promise<T>,
    opts?: StepOpts,
  ): Promise<T> {
    assertNotReservedAuthorKey(key, "ctx.step");
    const version =
      opts?.version ??
      computeVersion({ fn, schema, ...(opts?.bump !== undefined ? { bump: opts.bump } : {}) });
    const begun = this.engine.beginStep(key, inputs as Json, version, null);
    if (begun.kind === "replay") {
      return begun.value as T;
    }
    try {
      const raw = await fn(inputs);
      const result = schema.parse(raw);
      this.engine.completeStep(
        key,
        begun.attempt,
        version,
        begun.inputHash,
        begun.startedAtMs,
        result,
        null,
      );
      return result;
    } catch (err) {
      this.engine.failStep(key, begun.attempt, version, begun.inputHash, begun.startedAtMs, err);
      throw err;
    }
  }

  async checkpoint(rawSpec: CheckpointSpec): Promise<void> {
    const spec = normalizeCheckpoint(rawSpec);
    assertNotReservedAuthorKey(spec.stableKey, "ctx.checkpoint");
    const version = computeVersion({ spec: checkpointVersionIdentity() });
    const begun = this.engine.beginCheckpoint(spec.stableKey, spec.identity, version, null);
    if (begun.kind === "replay") return;

    this.engine.completeStep(
      spec.stableKey,
      begun.attempt,
      version,
      begun.inputHash,
      begun.startedAtMs,
      spec.result,
      null,
      "checkpoint",
      [
        {
          type: "checkpoint",
          payload: {
            stableKey: spec.stableKey,
            attempt: begun.attempt,
            message: spec.message,
            data: spec.data,
          },
        },
      ],
    );
  }

  state<S extends Record<string, Json>>(
    rawNamespace: string,
    schemas?: StateSchemas<S>,
  ): StateNamespace<S> {
    const namespace = normalizeStateNamespace(rawNamespace);
    let values = this.stateValues.get(namespace);
    if (!values) {
      values = new Map<string, Json>();
      this.stateValues.set(namespace, values);
    }
    const fold = values;
    return Object.freeze({
      set: async <K extends keyof S & string>(rawSpec: {
        key: string;
        name: K;
        value: S[K];
      }): Promise<void> => {
        const spec = normalizeStateWrite(namespace, schemas, rawSpec);
        assertNotReservedAuthorKey(spec.stableKey, "ctx.state.set");
        const version = computeVersion({ spec: stateVersionIdentity(spec.schemaHash) });
        const begun = this.engine.beginStateWrite(
          spec.stableKey,
          spec.identity,
          version,
          spec.namespace,
          spec.name,
        );
        if (begun.kind === "execute") {
          this.engine.completeStateWrite(
            spec.stableKey,
            begun.attempt,
            version,
            begun.inputHash,
            begun.startedAtMs,
            spec.namespace,
            spec.name,
            spec.value,
          );
        }
        fold.set(spec.name, spec.value);
      },
      get: <K extends keyof S & string>(name: K): S[K] | undefined =>
        fold.get(name) as S[K] | undefined,
      snapshot: (): Readonly<Partial<S>> => Object.freeze(Object.fromEntries(fold) as Partial<S>),
    });
  }

  async drainSignals<T>(key: string, name: string): Promise<T[]> {
    const spec = normalizeDrainSignals(key, name);
    assertNotReservedAuthorKey(spec.stableKey, "ctx.drainSignals");
    const version = computeVersion({ spec: drainSignalsVersionIdentity() });
    const begun = this.engine.beginDrainSignals(spec.stableKey, spec.identity, version, null);
    if (begun.kind === "replay") return begun.value as T[];

    return this.engine.completeDrainSignals(
      spec.stableKey,
      begun.attempt,
      version,
      begun.inputHash,
      begun.startedAtMs,
      spec.name,
    ) as T[];
  }

  async agent<T>(rawSpec: AgentSpec<T>): Promise<T> {
    if (!this.registry) {
      throw new Error("ctx.agent requires an agent provider registry");
    }
    // Resolve a named profile before versioning (resolved fields enter the hash).
    const spec = resolveProfile(
      rawSpec,
      this.agentProfiles as AgentProfiles | undefined,
    ) as AgentSpec<T>;
    assertNotReservedAuthorKey(spec.key, "ctx.agent");
    rejectRemovedWorkspaceFields(rawSpec, `ctx.agent("${spec.key}")`);
    const provider = spec.provider ?? DEFAULT_AGENT_PROVIDER;
    const profileProviderConfig = rawSpec.profile
      ? (this.agentProfiles as AgentProfiles | undefined)?.[rawSpec.profile]?.providerConfig
      : undefined;
    const selectedProviderConfig = resolveSelectedProviderConfig({
      context: `ctx.agent("${spec.key}")`,
      selectedProvider: provider,
      explicitProviderConfig: spec.providerConfig,
      profileName: rawSpec.profile,
      profileProviderConfig,
    });
    // Resolve capabilities identically to the realm path so the two front-ends
    // produce the same version hash for the same spec (identity parity, §11).
    const tools = resolveToolPolicy(
      {
        ...(spec.capabilities ? { capabilities: spec.capabilities } : {}),
        ...(spec.toolPolicy ? { toolPolicy: spec.toolPolicy } : {}),
        ...(spec.allowTools ? { allowTools: spec.allowTools } : {}),
        ...(spec.denyTools ? { denyTools: spec.denyTools } : {}),
      },
      { path: `ctx.agent("${spec.key}")` },
    );
    validateProviderToolPolicy(provider, tools, `ctx.agent("${spec.key}")`);
    const caps = tools.capabilities;
    const environment = normalizeAgentEnvironment(spec.environment, {
      path: `ctx.agent("${spec.key}").environment`,
    });
    assertEnvironmentSecretsGranted(environment, caps, `ctx.agent("${spec.key}")`);
    // Secret value resolution is realm-only (the side channel lives on the daemon host).
    if (environment.secrets.length > 0) {
      throw new Error(
        "ctx.agent({ environment: { secrets } }) requires the realm kernel (secret side-channel)",
      );
    }
    const workspaceHandle = this.resolveAgentWorkspaceHandle(spec.workspace);
    const workspaceId = workspaceHandle.id;
    const workspaceIdentityHash = workspaceHandle.identityHash ?? null;
    const cwd = this.resolveInProcessWorkspace(workspaceId, spec.key);
    const controls = resolveInProcessAgentControls(spec);
    const identityFields = {
      prompt: spec.prompt,
      provider,
      ...(selectedProviderConfig !== undefined ? { providerConfig: selectedProviderConfig } : {}),
      model: spec.model ?? null,
      reasoning: spec.reasoning ?? null,
      toolPolicy: tools.toolPolicy,
      allowTools: tools.allowTools,
      denyTools: tools.denyTools,
      workspaceId,
      ...(workspaceIdentityHash !== null ? { workspaceIdentityHash } : {}),
      capabilities: caps,
      environment,
      controls,
    };
    const version =
      spec.version ??
      computeVersion({
        spec: identityFields,
        schema: spec.schema,
        ...(spec.bump !== undefined ? { bump: spec.bump } : {}),
      });
    const inputs = identityFields;
    const begun = this.engine.beginStep(
      spec.key,
      inputs as unknown as Json,
      version,
      null,
      "effectful",
    );
    if (begun.kind === "replay") {
      return begun.value as T;
    }
    try {
      const jsonSchema = spec.schema?.structural?.();
      const execution = await runAgentWithStall(
        (signal) =>
          executeAgent(
            this.registry?.get(provider) as ReturnType<NonNullable<typeof this.registry>["get"]>,
            {
              key: spec.key,
              provider,
              prompt: spec.prompt,
              ...(selectedProviderConfig !== undefined
                ? { providerConfig: selectedProviderConfig }
                : {}),
              ...(spec.model ? { model: spec.model } : {}),
              ...(spec.reasoning ? { reasoning: spec.reasoning } : {}),
              toolPolicy: tools.toolPolicy,
              allowTools: tools.allowTools,
              denyTools: tools.denyTools,
              capabilities: caps,
              cwd,
              ...(hasAgentEnvironment(environment) ? { env: environment.vars } : {}),
              ...(begun.resumeToken ? { resumeToken: begun.resumeToken } : {}),
              abortSignal: signal,
            },
            {
              onSessionToken: (tok) => this.engine.recordSessionToken(spec.key, begun.attempt, tok),
              onEvent: (e) => this.engine.emitAgentTrace(spec.key, begun.attempt, e),
            },
            {
              ...(jsonSchema !== undefined ? { jsonSchema } : {}),
              maxRetries: controls.maxRetries,
              ...(controls.lenient ? { coerce: true } : {}),
            },
          ),
        {
          timeoutMs: controls.timeoutMs,
          stallRetries: controls.stallRetries,
          onStall: (a) => this.engine.emit("agent.stalled", { key: spec.key, attempt: a }),
        },
      );
      this.engine.completeStep(
        spec.key,
        begun.attempt,
        version,
        begun.inputHash,
        begun.startedAtMs,
        execution.output,
        null,
        "effectful",
        finalAgentMessageEvents(spec.key, begun.attempt, execution.text),
      );
      return execution.output as T;
    } catch (err) {
      // onFailure:'null' (D7): journal a completed null so resume replays it.
      if (controls.onFailure === "null" && err instanceof AgentFailure) {
        this.engine.emit("agent.tolerated_failure", {
          key: spec.key,
          error: { name: err.name, message: err.message },
        });
        this.engine.completeStep(
          spec.key,
          begun.attempt,
          version,
          begun.inputHash,
          begun.startedAtMs,
          null,
          null,
          "effectful",
        );
        return null as T;
      }
      this.engine.failStep(
        spec.key,
        begun.attempt,
        version,
        begun.inputHash,
        begun.startedAtMs,
        err,
        "effectful",
      );
      throw err;
    }
  }

  async command(rawSpec: WorkflowCommandSpec): Promise<CommandResult> {
    const command = normalizeWorkflowCommandSpec(rawSpec, { path: "ctx.command" });
    if (command.environment.secrets.length > 0) {
      throw new Error(
        "ctx.command({ environment: { secrets } }) requires the realm kernel (secret side-channel)",
      );
    }
    const workspace = this.resolveInProcessCommandWorkspace(command);
    const version = computeVersion({ spec: command.identity });
    const begun = this.engine.beginCommand(command.stableKey, command.identity, version, null);
    if (begun.kind === "replay") {
      const result = begun.value as CommandResult;
      applyCommandFailureMode(result, command.failureMode);
      return result;
    }

    this.acquireInProcessCommandWorkspace(command, begun.attempt, begun.startedAtMs);
    this.engine.emit("command.started", commandStartedEvent(command, begun.attempt));
    let result: CommandResult;
    try {
      result = await runBoundedProcess({
        command,
        attempt: begun.attempt,
        cwd: workspace.resolvedCwd,
        env: buildCommandEnvironment(command.environment, []),
      });
    } catch (err) {
      this.releaseInProcessCommandWorkspace(command, begun.attempt, this.host.clock());
      this.engine.failStep(
        command.stableKey,
        begun.attempt,
        version,
        begun.inputHash,
        begun.startedAtMs,
        err,
        "command",
      );
      throw err;
    }
    let completed: CommandResult;
    try {
      completed = this.completeInProcessCommand(command, begun, version, result);
    } catch (err) {
      this.releaseInProcessCommandWorkspace(command, begun.attempt, this.host.clock());
      throw err;
    }
    applyCommandFailureMode(completed, command.failureMode);
    return completed;
  }

  async completionCheck(rawSpec: CompletionCheckEffectSpec): Promise<CompletionCheckResult> {
    const spec = normalizeCompletionCheckEffectSpec(rawSpec, { path: "ctx.completionCheck" });
    const version = computeVersion({ spec: spec.identity });
    const begun = this.engine.beginCompletionCheck(spec.stableKey, spec.identity, version, null);
    if (begun.kind === "replay") return begun.value as CompletionCheckResult;
    this.engine.emit("completion_check.started", completionCheckStartedEvent(spec));
    const result = await runCompletionCheck({
      store: this.store,
      runId: this.runId,
      spec,
      startedAtMs: begun.startedAtMs,
      clock: this.host.clock,
    });
    this.host.fault?.("before-commit", spec.stableKey);
    const stored = prepareStepResult(result);
    const finishedAtMs = this.host.clock();
    this.store.transaction(() => {
      if (stored.artifact) {
        this.store.putArtifact(stored.artifact.hash, stored.artifact.bytes, finishedAtMs);
      }
      this.store.appendEvent(
        this.runId,
        "completion_check.completed",
        completionCheckCompletedEvent(spec, result),
        finishedAtMs,
      );
      this.store.putJournalRow({
        runId: this.runId,
        stableKey: spec.stableKey,
        attempt: begun.attempt,
        effectType: "completion_check",
        status: "completed",
        version,
        inputHash: begun.inputHash,
        inputDeps: null,
        resultInline: stored.inline,
        resultArtifact: stored.artifact?.hash ?? null,
        startedAtMs: begun.startedAtMs,
        finishedAtMs,
      });
    });
    return result;
  }

  private resolveInProcessCommandWorkspace(command: NormalizedWorkflowCommandSpec): {
    resolvedCwd: string;
  } {
    const row = this.store.getAgentWorkspace(this.runId, command.workspaceId);
    if (!row) {
      throw new Error(`workspace handle "${command.workspaceId}" was not created in this run`);
    }
    if (row.mode !== "direct") {
      throw new Error(`ctx.command with ${row.mode} workspace requires the realm kernel`);
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
    return { resolvedCwd };
  }

  private acquireInProcessCommandWorkspace(
    command: NormalizedWorkflowCommandSpec,
    attempt: number,
    atMs: number,
  ): void {
    this.store.updateAgentWorkspace(this.runId, command.workspaceId, {
      status: "active",
      activeHolderKind: "command",
      activeHolderKey: command.stableKey,
      activeHolderAttempt: attempt,
      activeStartedAtMs: atMs,
      updatedAtMs: atMs,
    });
  }

  private releaseInProcessCommandWorkspace(
    command: NormalizedWorkflowCommandSpec,
    attempt: number,
    atMs: number,
  ): void {
    const row = this.store.getAgentWorkspace(this.runId, command.workspaceId);
    if (!row) return;
    if (
      row.activeHolderKind &&
      (row.activeHolderKind !== "command" ||
        row.activeHolderKey !== command.stableKey ||
        row.activeHolderAttempt !== attempt)
    ) {
      throw new Error(
        `workspace "${command.workspaceId}" active holder changed while command was running`,
      );
    }
    const workspaceExists =
      existsSync(row.workspacePath) && statSync(row.workspacePath).isDirectory();
    this.store.updateAgentWorkspace(this.runId, command.workspaceId, {
      status: workspaceExists || !row.owned ? "idle" : "abandoned",
      ...(workspaceExists || !row.owned ? {} : { failureSeen: true }),
      activeHolderKind: null,
      activeHolderKey: null,
      activeHolderAttempt: null,
      activeStartedAtMs: null,
      updatedAtMs: atMs,
    });
  }

  private completeInProcessCommand(
    command: NormalizedWorkflowCommandSpec,
    begun: { attempt: number; inputHash: string; startedAtMs: number },
    version: string,
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
        this.runId,
        "command.completed",
        commandCompletedEvent(command, completed),
        finishedAtMs,
      );
      this.store.putJournalRow({
        runId: this.runId,
        stableKey: command.stableKey,
        attempt: begun.attempt,
        effectType: "command",
        status: "completed",
        version,
        inputHash: begun.inputHash,
        inputDeps: null,
        resultInline: stored.inline,
        resultArtifact: stored.artifact?.hash ?? null,
        startedAtMs: begun.startedAtMs,
        finishedAtMs,
      });
      this.releaseInProcessCommandWorkspace(command, begun.attempt, finishedAtMs);
    });
    return completed;
  }

  private resolveAgentWorkspaceHandle(handle: WorkspaceHandle | undefined): WorkspaceHandle {
    return handle ?? this.workspaceScope.getStore() ?? { id: DEFAULT_WORKSPACE_ID };
  }

  private resolveInProcessWorkspace(workspaceId: string, agentKey: string): string {
    if (workspaceId === DEFAULT_WORKSPACE_ID) {
      const target = requireRunTarget(this.runTarget, `agent "${agentKey}" run target`);
      const path = resolveUsableDirectory(target);
      const existing = this.store.getAgentWorkspace(this.runId, DEFAULT_WORKSPACE_ID);
      if (!existing) {
        const now = Date.now();
        const identity = workspaceIdentity({
          key: DEFAULT_WORKSPACE_ID,
          mode: "direct",
          ownerKind: "workflow",
          path,
          sdkAbiVersion: WORKFLOW_SDK_ABI_VERSION,
        });
        this.store.insertAgentWorkspace({
          runId: this.runId,
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
          suppliedPath: target,
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
          createdAtMs: now,
          updatedAtMs: now,
          mergedAtMs: null,
          discardedAtMs: null,
          removedAtMs: null,
        });
      }
      return path;
    }
    const row = this.store.getAgentWorkspace(this.runId, workspaceId);
    if (!row) throw new Error(`workspace handle "${workspaceId}" was not created in this run`);
    if (row.mode !== "direct") {
      throw new Error(`workspace "${workspaceId}" mode ${row.mode} requires the realm kernel`);
    }
    return resolveUsableDirectory(row.workspacePath);
  }

  async spawn(_key: string, _spec: SpawnSpec): Promise<SpawnHandle> {
    throw new Error("ctx.spawn requires the realm kernel");
  }

  async waitRun<T>(_key: string, _handle: SpawnHandle): Promise<ChildRunOutcome<T>> {
    throw new Error("ctx.waitRun requires the realm kernel");
  }

  agentSession(_spec: AgentSessionSpec): AgentSession {
    throw new Error("ctx.agentSession requires the realm kernel");
  }

  now(): number {
    return this.engine.now();
  }

  random(): number {
    return this.engine.random();
  }

  // Durable park/wake (sleep/signal/human) requires the realm host's suspend
  // machinery.
  async sleep(_key: string, _ms: number): Promise<void> {
    throw new Error("ctx.sleep requires the realm kernel (durable park/wake)");
  }

  async human(_spec: HumanSpec): Promise<HumanDecision> {
    throw new Error("ctx.human requires the realm kernel (durable park/wake)");
  }

  async signal<T>(_name: string): Promise<T> {
    throw new Error("ctx.signal requires the realm kernel (durable park/wake)");
  }

  async continueAsNew(_input: unknown): Promise<never> {
    throw new Error("ctx.continueAsNew requires the realm kernel");
  }

  stepKey(semanticName: string, stableId: string): string {
    return `${semanticName}:${stableId}`;
  }

  log(message: string, data?: Json): void {
    this.engine.emit("log", { message, data: data ?? null });
  }

  phase(title: string): void {
    this.engine.emit("phase", { title });
  }
}

function isWorkspaceHandle(value: WorkspaceSpec | WorkspaceHandle): value is WorkspaceHandle {
  return (
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    typeof (value as { id?: unknown }).id === "string" &&
    !("key" in value)
  );
}

function normalizeWorkspaceSpec(
  spec: WorkspaceSpec,
  runTarget: string | null,
):
  | {
      key: string;
      mode: "direct";
      path: string;
      suppliedPath: string | null;
      setup?: unknown;
    }
  | {
      key: string;
      mode: "worktree" | "copy";
      path: string;
      suppliedPath: string | null;
      ref?: string;
      retention: WorkspaceRetention;
      branch?: boolean;
      setup?: unknown;
    }
  | {
      key: string;
      mode: "clone";
      repo: string;
      ref: string | null;
      retention: WorkspaceRetention;
      setup?: unknown;
    } {
  const raw = spec as Record<string, unknown>;
  if (typeof raw.key !== "string" || raw.key.trim().length === 0) {
    throw new Error("WorkspaceSpec.key is required and must be a non-empty string");
  }
  const mode = raw.mode === undefined ? "direct" : raw.mode;
  if (mode !== "direct" && mode !== "worktree" && mode !== "copy" && mode !== "clone") {
    throw new Error(`workspace mode must be direct, worktree, copy, or clone, got ${String(mode)}`);
  }
  const suppliedPath = raw.path === undefined ? null : String(raw.path);
  const defaultPath = requireRunTarget(runTarget, `workspace "${raw.key}" run target`);
  if (mode === "direct") {
    if (raw.branch !== undefined) throw new Error("direct workspaces do not accept branch");
    if (raw.repo !== undefined) {
      throw new Error("direct workspaces do not accept repo");
    }
    if (raw.retention !== undefined) {
      throw new Error(
        "direct workspaces do not accept retention because Keel does not own the directory",
      );
    }
    if (raw.ref !== undefined) {
      throw new Error("direct workspaces do not accept ref");
    }
    return {
      key: raw.key,
      mode: "direct",
      path: resolveUsableDirectory(suppliedPath ?? defaultPath),
      suppliedPath,
      ...(raw.setup === undefined ? {} : { setup: raw.setup }),
    };
  }
  if (mode === "clone") {
    if (raw.path !== undefined) throw new Error("clone workspaces do not accept path; use repo");
    if (raw.branch !== undefined) throw new Error("clone workspaces do not accept branch");
    if (typeof raw.repo !== "string" || raw.repo.trim().length === 0) {
      throw new Error("clone workspaces require repo");
    }
    return {
      key: raw.key,
      mode: "clone",
      repo: raw.repo,
      ref: typeof raw.ref === "string" && raw.ref.length > 0 ? raw.ref : null,
      retention:
        raw.retention === undefined ? "remove" : validateWorkspaceRetentionForCtx(raw.retention),
      ...(raw.setup === undefined ? {} : { setup: raw.setup }),
    };
  }
  if (mode === "copy") {
    if (raw.repo !== undefined) throw new Error("copy workspaces do not accept repo");
    if (raw.ref !== undefined) throw new Error("copy workspaces do not accept ref");
    if (raw.branch !== undefined) throw new Error("copy workspaces do not accept branch");
    return {
      key: raw.key,
      mode: "copy",
      path: suppliedPath ?? defaultPath,
      suppliedPath,
      retention:
        raw.retention === undefined ? "remove" : validateWorkspaceRetentionForCtx(raw.retention),
      ...(raw.setup === undefined ? {} : { setup: raw.setup }),
    };
  }
  if (raw.repo !== undefined) throw new Error("worktree workspaces do not accept repo");
  if (raw.branch !== undefined && typeof raw.branch !== "boolean") {
    throw new Error("worktree branch must be boolean; object branch policies are not supported");
  }
  return {
    key: raw.key,
    mode: "worktree",
    path: suppliedPath ?? defaultPath,
    suppliedPath,
    ref: typeof raw.ref === "string" && raw.ref.length > 0 ? raw.ref : "HEAD",
    retention:
      raw.retention === undefined ? "remove" : validateWorkspaceRetentionForCtx(raw.retention),
    ...(raw.branch === undefined ? {} : { branch: raw.branch }),
    ...(raw.setup === undefined ? {} : { setup: raw.setup }),
  };
}

function validateWorkspaceRetentionForCtx(value: unknown): WorkspaceRetention {
  if (value === "remove" || value === "retain-on-failure" || value === "retain") return value;
  throw new Error("workspace retention must be one of remove, retain-on-failure, retain");
}

function rejectRemovedWorkspaceFields(spec: unknown, context: string): void {
  if (!spec || typeof spec !== "object") return;
  const record = spec as Record<string, unknown>;
  for (const field of ["workspaceIsolation", "workspaceRetention", "target"]) {
    if (record[field] !== undefined) {
      throw new Error(
        `${context} no longer accepts ${field}; use ctx.workspace or ctx.withWorkspace`,
      );
    }
  }
}
