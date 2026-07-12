import type { ChildRunOutcome, Ctx } from "@kcosr/keel";

export default async function spawnParent(
  ctx: Ctx,
  input: { workflow: string },
): Promise<Array<ChildRunOutcome<number>>> {
  const children = await Promise.all([
    ctx.spawn("spawn-a", { workflow: input.workflow, input: { value: 2 } }),
    ctx.spawn("spawn-b", { workflow: input.workflow, input: { value: 3 } }),
  ]);
  return await Promise.all([
    ctx.waitRun<number>("wait-a", children[0]),
    ctx.waitRun<number>("wait-b", children[1]),
  ]);
}
