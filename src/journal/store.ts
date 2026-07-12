// JournalStore — the durable substrate (DESIGN.md §8, Appendix A).
//
// The single-writer daemon owns one of these; clients never touch SQLite
// directly (L3). This class is deliberately low-level: it persists and reads
// rows and exposes one transaction primitive. Memoization/resume logic lives in
// the kernel (Phase 2), not here.

import { Database } from "bun:sqlite";
import { canonicalJson } from "../hash.ts";
import { applyMigration } from "./migrations.ts";
import { DDL, SCHEMA_VERSION } from "./schema.ts";
import type {
  AgentProfileCatalogRow,
  AgentSessionRow,
  AgentSessionTurnRow,
  AgentWorkspaceRow,
  AgentWorkspaceStatus,
  ArtifactRow,
  CapabilityRow,
  DaemonSettingCatalogRow,
  EventRow,
  InputDep,
  JournalRow,
  NewCapabilityRow,
  NewJournalRow,
  NewRunRow,
  NewWorkflowDefinitionRow,
  RunProfileSnapshotRow,
  RunProfileSnapshotSetRow,
  RunRow,
  RunSettingSnapshotRow,
  RunSettingSnapshotSetRow,
  SavedWorkflowRow,
  SavedWorkflowVersionRow,
  ScheduleRow,
  WorkflowDefinitionRow,
} from "./types.ts";

const SAVED_WORKFLOW_NAME_RE = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/;

export interface SavedWorkflowVersionView {
  name: string;
  version: number;
  definitionHash: string;
  workflowName: string | null;
  inputSchema: unknown | null;
  inputSchemaSet: boolean;
  defaultInput: unknown | null;
  defaultInputSet: boolean;
  defaultTarget: string | null;
  metadata: unknown | null;
  sourceProvenance: unknown | null;
  createdBy: string | null;
  createdAtMs: number;
  enabled: boolean;
  deprecatedAtMs: number | null;
  deprecationMessage: string | null;
  deletedAtMs: number | null;
}

export interface SavedWorkflowView {
  name: string;
  title: string | null;
  description: string | null;
  tags: string[];
  createdAtMs: number;
  updatedAtMs: number;
  disabledAtMs: number | null;
  deletedAtMs: number | null;
  versions: SavedWorkflowVersionView[];
}

export interface SavedWorkflowSummary extends SavedWorkflowView {
  latestVersion: number | null;
  latestDefinitionHash: string | null;
}

export class JournalStore {
  readonly db: Database;
  private readonly eventListeners = new Set<(event: EventRow) => void>();
  private transactionDepth = 0;
  private pendingEventNotifications: EventRow[] = [];

  private constructor(db: Database) {
    this.db = db;
    this.migrate();
  }

  /** Open (or create) a file-backed journal in WAL mode at a stable path. */
  static open(path: string): JournalStore {
    const db = new Database(path, { create: true });
    // WAL is what makes a single-writer + many-reader file safe (L11). The
    // daemon's exclusive-writer property is enforced above this layer.
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    return new JournalStore(db);
  }

  /** In-memory journal for tests. */
  static memory(): JournalStore {
    const db = new Database(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    return new JournalStore(db);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    // Base DDL creates any missing tables at the current shape; it is a no-op for
    // tables that already exist (CREATE TABLE IF NOT EXISTS).
    this.db.exec(DDL);
    const row = this.db
      .query<{ value: string }, [string]>("SELECT value FROM schema_meta WHERE key = ?")
      .get("schema_version");
    if (row === null) {
      // Fresh DB — base DDL already built everything at the current version.
      this.db
        .query("INSERT INTO schema_meta (key, value) VALUES (?, ?)")
        .run("schema_version", String(SCHEMA_VERSION));
      return;
    }
    let version = Number(row.value);
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `journal is newer (v${version}) than this code (v${SCHEMA_VERSION}); cannot downgrade`,
      );
    }
    // Migrate forward additively (no data loss) rather than refusing to open.
    this.transaction(() => {
      while (version < SCHEMA_VERSION) {
        applyMigration(this.db, version);
        version += 1;
      }
      if (Number(row.value) !== SCHEMA_VERSION) {
        this.db
          .query("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'")
          .run(String(SCHEMA_VERSION));
      }
    });
  }

  /**
   * Run `fn` inside a single SQLite transaction. If `fn` throws, the
   * transaction rolls back and no partial rows persist (Phase 1 exit criterion).
   */
  transaction<T>(fn: () => T): T {
    const outermost = this.transactionDepth === 0;
    const notificationStart = this.pendingEventNotifications.length;
    this.transactionDepth += 1;
    let committed = false;
    try {
      const result = this.db.transaction(fn)();
      committed = true;
      return result;
    } finally {
      this.transactionDepth -= 1;
      if (!committed) {
        this.pendingEventNotifications.length = notificationStart;
      }
      if (outermost) {
        if (committed) this.flushPendingEventNotifications();
        else this.pendingEventNotifications = [];
      }
    }
  }

  onEventAppended(listener: (event: EventRow) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  // ---- runs ---------------------------------------------------------------

  insertRun(row: NewRunRow): void {
    this.db
      .query(
        `INSERT INTO runs (
           run_id, workflow_name, definition_version, workflow_ref, run_target, status, parent_run_id,
           tenant_id, input_ref, output_ref, error_json, heartbeat_at_ms,
           runtime_owner_id, created_at_ms, finished_at_ms
         ) VALUES (
           $runId, $workflowName, $definitionVersion, $workflowRef, $runTarget, $status, $parentRunId,
           $tenantId, $inputRef, $outputRef, $errorJson, $heartbeatAtMs,
           $runtimeOwnerId, $createdAtMs, $finishedAtMs
         )`,
      )
      .run({
        $runId: row.runId,
        $workflowName: row.workflowName,
        $definitionVersion: row.definitionVersion,
        $workflowRef: row.workflowRef ?? null,
        $runTarget: row.runTarget ?? null,
        $status: row.status,
        $parentRunId: row.parentRunId,
        $tenantId: row.tenantId,
        $inputRef: row.inputRef,
        $outputRef: row.outputRef,
        $errorJson: row.errorJson,
        $heartbeatAtMs: row.heartbeatAtMs,
        $runtimeOwnerId: row.runtimeOwnerId,
        $createdAtMs: row.createdAtMs,
        $finishedAtMs: row.finishedAtMs ?? null,
      });
  }

  getRun(runId: string): RunRow | null {
    const r = this.db.query<RawRunRow, [string]>("SELECT * FROM runs WHERE run_id = ?").get(runId);
    return r ? mapRun(r) : null;
  }

  /** Patch a subset of mutable run columns. */
  updateRun(
    runId: string,
    patch: Partial<
      Pick<
        RunRow,
        | "status"
        | "workflowName"
        | "runTarget"
        | "inputRef"
        | "outputRef"
        | "errorJson"
        | "heartbeatAtMs"
        | "runtimeOwnerId"
        | "finishedAtMs"
      >
    >,
  ): void {
    const sets: string[] = [];
    type Bind = string | number | bigint | boolean | null | Uint8Array;
    const params: Record<string, Bind> = { $runId: runId };
    const add = (col: string, key: string, val: Bind) => {
      sets.push(`${col} = $${key}`);
      params[`$${key}`] = val;
    };
    if ("status" in patch) add("status", "status", patch.status ?? null);
    if ("workflowName" in patch) add("workflow_name", "workflowName", patch.workflowName ?? null);
    if ("runTarget" in patch) add("run_target", "runTarget", patch.runTarget ?? null);
    if ("inputRef" in patch) add("input_ref", "inputRef", patch.inputRef ?? null);
    if ("outputRef" in patch) add("output_ref", "outputRef", patch.outputRef ?? null);
    if ("errorJson" in patch) add("error_json", "errorJson", patch.errorJson ?? null);
    if ("heartbeatAtMs" in patch)
      add("heartbeat_at_ms", "heartbeatAtMs", patch.heartbeatAtMs ?? null);
    if ("runtimeOwnerId" in patch)
      add("runtime_owner_id", "runtimeOwnerId", patch.runtimeOwnerId ?? null);
    if ("finishedAtMs" in patch) add("finished_at_ms", "finishedAtMs", patch.finishedAtMs ?? null);
    if (sets.length === 0) return;
    this.db.query(`UPDATE runs SET ${sets.join(", ")} WHERE run_id = $runId`).run(params);
  }

  listRuns(): RunRow[] {
    return this.db
      .query<RawRunRow, []>("SELECT * FROM runs ORDER BY created_at_ms DESC, run_id DESC")
      .all()
      .map(mapRun);
  }

  listRunsPage(limit: number): { runs: RunRow[]; total: number } {
    const runs = this.db
      .query<RawRunRow, [number]>(
        "SELECT * FROM runs ORDER BY created_at_ms DESC, run_id DESC LIMIT ?",
      )
      .all(limit)
      .map(mapRun);
    const total = this.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM runs").get()?.c ?? 0;
    return { runs, total };
  }

  listRunsByStatus(status: RunRow["status"]): RunRow[] {
    return this.db
      .query<RawRunRow, [string]>("SELECT * FROM runs WHERE status = ? ORDER BY created_at_ms ASC")
      .all(status)
      .map(mapRun);
  }

  updateRunDefinition(runId: string, definitionVersion: string, workflowRef: string | null): void {
    this.db
      .query("UPDATE runs SET definition_version = ?, workflow_ref = ? WHERE run_id = ?")
      .run(definitionVersion, workflowRef, runId);
  }

  /**
   * Compare-and-set ownership fence (DESIGN.md §6.3/§7.4). Claim a run for
   * `ownerId` only if it is currently unowned, already ours, or owned by a stale
   * owner (heartbeat older than `staleBeforeMs`). Returns true if we now own it.
   */
  claimRun(runId: string, ownerId: string, staleBeforeMs: number, atMs: number): boolean {
    const res = this.db
      .query(
        `UPDATE runs SET runtime_owner_id = $owner, heartbeat_at_ms = $now
         WHERE run_id = $runId
           AND (runtime_owner_id IS NULL
                OR runtime_owner_id = $owner
                OR heartbeat_at_ms IS NULL
                OR heartbeat_at_ms < $stale)`,
      )
      .run({ $owner: ownerId, $now: atMs, $runId: runId, $stale: staleBeforeMs });
    return res.changes > 0;
  }

  /** Refresh the heartbeat for runs this owner drives (liveness fence). */
  heartbeat(runId: string, ownerId: string, atMs: number): void {
    this.db
      .query("UPDATE runs SET heartbeat_at_ms = ? WHERE run_id = ? AND runtime_owner_id = ?")
      .run(atMs, runId, ownerId);
  }

  // ---- journal ------------------------------------------------------------

  /** Upsert a journal row by (run_id, stable_key, attempt). */
  putJournalRow(row: NewJournalRow): void {
    const full = withJournalDefaults(row);
    // Assign a per-run monotonic seq on first insert; DO UPDATE keeps it.
    const nextSeq =
      (this.db
        .query<{ m: number | null }, [string]>("SELECT MAX(seq) AS m FROM journal WHERE run_id = ?")
        .get(full.runId)?.m ?? 0) + 1;
    this.db
      .query(
        `INSERT INTO journal (
           run_id, stable_key, attempt, seq, effect_type, status, version,
           input_hash, input_deps_json, key_set_hash, result_inline,
           result_artifact, session_token, error_json, started_at_ms,
           finished_at_ms
         ) VALUES (
           $runId, $stableKey, $attempt, $seq, $effectType, $status, $version,
           $inputHash, $inputDepsJson, $keySetHash, $resultInline,
           $resultArtifact, $sessionToken, $errorJson, $startedAtMs,
           $finishedAtMs
         )
         ON CONFLICT (run_id, stable_key, attempt) DO UPDATE SET
           effect_type     = excluded.effect_type,
           status          = excluded.status,
           version         = excluded.version,
           input_hash      = excluded.input_hash,
           input_deps_json = excluded.input_deps_json,
           key_set_hash    = excluded.key_set_hash,
           result_inline   = excluded.result_inline,
           result_artifact = excluded.result_artifact,
           session_token   = excluded.session_token,
           error_json      = excluded.error_json,
           started_at_ms   = excluded.started_at_ms,
           finished_at_ms  = excluded.finished_at_ms`,
      )
      .run({
        $runId: full.runId,
        $stableKey: full.stableKey,
        $attempt: full.attempt,
        $seq: nextSeq,
        $effectType: full.effectType,
        $status: full.status,
        $version: full.version,
        $inputHash: full.inputHash,
        $inputDepsJson: full.inputDeps ? JSON.stringify(full.inputDeps) : null,
        $keySetHash: full.keySetHash,
        $resultInline: full.resultInline,
        $resultArtifact: full.resultArtifact,
        $sessionToken: full.sessionToken,
        $errorJson: full.errorJson,
        $startedAtMs: full.startedAtMs,
        $finishedAtMs: full.finishedAtMs,
      });
  }

  getJournalRow(runId: string, stableKey: string, attempt: number): JournalRow | null {
    const r = this.db
      .query<RawJournalRow, [string, string, number]>(
        "SELECT * FROM journal WHERE run_id = ? AND stable_key = ? AND attempt = ?",
      )
      .get(runId, stableKey, attempt);
    return r ? mapJournal(r) : null;
  }

  /** The highest-attempt row for a key — the one memoization consults (§5.5). */
  getLatestAttempt(runId: string, stableKey: string): JournalRow | null {
    const r = this.db
      .query<RawJournalRow, [string, string]>(
        `SELECT * FROM journal WHERE run_id = ? AND stable_key = ?
         ORDER BY attempt DESC LIMIT 1`,
      )
      .get(runId, stableKey);
    return r ? mapJournal(r) : null;
  }

  listJournalRows(runId: string): JournalRow[] {
    return this.db
      .query<RawJournalRow, [string]>(
        "SELECT * FROM journal WHERE run_id = ? ORDER BY stable_key, attempt",
      )
      .all(runId)
      .map(mapJournal);
  }

  // ---- events -------------------------------------------------------------

  // ---- agent sessions -----------------------------------------------------

  hasAgentSessions(runId: string): boolean {
    const row = this.db
      .query<{ c: number }, [string]>(
        "SELECT COUNT(*) AS c FROM agent_sessions WHERE run_id = ? LIMIT 1",
      )
      .get(runId);
    return (row?.c ?? 0) > 0;
  }

  getAgentSession(runId: string, agentKey: string): AgentSessionRow | null {
    const r = this.db
      .query<RawAgentSessionRow, [string, string]>(
        "SELECT * FROM agent_sessions WHERE run_id = ? AND agent_key = ?",
      )
      .get(runId, agentKey);
    return r ? mapAgentSession(r) : null;
  }

  hasAgentSessionUsingWorkspace(runId: string, workspaceId: string): boolean {
    const rows = this.db
      .query<{ identity_json: string }, [string]>(
        "SELECT identity_json FROM agent_sessions WHERE run_id = ?",
      )
      .all(runId);
    return rows.some((row) => {
      try {
        const identity = JSON.parse(row.identity_json) as { workspaceId?: unknown };
        return identity.workspaceId === workspaceId;
      } catch {
        return false;
      }
    });
  }

  insertAgentSession(row: AgentSessionRow): void {
    this.db
      .query(
        `INSERT INTO agent_sessions (
           run_id, agent_key, identity_hash, identity_json, current_session_token,
           latest_completed_turn_key, latest_completed_attempt,
           active_turn_key, active_turn_attempt, created_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.runId,
        row.agentKey,
        row.identityHash,
        row.identityJson,
        row.currentSessionToken,
        row.latestCompletedTurnKey,
        row.latestCompletedAttempt,
        row.activeTurnKey,
        row.activeTurnAttempt,
        row.createdAtMs,
        row.updatedAtMs,
      );
  }

  updateAgentSessionActive(
    runId: string,
    agentKey: string,
    activeTurnKey: string | null,
    activeTurnAttempt: number | null,
    atMs: number,
  ): void {
    this.db
      .query(
        `UPDATE agent_sessions
         SET active_turn_key = ?, active_turn_attempt = ?, updated_at_ms = ?
         WHERE run_id = ? AND agent_key = ?`,
      )
      .run(activeTurnKey, activeTurnAttempt, atMs, runId, agentKey);
  }

  completeAgentSession(
    runId: string,
    agentKey: string,
    turnKey: string,
    attempt: number,
    token: string,
    atMs: number,
  ): void {
    this.db
      .query(
        `UPDATE agent_sessions
         SET current_session_token = ?,
             latest_completed_turn_key = ?,
             latest_completed_attempt = ?,
             active_turn_key = NULL,
             active_turn_attempt = NULL,
             updated_at_ms = ?
         WHERE run_id = ? AND agent_key = ?`,
      )
      .run(token, turnKey, attempt, atMs, runId, agentKey);
  }

  getLatestAgentSessionTurn(
    runId: string,
    agentKey: string,
    turnKey: string,
  ): AgentSessionTurnRow | null {
    const r = this.db
      .query<RawAgentSessionTurnRow, [string, string, string]>(
        `SELECT * FROM agent_session_turns
         WHERE run_id = ? AND agent_key = ? AND turn_key = ?
         ORDER BY attempt DESC LIMIT 1`,
      )
      .get(runId, agentKey, turnKey);
    return r ? mapAgentSessionTurn(r) : null;
  }

  putAgentSessionTurn(row: AgentSessionTurnRow): void {
    this.db
      .query(
        `INSERT INTO agent_session_turns (
           run_id, agent_key, turn_key, attempt, stable_key, status,
           started_session_token, observed_session_token, completed_session_token,
           started_at_ms, finished_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, agent_key, turn_key, attempt) DO UPDATE SET
           stable_key = excluded.stable_key,
           status = excluded.status,
           started_session_token = excluded.started_session_token,
           observed_session_token = COALESCE(agent_session_turns.observed_session_token, excluded.observed_session_token),
           completed_session_token = excluded.completed_session_token,
           started_at_ms = COALESCE(agent_session_turns.started_at_ms, excluded.started_at_ms),
           finished_at_ms = excluded.finished_at_ms`,
      )
      .run(
        row.runId,
        row.agentKey,
        row.turnKey,
        row.attempt,
        row.stableKey,
        row.status,
        row.startedSessionToken,
        row.observedSessionToken,
        row.completedSessionToken,
        row.startedAtMs,
        row.finishedAtMs,
      );
  }

  recordAgentSessionTurnToken(
    runId: string,
    agentKey: string,
    turnKey: string,
    attempt: number,
    token: string,
  ): void {
    this.db
      .query(
        `UPDATE agent_session_turns
         SET observed_session_token = ?
         WHERE run_id = ? AND agent_key = ? AND turn_key = ? AND attempt = ? AND status = 'pending'`,
      )
      .run(token, runId, agentKey, turnKey, attempt);
  }

  completeAgentSessionTurn(
    runId: string,
    agentKey: string,
    turnKey: string,
    attempt: number,
    token: string,
    atMs: number,
  ): void {
    this.db
      .query(
        `UPDATE agent_session_turns
         SET status = 'completed',
             completed_session_token = ?,
             finished_at_ms = ?
         WHERE run_id = ? AND agent_key = ? AND turn_key = ? AND attempt = ?`,
      )
      .run(token, atMs, runId, agentKey, turnKey, attempt);
  }

  failAgentSessionTurn(
    runId: string,
    agentKey: string,
    turnKey: string,
    attempt: number,
    atMs: number,
  ): void {
    this.db
      .query(
        `UPDATE agent_session_turns
         SET status = 'failed',
             finished_at_ms = ?
         WHERE run_id = ? AND agent_key = ? AND turn_key = ? AND attempt = ?`,
      )
      .run(atMs, runId, agentKey, turnKey, attempt);
    this.updateAgentSessionActive(runId, agentKey, null, null, atMs);
  }

  getAgentWorkspace(runId: string, workspaceId: string): AgentWorkspaceRow | null {
    const r = this.db
      .query<RawAgentWorkspaceRow, [string, string]>(
        "SELECT * FROM agent_workspaces WHERE run_id = ? AND workspace_id = ?",
      )
      .get(runId, workspaceId);
    return r ? mapAgentWorkspace(r) : null;
  }

  getAgentWorkspaceByKey(
    runId: string,
    ownerKind: AgentWorkspaceRow["ownerKind"],
    key: string,
  ): AgentWorkspaceRow | null {
    const r = this.db
      .query<RawAgentWorkspaceRow, [string, string, string]>(
        "SELECT * FROM agent_workspaces WHERE run_id = ? AND owner_kind = ? AND key = ?",
      )
      .get(runId, ownerKind, key);
    return r ? mapAgentWorkspace(r) : null;
  }

  listAgentWorkspaces(runId: string, opts: { includeRemoved?: boolean } = {}): AgentWorkspaceRow[] {
    const sql = opts.includeRemoved
      ? "SELECT * FROM agent_workspaces WHERE run_id = ? ORDER BY owner_kind ASC, key ASC, workspace_id ASC"
      : `SELECT * FROM agent_workspaces
         WHERE run_id = ?
           AND status != 'removed'
           AND (owned != 0 OR failure_seen != 0 OR cleanup_error_json IS NOT NULL OR status NOT IN ('idle'))
         ORDER BY owner_kind ASC, key ASC, workspace_id ASC`;
    return this.db.query<RawAgentWorkspaceRow, [string]>(sql).all(runId).map(mapAgentWorkspace);
  }

  listAllAgentWorkspaces(): AgentWorkspaceRow[] {
    return this.db
      .query<RawAgentWorkspaceRow, []>(
        "SELECT * FROM agent_workspaces ORDER BY run_id ASC, owner_kind ASC, key ASC, workspace_id ASC",
      )
      .all()
      .map(mapAgentWorkspace);
  }

  hasPendingAgentSessionTurn(runId: string, agentKey: string): boolean {
    const row = this.db
      .query<{ c: number }, [string, string]>(
        `SELECT COUNT(*) AS c FROM agent_session_turns
         WHERE run_id = ? AND agent_key = ? AND status = 'pending'`,
      )
      .get(runId, agentKey);
    return (row?.c ?? 0) > 0;
  }

  insertAgentWorkspace(
    row: Omit<
      AgentWorkspaceRow,
      | "sourceKind"
      | "sourceUri"
      | "sourceBare"
      | "sourceMergeEligible"
      | "resolvedRef"
      | "checkoutBranch"
      | "worktreeCheckoutKind"
      | "worktreeBranchOwned"
      | "copyBaselinePath"
      | "creationErrorJson"
      | "setupIdentityJson"
      | "setupIdentityHash"
      | "setupStatus"
      | "setupStartedAtMs"
      | "setupFinishedAtMs"
      | "setupErrorJson"
    > &
      Partial<
        Pick<
          AgentWorkspaceRow,
          | "sourceKind"
          | "sourceUri"
          | "sourceBare"
          | "sourceMergeEligible"
          | "resolvedRef"
          | "checkoutBranch"
          | "worktreeCheckoutKind"
          | "worktreeBranchOwned"
          | "copyBaselinePath"
          | "creationErrorJson"
          | "setupIdentityJson"
          | "setupIdentityHash"
          | "setupStatus"
          | "setupStartedAtMs"
          | "setupFinishedAtMs"
          | "setupErrorJson"
        >
      >,
  ): void {
    const full = withAgentWorkspaceDefaults(row);
    this.db
      .query(
        `INSERT INTO agent_workspaces (
          run_id, workspace_id, mode, owner_kind, key, last_attempt, retention_policy,
          workspace_path, source_kind, source_path, source_uri, source_bare, source_merge_eligible,
          supplied_path, source_ref, resolved_ref, checkout_branch, worktree_checkout_kind,
          worktree_branch_owned, base_commit, copy_baseline_path,
          creation_error_json, workspace_identity_json, workspace_identity_hash,
          setup_identity_json, setup_identity_hash, setup_status, setup_started_at_ms,
          setup_finished_at_ms, setup_error_json, owned, status, failure_seen,
          last_turn_key, last_turn_attempt, active_holder_kind, active_holder_key,
          active_holder_attempt, active_started_at_ms, last_diff_event_seq, last_error_event_seq,
          cleanup_error_json, created_at_ms, updated_at_ms, merged_at_ms, discarded_at_ms, removed_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        full.runId,
        full.workspaceId,
        full.mode,
        full.ownerKind,
        full.key,
        full.lastAttempt,
        full.retentionPolicy,
        full.workspacePath,
        full.sourceKind,
        full.sourcePath,
        full.sourceUri,
        full.sourceBare == null ? null : full.sourceBare ? 1 : 0,
        full.sourceMergeEligible ? 1 : 0,
        full.suppliedPath,
        full.sourceRef,
        full.resolvedRef,
        full.checkoutBranch,
        full.worktreeCheckoutKind,
        full.worktreeBranchOwned ? 1 : 0,
        full.baseCommit,
        full.copyBaselinePath,
        full.creationErrorJson,
        full.workspaceIdentityJson,
        full.workspaceIdentityHash,
        full.setupIdentityJson,
        full.setupIdentityHash,
        full.setupStatus,
        full.setupStartedAtMs,
        full.setupFinishedAtMs,
        full.setupErrorJson,
        full.owned ? 1 : 0,
        full.status,
        full.failureSeen ? 1 : 0,
        full.lastTurnKey,
        full.lastTurnAttempt,
        full.activeHolderKind,
        full.activeHolderKey,
        full.activeHolderAttempt,
        full.activeStartedAtMs,
        full.lastDiffEventSeq,
        full.lastErrorEventSeq,
        full.cleanupErrorJson,
        full.createdAtMs,
        full.updatedAtMs,
        full.mergedAtMs,
        full.discardedAtMs,
        full.removedAtMs,
      );
  }

  deleteAgentWorkspace(runId: string, workspaceId: string): void {
    this.db
      .query("DELETE FROM agent_workspaces WHERE run_id = ? AND workspace_id = ?")
      .run(runId, workspaceId);
  }

  updateAgentWorkspace(
    runId: string,
    workspaceId: string,
    patch: Partial<
      Pick<
        AgentWorkspaceRow,
        | "status"
        | "lastAttempt"
        | "retentionPolicy"
        | "workspacePath"
        | "sourceKind"
        | "sourcePath"
        | "sourceUri"
        | "sourceBare"
        | "sourceMergeEligible"
        | "suppliedPath"
        | "sourceRef"
        | "resolvedRef"
        | "checkoutBranch"
        | "worktreeCheckoutKind"
        | "worktreeBranchOwned"
        | "baseCommit"
        | "copyBaselinePath"
        | "creationErrorJson"
        | "workspaceIdentityJson"
        | "workspaceIdentityHash"
        | "setupIdentityJson"
        | "setupIdentityHash"
        | "setupStatus"
        | "setupStartedAtMs"
        | "setupFinishedAtMs"
        | "setupErrorJson"
        | "owned"
        | "failureSeen"
        | "lastTurnKey"
        | "lastTurnAttempt"
        | "activeHolderKind"
        | "activeHolderKey"
        | "activeHolderAttempt"
        | "activeStartedAtMs"
        | "lastDiffEventSeq"
        | "lastErrorEventSeq"
        | "cleanupErrorJson"
        | "updatedAtMs"
        | "mergedAtMs"
        | "discardedAtMs"
        | "removedAtMs"
      >
    >,
  ): void {
    const sets: string[] = [];
    type Bind = string | number | bigint | boolean | null | Uint8Array;
    const params: Record<string, Bind> = { $runId: runId, $workspaceId: workspaceId };
    const add = (col: string, key: string, val: Bind) => {
      sets.push(`${col} = $${key}`);
      params[`$${key}`] = val;
    };
    if ("status" in patch) add("status", "status", patch.status ?? null);
    if ("lastAttempt" in patch) add("last_attempt", "lastAttempt", patch.lastAttempt ?? null);
    if ("retentionPolicy" in patch)
      add("retention_policy", "retentionPolicy", patch.retentionPolicy ?? null);
    if ("workspacePath" in patch)
      add("workspace_path", "workspacePath", patch.workspacePath ?? null);
    if ("sourceKind" in patch) add("source_kind", "sourceKind", patch.sourceKind ?? null);
    if ("sourcePath" in patch) add("source_path", "sourcePath", patch.sourcePath ?? null);
    if ("sourceUri" in patch) add("source_uri", "sourceUri", patch.sourceUri ?? null);
    if ("sourceBare" in patch)
      add("source_bare", "sourceBare", patch.sourceBare == null ? null : patch.sourceBare ? 1 : 0);
    if ("sourceMergeEligible" in patch)
      add("source_merge_eligible", "sourceMergeEligible", patch.sourceMergeEligible ? 1 : 0);
    if ("suppliedPath" in patch) add("supplied_path", "suppliedPath", patch.suppliedPath ?? null);
    if ("sourceRef" in patch) add("source_ref", "sourceRef", patch.sourceRef ?? null);
    if ("resolvedRef" in patch) add("resolved_ref", "resolvedRef", patch.resolvedRef ?? null);
    if ("checkoutBranch" in patch)
      add("checkout_branch", "checkoutBranch", patch.checkoutBranch ?? null);
    if ("worktreeCheckoutKind" in patch)
      add("worktree_checkout_kind", "worktreeCheckoutKind", patch.worktreeCheckoutKind ?? null);
    if ("worktreeBranchOwned" in patch)
      add("worktree_branch_owned", "worktreeBranchOwned", patch.worktreeBranchOwned ? 1 : 0);
    if ("baseCommit" in patch) add("base_commit", "baseCommit", patch.baseCommit ?? null);
    if ("copyBaselinePath" in patch)
      add("copy_baseline_path", "copyBaselinePath", patch.copyBaselinePath ?? null);
    if ("creationErrorJson" in patch)
      add("creation_error_json", "creationErrorJson", patch.creationErrorJson ?? null);
    if ("workspaceIdentityJson" in patch)
      add("workspace_identity_json", "workspaceIdentityJson", patch.workspaceIdentityJson ?? null);
    if ("workspaceIdentityHash" in patch)
      add("workspace_identity_hash", "workspaceIdentityHash", patch.workspaceIdentityHash ?? null);
    if ("setupIdentityJson" in patch)
      add("setup_identity_json", "setupIdentityJson", patch.setupIdentityJson ?? null);
    if ("setupIdentityHash" in patch)
      add("setup_identity_hash", "setupIdentityHash", patch.setupIdentityHash ?? null);
    if ("setupStatus" in patch) add("setup_status", "setupStatus", patch.setupStatus ?? null);
    if ("setupStartedAtMs" in patch)
      add("setup_started_at_ms", "setupStartedAtMs", patch.setupStartedAtMs ?? null);
    if ("setupFinishedAtMs" in patch)
      add("setup_finished_at_ms", "setupFinishedAtMs", patch.setupFinishedAtMs ?? null);
    if ("setupErrorJson" in patch)
      add("setup_error_json", "setupErrorJson", patch.setupErrorJson ?? null);
    if ("owned" in patch) add("owned", "owned", patch.owned ? 1 : 0);
    if ("failureSeen" in patch) add("failure_seen", "failureSeen", patch.failureSeen ? 1 : 0);
    if ("lastTurnKey" in patch) add("last_turn_key", "lastTurnKey", patch.lastTurnKey ?? null);
    if ("lastTurnAttempt" in patch)
      add("last_turn_attempt", "lastTurnAttempt", patch.lastTurnAttempt ?? null);
    if ("activeHolderKind" in patch)
      add("active_holder_kind", "activeHolderKind", patch.activeHolderKind ?? null);
    if ("activeHolderKey" in patch)
      add("active_holder_key", "activeHolderKey", patch.activeHolderKey ?? null);
    if ("activeHolderAttempt" in patch)
      add("active_holder_attempt", "activeHolderAttempt", patch.activeHolderAttempt ?? null);
    if ("activeStartedAtMs" in patch)
      add("active_started_at_ms", "activeStartedAtMs", patch.activeStartedAtMs ?? null);
    if ("lastDiffEventSeq" in patch)
      add("last_diff_event_seq", "lastDiffEventSeq", patch.lastDiffEventSeq ?? null);
    if ("lastErrorEventSeq" in patch)
      add("last_error_event_seq", "lastErrorEventSeq", patch.lastErrorEventSeq ?? null);
    if ("cleanupErrorJson" in patch)
      add("cleanup_error_json", "cleanupErrorJson", patch.cleanupErrorJson ?? null);
    if ("updatedAtMs" in patch) add("updated_at_ms", "updatedAtMs", patch.updatedAtMs ?? null);
    if ("mergedAtMs" in patch) add("merged_at_ms", "mergedAtMs", patch.mergedAtMs ?? null);
    if ("discardedAtMs" in patch)
      add("discarded_at_ms", "discardedAtMs", patch.discardedAtMs ?? null);
    if ("removedAtMs" in patch) add("removed_at_ms", "removedAtMs", patch.removedAtMs ?? null);
    if (sets.length === 0) return;
    this.db
      .query(
        `UPDATE agent_workspaces SET ${sets.join(", ")} WHERE run_id = $runId AND workspace_id = $workspaceId`,
      )
      .run(params);
  }

  reopenPendingReviewWorkspaces(runId: string, atMs: number): void {
    this.db
      .query(
        `UPDATE agent_workspaces
         SET status = 'idle', updated_at_ms = ?
         WHERE run_id = ? AND status = 'pending_review'`,
      )
      .run(atMs, runId);
  }

  gcWorkspaceRows(statuses: AgentWorkspaceStatus[], olderThanMs: number): AgentWorkspaceRow[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    const query = this.db.query<RawAgentWorkspaceRow, never>(
      `SELECT * FROM agent_workspaces
       WHERE owned != 0 AND status IN (${placeholders}) AND updated_at_ms <= ?
       ORDER BY updated_at_ms ASC`,
    );
    return (query.all as (...args: unknown[]) => RawAgentWorkspaceRow[])(
      ...statuses,
      olderThanMs,
    ).map(mapAgentWorkspace);
  }

  /** Append an event; returns the assigned per-run sequence number. */
  appendEvent(runId: string, type: string, payload: unknown, atMs: number): number {
    const payloadJson = JSON.stringify(payload ?? null);
    const next = this.db
      .query<{ next: number }, [string]>(
        "SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE run_id = ?",
      )
      .get(runId);
    const seq = next?.next ?? 1;
    this.db
      .query(
        `INSERT INTO events (run_id, seq, type, payload_json, emitted_at_ms)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(runId, seq, type, payloadJson, atMs);
    this.notifyEventAppended({ runId, seq, type, payloadJson, emittedAtMs: atMs });
    return seq;
  }

  listEvents(runId: string, afterSeq = 0): EventRow[] {
    return this.db
      .query<RawEventRow, [string, number]>(
        "SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq",
      )
      .all(runId, afterSeq)
      .map(mapEvent);
  }

  eventHighWater(runId: string): number {
    return (
      this.db
        .query<{ highWater: number | null }, [string]>(
          "SELECT MAX(seq) AS highWater FROM events WHERE run_id = ?",
        )
        .get(runId)?.highWater ?? 0
    );
  }

  eventTailFloor(runId: string, count: number): number {
    if (count === 0) return this.eventHighWater(runId);
    const rows = this.db
      .query<{ seq: number }, [string, number]>(
        "SELECT seq FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT ?",
      )
      .all(runId, count);
    if (rows.length === 0) return 0;
    let floorSeq = rows[0]?.seq ?? 0;
    for (const row of rows.slice(1)) {
      if (row.seq < floorSeq) floorSeq = row.seq;
    }
    return floorSeq > 0 ? floorSeq - 1 : 0;
  }

  private notifyEventAppended(event: EventRow): void {
    if (this.transactionDepth > 0) {
      this.pendingEventNotifications.push(event);
      return;
    }
    this.deliverEventNotification(event);
  }

  private flushPendingEventNotifications(): void {
    const events = this.pendingEventNotifications;
    this.pendingEventNotifications = [];
    for (const event of events) this.deliverEventNotification(event);
  }

  private deliverEventNotification(event: EventRow): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // Event delivery is best-effort and must not alter committed journal state.
      }
    }
  }

  // ---- artifacts (two-tier store, Phase 8) --------------------------------

  getArtifact(hash: string): ArtifactRow | null {
    const r = this.db
      .query<RawArtifactRow, [string]>("SELECT * FROM artifacts WHERE hash = ?")
      .get(hash);
    return r ? mapArtifact(r) : null;
  }

  /** Content-addressed put: insert a new blob (refCount 1) or bump the refCount
   * of an existing one (dedup). */
  putArtifact(hash: string, data: Uint8Array, atMs: number): void {
    const existing = this.db
      .query<{ ref_count: number }, [string]>("SELECT ref_count FROM artifacts WHERE hash = ?")
      .get(hash);
    if (existing) {
      this.db.query("UPDATE artifacts SET ref_count = ref_count + 1 WHERE hash = ?").run(hash);
    } else {
      this.db
        .query(
          "INSERT INTO artifacts (hash, byte_len, ref_count, created_at_ms, data) VALUES (?, ?, 1, ?, ?)",
        )
        .run(hash, data.byteLength, atMs, data);
    }
  }

  /** The raw bytes of an artifact, or null. */
  getArtifactData(hash: string): Uint8Array | null {
    const r = this.db
      .query<{ data: Uint8Array | null }, [string]>("SELECT data FROM artifacts WHERE hash = ?")
      .get(hash);
    return r?.data ?? null;
  }

  // ---- workflow definitions ---------------------------------------------

  putWorkflowDefinition(row: NewWorkflowDefinitionRow): void {
    this.db
      .query(
        `INSERT INTO workflow_definitions (
           hash, name, kind, code, source_map, manifest_json, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO NOTHING`,
      )
      .run(
        row.hash,
        row.name,
        row.kind,
        row.code,
        row.sourceMap,
        row.manifestJson,
        row.createdAtMs,
      );
  }

  getWorkflowDefinition(hash: string): WorkflowDefinitionRow | null {
    const r = this.db
      .query<RawWorkflowDefinitionRow, [string]>(
        "SELECT * FROM workflow_definitions WHERE hash = ?",
      )
      .get(hash);
    return r ? mapWorkflowDefinition(r) : null;
  }

  listActiveWorkflowDefinitionHashes(): string[] {
    return this.db
      .query<{ hash: string }, []>(
        `SELECT DISTINCT definition_version AS hash FROM runs
         WHERE status IN ('running', 'waiting-human', 'waiting-signal', 'waiting-timer', 'interrupted')`,
      )
      .all()
      .map((r) => r.hash);
  }

  pruneWorkflowDefinitions(opts: { nowMs: number; ttlMs: number }): number {
    const cutoff = opts.nowMs - opts.ttlMs;
    const removed =
      this.db
        .query<{ c: number }, [number]>(
          `SELECT COUNT(*) AS c FROM workflow_definitions
           WHERE created_at_ms < ?
             AND hash NOT IN (SELECT definition_version FROM runs)
             AND hash NOT IN (SELECT workflow_ref FROM schedules WHERE enabled = 1)
             AND hash NOT IN (
               SELECT definition_hash FROM saved_workflow_versions WHERE deleted_at_ms IS NULL
             )`,
        )
        .get(cutoff)?.c ?? 0;
    this.db
      .query(
        `DELETE FROM workflow_definitions
         WHERE created_at_ms < ?
           AND hash NOT IN (SELECT definition_version FROM runs)
           AND hash NOT IN (SELECT workflow_ref FROM schedules WHERE enabled = 1)
           AND hash NOT IN (
             SELECT definition_hash FROM saved_workflow_versions WHERE deleted_at_ms IS NULL
           )`,
      )
      .run(cutoff);
    return removed;
  }

  // ---- saved workflow registry ------------------------------------------

  putSavedWorkflowVersion(req: {
    name: string;
    version?: number;
    definition?: NewWorkflowDefinitionRow;
    definitionHash?: string;
    workflowName?: string | null;
    title?: string | null;
    description?: string | null;
    tags?: string[];
    inputSchema?: unknown;
    defaultInput?: unknown;
    defaultTarget?: string | null;
    metadata?: unknown;
    sourceProvenance?: unknown;
    createdBy?: string | null;
    createdAtMs: number;
    allowDuplicateDefinition?: boolean;
  }): SavedWorkflowVersionView {
    assertValidSavedWorkflowName(req.name);
    const definitionHash = req.definition?.hash ?? req.definitionHash;
    if (!definitionHash) throw new Error("saved workflow version requires definitionHash");
    return this.transaction(() => {
      if (req.definition) this.putWorkflowDefinition(req.definition);
      if (!this.getWorkflowDefinition(definitionHash)) {
        throw new Error(`workflow definition ${definitionHash} does not exist`);
      }
      const existing = this.getSavedWorkflowRow(req.name);
      const tagsJson =
        req.tags === undefined ? (existing?.tagsJson ?? null) : canonicalJson(req.tags);
      if (existing) {
        if (existing.deletedAtMs !== null) {
          throw new Error(`saved workflow "${req.name}" is deleted`);
        }
        this.db
          .query(
            `UPDATE saved_workflows
             SET title = ?, description = ?, tags_json = ?, updated_at_ms = ?
             WHERE name = ?`,
          )
          .run(
            req.title ?? existing.title,
            req.description ?? existing.description,
            tagsJson,
            req.createdAtMs,
            req.name,
          );
      } else {
        this.db
          .query(
            `INSERT INTO saved_workflows (
              name, title, description, tags_json, created_at_ms, updated_at_ms,
              disabled_at_ms, deleted_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
          )
          .run(
            req.name,
            req.title ?? null,
            req.description ?? null,
            tagsJson,
            req.createdAtMs,
            req.createdAtMs,
          );
      }
      const duplicate = this.db
        .query<{ version: number }, [string, string]>(
          `SELECT version FROM saved_workflow_versions
           WHERE name = ? AND definition_hash = ? AND deleted_at_ms IS NULL
           ORDER BY version ASC LIMIT 1`,
        )
        .get(req.name, definitionHash);
      if (duplicate && !req.allowDuplicateDefinition) {
        throw new Error(
          `saved workflow "${req.name}" already has definition ${definitionHash} at version ${duplicate.version}`,
        );
      }
      const version =
        req.version ??
        (this.db
          .query<{ version: number | null }, [string]>(
            "SELECT MAX(version) AS version FROM saved_workflow_versions WHERE name = ?",
          )
          .get(req.name)?.version ?? 0) + 1;
      if (!Number.isSafeInteger(version) || version <= 0) {
        throw new Error(`saved workflow version must be a positive integer, got ${version}`);
      }
      const existingVersion = this.getSavedWorkflowVersion(req.name, version);
      if (existingVersion) {
        throw new Error(`saved workflow "${req.name}" version ${version} already exists`);
      }
      this.db
        .query(
          `INSERT INTO saved_workflow_versions (
            name, version, definition_hash, workflow_name, input_schema_json,
            default_input_json, default_target, metadata_json, source_provenance_json,
            created_by, created_at_ms, enabled, deprecated_at_ms,
            deprecation_message, deleted_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL)`,
        )
        .run(
          req.name,
          version,
          definitionHash,
          req.workflowName ?? null,
          req.inputSchema === undefined ? null : canonicalJson(req.inputSchema),
          req.defaultInput === undefined ? null : canonicalJson(req.defaultInput),
          req.defaultTarget ?? null,
          req.metadata === undefined ? null : canonicalJson(req.metadata),
          req.sourceProvenance === undefined ? null : canonicalJson(req.sourceProvenance),
          req.createdBy ?? null,
          req.createdAtMs,
        );
      const saved = this.getSavedWorkflowVersion(req.name, version);
      if (!saved) throw new Error(`saved workflow "${req.name}" version ${version} was not saved`);
      return saved;
    });
  }

  listSavedWorkflows(
    opts: {
      includeDisabled?: boolean;
      includeDeprecated?: boolean;
      includeDeleted?: boolean;
    } = {},
  ): SavedWorkflowSummary[] {
    const workflows = this.db
      .query<RawSavedWorkflowRow, []>("SELECT * FROM saved_workflows ORDER BY name ASC")
      .all()
      .map(mapSavedWorkflow);
    const out: SavedWorkflowSummary[] = [];
    for (const workflow of workflows) {
      if (!opts.includeDeleted && workflow.deletedAtMs !== null) continue;
      if (!opts.includeDisabled && workflow.disabledAtMs !== null) continue;
      const versions = this.listSavedWorkflowVersionRows(workflow.name).filter((version) => {
        if (!opts.includeDeleted && version.deletedAtMs !== null) return false;
        if (!opts.includeDeprecated && version.deprecatedAtMs !== null) return false;
        return true;
      });
      let latest: SavedWorkflowVersionView | null = null;
      try {
        latest = this.resolveSavedWorkflowRef({
          name: workflow.name,
          version: "latest",
          allowDeprecated: opts.includeDeprecated,
        });
      } catch {
        latest = null;
      }
      out.push({
        ...savedWorkflowBaseView(workflow),
        latestVersion: latest?.version ?? null,
        latestDefinitionHash: latest?.definitionHash ?? null,
        versions,
      });
    }
    return out;
  }

  getSavedWorkflow(name: string): SavedWorkflowView | null {
    assertValidSavedWorkflowName(name);
    const row = this.getSavedWorkflowRow(name);
    if (!row) return null;
    return {
      ...savedWorkflowBaseView(row),
      versions: this.listSavedWorkflowVersionRows(name),
    };
  }

  getSavedWorkflowVersion(name: string, version: number): SavedWorkflowVersionView | null {
    assertValidSavedWorkflowName(name);
    const row = this.db
      .query<RawSavedWorkflowVersionRow, [string, number]>(
        "SELECT * FROM saved_workflow_versions WHERE name = ? AND version = ?",
      )
      .get(name, version);
    return row ? savedWorkflowVersionView(mapSavedWorkflowVersion(row)) : null;
  }

  resolveSavedWorkflowRef(ref: {
    name: string;
    version?: number | "latest";
    allowDeprecated?: boolean;
  }): SavedWorkflowVersionView {
    assertValidSavedWorkflowName(ref.name);
    const workflow = this.getSavedWorkflowRow(ref.name);
    if (!workflow || workflow.deletedAtMs !== null) {
      throw new Error(`saved workflow "${ref.name}" does not exist`);
    }
    if (workflow.disabledAtMs !== null) throw new Error(`saved workflow "${ref.name}" is disabled`);
    const version =
      ref.version === undefined || ref.version === "latest"
        ? this.db
            .query<RawSavedWorkflowVersionRow, [string]>(
              `SELECT * FROM saved_workflow_versions
               WHERE name = ?
                 AND enabled = 1
                 ${ref.allowDeprecated ? "" : "AND deprecated_at_ms IS NULL"}
                 AND deleted_at_ms IS NULL
               ORDER BY version DESC LIMIT 1`,
            )
            .get(ref.name)
        : this.db
            .query<RawSavedWorkflowVersionRow, [string, number]>(
              "SELECT * FROM saved_workflow_versions WHERE name = ? AND version = ?",
            )
            .get(ref.name, ref.version);
    if (!version) throw new Error(`saved workflow "${ref.name}" has no matching version`);
    const row = mapSavedWorkflowVersion(version);
    if (row.deletedAtMs !== null) {
      throw new Error(`saved workflow "${ref.name}" version ${row.version} is deleted`);
    }
    if (!row.enabled) {
      throw new Error(`saved workflow "${ref.name}" version ${row.version} is disabled`);
    }
    if (row.deprecatedAtMs !== null && !ref.allowDeprecated) {
      throw new Error(
        `saved workflow "${ref.name}" version ${row.version} is deprecated; pass allowDeprecated to launch it`,
      );
    }
    return savedWorkflowVersionView(row);
  }

  setSavedWorkflowDisabled(name: string, disabled: boolean, atMs = Date.now()): SavedWorkflowView {
    assertValidSavedWorkflowName(name);
    return this.transaction(() => {
      const row = this.getSavedWorkflowRow(name);
      if (!row || row.deletedAtMs !== null)
        throw new Error(`saved workflow "${name}" does not exist`);
      this.db
        .query("UPDATE saved_workflows SET disabled_at_ms = ?, updated_at_ms = ? WHERE name = ?")
        .run(disabled ? atMs : null, atMs, name);
      const saved = this.getSavedWorkflow(name);
      if (!saved) throw new Error(`saved workflow "${name}" does not exist`);
      return saved;
    });
  }

  setSavedWorkflowVersionEnabled(
    name: string,
    version: number,
    enabled: boolean,
  ): SavedWorkflowVersionView {
    assertValidSavedWorkflowName(name);
    return this.transaction(() => {
      const row = this.getSavedWorkflowVersion(name, version);
      if (!row || row.deletedAtMs !== null) {
        throw new Error(`saved workflow "${name}" version ${version} does not exist`);
      }
      this.db
        .query("UPDATE saved_workflow_versions SET enabled = ? WHERE name = ? AND version = ?")
        .run(enabled ? 1 : 0, name, version);
      const saved = this.getSavedWorkflowVersion(name, version);
      if (!saved) throw new Error(`saved workflow "${name}" version ${version} does not exist`);
      return saved;
    });
  }

  deprecateSavedWorkflowVersion(
    name: string,
    version: number,
    message: string | null | undefined,
    atMs = Date.now(),
  ): SavedWorkflowVersionView {
    assertValidSavedWorkflowName(name);
    return this.transaction(() => {
      const row = this.getSavedWorkflowVersion(name, version);
      if (!row || row.deletedAtMs !== null) {
        throw new Error(`saved workflow "${name}" version ${version} does not exist`);
      }
      this.db
        .query(
          `UPDATE saved_workflow_versions
           SET deprecated_at_ms = ?, deprecation_message = ?
           WHERE name = ? AND version = ?`,
        )
        .run(atMs, message ?? null, name, version);
      const saved = this.getSavedWorkflowVersion(name, version);
      if (!saved) throw new Error(`saved workflow "${name}" version ${version} does not exist`);
      return saved;
    });
  }

  deleteSavedWorkflow(name: string, atMs = Date.now()): SavedWorkflowView {
    assertValidSavedWorkflowName(name);
    return this.transaction(() => {
      const row = this.getSavedWorkflowRow(name);
      if (!row || row.deletedAtMs !== null)
        throw new Error(`saved workflow "${name}" does not exist`);
      this.db
        .query("UPDATE saved_workflows SET deleted_at_ms = ?, updated_at_ms = ? WHERE name = ?")
        .run(atMs, atMs, name);
      const saved = this.getSavedWorkflow(name);
      if (!saved) throw new Error(`saved workflow "${name}" does not exist`);
      return saved;
    });
  }

  deleteSavedWorkflowVersion(
    name: string,
    version: number,
    atMs = Date.now(),
  ): SavedWorkflowVersionView {
    assertValidSavedWorkflowName(name);
    return this.transaction(() => {
      const row = this.getSavedWorkflowVersion(name, version);
      if (!row || row.deletedAtMs !== null) {
        throw new Error(`saved workflow "${name}" version ${version} does not exist`);
      }
      this.db
        .query(
          "UPDATE saved_workflow_versions SET deleted_at_ms = ? WHERE name = ? AND version = ?",
        )
        .run(atMs, name, version);
      const saved = this.getSavedWorkflowVersion(name, version);
      if (!saved) throw new Error(`saved workflow "${name}" version ${version} does not exist`);
      return saved;
    });
  }

  private getSavedWorkflowRow(name: string): SavedWorkflowRow | null {
    const row = this.db
      .query<RawSavedWorkflowRow, [string]>("SELECT * FROM saved_workflows WHERE name = ?")
      .get(name);
    return row ? mapSavedWorkflow(row) : null;
  }

  private listSavedWorkflowVersionRows(name: string): SavedWorkflowVersionView[] {
    return this.db
      .query<RawSavedWorkflowVersionRow, [string]>(
        "SELECT * FROM saved_workflow_versions WHERE name = ? ORDER BY version DESC",
      )
      .all(name)
      .map((row) => savedWorkflowVersionView(mapSavedWorkflowVersion(row)));
  }

  // ---- capabilities ------------------------------------------------------

  putCapability(row: NewCapabilityRow): void {
    this.db
      .query(
        `INSERT INTO capabilities (
           id, secret_hash, resource_json, actions_json, created_at_ms,
           expires_at_ms, revoked_at_ms, note
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(secret_hash) DO UPDATE SET
           resource_json = excluded.resource_json,
           actions_json = excluded.actions_json,
           expires_at_ms = excluded.expires_at_ms,
           revoked_at_ms = excluded.revoked_at_ms,
           note = excluded.note`,
      )
      .run(
        row.id,
        row.secretHash,
        row.resourceJson,
        row.actionsJson,
        row.createdAtMs,
        row.expiresAtMs,
        row.revokedAtMs,
        row.note,
      );
  }

  getCapabilityByHash(secretHash: string): CapabilityRow | null {
    const r = this.db
      .query<RawCapabilityRow, [string]>("SELECT * FROM capabilities WHERE secret_hash = ?")
      .get(secretHash);
    return r ? mapCapability(r) : null;
  }

  revokeCapability(id: string, atMs: number): void {
    this.db
      .query("UPDATE capabilities SET revoked_at_ms = ? WHERE id = ? AND revoked_at_ms IS NULL")
      .run(atMs, id);
  }

  // ---- timers (durable ctx.sleep, §16) -----------------------------------

  /** Record (or return the existing) timer for a sleep; idempotent on resume. */
  upsertTimer(
    runId: string,
    stableKey: string,
    fireAtMs: number,
  ): { fireAtMs: number; fired: boolean } {
    const existing = this.db
      .query<{ fire_at_ms: number; fired: number }, [string, string]>(
        "SELECT fire_at_ms, fired FROM timers WHERE run_id = ? AND stable_key = ?",
      )
      .get(runId, stableKey);
    if (existing) return { fireAtMs: existing.fire_at_ms, fired: existing.fired === 1 };
    this.db
      .query("INSERT INTO timers (run_id, stable_key, fire_at_ms, fired) VALUES (?, ?, ?, 0)")
      .run(runId, stableKey, fireAtMs);
    return { fireAtMs, fired: false };
  }

  markTimerFired(runId: string, stableKey: string): void {
    this.db
      .query("UPDATE timers SET fired = 1 WHERE run_id = ? AND stable_key = ?")
      .run(runId, stableKey);
  }

  /** Distinct run ids with an unfired timer due at or before `nowMs`. */
  dueTimerRunIds(nowMs: number): string[] {
    return this.db
      .query<{ run_id: string }, [number]>(
        "SELECT DISTINCT run_id FROM timers WHERE fired = 0 AND fire_at_ms <= ?",
      )
      .all(nowMs)
      .map((r) => r.run_id);
  }

  // ---- schedules (cron, §16) ---------------------------------------------

  putSchedule(s: {
    name: string;
    workflowRef: string;
    inputJson: string | null;
    scheduleTarget?: string | null;
    intervalMs: number;
    nextFireMs: number;
  }): void {
    this.db
      .query(
        `INSERT INTO schedules (
           name, workflow_ref, input_json, schedule_target, interval_ms, next_fire_ms, enabled, last_error_json, last_failed_at_ms
         )
         VALUES ($name, $ref, $input, $target, $interval, $next, 1, NULL, NULL)
         ON CONFLICT(name) DO UPDATE SET
           workflow_ref = $ref,
           input_json = $input,
           schedule_target = $target,
           interval_ms = $interval,
           next_fire_ms = $next,
           enabled = 1,
           last_error_json = NULL,
           last_failed_at_ms = NULL`,
      )
      .run({
        $name: s.name,
        $ref: s.workflowRef,
        $input: s.inputJson,
        $target: s.scheduleTarget ?? null,
        $interval: s.intervalMs,
        $next: s.nextFireMs,
      });
  }

  dueSchedules(nowMs: number): Array<{
    name: string;
    workflowRef: string;
    inputJson: string | null;
    scheduleTarget: string | null;
    intervalMs: number;
    nextFireMs: number;
  }> {
    return this.db
      .query<
        {
          name: string;
          workflow_ref: string;
          input_json: string | null;
          schedule_target: string | null;
          interval_ms: number;
          next_fire_ms: number;
        },
        [number]
      >("SELECT * FROM schedules WHERE enabled = 1 AND next_fire_ms <= ?")
      .all(nowMs)
      .map((r) => ({
        name: r.name,
        workflowRef: r.workflow_ref,
        inputJson: r.input_json,
        scheduleTarget: r.schedule_target,
        intervalMs: r.interval_ms,
        nextFireMs: r.next_fire_ms,
      }));
  }

  advanceSchedule(name: string, nextFireMs: number, lastRunId: string): void {
    this.db
      .query(
        "UPDATE schedules SET next_fire_ms = ?, last_run_id = ?, last_error_json = NULL, last_failed_at_ms = NULL WHERE name = ?",
      )
      .run(nextFireMs, lastRunId, name);
  }

  disableScheduleWithError(name: string, errorJson: string, atMs: number): void {
    this.db
      .query(
        "UPDATE schedules SET enabled = 0, last_error_json = ?, last_failed_at_ms = ? WHERE name = ?",
      )
      .run(errorJson, atMs, name);
  }

  setScheduleEnabled(name: string, enabled: boolean): void {
    const result = this.db
      .query("UPDATE schedules SET enabled = ? WHERE name = ?")
      .run(enabled ? 1 : 0, name);
    if (result.changes === 0) throw new Error(`schedule "${name}" does not exist`);
  }

  deleteSchedule(name: string): boolean {
    return this.db.query("DELETE FROM schedules WHERE name = ?").run(name).changes > 0;
  }

  listSchedules(opts: { includeDisabled?: boolean } = {}): ScheduleRow[] {
    const sql =
      opts.includeDisabled === false
        ? "SELECT * FROM schedules WHERE enabled = 1 ORDER BY name ASC"
        : "SELECT * FROM schedules ORDER BY name ASC";
    return this.db.query<RawScheduleRow, []>(sql).all().map(mapSchedule);
  }

  getSchedule(name: string): ScheduleRow | null {
    const row = this.db
      .query<RawScheduleRow, [string]>("SELECT * FROM schedules WHERE name = ?")
      .get(name);
    return row ? mapSchedule(row) : null;
  }

  // ---- agent profile catalog and run snapshots --------------------------

  listAgentProfileCatalogRows(): AgentProfileCatalogRow[] {
    return this.db
      .query<RawAgentProfileCatalogRow, []>("SELECT * FROM agent_profiles ORDER BY name ASC")
      .all()
      .map(mapAgentProfileCatalogRow);
  }

  getAgentProfileCatalogRow(name: string): AgentProfileCatalogRow | null {
    const row = this.db
      .query<RawAgentProfileCatalogRow, [string]>("SELECT * FROM agent_profiles WHERE name = ?")
      .get(name);
    return row ? mapAgentProfileCatalogRow(row) : null;
  }

  putAgentProfileCatalogRow(row: {
    name: string;
    configJson: string;
    configHash: string;
    nowMs: number;
    ifGeneration?: number;
    createOnly?: boolean;
    updateOnly?: boolean;
  }): AgentProfileCatalogRow {
    return this.transaction(() => {
      const existing = this.getAgentProfileCatalogRow(row.name);
      if (row.createOnly && existing) throw new Error(`agent profile "${row.name}" already exists`);
      if (row.updateOnly && !existing)
        throw new Error(`agent profile "${row.name}" does not exist`);
      if (row.ifGeneration !== undefined) {
        if (!existing)
          throw new Error(`agent profile "${row.name}" generation precondition failed`);
        if (existing.generation !== row.ifGeneration) {
          throw new Error(
            `agent profile "${row.name}" generation precondition failed (expected ${row.ifGeneration}, got ${existing.generation})`,
          );
        }
      }
      if (existing) {
        this.db
          .query(
            `UPDATE agent_profiles
             SET config_json = ?, config_hash = ?, generation = generation + 1, updated_at_ms = ?
             WHERE name = ?`,
          )
          .run(row.configJson, row.configHash, row.nowMs, row.name);
      } else {
        this.db
          .query(
            `INSERT INTO agent_profiles (name, config_json, config_hash, generation, created_at_ms, updated_at_ms)
             VALUES (?, ?, ?, 1, ?, ?)`,
          )
          .run(row.name, row.configJson, row.configHash, row.nowMs, row.nowMs);
      }
      const saved = this.getAgentProfileCatalogRow(row.name);
      if (!saved) throw new Error(`agent profile "${row.name}" was not saved`);
      return saved;
    });
  }

  deleteAgentProfileCatalogRow(name: string, ifGeneration?: number): boolean {
    return this.transaction(() => {
      const existing = this.getAgentProfileCatalogRow(name);
      if (!existing) return false;
      if (ifGeneration !== undefined && existing.generation !== ifGeneration) {
        throw new Error(
          `agent profile "${name}" generation precondition failed (expected ${ifGeneration}, got ${existing.generation})`,
        );
      }
      this.db.query("DELETE FROM agent_profiles WHERE name = ?").run(name);
      return true;
    });
  }

  replaceRunProfileSnapshot(
    runId: string,
    set: { catalogHash: string; capturedAtMs: number },
    rows: Array<{
      name: string;
      source: "catalog" | "programmatic";
      configJson: string;
      configHash: string;
      catalogGeneration: number | null;
    }>,
  ): void {
    this.transaction(() => {
      this.db.query("DELETE FROM run_profile_snapshots WHERE run_id = ?").run(runId);
      this.db.query("DELETE FROM run_profile_snapshot_sets WHERE run_id = ?").run(runId);
      this.db
        .query(
          `INSERT INTO run_profile_snapshot_sets (run_id, catalog_hash, captured_at_ms)
         VALUES (?, ?, ?)`,
        )
        .run(runId, set.catalogHash, set.capturedAtMs);
      const insert = this.db.query(
        `INSERT INTO run_profile_snapshots (
         run_id, name, source, config_json, config_hash, catalog_generation, captured_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        insert.run(
          runId,
          row.name,
          row.source,
          row.configJson,
          row.configHash,
          row.catalogGeneration,
          set.capturedAtMs,
        );
      }
    });
  }

  getRunProfileSnapshotSet(runId: string): RunProfileSnapshotSetRow | null {
    const row = this.db
      .query<RawRunProfileSnapshotSetRow, [string]>(
        "SELECT * FROM run_profile_snapshot_sets WHERE run_id = ?",
      )
      .get(runId);
    return row ? mapRunProfileSnapshotSet(row) : null;
  }

  listRunProfileSnapshots(runId: string): RunProfileSnapshotRow[] {
    return this.db
      .query<RawRunProfileSnapshotRow, [string]>(
        "SELECT * FROM run_profile_snapshots WHERE run_id = ? ORDER BY name ASC",
      )
      .all(runId)
      .map(mapRunProfileSnapshotRow);
  }

  copyRunProfileSnapshot(srcRunId: string, dstRunId: string): void {
    const set = this.getRunProfileSnapshotSet(srcRunId);
    if (!set) throw new Error(`run ${srcRunId} is missing agent profile snapshot set`);
    this.replaceRunProfileSnapshot(
      dstRunId,
      { catalogHash: set.catalogHash, capturedAtMs: set.capturedAtMs },
      this.listRunProfileSnapshots(srcRunId).map((row) => ({
        name: row.name,
        source: row.source,
        configJson: row.configJson,
        configHash: row.configHash,
        catalogGeneration: row.catalogGeneration,
      })),
    );
  }

  // ---- daemon settings catalog and run snapshots -------------------------

  listDaemonSettingRows(): DaemonSettingCatalogRow[] {
    return this.db
      .query<RawDaemonSettingCatalogRow, []>("SELECT * FROM daemon_settings ORDER BY key ASC")
      .all()
      .map(mapDaemonSettingCatalogRow);
  }

  getDaemonSettingRow(key: string): DaemonSettingCatalogRow | null {
    const row = this.db
      .query<RawDaemonSettingCatalogRow, [string]>("SELECT * FROM daemon_settings WHERE key = ?")
      .get(key);
    return row ? mapDaemonSettingCatalogRow(row) : null;
  }

  putDaemonSettingRow(row: {
    key: string;
    valueJson: string;
    nowMs: number;
    ifGeneration?: number;
  }): DaemonSettingCatalogRow {
    return this.transaction(() => {
      const existing = this.getDaemonSettingRow(row.key);
      if (row.ifGeneration !== undefined) {
        if (!existing) throw new Error(`setting "${row.key}" generation precondition failed`);
        if (existing.generation !== row.ifGeneration) {
          throw new Error(
            `setting "${row.key}" generation precondition failed (expected ${row.ifGeneration}, got ${existing.generation})`,
          );
        }
      }
      if (existing) {
        this.db
          .query(
            `UPDATE daemon_settings
             SET value_json = ?, generation = generation + 1, updated_at_ms = ?
             WHERE key = ?`,
          )
          .run(row.valueJson, row.nowMs, row.key);
      } else {
        this.db
          .query(
            `INSERT INTO daemon_settings (key, value_json, generation, created_at_ms, updated_at_ms)
             VALUES (?, ?, 1, ?, ?)`,
          )
          .run(row.key, row.valueJson, row.nowMs, row.nowMs);
      }
      const saved = this.getDaemonSettingRow(row.key);
      if (!saved) throw new Error(`setting "${row.key}" was not saved`);
      return saved;
    });
  }

  deleteDaemonSettingRow(key: string, ifGeneration?: number): boolean {
    return this.transaction(() => {
      const existing = this.getDaemonSettingRow(key);
      if (!existing) {
        if (ifGeneration !== undefined) {
          throw new Error(`setting "${key}" generation precondition failed`);
        }
        return false;
      }
      if (ifGeneration !== undefined && existing.generation !== ifGeneration) {
        throw new Error(
          `setting "${key}" generation precondition failed (expected ${ifGeneration}, got ${existing.generation})`,
        );
      }
      this.db.query("DELETE FROM daemon_settings WHERE key = ?").run(key);
      return true;
    });
  }

  replaceRunSettingSnapshot(
    runId: string,
    set: { settingsHash: string; capturedAtMs: number },
    rows: Array<{
      key: string;
      class: "workflow-visible" | "daemon-operational";
      valueJson: string;
      defaultJson: string;
      source: "catalog" | "default";
      catalogGeneration: number | null;
    }>,
  ): void {
    this.transaction(() => {
      this.db.query("DELETE FROM run_setting_snapshots WHERE run_id = ?").run(runId);
      this.db.query("DELETE FROM run_setting_snapshot_sets WHERE run_id = ?").run(runId);
      this.db
        .query(
          `INSERT INTO run_setting_snapshot_sets (run_id, settings_hash, captured_at_ms)
           VALUES (?, ?, ?)`,
        )
        .run(runId, set.settingsHash, set.capturedAtMs);
      const insert = this.db.query(
        `INSERT INTO run_setting_snapshots (
           run_id, key, class, value_json, default_json, source, catalog_generation, captured_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        insert.run(
          runId,
          row.key,
          row.class,
          row.valueJson,
          row.defaultJson,
          row.source,
          row.catalogGeneration,
          set.capturedAtMs,
        );
      }
    });
  }

  getRunSettingSnapshotSet(runId: string): RunSettingSnapshotSetRow | null {
    const row = this.db
      .query<RawRunSettingSnapshotSetRow, [string]>(
        "SELECT * FROM run_setting_snapshot_sets WHERE run_id = ?",
      )
      .get(runId);
    return row ? mapRunSettingSnapshotSet(row) : null;
  }

  listRunSettingSnapshots(runId: string): RunSettingSnapshotRow[] {
    return this.db
      .query<RawRunSettingSnapshotRow, [string]>(
        "SELECT * FROM run_setting_snapshots WHERE run_id = ? ORDER BY key ASC",
      )
      .all(runId)
      .map(mapRunSettingSnapshotRow);
  }

  copyRunSettingSnapshot(srcRunId: string, dstRunId: string): void {
    const set = this.getRunSettingSnapshotSet(srcRunId);
    if (!set) throw new Error(`run ${srcRunId} is missing daemon settings snapshot set`);
    this.replaceRunSettingSnapshot(
      dstRunId,
      { settingsHash: set.settingsHash, capturedAtMs: set.capturedAtMs },
      this.listRunSettingSnapshots(srcRunId).map((row) => ({
        key: row.key,
        class: row.class,
        valueJson: row.valueJson,
        defaultJson: row.defaultJson,
        source: row.source,
        catalogGeneration: row.catalogGeneration,
      })),
    );
  }

  // ---- time travel (retry/rewind/fork, §18) ------------------------------

  /** Delete the failed rows of a run (retry: the failed step re-executes). */
  deleteFailedRows(runId: string): void {
    this.transaction(() => {
      this.db.query("DELETE FROM journal WHERE run_id = ? AND status = 'failed'").run(runId);
      this.db
        .query("DELETE FROM agent_session_turns WHERE run_id = ? AND status = 'failed'")
        .run(runId);
    });
  }

  /** Delete selected workspace setup command rows so an explicit retry can rerun setup from command 0. */
  deleteWorkspaceSetupRowsByStableKeyPrefix(runId: string, stableKeyPrefixes: string[]): void {
    if (stableKeyPrefixes.length === 0) return;
    this.transaction(() => {
      const artifactHashes = new Set<string>();
      const artifacts = this.db.query<{ result_artifact: string }, [string, number, string]>(
        `SELECT DISTINCT result_artifact
         FROM journal
         WHERE run_id = ?
           AND effect_type = 'workspace_setup'
           AND result_artifact IS NOT NULL
           AND substr(stable_key, 1, ?) = ?`,
      );
      const deleteRows = this.db.query<unknown, [string, number, string]>(
        `DELETE FROM journal
         WHERE run_id = ?
           AND effect_type = 'workspace_setup'
           AND substr(stable_key, 1, ?) = ?`,
      );
      for (const prefix of stableKeyPrefixes) {
        for (const artifact of artifacts.all(runId, prefix.length, prefix)) {
          artifactHashes.add(artifact.result_artifact);
        }
      }
      for (const hash of artifactHashes) this.decrementArtifactRefcount(hash);
      for (const prefix of stableKeyPrefixes) {
        deleteRows.run(runId, prefix.length, prefix);
      }
    });
  }

  /** Delete everything journaled AFTER a target step (rewind to that step). */
  /**
   * Rewind a run's durable state to a target step (§18). Deletes journal rows
   * AFTER the target's seq, decrements artifact refcounts for the discarded rows,
   * and clears UNRESOLVED transient waits (unfired timers, pending approvals,
   * unconsumed signals) so re-execution re-parks fresh. RESOLVED waits (fired
   * timers, decided approvals, consumed signals) are preserved — the journal
   * replay and resolved-wait replay rely on them. Events are append-only history
   * (a run.rewind marker is appended by the caller); they are not trimmed.
   */
  deleteRunStateAfter(runId: string, stableKey: string): void {
    this.transaction(() => {
      const cut = this.db
        .query<{ m: number | null }, [string, string]>(
          "SELECT MAX(seq) AS m FROM journal WHERE run_id = ? AND stable_key = ?",
        )
        .get(runId, stableKey)?.m;
      if (cut == null) return;
      // decrement refcounts for artifact-backed rows about to be discarded
      const orphans = this.db
        .query<{ result_artifact: string }, [string, number]>(
          "SELECT DISTINCT result_artifact FROM journal WHERE run_id = ? AND seq > ? AND result_artifact IS NOT NULL",
        )
        .all(runId, cut);
      for (const o of orphans) this.decrementArtifactRefcount(o.result_artifact);
      // Clear signals that were already pending at the rewind boundary before
      // restoring the consumed batch owned by discarded drain results.
      this.db.query("DELETE FROM signals WHERE run_id = ? AND consumed_key IS NULL").run(runId);
      // A discarded drain result can no longer replay its batch, so return only
      // the signals consumed by those discarded drain rows to the pending FIFO.
      this.db
        .query(
          `UPDATE signals
           SET consumed_key = NULL
           WHERE run_id = ?
             AND consumed_key IN (
               SELECT stable_key || '#' || attempt
               FROM journal
               WHERE run_id = ? AND seq > ? AND effect_type = 'drain_signals'
             )`,
        )
        .run(runId, runId, cut);
      this.db.query("DELETE FROM journal WHERE run_id = ? AND seq > ?").run(runId, cut);
      // clear unresolved waits — the run no longer parks where it did
      this.db.query("DELETE FROM timers WHERE run_id = ? AND fired = 0").run(runId);
      this.db.query("DELETE FROM approvals WHERE run_id = ? AND status = 'pending'").run(runId);
    });
  }

  decrementArtifactRefcount(hash: string): void {
    // CASE, not MAX() — MAX is an aggregate in Postgres; keep the dialect portable.
    this.db
      .query(
        "UPDATE artifacts SET ref_count = CASE WHEN ref_count > 0 THEN ref_count - 1 ELSE 0 END WHERE hash = ?",
      )
      .run(hash);
  }

  /**
   * Fork a run into a new independent run sharing the journal prefix (up to
   * `atStableKey` inclusive, or the whole journal). The new run can then be
   * resumed/rerun to diverge. Artifact refcounts are bumped for shared blobs.
   */
  forkRun(srcRunId: string, newRunId: string, atStableKey: string | null, atMs: number): void {
    const src = this.getRun(srcRunId);
    if (!src) throw new Error(`fork source run ${srcRunId} not found`);
    this.transaction(() => {
      this.insertRun({
        runId: newRunId,
        workflowName: src.workflowName,
        definitionVersion: src.definitionVersion,
        workflowRef: src.workflowRef,
        runTarget: src.runTarget,
        status: "running",
        parentRunId: srcRunId,
        tenantId: src.tenantId,
        inputRef: src.inputRef,
        outputRef: null,
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        createdAtMs: atMs,
      });
      this.copyRunProfileSnapshot(srcRunId, newRunId);
      this.copyRunSettingSnapshot(srcRunId, newRunId);
      const cutoff = atStableKey
        ? (this.db
            .query<{ m: number | null }, [string, string]>(
              "SELECT MAX(seq) AS m FROM journal WHERE run_id = ? AND stable_key = ?",
            )
            .get(srcRunId, atStableKey)?.m ?? null)
        : null;
      const rows = this.db
        .query<RawJournalRow, [string]>("SELECT * FROM journal WHERE run_id = ? ORDER BY seq ASC")
        .all(srcRunId)
        .filter((r) => cutoff === null || r.seq <= cutoff)
        .map(mapJournal);
      for (const r of rows) {
        this.putJournalRow({ ...r, runId: newRunId });
        if (r.resultArtifact) this.incrementArtifactRefcount(r.resultArtifact);
      }
      // Copy the source's RESOLVED durable-wait history ONLY for a FULL fork.
      // Durable waits (sleep/human/signal) aren't journal rows and carry no seq,
      // so for a PARTIAL fork (atStableKey set) we can't tell which waits fall
      // before vs after the cut — copying all of them could drag a post-cutoff
      // wait into the prefix. A full fork is an exact, terminal-source clone where
      // every wait is resolved, so copying is safe and correct. A partial fork
      // re-encounters any prefix waits fresh on rerun (documented, §18).
      if (cutoff === null) {
        this.db
          .query(
            `INSERT INTO timers (run_id, stable_key, fire_at_ms, fired)
             SELECT ?, stable_key, fire_at_ms, fired FROM timers WHERE run_id = ?`,
          )
          .run(newRunId, srcRunId);
        this.db
          .query(
            `INSERT INTO approvals (run_id, stable_key, status, prompt, requested_caps_json, granted_caps_json, decided_by, note, requested_at_ms, decided_at_ms)
             SELECT ?, stable_key, status, prompt, requested_caps_json, granted_caps_json, decided_by, note, requested_at_ms, decided_at_ms FROM approvals WHERE run_id = ?`,
          )
          .run(newRunId, srcRunId);
        this.db
          .query(
            `INSERT INTO signals (run_id, seq, name, correlation_id, payload_ref, received_at_ms, consumed_key)
             SELECT ?, seq, name, correlation_id, payload_ref, received_at_ms, consumed_key FROM signals WHERE run_id = ?`,
          )
          .run(newRunId, srcRunId);
      }
    });
  }

  incrementArtifactRefcount(hash: string): void {
    this.db.query("UPDATE artifacts SET ref_count = ref_count + 1 WHERE hash = ?").run(hash);
  }

  /**
   * Reclaim artifacts no journal row references (§19). Refcounts are recomputed
   * from the journal (the source of truth — so it self-heals after rewind/fork
   * deletes), then zero-ref blobs are dropped. Returns the count removed.
   */
  gcArtifacts(): number {
    this.db.exec(
      `UPDATE artifacts SET ref_count =
         (SELECT COUNT(*) FROM journal WHERE journal.result_artifact = artifacts.hash)`,
    );
    const removed =
      this.db
        .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM artifacts WHERE ref_count <= 0")
        .get()?.c ?? 0;
    this.db.exec("DELETE FROM artifacts WHERE ref_count <= 0");
    return removed;
  }

  // ---- approvals (ctx.human, §17) ----------------------------------------

  /** Record a pending approval request (idempotent on resume). */
  requestApproval(
    runId: string,
    stableKey: string,
    request: { prompt: string; requestedCaps?: unknown },
    atMs: number,
  ): void {
    // Persist WHAT the human is being asked so a UI/API can render it without
    // reading workflow source (§17). Idempotent on resume (DO NOTHING).
    this.db
      .query(
        `INSERT INTO approvals (run_id, stable_key, status, prompt, requested_caps_json, requested_at_ms)
         VALUES (?, ?, 'pending', ?, ?, ?)
         ON CONFLICT (run_id, stable_key) DO NOTHING`,
      )
      .run(
        runId,
        stableKey,
        request.prompt,
        request.requestedCaps != null ? JSON.stringify(request.requestedCaps) : null,
        atMs,
      );
  }

  decideApproval(
    runId: string,
    stableKey: string,
    decision: {
      status: "approved" | "denied";
      note?: string;
      grantedCaps?: unknown;
      decidedBy?: string;
    },
    atMs: number,
  ): void {
    this.db
      .query(
        `UPDATE approvals SET status = ?, note = ?, granted_caps_json = ?, decided_by = ?, decided_at_ms = ?
         WHERE run_id = ? AND stable_key = ?`,
      )
      .run(
        decision.status,
        decision.note ?? null,
        decision.grantedCaps != null ? JSON.stringify(decision.grantedCaps) : null,
        decision.decidedBy ?? null,
        atMs,
        runId,
        stableKey,
      );
  }

  getApproval(
    runId: string,
    stableKey: string,
  ): {
    status: string;
    prompt: string | null;
    requestedCaps: unknown;
    note: string | null;
    grantedCaps: unknown;
  } | null {
    const r = this.db
      .query<
        {
          status: string;
          prompt: string | null;
          requested_caps_json: string | null;
          note: string | null;
          granted_caps_json: string | null;
        },
        [string, string]
      >(
        "SELECT status, prompt, requested_caps_json, note, granted_caps_json FROM approvals WHERE run_id = ? AND stable_key = ?",
      )
      .get(runId, stableKey);
    if (!r) return null;
    return {
      status: r.status,
      prompt: r.prompt,
      requestedCaps: r.requested_caps_json ? JSON.parse(r.requested_caps_json) : null,
      note: r.note,
      grantedCaps: r.granted_caps_json ? JSON.parse(r.granted_caps_json) : null,
    };
  }

  /** All pending approvals for a run (for projection / UI). */
  listPendingApprovals(runId: string): Array<{
    stableKey: string;
    prompt: string | null;
    requestedCaps: unknown;
    requestedAtMs: number;
  }> {
    return this.db
      .query<
        {
          stable_key: string;
          prompt: string | null;
          requested_caps_json: string | null;
          requested_at_ms: number;
        },
        [string]
      >(
        "SELECT stable_key, prompt, requested_caps_json, requested_at_ms FROM approvals WHERE run_id = ? AND status = 'pending'",
      )
      .all(runId)
      .map((r) => ({
        stableKey: r.stable_key,
        prompt: r.prompt,
        requestedCaps: r.requested_caps_json ? JSON.parse(r.requested_caps_json) : null,
        requestedAtMs: r.requested_at_ms,
      }));
  }

  // ---- signals (ctx.signal, §17) -----------------------------------------

  /** Deliver an external signal to a run (appended; consumed by a ctx.signal call). */
  putSignal(runId: string, name: string, payload: unknown, atMs: number): void {
    const next =
      (this.db
        .query<{ m: number | null }, [string]>("SELECT MAX(seq) AS m FROM signals WHERE run_id = ?")
        .get(runId)?.m ?? 0) + 1;
    this.db
      .query(
        "INSERT INTO signals (run_id, seq, name, payload_ref, received_at_ms) VALUES (?, ?, ?, ?, ?)",
      )
      .run(runId, next, name, payload != null ? JSON.stringify(payload) : null, atMs);
  }

  /** The signal already consumed by a given ctx.signal call (replay path). */
  signalConsumedBy(runId: string, consumedKey: string): { payload: unknown } | null {
    const r = this.db
      .query<{ payload_ref: string | null }, [string, string]>(
        "SELECT payload_ref FROM signals WHERE run_id = ? AND consumed_key = ?",
      )
      .get(runId, consumedKey);
    if (!r) return null;
    return { payload: r.payload_ref ? JSON.parse(r.payload_ref) : null };
  }

  /** Consume the oldest pending signal of `name` for `consumedKey`; null if none. */
  consumeSignal(runId: string, name: string, consumedKey: string): { payload: unknown } | null {
    const r = this.db
      .query<{ seq: number; payload_ref: string | null }, [string, string]>(
        "SELECT seq, payload_ref FROM signals WHERE run_id = ? AND name = ? AND consumed_key IS NULL ORDER BY seq ASC LIMIT 1",
      )
      .get(runId, name);
    if (!r) return null;
    this.db
      .query("UPDATE signals SET consumed_key = ? WHERE run_id = ? AND seq = ?")
      .run(consumedKey, runId, r.seq);
    return { payload: r.payload_ref ? JSON.parse(r.payload_ref) : null };
  }

  /** Consume every currently pending signal of `name` in FIFO delivery order. */
  drainSignals(runId: string, name: string, consumedKey: string): unknown[] {
    const rows = this.db
      .query<{ payload_ref: string | null }, [string, string]>(
        "SELECT payload_ref FROM signals WHERE run_id = ? AND name = ? AND consumed_key IS NULL ORDER BY seq ASC",
      )
      .all(runId, name);
    if (rows.length === 0) return [];
    this.db
      .query(
        "UPDATE signals SET consumed_key = ? WHERE run_id = ? AND name = ? AND consumed_key IS NULL",
      )
      .run(consumedKey, runId, name);
    return rows.map((row) => (row.payload_ref ? JSON.parse(row.payload_ref) : null));
  }
}

function withJournalDefaults(row: NewJournalRow): JournalRow {
  return {
    attempt: 1,
    inputDeps: null,
    keySetHash: null,
    resultInline: null,
    resultArtifact: null,
    sessionToken: null,
    errorJson: null,
    startedAtMs: null,
    finishedAtMs: null,
    ...row,
  };
}

function withAgentWorkspaceDefaults(
  row: Omit<
    AgentWorkspaceRow,
    | "sourceKind"
    | "sourceUri"
    | "sourceBare"
    | "sourceMergeEligible"
    | "resolvedRef"
    | "checkoutBranch"
    | "worktreeCheckoutKind"
    | "worktreeBranchOwned"
    | "copyBaselinePath"
    | "creationErrorJson"
    | "setupIdentityJson"
    | "setupIdentityHash"
    | "setupStatus"
    | "setupStartedAtMs"
    | "setupFinishedAtMs"
    | "setupErrorJson"
  > &
    Partial<
      Pick<
        AgentWorkspaceRow,
        | "sourceKind"
        | "sourceUri"
        | "sourceBare"
        | "sourceMergeEligible"
        | "resolvedRef"
        | "checkoutBranch"
        | "worktreeCheckoutKind"
        | "worktreeBranchOwned"
        | "copyBaselinePath"
        | "creationErrorJson"
        | "setupIdentityJson"
        | "setupIdentityHash"
        | "setupStatus"
        | "setupStartedAtMs"
        | "setupFinishedAtMs"
        | "setupErrorJson"
      >
    >,
): AgentWorkspaceRow {
  if (!row.workspaceIdentityJson || !row.workspaceIdentityHash) {
    throw new Error(`workspace ${row.runId}/${row.workspaceId} is missing identity metadata`);
  }
  return {
    ...row,
    sourceKind:
      row.sourceKind ??
      (row.mode === "direct"
        ? "direct-path"
        : row.mode === "copy"
          ? "local-copy"
          : row.mode === "clone"
            ? "remote-git"
            : "worktree-git"),
    sourceUri: row.sourceUri ?? null,
    sourceBare: row.sourceBare ?? null,
    sourceMergeEligible:
      row.sourceMergeEligible ?? (row.mode === "worktree" || row.mode === "copy"),
    resolvedRef: row.resolvedRef ?? null,
    checkoutBranch: row.checkoutBranch ?? null,
    worktreeCheckoutKind: row.worktreeCheckoutKind ?? (row.mode === "worktree" ? "detached" : null),
    worktreeBranchOwned: row.worktreeBranchOwned ?? false,
    copyBaselinePath: row.copyBaselinePath ?? null,
    creationErrorJson: row.creationErrorJson ?? null,
    workspaceIdentityJson: row.workspaceIdentityJson,
    workspaceIdentityHash: row.workspaceIdentityHash,
    setupIdentityJson: row.setupIdentityJson ?? null,
    setupIdentityHash: row.setupIdentityHash ?? null,
    setupStatus: row.setupStatus ?? "none",
    setupStartedAtMs: row.setupStartedAtMs ?? null,
    setupFinishedAtMs: row.setupFinishedAtMs ?? null,
    setupErrorJson: row.setupErrorJson ?? null,
  };
}

// ---- raw row shapes + mappers ---------------------------------------------

interface RawRunRow {
  run_id: string;
  workflow_name: string | null;
  definition_version: string;
  workflow_ref: string | null;
  run_target: string | null;
  status: string;
  parent_run_id: string | null;
  tenant_id: string | null;
  input_ref: string | null;
  output_ref: string | null;
  error_json: string | null;
  heartbeat_at_ms: number | null;
  runtime_owner_id: string | null;
  created_at_ms: number;
  finished_at_ms: number | null;
}

interface RawJournalRow {
  run_id: string;
  stable_key: string;
  attempt: number;
  seq: number;
  effect_type: string;
  status: string;
  version: string;
  input_hash: string;
  input_deps_json: string | null;
  key_set_hash: string | null;
  result_inline: string | null;
  result_artifact: string | null;
  session_token: string | null;
  error_json: string | null;
  started_at_ms: number | null;
  finished_at_ms: number | null;
}

interface RawAgentSessionRow {
  run_id: string;
  agent_key: string;
  identity_hash: string;
  identity_json: string;
  current_session_token: string | null;
  latest_completed_turn_key: string | null;
  latest_completed_attempt: number | null;
  active_turn_key: string | null;
  active_turn_attempt: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface RawAgentSessionTurnRow {
  run_id: string;
  agent_key: string;
  turn_key: string;
  attempt: number;
  stable_key: string;
  status: string;
  started_session_token: string | null;
  observed_session_token: string | null;
  completed_session_token: string | null;
  started_at_ms: number | null;
  finished_at_ms: number | null;
}

interface RawAgentWorkspaceRow {
  run_id: string;
  workspace_id: string;
  mode: string;
  owner_kind: string;
  key: string;
  last_attempt: number | null;
  retention_policy: string | null;
  workspace_path: string;
  source_kind: string | null;
  source_path: string | null;
  source_uri: string | null;
  source_bare: number | null;
  source_merge_eligible: number;
  supplied_path: string | null;
  source_ref: string | null;
  resolved_ref: string | null;
  checkout_branch: string | null;
  worktree_checkout_kind: string | null;
  worktree_branch_owned: number;
  base_commit: string | null;
  copy_baseline_path: string | null;
  creation_error_json: string | null;
  workspace_identity_json: string;
  workspace_identity_hash: string;
  setup_identity_json: string | null;
  setup_identity_hash: string | null;
  setup_status: string;
  setup_started_at_ms: number | null;
  setup_finished_at_ms: number | null;
  setup_error_json: string | null;
  owned: number;
  status: string;
  failure_seen: number;
  last_turn_key: string | null;
  last_turn_attempt: number | null;
  active_holder_kind: string | null;
  active_holder_key: string | null;
  active_holder_attempt: number | null;
  active_started_at_ms: number | null;
  last_diff_event_seq: number | null;
  last_error_event_seq: number | null;
  cleanup_error_json: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  merged_at_ms: number | null;
  discarded_at_ms: number | null;
  removed_at_ms: number | null;
}

interface RawEventRow {
  run_id: string;
  seq: number;
  type: string;
  payload_json: string;
  emitted_at_ms: number;
}

interface RawArtifactRow {
  hash: string;
  byte_len: number;
  ref_count: number;
  created_at_ms: number;
  data: Uint8Array | null;
}

interface RawWorkflowDefinitionRow {
  hash: string;
  name: string | null;
  kind: string;
  code: string;
  source_map: string | null;
  manifest_json: string | null;
  created_at_ms: number;
}

interface RawScheduleRow {
  name: string;
  workflow_ref: string;
  input_json: string | null;
  schedule_target: string | null;
  interval_ms: number;
  next_fire_ms: number;
  enabled: number;
  last_run_id: string | null;
  last_error_json: string | null;
  last_failed_at_ms: number | null;
}

interface RawSavedWorkflowRow {
  name: string;
  title: string | null;
  description: string | null;
  tags_json: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  disabled_at_ms: number | null;
  deleted_at_ms: number | null;
}

interface RawSavedWorkflowVersionRow {
  name: string;
  version: number;
  definition_hash: string;
  workflow_name: string | null;
  input_schema_json: string | null;
  default_input_json: string | null;
  default_target: string | null;
  metadata_json: string | null;
  source_provenance_json: string | null;
  created_by: string | null;
  created_at_ms: number;
  enabled: number;
  deprecated_at_ms: number | null;
  deprecation_message: string | null;
  deleted_at_ms: number | null;
}

interface RawCapabilityRow {
  id: string;
  secret_hash: string;
  resource_json: string;
  actions_json: string;
  created_at_ms: number;
  expires_at_ms: number | null;
  revoked_at_ms: number | null;
  note: string | null;
}

interface RawAgentProfileCatalogRow {
  name: string;
  config_json: string;
  config_hash: string;
  generation: number;
  created_at_ms: number;
  updated_at_ms: number;
}

interface RawDaemonSettingCatalogRow {
  key: string;
  value_json: string;
  generation: number;
  created_at_ms: number;
  updated_at_ms: number;
}

interface RawRunProfileSnapshotSetRow {
  run_id: string;
  catalog_hash: string;
  captured_at_ms: number;
}

interface RawRunProfileSnapshotRow {
  run_id: string;
  name: string;
  source: string;
  config_json: string;
  config_hash: string;
  catalog_generation: number | null;
  captured_at_ms: number;
}

interface RawRunSettingSnapshotSetRow {
  run_id: string;
  settings_hash: string;
  captured_at_ms: number;
}

interface RawRunSettingSnapshotRow {
  run_id: string;
  key: string;
  class: string;
  value_json: string;
  default_json: string;
  source: string;
  catalog_generation: number | null;
  captured_at_ms: number;
}

function mapAgentProfileCatalogRow(r: RawAgentProfileCatalogRow): AgentProfileCatalogRow {
  return {
    name: r.name,
    configJson: r.config_json,
    configHash: r.config_hash,
    generation: r.generation,
    createdAtMs: r.created_at_ms,
    updatedAtMs: r.updated_at_ms,
  };
}

function mapDaemonSettingCatalogRow(r: RawDaemonSettingCatalogRow): DaemonSettingCatalogRow {
  return {
    key: r.key,
    valueJson: r.value_json,
    generation: r.generation,
    createdAtMs: r.created_at_ms,
    updatedAtMs: r.updated_at_ms,
  };
}

function mapRunProfileSnapshotSet(r: RawRunProfileSnapshotSetRow): RunProfileSnapshotSetRow {
  return {
    runId: r.run_id,
    catalogHash: r.catalog_hash,
    capturedAtMs: r.captured_at_ms,
  };
}

function mapRunProfileSnapshotRow(r: RawRunProfileSnapshotRow): RunProfileSnapshotRow {
  return {
    runId: r.run_id,
    name: r.name,
    source: r.source as RunProfileSnapshotRow["source"],
    configJson: r.config_json,
    configHash: r.config_hash,
    catalogGeneration: r.catalog_generation,
    capturedAtMs: r.captured_at_ms,
  };
}

function mapRunSettingSnapshotSet(r: RawRunSettingSnapshotSetRow): RunSettingSnapshotSetRow {
  return {
    runId: r.run_id,
    settingsHash: r.settings_hash,
    capturedAtMs: r.captured_at_ms,
  };
}

function mapRunSettingSnapshotRow(r: RawRunSettingSnapshotRow): RunSettingSnapshotRow {
  return {
    runId: r.run_id,
    key: r.key,
    class: r.class as RunSettingSnapshotRow["class"],
    valueJson: r.value_json,
    defaultJson: r.default_json,
    source: r.source as RunSettingSnapshotRow["source"],
    catalogGeneration: r.catalog_generation,
    capturedAtMs: r.captured_at_ms,
  };
}

function mapSavedWorkflow(r: RawSavedWorkflowRow): SavedWorkflowRow {
  return {
    name: r.name,
    title: r.title,
    description: r.description,
    tagsJson: r.tags_json,
    createdAtMs: r.created_at_ms,
    updatedAtMs: r.updated_at_ms,
    disabledAtMs: r.disabled_at_ms,
    deletedAtMs: r.deleted_at_ms,
  };
}

function mapSavedWorkflowVersion(r: RawSavedWorkflowVersionRow): SavedWorkflowVersionRow {
  return {
    name: r.name,
    version: r.version,
    definitionHash: r.definition_hash,
    workflowName: r.workflow_name,
    inputSchemaJson: r.input_schema_json,
    defaultInputJson: r.default_input_json,
    defaultTarget: r.default_target,
    metadataJson: r.metadata_json,
    sourceProvenanceJson: r.source_provenance_json,
    createdBy: r.created_by,
    createdAtMs: r.created_at_ms,
    enabled: r.enabled !== 0,
    deprecatedAtMs: r.deprecated_at_ms,
    deprecationMessage: r.deprecation_message,
    deletedAtMs: r.deleted_at_ms,
  };
}

function savedWorkflowBaseView(row: SavedWorkflowRow): Omit<SavedWorkflowView, "versions"> {
  return {
    name: row.name,
    title: row.title,
    description: row.description,
    tags: row.tagsJson ? (JSON.parse(row.tagsJson) as string[]) : [],
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
    disabledAtMs: row.disabledAtMs,
    deletedAtMs: row.deletedAtMs,
  };
}

function savedWorkflowVersionView(row: SavedWorkflowVersionRow): SavedWorkflowVersionView {
  return {
    name: row.name,
    version: row.version,
    definitionHash: row.definitionHash,
    workflowName: row.workflowName,
    inputSchema: row.inputSchemaJson ? JSON.parse(row.inputSchemaJson) : null,
    inputSchemaSet: row.inputSchemaJson !== null,
    defaultInput: row.defaultInputJson ? JSON.parse(row.defaultInputJson) : null,
    defaultInputSet: row.defaultInputJson !== null,
    defaultTarget: row.defaultTarget,
    metadata: row.metadataJson ? JSON.parse(row.metadataJson) : null,
    sourceProvenance: row.sourceProvenanceJson ? JSON.parse(row.sourceProvenanceJson) : null,
    createdBy: row.createdBy,
    createdAtMs: row.createdAtMs,
    enabled: row.enabled,
    deprecatedAtMs: row.deprecatedAtMs,
    deprecationMessage: row.deprecationMessage,
    deletedAtMs: row.deletedAtMs,
  };
}

function assertValidSavedWorkflowName(name: string): void {
  if (name.trim() !== name || !SAVED_WORKFLOW_NAME_RE.test(name)) {
    throw new Error(`invalid saved workflow name "${name}"`);
  }
  if (name.startsWith("wf_") || name.startsWith("wf_sha256")) {
    throw new Error(`saved workflow name "${name}" uses a reserved workflow definition prefix`);
  }
}

function mapRun(r: RawRunRow): RunRow {
  return {
    runId: r.run_id,
    workflowName: r.workflow_name,
    definitionVersion: r.definition_version,
    workflowRef: r.workflow_ref,
    runTarget: r.run_target,
    status: r.status as RunRow["status"],
    parentRunId: r.parent_run_id,
    tenantId: r.tenant_id,
    inputRef: r.input_ref,
    outputRef: r.output_ref,
    errorJson: r.error_json,
    heartbeatAtMs: r.heartbeat_at_ms,
    runtimeOwnerId: r.runtime_owner_id,
    createdAtMs: r.created_at_ms,
    finishedAtMs: r.finished_at_ms,
  };
}

function mapSchedule(r: RawScheduleRow): ScheduleRow {
  return {
    name: r.name,
    workflowRef: r.workflow_ref,
    inputJson: r.input_json,
    scheduleTarget: r.schedule_target,
    intervalMs: r.interval_ms,
    nextFireMs: r.next_fire_ms,
    enabled: r.enabled === 1,
    lastRunId: r.last_run_id,
    lastErrorJson: r.last_error_json,
    lastFailedAtMs: r.last_failed_at_ms,
  };
}

function mapJournal(r: RawJournalRow): JournalRow {
  return {
    runId: r.run_id,
    stableKey: r.stable_key,
    attempt: r.attempt,
    effectType: r.effect_type as JournalRow["effectType"],
    status: r.status as JournalRow["status"],
    version: r.version,
    inputHash: r.input_hash,
    inputDeps: r.input_deps_json ? (JSON.parse(r.input_deps_json) as InputDep[]) : null,
    keySetHash: r.key_set_hash,
    resultInline: r.result_inline,
    resultArtifact: r.result_artifact,
    sessionToken: r.session_token,
    errorJson: r.error_json,
    startedAtMs: r.started_at_ms,
    finishedAtMs: r.finished_at_ms,
  };
}

function mapAgentSession(r: RawAgentSessionRow): AgentSessionRow {
  return {
    runId: r.run_id,
    agentKey: r.agent_key,
    identityHash: r.identity_hash,
    identityJson: r.identity_json,
    currentSessionToken: r.current_session_token,
    latestCompletedTurnKey: r.latest_completed_turn_key,
    latestCompletedAttempt: r.latest_completed_attempt,
    activeTurnKey: r.active_turn_key,
    activeTurnAttempt: r.active_turn_attempt,
    createdAtMs: r.created_at_ms,
    updatedAtMs: r.updated_at_ms,
  };
}

function mapAgentSessionTurn(r: RawAgentSessionTurnRow): AgentSessionTurnRow {
  return {
    runId: r.run_id,
    agentKey: r.agent_key,
    turnKey: r.turn_key,
    attempt: r.attempt,
    stableKey: r.stable_key,
    status: r.status as AgentSessionTurnRow["status"],
    startedSessionToken: r.started_session_token,
    observedSessionToken: r.observed_session_token,
    completedSessionToken: r.completed_session_token,
    startedAtMs: r.started_at_ms,
    finishedAtMs: r.finished_at_ms,
  };
}

function mapAgentWorkspace(r: RawAgentWorkspaceRow): AgentWorkspaceRow {
  return {
    runId: r.run_id,
    workspaceId: r.workspace_id,
    mode: r.mode as AgentWorkspaceRow["mode"],
    ownerKind: r.owner_kind as AgentWorkspaceRow["ownerKind"],
    key: r.key,
    lastAttempt: r.last_attempt,
    retentionPolicy: r.retention_policy as AgentWorkspaceRow["retentionPolicy"],
    workspacePath: r.workspace_path,
    sourceKind: r.source_kind as AgentWorkspaceRow["sourceKind"],
    sourcePath: r.source_path,
    sourceUri: r.source_uri,
    sourceBare: r.source_bare == null ? null : r.source_bare !== 0,
    sourceMergeEligible: r.source_merge_eligible !== 0,
    suppliedPath: r.supplied_path,
    sourceRef: r.source_ref,
    resolvedRef: r.resolved_ref,
    checkoutBranch: r.checkout_branch,
    worktreeCheckoutKind: r.worktree_checkout_kind as AgentWorkspaceRow["worktreeCheckoutKind"],
    worktreeBranchOwned: r.worktree_branch_owned !== 0,
    baseCommit: r.base_commit,
    copyBaselinePath: r.copy_baseline_path,
    creationErrorJson: r.creation_error_json,
    workspaceIdentityJson: r.workspace_identity_json,
    workspaceIdentityHash: r.workspace_identity_hash,
    setupIdentityJson: r.setup_identity_json,
    setupIdentityHash: r.setup_identity_hash,
    setupStatus: r.setup_status as AgentWorkspaceRow["setupStatus"],
    setupStartedAtMs: r.setup_started_at_ms,
    setupFinishedAtMs: r.setup_finished_at_ms,
    setupErrorJson: r.setup_error_json,
    owned: r.owned !== 0,
    status: r.status as AgentWorkspaceStatus,
    failureSeen: r.failure_seen !== 0,
    lastTurnKey: r.last_turn_key,
    lastTurnAttempt: r.last_turn_attempt,
    activeHolderKind: r.active_holder_kind as AgentWorkspaceRow["activeHolderKind"],
    activeHolderKey: r.active_holder_key,
    activeHolderAttempt: r.active_holder_attempt,
    activeStartedAtMs: r.active_started_at_ms,
    lastDiffEventSeq: r.last_diff_event_seq,
    lastErrorEventSeq: r.last_error_event_seq,
    cleanupErrorJson: r.cleanup_error_json,
    createdAtMs: r.created_at_ms,
    updatedAtMs: r.updated_at_ms,
    mergedAtMs: r.merged_at_ms,
    discardedAtMs: r.discarded_at_ms,
    removedAtMs: r.removed_at_ms,
  };
}

function mapEvent(r: RawEventRow): EventRow {
  return {
    runId: r.run_id,
    seq: r.seq,
    type: r.type,
    payloadJson: r.payload_json,
    emittedAtMs: r.emitted_at_ms,
  };
}

function mapArtifact(r: RawArtifactRow): ArtifactRow {
  return {
    hash: r.hash,
    byteLen: r.byte_len,
    refCount: r.ref_count,
    createdAtMs: r.created_at_ms,
    data: r.data,
  };
}

function mapWorkflowDefinition(r: RawWorkflowDefinitionRow): WorkflowDefinitionRow {
  return {
    hash: r.hash,
    name: r.name,
    kind: r.kind,
    code: r.code,
    sourceMap: r.source_map,
    manifestJson: r.manifest_json,
    createdAtMs: r.created_at_ms,
  };
}

function mapCapability(r: RawCapabilityRow): CapabilityRow {
  return {
    id: r.id,
    secretHash: r.secret_hash,
    resourceJson: r.resource_json,
    actionsJson: r.actions_json,
    createdAtMs: r.created_at_ms,
    expiresAtMs: r.expires_at_ms,
    revokedAtMs: r.revoked_at_ms,
    note: r.note,
  };
}
