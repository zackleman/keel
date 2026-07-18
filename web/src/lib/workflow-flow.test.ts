import { describe, expect, test } from "vitest";
import type { NodeView, WorkflowFlowOperation, WorkflowFlowView } from "../api/types";
import { layoutFlow } from "./workflow-flow";
import type { FlowRuntimeOverrides } from "./workflow-flow-live";

function op(
  id: string,
  parallelLane = 0,
  kind: WorkflowFlowOperation["kind"] = "step",
): WorkflowFlowOperation {
  return {
    id,
    kind,
    key: { kind: "literal", text: `"${id}"`, static: true, value: id },
    containers: ["parallel"],
    parallelLane,
  };
}

describe("layoutFlow", () => {
  test("stacks deterministic Promise.all lanes before joining", () => {
    const flow: WorkflowFlowView = {
      entry: { name: null, async: true, params: [] },
      input: null,
      diagnostics: [],
      operations: [
        op("proposal", 0),
        op("approve-proposal", 0),
        op("review", 1),
        op("approve-review", 1),
      ],
    };

    const layout = layoutFlow(flow, { nodes: [], phase: null, finished: false });
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));

    expect(byId.get("proposal")?.x).toBe(byId.get("approve-proposal")?.x);
    expect(byId.get("review")?.x).toBe(byId.get("approve-review")?.x);
    expect(byId.get("proposal")?.x).not.toBe(byId.get("review")?.x);
    expect(byId.get("approve-proposal")?.y).toBeGreaterThan(byId.get("proposal")?.y ?? 0);
    expect(byId.get("approve-review")?.y).toBeGreaterThan(byId.get("review")?.y ?? 0);

    const join = layout.nodes.find((node) => node.kind === "join");
    expect(join?.y).toBeGreaterThan(byId.get("approve-proposal")?.y ?? 0);
    expect(join?.y).toBeGreaterThan(byId.get("approve-review")?.y ?? 0);
    expect(layout.edges).toContainEqual(
      expect.objectContaining({ from: "proposal", to: "approve-proposal", kind: "seq" }),
    );
    expect(layout.edges).toContainEqual(
      expect.objectContaining({ from: "review", to: "approve-review", kind: "seq" }),
    );
  });

  test("uses live runtime overrides before projection nodes are refreshed", () => {
    const flow: WorkflowFlowView = {
      entry: { name: null, async: true, params: [] },
      input: null,
      diagnostics: [],
      operations: [op("proposal", 0, "agent"), op("approve-proposal", 0, "human")],
    };
    const overrides: FlowRuntimeOverrides = new Map([
      ["proposal", { state: "running" }],
      ["approve-proposal", { state: "blocked", reason: "human" }],
    ]);

    const layout = layoutFlow(flow, { nodes: [], phase: null, finished: false, overrides });
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));

    expect(byId.get("proposal")).toMatchObject({
      tone: "running",
      matched: true,
      state: "running",
    });
    expect(byId.get("approve-proposal")).toMatchObject({
      tone: "waiting",
      matched: true,
      state: "blocked",
    });
  });

  test("marks current phase running and prior phases completed from live phase", () => {
    const flow: WorkflowFlowView = {
      entry: { name: null, async: true, params: [] },
      input: null,
      diagnostics: [],
      operations: [
        phase("parallel inputs"),
        op("proposal"),
        phase("synthesis"),
        op("merge"),
        phase("approval"),
      ],
    };

    const layout = layoutFlow(flow, { nodes: [], phase: "synthesis", finished: false });
    const byId = new Map(layout.nodes.map((node) => [node.id, node]));

    expect(byId.get("phase-parallel-inputs")).toMatchObject({
      tone: "success",
      state: "completed",
    });
    expect(byId.get("phase-synthesis")).toMatchObject({
      tone: "running",
      state: "running",
    });
    expect(byId.get("phase-approval")).toMatchObject({
      tone: "neutral",
      state: "not-started",
    });
  });

  test("treats pending projection nodes as running when keyed to an operation", () => {
    const flow: WorkflowFlowView = {
      entry: { name: null, async: true, params: [] },
      input: null,
      diagnostics: [],
      operations: [op("proposal")],
    };
    const nodes: NodeView[] = [
      {
        stableKey: "proposal",
        effectType: "effectful",
        status: "pending",
        attempt: 1,
        startedAtMs: 10,
        dependsOn: [],
        artifactBacked: false,
        checkpoint: null,
      },
    ];

    const layout = layoutFlow(flow, { nodes, phase: null, finished: false });

    expect(layout.nodes.find((node) => node.id === "proposal")).toMatchObject({
      tone: "running",
      matched: true,
      state: "running",
    });
  });
});

function stateNode(stableKey: string): NodeView {
  return {
    stableKey,
    effectType: "state_write",
    status: "completed",
    attempt: 1,
    startedAtMs: 10,
    dependsOn: [],
    artifactBacked: false,
    checkpoint: null,
  };
}

describe("layoutFlow new ctx ops", () => {
  test("aggregates runtime nodes for a stateSet op via stepKey prefix matching", () => {
    const flow: WorkflowFlowView = {
      entry: { name: null, async: true, params: [] },
      input: null,
      diagnostics: [],
      operations: [
        {
          id: "state_1",
          kind: "stateSet",
          key: { kind: "literal", text: '"counter"', static: true, value: "counter" },
          namespace: { kind: "literal", text: '"counters"', static: true, value: "counters" },
          stateName: { kind: "literal", text: '"processed"', static: true, value: "processed" },
          containers: ["loop"],
        },
      ],
    };
    // Fan-out writes journal one node per iteration under a shared prefix.
    const nodes: NodeView[] = [stateNode("counter:a"), stateNode("counter:b")];

    const layout = layoutFlow(flow, { nodes, phase: null, finished: false });
    const node = layout.nodes.find((candidate) => candidate.id === "state_1");

    expect(node).toMatchObject({
      matched: true,
      count: 2,
      state: "completed",
      tone: "success",
      label: "counters.processed",
    });
  });
});

function phase(title: string): WorkflowFlowOperation {
  return {
    id: `phase-${title.replaceAll(" ", "-")}`,
    kind: "phase",
    title: { kind: "literal", text: `"${title}"`, static: true, value: title },
    containers: [],
  };
}
