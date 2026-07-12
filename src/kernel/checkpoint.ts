import { type Json, hashJson } from "../hash.ts";

export const CHECKPOINT_ABI = 1;

export interface CheckpointSpec {
  key: string;
  message: string;
  data?: Json;
}

export interface NormalizedCheckpoint {
  stableKey: string;
  message: string;
  data: Json;
  identity: Json;
  result: { message: string; data: Json };
}

export function normalizeCheckpoint(value: unknown, path = "ctx.checkpoint"): NormalizedCheckpoint {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} spec must be a plain object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) {
    throw new Error(`${path} spec must be a plain object`);
  }
  const raw = value as Record<string, unknown>;
  const unsupported = Reflect.ownKeys(raw).filter(
    (key) => typeof key !== "string" || !["key", "message", "data"].includes(key),
  );
  if (unsupported.length > 0) {
    throw new Error(`${path} contains unsupported field ${String(unsupported[0])}`);
  }
  if (typeof raw.key !== "string" || raw.key.trim().length === 0) {
    throw new Error(`${path}.key must be a non-empty string`);
  }
  if (typeof raw.message !== "string" || raw.message.trim().length === 0) {
    throw new Error(`${path}.message must be a non-empty string`);
  }
  const data = raw.data === undefined ? null : raw.data;
  hashJson(data);

  const result = { message: raw.message, data: data as Json };
  return {
    stableKey: raw.key,
    ...result,
    identity: result,
    result,
  };
}

export function checkpointVersionIdentity(): Json {
  return { kind: "checkpoint", abi: CHECKPOINT_ABI };
}
