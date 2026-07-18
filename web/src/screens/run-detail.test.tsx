import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { KeelWebClient, WatchRunEventsOptions } from "../api/client";
import type { EventStreamFrame, RunDetailResponse, RunWorkspaceView } from "../api/types";
import type { RawEventFrame } from "../components/transcript";
import { resetWebDebugCacheForTest } from "../lib/debug";
import { RunDetailScreen, mergeEventFrames, mergeRawFrames } from "./run-detail";

describe("RunDetailScreen", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
    window.history.replaceState(null, "", "/");
    resetWebDebugCacheForTest();
  });

  test("deduplicates replayed durable events and keeps durable rows ordered", () => {
    const merged = mergeEventFrames(
      [durable(3, "phase"), durable(5, "agent.message")],
      [durable(1, "run.started"), durable(3, "phase.replayed"), durable(6, "run.finished")],
    );

    expect(
      merged.map((event) => (event.kind === "durable" ? `${event.seq}:${event.type}` : event.type)),
    ).toEqual(["1:run.started", "3:phase.replayed", "5:agent.message", "6:run.finished"]);
  });

  test("keeps live ephemeral chunks in stream position when merging around durables", () => {
    const merged = mergeEventFrames(
      [durable(5, "phase")],
      [ephemeral("agent.event"), durable(6, "agent.message")],
    );

    expect(
      merged.map((event) => (event.kind === "durable" ? `${event.seq}:${event.type}` : event.type)),
    ).toEqual(["5:phase", "agent.event", "6:agent.message"]);
  });

  test("deduplicates replayed raw durable rows and keeps raw rows ordered", () => {
    const merged = mergeRawFrames(
      [raw(durable(3, "phase"), "tail"), raw(durable(5, "agent.message"), "tail")],
      [raw(durable(3, "phase.replayed"), "live"), raw(durable(6, "run.finished"), "live")],
    );

    expect(merged.map(rawSummary)).toEqual([
      "3:phase.replayed:live",
      "5:agent.message:tail",
      "6:run.finished:live",
    ]);
  });

  test("keeps live ephemeral raw rows in stream position when merging around durables", () => {
    const merged = mergeRawFrames(
      [raw(durable(5, "phase"), "tail")],
      [raw(ephemeral("agent.event"), "live"), raw(durable(6, "agent.message"), "live")],
    );

    expect(merged.map(rawSummary)).toEqual([
      "5:phase:tail",
      "agent.event:live",
      "6:agent.message:live",
    ]);
  });

  test("links a child run to its parent", async () => {
    const child = detail();
    if (!child.run) throw new Error("expected run detail fixture");
    child.run.parentRunId = "run_parent";
    const client = {
      getRun: vi.fn(async () => child),
      watchRunEvents: vi.fn(),
    } as unknown as KeelWebClient;

    render(<RunDetailScreen client={client} runId="run_1" refreshKey={0} />);

    const parentLink = await screen.findByRole("link", { name: "run_parent" });
    expect(parentLink).toHaveAttribute("href", "#/runs/run_parent");
  });

  test("starts live watch from the detail cursor and renders coalesced live text", async () => {
    const watched: WatchRunEventsOptions[] = [];
    const client = {
      getRun: async () => detail(),
      watchRunEvents: vi.fn((_runId: string, opts: WatchRunEventsOptions) => {
        watched.push(opts);
        opts.onFrame({
          event: "event",
          data: {
            kind: "ephemeral",
            type: "agent.event",
            payload: { key: "review", event: { type: "text", data: "Hello" } },
            atMs: 10,
          },
          raw: "event: event",
        });
        opts.onFrame({
          event: "event",
          data: {
            kind: "ephemeral",
            type: "agent.event",
            payload: { key: "review", event: { type: "text", data: " live" } },
            atMs: 11,
          },
          raw: "event: event",
        });
        opts.onStatus?.({ state: "caught-up", cursor: { kind: "after-seq", seq: 5 } });
        return vi.fn();
      }),
    } as unknown as KeelWebClient;

    render(<RunDetailScreen client={client} runId="run_1" refreshKey={0} />);

    fireEvent.click(await screen.findByRole("button", { name: "Watch live" }));
    fireEvent.click(screen.getByRole("tab", { name: /activity/i }));

    await waitFor(() => expect(client.watchRunEvents).toHaveBeenCalledTimes(1));
    expect(watched[0]?.cursor).toEqual({ kind: "after-seq", seq: 5 });
    expect((await screen.findAllByText("Hello live")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("caught up").length).toBeGreaterThan(0);
  });

  test("waits for the initial projection before starting a current-cursor watch", async () => {
    let resolveDetail: (value: RunDetailResponse) => void = () => undefined;
    const initialDetail = new Promise<RunDetailResponse>((resolve) => {
      resolveDetail = resolve;
    });
    const watched: WatchRunEventsOptions[] = [];
    const client = {
      getRun: vi.fn(() => initialDetail),
      watchRunEvents: vi.fn((_runId: string, opts: WatchRunEventsOptions) => {
        watched.push(opts);
        return vi.fn();
      }),
    } as unknown as KeelWebClient;

    render(<RunDetailScreen client={client} runId="run_1" refreshKey={0} />);
    fireEvent.click(screen.getByRole("button", { name: "Watch live" }));
    expect(client.watchRunEvents).not.toHaveBeenCalled();

    await act(async () => resolveDetail(detail(7)));

    await waitFor(() => expect(client.watchRunEvents).toHaveBeenCalledTimes(1));
    expect(watched[0]?.cursor).toEqual({ kind: "after-seq", seq: 7 });
  });

  test("uses the latest loaded detail cursor after manual refresh", async () => {
    let seq = 5;
    const watched: WatchRunEventsOptions[] = [];
    const client = {
      getRun: vi.fn(async () => detail(seq)),
      watchRunEvents: vi.fn((_runId: string, opts: WatchRunEventsOptions) => {
        watched.push(opts);
        return vi.fn();
      }),
    } as unknown as KeelWebClient;

    render(<RunDetailScreen client={client} runId="run_1" refreshKey={0} />);

    await screen.findByText("cursor 5");
    seq = 9;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("cursor 9");

    fireEvent.click(screen.getByRole("button", { name: "Watch live" }));

    await waitFor(() => expect(client.watchRunEvents).toHaveBeenCalledTimes(1));
    expect(watched[0]?.cursor).toEqual({ kind: "after-seq", seq: 9 });
  });

  test("keeps the live event subscription open when a projection reloads", async () => {
    const stops: ReturnType<typeof vi.fn>[] = [];
    const watched: WatchRunEventsOptions[] = [];
    const client = {
      getRun: vi.fn(async () => ({ ...detail(), run: { ...detail().run } })),
      watchRunEvents: vi.fn((_runId: string, opts: WatchRunEventsOptions) => {
        watched.push(opts);
        const stop = vi.fn();
        stops.push(stop);
        return stop;
      }),
    } as unknown as KeelWebClient;

    render(<RunDetailScreen client={client} runId="run_1" refreshKey={0} />);
    await screen.findByText("cursor 5");
    fireEvent.click(screen.getByRole("button", { name: "Watch live" }));
    await waitFor(() => expect(client.watchRunEvents).toHaveBeenCalledTimes(1));

    act(() => {
      watched[0]?.onFrame({
        event: "event",
        data: durable(6, "run.finished"),
        raw: "event: event",
      });
    });
    await waitFor(() => expect(client.getRun).toHaveBeenCalledTimes(2));

    expect(client.watchRunEvents).toHaveBeenCalledTimes(1);
    expect(stops[0]).not.toHaveBeenCalled();
  });

  test("projects human approval parks from live events without refetching detail", async () => {
    const watched: WatchRunEventsOptions[] = [];
    const client = {
      getRun: vi.fn(async () => detail()),
      watchRunEvents: vi.fn((_runId: string, opts: WatchRunEventsOptions) => {
        watched.push(opts);
        return vi.fn();
      }),
      decideApproval: vi.fn(),
    } as unknown as KeelWebClient;

    render(<RunDetailScreen client={client} runId="run_1" refreshKey={0} />);

    await screen.findByText("cursor 5");
    fireEvent.click(screen.getByRole("button", { name: "Watch live" }));
    await waitFor(() => expect(client.watchRunEvents).toHaveBeenCalledTimes(1));

    act(() => {
      watched[0]?.onFrame({
        event: "event",
        data: durable(6, "run.parked", { kind: "human", key: "approve-review" }),
        raw: "event: event",
      });
    });

    await waitFor(() => expect(client.getRun).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("tab", { name: /approvals/i }));

    expect((await screen.findAllByText("approve-review")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/keel approve/)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Approval decisions require admin authority and a refreshed run projection.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
  });

  test("projects live phase events without refetching detail", async () => {
    const watched: WatchRunEventsOptions[] = [];
    const client = {
      getRun: vi.fn(async () => detail()),
      watchRunEvents: vi.fn((_runId: string, opts: WatchRunEventsOptions) => {
        watched.push(opts);
        return vi.fn();
      }),
    } as unknown as KeelWebClient;

    render(<RunDetailScreen client={client} runId="run_1" refreshKey={0} />);

    await screen.findByText("cursor 5");
    fireEvent.click(screen.getByRole("button", { name: "Watch live" }));
    await waitFor(() => expect(client.watchRunEvents).toHaveBeenCalledTimes(1));

    act(() => {
      watched[0]?.onFrame({
        event: "event",
        data: durable(6, "phase", { title: "synthesis" }),
        raw: "event: event",
      });
    });

    await waitFor(() => expect(client.getRun).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText("synthesis").length).toBeGreaterThan(0);
  });

  test("event conversion debug summaries omit raw streamed agent text", async () => {
    const marker = "raw-run-detail-debug-marker";
    localStorage.setItem("keelDebug", "events");
    resetWebDebugCacheForTest();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const watched: WatchRunEventsOptions[] = [];
    const client = {
      getRun: vi.fn(async () => detail()),
      watchRunEvents: vi.fn((_runId: string, opts: WatchRunEventsOptions) => {
        watched.push(opts);
        return vi.fn();
      }),
    } as unknown as KeelWebClient;

    render(<RunDetailScreen client={client} runId="run_1" refreshKey={0} />);

    await screen.findByText("cursor 5");
    fireEvent.click(screen.getByRole("button", { name: "Watch live" }));
    await waitFor(() => expect(client.watchRunEvents).toHaveBeenCalledTimes(1));

    act(() => {
      watched[0]?.onFrame({
        event: "event",
        data: {
          kind: "ephemeral",
          type: "agent.event",
          payload: { key: "review", event: { type: "reasoning", data: marker } },
          atMs: 12,
        },
        raw: "event: event",
      });
    });

    await waitFor(() => {
      expect(JSON.stringify(debug.mock.calls)).toContain(`"dataLength":${marker.length}`);
    });
    const logged = JSON.stringify(debug.mock.calls);
    expect(logged).not.toContain(marker);
    expect(logged).toContain('"innerType":"reasoning"');
  });

  test("labels the internal default workspace as the run target on detail", async () => {
    const client = {
      getRun: vi.fn(async () => ({
        ...detail(),
        workspaces: [
          workspace("__default", "direct", "idle", "/repo"),
          workspace("fake-app-change", "worktree", "pending_review", "/tmp/worktree"),
        ],
      })),
      watchRunEvents: vi.fn(),
    } as unknown as KeelWebClient;

    render(<RunDetailScreen client={client} runId="run_1" refreshKey={0} />);

    fireEvent.click(await screen.findByRole("tab", { name: /workspaces/i }));
    expect(screen.getByText("default")).toBeInTheDocument();
    expect(screen.getAllByText(/target/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("Default target")).not.toBeInTheDocument();
    expect(screen.queryByText("__default")).not.toBeInTheDocument();
    expect(screen.getByText("fake-app-change")).toBeInTheDocument();
  });

  test("hides the checkpoint and state panels when the run has neither", async () => {
    const client = {
      getRun: vi.fn(async () => detail()),
      watchRunEvents: vi.fn(),
    } as unknown as KeelWebClient;

    render(<RunDetailScreen client={client} runId="run_1" refreshKey={0} />);

    await screen.findByText("cursor 5");
    expect(screen.queryByRole("heading", { name: "Checkpoints" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "State" })).not.toBeInTheDocument();
  });

  test("renders checkpoint frames in stream order with message and data", async () => {
    const client = {
      getRun: vi.fn(async () => ({
        ...detail(),
        events: [
          durable(2, "checkpoint", { stableKey: "cp.a", attempt: 1, message: "first", data: null }),
          durable(4, "checkpoint", {
            stableKey: "cp.b",
            attempt: 1,
            message: "second",
            data: { iteration: 2 },
          }),
        ],
      })),
      watchRunEvents: vi.fn(),
    } as unknown as KeelWebClient;

    render(<RunDetailScreen client={client} runId="run_1" refreshKey={0} />);

    const first = await screen.findByText("first");
    const second = screen.getByText("second");
    expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/"iteration": 2/)).toBeInTheDocument();
  });

  test("appends live checkpoint frames through the event stream", async () => {
    const watched: WatchRunEventsOptions[] = [];
    const client = {
      getRun: vi.fn(async () => detail()),
      watchRunEvents: vi.fn((_runId: string, opts: WatchRunEventsOptions) => {
        watched.push(opts);
        return vi.fn();
      }),
    } as unknown as KeelWebClient;

    render(<RunDetailScreen client={client} runId="run_1" refreshKey={0} />);
    await screen.findByText("cursor 5");
    fireEvent.click(screen.getByRole("button", { name: "Watch live" }));
    await waitFor(() => expect(client.watchRunEvents).toHaveBeenCalledTimes(1));

    act(() => {
      watched[0]?.onFrame({
        event: "event",
        data: durable(6, "checkpoint", {
          stableKey: "cp.live",
          attempt: 1,
          message: "streamed progress",
          data: null,
        }),
        raw: "event: event",
      });
    });

    expect(await screen.findByText("streamed progress")).toBeInTheDocument();
  });

  test("shows the folded state snapshot grouped by namespace and name", async () => {
    const client = {
      getRun: vi.fn(async () => ({
        ...detail(),
        run: {
          ...detail().run,
          state: {
            research: { count: 3, history: [1, 2, 3] },
            auxiliary: { count: 99 },
          },
        },
      })),
      watchRunEvents: vi.fn(),
    } as unknown as KeelWebClient;

    render(<RunDetailScreen client={client} runId="run_1" refreshKey={0} />);

    await screen.findByRole("heading", { name: "State" });
    expect(screen.getByText("research")).toBeInTheDocument();
    expect(screen.getByText("auxiliary")).toBeInTheDocument();
    expect(screen.getByText("history")).toBeInTheDocument();
    expect(screen.getByText("99")).toBeInTheDocument();
  });

  test("reloads the folded state snapshot when a live state write completes", async () => {
    let count = 111;
    const watched: WatchRunEventsOptions[] = [];
    const client = {
      getRun: vi.fn(async () => ({
        ...detail(),
        run: { ...detail().run, state: { research: { count } } },
      })),
      watchRunEvents: vi.fn((_runId: string, opts: WatchRunEventsOptions) => {
        watched.push(opts);
        return vi.fn();
      }),
    } as unknown as KeelWebClient;

    render(<RunDetailScreen client={client} runId="run_1" refreshKey={0} />);
    await screen.findByText("111");
    fireEvent.click(screen.getByRole("button", { name: "Watch live" }));
    await waitFor(() => expect(client.watchRunEvents).toHaveBeenCalledTimes(1));

    count = 222;
    act(() => {
      watched[0]?.onFrame({
        event: "event",
        data: durable(6, "step.completed", { stableKey: "state.count", effectType: "state_write" }),
        raw: "event: event",
      });
    });

    await waitFor(() => expect(client.getRun).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("222")).toBeInTheDocument();
  });
});

function detail(seq = 5): RunDetailResponse {
  return {
    run: {
      runId: "run_1",
      workflowName: "wf",
      status: "running",
      definitionVersion: "wf_sha",
      runTarget: "target",
      parentRunId: null,
      createdAtMs: 1,
      finishedAtMs: null,
      state: {},
      nodes: [
        {
          stableKey: "step_a",
          effectType: "pure",
          status: "completed",
          attempt: 1,
          startedAtMs: 1,
          dependsOn: [],
          artifactBacked: false,
          checkpoint: null,
        },
        {
          stableKey: "step_b",
          effectType: "effectful",
          status: "pending",
          attempt: 1,
          startedAtMs: 2,
          dependsOn: ["step_a"],
          artifactBacked: false,
          checkpoint: null,
        },
      ],
      phase: "Running",
      error: null,
      stats: { steps: 1, agents: 1, checkpointCount: 0, artifacts: 0 },
    },
    report: null,
    blockage: null,
    workspaces: [],
    source: null,
    flow: null,
    events: [],
    eventCursor: { kind: "after-seq", runId: "run_1", seq },
    rawEvents: { href: "/runs/run_1/events" },
    actionAuthorization: {
      resume: true,
      interrupt: true,
      retry: true,
      rerun: true,
      rewind: true,
      fork: true,
      signal: true,
      decideApproval: false,
    },
  };
}

function workspace(
  workspaceId: string,
  mode: RunWorkspaceView["mode"],
  status: string,
  workspacePath: string,
): RunWorkspaceView {
  return {
    runId: "run_1",
    workspaceId,
    mode,
    ownerKind: "workflow",
    key: workspaceId,
    lastAttempt: null,
    retentionPolicy: null,
    workspacePath,
    setupStatus: "none",
    setupIdentityHash: null,
    setupStartedAtMs: null,
    setupFinishedAtMs: null,
    setupError: null,
    sourceKind: mode === "direct" ? "direct-path" : "worktree-git",
    sourcePath: mode === "direct" ? workspacePath : "/repo",
    sourceUri: null,
    sourceBare: null,
    sourceMergeEligible: mode !== "direct",
    suppliedPath: null,
    sourceRef: null,
    resolvedRef: null,
    checkoutBranch: null,
    baseCommit: null,
    copyBaselinePath: null,
    owned: true,
    status,
    failureSeen: false,
    lastTurnKey: null,
    lastTurnAttempt: null,
    activeHolderKind: null,
    activeHolderKey: null,
    activeHolderAttempt: null,
    activeStartedAtMs: null,
    lastDiffEventSeq: null,
    lastErrorEventSeq: null,
    cleanupError: null,
    mergeSupported: mode !== "direct",
    discardSupported: mode !== "direct",
    diffSupported: mode !== "direct",
    createdAtMs: 1,
    updatedAtMs: 1,
    mergedAtMs: null,
    discardedAtMs: null,
    removedAtMs: null,
  };
}

function durable(seq: number, type: string, payload: unknown = {}): EventStreamFrame {
  return { kind: "durable", seq, type, payload, atMs: seq };
}

function ephemeral(type: string): EventStreamFrame {
  return { kind: "ephemeral", type, payload: {}, atMs: 1 };
}

function raw(data: EventStreamFrame, source: RawEventFrame["source"]): RawEventFrame {
  return { event: "event", data, raw: JSON.stringify(data), source, receivedAtMs: 1 };
}

function rawSummary(frame: RawEventFrame): string {
  const data = frame.data as EventStreamFrame;
  return data.kind === "durable"
    ? `${data.seq}:${data.type}:${frame.source}`
    : `${data.type}:${frame.source}`;
}
