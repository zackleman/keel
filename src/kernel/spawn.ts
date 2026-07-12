import type { Json } from "../hash.ts";
import type { RunStatus } from "../journal/types.ts";

export type ChildRunCapability =
  | "run:read"
  | "run:source"
  | "run:watch"
  | "run:events"
  | "run:output"
  | "run:resume"
  | "run:interrupt"
  | "run:retry"
  | "run:rewind"
  | "run:fork"
  | "run:signal";

export interface SpawnSpec {
  workflow: string;
  input: Json;
  caps?: ChildRunCapability[];
}

export interface SpawnHandle {
  readonly runId: string;
}

export interface ChildRunOutcome<T = unknown> {
  runId: string;
  status: RunStatus;
  output?: T;
  error?: { name: string; message: string } | null;
}

export interface NormalizedSpawn {
  stableKey: string;
  workflow: { name: string; version?: number };
  input: Json;
  caps: ChildRunCapability[] | null;
  identity: Json;
}

const CHILD_RUN_CAPABILITIES = new Set<ChildRunCapability>([
  "run:read",
  "run:source",
  "run:watch",
  "run:events",
  "run:output",
  "run:resume",
  "run:interrupt",
  "run:retry",
  "run:rewind",
  "run:fork",
  "run:signal",
]);

export function normalizeSpawn(key: unknown, rawSpec: unknown): NormalizedSpawn {
  const stableKey = nonEmptyString(key, "ctx.spawn key");
  if (!rawSpec || typeof rawSpec !== "object" || Array.isArray(rawSpec)) {
    throw new Error("ctx.spawn spec must be an object");
  }
  const spec = rawSpec as Record<string, unknown>;
  const workflow = parseSavedWorkflowRef(spec.workflow);
  if (!("input" in spec)) throw new Error("ctx.spawn spec.input is required");
  const input = spec.input as Json;
  const caps = normalizeCaps(spec.caps);
  return {
    stableKey,
    workflow,
    input,
    caps,
    identity: {
      workflow,
      input,
      caps,
    },
  };
}

export function normalizeWaitRun(
  key: unknown,
  rawHandle: unknown,
): { stableKey: string; handle: SpawnHandle; identity: Json } {
  const stableKey = nonEmptyString(key, "ctx.waitRun key");
  if (!rawHandle || typeof rawHandle !== "object" || Array.isArray(rawHandle)) {
    throw new Error("ctx.waitRun handle must be the value returned by ctx.spawn");
  }
  const runId = nonEmptyString(
    (rawHandle as Record<string, unknown>).runId,
    "ctx.waitRun handle.runId",
  );
  const handle = Object.freeze({ runId });
  return { stableKey, handle, identity: { runId } };
}

export function spawnVersionIdentity(): Json {
  return { kind: "spawn", abi: 1 };
}

export function waitRunVersionIdentity(): Json {
  return { kind: "wait_run", abi: 1 };
}

function parseSavedWorkflowRef(value: unknown): { name: string; version?: number } {
  const ref = nonEmptyString(value, "ctx.spawn spec.workflow");
  const match = /^(.*)@(\d+)$/.exec(ref);
  if (!match) return { name: ref };
  const [, name, versionText] = match;
  if (!name || !versionText) throw new Error(`invalid saved workflow ref ${ref}`);
  const version = Number(versionText);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`invalid saved workflow ref ${ref}`);
  }
  return { name, version };
}

function normalizeCaps(value: unknown): ChildRunCapability[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw new Error("ctx.spawn spec.caps must be an array");
  const caps: ChildRunCapability[] = [];
  for (const cap of value) {
    if (typeof cap !== "string" || !CHILD_RUN_CAPABILITIES.has(cap as ChildRunCapability)) {
      throw new Error(`ctx.spawn spec.caps contains unsupported capability ${String(cap)}`);
    }
    if (!caps.includes(cap as ChildRunCapability)) caps.push(cap as ChildRunCapability);
  }
  return caps;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}
