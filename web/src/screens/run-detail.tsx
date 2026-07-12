import { Check, Pause, Radio, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeelWebClient, WatchRunEventsStatus } from "../api/client";
import type { SseMessage } from "../api/sse";
import type {
  EventCursorInput,
  EventStreamFrame,
  NodeView,
  RunDetailResponse,
  RunStatus,
} from "../api/types";
import { CodeViewer } from "../components/code-viewer";
import {
  Button,
  EmptyState,
  ErrorState,
  JsonBlock,
  KeyValueList,
  LoadingState,
  Select,
  StatusPill,
  Tabs,
  type Tone,
  formatDuration,
  formatTime,
  statusLabel,
  toneForStatus,
} from "../components/controls";
import { type Column, DenseTable } from "../components/dense-table";
import { NodeTimeline, RunGraph } from "../components/graph";
import { RunActions } from "../components/run-actions";
import { type RawEventFrame, RawEventList, Transcript } from "../components/transcript";
import { WorkflowFlow } from "../components/workflow-flow";
import { useAsync } from "../hooks/use-async";
import { summarizeEventFrameForDebug, webDebug } from "../lib/debug";
import { flowPhaseFromEvents, flowRuntimeFromEvents } from "../lib/workflow-flow-live";

type RunTab =
  | "overview"
  | "activity"
  | "flow"
  | "source"
  | "workspaces"
  | "approvals"
  | "diagnostics";

type CursorMode = "current" | "tail" | "beginning" | "now";

interface StreamState {
  state: "idle" | WatchRunEventsStatus["state"];
  cursorSeq: number | null;
  message?: string;
}

const TABS: Array<{ id: RunTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "activity", label: "Activity" },
  { id: "flow", label: "Flow" },
  { id: "workspaces", label: "Workspaces" },
  { id: "approvals", label: "Approvals" },
  { id: "source", label: "Source" },
  { id: "diagnostics", label: "Diagnostics" },
];

export function RunDetailScreen({
  client,
  runId,
  refreshKey,
}: {
  client: KeelWebClient;
  runId: string;
  refreshKey: number;
}) {
  const detailState = useAsync(() => client.getRun(runId), [client, runId, refreshKey]);
  const [tab, setTab] = useState<RunTab>("overview");
  const [live, setLive] = useState(false);
  const [cursorMode, setCursorMode] = useState<CursorMode>("current");
  const [liveEvents, setLiveEvents] = useState<EventStreamFrame[]>([]);
  const [rawLiveFrames, setRawLiveFrames] = useState<RawEventFrame[]>([]);
  const [streamState, setStreamState] = useState<StreamState>({
    state: "idle",
    cursorSeq: null,
  });
  const latestSeqRef = useRef<number | null>(null);
  const detailRef = useRef<RunDetailResponse | null>(null);
  detailRef.current = detailState.data;
  const currentCursorReady = cursorMode !== "current" || detailState.data !== null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: runId must clear live buffers even when a new run has the same cursor sequence.
  useEffect(() => {
    latestSeqRef.current = null;
    setLiveEvents([]);
    setRawLiveFrames([]);
    setStreamState({ state: "idle", cursorSeq: null });
  }, [runId]);

  useEffect(() => {
    const seq = detailState.data?.eventCursor?.seq ?? null;
    if (seq === null) return;
    const nextSeq = Math.max(latestSeqRef.current ?? seq, seq);
    latestSeqRef.current = nextSeq;
    setStreamState((state) => ({ ...state, cursorSeq: nextSeq }));
  }, [detailState.data?.eventCursor?.seq]);

  useEffect(() => {
    if (!live || !currentCursorReady) return;
    const stop = client.watchRunEvents(runId, {
      cursor: cursorInputForMode(cursorMode, detailRef.current, latestSeqRef.current),
      onFrame: (frame) => {
        setRawLiveFrames((frames) => [
          ...frames.slice(-499),
          {
            event: frame.event,
            data: frame.data,
            raw: frame.raw,
            source: "live",
            receivedAtMs: Date.now(),
          },
        ]);
        const event = streamFrameFromSse(frame);
        webDebug("events", "run frame conversion", () => ({
          sseEvent: frame.event,
          accepted: event !== null,
          frame: event ? summarizeEventFrameForDebug(event) : null,
        }));
        if (event) setLiveEvents((events) => [...events.slice(-499), event]);
        if (shouldReloadProjection(frame)) detailState.reload();
        const seq = cursorSeqFromSse(frame);
        if (seq !== null) {
          latestSeqRef.current = seq;
          setStreamState((state) => ({ ...state, cursorSeq: seq }));
        }
      },
      onStatus: (status) => {
        const seq = seqFromCursorInput(status.cursor);
        if (seq !== null) latestSeqRef.current = seq;
        if (status.state === "closed") setLive(false);
        setStreamState({
          state: status.state,
          cursorSeq: seq ?? latestSeqRef.current,
          message: "reason" in status ? status.reason : undefined,
        });
      },
      onError: (err) => {
        setStreamState((state) => ({
          ...state,
          state: "reconnecting",
          message: err instanceof Error ? err.message : String(err),
        }));
      },
    });
    return stop;
  }, [client, currentCursorReady, cursorMode, detailState.reload, live, runId]);

  const detail = detailState.data;
  const displayDetail = useMemo(
    () => applyLiveProjection(detail, liveEvents),
    [detail, liveEvents],
  );
  const renderedDetail = displayDetail ?? detail;
  const allEvents = useMemo(() => {
    const merged = mergeEventFrames(detail?.events ?? [], liveEvents);
    webDebug("events", "merged event frames", () => ({
      tail: detail?.events.length ?? 0,
      live: liveEvents.length,
      merged: merged.length,
    }));
    return merged;
  }, [detail?.events, liveEvents]);
  const rawFrames = useMemo(
    () => mergeRawFrames(tailRawFrames(detail?.events ?? []), rawLiveFrames),
    [detail?.events, rawLiveFrames],
  );

  return (
    <div className="run-detail-screen">
      <div className="content-scroll run-detail-main">
        <div className="toolbar run-detail-toolbar">
          <div className="toolbar-left">
            <a className="inline-link" href="#/runs">
              Runs
            </a>
            <span className="mono">{runId}</span>
            <StatusPill tone={streamTone(streamState, live)} dot>
              {streamLabel(streamState, live)}
            </StatusPill>
            <span className="mono stream-cursor">cursor {streamState.cursorSeq ?? "-"}</span>
          </div>
          <div className="toolbar-right">
            {renderedDetail?.run ? (
              <RunActions
                client={client}
                run={renderedDetail.run}
                authorization={renderedDetail.actionAuthorization}
                onChanged={detailState.reload}
              />
            ) : null}
            <Select
              value={cursorMode}
              onChange={(event) => setCursorMode(event.target.value as CursorMode)}
              aria-label="Watch cursor"
            >
              <option value="current">Current cursor</option>
              <option value="tail">Tail 100</option>
              <option value="beginning">Beginning</option>
              <option value="now">Now</option>
            </Select>
            <Button icon={RefreshCw} size="sm" onClick={detailState.reload}>
              Refresh
            </Button>
            <Button
              icon={live ? Pause : Radio}
              size="sm"
              variant={live ? "primary" : "secondary"}
              onClick={() => setLive((value) => !value)}
            >
              {live ? "Pause live" : "Watch live"}
            </Button>
          </div>
        </div>
        {renderedDetail?.blockage ? (
          <div className="run-blockage-banner">
            <StatusPill tone={toneForStatus(renderedDetail.blockage.reason)} dot>
              {statusLabel(renderedDetail.blockage.reason)}
            </StatusPill>
            <span>{renderedDetail.blockage.context}</span>
            {renderedDetail.blockage.reason === "waiting_human" ? (
              <button className="inline-link" type="button" onClick={() => setTab("approvals")}>
                Review approval
              </button>
            ) : null}
          </div>
        ) : null}
        {detailState.loading ? <LoadingState label="Loading run" /> : null}
        {detailState.error ? (
          <ErrorState error={detailState.error} onRetry={detailState.reload} />
        ) : null}
        {renderedDetail && !detailState.loading && !detailState.error ? (
          <>
            <Tabs<RunTab>
              tabs={TABS.map((item) => ({
                ...item,
                count: tabCount(item.id, renderedDetail, allEvents),
              }))}
              active={tab}
              onChange={setTab}
            />
            <div className="tab-panel">
              {renderTab(
                tab,
                renderedDetail,
                allEvents,
                rawFrames,
                setTab,
                client,
                detailState.reload,
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function renderTab(
  tab: RunTab,
  detail: RunDetailResponse,
  events: EventStreamFrame[],
  rawFrames: RawEventFrame[],
  setTab: (tab: RunTab) => void,
  client: KeelWebClient,
  reload: () => void,
) {
  if (!detail.run) {
    return (
      <EmptyState title="Run not found" detail="The daemon did not return a run projection." />
    );
  }
  switch (tab) {
    case "overview":
      return (
        <div className="overview-grid">
          <section className="panel panel-wide">
            <div className="panel-heading">
              <h2>Graph</h2>
              <span className="muted">Projection nodes and dependency edges</span>
            </div>
            <RunGraph nodes={detail.run.nodes} />
          </section>
          <section className="panel panel-wide">
            <h2>Summary</h2>
            <KeyValueList
              rows={[
                { label: "Workflow", value: detail.run.workflowName ?? "unnamed" },
                { label: "Status", value: detail.run.status },
                { label: "Phase", value: detail.run.phase ?? "-" },
                { label: "Definition", value: detail.run.definitionVersion, mono: true },
                ...(detail.run.parentRunId
                  ? [
                      {
                        label: "Parent run",
                        value: (
                          <a className="inline-link mono" href={`#/runs/${detail.run.parentRunId}`}>
                            {detail.run.parentRunId}
                          </a>
                        ),
                      },
                    ]
                  : []),
                { label: "Created", value: formatTime(detail.run.createdAtMs) },
                {
                  label: "Duration",
                  value: formatDuration(detail.run.createdAtMs, detail.run.finishedAtMs),
                },
              ]}
            />
          </section>
          <section className="panel">
            <div className="panel-heading">
              <h2>Recent Transcript</h2>
              <button className="inline-link" type="button" onClick={() => setTab("activity")}>
                Open activity
              </button>
            </div>
            <Transcript events={events} compact maxRows={8} />
          </section>
        </div>
      );
    case "flow":
      return detail.flow ? (
        <WorkflowFlow
          flow={detail.flow}
          nodes={detail.run.nodes}
          phase={flowPhaseFromEvents(events) ?? detail.run.phase}
          runStatus={detail.run.status}
          runtime={flowRuntimeFromEvents(events)}
        />
      ) : (
        <EmptyState
          title="No workflow flow"
          detail="The run did not capture parseable workflow source for a structural view."
        />
      );
    case "activity":
      return (
        <div className="activity-grid">
          <section className="panel panel-wide">
            <div className="panel-heading">
              <h2>Transcript</h2>
              <StatusPill tone="neutral">{events.length} events</StatusPill>
            </div>
            <Transcript events={events} />
          </section>
          <section className="panel panel-wide">
            <div className="panel-heading">
              <h2>Step timeline</h2>
              <StatusPill tone="neutral">{detail.run.nodes.length} steps</StatusPill>
            </div>
            <NodeTimeline nodes={detail.run.nodes} />
            <NodeTable nodes={detail.run.nodes} />
          </section>
        </div>
      );
    case "source":
      return <CodeViewer source={detail.source} />;
    case "workspaces":
      return <WorkspacesTable detail={detail} />;
    case "approvals":
      return <ApprovalPanel detail={detail} client={client} onChanged={reload} />;
    case "diagnostics":
      return (
        <div className="diagnostics-grid">
          <section className="panel">
            <h2>Run report</h2>
            <JsonBlock value={detail.report ?? detail.run} />
          </section>
          <section className="panel panel-wide">
            <div className="panel-heading">
              <h2>Raw event stream</h2>
              <StatusPill tone="neutral">{rawFrames.length} frames</StatusPill>
            </div>
            <RawEventList frames={rawFrames} />
          </section>
        </div>
      );
  }
}

function WorkspacesTable({ detail }: { detail: RunDetailResponse }) {
  return (
    <DenseTable
      rows={detail.workspaces}
      rowKey={(workspace) => workspace.workspaceId}
      empty="No workspaces"
      columns={[
        {
          key: "id",
          header: "Workspace",
          render: (workspace) =>
            isDefaultWorkspace(workspace) ? (
              <span className="default-target-cell">
                <StatusPill tone="info">default</StatusPill>
              </span>
            ) : (
              <span className="mono">{workspace.workspaceId}</span>
            ),
        },
        { key: "mode", header: "Mode", width: "110px", render: (workspace) => workspace.mode },
        {
          key: "status",
          header: "Status",
          width: "120px",
          render: (workspace) => (
            <StatusPill
              tone={isDefaultWorkspace(workspace) ? "neutral" : toneForStatus(workspace.status)}
            >
              {isDefaultWorkspace(workspace) ? "Target" : statusLabel(workspace.status)}
            </StatusPill>
          ),
        },
        {
          key: "path",
          header: "Path",
          render: (workspace) => (
            <span className="mono text-truncate">{workspace.workspacePath}</span>
          ),
        },
      ]}
    />
  );
}

function isDefaultWorkspace(workspace: { workspaceId: string }): boolean {
  return workspace.workspaceId === "__default";
}

function ApprovalPanel({
  detail,
  client,
  onChanged,
}: { detail: RunDetailResponse; client: KeelWebClient; onChanged: () => void }) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const run = detail.run;
  const blockage = detail.blockage;
  if (!run || blockage?.reason !== "waiting_human") {
    return (
      <EmptyState
        title="No run-local approval is waiting"
        detail="The current projection does not expose a waiting ctx.human gate for this run."
      />
    );
  }

  const gate = blockage.blockedOn?.stableKey ?? "<gate>";
  const prompt = blockage.context.replace(/^awaiting decision: /, "");
  const canDecide = detail.actionAuthorization.decideApproval === true;
  const decide = async (status: "approved" | "denied") => {
    if (!canDecide || gate === "<gate>" || pending) return;
    setPending(status);
    setError(null);
    setMessage(null);
    try {
      await client.decideApproval(run.runId, gate, {
        status,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setNote("");
      setMessage(`${status === "approved" ? "Approved" : "Denied"} ${gate}`);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };
  return (
    <div className="approval-panel">
      <section className="panel">
        <h2>Waiting Human Gate</h2>
        <KeyValueList
          rows={[
            { label: "Gate", value: gate, mono: true },
            { label: "Prompt", value: prompt },
            { label: "Since", value: formatTime(blockage.blockedOn?.since) },
            { label: "Authority", value: "admin" },
          ]}
        />
        <textarea
          className="field-textarea"
          rows={3}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Decision note"
          aria-label="Decision note"
        />
        {!canDecide ? (
          <p className="muted">
            Approval decisions require admin authority and a refreshed run projection.
          </p>
        ) : null}
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {message ? <output className="form-success">{message}</output> : null}
        <div className="btn-row">
          <Button
            icon={X}
            variant="danger"
            disabled={!canDecide || gate === "<gate>" || pending !== null}
            onClick={() => void decide("denied")}
          >
            {pending === "denied" ? "Denying" : "Deny"}
          </Button>
          <Button
            icon={Check}
            variant="primary"
            disabled={!canDecide || gate === "<gate>" || pending !== null}
            onClick={() => void decide("approved")}
          >
            {pending === "approved" ? "Approving" : "Approve"}
          </Button>
        </div>
      </section>
    </div>
  );
}

function NodeTable({ nodes }: { nodes: NodeView[] }) {
  const columns: Array<Column<NodeView>> = [
    {
      key: "key",
      header: "Stable key",
      render: (node) => <span className="mono">{node.stableKey}</span>,
    },
    { key: "effect", header: "Effect", width: "120px", render: (node) => node.effectType },
    {
      key: "status",
      header: "Status",
      width: "130px",
      render: (node) => (
        <StatusPill tone={toneForStatus(node.status)}>{statusLabel(node.status)}</StatusPill>
      ),
    },
    {
      key: "started",
      header: "Started",
      width: "180px",
      render: (node) => <span className="mono">{formatTime(node.startedAtMs)}</span>,
    },
    {
      key: "attempt",
      header: "Attempt",
      width: "80px",
      align: "right",
      render: (node) => node.attempt,
    },
    {
      key: "artifact",
      header: "Artifact",
      width: "90px",
      render: (node) => (node.artifactBacked ? "yes" : "no"),
    },
    { key: "deps", header: "Depends on", render: (node) => node.dependsOn.join(", ") || "root" },
  ];
  return (
    <DenseTable
      rows={nodes}
      rowKey={(node) => `${node.stableKey}:${node.attempt}`}
      columns={columns}
    />
  );
}

function tabCount(
  tab: RunTab,
  detail: RunDetailResponse,
  events: EventStreamFrame[],
): number | undefined {
  if (tab === "flow") return detail.flow?.operations.length ?? 0;
  if (tab === "activity") return events.length;
  if (tab === "workspaces") return detail.workspaces.length;
  if (tab === "diagnostics") return events.length;
  if (tab === "approvals") return detail.blockage?.reason === "waiting_human" ? 1 : 0;
  return undefined;
}

function applyLiveProjection(
  detail: RunDetailResponse | null,
  liveEvents: EventStreamFrame[],
): RunDetailResponse | null {
  if (!detail?.run || liveEvents.length === 0) return detail;
  let next: RunDetailResponse | null = null;
  const current = () => next ?? detail;
  const mutable = () => {
    if (!next) next = { ...detail, run: detail.run ? { ...detail.run } : detail.run };
    return next;
  };

  for (const event of liveEvents) {
    if (event.kind !== "durable") continue;
    if (event.type === "phase") {
      const title = eventPayloadString(event.payload, "title");
      if (!title) continue;
      const projected = mutable();
      if (projected.run) {
        projected.run = {
          ...projected.run,
          phase: title,
        };
      }
      continue;
    }
    if (event.type === "run.parked") {
      const parked = parkedPayload(event.payload);
      if (!parked) continue;
      const projected = mutable();
      if (projected.run) {
        projected.run = {
          ...projected.run,
          status: parkedStatus(parked.kind),
        };
      }
      if (parked.kind === "human") {
        const key = parked.key ?? null;
        projected.blockage = {
          reason: "waiting_human",
          blockedOn: key ? { stableKey: key, since: event.atMs } : null,
          context: `awaiting decision: ${key ?? "human approval"}`,
        };
      }
      continue;
    }
    if (
      event.type === "run.resumed" ||
      event.type === "run.finished" ||
      event.type === "run.failed" ||
      event.type === "run.aborted" ||
      event.type === "run.interrupted" ||
      event.type === "run.continued"
    ) {
      const projected = mutable();
      projected.blockage = null;
      if (projected.run) {
        projected.run = {
          ...projected.run,
          status: statusForLifecycleEvent(event.type, current().run?.status ?? "running"),
          ...(event.type === "run.finished" ||
          event.type === "run.failed" ||
          event.type === "run.aborted" ||
          event.type === "run.continued"
            ? { finishedAtMs: event.atMs }
            : {}),
        };
      }
    }
  }
  return next ?? detail;
}

function eventPayloadString(payload: unknown, property: string): string | null {
  if (!payload || typeof payload !== "object" || !(property in payload)) return null;
  const value = (payload as Record<string, unknown>)[property];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parkedPayload(
  payload: unknown,
): { kind: "human" | "signal" | "timer"; key?: string } | null {
  if (!payload || typeof payload !== "object") return null;
  const kind = "kind" in payload ? payload.kind : null;
  if (kind !== "human" && kind !== "signal" && kind !== "timer") return null;
  const key = "key" in payload && typeof payload.key === "string" ? payload.key : undefined;
  return key ? { kind, key } : { kind };
}

function parkedStatus(kind: "human" | "signal" | "timer"): RunStatus {
  if (kind === "human") return "waiting-human";
  if (kind === "signal") return "waiting-signal";
  return "waiting-timer";
}

function statusForLifecycleEvent(type: string, fallback: RunStatus): RunStatus {
  if (type === "run.resumed") return "running";
  if (type === "run.finished") return "finished";
  if (type === "run.failed") return "failed";
  if (type === "run.aborted") return "cancelled";
  if (type === "run.interrupted") return "interrupted";
  if (type === "run.continued") return "continued";
  return fallback;
}

function cursorInputForMode(
  mode: CursorMode,
  detail: RunDetailResponse | null,
  latestSeq: number | null,
): EventCursorInput {
  if (mode === "beginning") return { kind: "beginning" };
  if (mode === "now") return { kind: "now" };
  if (mode === "tail") return { kind: "tail", count: 100 };
  const loadedSeq = detail?.eventCursor?.seq ?? null;
  const seq =
    latestSeq === null && loadedSeq === null ? null : Math.max(latestSeq ?? 0, loadedSeq ?? 0);
  return typeof seq === "number" ? { kind: "after-seq", seq } : { kind: "tail", count: 100 };
}

export function mergeEventFrames(
  detailEvents: EventStreamFrame[],
  liveEvents: EventStreamFrame[],
): EventStreamFrame[] {
  return mergeOrderedFrames([
    ...orderEventFrames(detailEvents, 0),
    ...orderEventFrames(liveEvents, detailEvents.length),
  ]).map((item) => item.frame);
}

export function mergeRawFrames(
  tailFrames: RawEventFrame[],
  liveFrames: RawEventFrame[],
): RawEventFrame[] {
  return mergeOrderedFrames([
    ...orderRawFrames(tailFrames, 0),
    ...orderRawFrames(liveFrames, tailFrames.length),
  ]).map((item) => item.frame);
}

function streamFrameFromSse(frame: SseMessage): EventStreamFrame | null {
  const data = frame.data;
  if (isEventFrame(data)) return data;
  if (frame.event === "error") {
    return { kind: "ephemeral", type: "stream.error", payload: data, atMs: Date.now() };
  }
  return null;
}

function isEventFrame(value: unknown): value is EventStreamFrame {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  const kind = value.kind;
  if (kind === "durable") return "seq" in value && "type" in value;
  if (kind === "ephemeral") return "type" in value;
  if (kind === "control") return "type" in value && "cursor" in value;
  return false;
}

function cursorSeqFromSse(frame: SseMessage): number | null {
  const data = frame.data;
  if (!data || typeof data !== "object") return null;
  if ("kind" in data && data.kind === "durable" && "seq" in data && typeof data.seq === "number") {
    return data.seq;
  }
  if ("cursor" in data) {
    const cursor = data.cursor;
    if (cursor && typeof cursor === "object" && "seq" in cursor && typeof cursor.seq === "number") {
      return cursor.seq;
    }
  }
  return null;
}

function seqFromCursorInput(cursor: EventCursorInput): number | null {
  return cursor.kind === "after-seq" ? cursor.seq : null;
}

function tailRawFrames(events: EventStreamFrame[]): RawEventFrame[] {
  return events.map((event) => ({
    event: event.kind === "control" ? event.type : "event",
    data: event,
    source: "tail",
    receivedAtMs: event.kind === "control" ? Date.now() : event.atMs,
  }));
}

interface OrderedFrame<T> {
  frame: T;
  identity: string | null;
  order: number;
  position: number;
}

function mergeOrderedFrames<T>(frames: Array<OrderedFrame<T>>): Array<OrderedFrame<T>> {
  const latestByIdentity = new Map<string, OrderedFrame<T>>();
  for (const frame of frames) {
    if (frame.identity !== null) latestByIdentity.set(frame.identity, frame);
  }

  return frames
    .filter((frame) => frame.identity === null || latestByIdentity.get(frame.identity) === frame)
    .sort((a, b) => a.position - b.position || a.order - b.order);
}

function orderEventFrames(
  frames: EventStreamFrame[],
  offset: number,
): Array<OrderedFrame<EventStreamFrame>> {
  return orderFrames(frames, offset, eventPosition, eventIdentity);
}

function orderRawFrames(
  frames: RawEventFrame[],
  offset: number,
): Array<OrderedFrame<RawEventFrame>> {
  return orderFrames(frames, offset, rawFramePosition, rawFrameIdentity);
}

function orderFrames<T>(
  frames: T[],
  offset: number,
  knownPosition: (frame: T) => number | null,
  identity: (frame: T) => string | null,
): Array<OrderedFrame<T>> {
  const nextPositions = new Array<number | null>(frames.length);
  let next: number | null = null;
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const position = knownPosition(frames[index] as T);
    nextPositions[index] = next;
    if (position !== null) next = position;
  }

  let previous: number | null = null;
  return frames.map((frame, index) => {
    const position = knownPosition(frame);
    const ordered = {
      frame,
      identity: identity(frame),
      order: offset + index,
      position: position ?? inferredPosition(previous, nextPositions[index] ?? null),
    };
    if (position !== null) previous = position;
    return ordered;
  });
}

function inferredPosition(previous: number | null, next: number | null): number {
  if (previous !== null && next !== null) {
    return next > previous ? previous + (next - previous) / 2 : previous + 0.5;
  }
  if (previous !== null) return previous + 0.5;
  if (next !== null) return next - 0.5;
  return Number.MAX_SAFE_INTEGER;
}

function eventPosition(event: EventStreamFrame): number | null {
  if (event.kind === "durable") return event.seq;
  if (event.kind === "control") return event.cursor.seq + 0.75;
  return null;
}

function rawFramePosition(frame: RawEventFrame): number | null {
  return isEventFrame(frame.data) ? eventPosition(frame.data) : null;
}

function eventIdentity(event: EventStreamFrame): string | null {
  if (event.kind === "durable") return `durable:${event.seq}`;
  if (event.kind === "control") return `control:${event.type}:${event.cursor.seq}`;
  return null;
}

function rawFrameIdentity(frame: RawEventFrame): string | null {
  return isEventFrame(frame.data) ? eventIdentity(frame.data) : null;
}

function streamTone(streamState: StreamState, live: boolean): Tone {
  if (!live && streamState.state !== "closed") return "neutral";
  switch (streamState.state) {
    case "caught-up":
    case "open":
      return "running";
    case "connecting":
    case "reconnecting":
      return "waiting";
    case "closed":
      return toneForClosedStream(streamState.message);
    default:
      return "neutral";
  }
}

function streamLabel(streamState: StreamState, live: boolean): string {
  if (!live && streamState.state !== "closed") return "not watching";
  if (streamState.state === "caught-up") return "caught up";
  if (streamState.state === "open") return "streaming";
  if (streamState.state === "reconnecting") return "reconnecting";
  if (streamState.state === "connecting") return "connecting";
  if (streamState.state === "closed") return "closed";
  return "idle";
}

function toneForClosedStream(reason: string | undefined): Tone {
  if (!reason || reason === "finished" || reason === "continued") return "success";
  if (reason === "interrupted" || reason === "parked" || reason.startsWith("waiting")) {
    return "waiting";
  }
  return "failed";
}

function shouldReloadProjection(frame: SseMessage): boolean {
  if (frame.event === "closed") return true;
  const data = frame.data;
  if (!data || typeof data !== "object" || !("kind" in data) || data.kind !== "durable") {
    return false;
  }
  const type = "type" in data ? data.type : null;
  if (type === "run.parked") return !isHumanParkFrame(data);
  return (
    type === "run.finished" ||
    type === "run.failed" ||
    type === "run.aborted" ||
    type === "run.interrupted" ||
    type === "run.continued"
  );
}

function isHumanParkFrame(data: unknown): boolean {
  if (!data || typeof data !== "object" || !("payload" in data)) return false;
  const payload = data.payload;
  return Boolean(
    payload && typeof payload === "object" && "kind" in payload && payload.kind === "human",
  );
}
