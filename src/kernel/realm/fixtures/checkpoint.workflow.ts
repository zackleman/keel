import { type Ctx, passthrough } from "@kcosr/keel";

const bool = passthrough<boolean>();

export default async function checkpointWorkflow(ctx: Ctx): Promise<boolean> {
  await ctx.checkpoint({
    key: "checkpoint.first",
    message: "Started work",
    data: { completed: 1, total: 2 },
  });
  await ctx.checkpoint({ key: "checkpoint.second", message: "Finished work" });
  return await ctx.step("after-checkpoints", bool, true, (value) => value);
}
