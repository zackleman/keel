import { createHash, randomBytes } from "node:crypto";
import { canonicalJson } from "../hash.ts";
import type { JournalStore } from "../journal/store.ts";
import type { CapabilityRow } from "../journal/types.ts";

export type CapabilityResource =
  | { kind: "run"; runId: string }
  | { kind: "workflow"; name: string; version?: number }
  | { kind: "daemon" };

export type CapabilityAction =
  | "run:read"
  | "run:source"
  | "run:watch"
  | "run:events"
  | "run:output"
  | "run:resume"
  | "run:interrupt"
  | "run:retry"
  | "run:rewind"
  | "run:fork"
  | "run:signal"
  | "run:cancel"
  | "workflow:read"
  | "workflow:run"
  | "workflow:save"
  | "admin";

export interface AuthorizationRequest {
  action: CapabilityAction;
  resource: CapabilityResource;
}

export class AuthorizationError extends Error {
  readonly code = "permission_denied";
  constructor(
    message: string,
    readonly request: AuthorizationRequest,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export const DEFAULT_RUN_CAPABILITY_ACTIONS: readonly CapabilityAction[] = [
  "run:read",
  "run:source",
  "run:watch",
  "run:events",
  "run:output",
  "run:resume",
  "run:interrupt",
  "run:retry",
  "run:rewind",
  "run:fork",
  "run:signal",
];

export function issueRunCapability(
  store: JournalStore,
  runId: string,
  atMs: number,
  opts: {
    expiresAtMs?: number | null;
    note?: string | null;
    actions?: readonly CapabilityAction[];
  } = {},
): { capabilityId: string; token: string } {
  const actions = opts.actions ?? DEFAULT_RUN_CAPABILITY_ACTIONS;
  for (const action of actions) {
    if (!DEFAULT_RUN_CAPABILITY_ACTIONS.includes(action)) {
      throw new Error(`run capability cannot grant ${action}`);
    }
  }
  return putCapability(store, {
    prefix: "kc_run",
    resource: { kind: "run", runId },
    actions: [...actions],
    atMs,
    expiresAtMs: opts.expiresAtMs ?? null,
    note: opts.note ?? `run ${runId}`,
  });
}

export function ensureAdminCapability(store: JournalStore, token: string, atMs: number): void {
  const secretHash = hashCapabilityToken(token);
  if (store.getCapabilityByHash(secretHash)) return;
  store.putCapability({
    id: `cap_admin_${shortHash(token)}`,
    secretHash,
    resourceJson: canonicalJson({ kind: "daemon" } satisfies CapabilityResource),
    actionsJson: canonicalJson(["admin"] satisfies CapabilityAction[]),
    createdAtMs: atMs,
    expiresAtMs: null,
    revokedAtMs: null,
    note: "daemon admin bootstrap",
  });
}

export function authorize(
  store: JournalStore,
  credential: string | null,
  request: AuthorizationRequest,
  nowMs: number,
): CapabilityRow {
  if (!credential) {
    throw denied("no capability presented", request);
  }
  const row = store.getCapabilityByHash(hashCapabilityToken(credential));
  if (!row) throw denied("capability is invalid", request);
  if (row.revokedAtMs !== null) throw denied("capability has been revoked", request);
  if (row.expiresAtMs !== null && row.expiresAtMs <= nowMs) {
    throw denied("capability has expired", request);
  }

  const resource = JSON.parse(row.resourceJson) as CapabilityResource;
  const actions = JSON.parse(row.actionsJson) as CapabilityAction[];
  if (resource.kind === "daemon" && actions.includes("admin")) return row;
  if (!actions.includes(request.action)) {
    throw denied(`capability does not grant ${request.action}`, request);
  }
  if (!sameResource(resource, request.resource)) {
    throw denied("capability is scoped to a different resource", request);
  }
  return row;
}

export function hashCapabilityToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function putCapability(
  store: JournalStore,
  input: {
    prefix: "kc_run";
    resource: CapabilityResource;
    actions: CapabilityAction[];
    atMs: number;
    expiresAtMs: number | null;
    note: string | null;
  },
): { capabilityId: string; token: string } {
  const token = `${input.prefix}_${randomBytes(32).toString("base64url")}`;
  const capabilityId = `cap_${randomBytes(12).toString("base64url")}`;
  store.putCapability({
    id: capabilityId,
    secretHash: hashCapabilityToken(token),
    resourceJson: canonicalJson(input.resource),
    actionsJson: canonicalJson(input.actions),
    createdAtMs: input.atMs,
    expiresAtMs: input.expiresAtMs,
    revokedAtMs: null,
    note: input.note,
  });
  return { capabilityId, token };
}

function sameResource(a: CapabilityResource, b: CapabilityResource): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "daemon":
      return true;
    case "run":
      return b.kind === "run" && a.runId === b.runId;
    case "workflow":
      return (
        b.kind === "workflow" &&
        a.name === b.name &&
        (a.version === undefined || (b.version !== undefined && a.version === b.version))
      );
  }
}

function denied(message: string, request: AuthorizationRequest): AuthorizationError {
  const resource =
    request.resource.kind === "run" ? `run ${request.resource.runId}` : request.resource.kind;
  return new AuthorizationError(
    `${message}; ${request.action} on ${resource} is not authorized`,
    request,
  );
}

function shortHash(token: string): string {
  return hashCapabilityToken(token).slice(0, 16);
}
