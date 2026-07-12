import { redactCapabilityTokensInValue } from "../auth/redaction.ts";
import { DaemonClient } from "../daemon/client.ts";
import type {
  DurableEventEnvelope,
  EventCursor,
  RunOutcome,
  RunProjection,
  RunReport,
  RunStart,
  RunSummaryPage,
} from "../rpc/contract.ts";
import type { Blockage } from "../rpc/projection.ts";

export const DEFAULT_MCP_PAGE_LIMIT = 100;
export const MAX_MCP_PAGE_LIMIT = 500;

export interface DurableFramePage {
  frames: DurableEventEnvelope[];
  nextCursor: number;
}

export type RunBlockage = Blockage & { approvalId?: string };

export class SupervisorTools {
  private constructor(private readonly client: DaemonClient) {}

  static async connect(opts: { socketPath: string; credential: string }): Promise<SupervisorTools> {
    const client = await DaemonClient.connect(opts.socketPath);
    try {
      await client.authenticate(opts.credential);
      return new SupervisorTools(client);
    } catch (error) {
      client.close();
      throw error;
    }
  }

  close(): void {
    this.client.close();
  }

  async listRuns(limit = DEFAULT_MCP_PAGE_LIMIT): Promise<RunSummaryPage> {
    return this.safe(await this.client.listRunsPage({ limit: validLimit(limit) }));
  }

  async watchRun(runId: string): Promise<{
    runId: string;
    status: RunProjection["status"];
    phase: string | null;
    blockage: RunBlockage;
  }> {
    const run = await this.requireRun(runId);
    const blockage = await this.getRunBlockage(runId);
    return this.safe({ runId, status: run.status, phase: run.phase, blockage });
  }

  async getRunDetail(
    runId: string,
    includeReport = false,
  ): Promise<
    | RunProjection
    | {
        run: RunProjection;
        report: RunReport;
      }
  > {
    const run = await this.requireRun(runId);
    if (!includeReport) return this.safe(run);
    const report = await this.client.getRunReport(runId);
    if (!report) throw new Error(`run ${runId} not found`);
    return this.safe({ run, report });
  }

  async getRunBlockage(runId: string): Promise<RunBlockage> {
    await this.requireRun(runId);
    const blockage = await this.client.getBlockage(runId);
    const approvalId =
      blockage.reason === "waiting_human" && blockage.blockedOn
        ? encodeApprovalId(runId, blockage.blockedOn.stableKey)
        : undefined;
    return this.safe({ ...blockage, ...(approvalId ? { approvalId } : {}) });
  }

  tailCheckpoints(
    runId: string,
    afterSeq = 0,
    limit = DEFAULT_MCP_PAGE_LIMIT,
  ): Promise<DurableFramePage> {
    return this.tailEvents(runId, afterSeq, ["checkpoint"], limit);
  }

  async tailEvents(
    runId: string,
    afterSeq = 0,
    types?: string[],
    limit = DEFAULT_MCP_PAGE_LIMIT,
  ): Promise<DurableFramePage> {
    await this.requireRun(runId);
    validCursor(afterSeq);
    const pageLimit = validLimit(limit);
    const typeSet = types && types.length > 0 ? new Set(types) : null;
    const { frames, cursor } = await collectDurableBackfill(this.client, runId, afterSeq);
    const matching = typeSet ? frames.filter((frame) => typeSet.has(frame.type)) : frames;
    const page = matching.slice(0, pageLimit);
    const caughtUpSeq = frames.reduce((seq, frame) => Math.max(seq, frame.seq), cursor.seq);
    const nextCursor = matching.length > pageLimit ? (page.at(-1)?.seq ?? afterSeq) : caughtUpSeq;
    return this.safe({ frames: page, nextCursor });
  }

  async sendSignal(runId: string, name: string, payload: unknown): Promise<RunStart> {
    return this.safe(await this.client.sendSignal(runId, name, payload));
  }

  async decideApproval(
    approvalId: string,
    decision: "approved" | "denied",
    note?: string,
  ): Promise<RunStart> {
    const { runId, stableKey } = decodeApprovalId(approvalId);
    return this.safe(
      await this.client.decideApproval(runId, stableKey, {
        status: decision,
        ...(note ? { note } : {}),
      }),
    );
  }

  async interruptRun(runId: string): Promise<{ runId: string; status: "interrupted" }> {
    return this.safe(await this.client.interruptRun(runId));
  }

  async resumeRun(runId: string): Promise<RunStart> {
    return this.safe(await this.client.resumeRun(runId));
  }

  async launchSavedWorkflow(ref: string, input: unknown): Promise<{ runId: string }> {
    const launched = await this.client.launchSavedWorkflow({
      ref: parseSavedWorkflowRef(ref),
      input,
    });
    return { runId: launched.runId };
  }

  async waitForRun(runId: string): Promise<RunOutcome> {
    return this.safe(await this.client.waitForRun(runId));
  }

  private async requireRun(runId: string): Promise<RunProjection> {
    const run = await this.client.getRun(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    return run;
  }

  private safe<T>(value: T): T {
    return redactCapabilityTokensInValue(value);
  }
}

function collectDurableBackfill(
  client: DaemonClient,
  runId: string,
  afterSeq: number,
): Promise<{ frames: DurableEventEnvelope[]; cursor: EventCursor }> {
  return new Promise((resolve, reject) => {
    const frames: DurableEventEnvelope[] = [];
    let settled = false;
    let unsubscribe = () => {};
    unsubscribe = client.subscribeEvents(
      { runId, cursor: { kind: "after-seq", seq: afterSeq } },
      (event) => {
        if (!settled && event.kind === "durable") frames.push(event);
      },
      (error) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        reject(error);
      },
      (result) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        resolve({ frames, cursor: result.cursor });
      },
    );
  });
}

function validLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MCP_PAGE_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_MCP_PAGE_LIMIT}`);
  }
  return limit;
}

function validCursor(afterSeq: number): number {
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
    throw new Error("afterSeq must be a non-negative integer");
  }
  return afterSeq;
}

function parseSavedWorkflowRef(ref: string): { name: string; version?: number } {
  const match = /^(.*)@(\d+)$/.exec(ref);
  if (!match) {
    if (!ref) throw new Error("workflow ref must not be empty");
    return { name: ref };
  }
  const [, name, versionText] = match;
  if (!name || !versionText) throw new Error(`invalid saved workflow ref ${ref}`);
  const version = Number(versionText);
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error(`invalid saved workflow ref ${ref}`);
  return { name, version };
}

function encodeApprovalId(runId: string, stableKey: string): string {
  return `${runId}:${stableKey}`;
}

function decodeApprovalId(approvalId: string): { runId: string; stableKey: string } {
  const separator = approvalId.indexOf(":");
  if (separator < 1 || separator === approvalId.length - 1) {
    throw new Error("approvalId must be the value returned by get_run_blockage");
  }
  return { runId: approvalId.slice(0, separator), stableKey: approvalId.slice(separator + 1) };
}
