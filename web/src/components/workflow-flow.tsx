import {
  Bot,
  Box,
  Database,
  Flag,
  GitFork,
  Inbox,
  LogOut,
  type LucideIcon,
  MessageSquare,
  MessagesSquare,
  Radio,
  Timer,
  UserCheck,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { NodeView, RunStatus, WorkflowFlowOperation, WorkflowFlowView } from "../api/types";
import { type FlowNode, layoutFlow } from "../lib/workflow-flow";
import type { FlowRuntimeOverrides } from "../lib/workflow-flow-live";
import { StatusPill } from "./controls";

const OP_ICON: Record<string, LucideIcon> = {
  phase: Flag,
  step: Box,
  agent: Bot,
  agentSession: MessagesSquare,
  agentTurn: MessageSquare,
  sleep: Timer,
  human: UserCheck,
  signal: Radio,
  checkpoint: Flag,
  drainSignals: Inbox,
  stateSet: Database,
  spawn: GitFork,
  waitRun: Timer,
  return: LogOut,
};

const ZOOM_STEP = 0.15;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1.6;

const COMPLETED_TERMINAL = new Set<RunStatus>(["finished", "continued"]);

export function WorkflowFlow({
  flow,
  nodes,
  phase,
  runStatus,
  runtime,
}: {
  flow: WorkflowFlowView;
  nodes: NodeView[];
  phase: string | null;
  runStatus: RunStatus;
  runtime?: FlowRuntimeOverrides;
}) {
  const completed = COMPLETED_TERMINAL.has(runStatus);
  const layout = useMemo(
    () => layoutFlow(flow, { nodes, phase, finished: completed, overrides: runtime }),
    [flow, nodes, phase, completed, runtime],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  if (flow.operations.length === 0) {
    return <div className="graph-empty">No workflow operations were detected in the source.</div>;
  }

  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;
  const zoomTo = (next: number) =>
    setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100)));

  return (
    <div className="run-graph workflow-flow-graph">
      <div className="graph-summary">
        <StatusPill tone="info">{flow.operations.length} operations</StatusPill>
        {flow.entry.name ? <StatusPill tone="neutral">{flow.entry.name}</StatusPill> : null}
      </div>
      <div className="graph-canvas">
        <div className="graph-scroll">
          <div
            className="graph-zoomwrap"
            style={{ width: layout.width * zoom, height: layout.height * zoom }}
          >
            <div
              className="graph-stage"
              style={{
                width: layout.width,
                height: layout.height,
                transform: `scale(${zoom})`,
                transformOrigin: "0 0",
              }}
            >
              <svg
                className="graph-edges"
                width={layout.width}
                height={layout.height}
                aria-hidden="true"
              >
                <title>Workflow control flow</title>
                <defs>
                  <marker
                    id="flow-arrow"
                    markerWidth="8"
                    markerHeight="8"
                    refX="6.5"
                    refY="4"
                    orient="auto"
                  >
                    <path
                      d="M1,1 L6.5,4 L1,7"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </marker>
                </defs>
                {layout.edges.map((edge) => {
                  const from = byId.get(edge.from);
                  const to = byId.get(edge.to);
                  if (!from || !to) return null;
                  const annotated = edge.kind === "skip" || edge.kind === "repeat";
                  return (
                    <path
                      key={edge.id}
                      d={edgePath(from, to, edge.kind, layout.width)}
                      className={`gedge${annotated ? " gedge-dim" : ""}`}
                      markerEnd="url(#flow-arrow)"
                    />
                  );
                })}
              </svg>
              {layout.nodes.map((node) => (
                <FlowNodeBox
                  key={node.id}
                  node={node}
                  selected={selectedId === node.id}
                  onSelect={() =>
                    setSelectedId((current) =>
                      node.kind === "op" || node.kind === "phase"
                        ? current === node.id
                          ? null
                          : node.id
                        : current,
                    )
                  }
                />
              ))}
            </div>
          </div>
        </div>
        <div className="graph-controls">
          <button
            type="button"
            className="icon-btn"
            aria-label="Zoom out"
            title="Zoom out"
            disabled={zoom <= ZOOM_MIN}
            onClick={() => zoomTo(zoom - ZOOM_STEP)}
          >
            <ZoomOut size={15} />
          </button>
          <span className="graph-zoom">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Zoom in"
            title="Zoom in"
            disabled={zoom >= ZOOM_MAX}
            onClick={() => zoomTo(zoom + ZOOM_STEP)}
          >
            <ZoomIn size={15} />
          </button>
        </div>
        {selected?.op ? null : (
          <div className="graph-hint graph-hint-overlay muted">
            Select an operation to inspect its spec and runtime status.
          </div>
        )}
      </div>
      {selected?.op ? <FlowDetail node={selected} /> : null}
    </div>
  );
}

function FlowNodeBox({
  node,
  selected,
  onSelect,
}: {
  node: FlowNode;
  selected: boolean;
  onSelect: () => void;
}) {
  const style = { left: node.x, top: node.y, width: node.w, height: node.h };

  if (node.kind === "phase") {
    return (
      <button
        type="button"
        className={`gphase gphase-${node.tone}${activeClass(node)}${
          selected ? " is-selected" : ""
        }`}
        style={style}
        onClick={onSelect}
      >
        <Flag size={13} />
        <span className="gphase-label">{node.label}</span>
      </button>
    );
  }

  if (node.kind === "fanout" || node.kind === "join") {
    return (
      <div className="gfan" style={style}>
        {node.label}
      </div>
    );
  }

  if (node.kind === "branch") {
    return (
      <div className="gbranch" style={style}>
        <span className="gbranch-glyph">◆</span>
        <span className="gbranch-label">{node.label}</span>
      </div>
    );
  }

  const Icon = OP_ICON[node.op?.kind ?? "step"] ?? Box;
  return (
    <button
      type="button"
      className={`gnode gnode-${node.tone}${activeClass(node)}${
        node.matched ? "" : " is-unmatched"
      }${selected ? " is-selected" : ""}`}
      style={style}
      onClick={onSelect}
      title={node.label}
    >
      <span className={`gnode-icon gnode-icon-${node.tone}`}>
        <Icon size={13} />
      </span>
      <span className="gnode-text">
        <span className="gnode-title">{node.label}</span>
        <span className="gnode-meta">
          <span className={`gnode-status-dot dot-${node.tone}`} />
          {node.meta}
        </span>
      </span>
    </button>
  );
}

function activeClass(node: FlowNode): string {
  return node.state === "running" || node.state === "blocked" ? " is-live-active" : "";
}

function FlowDetail({ node }: { node: FlowNode }) {
  const op = node.op as WorkflowFlowOperation;
  const rows: Array<[string, string]> = [];
  const add = (label: string, expr?: { value?: unknown; text?: string }) => {
    if (!expr) return;
    const value = (typeof expr.value === "string" ? expr.value : undefined) ?? expr.text;
    if (value) rows.push([label, value]);
  };
  add("Key", op.key);
  add("Provider", op.provider);
  add("Model", op.model);
  add("Profile", op.profile);
  add("Tool policy", op.toolPolicy);
  add("Reasoning", op.reasoning);
  add("Target", op.target);
  add("Condition", op.condition);
  add("Message", op.message);
  add("Namespace", op.namespace);
  add("State", op.stateName);
  add("Signal", op.signalName);
  add("Workflow", op.workflowRef);
  add("Prompt", op.prompt);

  return (
    <div className="graph-node-detail">
      <div className="graph-node-detail-head">
        <strong>{node.label}</strong>
        <StatusPill tone={node.tone} dot>
          {statusLabel(node)}
        </StatusPill>
      </div>
      <div className="graph-node-detail-meta">
        <span>{op.kind}</span>
        {op.containers.map((container) => (
          <span key={container}>{container}</span>
        ))}
        {node.count && node.count > 1 ? <span>{node.count} runtime nodes</span> : null}
      </div>
      {rows.length > 0 ? (
        <dl className="kv-list">
          {rows.map(([label, value]) => (
            <div className="kv-row" key={label}>
              <dt>{label}</dt>
              <dd className="mono">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

function statusLabel(node: FlowNode): string {
  switch (node.state) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "running":
      return "running";
    case "blocked":
      return "blocked";
    case "not-started":
      return "not started";
  }
  switch (node.tone) {
    case "success":
      return "completed";
    case "failed":
      return "failed";
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    default:
      return "tracked";
  }
}

function edgePath(from: FlowNode, to: FlowNode, kind: string, width: number): string {
  if (kind === "skip") {
    const sx = from.x + from.w;
    const sy = from.y + from.h / 2;
    const tx = to.x + to.w;
    const ty = to.y + to.h / 2;
    const bow = width - 6;
    return `M${sx},${sy} C${bow},${sy} ${bow},${ty} ${tx},${ty}`;
  }
  if (kind === "repeat") {
    const sx = from.x;
    const sy = from.y + from.h / 2;
    const tx = to.x;
    const ty = to.y + to.h / 2;
    const bow = 8;
    return `M${sx},${sy} C${bow},${sy} ${bow},${ty} ${tx},${ty}`;
  }
  const sx = from.x + from.w / 2;
  const sy = from.y + from.h;
  const tx = to.x + to.w / 2;
  const ty = to.y;
  const dy = ty - sy;
  return `M${sx},${sy} C${sx},${sy + dy * 0.5} ${tx},${ty - dy * 0.5} ${tx},${ty}`;
}
