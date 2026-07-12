// Mirrors the saved workload except for the final-iteration instruction below.
// Keep other edits synchronized so this fixture isolates suffix invalidation.
import { type Ctx, type HumanDecision, jsonSchema } from "@kcosr/keel";

const Input = jsonSchema<{
  iterations: number;
  cooldownMs: number;
  requireApproval: boolean;
}>({
  type: "object",
  additionalProperties: false,
  required: ["iterations", "cooldownMs", "requireApproval"],
  properties: {
    iterations: { type: "integer", minimum: 1, maximum: 10 },
    cooldownMs: { type: "integer", minimum: 0 },
    requireApproval: { type: "boolean" },
  },
});

const SetupResult = jsonSchema<{ baselineScore: number; hypothesis: string }>({
  type: "object",
  additionalProperties: false,
  required: ["baselineScore", "hypothesis"],
  properties: {
    baselineScore: { type: "number" },
    hypothesis: { type: "string" },
  },
});

const ExperimentResult = jsonSchema<{ score: number; candidate: string; summary: string }>({
  type: "object",
  additionalProperties: false,
  required: ["score", "candidate", "summary"],
  properties: {
    score: { type: "number" },
    candidate: { type: "string" },
    summary: { type: "string" },
  },
});

const RecorderResult = jsonSchema<{ summary: string }>({
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: { summary: { type: "string" } },
});

interface Steer {
  [key: string]: string | number;
  message: string;
}

interface HistoryEntry {
  iteration: number;
  accepted: boolean;
  result: { score: number; candidate: string; summary: string } | null;
  steers: Steer[];
}

export default async function autoresearch(ctx: Ctx, rawInput: unknown) {
  const input = Input.parse(rawInput);
  ctx.phase("Setup");
  const setup = await ctx.agent({
    key: "setup",
    provider: "mock",
    prompt: "Establish a deterministic baseline and one testable optimization hypothesis.",
    schema: SetupResult,
    toolPolicy: "none",
  });

  let best = {
    score: setup.baselineScore,
    candidate: "baseline",
    summary: setup.hypothesis,
  };
  const history: HistoryEntry[] = [];

  ctx.phase("Experiment");
  for (let i = 0; i < input.iterations; i++) {
    const steers = await ctx.drainSignals<Steer>(ctx.stepKey("steer", String(i)), "steer");
    const lateInstruction =
      i === input.iterations - 1 ? "validate the final candidate with a regression-focused protocol" : "explore a candidate";
    const result = await ctx.agent({
      key: ctx.stepKey("experiment", String(i)),
      provider: "mock",
      prompt: [
        `Iteration ${i}: ${lateInstruction}.`,
        `Hypothesis: ${setup.hypothesis}`,
        `Current best: ${JSON.stringify(best)}`,
        `Supervisor steers: ${JSON.stringify(steers)}`,
      ].join("\n"),
      schema: ExperimentResult,
      toolPolicy: "none",
      onFailure: "null",
      maxRetries: 0,
    });

    const accepted = result !== null && result.score > best.score;
    if (accepted) best = result;
    history.push({ iteration: i, accepted, result, steers });

    await ctx.checkpoint({
      key: ctx.stepKey("checkpoint", String(i)),
      message: `iteration ${i}: ${accepted ? "kept" : "reverted"}`,
      data: { iteration: i, accepted, best, result, steers },
    });

    if (i < input.iterations - 1 && input.cooldownMs > 0) {
      await ctx.sleep(ctx.stepKey("cooldown", String(i)), input.cooldownMs);
    }
  }

  ctx.phase("Record");
  const recorder = await ctx.agent({
    key: "recorder",
    provider: "mock",
    prompt: `Record the experiment history and winning candidate.\n${JSON.stringify({ best, history })}`,
    schema: RecorderResult,
    toolPolicy: "none",
  });
  await ctx.checkpoint({
    key: "checkpoint.final",
    message: recorder.summary,
    data: { best, iterations: history.length },
  });

  let approval: HumanDecision | null = null;
  if (input.requireApproval) {
    ctx.phase("Ship");
    approval = await ctx.human({
      key: "ship",
      prompt: `Ship candidate ${best.candidate} at score ${best.score}?`,
    });
  }

  return { best, history, recorder, approval };
}
