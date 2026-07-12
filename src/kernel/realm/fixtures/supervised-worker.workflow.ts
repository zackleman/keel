import { type Ctx, jsonSchema } from "@kcosr/keel";

const TurnResult = jsonSchema<{ summary: string }>({
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: { summary: { type: "string" } },
});

export default async function supervisedWorker(ctx: Ctx): Promise<string[]> {
  const session = ctx.agentSession({ key: "worker", provider: "session" });
  const summaries: string[] = [];

  for (let i = 0; i < 2; i++) {
    const steers = await ctx.drainSignals<{ message: string }>(
      ctx.stepKey("steer", String(i)),
      "steer",
    );
    const turn = await session.turn({
      key: `turn_${i}`,
      prompt: `Steers: ${JSON.stringify(steers)}`,
      schema: TurnResult,
    });
    summaries.push(turn.summary);
    await ctx.checkpoint({
      key: ctx.stepKey("checkpoint", String(i)),
      message: turn.summary,
      data: { iteration: i },
    });
    if (i === 0) await ctx.signal("next");
  }

  return summaries;
}
