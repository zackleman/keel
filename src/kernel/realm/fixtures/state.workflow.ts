import { type Ctx, jsonSchema } from "@kcosr/keel";

const NumberSchema = jsonSchema<number>({ type: "number" });
const NumbersSchema = jsonSchema<number[]>({ type: "array", items: { type: "number" } });

export default async function stateWorkflow(ctx: Ctx) {
  const research = ctx.state<{ count: number; history: number[] }>("research", {
    count: NumberSchema,
    history: NumbersSchema,
  });
  const auxiliary = ctx.state<{ count: number }>("auxiliary", { count: NumberSchema });
  const before = research.get("count");
  await research.set({ key: "state.count.init", name: "count", value: 0 });
  await research.set({ key: "state.history.init", name: "history", value: [] });
  await auxiliary.set({ key: "state.aux.init", name: "count", value: 99 });
  for (let i = 1; i <= 3; i++) {
    await research.set({ key: ctx.stepKey("state.count", String(i)), name: "count", value: i });
    const history = research.get("history");
    if (!history) throw new Error("history state was not initialized");
    await research.set({
      key: ctx.stepKey("state.history", String(i)),
      name: "history",
      value: [...history, i],
    });
  }
  return { before: before ?? null, research: research.snapshot(), auxiliary: auxiliary.snapshot() };
}
