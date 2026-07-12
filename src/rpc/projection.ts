// The canonical RunProjection (DESIGN.md §12.1).
//
// One read model, derived from the journal + event log. Every surface (CLI, web,
// MCP) consumes THIS — no surface reconstructs run state independently. Building
// it here prevents per-surface drift.

import type { JournalStore } from "../journal/store.ts";
import type { RunRow, ScheduleRow } from "../journal/types.ts";
import { isRunOwnerStale, ownerStaleWindowMs } from "../kernel/liveness.ts";
import { RUN_FINISHED_INLINE_OUTPUT_BYTES } from "../kernel/output.ts";
import { readJournalResult } from "../kernel/step-engine.ts";
import { workflowDefinitionSourceSelection } from "../workflow-definitions/source-view.ts";
import type {
  Blockage,
  InterruptionBlockageDetails,
  NodeView,
  ReportNodeView,
  RunProjection,
  RunReport,
  RunStateSnapshot,
  RunStats,
  RunSummary,
  RunSummaryPage,
  ScheduleErrorProjection,
  ScheduleSummary,
  ScheduleView,
  WorkflowDefinitionSourceView,
} from "./view-contract.ts";

export type {
  Blockage,
  BlockageReason,
  EffectType,
  InterruptionBlockageDetails,
  JournalStatus,
  NodeView,
  ReportNodeView,
  RunProjection,
  RunReport,
  RunStatus,
  RunSummary,
  RunSummaryPage,
  RunStats,
  RunStateSnapshot,
  ScheduleErrorProjection,
  ScheduleSummary,
  ScheduleView,
} from "./view-contract.ts";

export const MAX_RUN_SUMMARY_PAGE_LIMIT = 500;
export const MAX_RUN_STATE_VALUE_BYTES = 64 * 1024;

/** Build the canonical projection for a run from the journal + events. */
export function buildProjection(store: JournalStore, runId: string): RunProjection | null {
  const run = store.getRun(runId);
  if (!run) return null;

  // One node per stableKey, latest attempt, excluding ambient bookkeeping keys.
  const rows = store.listJournalRows(runId);
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (r.stableKey.startsWith("__")) continue; // ambient now/random
    const prev = latest.get(r.stableKey);
    if (!prev || r.attempt > prev.attempt) latest.set(r.stableKey, r);
  }

  const nodes: NodeView[] = [...latest.values()]
    .sort((a, b) => a.stableKey.localeCompare(b.stableKey))
    .map((r) => ({
      stableKey: r.stableKey,
      effectType: r.effectType,
      status: r.status,
      attempt: r.attempt,
      startedAtMs: r.startedAtMs,
      dependsOn: (r.inputDeps ?? []).map((d) => d.stepKey).sort(),
      artifactBacked: r.resultArtifact !== null,
      checkpoint:
        r.effectType === "checkpoint" && r.status === "completed"
          ? (readJournalResult(store, r) as NodeView["checkpoint"])
          : null,
    }));

  let phase: string | null = null;
  for (const ev of store.listEvents(runId)) {
    if (ev.type === "phase") {
      try {
        phase = (JSON.parse(ev.payloadJson) as { title?: string }).title ?? phase;
      } catch {
        // ignore
      }
    }
  }

  const stats: RunStats = {
    steps: nodes.filter((n) => n.effectType === "pure").length,
    agents: nodes.filter((n) => n.effectType === "effectful").length,
    checkpointCount: nodes.filter((n) => n.effectType === "checkpoint").length,
    artifacts: nodes.filter((n) => n.artifactBacked).length,
  };

  return {
    runId: run.runId,
    workflowName: run.workflowName,
    status: run.status,
    definitionVersion: run.definitionVersion,
    runTarget: run.runTarget,
    parentRunId: run.parentRunId,
    createdAtMs: run.createdAtMs,
    finishedAtMs: run.finishedAtMs,
    nodes,
    state: buildRunState(store, runId, undefined, false),
    phase,
    error: run.errorJson ? (JSON.parse(run.errorJson) as { name: string; message: string }) : null,
    stats,
  };
}

export function buildRunState(
  store: JournalStore,
  runId: string,
  namespace?: string,
  resolveArtifacts = true,
): RunStateSnapshot {
  const snapshot: RunStateSnapshot = {};
  for (const row of store.getRunState(runId, namespace)) {
    let values = snapshot[row.namespace];
    if (!values) {
      values = {};
      snapshot[row.namespace] = values;
    }
    if (row.valueArtifact) {
      const artifact = store.getArtifact(row.valueArtifact);
      if (!artifact) {
        throw new Error(
          `artifact ${row.valueArtifact} missing for state ${row.namespace}.${row.name}`,
        );
      }
      if (resolveArtifacts && artifact.byteLen <= MAX_RUN_STATE_VALUE_BYTES) {
        const data = store.getArtifactData(row.valueArtifact);
        if (!data) {
          throw new Error(
            `artifact ${row.valueArtifact} missing for state ${row.namespace}.${row.name}`,
          );
        }
        values[row.name] = JSON.parse(new TextDecoder().decode(data));
      } else {
        values[row.name] = { $artifact: row.valueArtifact, byteLen: artifact.byteLen };
      }
    } else if (row.valueInline !== null) {
      values[row.name] = JSON.parse(row.valueInline);
    }
  }
  return snapshot;
}

export function listScheduleSummaries(
  store: JournalStore,
  opts: { includeDisabled?: boolean } = {},
): ScheduleSummary[] {
  return store.listSchedules(opts).map((row) => buildScheduleSummary(store, row));
}

export function buildScheduleView(
  store: JournalStore,
  name: string,
  opts: { includeSource?: boolean } = {},
): ScheduleView | null {
  const row = store.getSchedule(name);
  if (!row) return null;
  const summary = buildScheduleSummary(store, row);
  const view: ScheduleView = {
    ...summary,
    input: row.inputJson === null ? null : JSON.parse(row.inputJson),
    inputJson: row.inputJson,
  };
  if (opts.includeSource) {
    const definition = store.getWorkflowDefinition(row.workflowRef);
    view.source = definition ? workflowDefinitionSourceView(row.workflowRef, definition) : null;
  }
  return view;
}

function buildScheduleSummary(store: JournalStore, row: ScheduleRow): ScheduleSummary {
  const definition = store.getWorkflowDefinition(row.workflowRef);
  return {
    name: row.name,
    enabled: row.enabled,
    workflowRef: row.workflowRef,
    definitionState: definition ? "available" : "missing",
    workflowName: definition?.name ?? null,
    workflowKind: definition?.kind ?? null,
    target: row.scheduleTarget,
    intervalMs: row.intervalMs,
    nextFireMs: row.nextFireMs,
    lastRunId: row.lastRunId,
    lastRunStatus: row.lastRunId ? (store.getRun(row.lastRunId)?.status ?? null) : null,
    lastFailedAtMs: row.lastFailedAtMs,
    lastError: scheduleErrorProjection(row.lastErrorJson),
  };
}

function workflowDefinitionSourceView(
  definitionHash: string,
  definition: NonNullable<ReturnType<JournalStore["getWorkflowDefinition"]>>,
): WorkflowDefinitionSourceView {
  const { entry, files } = workflowDefinitionSourceSelection(definition, {});
  return {
    kind: "workflow-definition-source",
    lookup: { kind: "definition", definitionHash },
    definitionHash,
    definitionName: definition.name,
    createdAtMs: definition.createdAtMs,
    entry,
    files,
  };
}

function scheduleErrorProjection(errorJson: string | null): ScheduleErrorProjection {
  if (errorJson === null) return { kind: "none" };
  try {
    const parsed = JSON.parse(errorJson) as { name?: unknown; message?: unknown };
    return {
      kind: "error",
      error: {
        ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
        message: typeof parsed.message === "string" ? parsed.message : String(parsed.message),
      },
    };
  } catch (err) {
    return {
      kind: "parse-error",
      raw: errorJson,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Build a post-run digest from journaled node results, not raw event transcripts. */
export function buildRunReport(
  store: JournalStore,
  runId: string,
  opts: { nowMs?: number; ownerStaleWindowMs?: number } = {},
): RunReport | null {
  const run = store.getRun(runId);
  if (!run) return null;

  const rows = store.listJournalRows(runId);
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (r.stableKey.startsWith("__")) continue;
    const prev = latest.get(r.stableKey);
    if (!prev || r.attempt > prev.attempt) latest.set(r.stableKey, r);
  }

  const nodes: ReportNodeView[] = [...latest.values()]
    .sort((a, b) => a.stableKey.localeCompare(b.stableKey))
    .map((r) => {
      const node: ReportNodeView = {
        stableKey: r.stableKey,
        effectType: r.effectType,
        status: r.status,
        attempt: r.attempt,
        startedAtMs: r.startedAtMs,
        dependsOn: (r.inputDeps ?? []).map((d) => d.stepKey).sort(),
        artifactBacked: r.resultArtifact !== null,
        checkpoint:
          r.effectType === "checkpoint" && r.status === "completed"
            ? (readJournalResult(store, r) as ReportNodeView["checkpoint"])
            : null,
      };
      const result = resultJsonForReport(store, r.resultInline, r.resultArtifact);
      if (result.kind === "inline") node.result = JSON.parse(result.json);
      if (result.kind === "omitted") {
        node.resultOmitted = true;
        node.resultByteLength = result.byteLength;
      }
      return node;
    });

  const output = outputJsonForReport(run.outputRef);
  const blockage = getBlockage(
    store,
    runId,
    opts.nowMs ?? Date.now(),
    opts.ownerStaleWindowMs ?? ownerStaleWindowMs(),
  );
  return {
    runId: run.runId,
    workflowName: run.workflowName,
    status: run.status,
    createdAtMs: run.createdAtMs,
    finishedAtMs: run.finishedAtMs,
    ...(output.kind === "inline" ? { output: JSON.parse(output.json) } : {}),
    ...(output.kind === "omitted"
      ? { outputOmitted: true as const, outputByteLength: output.byteLength }
      : {}),
    error: run.errorJson ? (JSON.parse(run.errorJson) as { name: string; message: string }) : null,
    ...(isVisibleBlockage(blockage) ? { blockage } : {}),
    nodes,
    stats: {
      steps: nodes.filter((n) => n.effectType === "pure").length,
      agents: nodes.filter((n) => n.effectType === "effectful").length,
      checkpointCount: nodes.filter((n) => n.effectType === "checkpoint").length,
      artifacts: nodes.filter((n) => n.artifactBacked).length,
    },
  };
}

function outputJsonForReport(
  json: string | null,
): { kind: "none" } | { kind: "inline"; json: string } | { kind: "omitted"; byteLength: number } {
  if (json === null) return { kind: "none" };
  const byteLength = Buffer.byteLength(json, "utf8");
  if (byteLength > RUN_FINISHED_INLINE_OUTPUT_BYTES) {
    return { kind: "omitted", byteLength };
  }
  return { kind: "inline", json };
}

function resultJsonForReport(
  store: JournalStore,
  inline: string | null,
  artifact: string | null,
): { kind: "none" } | { kind: "inline"; json: string } | { kind: "omitted"; byteLength: number } {
  if (inline !== null) return { kind: "inline", json: inline };
  if (artifact === null) return { kind: "none" };
  const row = store.getArtifact(artifact);
  if (!row) throw new Error(`journal result artifact ${artifact} is missing`);
  if (row.byteLen > RUN_FINISHED_INLINE_OUTPUT_BYTES) {
    return { kind: "omitted", byteLength: row.byteLen };
  }
  const data = store.getArtifactData(artifact);
  if (!data) throw new Error(`journal result artifact ${artifact} has no data`);
  return { kind: "inline", json: Buffer.from(data).toString("utf8") };
}

export function isVisibleBlockage(blockage: Blockage | null | undefined): blockage is Blockage {
  return Boolean(blockage && blockage.reason !== "none" && blockage.reason !== "running");
}

function latestInterruptionDetails(
  store: JournalStore,
  runId: string,
): InterruptionBlockageDetails & { interruptedAtMs: number } {
  let reason: string | undefined;
  let previousStatus = "unknown";
  let interruptedAtMs = 0;
  let phase: string | null = null;
  let wait: { kind?: string; key?: string; until?: number } | null = null;
  for (const ev of store.listEvents(runId)) {
    let payload: Record<string, unknown> | null = null;
    try {
      payload = JSON.parse(ev.payloadJson) as Record<string, unknown>;
    } catch {
      payload = null;
    }
    if (ev.type === "phase") {
      phase = typeof payload?.title === "string" ? payload.title : phase;
    } else if (ev.type === "run.parked") {
      const parked: { kind?: string; key?: string; until?: number } = {};
      if (typeof payload?.kind === "string") parked.kind = payload.kind;
      if (typeof payload?.key === "string") parked.key = payload.key;
      if (typeof payload?.until === "number") parked.until = payload.until;
      wait = Object.keys(parked).length > 0 ? parked : wait;
    } else if (ev.type === "run.interrupted") {
      previousStatus =
        typeof payload?.previousStatus === "string" ? payload.previousStatus : previousStatus;
      reason = typeof payload?.reason === "string" ? payload.reason : undefined;
      interruptedAtMs = ev.emittedAtMs;
    }
  }
  return { ...(reason ? { reason } : {}), previousStatus, phase, wait, interruptedAtMs };
}

function interruptedContext(details: InterruptionBlockageDetails): string {
  const parts = [`interrupted from ${details.previousStatus}`];
  if (details.reason) parts.push(`reason: ${details.reason}`);
  if (details.phase) parts.push(`last phase: ${details.phase}`);
  if (details.wait) {
    const wait = [details.wait.kind, details.wait.key].filter(Boolean).join(" ");
    if (wait.length > 0) parts.push(`last wait: ${wait}`);
  }
  return parts.join("; ");
}

/**
 * Agent-facing "why is this run stuck?" (DESIGN.md §12.2) — one call instead of
 * log archaeology. waiting_* map to run status (HITL/timers land in Phases 16/17).
 * stalled_no_heartbeat is reserved for stale daemon-owner heartbeats.
 */
export function getBlockage(
  store: JournalStore,
  runId: string,
  nowMs: number,
  staleWindowMs: number = ownerStaleWindowMs(),
): Blockage {
  const run = store.getRun(runId);
  if (!run) return { reason: "none", blockedOn: null, context: "run not found" };
  switch (run.status) {
    case "interrupted": {
      const details = latestInterruptionDetails(store, runId);
      return {
        reason: "interrupted",
        blockedOn: details.wait?.key
          ? { stableKey: details.wait.key, since: details.interruptedAtMs }
          : null,
        context: interruptedContext(details),
        interrupted: {
          ...(details.reason ? { reason: details.reason } : {}),
          previousStatus: details.previousStatus,
          phase: details.phase,
          wait: details.wait,
        },
      };
    }
    case "waiting-human": {
      // surface WHAT is being asked, from the persisted approval (§17)
      const pending = store.listPendingApprovals(runId)[0];
      return {
        reason: "waiting_human",
        blockedOn: pending ? { stableKey: pending.stableKey, since: pending.requestedAtMs } : null,
        context: pending?.prompt
          ? `awaiting decision: ${pending.prompt}`
          : "awaiting a human decision",
      };
    }
    case "waiting-signal":
      return { reason: "waiting_signal", blockedOn: null, context: "awaiting a named signal" };
    case "waiting-timer":
      return { reason: "waiting_timer", blockedOn: null, context: "awaiting a durable timer" };
    case "finished":
    case "failed":
    case "cancelled":
    case "continued":
      return { reason: "none", blockedOn: null, context: `terminal: ${run.status}` };
    default:
      break;
  }
  if (isRunOwnerStale(run, nowMs, staleWindowMs)) {
    const owner = run.runtimeOwnerId ?? "unknown";
    const context =
      run.heartbeatAtMs === null
        ? `run owner ${owner} has no heartbeat`
        : `run owner ${owner} heartbeat stale by ${nowMs - staleWindowMs - run.heartbeatAtMs}ms`;
    return {
      reason: "stalled_no_heartbeat",
      blockedOn: null,
      context,
    };
  }
  return { reason: "running", blockedOn: null, context: "executing normally" };
}

export function listRunSummaries(store: JournalStore): RunSummary[] {
  return store.listRuns().map(runSummary);
}

export function listRunSummaryPage(store: JournalStore, limit: number): RunSummaryPage {
  const page = store.listRunsPage(limit);
  return { runs: page.runs.map(runSummary), total: page.total };
}

function runSummary(r: RunRow): RunSummary {
  return {
    runId: r.runId,
    workflowName: r.workflowName,
    status: r.status,
    runTarget: r.runTarget,
    createdAtMs: r.createdAtMs,
    finishedAtMs: r.finishedAtMs,
    parentRunId: r.parentRunId,
  };
}
