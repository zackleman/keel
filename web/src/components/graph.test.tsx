import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { EffectType, NodeView } from "../api/types";
import { RunGraph } from "./graph";

const EFFECT_TYPE_FIXTURES = {
  pure: true,
  effectful: true,
  command: true,
  completion_check: true,
  checkpoint: true,
  drain_signals: true,
  state_write: true,
  spawn: true,
  wait_run: true,
  workspace_setup: true,
  ambient: true,
} satisfies Record<EffectType, true>;

describe("RunGraph", () => {
  afterEach(cleanup);

  test("renders every shared effect type with a graph icon", () => {
    const nodes = (Object.keys(EFFECT_TYPE_FIXTURES) as EffectType[]).map((effectType, index) =>
      node(effectType, index),
    );

    render(<RunGraph nodes={nodes} />);

    for (const effectType of Object.keys(EFFECT_TYPE_FIXTURES) as EffectType[]) {
      expect(screen.getByText(`${effectType} · completed`)).toBeInTheDocument();
    }
  });
});

function node(effectType: EffectType, index: number): NodeView {
  return {
    stableKey: `node_${index}`,
    effectType,
    status: "completed",
    attempt: 1,
    startedAtMs: 1_000 + index,
    dependsOn: [],
    artifactBacked: false,
    checkpoint: null,
  };
}
