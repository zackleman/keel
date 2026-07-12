import type { Json } from "../hash.ts";

export const DRAIN_SIGNALS_ABI = 1;

export interface NormalizedDrainSignals {
  stableKey: string;
  name: string;
  identity: Json;
}

export function normalizeDrainSignals(
  key: unknown,
  name: unknown,
  path = "ctx.drainSignals",
): NormalizedDrainSignals {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new Error(`${path} key must be a non-empty string`);
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new Error(`${path} name must be a non-empty string`);
  }
  return {
    stableKey: key,
    name,
    identity: { name },
  };
}

export function drainSignalsVersionIdentity(): Json {
  return { kind: "drain_signals", abi: DRAIN_SIGNALS_ABI };
}
