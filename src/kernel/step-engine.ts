// StepEngine — the host-side journaling state machine (DESIGN.md §5.5–5.6).
//
// One source of truth for memoization, the write-ahead protocol, and ambient
// recording. RealmKernel uses it for Worker-backed workflow execution, and
// host-local WorkflowCtx tests use the same machinery for focused coverage.
// Splitting "begin" from "complete" is what lets the realm run the fn between
// the two commits while the journaling stays here.

import type { TraceEvent } from "../agents/types.ts";
import { type Json, hashJson, sha256Hex } from "../hash.ts";
import type { JournalStore } from "../journal/store.ts";
import type { EffectType, InputDep, JournalRow } from "../journal/types.ts";
import { durableAgentToolEvent } from "./agent-events.ts";
import type { CtxHost } from "./ctx.ts";

/** Results larger than this are stored content-addressed, not inline (§8.2). */
export const INLINE_LIMIT_BYTES = 1024;

export type BeginResult =
  | { kind: "replay"; value: unknown }
  | {
      kind: "execute";
      attempt: number;
      inputHash: string;
      startedAtMs: number;
      /** Session token carried over from a crashed pending attempt (§10.4). */
      resumeToken?: string;
    };

export class StepEngine {
  private readonly ambientCounters = new Map<string, number>();

  constructor(
    private readonly store: JournalStore,
    private readonly runId: string,
    private readonly host: CtxHost,
  ) {}

  /** Look up a step; replay if a matching completed row exists, else write the
   * pending row (write-ahead) and instruct the caller to execute. Effectful steps
   * (agent/human/spawn) use effectType="effectful": a completed one is never
   * re-executed; a pending one re-executes at-least-once (§5.1, §5.5). */
  beginStep(
    key: string,
    inputs: Json,
    version: string,
    deps: InputDep[] | null,
    effectType: EffectType = "pure",
  ): BeginResult {
    const inputHash = hashJson(inputs);
    const existing = this.store.getLatestAttempt(this.runId, key);
    if (
      existing &&
      existing.status === "completed" &&
      existing.inputHash === inputHash &&
      existing.version === version
    ) {
      return { kind: "replay", value: this.readResult(existing) };
    }
    const resuming = existing != null && existing.status === "pending";
    const attempt = resuming
      ? (existing as JournalRow).attempt
      : existing
        ? existing.attempt + 1
        : 1;
    // Carry a crashed pending attempt's session token forward so the re-execution
    // can reconnect to the vendor session instead of starting cold (§10.4).
    const carriedToken = resuming ? ((existing as JournalRow).sessionToken ?? null) : null;
    const startedAtMs = this.host.clock();
    this.store.putJournalRow({
      runId: this.runId,
      stableKey: key,
      attempt,
      effectType,
      status: "pending",
      version,
      inputHash,
      inputDeps: deps,
      sessionToken: carriedToken,
      startedAtMs,
    });
    this.host.fault?.("after-pending", key);
    return {
      kind: "execute",
      attempt,
      inputHash,
      startedAtMs,
      ...(carriedToken ? { resumeToken: carriedToken } : {}),
    };
  }

  /** Command effects have a stricter pending-row identity guard than legacy
   * effectful steps: a resumed pending command may re-execute only when version
   * and input hash still match. */
  beginCommand(key: string, inputs: Json, version: string, deps: InputDep[] | null): BeginResult {
    return this.beginStrictEffect(key, inputs, version, deps, "command");
  }

  beginCompletionCheck(
    key: string,
    inputs: Json,
    version: string,
    deps: InputDep[] | null,
  ): BeginResult {
    return this.beginStrictEffect(key, inputs, version, deps, "completion_check");
  }

  beginCheckpoint(
    key: string,
    inputs: Json,
    version: string,
    deps: InputDep[] | null,
  ): BeginResult {
    return this.beginStrictEffect(key, inputs, version, deps, "checkpoint");
  }

  beginDrainSignals(
    key: string,
    inputs: Json,
    version: string,
    deps: InputDep[] | null,
  ): BeginResult {
    return this.beginStrictEffect(key, inputs, version, deps, "drain_signals");
  }

  private beginStrictEffect(
    key: string,
    inputs: Json,
    version: string,
    deps: InputDep[] | null,
    effectType: "command" | "completion_check" | "checkpoint" | "drain_signals",
  ): BeginResult {
    const inputHash = hashJson(inputs);
    const existing = this.store.getLatestAttempt(this.runId, key);
    if (
      existing &&
      existing.status === "completed" &&
      existing.inputHash === inputHash &&
      existing.version === version
    ) {
      return { kind: "replay", value: this.readResult(existing) };
    }
    if (existing?.status === "pending") {
      if (existing.inputHash !== inputHash || existing.version !== version) {
        throw new Error(
          `pending ${effectType} "${key}" identity changed; use a new key or rewind the run`,
        );
      }
      return {
        kind: "execute",
        attempt: existing.attempt,
        inputHash,
        startedAtMs: existing.startedAtMs ?? this.host.clock(),
      };
    }
    const attempt = existing ? existing.attempt + 1 : 1;
    const startedAtMs = this.host.clock();
    this.store.putJournalRow({
      runId: this.runId,
      stableKey: key,
      attempt,
      effectType,
      status: "pending",
      version,
      inputHash,
      inputDeps: deps,
      startedAtMs,
    });
    this.host.fault?.("after-pending", key);
    return { kind: "execute", attempt, inputHash, startedAtMs };
  }

  /** Write-ahead capture of a vendor session token on the pending row (§10.4). */
  recordSessionToken(key: string, attempt: number, token: string): void {
    const row = this.store.getJournalRow(this.runId, key, attempt);
    if (!row) return;
    this.store.putJournalRow({ ...row, sessionToken: token });
  }

  /** Commit a step's completed result. */
  completeStep(
    key: string,
    attempt: number,
    version: string,
    inputHash: string,
    startedAtMs: number,
    value: unknown,
    deps: InputDep[] | null,
    effectType: EffectType = "pure",
    events: Array<{ type: string; payload: Json }> = [],
  ): void {
    this.commitStep(
      key,
      attempt,
      version,
      inputHash,
      startedAtMs,
      () => value,
      deps,
      effectType,
      events,
    );
  }

  /** Atomically consume the pending signal batch and commit it as this effect's result. */
  completeDrainSignals(
    key: string,
    attempt: number,
    version: string,
    inputHash: string,
    startedAtMs: number,
    name: string,
  ): unknown[] {
    let batch: unknown[] = [];
    this.commitStep(
      key,
      attempt,
      version,
      inputHash,
      startedAtMs,
      () => {
        batch = this.store.drainSignals(this.runId, name, `${key}#${attempt}`);
        return batch;
      },
      null,
      "drain_signals",
    );
    return batch;
  }

  private commitStep(
    key: string,
    attempt: number,
    version: string,
    inputHash: string,
    startedAtMs: number,
    value: () => unknown,
    deps: InputDep[] | null,
    effectType: EffectType,
    events: Array<{ type: string; payload: Json }> = [],
  ): void {
    this.host.fault?.("before-commit", key);
    const existing = this.store.getJournalRow(this.runId, key, attempt);
    // Artifact write + journal commit happen in ONE transaction, so a crash
    // leaves a committed row with its artifact present, or nothing — never a
    // dangling reference (§8.2). Signal drains also consume their queue here.
    this.store.transaction(() => {
      const stored = prepareStepResult(value());
      if (stored.artifact) {
        this.store.putArtifact(stored.artifact.hash, stored.artifact.bytes, this.host.clock());
      }
      for (const event of events) {
        this.store.appendEvent(this.runId, event.type, event.payload, this.host.clock());
      }
      this.store.putJournalRow({
        runId: this.runId,
        stableKey: key,
        attempt,
        effectType,
        status: "completed",
        version,
        inputHash,
        inputDeps: deps,
        resultInline: stored.inline,
        resultArtifact: stored.artifact?.hash ?? null,
        sessionToken: existing?.sessionToken ?? null,
        startedAtMs,
        finishedAtMs: this.host.clock(),
      });
    });
    this.emit("step.completed", { stableKey: key, effectType });
  }

  /** Record a step's terminal failure. */
  failStep(
    key: string,
    attempt: number,
    version: string,
    inputHash: string,
    startedAtMs: number,
    err: unknown,
    effectType: EffectType = "pure",
  ): void {
    this.store.putJournalRow({
      runId: this.runId,
      stableKey: key,
      attempt,
      effectType,
      status: "failed",
      version,
      inputHash,
      errorJson: JSON.stringify(serializeError(err)),
      startedAtMs,
      finishedAtMs: this.host.clock(),
    });
  }

  /** Generate-once / replay an ambient value (now/random). */
  ambient(kind: string, generate: () => number): number {
    const idx = this.ambientCounters.get(kind) ?? 0;
    this.ambientCounters.set(kind, idx + 1);
    const key = `__${kind}#${idx}`;
    const existing = this.store.getLatestAttempt(this.runId, key);
    if (existing && existing.status === "completed") {
      return readJournalResult(this.store, existing) as number;
    }
    const value = generate();
    this.store.putJournalRow({
      runId: this.runId,
      stableKey: key,
      attempt: 1,
      effectType: "ambient",
      status: "completed",
      version: "ambient",
      inputHash: "",
      resultInline: encode(value),
      startedAtMs: this.host.clock(),
      finishedAtMs: this.host.clock(),
    });
    return value;
  }

  emit(type: string, payload: Json): void {
    this.store.appendEvent(this.runId, type, payload, this.host.clock());
  }

  emitLive(type: string, payload: Json): void {
    this.host.liveEvent?.(this.runId, type, payload, this.host.clock());
  }

  emitAgentTrace(key: string, attempt: number, event: TraceEvent): void {
    const durable = durableAgentToolEvent(key, attempt, event);
    if (durable) {
      this.emit(durable.type, durable.payload);
      return;
    }
    if (event.type !== "session") {
      this.emitLive("agent.event", { key, event: event as unknown as Json });
    }
  }

  now(): number {
    return this.ambient("now", this.host.clock);
  }

  random(): number {
    return this.ambient("random", this.host.rng);
  }

  /** Read a completed row's result from whichever tier holds it. */
  private readResult(row: JournalRow): unknown {
    return readJournalResult(this.store, row);
  }
}

/** Split a result into inline (<=1KB) or content-addressed artifact (§8.2). */
export function prepareStepResult(value: unknown): {
  inline: string | null;
  artifact: { hash: string; bytes: Uint8Array } | null;
} {
  const json = encode(value);
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength <= INLINE_LIMIT_BYTES) {
    return { inline: json, artifact: null };
  }
  return { inline: null, artifact: { hash: sha256Hex(json), bytes } };
}

/** Read a completed row's result from whichever tier holds it. */
export function readJournalResult(store: JournalStore, row: JournalRow): unknown {
  if (row.resultArtifact) {
    const data = store.getArtifactData(row.resultArtifact);
    if (!data) {
      throw new Error(`artifact ${row.resultArtifact} missing for step ${row.stableKey}`);
    }
    return JSON.parse(new TextDecoder().decode(data));
  }
  return decode(row.resultInline);
}

export function encode(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function decode(inline: string | null): unknown {
  if (inline === null) {
    throw new Error("journal row marked completed but has no inline result");
  }
  return JSON.parse(inline);
}

export function serializeError(err: unknown): { name: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "Error", message: String(err) };
}
