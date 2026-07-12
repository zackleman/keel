// Realm worker entry (DESIGN.md §6) — runs in a Bun Worker thread.
//
// Before importing any workflow code it installs throwing shims for the ambient
// globals (Date.now, argless new Date(), Math.random, crypto.randomUUID,
// fetch, eval/Function, process, performance.now, Bun.*) so that workflow code physically cannot read
// non-determinism — the only time/entropy is ctx.now()/ctx.random(). Module
// imports of fs/child_process/http are rejected by the static lint (Phase 5);
// this layer seals the globals (§6 layer 2).
//
// The bridge `ctx` is sealed: only whitelisted methods exist, each journaled by
// the host. Step results are tagged (worker-side WeakMap) so that when one
// flows into a later step's inputs, the dependency edge is detected and sent to
// the host — the "tagged envelope" of §5.4, proven across the JSON boundary.

/// <reference lib="webworker" />

import { AsyncLocalStorage } from "node:async_hooks";
import {
  type ToolPolicy,
  resolveToolPolicy,
  validateProviderToolPolicy,
} from "../../agents/capabilities.ts";
import { DEFAULT_AGENT_PROVIDER } from "../../agents/defaults.ts";
import {
  type AgentEnvironmentSpec,
  assertEnvironmentSecretsGranted,
  normalizeAgentEnvironment,
} from "../../agents/environment.ts";
import { type AgentProfiles, resolveProfile } from "../../agents/profiles.ts";
import { resolveSelectedProviderConfig } from "../../agents/provider-config.ts";
import type { ProviderConfigMap } from "../../agents/types.ts";
import { type Json, hashJson } from "../../hash.ts";
import type { WorkspaceRetention } from "../../journal/types.ts";
import type { WorkflowVisibleSettings } from "../../settings/catalog.ts";
import { requireRunTarget } from "../../target.ts";
import { DEFAULT_WORKSPACE_ID } from "../../workspace/identity.ts";
import { checkpointVersionIdentity, normalizeCheckpoint } from "../checkpoint.ts";
import { CommandFailure, type CommandResult, normalizeWorkflowCommandSpec } from "../command.ts";
import {
  type CompletionCheckResult,
  normalizeCompletionCheckEffectSpec,
} from "../completion-check.ts";
import { drainSignalsVersionIdentity, normalizeDrainSignals } from "../drain-signals.ts";
import type { Schema } from "../schema.ts";
import {
  type StateNamespace,
  type StateSchemas,
  normalizeStateNamespace,
  normalizeStateWrite,
  stateVersionIdentity,
} from "../state.ts";
import { closureOfHelpers, computeVersion } from "../version.ts";
import {
  CONTROL_WORDS,
  type CommandReply,
  type CompletionCheckReply,
  type HostReply,
  type StepBeginReply,
  VALUE_OFFSET,
  type WorkerRequest,
} from "./protocol.ts";

// ---- determinism shims (install first) ------------------------------------

function realmError(what: string, instead: string): Error {
  return new Error(
    `${what} is not allowed in workflow code: it is non-deterministic and would ` +
      `break resume. Use ${instead}.`,
  );
}

function installBunShims(bunValue: unknown): void {
  if (!bunValue || (typeof bunValue !== "object" && typeof bunValue !== "function")) return;

  const bun = bunValue as Record<PropertyKey, unknown>;
  const throwBun = (what: string): never => {
    throw realmError(`Bun.${what}`, "ctx.* or a host-mediated capability");
  };
  const deniedFunction = (what: string) => () => throwBun(what);
  const deniedObject = (what: string) =>
    new Proxy(Object.create(null), {
      get() {
        return throwBun(what);
      },
      set() {
        return throwBun(what);
      },
      has() {
        return throwBun(what);
      },
      ownKeys() {
        return throwBun(what);
      },
      getOwnPropertyDescriptor() {
        return throwBun(what);
      },
    });

  const replaceProperty = (target: Record<PropertyKey, unknown>, prop: string, value: unknown) => {
    try {
      Object.defineProperty(target, prop, {
        value,
        writable: true,
        enumerable: true,
        configurable: false,
      });
    } catch {
      try {
        target[prop] = value;
      } catch {
        // Some Bun globals are non-writable and non-configurable; static lint is
        // the primary guard for those. Patch what the runtime permits.
      }
    }
  };

  const hardenObjectProperty = (prop: string) => {
    const value = bun[prop];
    if (!value || (typeof value !== "object" && typeof value !== "function")) {
      replaceProperty(bun, prop, deniedObject(prop));
      return;
    }

    const object = value as Record<PropertyKey, unknown>;
    for (const key of Object.keys(object)) {
      try {
        Object.defineProperty(object, key, {
          get() {
            throwBun(prop);
          },
          set() {
            throwBun(prop);
          },
          enumerable: true,
          configurable: true,
        });
      } catch {
        try {
          object[key] = deniedFunction(prop);
        } catch {
          // Leave non-patchable properties to the static lint layer.
        }
      }
    }
    try {
      Object.setPrototypeOf(
        object,
        new Proxy(Object.getPrototypeOf(object) ?? Object.prototype, {
          get() {
            return throwBun(prop);
          },
          set() {
            return throwBun(prop);
          },
          has() {
            return throwBun(prop);
          },
          ownKeys() {
            return throwBun(prop);
          },
          getOwnPropertyDescriptor() {
            return throwBun(prop);
          },
        }),
      );
    } catch {
      // Best effort only; own environment properties above cover known keys.
    }
  };

  for (const prop of [
    "$",
    "build",
    "connect",
    "file",
    "listen",
    "openInEditor",
    "plugin",
    "serve",
    "spawn",
    "spawnSync",
    "sql",
    "write",
  ]) {
    replaceProperty(bun, prop, deniedFunction(prop));
  }

  for (const prop of ["dns", "env", "postgres", "redis", "s3", "secrets", "unsafe"]) {
    hardenObjectProperty(prop);
  }
}

function installShims(): void {
  const RealDate = Date;
  // A Proxy over Date traps construction and `.now` while passing everything else
  // through (parse/UTC, instanceof). new Date() with no args throws guidance;
  // new Date(ms) is deterministic and allowed.
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args) {
      if (args.length === 0) {
        throw realmError("new Date()", "ctx.now()");
      }
      return Reflect.construct(target, args);
    },
    get(target, prop, receiver) {
      if (prop === "now") {
        return () => {
          throw realmError("Date.now()", "ctx.now()");
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  Math.random = () => {
    throw realmError("Math.random()", "ctx.random()");
  };

  globalThis.fetch = (() => {
    throw realmError("fetch()", "ctx.agent() or pass data in as a journaled step input");
  }) as unknown as typeof fetch;
  globalThis.eval = (() => {
    throw realmError("eval()", "static workflow code");
  }) as unknown as typeof eval;
  globalThis.Function = (() => {
    throw realmError("Function()", "static workflow code");
  }) as unknown as FunctionConstructor;

  const g = globalThis as unknown as {
    Bun?: unknown;
    crypto?: { randomUUID?: unknown; getRandomValues?: unknown };
    performance?: { now?: unknown };
    __KEEL_WORKFLOW_REALM__?: true;
    process?: unknown;
    module?: unknown;
    require?: unknown;
  };
  g.__KEEL_WORKFLOW_REALM__ = true;
  const deniedHostGlobal = (name: string) =>
    new Proxy(Object.create(null), {
      get() {
        throw realmError(name, "ctx.* or explicit workflow inputs");
      },
      set() {
        throw realmError(name, "ctx.* or explicit workflow inputs");
      },
      has() {
        throw realmError(name, "ctx.* or explicit workflow inputs");
      },
      ownKeys() {
        throw realmError(name, "ctx.* or explicit workflow inputs");
      },
    });
  for (const name of ["process", "module", "require"] as const) {
    try {
      Object.defineProperty(globalThis, name, {
        value: deniedHostGlobal(name),
        writable: false,
        enumerable: false,
        configurable: false,
      });
    } catch {
      try {
        g[name] = deniedHostGlobal(name);
      } catch {
        // Static lint remains the fail-closed guard for non-patchable globals.
      }
    }
  }
  if (g.Bun) {
    installBunShims(g.Bun);
  }
  if (g.crypto) {
    g.crypto.randomUUID = () => {
      throw realmError("crypto.randomUUID()", "ctx.random() or a content-derived key");
    };
    g.crypto.getRandomValues = () => {
      throw realmError("crypto.getRandomValues()", "ctx.random()");
    };
  }
  if (g.performance) {
    g.performance.now = () => {
      throw realmError("performance.now()", "ctx.now()");
    };
  }
}

installShims();

// ---- bridge plumbing ------------------------------------------------------

declare const self: {
  onmessage: ((e: { data: HostReply }) => void) | null;
  postMessage: (msg: WorkerRequest) => void;
};

let control: Int32Array;
let value: Float64Array;
let moduleHelpers: Record<string, string> = {};
let agentProfiles: AgentProfiles = {};
let workflowSettings: WorkflowVisibleSettings | null = null;
let runId: string | null = null;
let runTarget: string | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

function post(msg: WorkerRequest): void {
  self.postMessage(msg);
}

function rpc<T>(msg: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    post({ ...msg, id } as unknown as WorkerRequest);
  });
}

function ambient(kind: "now" | "random"): number {
  Atomics.store(control, 0, 0);
  post({ type: "ambient", kind });
  Atomics.wait(control, 0, 0);
  return value[0] as number;
}

/** A durable wait that should suspend the run (not an error). Tagged so start()
 * distinguishes it from a real failure. */
class KeelPark extends Error {
  constructor(
    readonly parkKind: "timer" | "signal" | "human",
    readonly key: string,
    readonly until: number | null,
  ) {
    super(`park:${parkKind}`);
    this.name = "KeelPark";
  }
}

/** Terminal continuation: end this run and chain a fresh one (§19). */
class ContinueAsNew extends Error {
  constructor(readonly input: unknown) {
    super("continueAsNew");
    this.name = "ContinueAsNew";
  }
}

// Per-name occurrence counter for ctx.signal stable keys (recomputed
// deterministically each execution, so resume maps to the same wait site).
const signalOccurrences = new Map<string, number>();
const workspaceScope = new AsyncLocalStorage<WorkspaceHandle>();

// ---- tagged-envelope edge detection ---------------------------------------

const provenance = new WeakMap<object, { stepKey: string; contentHash: string }>();
const SESSION_KEY_RE = /^[A-Za-z0-9_-]+$/;
const SESSION_STABLE_KEY_PREFIX = "__session.";

function assertNotReservedAuthorKey(key: string, kind: string): void {
  if (key.startsWith(SESSION_STABLE_KEY_PREFIX)) {
    throw new Error(`${kind} key "${key}" uses reserved prefix ${SESSION_STABLE_KEY_PREFIX}`);
  }
}

function assertSessionKey(key: string, kind: string): void {
  if (!SESSION_KEY_RE.test(key)) {
    throw new Error(`${kind} key "${key}" must match ${SESSION_KEY_RE.source}`);
  }
}

function sessionStableKey(agentKey: string, turnKey: string): string {
  return `${SESSION_STABLE_KEY_PREFIX}${agentKey}.${turnKey}`;
}

function currentRunTarget(context: string): string {
  return requireRunTarget(runTarget, context);
}

function currentWorkflowSettings(): WorkflowVisibleSettings {
  if (!workflowSettings) throw new Error("workflow settings snapshot was not initialized");
  return workflowSettings;
}

interface AgentControls {
  maxRetries: number;
  lenient: boolean;
  onFailure: "throw" | "null";
  timeoutMs: number;
  stallRetries: number;
}

function resolveAgentControls(
  spec: {
    maxRetries?: number;
    lenient?: boolean;
    onFailure?: "throw" | "null";
    timeoutMs?: number;
    stallRetries?: number;
  },
  settings: WorkflowVisibleSettings,
): AgentControls {
  return {
    maxRetries: spec.maxRetries ?? settings.agentDefaultMaxRetries,
    lenient: spec.lenient ?? settings.agentDefaultLenient,
    onFailure: spec.onFailure ?? settings.agentDefaultOnFailure,
    timeoutMs: spec.timeoutMs ?? settings.agentDefaultTimeoutMs,
    stallRetries: spec.stallRetries ?? settings.agentDefaultStallRetries,
  };
}

interface WorkspaceHandle {
  readonly id: string;
  readonly identityHash?: string;
  readonly setupIdentityHash?: string | null;
}

type WorkspaceSpec =
  | { key: string; mode?: "direct"; path?: string; setup?: unknown }
  | {
      key: string;
      mode: "worktree";
      path?: string;
      ref?: string;
      retention?: WorkspaceRetention;
      branch?: boolean;
      setup?: unknown;
    }
  | { key: string; mode: "copy"; path?: string; retention?: WorkspaceRetention; setup?: unknown }
  | {
      key: string;
      mode: "clone";
      repo: string;
      ref?: string;
      retention?: WorkspaceRetention;
      setup?: unknown;
    };

function isWorkspaceHandle(value: WorkspaceSpec | WorkspaceHandle): value is WorkspaceHandle {
  return (
    value !== null &&
    typeof value === "object" &&
    "id" in value &&
    typeof (value as { id?: unknown }).id === "string" &&
    !("key" in value)
  );
}

function resolveWorkspaceId(handle: WorkspaceHandle | undefined): string {
  return (handle ?? workspaceScope.getStore())?.id ?? DEFAULT_WORKSPACE_ID;
}

function resolveWorkspaceIdentityHash(handle: WorkspaceHandle | undefined): string | null {
  return (handle ?? workspaceScope.getStore())?.identityHash ?? null;
}

function resolveWorkspaceSetupIdentityHash(handle: WorkspaceHandle | undefined): string | null {
  return (handle ?? workspaceScope.getStore())?.setupIdentityHash ?? null;
}

async function resolveWorkspace(spec: WorkspaceSpec): Promise<WorkspaceHandle> {
  const reply = await rpc<WorkspaceHandle>({
    type: "workspace",
    spec: {
      key: (spec as { key?: string }).key ?? "",
      mode: (spec as { mode?: string }).mode ?? null,
      path: (spec as { path?: string }).path ?? null,
      repo: (spec as { repo?: string }).repo ?? null,
      ref: (spec as { ref?: string }).ref ?? null,
      retention: (spec as { retention?: WorkspaceRetention }).retention ?? null,
      branch: (spec as { branch?: boolean }).branch ?? null,
      setup: (spec as { setup?: unknown }).setup,
    },
  });
  return Object.freeze(reply);
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

function tag<T>(result: T, stepKey: string, contentHash: string): T {
  if (result !== null && typeof result === "object") {
    provenance.set(result as object, { stepKey, contentHash });
  }
  return result;
}

function collectDeps(inputs: unknown): { stepKey: string; contentHash: string }[] | null {
  const found = new Map<string, { stepKey: string; contentHash: string }>();
  const seen = new Set<object>();
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    const tagged = provenance.get(v);
    if (tagged) found.set(`${tagged.stepKey}\u0000${tagged.contentHash}`, tagged);
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
    } else {
      for (const k of Object.keys(v)) walk((v as Record<string, unknown>)[k]);
    }
  };
  walk(inputs);
  return found.size > 0 ? [...found.values()] : null;
}

// ---- the sealed ctx -------------------------------------------------------

interface Schemaish<T> {
  parse(value: unknown): T;
}

const stateValues = new Map<string, Map<string, Json>>();

const ctx = Object.freeze({
  get run(): { readonly id: string; readonly target: string } {
    return Object.freeze({
      id: requireRunTarget(runId, "ctx.run.id"),
      target: currentRunTarget("ctx.run.target"),
    });
  },
  async workspace(spec: WorkspaceSpec): Promise<WorkspaceHandle> {
    return await resolveWorkspace(spec);
  },
  async withWorkspace<T>(
    specOrHandle: WorkspaceSpec | WorkspaceHandle,
    fn: () => Promise<T>,
  ): Promise<T> {
    const handle = isWorkspaceHandle(specOrHandle)
      ? specOrHandle
      : await resolveWorkspace(specOrHandle);
    return await workspaceScope.run(handle, fn);
  },
  async step<T>(
    key: string,
    schema: Schemaish<T>,
    inputs: unknown,
    fn: (inputs: unknown) => T | Promise<T>,
    opts?: { version?: string; bump?: string | number; deps?: string[] },
  ): Promise<T> {
    assertNotReservedAuthorKey(key, "ctx.step");
    const version =
      opts?.version ??
      computeVersion({
        fn: fn as (...a: never[]) => unknown,
        schema: schema as Schema<unknown>,
        // fold in the transitive closure of module helpers this fn references so
        // an edit to a helper re-runs the step (§5.2).
        helpers: closureOfHelpers(fn.toString(), moduleHelpers),
        ...(opts?.bump !== undefined ? { bump: opts.bump } : {}),
      });
    // Auto-detected edges (tagged envelopes) plus any author-declared deps (§5.4
    // escape hatch). Declared deps are advisory graph edges; correctness comes
    // from value hashing.
    const auto = collectDeps(inputs) ?? [];
    const declared = (opts?.deps ?? []).map((stepKey) => ({ stepKey, contentHash: "declared" }));
    const merged = [...auto, ...declared];
    const deps = merged.length > 0 ? merged : null;
    const begun = await rpc<StepBeginReply>({
      type: "step-begin",
      key,
      inputs,
      version,
      deps,
    });
    if (begun.action === "replay") {
      return tag(begun.value as T, key, begun.contentHash);
    }
    try {
      const raw = await fn(inputs);
      const result = schema.parse(raw);
      const reply = await rpc<{ contentHash: string }>({
        type: "step-commit",
        key,
        attempt: begun.attempt,
        version,
        inputHash: begun.inputHash,
        startedAtMs: begun.startedAtMs,
        value: result,
        deps,
      });
      return tag(result, key, reply.contentHash);
    } catch (err) {
      await rpc({
        type: "step-fail",
        key,
        attempt: begun.attempt,
        version,
        inputHash: begun.inputHash,
        startedAtMs: begun.startedAtMs,
        error: serializeError(err),
      });
      throw err;
    }
  },
  async agent<T>(rawSpec: {
    key: string;
    prompt: string;
    profile?: string;
    provider?: string;
    providerConfig?: ProviderConfigMap;
    schema?: Schemaish<T>;
    model?: string;
    reasoning?: string;
    toolPolicy?: ToolPolicy;
    allowTools?: string[];
    denyTools?: string[];
    workspace?: WorkspaceHandle;
    capabilities?: Record<string, unknown>;
    environment?: AgentEnvironmentSpec;
    onFailure?: "throw" | "null";
    maxRetries?: number;
    lenient?: boolean;
    timeoutMs?: number;
    stallRetries?: number;
    bump?: string | number;
    version?: string;
  }): Promise<T> {
    // Resolve a named profile into concrete fields BEFORE versioning, so the
    // RESOLVED settings (not the profile name) enter the version/input hash.
    const spec = resolveProfile(rawSpec, agentProfiles) as Omit<typeof rawSpec, "profile">;
    const settings = currentWorkflowSettings();
    assertNotReservedAuthorKey(spec.key, "ctx.agent");
    const provider = spec.provider ?? DEFAULT_AGENT_PROVIDER;
    const profileProviderConfig = rawSpec.profile
      ? agentProfiles[rawSpec.profile]?.providerConfig
      : undefined;
    const selectedProviderConfig = resolveSelectedProviderConfig({
      context: `ctx.agent("${spec.key}")`,
      selectedProvider: provider,
      explicitProviderConfig: spec.providerConfig,
      profileName: rawSpec.profile,
      profileProviderConfig,
    });
    const schema = spec.schema as Schema<unknown> | undefined;
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
    rejectRemovedWorkspaceFields(rawSpec, `ctx.agent("${spec.key}")`);
    const workspaceId = resolveWorkspaceId(spec.workspace);
    const workspaceIdentityHash = resolveWorkspaceIdentityHash(spec.workspace);
    const setupIdentityHash = resolveWorkspaceSetupIdentityHash(spec.workspace);
    const controls = resolveAgentControls(spec, settings);
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
      ...(setupIdentityHash !== null ? { setupIdentityHash } : {}),
      capabilities: caps,
      environment,
      controls,
    };
    const version =
      spec.version ??
      computeVersion({
        spec: identityFields,
        schema,
        ...(spec.bump !== undefined ? { bump: spec.bump } : {}),
      });
    // Inputs are the COMPLETE identity: every field that participates in the
    // version must also appear here (caps/secrets included — §11).
    const inputs = identityFields;
    const reply = await rpc<{
      ok: boolean;
      output?: unknown;
      contentHash?: string;
      error?: { name: string; message: string };
      failure?: boolean;
    }>({
      type: "agent",
      key: spec.key,
      prompt: spec.prompt,
      provider,
      providerConfig: selectedProviderConfig ?? null,
      model: spec.model ?? null,
      reasoning: spec.reasoning ?? null,
      toolPolicy: tools.toolPolicy,
      allowTools: tools.allowTools,
      denyTools: tools.denyTools,
      workspaceId,
      setupIdentityHash,
      capabilities: caps,
      environment,
      version,
      inputs,
      jsonSchema: schema?.structural?.() ?? null,
      maxRetries: controls.maxRetries,
      lenient: controls.lenient,
      onFailure: controls.onFailure,
      timeoutMs: controls.timeoutMs,
      stallRetries: controls.stallRetries,
      deps: null,
    });
    // The host applies onFailure: an accepted failure is journaled as a
    // completed null and replayed as null on resume (no re-call). The worker
    // just returns the host's result or throws on a non-tolerated failure.
    if (reply.ok) {
      return tag(reply.output as T, spec.key, reply.contentHash ?? "");
    }
    const err = new Error(reply.error?.message ?? "agent failed");
    err.name = reply.error?.name ?? "AgentFailure";
    throw err;
  },
  async command(rawSpec: unknown): Promise<CommandResult> {
    const command = normalizeWorkflowCommandSpec(rawSpec, { path: "ctx.command" });
    const version = computeVersion({ spec: command.identity });
    const reply = await rpc<CommandReply>({
      type: "command",
      command,
      version,
      inputs: command.identity,
      deps: null,
    });
    if (reply.ok && reply.result) {
      return tag(reply.result, command.stableKey, reply.contentHash ?? "");
    }
    if (reply.result) throw new CommandFailure(reply.result);
    const err = new Error(reply.error?.message ?? "command failed");
    err.name = reply.error?.name ?? "CommandFailure";
    throw err;
  },
  async completionCheck(rawSpec: unknown): Promise<CompletionCheckResult> {
    const completionCheck = normalizeCompletionCheckEffectSpec(rawSpec, {
      path: "ctx.completionCheck",
    });
    const version = computeVersion({ spec: completionCheck.identity });
    const reply = await rpc<CompletionCheckReply>({
      type: "completion-check",
      completionCheck,
      version,
      inputs: completionCheck.identity,
      deps: null,
    });
    if (reply.ok && reply.result) {
      return tag(reply.result, completionCheck.stableKey, reply.contentHash ?? "");
    }
    const err = new Error(reply.error?.message ?? "completion check failed");
    err.name = reply.error?.name ?? "CompletionCheckFailure";
    throw err;
  },
  async checkpoint(rawSpec: unknown): Promise<void> {
    const checkpoint = normalizeCheckpoint(rawSpec);
    assertNotReservedAuthorKey(checkpoint.stableKey, "ctx.checkpoint");
    const version = computeVersion({ spec: checkpointVersionIdentity() });
    await rpc({
      type: "checkpoint",
      checkpoint,
      version,
    });
  },
  state<S extends Record<string, Json>>(
    rawNamespace: string,
    schemas?: StateSchemas<S>,
  ): StateNamespace<S> {
    const namespace = normalizeStateNamespace(rawNamespace);
    let values = stateValues.get(namespace);
    if (!values) {
      values = new Map<string, Json>();
      stateValues.set(namespace, values);
    }
    const fold = values;
    return Object.freeze({
      set: async <K extends keyof S & string>(rawSpec: {
        key: string;
        name: K;
        value: S[K];
      }): Promise<void> => {
        const state = normalizeStateWrite(namespace, schemas, rawSpec);
        assertNotReservedAuthorKey(state.stableKey, "ctx.state.set");
        const version = computeVersion({ spec: stateVersionIdentity(state.schemaHash) });
        const reply = await rpc<{ value: Json }>({
          type: "state-write",
          state,
          version,
        });
        fold.set(state.name, reply.value);
      },
      get: <K extends keyof S & string>(name: K): S[K] | undefined =>
        fold.get(name) as S[K] | undefined,
      snapshot: (): Readonly<Partial<S>> => Object.freeze(Object.fromEntries(fold) as Partial<S>),
    });
  },
  async drainSignals<T>(key: unknown, name: unknown): Promise<T[]> {
    const spec = normalizeDrainSignals(key, name);
    assertNotReservedAuthorKey(spec.stableKey, "ctx.drainSignals");
    const version = computeVersion({ spec: drainSignalsVersionIdentity() });
    const reply = await rpc<{ batch: unknown[] }>({
      type: "drain-signals",
      key: spec.stableKey,
      name: spec.name,
      inputs: spec.identity,
      version,
    });
    return reply.batch as T[];
  },
  agentSession(rawSessionSpec: {
    key: string;
    profile?: string;
    provider?: string;
    providerConfig?: ProviderConfigMap;
    model?: string;
    reasoning?: string;
    toolPolicy?: ToolPolicy;
    allowTools?: string[];
    denyTools?: string[];
    workspace?: WorkspaceHandle;
    capabilities?: Record<string, unknown>;
    environment?: AgentEnvironmentSpec;
  }): {
    turn<T>(spec: {
      key: string;
      prompt: string;
      schema?: Schemaish<T>;
      onFailure?: "throw" | "null";
      maxRetries?: number;
      lenient?: boolean;
      timeoutMs?: number;
      stallRetries?: number;
      bump?: string | number;
      version?: string;
    }): Promise<T>;
  } {
    const sessionSpec = resolveProfile(rawSessionSpec, agentProfiles) as Omit<
      typeof rawSessionSpec,
      "profile"
    >;
    const settings = currentWorkflowSettings();
    assertSessionKey(sessionSpec.key, "agentSession");
    const provider = sessionSpec.provider ?? DEFAULT_AGENT_PROVIDER;
    const profileProviderConfig = rawSessionSpec.profile
      ? agentProfiles[rawSessionSpec.profile]?.providerConfig
      : undefined;
    const selectedProviderConfig = resolveSelectedProviderConfig({
      context: `ctx.agentSession("${sessionSpec.key}")`,
      selectedProvider: provider,
      explicitProviderConfig: sessionSpec.providerConfig,
      profileName: rawSessionSpec.profile,
      profileProviderConfig,
    });
    const tools = resolveToolPolicy(
      {
        ...(sessionSpec.capabilities ? { capabilities: sessionSpec.capabilities } : {}),
        ...(sessionSpec.toolPolicy ? { toolPolicy: sessionSpec.toolPolicy } : {}),
        ...(sessionSpec.allowTools ? { allowTools: sessionSpec.allowTools } : {}),
        ...(sessionSpec.denyTools ? { denyTools: sessionSpec.denyTools } : {}),
      },
      { path: `ctx.agentSession("${sessionSpec.key}")` },
    );
    validateProviderToolPolicy(provider, tools, `ctx.agentSession("${sessionSpec.key}")`);
    const caps = tools.capabilities;
    const environment = normalizeAgentEnvironment(sessionSpec.environment, {
      path: `ctx.agentSession("${sessionSpec.key}").environment`,
    });
    assertEnvironmentSecretsGranted(environment, caps, `ctx.agentSession("${sessionSpec.key}")`);
    rejectRemovedWorkspaceFields(rawSessionSpec, `ctx.agentSession("${sessionSpec.key}")`);
    const workspaceId = resolveWorkspaceId(sessionSpec.workspace);
    const workspaceIdentityHash = resolveWorkspaceIdentityHash(sessionSpec.workspace);
    const setupIdentityHash = resolveWorkspaceSetupIdentityHash(sessionSpec.workspace);
    const identity = {
      agentKey: sessionSpec.key,
      provider,
      ...(selectedProviderConfig !== undefined ? { providerConfig: selectedProviderConfig } : {}),
      model: sessionSpec.model ?? null,
      reasoning: sessionSpec.reasoning ?? null,
      toolPolicy: tools.toolPolicy,
      allowTools: tools.allowTools,
      denyTools: tools.denyTools,
      workspaceId,
      ...(workspaceIdentityHash !== null ? { workspaceIdentityHash } : {}),
      ...(setupIdentityHash !== null ? { setupIdentityHash } : {}),
      capabilities: caps,
      environment,
    };
    const identityHash = hashJson(identity as unknown as Json);
    const identityJson = JSON.stringify(identity);
    return Object.freeze({
      async turn<T>(rawTurnSpec: {
        key: string;
        prompt: string;
        schema?: Schemaish<T>;
        onFailure?: "throw" | "null";
        maxRetries?: number;
        lenient?: boolean;
        timeoutMs?: number;
        stallRetries?: number;
        bump?: string | number;
        version?: string;
      }): Promise<T> {
        assertSessionKey(rawTurnSpec.key, "agentSession.turn");
        const schema = rawTurnSpec.schema as Schema<unknown> | undefined;
        const stableKey = sessionStableKey(sessionSpec.key, rawTurnSpec.key);
        const controls = resolveAgentControls(rawTurnSpec, settings);
        const version =
          rawTurnSpec.version ??
          computeVersion({
            spec: {
              prompt: rawTurnSpec.prompt,
              provider,
              ...(selectedProviderConfig !== undefined
                ? { providerConfig: selectedProviderConfig }
                : {}),
              model: sessionSpec.model ?? null,
              reasoning: sessionSpec.reasoning ?? null,
              toolPolicy: tools.toolPolicy,
              allowTools: tools.allowTools,
              denyTools: tools.denyTools,
              workspaceId,
              ...(workspaceIdentityHash !== null ? { workspaceIdentityHash } : {}),
              capabilities: caps,
              environment,
              participantIdentityHash: identityHash,
              controls,
            },
            schema,
            ...(rawTurnSpec.bump !== undefined ? { bump: rawTurnSpec.bump } : {}),
          });
        const inputs = {
          prompt: rawTurnSpec.prompt,
          provider,
          ...(selectedProviderConfig !== undefined
            ? { providerConfig: selectedProviderConfig }
            : {}),
          model: sessionSpec.model ?? null,
          reasoning: sessionSpec.reasoning ?? null,
          toolPolicy: tools.toolPolicy,
          allowTools: tools.allowTools,
          denyTools: tools.denyTools,
          workspaceId,
          ...(workspaceIdentityHash !== null ? { workspaceIdentityHash } : {}),
          capabilities: caps,
          environment,
          participantIdentityHash: identityHash,
          controls,
        };
        const reply = await rpc<{
          ok: boolean;
          output?: unknown;
          contentHash?: string;
          error?: { name: string; message: string };
          failure?: boolean;
        }>({
          type: "agent-turn",
          agentKey: sessionSpec.key,
          turnKey: rawTurnSpec.key,
          stableKey,
          identityHash,
          identityJson,
          prompt: rawTurnSpec.prompt,
          provider,
          providerConfig: selectedProviderConfig ?? null,
          model: sessionSpec.model ?? null,
          reasoning: sessionSpec.reasoning ?? null,
          toolPolicy: tools.toolPolicy,
          allowTools: tools.allowTools,
          denyTools: tools.denyTools,
          workspaceId,
          setupIdentityHash,
          capabilities: caps,
          environment,
          version,
          inputs,
          jsonSchema: schema?.structural?.() ?? null,
          maxRetries: controls.maxRetries,
          lenient: controls.lenient,
          onFailure: controls.onFailure,
          timeoutMs: controls.timeoutMs,
          stallRetries: controls.stallRetries,
          deps: null,
        });
        if (reply.ok) {
          return tag(reply.output as T, stableKey, reply.contentHash ?? "");
        }
        const err = new Error(reply.error?.message ?? "agent session turn failed");
        err.name = reply.error?.name ?? "AgentFailure";
        throw err;
      },
    });
  },
  now(): number {
    return ambient("now");
  },
  random(): number {
    return ambient("random");
  },
  async sleep(key: string, ms: number): Promise<void> {
    // Author key + duration form the identity (like ctx.step's versioning): a
    // changed duration is a new timer, and unrelated reorders don't shift keys.
    const timerKey = `${key}#${ms}`;
    const reply = await rpc<{ ready: boolean; until?: number | null }>({
      type: "park-check",
      kind: "timer",
      key: timerKey,
      durationMs: ms,
      payload: null,
    });
    if (reply.ready) return;
    throw new KeelPark("timer", timerKey, reply.until ?? null);
  },
  async human(spec: { key: string; prompt: string; requestedCaps?: unknown }): Promise<unknown> {
    const reply = await rpc<{ ready: boolean; value?: unknown }>({
      type: "park-check",
      kind: "human",
      key: spec.key,
      durationMs: null,
      payload: { prompt: spec.prompt, requestedCaps: spec.requestedCaps ?? null },
    });
    if (reply.ready) return reply.value;
    throw new KeelPark("human", spec.key, null);
  },
  async signal<T>(name: string): Promise<T> {
    // Key by name + per-name occurrence: the Nth ctx.signal(name) consumes the
    // Nth such signal, and an unrelated wait inserted elsewhere doesn't reshuffle.
    const n = signalOccurrences.get(name) ?? 0;
    signalOccurrences.set(name, n + 1);
    const key = `${name}:${n}`;
    const reply = await rpc<{ ready: boolean; value?: unknown }>({
      type: "park-check",
      kind: "signal",
      key,
      durationMs: null,
      payload: { name },
    });
    if (reply.ready) return reply.value as T;
    throw new KeelPark("signal", key, null);
  },
  async continueAsNew(input: unknown): Promise<never> {
    throw new ContinueAsNew(input);
  },
  stepKey(semanticName: string, stableId: string): string {
    return `${semanticName}:${stableId}`;
  },
  log(message: string, data?: unknown): void {
    post({ type: "log", message, data: data ?? null });
  },
  phase(title: string): void {
    post({ type: "phase", title });
  },
});

function serializeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "Error", message: String(err) };
}

// ---- run loop -------------------------------------------------------------

self.onmessage = (e: { data: HostReply }) => {
  const m = e.data;
  if (m.type === "init") {
    control = new Int32Array(m.sab, 0, CONTROL_WORDS);
    value = new Float64Array(m.sab, VALUE_OFFSET, 1);
    moduleHelpers = m.moduleHelpers;
    agentProfiles = m.agentProfiles as AgentProfiles;
    workflowSettings = m.workflowSettings;
    runId = m.runId;
    runTarget = m.runTarget;
    void start(m.workflowUrl, m.input);
    return;
  }
  if (m.type === "rpc-reply") {
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      p.resolve(m.payload);
    }
    return;
  }
  if (m.type === "rpc-error") {
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      p.reject(Object.assign(new Error(m.error.message), { name: m.error.name }));
    }
  }
};

async function start(workflowUrl: string, input: unknown): Promise<void> {
  try {
    const mod = (await import(workflowUrl)) as {
      default: (c: typeof ctx, i: unknown) => Promise<unknown>;
    };
    const output = await mod.default(ctx, input);
    post({ type: "result", output });
  } catch (err) {
    if (err instanceof ContinueAsNew) {
      post({ type: "continue", input: err.input });
      return;
    }
    if (err instanceof KeelPark) {
      post({ type: "parked", kind: err.parkKind, key: err.key, until: err.until });
      return;
    }
    post({ type: "error", error: serializeError(err) });
  }
}

post({ type: "ready" });
