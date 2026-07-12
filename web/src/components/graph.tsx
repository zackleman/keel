import {
  Box,
  CircleCheck,
  Flag,
  FolderCog,
  Globe,
  Inbox,
  type LucideIcon,
  Terminal,
  Zap,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { EffectType, NodeView } from "../api/types";
import { StatusPill, formatTime, toneForStatus } from "./controls";

// Workflow graph canvas: SVG dependency edges behind absolutely-positioned node
// boxes, laid out in columns by longest-path depth over `dependsOn`. Ported from
// the .specs/web-ui-mockups prototype to render real RunProjection nodes.

const NODE_W = 188;
const NODE_H = 58;
const GAP_X = 60;
const GAP_Y = 22;
const PAD = 22;

const ZOOM_STEP = 0.15;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1.6;

const EFFECT_ICON = {
  pure: Box,
  effectful: Zap,
  command: Terminal,
  completion_check: CircleCheck,
  checkpoint: Flag,
  drain_signals: Inbox,
  workspace_setup: FolderCog,
  ambient: Globe,
} satisfies Record<EffectType, LucideIcon>;

interface PlacedNode {
  node: NodeView;
  x: number;
  y: number;
}

export function RunGraph({ nodes }: { nodes: NodeView[] }) {
  const { placed, width, height } = useMemo(() => placeNodes(nodes), [nodes]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);

  if (nodes.length === 0) {
    return <div className="graph-empty">No journal nodes have been recorded.</div>;
  }

  const byKey = new Map(placed.map((entry) => [entry.node.stableKey, entry]));
  const edges = placed.flatMap((entry) =>
    entry.node.dependsOn
      .map((dep) => byKey.get(dep))
      .filter((from): from is PlacedNode => from !== undefined)
      .map((from) => ({ from, to: entry })),
  );
  const selected = selectedKey ? (byKey.get(selectedKey)?.node ?? null) : null;
  const zoomTo = (next: number) =>
    setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100)));

  return (
    <div className="run-graph">
      <div className="graph-summary">
        <StatusPill tone="info">{nodes.length} nodes</StatusPill>
        <StatusPill tone="neutral">{edges.length} dependencies</StatusPill>
      </div>
      <div className="graph-canvas">
        <div className="graph-scroll">
          <div className="graph-zoomwrap" style={{ width: width * zoom, height: height * zoom }}>
            <div
              className="graph-stage"
              style={{ width, height, transform: `scale(${zoom})`, transformOrigin: "0 0" }}
            >
              <svg className="graph-edges" width={width} height={height} aria-hidden="true">
                <title>Dependency edges</title>
                <defs>
                  <marker
                    id="graph-arrow"
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
                {edges.map(({ from, to }) => {
                  const dim = from.node.status === "pending" || to.node.status === "pending";
                  return (
                    <path
                      key={`${from.node.stableKey}->${to.node.stableKey}`}
                      d={edgePath(from, to)}
                      className={`gedge${dim ? " gedge-dim" : ""}`}
                      markerEnd="url(#graph-arrow)"
                    />
                  );
                })}
              </svg>
              {placed.map(({ node, x, y }) => {
                const tone = toneForStatus(node.status);
                const Icon = EFFECT_ICON[node.effectType];
                const isSelected = selectedKey === node.stableKey;
                return (
                  <button
                    key={`${node.stableKey}:${node.attempt}`}
                    type="button"
                    className={`gnode gnode-${tone}${node.status === "pending" ? " is-pending" : ""}${
                      isSelected ? " is-selected" : ""
                    }`}
                    style={{ left: x, top: y, width: NODE_W, height: NODE_H }}
                    onClick={() => setSelectedKey(isSelected ? null : node.stableKey)}
                    title={node.stableKey}
                  >
                    <span className={`gnode-icon gnode-icon-${tone}`}>
                      <Icon size={13} />
                    </span>
                    <span className="gnode-text">
                      <span className="gnode-title">{node.stableKey}</span>
                      <span className="gnode-meta">
                        <span className={`gnode-status-dot dot-${tone}`} />
                        {node.effectType} · {node.status}
                      </span>
                    </span>
                  </button>
                );
              })}
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
      </div>
      {selected ? (
        <div className="graph-node-detail">
          <div className="graph-node-detail-head">
            <strong className="mono">{selected.stableKey}</strong>
            <StatusPill tone={toneForStatus(selected.status)} dot>
              {selected.status}
            </StatusPill>
          </div>
          <div className="graph-node-detail-meta">
            <span>{selected.effectType}</span>
            <span>attempt {selected.attempt}</span>
            <span>{formatTime(selected.startedAtMs)}</span>
            {selected.artifactBacked ? <span>artifact backed</span> : null}
          </div>
          <div className="graph-deps">
            {selected.dependsOn.length === 0 ? (
              <span className="muted">root node</span>
            ) : (
              selected.dependsOn.map((dep) => (
                <span className="dep-pill mono" key={dep}>
                  {dep}
                </span>
              ))
            )}
          </div>
        </div>
      ) : (
        <div className="graph-hint muted">
          Select a node to inspect its status and dependencies.
        </div>
      )}
    </div>
  );
}

export function NodeTimeline({ nodes }: { nodes: NodeView[] }) {
  if (nodes.length === 0) {
    return <div className="table-empty">No projected nodes are available.</div>;
  }

  return (
    <ol className="node-timeline" aria-label="Node timeline">
      {sortNodes(nodes).map((node) => (
        <li className="node-timeline-item" key={`${node.stableKey}:${node.attempt}`}>
          <span className={`timeline-dot dot-${toneForStatus(node.status)}`} />
          <div className="node-timeline-body">
            <div className="node-timeline-main">
              <span className="mono">{node.stableKey}</span>
              <StatusPill tone={toneForStatus(node.status)}>{node.status}</StatusPill>
            </div>
            <div className="node-timeline-meta">
              <span>{formatTime(node.startedAtMs)}</span>
              <span>{node.effectType}</span>
              <span>attempt {node.attempt}</span>
              {node.artifactBacked ? <span>artifact backed</span> : null}
            </div>
            <div className="graph-deps">
              {node.dependsOn.length === 0
                ? "root"
                : node.dependsOn.map((dep) => (
                    <span className="dep-pill mono" key={dep}>
                      {dep}
                    </span>
                  ))}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function placeNodes(nodes: NodeView[]): { placed: PlacedNode[]; width: number; height: number } {
  const byKey = new Map(nodes.map((node) => [node.stableKey, node]));
  const levelMemo = new Map<string, number>();
  const visiting = new Set<string>();

  const levelFor = (node: NodeView): number => {
    const existing = levelMemo.get(node.stableKey);
    if (existing !== undefined) return existing;
    if (visiting.has(node.stableKey)) return 0;
    visiting.add(node.stableKey);
    const level =
      node.dependsOn.length === 0
        ? 0
        : Math.max(
            0,
            ...node.dependsOn.map((dep) => {
              const parent = byKey.get(dep);
              return parent ? levelFor(parent) + 1 : 0;
            }),
          );
    visiting.delete(node.stableKey);
    levelMemo.set(node.stableKey, level);
    return level;
  };

  const rowByLevel = new Map<number, number>();
  let maxLevel = 0;
  let maxRows = 1;
  const placed = sortNodes(nodes).map((node) => {
    const level = levelFor(node);
    const row = rowByLevel.get(level) ?? 0;
    rowByLevel.set(level, row + 1);
    maxLevel = Math.max(maxLevel, level);
    maxRows = Math.max(maxRows, row + 1);
    return {
      node,
      x: PAD + level * (NODE_W + GAP_X),
      y: PAD + row * (NODE_H + GAP_Y),
    };
  });

  const width = PAD * 2 + (maxLevel + 1) * NODE_W + maxLevel * GAP_X;
  const height = PAD * 2 + maxRows * NODE_H + (maxRows - 1) * GAP_Y;
  return { placed, width, height };
}

function edgePath(a: PlacedNode, b: PlacedNode): string {
  const crossRow = Math.abs(b.y - a.y) > NODE_H + 4;
  if (crossRow) {
    const down = b.y > a.y;
    const sx = a.x + NODE_W / 2;
    const sy = down ? a.y + NODE_H : a.y;
    const tx = b.x + NODE_W / 2;
    const ty = down ? b.y : b.y + NODE_H;
    const dy = ty - sy;
    return `M${sx},${sy} C${sx},${sy + dy * 0.45} ${tx},${ty - dy * 0.45} ${tx},${ty}`;
  }
  const sx = a.x + NODE_W;
  const sy = a.y + NODE_H / 2;
  const tx = b.x;
  const ty = b.y + NODE_H / 2;
  const dx = tx - sx;
  return `M${sx},${sy} C${sx + dx * 0.45},${sy} ${tx - dx * 0.45},${ty} ${tx},${ty}`;
}

function sortNodes(nodes: NodeView[]): NodeView[] {
  return nodes.slice().sort((a, b) => {
    const timeA = a.startedAtMs ?? Number.MAX_SAFE_INTEGER;
    const timeB = b.startedAtMs ?? Number.MAX_SAFE_INTEGER;
    if (timeA !== timeB) return timeA - timeB;
    return a.stableKey.localeCompare(b.stableKey);
  });
}
