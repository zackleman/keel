import type { Ctx } from "@kcosr/keel";

export default async function spawnChild(_ctx: Ctx, input: { value: number }): Promise<number> {
  return input.value * 2;
}
