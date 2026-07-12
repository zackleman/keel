// Thin daemon client (DESIGN.md §6.1) — implements the same KeelApi over a Unix
// socket. The CLI, and later web/MCP, are clients exactly like this.

import { type Socket, connect } from "bun";
import type {
  AgentProfileCheckResult,
  AgentProfileView,
  BrowseDirectoriesRequest,
  BrowseDirectoriesResult,
  CheckAgentProfileRequest,
  DeleteAgentProfileRequest,
  DeleteSettingRequest,
  EventEnvelope,
  EventStreamFrame,
  GetWorkflowDefinitionSourceRequest,
  LaunchRequest,
  LaunchSavedWorkflowRequest,
  PreviewWorkflowDefinitionRequest,
  PreviewWorkflowDefinitionResult,
  PutAgentProfileRequest,
  PutSettingRequest,
  RunLaunchResult,
  RunOutcome,
  RunStart,
  RunStateSnapshot,
  RunWorkspaceDiff,
  RunWorkspaceView,
  SaveWorkflowRequest,
  SavedWorkflowRef,
  SavedWorkflowSourceView,
  SavedWorkflowSummary,
  SavedWorkflowVersionView,
  SavedWorkflowView,
  ScheduleSummary,
  ScheduleView,
  SettingView,
  SettingsDiagnostic,
  StreamControlFrame,
  SubscribeEventsRequest,
  SubscribeEventsResult,
  WorkflowDefinitionSourceView,
  WorkspaceGcResult,
} from "../rpc/contract.ts";
import type { RunProjection, RunReport, RunSummary, RunSummaryPage } from "../rpc/projection.ts";
import { clientRunTargetOrCwd } from "../target.ts";
import type { WorkflowSourceInput } from "../workflow-definitions/source.ts";

/** Async-shaped client over the socket (the in-process KeelApi is sync; the wire
 * is async). Same method names, Promise-returning. */
export class DaemonClient {
  private socket: Socket<undefined> | null = null;
  private buf = "";
  private nextId = 1;
  private readonly encoder = new TextEncoder();
  private readonly writeQueue: Array<{ data: Uint8Array; offset: number }> = [];
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private readonly subs = new Map<string, (event: EventEnvelope) => void>();
  private readonly controlSubs = new Map<string, (frame: StreamControlFrame) => void>();
  private readonly pendingSubEvents = new Map<string, EventStreamFrame[]>();
  private readonly closedSubIds = new Set<string>();

  static async connect(socketPath: string): Promise<DaemonClient> {
    const c = new DaemonClient();
    c.socket = await connect<undefined>({
      unix: socketPath,
      socket: {
        data: (_s, data) => c.onData(data),
        drain: () => c.flushWrites(),
        close: () => c.failAll(new Error("daemon connection closed")),
      },
    });
    return c;
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.writeQueue.length = 0;
    this.failAll(new Error("daemon client closed"));
    socket?.end();
    const force = socket as
      | ({ flush?: () => void; terminate?: () => void } & Socket<undefined>)
      | null;
    force?.flush?.();
    force?.terminate?.();
  }

  private onData(data: Buffer): void {
    this.buf += data.toString("utf8");
    let nl = this.buf.indexOf("\n");
    while (nl >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.trim()) this.onMessage(line);
      nl = this.buf.indexOf("\n");
    }
  }

  private onMessage(line: string): void {
    const msg = JSON.parse(line) as {
      id?: number;
      result?: unknown;
      error?: { message: string; code?: string; action?: string; resource?: unknown };
      event?: EventStreamFrame & { subId: string };
    };
    if (msg.event) {
      const { subId, ...frame } = msg.event;
      const event = frame as EventStreamFrame;
      const eventSub = this.subs.get(subId);
      const controlSub = this.controlSubs.get(subId);
      if (event.kind === "control" && controlSub) {
        controlSub(event);
      } else if (event.kind !== "control" && eventSub) {
        eventSub(event);
      } else if (this.closedSubIds.has(subId)) {
        return;
      } else {
        const buffered = this.pendingSubEvents.get(subId) ?? [];
        buffered.push(event);
        this.pendingSubEvents.set(subId, buffered);
      }
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  }

  private failAll(err: unknown): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.subs.clear();
    this.controlSubs.clear();
    this.pendingSubEvents.clear();
    this.closedSubIds.clear();
  }

  private rpc<T>(method: string, params: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.writeQueue.push({
        data: this.encoder.encode(`${JSON.stringify({ id, method, params })}\n`),
        offset: 0,
      });
      this.flushWrites();
    });
  }

  private flushWrites(): void {
    const socket = this.socket;
    if (!socket) return;
    while (this.writeQueue.length > 0) {
      const next = this.writeQueue[0];
      if (!next) return;
      const written = socket.write(next.data, next.offset, next.data.byteLength - next.offset);
      if (written < 0) {
        this.close();
        return;
      }
      if (written === 0) return;
      next.offset += written;
      if (next.offset >= next.data.byteLength) this.writeQueue.shift();
    }
  }

  browseDirectories(req: BrowseDirectoriesRequest): Promise<BrowseDirectoriesResult> {
    return this.rpc("browseDirectories", req);
  }

  launchRun(req: LaunchRequest): Promise<RunLaunchResult> {
    return this.rpc("launchRun", {
      ...req,
      target: clientRunTargetOrCwd(req.target, "launchRun"),
    });
  }
  saveWorkflow(req: SaveWorkflowRequest): Promise<SavedWorkflowVersionView> {
    return this.rpc("saveWorkflow", req);
  }
  previewWorkflowDefinition(
    req: PreviewWorkflowDefinitionRequest,
  ): Promise<PreviewWorkflowDefinitionResult> {
    return this.rpc("previewWorkflowDefinition", req);
  }
  listSavedWorkflows(
    req: {
      includeDisabled?: boolean;
      includeDeprecated?: boolean;
      includeDeleted?: boolean;
    } = {},
  ): Promise<SavedWorkflowSummary[]> {
    return this.rpc("listSavedWorkflows", req);
  }
  getSavedWorkflow(name: string): Promise<SavedWorkflowView | null> {
    return this.rpc("getSavedWorkflow", { name });
  }
  getSavedWorkflowSource(req: {
    name: string;
    version?: number | "latest";
    file?: string;
    all?: boolean;
    allowDeprecated?: boolean;
  }): Promise<SavedWorkflowSourceView> {
    return this.rpc("getSavedWorkflowSource", req);
  }
  getWorkflowDefinitionSource(
    req: GetWorkflowDefinitionSourceRequest,
  ): Promise<WorkflowDefinitionSourceView> {
    return this.rpc("getWorkflowDefinitionSource", req);
  }
  launchSavedWorkflow(req: LaunchSavedWorkflowRequest): Promise<RunLaunchResult> {
    return this.rpc("launchSavedWorkflow", {
      ...req,
      ...(req.target !== undefined
        ? { target: clientRunTargetOrCwd(req.target, "launchSavedWorkflow") }
        : {}),
    });
  }
  setSavedWorkflowDisabled(name: string, disabled: boolean): Promise<SavedWorkflowView> {
    return this.rpc("setSavedWorkflowDisabled", { name, disabled });
  }
  setSavedWorkflowVersionEnabled(
    name: string,
    version: number,
    enabled: boolean,
  ): Promise<SavedWorkflowVersionView> {
    return this.rpc("setSavedWorkflowVersionEnabled", { name, version, enabled });
  }
  deprecateSavedWorkflowVersion(req: {
    name: string;
    version: number;
    message?: string | null;
  }): Promise<SavedWorkflowVersionView> {
    return this.rpc("deprecateSavedWorkflowVersion", req);
  }
  deleteSavedWorkflow(name: string): Promise<SavedWorkflowView> {
    return this.rpc("deleteSavedWorkflow", { name });
  }
  deleteSavedWorkflowVersion(name: string, version: number): Promise<SavedWorkflowVersionView> {
    return this.rpc("deleteSavedWorkflowVersion", { name, version });
  }
  resumeRun(runId: string): Promise<RunStart> {
    return this.rpc("resumeRun", { runId });
  }
  interruptRun(runId: string, reason?: string): Promise<{ runId: string; status: "interrupted" }> {
    return this.rpc("interruptRun", { runId, reason });
  }
  rerunRun(
    runId: string,
    opts?: {
      source?: WorkflowSourceInput;
      input?: unknown;
      name?: string | null;
      provenance?: LaunchRequest["provenance"];
      runSecrets?: LaunchRequest["runSecrets"];
    },
  ): Promise<RunStart> {
    return this.rpc("rerunRun", { runId, opts });
  }
  getRun(runId: string): Promise<RunProjection | null> {
    return this.rpc("getRun", { runId });
  }
  getRunState(runId: string, namespace?: string): Promise<RunStateSnapshot | null> {
    return this.rpc("getRunState", { runId, ...(namespace === undefined ? {} : { namespace }) });
  }
  getRunReport(runId: string): Promise<RunReport | null> {
    return this.rpc("getRunReport", { runId });
  }
  retryRun(
    runId: string,
    opts: { runSecrets?: LaunchRequest["runSecrets"] } = {},
  ): Promise<RunStart> {
    return this.rpc("retryRun", { runId, ...opts });
  }
  rewindRun(
    runId: string,
    toStableKey: string,
    opts: { runSecrets?: LaunchRequest["runSecrets"] } = {},
  ): Promise<RunStart> {
    return this.rpc("rewindRun", { runId, toStableKey, ...opts });
  }
  forkRun(
    runId: string,
    opts: { atStableKey?: string; newRunId?: string } = {},
  ): Promise<RunLaunchResult> {
    return this.rpc("forkRun", { runId, opts });
  }
  getBlockage(runId: string): Promise<import("../rpc/projection.ts").Blockage> {
    return this.rpc("getBlockage", { runId });
  }
  decideApproval(
    runId: string,
    key: string,
    decision: { status: "approved" | "denied"; note?: string; grantedCaps?: unknown },
  ): Promise<RunStart> {
    return this.rpc("decideApproval", { runId, key, decision });
  }
  sendSignal(runId: string, name: string, payload: unknown): Promise<RunStart> {
    return this.rpc("sendSignal", { runId, name, payload });
  }
  putSchedule(req: {
    name: string;
    source?: WorkflowSourceInput;
    savedRef?: SavedWorkflowRef;
    workflowName?: string | null;
    input?: unknown;
    target?: string;
    intervalMs: number;
    firstFireMs?: number;
  }): Promise<{ ok: boolean }> {
    const target =
      req.target !== undefined
        ? clientRunTargetOrCwd(req.target, "putSchedule")
        : req.savedRef === undefined
          ? clientRunTargetOrCwd(undefined, "putSchedule")
          : undefined;
    return this.rpc("putSchedule", {
      ...req,
      ...(target !== undefined ? { target } : {}),
    });
  }
  setScheduleEnabled(name: string, enabled: boolean): Promise<{ name: string; enabled: boolean }> {
    return this.rpc("setScheduleEnabled", { name, enabled });
  }
  deleteSchedule(name: string): Promise<{ name: string; deleted: boolean }> {
    return this.rpc("deleteSchedule", { name });
  }
  listSchedules(req: { includeDisabled?: boolean } = {}): Promise<ScheduleSummary[]> {
    return this.rpc("listSchedules", req);
  }
  getSchedule(req: { name: string; includeSource?: boolean }): Promise<ScheduleView | null> {
    return this.rpc("getSchedule", req);
  }
  listRunWorkspaces(
    runId: string,
    opts: { includeRemoved?: boolean } = {},
  ): Promise<RunWorkspaceView[]> {
    return this.rpc("listRunWorkspaces", { runId, ...opts });
  }
  getRunWorkspace(runId: string, workspaceId: string): Promise<RunWorkspaceView | null> {
    return this.rpc("getRunWorkspace", { runId, workspaceId });
  }
  getRunWorkspaceDiff(runId: string, workspaceId: string): Promise<RunWorkspaceDiff> {
    return this.rpc("getRunWorkspaceDiff", { runId, workspaceId });
  }
  mergeRunWorkspace(runId: string, workspaceId: string): Promise<RunWorkspaceView> {
    return this.rpc("mergeRunWorkspace", { runId, workspaceId });
  }
  discardRunWorkspace(runId: string, workspaceId: string): Promise<RunWorkspaceView> {
    return this.rpc("discardRunWorkspace", { runId, workspaceId });
  }
  gcWorkspaces(
    req: { olderThanMs?: number; includePending?: boolean; includeRemoved?: boolean } = {},
  ): Promise<WorkspaceGcResult> {
    return this.rpc("gcWorkspaces", req);
  }
  listAgentProfiles(
    req: { source?: "all" | "catalog" | "programmatic" } = {},
  ): Promise<AgentProfileView[]> {
    return this.rpc("listAgentProfiles", req);
  }
  getAgentProfile(name: string): Promise<AgentProfileView | null> {
    return this.rpc("getAgentProfile", { name });
  }
  putAgentProfile(req: PutAgentProfileRequest): Promise<AgentProfileView> {
    return this.rpc("putAgentProfile", req);
  }
  deleteAgentProfile(req: DeleteAgentProfileRequest): Promise<{ name: string; deleted: true }> {
    return this.rpc("deleteAgentProfile", req);
  }
  checkAgentProfile(req: CheckAgentProfileRequest): Promise<AgentProfileCheckResult> {
    return this.rpc("checkAgentProfile", req);
  }
  listSettings(): Promise<SettingView[]> {
    return this.rpc("listSettings", {});
  }
  getSetting(key: string): Promise<SettingView | null> {
    return this.rpc("getSetting", { key });
  }
  putSetting(req: PutSettingRequest): Promise<SettingView> {
    return this.rpc("putSetting", req);
  }
  deleteSetting(req: DeleteSettingRequest): Promise<{ key: string; deleted: boolean }> {
    return this.rpc("deleteSetting", req);
  }
  checkSetting(req: {
    key: string;
    value: unknown;
  }): Promise<{ ok: boolean; diagnostics: SettingsDiagnostic[] }> {
    return this.rpc("checkSetting", req);
  }
  gcDefinitions(req: { ttlMs?: number; runTtlMs?: number; cacheMinAgeMs?: number } = {}): Promise<{
    oneOffRunsRemoved: number;
    workflowDefinitionsRemoved: number;
    definitionCacheEntriesRemoved: number;
  }> {
    return this.rpc("gcDefinitions", req);
  }
  listRuns(): Promise<RunSummary[]> {
    return this.rpc("listRuns", {});
  }
  listRunsPage(req: { limit: number; parentRunId?: string }): Promise<RunSummaryPage> {
    return this.rpc("listRunsPage", req);
  }
  ping(): Promise<{ ok: boolean; ownerId: string }> {
    return this.rpc("ping", {});
  }
  authenticate(token: string): Promise<{ ok: boolean }> {
    return this.rpc("authenticate", { token });
  }
  waitForRun(runId: string): Promise<RunOutcome> {
    return this.rpc("waitForRun", { runId });
  }
  getRunOutput(runId: string): Promise<RunOutcome> {
    return this.rpc("getRunOutput", { runId });
  }
  subscribeEvents(
    req: SubscribeEventsRequest,
    onEvent: (e: EventEnvelope) => void,
    onError?: (err: unknown) => void,
    onCaughtUp?: (result: SubscribeEventsResult) => void,
    onControl?: (frame: StreamControlFrame) => void,
  ): () => void {
    let subId: string | null = null;
    let active = true;
    void this.rpc<SubscribeEventsResult>("subscribeEvents", req).then(
      (r) => {
        subId = r.subId;
        if (!active) {
          this.closedSubIds.add(r.subId);
          this.pendingSubEvents.delete(r.subId);
          return;
        }
        this.closedSubIds.delete(r.subId);
        this.subs.set(r.subId, onEvent);
        if (onControl) this.controlSubs.set(r.subId, onControl);
        const buffered = this.pendingSubEvents.get(r.subId) ?? [];
        this.pendingSubEvents.delete(r.subId);
        for (const event of buffered) {
          if (event.kind === "control") onControl?.(event);
          else onEvent(event);
        }
        // The daemon backfills before the subscribe RPC returns; after this flush, events are live.
        onCaughtUp?.(r);
      },
      (err) => {
        onError?.(err);
      },
    );
    return () => {
      active = false;
      if (subId) {
        this.subs.delete(subId);
        this.controlSubs.delete(subId);
        this.pendingSubEvents.delete(subId);
        this.closedSubIds.add(subId);
      }
    };
  }
}
