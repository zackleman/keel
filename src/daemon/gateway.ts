import { randomUUID } from "node:crypto";
import {
  AuthorizationError,
  type CapabilityAction,
  authorize,
  issueRunCapability,
} from "../auth/capabilities.ts";
import { redactCapabilityTokensInValue } from "../auth/redaction.ts";
import type { JournalStore } from "../journal/store.ts";
import { failRunWithError } from "../kernel/run-errors.ts";
import {
  CapabilityCeilingError,
  DEFAULT_ONE_OFF_RUN_TTL_MS,
  type LaunchAuthority,
  authorityForCeilingProfile,
  preflightSubmissionSource,
} from "../policy/launch-authority.ts";
import type {
  EventCursor,
  EventEnvelope,
  EventStreamFrame,
  RunStart,
  SaveWorkflowRequest,
  SavedWorkflowRef,
  StreamControlFrame,
  SubscribeEventsRequest,
  SubscribeEventsResult,
  WorkflowProvenance,
} from "../rpc/contract.ts";
import {
  cursorAfterSeq,
  normalizeEventCursorInput,
  resolveEventCursor,
} from "../rpc/event-cursor.ts";
import type { InProcessKeel } from "../rpc/in-process.ts";
import { effectiveOperationalSettings } from "../settings/catalog.ts";
import { requireRunTarget } from "../target.ts";
import {
  evictWorkflowDefinitionCache,
  isUnsupportedWorkflowSdkAbiError,
  materializeWorkflowDefinition,
  snapshotWorkflowSource,
} from "../workflow-definitions/snapshot.ts";
import type { WorkflowSourceInput } from "../workflow-definitions/source.ts";

export interface GatewaySession {
  readonly id: string;
  getCredential(): string | null;
  setCredential(token: string | null): void;
  sendEvent(event: GatewayEventFrame): void;
  addCleanup(cleanup: () => void): void;
  removeCleanup(cleanup: () => void): void;
  close(): void;
}

export interface GatewayRequest {
  id?: unknown;
  method: string;
  params?: unknown;
  credential?: string | null;
  surface?: "local" | "web";
}

export interface GatewayResponse {
  id?: unknown;
  result?: unknown;
  error?: GatewayErrorEnvelope;
}

export type GatewayErrorEnvelope =
  | {
      code: string;
      message: string;
      action: string;
      resource: unknown;
    }
  | {
      code: string;
      message: string;
      details?: unknown;
    }
  | {
      message: string;
    };

export type GatewayEventFrame = {
  subId: string;
} & EventStreamFrame;

export interface KeelOperationGatewayOptions {
  ownerId: string;
  api: InProcessKeel;
  store: JournalStore;
  clock: () => number;
  claimLaunchedRun(runId: string): void;
  claimOrReject(runId: string): void;
  definitionCacheRoot: string;
}

type GatewayHandler = (
  session: GatewaySession,
  params: Record<string, unknown>,
  credential: string | null,
) => Promise<unknown> | unknown;

interface GatewayMethod {
  kind: "session" | "health" | "core" | "daemon";
  webRequiresAdmin?: boolean;
  handle: GatewayHandler;
}

interface ActiveDeliveryWake {
  ack: Promise<{ status: string }>;
}

const AUTH_RECHECK_MS = 100;
const DEFAULT_DEFINITION_CACHE_MIN_AGE_MS = 60_000;
const PROMOTION_REVIEW_KEY_PREFIX = "review:";
const INSPECTED_RUN_ACTIONS = {
  resume: "run:resume",
  interrupt: "run:interrupt",
  retry: "run:retry",
  rerun: "run:retry",
  rewind: "run:rewind",
  fork: "run:fork",
  signal: "run:signal",
} as const satisfies Record<string, CapabilityAction>;

export class KeelOperationGateway {
  private readonly activeDeliveryWakes = new Map<string, ActiveDeliveryWake>();

  private readonly methods: Record<string, GatewayMethod> = {
    authenticate: {
      kind: "session",
      handle: (session, p) => {
        session.setCredential((p.token as string | null | undefined) ?? null);
        return { ok: true };
      },
    },
    browseDirectories: {
      kind: "core",
      webRequiresAdmin: true,
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.browseDirectories({ path: p.path as string });
      },
    },
    launchRun: {
      kind: "core",
      webRequiresAdmin: true,
      handle: async (_session, p, credential) => {
        const launchAuthority = this.launchAuthorityForCredential(credential);
        preflightSubmissionSource(p.source as WorkflowSourceInput, launchAuthority);
        const target = requireRunTarget(p.target, "launchRun");
        const res = await this.opts.api.launchRun({
          source: p.source as WorkflowSourceInput,
          input: p.input,
          target,
          name: (p.name as string | null | undefined) ?? null,
          provenance: p.provenance as WorkflowProvenance | undefined,
          runSecrets: p.runSecrets as Record<string, string> | undefined,
          launchAuthority,
        });
        this.opts.claimLaunchedRun(res.runId);
        const cap = issueRunCapability(this.opts.store, res.runId, this.opts.clock());
        return { ...res, capability: cap.token, capabilityId: cap.capabilityId };
      },
    },
    saveWorkflow: {
      kind: "core",
      handle: (_session, p, credential) => {
        const name = p.name as string;
        this.authorizeWorkflow(credential, name, p.version as number | undefined, "workflow:save");
        this.assertPromotionReviewed(p as unknown as SaveWorkflowRequest);
        return this.opts.api.saveWorkflow(p as unknown as SaveWorkflowRequest);
      },
    },
    previewWorkflowDefinition: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.previewWorkflowDefinition({ source: p.source as WorkflowSourceInput });
      },
    },
    listSavedWorkflows: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.listSavedWorkflows({
          ...(p.includeDisabled === true ? { includeDisabled: true } : {}),
          ...(p.includeDeprecated === true ? { includeDeprecated: true } : {}),
          ...(p.includeDeleted === true ? { includeDeleted: true } : {}),
        });
      },
    },
    getSavedWorkflow: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeWorkflow(credential, p.name as string, undefined, "workflow:read");
        return this.opts.api.getSavedWorkflow(p.name as string);
      },
    },
    getSavedWorkflowSource: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeWorkflow(
          credential,
          p.name as string,
          typeof p.version === "number" ? (p.version as number) : undefined,
          "workflow:read",
        );
        return this.opts.api.getSavedWorkflowSource(p as never);
      },
    },
    getWorkflowDefinitionSource: {
      kind: "core",
      handle: (_session, p, credential) => {
        const lookup = (p.lookup ?? {}) as Record<string, unknown>;
        if (lookup.kind === "run") {
          this.authorizeRunCredential(credential, lookup.runId as string, "run:source");
        } else if (lookup.kind === "definition") {
          this.authorizeAdmin(credential);
        } else {
          throw new Error("workflow definition source lookup must be run or definition");
        }
        return this.opts.api.getWorkflowDefinitionSource(p as never);
      },
    },
    launchSavedWorkflow: {
      kind: "core",
      handle: async (_session, p, credential) => {
        const ref = (p.ref ?? {}) as SavedWorkflowRef;
        const launchAuthority = this.launchAuthorityForCredential(credential, true);
        this.authorizeWorkflow(
          credential,
          ref.name,
          typeof ref.version === "number" ? ref.version : undefined,
          "workflow:run",
        );
        const saved = this.opts.store.resolveSavedWorkflowRef(ref);
        this.authorizeWorkflow(credential, ref.name, saved.version, "workflow:run");
        const target = (p.target as string | undefined) ?? saved.defaultTarget ?? undefined;
        const res = await this.opts.api.launchSavedWorkflow({
          ref,
          input: p.input,
          target,
          name: (p.name as string | null | undefined) ?? null,
          runSecrets: p.runSecrets as Record<string, string> | undefined,
          launchAuthority,
        });
        this.opts.claimLaunchedRun(res.runId);
        const cap = issueRunCapability(this.opts.store, res.runId, this.opts.clock());
        return { ...res, capability: cap.token, capabilityId: cap.capabilityId };
      },
    },
    setSavedWorkflowDisabled: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeWorkflow(credential, p.name as string, undefined, "workflow:save");
        return this.opts.api.setSavedWorkflowDisabled(p.name as string, p.disabled === true);
      },
    },
    setSavedWorkflowVersionEnabled: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeWorkflow(credential, p.name as string, p.version as number, "workflow:save");
        return this.opts.api.setSavedWorkflowVersionEnabled(
          p.name as string,
          p.version as number,
          p.enabled === true,
        );
      },
    },
    deprecateSavedWorkflowVersion: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeWorkflow(credential, p.name as string, p.version as number, "workflow:save");
        return this.opts.api.deprecateSavedWorkflowVersion(p as never);
      },
    },
    deleteSavedWorkflow: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.deleteSavedWorkflow(p.name as string);
      },
    },
    deleteSavedWorkflowVersion: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.deleteSavedWorkflowVersion(p.name as string, p.version as number);
      },
    },
    inspectRunAccess: {
      kind: "daemon",
      handle: (_session, p, credential) => {
        const runId = p.runId as string;
        this.authorizeRunCredential(credential, runId, "run:read");
        const actions = Object.fromEntries(
          Object.entries(INSPECTED_RUN_ACTIONS).map(([name, action]) => [
            name,
            this.isRunActionAuthorized(credential, runId, action),
          ]),
        );
        return {
          runId,
          actions: { ...actions, decideApproval: this.isAdminAuthorized(credential) },
        };
      },
    },
    resumeRun: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeRunCredential(credential, p.runId as string, "run:resume");
        this.opts.claimOrReject(p.runId as string);
        return this.opts.api.resumeRun(p.runId as string);
      },
    },
    interruptRun: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeRunCredential(credential, p.runId as string, "run:interrupt");
        this.opts.claimOrReject(p.runId as string);
        return this.opts.api.interruptRun(p.runId as string, p.reason as string | undefined);
      },
    },
    rerunRun: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeRunCredential(credential, p.runId as string, "run:retry");
        this.opts.claimOrReject(p.runId as string);
        return this.opts.api.rerunRun(
          p.runId as string,
          p.opts as {
            source?: WorkflowSourceInput;
            input?: unknown;
            name?: string | null;
            provenance?: WorkflowProvenance;
            runSecrets?: Record<string, string>;
          },
        );
      },
    },
    getRun: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeRunCredential(credential, p.runId as string, "run:read");
        return this.opts.api.getRun(p.runId as string);
      },
    },
    getRunState: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeRunCredential(credential, p.runId as string, "run:read");
        return this.opts.api.getRunState(
          p.runId as string,
          typeof p.namespace === "string" ? p.namespace : undefined,
        );
      },
    },
    getRunReport: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeRunCredential(credential, p.runId as string, "run:read");
        return this.opts.api.getRunReport(p.runId as string);
      },
    },
    getBlockage: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeRunCredential(credential, p.runId as string, "run:read");
        return this.opts.api.getBlockage(p.runId as string);
      },
    },
    listRuns: {
      kind: "core",
      handle: (_session, _p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.listRuns();
      },
    },
    listRunsPage: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.listRunsPage({
          limit: p.limit as number,
          ...(typeof p.parentRunId === "string" ? { parentRunId: p.parentRunId } : {}),
        });
      },
    },
    waitForRun: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeRunCredential(credential, p.runId as string, "run:watch");
        return this.waitForRunAuthorized(credential, p.runId as string);
      },
    },
    getRunOutput: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeRunCredential(credential, p.runId as string, "run:output");
        return this.opts.api.getRunOutput(p.runId as string);
      },
    },
    subscribeEvents: {
      kind: "core",
      handle: (session, p, credential) => {
        this.authorizeRunCredential(credential, p.runId as string, "run:events");
        return this.subscribeEvents(session, p, credential);
      },
    },
    retryRun: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeRunCredential(credential, p.runId as string, "run:retry");
        this.opts.claimOrReject(p.runId as string);
        return this.opts.api.retryRun(p.runId as string, {
          runSecrets: p.runSecrets as Record<string, string> | undefined,
        });
      },
    },
    rewindRun: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeRunCredential(credential, p.runId as string, "run:rewind");
        this.opts.claimOrReject(p.runId as string);
        return this.opts.api.rewindRun(p.runId as string, p.toStableKey as string, {
          runSecrets: p.runSecrets as Record<string, string> | undefined,
        });
      },
    },
    forkRun: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeRunCredential(credential, p.runId as string, "run:fork");
        const fork = this.opts.api.forkRun(
          p.runId as string,
          (p.opts as Record<string, unknown>) ?? {},
        );
        const cap = issueRunCapability(this.opts.store, fork.runId, this.opts.clock());
        return { ...fork, capability: cap.token, capabilityId: cap.capabilityId };
      },
    },
    decideApproval: {
      kind: "daemon",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        const runId = p.runId as string;
        const attachAfterSeq = this.opts.store.eventHighWater(runId);
        this.opts.store.decideApproval(
          runId,
          p.key as string,
          p.decision as { status: "approved" | "denied"; note?: string; grantedCaps?: unknown },
          this.opts.clock(),
        );
        return this.startWakeAfterDelivery(runId, attachAfterSeq);
      },
    },
    sendSignal: {
      kind: "daemon",
      handle: (_session, p, credential) => {
        const runId = p.runId as string;
        this.authorizeRunCredential(credential, runId, "run:signal");
        const attachAfterSeq = this.opts.store.eventHighWater(runId);
        this.opts.store.putSignal(runId, p.name as string, p.payload, this.opts.clock());
        return this.startWakeAfterDelivery(runId, attachAfterSeq);
      },
    },
    putSchedule: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        const hasSource = p.source !== undefined;
        const hasSavedRef = p.savedRef !== undefined;
        if (hasSource === hasSavedRef) {
          throw new Error("putSchedule requires exactly one of source or savedRef");
        }
        let workflowRef: string;
        const scheduleName = (p.workflowName as string | null | undefined) ?? (p.name as string);
        let defaultTarget: string | null = null;
        if (hasSavedRef) {
          if (p.workflowName !== undefined) {
            throw new Error("putSchedule workflowName is only valid with source");
          }
          const saved = this.opts.store.resolveSavedWorkflowRef(p.savedRef as SavedWorkflowRef);
          materializeWorkflowDefinition(
            this.opts.store,
            saved.definitionHash,
            this.opts.definitionCacheRoot,
          );
          workflowRef = saved.definitionHash;
          defaultTarget = saved.defaultTarget;
        } else {
          const snapshot = snapshotWorkflowSource(
            this.opts.store,
            p.source as WorkflowSourceInput,
            {
              name: scheduleName,
              nowMs: this.opts.clock(),
              cacheRoot: this.opts.definitionCacheRoot,
            },
          ).snapshot;
          workflowRef = snapshot.hash;
        }
        const target = requireRunTarget(
          (p.target as string | undefined) ?? defaultTarget,
          "putSchedule",
        );
        this.opts.store.putSchedule({
          name: p.name as string,
          workflowRef,
          inputJson: p.input != null ? JSON.stringify(p.input) : null,
          scheduleTarget: target,
          intervalMs: p.intervalMs as number,
          nextFireMs: (p.firstFireMs as number) ?? this.opts.clock(),
        });
        return { ok: true };
      },
    },
    setScheduleEnabled: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        if (typeof p.name !== "string" || p.name.trim().length === 0) {
          throw new Error("setScheduleEnabled requires a non-empty schedule name");
        }
        if (typeof p.enabled !== "boolean") {
          throw new Error("setScheduleEnabled requires a boolean enabled value");
        }
        const name = p.name;
        const enabled = p.enabled;
        this.opts.store.setScheduleEnabled(name, enabled);
        return { name, enabled };
      },
    },
    deleteSchedule: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        if (typeof p.name !== "string" || p.name.trim().length === 0) {
          throw new Error("deleteSchedule requires a non-empty schedule name");
        }
        const name = p.name;
        return { name, deleted: this.opts.store.deleteSchedule(name) };
      },
    },
    listSchedules: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.listSchedules({
          ...(p.includeDisabled === false ? { includeDisabled: false } : {}),
        });
      },
    },
    getSchedule: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.getSchedule({
          name: p.name as string,
          ...(p.includeSource === true ? { includeSource: true } : {}),
        });
      },
    },
    listRunWorkspaces: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeRunCredential(credential, p.runId as string, "run:read");
        return this.opts.api.listRunWorkspaces(p.runId as string, {
          ...(p.includeRemoved === true ? { includeRemoved: true } : {}),
        });
      },
    },
    getRunWorkspace: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeRunCredential(credential, p.runId as string, "run:read");
        return this.opts.api.getRunWorkspace(p.runId as string, p.workspaceId as string);
      },
    },
    getRunWorkspaceDiff: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeRunCredential(credential, p.runId as string, "run:read");
        return this.opts.api.getRunWorkspaceDiff(p.runId as string, p.workspaceId as string);
      },
    },
    mergeRunWorkspace: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.mergeRunWorkspace(p.runId as string, p.workspaceId as string);
      },
    },
    discardRunWorkspace: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.discardRunWorkspace(p.runId as string, p.workspaceId as string);
      },
    },
    gcWorkspaces: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.gcWorkspaces({
          ...(typeof p.olderThanMs === "number" ? { olderThanMs: p.olderThanMs } : {}),
          ...(p.includePending === true ? { includePending: true } : {}),
          ...(p.includeRemoved === true ? { includeRemoved: true } : {}),
        });
      },
    },
    listAgentProfiles: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.listAgentProfiles(
          p as { source?: "all" | "catalog" | "programmatic" },
        );
      },
    },
    getAgentProfile: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.getAgentProfile(p.name as string);
      },
    },
    putAgentProfile: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.putAgentProfile(p as never);
      },
    },
    deleteAgentProfile: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.deleteAgentProfile(p as never);
      },
    },
    checkAgentProfile: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.checkAgentProfile(p as never);
      },
    },
    listSettings: {
      kind: "core",
      handle: (_session, _p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.listSettings();
      },
    },
    getSetting: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.getSetting(p.key as string);
      },
    },
    putSetting: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.putSetting(p as never);
      },
    },
    deleteSetting: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.deleteSetting(p as never);
      },
    },
    checkSetting: {
      kind: "core",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        return this.opts.api.checkSetting(p as never);
      },
    },
    gcDefinitions: {
      kind: "daemon",
      handle: (_session, p, credential) => {
        this.authorizeAdmin(credential);
        const operational = effectiveOperationalSettings(this.opts.store.listDaemonSettingRows());
        const ttlMs = typeof p.ttlMs === "number" ? p.ttlMs : operational.workflowDefinitionGcTtlMs;
        const cacheMinAgeMs =
          typeof p.cacheMinAgeMs === "number"
            ? p.cacheMinAgeMs
            : DEFAULT_DEFINITION_CACHE_MIN_AGE_MS;
        const nowMs = this.opts.clock();
        const oneOffRunsRemoved = this.opts.store.pruneOneOffRuns({
          nowMs,
          ttlMs: typeof p.runTtlMs === "number" ? p.runTtlMs : DEFAULT_ONE_OFF_RUN_TTL_MS,
        });
        const workflowDefinitionsRemoved = this.opts.store.pruneWorkflowDefinitions({
          nowMs,
          ttlMs,
        });
        const definitionCacheEntriesRemoved = evictWorkflowDefinitionCache(this.opts.store, {
          cacheRoot: this.opts.definitionCacheRoot,
          nowMs: this.opts.clock(),
          minAgeMs: cacheMinAgeMs,
        });
        return { oneOffRunsRemoved, workflowDefinitionsRemoved, definitionCacheEntriesRemoved };
      },
    },
    ping: {
      kind: "health",
      handle: () => ({ ok: true, ownerId: this.opts.ownerId }),
    },
  };

  constructor(private readonly opts: KeelOperationGatewayOptions) {}

  async handle(session: GatewaySession, request: GatewayRequest): Promise<GatewayResponse> {
    try {
      const method = this.methods[request.method];
      if (!method) throw new Error(`unknown method ${request.method}`);
      const params = paramsObject(request.params);
      const credential =
        request.credential !== undefined ? request.credential : session.getCredential();
      if (request.surface === "web" && hasRunSecretsParam(params)) {
        throw new Error("runSecrets are not accepted from the web surface");
      }
      if (request.surface === "web" && method.webRequiresAdmin) {
        this.authorizeAdmin(credential);
      }
      const result = await method.handle(session, params, credential);
      return { id: request.id, result };
    } catch (err) {
      return { id: request.id, error: this.errorEnvelope(err) };
    }
  }

  private errorEnvelope(err: unknown): GatewayErrorEnvelope {
    if (err instanceof CapabilityCeilingError) {
      return {
        code: err.code,
        message: err.message,
        details: {
          profile: err.profile,
          context: err.context,
          declared: err.declared,
          ceiling: err.ceiling,
          exceeded: err.exceeded,
        },
      };
    }
    if (err instanceof AuthorizationError) {
      return {
        code: err.code,
        message: err.message,
        action: err.request.action,
        resource: err.request.resource,
      };
    }
    return {
      message: redactCapabilityTokensInValue(err instanceof Error ? err.message : String(err)),
    };
  }

  private launchAuthorityForCredential(
    credential: string | null,
    allowWorkflowCredential = false,
  ): LaunchAuthority | null {
    if (credential === null || this.isAdminAuthorized(credential)) return null;
    try {
      const capability = authorize(
        this.opts.store,
        credential,
        { action: "workflow:submit", resource: { kind: "daemon" } },
        this.opts.clock(),
      );
      if (!capability.ceilingProfile) {
        throw new Error("submitter credential has no launch-authority ceiling profile");
      }
      return authorityForCeilingProfile(capability.ceilingProfile);
    } catch (err) {
      if (allowWorkflowCredential && err instanceof AuthorizationError) return null;
      throw err;
    }
  }

  private assertPromotionReviewed(req: SaveWorkflowRequest): void {
    const launchAuthorityRegimeActive =
      this.opts.store.db
        .query<{ active: number }, []>(
          "SELECT EXISTS(SELECT 1 FROM capabilities WHERE ceiling_profile IS NOT NULL) AS active",
        )
        .get()?.active === 1;
    if (!launchAuthorityRegimeActive) return;

    const snapshot = snapshotWorkflowSource(this.opts.store, req.source, {
      name: req.workflowName ?? req.name,
      nowMs: this.opts.clock(),
      cacheRoot: this.opts.definitionCacheRoot,
    }).snapshot;
    const review = req.reviewApproval;
    if (!review) {
      throw new Error(
        "saving a workflow while submitter credentials are configured requires reviewApproval { runId, key }",
      );
    }
    if (!review.key.startsWith(PROMOTION_REVIEW_KEY_PREFIX)) {
      throw new Error(
        `promotion review key must start with ${JSON.stringify(PROMOTION_REVIEW_KEY_PREFIX)}`,
      );
    }
    const run = this.opts.store.getRun(review.runId);
    if (!run) throw new Error(`review run ${review.runId} not found`);
    const approval = this.opts.store.getApproval(review.runId, review.key);
    if (!approval || approval.status !== "approved") {
      throw new Error(`promotion review ${review.runId}/${review.key} is not approved`);
    }
    if (snapshot.hash !== run.definitionVersion) {
      throw new Error(
        `promotion source ${snapshot.hash} does not match reviewed definition ${run.definitionVersion}`,
      );
    }
  }

  private authorizeRunCredential(
    credential: string | null,
    runId: string,
    action: CapabilityAction,
  ): void {
    authorize(
      this.opts.store,
      credential,
      { action, resource: { kind: "run", runId } },
      this.opts.clock(),
    );
  }

  private isRunActionAuthorized(
    credential: string | null,
    runId: string,
    action: CapabilityAction,
  ): boolean {
    try {
      this.authorizeRunCredential(credential, runId, action);
      return true;
    } catch (err) {
      if (err instanceof AuthorizationError) return false;
      throw err;
    }
  }

  private isAdminAuthorized(credential: string | null): boolean {
    try {
      this.authorizeAdmin(credential);
      return true;
    } catch (err) {
      if (err instanceof AuthorizationError) return false;
      throw err;
    }
  }

  private authorizeAdmin(credential: string | null): void {
    authorize(
      this.opts.store,
      credential,
      { action: "admin", resource: { kind: "daemon" } },
      this.opts.clock(),
    );
  }

  private authorizeWorkflow(
    credential: string | null,
    name: string,
    version: number | undefined,
    action: CapabilityAction,
  ): void {
    authorize(
      this.opts.store,
      credential,
      {
        action,
        resource:
          version === undefined ? { kind: "workflow", name } : { kind: "workflow", name, version },
      },
      this.opts.clock(),
    );
  }

  private waitForRunAuthorized(credential: string | null, runId: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearInterval(recheck);
        fn();
      };
      const recheck = setInterval(() => {
        try {
          this.authorizeRunCredential(credential, runId, "run:watch");
        } catch (err) {
          finish(() => reject(err));
        }
      }, AUTH_RECHECK_MS);
      this.opts.api.waitForRun(runId).then(
        (out) => {
          try {
            this.authorizeRunCredential(credential, runId, "run:watch");
            finish(() => resolve(out));
          } catch (err) {
            finish(() => reject(err));
          }
        },
        (err) => finish(() => reject(err)),
      );
    });
  }

  private subscribeEvents(
    session: GatewaySession,
    p: Record<string, unknown>,
    credential: string | null,
  ): SubscribeEventsResult {
    const runId = p.runId as string;
    if ("afterSeq" in p) {
      throw new Error("subscribeEvents uses cursor; numeric afterSeq is not supported");
    }
    const req: SubscribeEventsRequest = {
      runId,
      ...(p.cursor !== undefined ? { cursor: p.cursor as SubscribeEventsRequest["cursor"] } : {}),
      ...(p.includeControlFrames === true ? { includeControlFrames: true } : {}),
    };
    normalizeEventCursorInput(req.cursor);
    const includeControlFrames = req.includeControlFrames === true;
    const initialCursor = resolveEventCursor(this.opts.store, runId, req.cursor).initialCursor;
    const subId = randomUUID();
    let unsub = () => {};
    let stopped = false;
    let unsubAssigned = false;
    let authFailureSent = false;
    let recheck: ReturnType<typeof setInterval> | null = null;
    let lastCursor: EventCursor = initialCursor;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (recheck) clearInterval(recheck);
      if (unsubAssigned) unsub();
      session.removeCleanup(stop);
    };
    session.addCleanup(stop);
    const sendAuthFailure = (err: unknown) => {
      if (authFailureSent) return;
      authFailureSent = true;
      const payload = {
        message: redactCapabilityTokensInValue(err instanceof Error ? err.message : String(err)),
      };
      if (includeControlFrames) {
        session.sendEvent(
          redactCapabilityTokensInValue({
            subId,
            kind: "control",
            type: "authorization.failed",
            cursor: lastCursor,
            payload,
          }) as GatewayEventFrame,
        );
      } else {
        session.sendEvent({
          subId,
          kind: "ephemeral",
          type: "authorization.failed",
          payload,
          atMs: this.opts.clock(),
        });
      }
    };
    recheck = setInterval(() => {
      try {
        this.authorizeRunCredential(credential, runId, "run:events");
      } catch (err) {
        sendAuthFailure(err);
        stop();
      }
    }, AUTH_RECHECK_MS);
    const sendFrame = (frame: EventStreamFrame): void => {
      try {
        if (stopped) return;
        this.authorizeRunCredential(credential, runId, "run:events");
        if (frame.kind === "durable") lastCursor = { kind: "after-seq", runId, seq: frame.seq };
        if (frame.kind === "control") lastCursor = frame.cursor;
        session.sendEvent({ subId, ...redactCapabilityTokensInValue(frame) });
      } catch (err) {
        sendAuthFailure(err);
        stop();
      }
    };
    let subscribed: (() => void) & Pick<SubscribeEventsResult, "cursor" | "closedStatus">;
    try {
      subscribed = this.opts.api.subscribeEvents(
        req,
        (event: EventEnvelope) => sendFrame(event),
        (frame: StreamControlFrame) => {
          if (includeControlFrames) sendFrame(frame);
          else lastCursor = frame.cursor;
        },
      ) as (() => void) & Pick<SubscribeEventsResult, "cursor" | "closedStatus">;
    } catch (err) {
      stop();
      throw err;
    }
    lastCursor = subscribed.cursor;
    unsub = subscribed;
    unsubAssigned = true;
    if (stopped) {
      unsub();
      session.removeCleanup(stop);
    }
    return {
      subId,
      cursor: subscribed.cursor,
      closedStatus: subscribed.closedStatus,
    };
  }

  /** Start, but do not await, a wake made eligible by a delivered decision/signal. */
  private async startWakeAfterDelivery(runId: string, attachAfterSeq: number): Promise<RunStart> {
    const run = this.opts.store.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    const attachCursor = cursorAfterSeq(runId, attachAfterSeq);
    if (run.status.startsWith("waiting-")) {
      const active = this.activeDeliveryWakes.get(runId);
      if (active)
        return { runId, status: (await active.ack).status as RunStart["status"], attachCursor };
      const wake: ActiveDeliveryWake = { ack: this.startDeliveryWake(runId) };
      this.activeDeliveryWakes.set(runId, wake);
      try {
        const started = await wake.ack;
        return { runId, status: started.status as RunStart["status"], attachCursor };
      } catch (err) {
        if (this.activeDeliveryWakes.get(runId) === wake) this.activeDeliveryWakes.delete(runId);
        throw err;
      }
    }
    return { runId, status: run.status, attachCursor };
  }

  private async startDeliveryWake(runId: string): Promise<{ status: string }> {
    this.opts.claimOrReject(runId);
    try {
      await this.opts.api.resumeRun(runId);
    } catch (err) {
      if (isUnsupportedWorkflowSdkAbiError(err)) {
        failRunWithError(this.opts.store, runId, err, this.opts.clock());
      }
      throw err;
    }
    const wake = this.activeDeliveryWakes.get(runId);
    void this.opts.api
      .waitForRun(runId)
      .catch(() => undefined)
      .finally(() => {
        if (this.activeDeliveryWakes.get(runId) === wake) this.activeDeliveryWakes.delete(runId);
      });
    return { status: "running" };
  }
}

function hasRunSecretsParam(params: Record<string, unknown>): boolean {
  if (Object.prototype.hasOwnProperty.call(params, "runSecrets")) return true;
  const opts = params.opts;
  return (
    opts !== null &&
    typeof opts === "object" &&
    Object.prototype.hasOwnProperty.call(opts, "runSecrets")
  );
}

function paramsObject(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new Error("request params must be an object");
  }
  return params as Record<string, unknown>;
}
