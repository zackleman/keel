import { describe, expect, test } from "bun:test";
import type { RunProjection, RunSummary } from "../rpc/projection.ts";
import {
  appendWatchLines,
  createTuiState,
  setBrowserRuns,
  setDetailData,
  startWatchState,
} from "./state.ts";
import { renderAnsiFrame, renderTuiLines } from "./views.ts";

const run: RunSummary = {
  runId: "run_1",
  workflowName: null,
  status: "waiting-signal",
  createdAtMs: Date.UTC(2026, 5, 14, 1, 0, 0, 0),
  finishedAtMs: null,
  parentRunId: null,
};

const projection: RunProjection = {
  runId: "run_1",
  workflowName: "wf",
  status: "running",
  definitionVersion: "def_1",
  parentRunId: null,
  createdAtMs: Date.UTC(2026, 5, 14, 1, 0, 0, 0),
  finishedAtMs: null,
  phase: "working",
  error: null,
  stats: { steps: 1, agents: 0, checkpointCount: 0, artifacts: 0 },
  nodes: [
    {
      stableKey: "step.one",
      effectType: "pure",
      status: "completed",
      attempt: 1,
      startedAtMs: 1,
      dependsOn: [],
      artifactBacked: false,
      checkpoint: null,
    },
  ],
};

describe("tui views", () => {
  test("renders browser table with list display semantics", () => {
    const state = setBrowserRuns(createTuiState({ nowMs: Date.UTC(2026, 5, 14, 1, 0, 5, 0) }), [
      run,
    ]);

    expect(renderTuiLines(state, { width: 100, height: 8 })).toEqual([
      "Keel runs 1/1",
      "  RUN ID          STATUS          WORKFLOW                        CREATED                   DURATION",
      "> run_1           waiting-signal  (unnamed)                       2026-06-14T01:00:00.000Z  5s      ",
      "",
      "",
      "",
      "1 run",
      "? help  q quit  r refresh  j/k move  Enter open  w watch  / filter  R resume  t retry  s signal",
    ]);
  });

  test("sanitizes terminal controls in rendered browser rows", () => {
    const state = setBrowserRuns(createTuiState({ nowMs: Date.UTC(2026, 5, 14, 1, 0, 5, 0) }), [
      { ...run, workflowName: "\u001b[31mwf\u001b[0m\nname" },
    ]);

    const text = renderTuiLines(state, { width: 100, height: 5 }).join("\n");

    expect(text).not.toContain("\u001b");
    expect(text).toContain("wf name");
  });

  test("keeps selected browser row visible after scrolling past the first page", () => {
    const runs = Array.from(
      { length: 8 },
      (_, index): RunSummary => ({
        ...run,
        runId: `run_${index}`,
        workflowName: `workflow_${index}`,
        createdAtMs: Date.UTC(2026, 5, 14, 1, index, 0, 0),
      }),
    );
    let state = setBrowserRuns(createTuiState({ nowMs: Date.UTC(2026, 5, 14, 2, 0, 0, 0) }), runs);
    state = {
      ...state,
      browser: {
        ...state.browser,
        selectedIndex: 6,
      },
    };

    const lines = renderTuiLines(state, { width: 100, height: 8 });

    expect(lines.some((line) => line.startsWith("> run_6"))).toBe(true);
    expect(lines.some((line) => line.includes("run_0"))).toBe(false);
  });

  test("ansi frame clears stale rows below a shrunken render", () => {
    const state = setBrowserRuns(createTuiState(), [run]);
    const frame = renderAnsiFrame(state, { width: 80, height: 6 });

    expect(frame.endsWith("\u001b[J")).toBe(true);
    expect(frame).toContain("\u001b[K\r\n");
  });

  test("renders detail header, stats, nodes, and watch status", () => {
    let state = createTuiState({ runId: "run_1", nowMs: Date.UTC(2026, 5, 14, 1, 0, 2, 0) });
    state = setDetailData(state, { projection, report: null, blockage: null });
    state = startWatchState(state, "run_1");

    expect(renderTuiLines(state, { width: 100, height: 10 })).toEqual([
      "Keel run detail",
      "run run_1  running  wf  created 2026-06-14T01:00:00.000Z  duration 2s",
      "phase: working",
      "stats: steps=1 agents=0 artifacts=0",
      "nodes:",
      "  step.one completed pure attempt=1",
      "watch: attached run_1 (backfill)",
      "events: none",
      "watching run_1",
      "q quit  b back  w detach  r refresh  R resume  t retry  e rewind  s signal  o output  approval admi…",
    ]);
  });

  test("does not render diagnostic running as a blockage", () => {
    let state = createTuiState({ runId: "run_1", nowMs: Date.UTC(2026, 5, 14, 1, 0, 2, 0) });
    state = setDetailData(state, {
      projection,
      report: null,
      blockage: { reason: "running", blockedOn: null, context: "executing normally" },
    });

    const lines = renderTuiLines(state, { width: 100, height: 10 });

    expect(lines.some((line) => line.startsWith("blockage:"))).toBe(false);
  });

  test("prefers run detail over an empty detached watch footer in small terminals", () => {
    let state = createTuiState({ runId: "run_1", nowMs: Date.UTC(2026, 5, 14, 1, 0, 2, 0) });
    state = setDetailData(state, { projection, report: null, blockage: null });

    const lines = renderTuiLines(state, { width: 100, height: 7 });

    expect(lines).toContain("nodes:");
    expect(lines).not.toContain("watch: detached");
    expect(lines).not.toContain("events: none");
  });

  test("keeps latest detail watch output visible when detail metadata overflows", () => {
    let state = createTuiState({ runId: "run_1", nowMs: Date.UTC(2026, 5, 14, 1, 0, 2, 0) });
    state = setDetailData(state, {
      projection: {
        ...projection,
        nodes: Array.from({ length: 10 }, (_, index) => ({
          stableKey: `step.${index}`,
          effectType: "effectful",
          status: "pending",
          attempt: index + 1,
          startedAtMs: index + 1,
          dependsOn: [],
          artifactBacked: false,
          checkpoint: null,
        })),
      },
      report: null,
      blockage: {
        reason: "waiting_signal",
        blockedOn: { stableKey: "gate", since: 1 },
        context: "waiting",
      },
    });
    state = startWatchState(state, "run_1");
    for (let seq = 1; seq <= 5; seq += 1) {
      state = appendWatchLines(
        state,
        { kind: "durable", seq, type: "phase", payload: { title: `event ${seq}` }, atMs: seq },
        [`[${seq}] phase: event ${seq}`],
      );
    }

    const lines = renderTuiLines(state, { width: 100, height: 8 });

    expect(lines).toContain("watch: attached run_1 (backfill)");
    expect(lines).toContain("  [5] phase: event 5");
    expect(lines.some((line) => line.includes("step.0"))).toBe(false);
    expect(lines.at(-2)).toBe("watching run_1");
  });
});
