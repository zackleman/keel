// Top-down flow layout for the workflow "Flow" view. Turns the static
// operation/container IR (parsed server-side from the workflow source) into
// placed nodes + edges our SVG renderer draws, and overlays runtime status from
// the journal projection. Parser-independent: it only consumes the IR shape.

import type { NodeView, WorkflowFlowOperation, WorkflowFlowView } from "../api/types";
import type { Tone } from "../components/controls";
import type {
  FlowRuntimeOverride,
  FlowRuntimeOverrides,
  FlowRuntimeState,
} from "./workflow-flow-live";

export const NODE_W = 216;
export const NODE_H = 54;
export const PHASE_H = 34;
export const GATE_H = 46;
export const FAN_H = 24;
const V_GAP = 30;
const H_GAP = 26;
const PAD = 26;

export type FlowNodeKind = "op" | "phase" | "branch" | "fanout" | "join";

export interface FlowNode {
  id: string;
  kind: FlowNodeKind;
  op?: WorkflowFlowOperation;
  label: string;
  meta?: string;
  tone: Tone;
  x: number;
  y: number;
  w: number;
  h: number;
  count?: number;
  matched: boolean;
  state?: FlowRuntimeState;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  kind: "seq" | "skip" | "repeat" | "fan";
}

export interface FlowLayout {
  nodes: FlowNode[];
  edges: FlowEdge[];
  width: number;
  height: number;
}

interface Runtime {
  nodes: NodeView[];
  phase: string | null;
  finished: boolean;
  overrides?: FlowRuntimeOverrides;
}

interface Segment {
  start: number;
  end: number;
}

export function layoutFlow(flow: WorkflowFlowView, runtime: Runtime): FlowLayout {
  const ops = flow.operations;
  const parallel = segments(ops, (op) => op.containers.includes("parallel"));
  const branch = segments(ops, (op) => op.containers.includes("branch"));
  const loops = segments(ops, isLoopOp).filter((seg) => !inAnySegment(parallel, seg.start));

  const phaseOrder = ops.filter((op) => op.kind === "phase").map((op) => phaseTitle(op));
  const currentPhaseIdx = runtime.phase ? phaseOrder.indexOf(runtime.phase) : -1;

  const maxSiblings = Math.max(1, ...parallel.map((seg) => parallelBreadth(ops, seg)));
  const width = PAD * 2 + maxSiblings * NODE_W + (maxSiblings - 1) * H_GAP;
  const centerX = width / 2;

  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  let y = PAD;
  let prevId: string | null = null;
  let pendingSkipFrom: string | null = null;
  let edgeSeq = 0;
  const link = (from: string | null, to: string, kind: FlowEdge["kind"]) => {
    if (from) edges.push({ id: `e${edgeSeq++}`, from, to, kind });
  };
  const settlePrev = (id: string) => {
    link(prevId, id, "seq");
    if (pendingSkipFrom) {
      edges.push({ id: `e${edgeSeq++}`, from: pendingSkipFrom, to: id, kind: "skip" });
      pendingSkipFrom = null;
    }
  };

  let i = 0;
  while (i < ops.length) {
    const pseg = parallel.find((seg) => seg.start === i);
    const bseg = branch.find((seg) => seg.start === i);

    if (pseg) {
      const fanId = `fanout_${i}`;
      const cx = centerX;
      nodes.push(fanNode(fanId, "fanout", "parallel fan-out", cx, y));
      settlePrev(fanId);
      y += FAN_H + V_GAP;
      const segOps = ops.slice(pseg.start, pseg.end + 1);
      const lanes = deterministicParallelLanes(segOps);
      const tails: string[] = [];
      if (lanes) {
        const totalW = lanes.length * NODE_W + (lanes.length - 1) * H_GAP;
        let x = centerX - totalW / 2;
        let maxLaneH = 0;
        for (const lane of lanes) {
          let laneY = y;
          let first: string | null = null;
          let last: string | null = null;
          for (const op of lane) {
            const node = opNode(op, x, laneY, runtime, phaseOrder, currentPhaseIdx);
            nodes.push(node);
            if (!first) first = node.id;
            if (last) link(last, node.id, "seq");
            last = node.id;
            laneY += NODE_H + V_GAP;
          }
          if (first) link(fanId, first, "fan");
          if (last) tails.push(last);
          maxLaneH = Math.max(maxLaneH, laneStackHeight(lane));
          x += NODE_W + H_GAP;
        }
        y += maxLaneH + V_GAP;
      } else {
        const totalW = segOps.length * NODE_W + (segOps.length - 1) * H_GAP;
        let x = centerX - totalW / 2;
        for (const op of segOps) {
          const node = opNode(op, x, y, runtime, phaseOrder, currentPhaseIdx);
          nodes.push(node);
          tails.push(node.id);
          link(fanId, node.id, "fan");
          x += NODE_W + H_GAP;
        }
        y += NODE_H + V_GAP;
      }
      const joinId = `join_${i}`;
      nodes.push(fanNode(joinId, "join", "join", cx, y));
      for (const id of tails) link(id, joinId, "fan");
      y += FAN_H + V_GAP;
      prevId = joinId;
      i = pseg.end + 1;
      continue;
    }

    if (bseg) {
      const gateId = `branch_${i}`;
      nodes.push({
        id: gateId,
        kind: "branch",
        label: conditionLabel(ops, bseg),
        tone: "info",
        x: centerX - NODE_W / 2,
        y,
        w: NODE_W,
        h: GATE_H,
        matched: false,
      });
      settlePrev(gateId);
      y += GATE_H + V_GAP;
      const segOps = ops.slice(bseg.start, bseg.end + 1);
      let first: string | null = null;
      let last: string | null = null;
      for (const segOp of segOps) {
        const node = opNode(segOp, centerX - NODE_W / 2, y, runtime, phaseOrder, currentPhaseIdx);
        nodes.push(node);
        if (!first) first = node.id;
        if (last) link(last, node.id, "seq");
        last = node.id;
        y += NODE_H + V_GAP;
      }
      if (first) link(gateId, first, "seq");
      pendingSkipFrom = gateId; // skip edge resolves to the next placed node
      prevId = last;
      i = bseg.end + 1;
      continue;
    }

    const op = ops[i];
    if (!op) {
      i += 1;
      continue;
    }
    if (op.kind === "phase") {
      const id = op.id;
      const state = phaseState(phaseTitle(op), phaseOrder, currentPhaseIdx, runtime.finished);
      nodes.push({
        id,
        kind: "phase",
        op,
        label: phaseTitle(op),
        tone: toneForRuntimeState(state),
        x: PAD,
        y,
        w: width - PAD * 2,
        h: PHASE_H,
        matched: state !== "not-started",
        state,
      });
      settlePrev(id);
      prevId = id;
      y += PHASE_H + V_GAP;
      i += 1;
      continue;
    }

    const node = opNode(op, centerX - NODE_W / 2, y, runtime, phaseOrder, currentPhaseIdx);
    nodes.push(node);
    settlePrev(node.id);
    prevId = node.id;
    y += NODE_H + V_GAP;
    i += 1;
  }

  for (const seg of loops) {
    const firstOp = ops[seg.start];
    const lastOp = lastNonReturn(ops, seg);
    if (firstOp && lastOp) {
      edges.push({ id: `e${edgeSeq++}`, from: lastOp.id, to: firstOp.id, kind: "repeat" });
    }
  }

  return { nodes, edges, width, height: y - V_GAP + PAD };
}

function opNode(
  op: WorkflowFlowOperation,
  x: number,
  y: number,
  runtime: Runtime,
  phaseOrder: string[],
  currentPhaseIdx: number,
): FlowNode {
  const match = matchOp(op, runtime, phaseOrder, currentPhaseIdx);
  return {
    id: op.id,
    kind: "op",
    op,
    label: opLabel(op),
    meta: opMeta(op, match.count),
    tone: match.tone,
    x,
    y,
    w: NODE_W,
    h: NODE_H,
    count: match.count,
    matched: match.matched,
    state: match.state,
  };
}

function fanNode(id: string, kind: FlowNodeKind, label: string, cx: number, y: number): FlowNode {
  const w = 132;
  return { id, kind, label, tone: "neutral", x: cx - w / 2, y, w, h: FAN_H, matched: false };
}

interface OpMatch {
  tone: Tone;
  count: number;
  matched: boolean;
  state: FlowRuntimeState;
}

function matchOp(
  op: WorkflowFlowOperation,
  runtime: Runtime,
  phaseOrder: string[],
  currentPhaseIdx: number,
): OpMatch {
  if (op.kind === "phase") {
    return {
      tone: toneForRuntimeState(
        phaseState(phaseTitle(op), phaseOrder, currentPhaseIdx, runtime.finished),
      ),
      count: 0,
      matched: true,
      state: phaseState(phaseTitle(op), phaseOrder, currentPhaseIdx, runtime.finished),
    };
  }
  if (op.kind === "return") {
    return {
      tone: runtime.finished ? "success" : "neutral",
      count: 0,
      matched: runtime.finished,
      state: runtime.finished ? "completed" : "not-started",
    };
  }
  const live = matchingOverride(op, runtime.overrides);
  if (live) {
    return {
      tone: toneForRuntimeState(live.state),
      count: live.count,
      matched: true,
      state: live.state,
    };
  }
  const matches = matchingNodes(op, runtime.nodes);
  if (matches.length === 0) {
    return { tone: "neutral", count: 0, matched: false, state: "not-started" };
  }
  const state = aggregateState(matches);
  return { tone: toneForRuntimeState(state), count: matches.length, matched: true, state };
}

function matchingOverride(
  op: WorkflowFlowOperation,
  overrides: FlowRuntimeOverrides | undefined,
): (FlowRuntimeOverride & { count: number }) | null {
  if (!overrides || overrides.size === 0) return null;
  const literal = staticKey(op);
  if (literal) {
    const exact = overrides.get(literal);
    if (exact) return { ...exact, count: 1 };
  }
  const prefix = keyPrefix(op);
  if (!prefix) return null;
  const matches = [...overrides.entries()].filter(
    ([key]) =>
      key === prefix ||
      key.startsWith(`${prefix}:`) ||
      key.startsWith(`${prefix}-`) ||
      key.startsWith(`${prefix}.`),
  );
  if (matches.length === 0) return null;
  return { ...aggregateOverrides(matches.map(([, override]) => override)), count: matches.length };
}

function matchingNodes(op: WorkflowFlowOperation, nodes: NodeView[]): NodeView[] {
  const literal = staticKey(op);
  if (literal) {
    const exact = nodes.filter((node) => node.stableKey === literal);
    if (exact.length > 0) return exact;
  }
  const prefix = keyPrefix(op);
  if (prefix) {
    return nodes.filter(
      (node) =>
        node.stableKey === prefix ||
        node.stableKey.startsWith(`${prefix}:`) ||
        node.stableKey.startsWith(`${prefix}-`) ||
        node.stableKey.startsWith(`${prefix}.`),
    );
  }
  return [];
}

function staticKey(op: WorkflowFlowOperation): string | null {
  if (op.key?.static && typeof op.key.value === "string") return op.key.value;
  return null;
}

function keyPrefix(op: WorkflowFlowOperation): string | null {
  const text = op.key?.text;
  if (!text) return null;
  const literal = text.match(/["'`]([^"'`]+)["'`]/);
  return literal?.[1] ?? null;
}

function aggregateState(nodes: NodeView[]): FlowRuntimeState {
  if (nodes.some((node) => node.status === "failed")) return "failed";
  if (nodes.every((node) => node.status === "completed")) return "completed";
  if (nodes.some((node) => String(node.status).startsWith("waiting"))) return "blocked";
  return "running";
}

function aggregateOverrides(overrides: FlowRuntimeOverride[]): FlowRuntimeOverride {
  if (overrides.some((override) => override.state === "failed")) return { state: "failed" };
  const blocked = overrides.find((override) => override.state === "blocked");
  if (blocked) return blocked;
  if (overrides.some((override) => override.state === "running")) return { state: "running" };
  if (overrides.every((override) => override.state === "completed")) return { state: "completed" };
  return { state: "not-started" };
}

function toneForRuntimeState(state: FlowRuntimeState): Tone {
  switch (state) {
    case "completed":
      return "success";
    case "running":
      return "running";
    case "blocked":
      return "waiting";
    case "failed":
      return "failed";
    default:
      return "neutral";
  }
}

function phaseState(
  title: string,
  order: string[],
  currentIdx: number,
  finished: boolean,
): FlowRuntimeState {
  if (finished) return "completed";
  if (currentIdx < 0) return "not-started";
  const idx = order.indexOf(title);
  if (idx < currentIdx) return "completed";
  if (idx === currentIdx) return "running";
  return "not-started";
}

function summaryText(expr?: { value?: unknown; text?: string }): string | undefined {
  return (typeof expr?.value === "string" ? expr.value : undefined) ?? expr?.text ?? undefined;
}

function opLabel(op: WorkflowFlowOperation): string {
  if (op.kind === "return") return "return";
  if (op.kind === "checkpoint") {
    return summaryText(op.message) ?? summaryText(op.key) ?? "checkpoint";
  }
  if (op.kind === "drainSignals") {
    return summaryText(op.signalName) ?? summaryText(op.key) ?? "drainSignals";
  }
  if (op.kind === "stateSet") {
    const ns = summaryText(op.namespace);
    const name = summaryText(op.stateName);
    if (ns && name) return `${ns}.${name}`;
    return name ?? ns ?? summaryText(op.key) ?? "stateSet";
  }
  if (op.kind === "spawn") {
    return summaryText(op.workflowRef) ?? summaryText(op.key) ?? "spawn";
  }
  return summaryText(op.title ?? op.key) ?? op.kind;
}

function opMeta(op: WorkflowFlowOperation, count: number): string {
  const bits: string[] = [op.kind];
  if (op.containers.some((c) => c.includes("loop"))) bits.push("loop");
  else if (op.containers.includes("parallel")) bits.push("parallel");
  if (count > 1) bits.push(`×${count}`);
  if (op.provider?.value && typeof op.provider.value === "string")
    bits.push(String(op.provider.value));
  return bits.join(" · ");
}

function conditionLabel(ops: WorkflowFlowOperation[], seg: Segment): string {
  for (let i = seg.start; i <= seg.end; i++) {
    const condition = ops[i]?.condition;
    if (condition?.text) {
      const text = condition.text.length > 40 ? `${condition.text.slice(0, 37)}…` : condition.text;
      return `${text}?`;
    }
  }
  return "branch?";
}

function phaseTitle(op: WorkflowFlowOperation): string {
  return (
    (typeof op.title?.value === "string" ? op.title.value : undefined) ?? op.title?.text ?? "phase"
  );
}

function isLoopOp(op: WorkflowFlowOperation): boolean {
  return op.containers.some(
    (c) => c === "loop" || c.includes("map loop") || c.includes("forEach loop"),
  );
}

function deterministicParallelLanes(
  ops: WorkflowFlowOperation[],
): WorkflowFlowOperation[][] | null {
  const groups = new Map<number, WorkflowFlowOperation[]>();
  for (const op of ops) {
    const lane = op.parallelLane;
    if (typeof lane !== "number" || !Number.isInteger(lane) || lane < 0) return null;
    const group = groups.get(lane);
    if (group) group.push(op);
    else groups.set(lane, [op]);
  }
  if (groups.size === 0) return null;
  return [...groups.entries()].sort(([a], [b]) => a - b).map(([, laneOps]) => laneOps);
}

function parallelBreadth(ops: WorkflowFlowOperation[], seg: Segment): number {
  const segOps = ops.slice(seg.start, seg.end + 1);
  return deterministicParallelLanes(segOps)?.length ?? segOps.length;
}

function laneStackHeight(ops: WorkflowFlowOperation[]): number {
  if (ops.length === 0) return 0;
  return ops.length * NODE_H + (ops.length - 1) * V_GAP;
}

function segments(
  ops: WorkflowFlowOperation[],
  predicate: (op: WorkflowFlowOperation) => boolean,
): Segment[] {
  const out: Segment[] = [];
  let start: number | null = null;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op && predicate(op)) {
      if (start === null) start = i;
    } else if (start !== null) {
      out.push({ start, end: i - 1 });
      start = null;
    }
  }
  if (start !== null) out.push({ start, end: ops.length - 1 });
  return out;
}

function inAnySegment(segs: Segment[], index: number): boolean {
  return segs.some((seg) => index >= seg.start && index <= seg.end);
}

function lastNonReturn(ops: WorkflowFlowOperation[], seg: Segment): WorkflowFlowOperation | null {
  for (let i = seg.end; i >= seg.start; i--) {
    const op = ops[i];
    if (op && op.kind !== "return") return op;
  }
  return null;
}

// re-export for the renderer
export type { WorkflowFlowOperation };
