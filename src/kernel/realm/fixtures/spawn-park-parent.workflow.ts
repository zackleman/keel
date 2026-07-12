import type { Ctx } from "@kcosr/keel";

export default async function spawnParkParent(
  ctx: Ctx,
  input: { workflow: string },
): Promise<unknown> {
  const child = await ctx.spawn("spawn-child", {
    workflow: input.workflow,
    input: { value: 5 },
  });
  await ctx.signal("continue-to-wait");
  return await ctx.waitRun("wait-child", child);
}
