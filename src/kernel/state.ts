import { type Json, hashJson } from "../hash.ts";
import type { Schema } from "./schema.ts";

export const STATE_ABI = 1;
export const STATE_NAME_MAX_LENGTH = 128;

export type StateSchemas<S extends Record<string, Json>> = {
  [K in keyof S]?: Schema<S[K]>;
};

export interface StateSetSpec<K extends string, V extends Json> {
  key: string;
  name: K;
  value: V;
}

export interface StateNamespace<S extends Record<string, Json>> {
  set<K extends keyof S & string>(spec: StateSetSpec<K, S[K]>): Promise<void>;
  get<K extends keyof S & string>(name: K): S[K] | undefined;
  snapshot(): Readonly<Partial<S>>;
}

export interface NormalizedStateWrite {
  stableKey: string;
  namespace: string;
  name: string;
  value: Json;
  identity: Json;
  schemaHash: string | null;
}

export function normalizeStateNamespace(value: unknown, path = "ctx.state"): string {
  return normalizeStateName(value, `${path} namespace`);
}

export function normalizeStateWrite<S extends Record<string, Json>>(
  namespace: string,
  schemas: StateSchemas<S> | undefined,
  value: unknown,
  path = "ctx.state.set",
): NormalizedStateWrite {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} spec must be a plain object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) {
    throw new Error(`${path} spec must be a plain object`);
  }
  const raw = value as Record<string, unknown>;
  const unsupported = Reflect.ownKeys(raw).filter(
    (key) => typeof key !== "string" || !["key", "name", "value"].includes(key),
  );
  if (unsupported.length > 0) {
    throw new Error(`${path} contains unsupported field ${String(unsupported[0])}`);
  }
  if (typeof raw.key !== "string" || raw.key.trim().length === 0) {
    throw new Error(`${path}.key must be a non-empty string`);
  }
  const name = normalizeStateName(raw.name, `${path}.name`);
  const schema = schemas?.[name as keyof S];
  const parsed = schema ? schema.parse(raw.value) : raw.value;
  hashJson(parsed);

  const stateValue = parsed as Json;
  return {
    stableKey: raw.key,
    namespace,
    name,
    value: stateValue,
    identity: { namespace, name, value: stateValue },
    schemaHash: schema?.structural ? hashJson(schema.structural()) : null,
  };
}

export function stateVersionIdentity(schemaHash: string | null): Json {
  return { kind: "state_write", abi: STATE_ABI, schema: schemaHash };
}

function normalizeStateName(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  if (value.length > STATE_NAME_MAX_LENGTH) {
    throw new Error(`${path} must be at most ${STATE_NAME_MAX_LENGTH} characters`);
  }
  if (value.startsWith("__")) {
    throw new Error(`${path} must not start with reserved prefix __`);
  }
  return value;
}
