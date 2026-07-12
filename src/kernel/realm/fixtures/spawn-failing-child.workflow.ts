import type { Ctx } from "@kcosr/keel";

export default async function spawnFailingChild(_ctx: Ctx): Promise<never> {
  throw new Error("child failed intentionally");
}
