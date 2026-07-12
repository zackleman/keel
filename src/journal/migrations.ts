// Forward-migration ladder (DESIGN.md §8.1, §19).
//
// The base DDL is `CREATE TABLE IF NOT EXISTS`, so it creates any MISSING tables
// at the current shape but cannot add columns to a pre-existing table. This ladder
// applies the column-adds, rebuilds, and data transitions needed to bring an older
// journal up to SCHEMA_VERSION. Migrations are forward-only; compatibility after
// startup is the current schema, not runtime branches for old record meanings.
//
// History: v1 base → v2 runs.workflow_ref → v3 schedules table → v4
// signals.consumed_key → v5 journal.seq → v6 approvals.prompt/requested_caps_json
// → v7 workflow_definitions → v8 capabilities → v9 schedule definitions
// → v10 nullable display names → v11 durable agent session tables
// → v12 workflow SDK ABI manifests and schedule failure state
// → v13 run targets and retained agent session workspaces
// → v14 unified agent workspace retention policy table
// → v15 workflow-scoped direct/worktree workspace rows
// → v16 persistent agent profile catalog and run profile snapshots
// → v17 daemon settings catalog and run setting snapshots
// → v18 managed workspace copy/clone metadata and workspace identities
// → v19 branch-backed worktree checkout metadata
// → v20 saved workflow registry tables
// → v21 normalize legacy workflow definition source manifests
// → v22 workspace setup metadata
// → v23 run-scoped materialized state
// → v24 launch-authority ceiling snapshots and submitter credential profiles.

import type { Database } from "bun:sqlite";
import { parse } from "acorn";
import { canonicalJson, sha256Hex } from "../hash.ts";
import { captureWorkflowVisibleSettingsSnapshot } from "../settings/catalog.ts";
import { workspaceIdentity } from "../workspace/identity.ts";

const DEFINITION_PREFIX = "wf_sha256_";
const WORKFLOW_SDK_ABI_V12 = 1;
const WORKFLOW_SDK_ABI_V18 = 6;
const DIRECT_WORKSPACE_RULES_VERSION_V18 = 1;
const WORKTREE_WORKSPACE_RULES_VERSION_V18 = 1;
const tsTranspiler = new Bun.Transpiler({ loader: "tsx" });

/** True if `table` already has `column` (so we don't re-add it). */
function hasColumn(db: Database, table: string, column: string): boolean {
  const cols = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all();
  return cols.some((c) => c.name === column);
}

function addColumn(db: Database, table: string, column: string, type: string): void {
  if (!hasColumn(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function tableExists(db: Database, table: string): boolean {
  const row = db
    .query<{ name: string }, [string]>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
    .get(table);
  return row !== null;
}

function workspaceIdForMigration(kind: "agent" | "agent_session", key: string): string {
  return `ws_${sha256Hex(canonicalJson({ kind, key })).slice(0, 32)}`;
}

function rebuildTable(db: Database, table: string, createSql: string, columns: string[]): void {
  const tmp = `${table}_new`;
  const cols = columns.join(", ");
  db.exec(`ALTER TABLE ${table} RENAME TO ${table}_old`);
  db.exec(createSql.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${tmp}`));
  db.exec(`INSERT INTO ${tmp} (${cols}) SELECT ${cols} FROM ${table}_old`);
  db.exec(`DROP TABLE ${table}_old`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
}

/** Apply the single step that upgrades a DB from `fromVersion` to `fromVersion+1`. */
export function applyMigration(db: Database, fromVersion: number): void {
  switch (fromVersion) {
    case 1: // → v2
      addColumn(db, "runs", "workflow_ref", "TEXT");
      break;
    case 2: // → v3: schedules is a new TABLE, created by the base DDL's CREATE IF NOT EXISTS
      break;
    case 3: // → v4
      addColumn(db, "signals", "consumed_key", "TEXT");
      break;
    case 4: // → v5: per-run insertion order; backfill so existing rows stay monotonic
      addColumn(db, "journal", "seq", "INTEGER NOT NULL DEFAULT 0");
      db.exec(
        `UPDATE journal SET seq = sub.rn FROM (
           SELECT rowid AS rid, row_number() OVER (PARTITION BY run_id ORDER BY rowid) AS rn
           FROM journal
         ) AS sub WHERE journal.rowid = sub.rid`,
      );
      break;
    case 5: // → v6
      addColumn(db, "approvals", "prompt", "TEXT");
      addColumn(db, "approvals", "requested_caps_json", "TEXT");
      break;
    case 6: // → v7: workflow_definitions is a new TABLE, created by base DDL.
      break;
    case 7: // → v8: capabilities is a new TABLE, created by base DDL.
      break;
    case 8: // → v9: schedules.workflow_ref now stores definition hashes.
      db.exec("UPDATE schedules SET enabled = 0");
      break;
    case 9: // → v10: display names are nullable.
      rebuildTable(
        db,
        "runs",
        `CREATE TABLE runs (
          run_id             TEXT PRIMARY KEY,
          workflow_name      TEXT,
          definition_version TEXT NOT NULL,
          workflow_ref       TEXT,
          status             TEXT NOT NULL,
          parent_run_id      TEXT,
          tenant_id          TEXT,
          input_ref          TEXT,
          output_ref         TEXT,
          error_json         TEXT,
          heartbeat_at_ms    INTEGER,
          runtime_owner_id   TEXT,
          created_at_ms      INTEGER NOT NULL,
          finished_at_ms     INTEGER
        )`,
        [
          "run_id",
          "workflow_name",
          "definition_version",
          "workflow_ref",
          "status",
          "parent_run_id",
          "tenant_id",
          "input_ref",
          "output_ref",
          "error_json",
          "heartbeat_at_ms",
          "runtime_owner_id",
          "created_at_ms",
          "finished_at_ms",
        ],
      );
      rebuildTable(
        db,
        "workflow_definitions",
        `CREATE TABLE workflow_definitions (
          hash          TEXT PRIMARY KEY,
          name          TEXT,
          kind          TEXT NOT NULL,
          code          TEXT NOT NULL,
          source_map    TEXT,
          manifest_json TEXT,
          created_at_ms INTEGER NOT NULL
        )`,
        ["hash", "name", "kind", "code", "source_map", "manifest_json", "created_at_ms"],
      );
      break;
    case 10: // → v11: durable logical agent session metadata tables.
      break;
    case 11: // → v12: workflow SDK ABI manifests and durable schedule fire errors.
      addColumn(db, "schedules", "last_error_json", "TEXT");
      addColumn(db, "schedules", "last_failed_at_ms", "INTEGER");
      migrateWorkflowDefinitionManifestsToV12(db);
      break;
    case 12: // → v13: run/schedule targets and retained session workspace metadata.
      addColumn(db, "runs", "run_target", "TEXT");
      addColumn(db, "schedules", "schedule_target", "TEXT");
      db.exec(`CREATE TABLE IF NOT EXISTS agent_session_workspaces (
        run_id              TEXT NOT NULL,
        agent_key           TEXT NOT NULL,
        workspace_path      TEXT NOT NULL,
        target              TEXT NOT NULL,
        base_commit         TEXT NOT NULL,
        status              TEXT NOT NULL,
        last_turn_key       TEXT,
        last_turn_attempt   INTEGER,
        last_diff_event_seq INTEGER,
        last_error_event_seq INTEGER,
        created_at_ms       INTEGER NOT NULL,
        updated_at_ms       INTEGER NOT NULL,
        merged_at_ms        INTEGER,
        discarded_at_ms     INTEGER,
        PRIMARY KEY (run_id, agent_key)
      )`);
      break;
    case 13: // → v14: unified workspace retention policy metadata.
      db.exec(`CREATE TABLE IF NOT EXISTS agent_workspaces (
        run_id               TEXT NOT NULL,
        workspace_id         TEXT NOT NULL,
        kind                 TEXT NOT NULL,
        key                  TEXT NOT NULL,
        last_attempt         INTEGER,
        retention_policy     TEXT NOT NULL,
        workspace_path       TEXT NOT NULL,
        target               TEXT NOT NULL,
        base_commit          TEXT NOT NULL,
        status               TEXT NOT NULL,
        failure_seen         INTEGER NOT NULL DEFAULT 0,
        last_turn_key        TEXT,
        last_turn_attempt    INTEGER,
        last_diff_event_seq  INTEGER,
        last_error_event_seq INTEGER,
        cleanup_error_json   TEXT,
        created_at_ms        INTEGER NOT NULL,
        updated_at_ms        INTEGER NOT NULL,
        merged_at_ms         INTEGER,
        discarded_at_ms      INTEGER,
        removed_at_ms        INTEGER,
        PRIMARY KEY (run_id, workspace_id)
      )`);
      if (tableExists(db, "agent_session_workspaces")) {
        const rows = db
          .query<RawAgentSessionWorkspaceV13, []>("SELECT * FROM agent_session_workspaces")
          .all();
        const insert = hasColumn(db, "agent_workspaces", "kind")
          ? db.query(
              `INSERT OR REPLACE INTO agent_workspaces (
                run_id, workspace_id, kind, key, last_attempt, retention_policy,
                workspace_path, target, base_commit, status, failure_seen,
                last_turn_key, last_turn_attempt, last_diff_event_seq, last_error_event_seq,
                cleanup_error_json, created_at_ms, updated_at_ms, merged_at_ms, discarded_at_ms, removed_at_ms
              ) VALUES (?, ?, 'agent_session', ?, NULL, 'always', ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL)`,
            )
          : db.query(
              `INSERT OR REPLACE INTO agent_workspaces (
                run_id, workspace_id, mode, owner_kind, key, last_attempt, retention_policy,
                workspace_path, source_path, supplied_path, source_ref, base_commit, owned, status,
                failure_seen, last_turn_key, last_turn_attempt, active_holder_kind, active_holder_key,
                active_holder_attempt, active_started_at_ms, last_diff_event_seq, last_error_event_seq,
                cleanup_error_json, created_at_ms, updated_at_ms, merged_at_ms, discarded_at_ms, removed_at_ms
              ) VALUES (?, ?, 'worktree', 'agent_session', ?, NULL, 'retain', ?, ?, NULL, 'HEAD', ?, 1, ?, 0, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?, NULL)`,
            );
        for (const row of rows) {
          insert.run(
            row.run_id,
            workspaceIdForMigration("agent_session", row.agent_key),
            row.agent_key,
            row.workspace_path,
            row.target,
            row.base_commit,
            row.status,
            row.last_turn_key,
            row.last_turn_attempt,
            row.last_diff_event_seq,
            row.last_error_event_seq,
            row.created_at_ms,
            row.updated_at_ms,
            row.merged_at_ms,
            row.discarded_at_ms,
          );
        }
        db.exec("DROP TABLE agent_session_workspaces");
      }
      break;
    case 14: // → v15: workflow-scoped direct/worktree workspace rows.
      if (!hasColumn(db, "agent_workspaces", "kind")) break;
      db.exec("ALTER TABLE agent_workspaces RENAME TO agent_workspaces_old");
      db.exec(`CREATE TABLE agent_workspaces (
        run_id                TEXT NOT NULL,
        workspace_id          TEXT NOT NULL,
        mode                  TEXT NOT NULL,
        owner_kind            TEXT NOT NULL,
        key                   TEXT NOT NULL,
        last_attempt          INTEGER,
        retention_policy      TEXT,
        workspace_path        TEXT NOT NULL,
        source_path           TEXT NOT NULL,
        supplied_path         TEXT,
        source_ref            TEXT,
        base_commit           TEXT,
        owned                 INTEGER NOT NULL DEFAULT 0,
        status                TEXT NOT NULL,
        failure_seen          INTEGER NOT NULL DEFAULT 0,
        last_turn_key         TEXT,
        last_turn_attempt     INTEGER,
        active_holder_kind    TEXT,
        active_holder_key     TEXT,
        active_holder_attempt INTEGER,
        active_started_at_ms  INTEGER,
        last_diff_event_seq   INTEGER,
        last_error_event_seq  INTEGER,
        cleanup_error_json    TEXT,
        created_at_ms         INTEGER NOT NULL,
        updated_at_ms         INTEGER NOT NULL,
        merged_at_ms          INTEGER,
        discarded_at_ms       INTEGER,
        removed_at_ms         INTEGER,
        PRIMARY KEY (run_id, workspace_id)
      )`);
      db.exec(`INSERT INTO agent_workspaces (
        run_id, workspace_id, mode, owner_kind, key, last_attempt, retention_policy,
        workspace_path, source_path, supplied_path, source_ref, base_commit, owned, status,
        failure_seen, last_turn_key, last_turn_attempt, active_holder_kind, active_holder_key,
        active_holder_attempt, active_started_at_ms, last_diff_event_seq, last_error_event_seq,
        cleanup_error_json, created_at_ms, updated_at_ms, merged_at_ms, discarded_at_ms, removed_at_ms
      )
      SELECT
        run_id,
        workspace_id,
        'worktree',
        kind,
        key,
        last_attempt,
        CASE retention_policy
          WHEN 'never' THEN 'remove'
          WHEN 'on-failure' THEN 'retain-on-failure'
          WHEN 'always' THEN 'retain'
          ELSE retention_policy
        END,
        workspace_path,
        target,
        NULL,
        'HEAD',
        base_commit,
        1,
        status,
        failure_seen,
        last_turn_key,
        last_turn_attempt,
        NULL,
        NULL,
        NULL,
        NULL,
        last_diff_event_seq,
        last_error_event_seq,
        cleanup_error_json,
        created_at_ms,
        updated_at_ms,
        merged_at_ms,
        discarded_at_ms,
        removed_at_ms
      FROM agent_workspaces_old`);
      db.exec("DROP TABLE agent_workspaces_old");
      break;
    case 15: // → v16: persistent agent profile catalog and frozen run snapshots.
      migrateAgentProfileCatalogToV16(db);
      break;
    case 16: // → v17: daemon settings catalog and frozen workflow-visible defaults.
      migrateDaemonSettingsToV17(db);
      break;
    case 17: // → v18: managed copy/clone workspace metadata and identity hashes.
      migrateAgentWorkspacesToV18(db);
      break;
    case 18: // → v19: worktree checkout kind and branch ownership metadata.
      addColumn(db, "agent_workspaces", "worktree_checkout_kind", "TEXT");
      addColumn(db, "agent_workspaces", "worktree_branch_owned", "INTEGER NOT NULL DEFAULT 0");
      db.exec(
        `UPDATE agent_workspaces
         SET worktree_checkout_kind = CASE WHEN mode = 'worktree' THEN 'detached' ELSE NULL END,
             worktree_branch_owned = 0`,
      );
      migrateWorktreeIdentitiesToV19(db);
      break;
    case 19: // → v20: saved workflow registry tables.
      createSavedWorkflowRegistry(db);
      break;
    case 20: // → v21: normalize legacy workflow definition source manifests.
      normalizeLegacyWorkflowDefinitionSources(db);
      break;
    case 21: // → v22: workspace setup metadata.
      addColumn(db, "agent_workspaces", "setup_identity_json", "TEXT");
      addColumn(db, "agent_workspaces", "setup_identity_hash", "TEXT");
      addColumn(db, "agent_workspaces", "setup_status", "TEXT NOT NULL DEFAULT 'none'");
      addColumn(db, "agent_workspaces", "setup_started_at_ms", "INTEGER");
      addColumn(db, "agent_workspaces", "setup_finished_at_ms", "INTEGER");
      addColumn(db, "agent_workspaces", "setup_error_json", "TEXT");
      break;
    case 22: // → v23: run-scoped materialized state.
      db.exec(`CREATE TABLE IF NOT EXISTS state (
        run_id         TEXT NOT NULL,
        namespace      TEXT NOT NULL,
        name           TEXT NOT NULL,
        value_inline   TEXT,
        value_artifact TEXT,
        written_key    TEXT NOT NULL,
        updated_at_ms  INTEGER NOT NULL,
        PRIMARY KEY (run_id, namespace, name)
      )`);
      break;
    case 23: // → v24: launch-authority policy is snapshotted per run.
      addColumn(db, "runs", "launch_authority_json", "TEXT");
      addColumn(db, "capabilities", "ceiling_profile", "TEXT");
      break;
    default:
      throw new Error(`no migration defined from schema version ${fromVersion}`);
  }
}

function createSavedWorkflowRegistry(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS saved_workflows (
    name              TEXT PRIMARY KEY,
    title             TEXT,
    description       TEXT,
    tags_json         TEXT,
    created_at_ms     INTEGER NOT NULL,
    updated_at_ms     INTEGER NOT NULL,
    disabled_at_ms    INTEGER,
    deleted_at_ms     INTEGER
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS saved_workflow_versions (
    name                  TEXT NOT NULL,
    version               INTEGER NOT NULL,
    definition_hash        TEXT NOT NULL,
    workflow_name          TEXT,
    input_schema_json      TEXT,
    default_input_json     TEXT,
    default_target         TEXT,
    metadata_json          TEXT,
    source_provenance_json TEXT,
    created_by            TEXT,
    created_at_ms          INTEGER NOT NULL,
    enabled                INTEGER NOT NULL DEFAULT 1,
    deprecated_at_ms       INTEGER,
    deprecation_message    TEXT,
    deleted_at_ms          INTEGER,
    PRIMARY KEY (name, version)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS saved_workflow_versions_by_definition
    ON saved_workflow_versions (definition_hash)`);
  db.exec(`CREATE INDEX IF NOT EXISTS saved_workflow_versions_by_name_version
    ON saved_workflow_versions (name, version DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS saved_workflow_versions_by_name_created
    ON saved_workflow_versions (name, created_at_ms DESC)`);
}

function normalizeLegacyWorkflowDefinitionSources(db: Database): void {
  const rows = db.query<RawWorkflowDefinitionV11, []>("SELECT * FROM workflow_definitions").all();
  for (const row of rows) {
    const normalized = normalizedWorkflowDefinitionSourceManifest(row);
    if (!normalized) continue;

    if (normalized.hash === row.hash) {
      db.query("UPDATE workflow_definitions SET manifest_json = ? WHERE hash = ?").run(
        normalized.manifestJson,
        row.hash,
      );
      continue;
    }

    const existing = db
      .query<RawWorkflowDefinitionV11, [string]>(
        "SELECT * FROM workflow_definitions WHERE hash = ?",
      )
      .get(normalized.hash);
    if (existing) {
      assertWorkflowDefinitionV21CollisionIsMergeable(
        existing,
        row,
        normalized.manifestJson,
        normalized.hash,
      );
    } else {
      db.query(
        `INSERT INTO workflow_definitions (
           hash, name, kind, code, source_map, manifest_json, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        normalized.hash,
        row.name,
        row.kind,
        row.code,
        row.source_map,
        normalized.manifestJson,
        row.created_at_ms,
      );
    }

    updateWorkflowDefinitionReferences(db, row.hash, normalized.hash);
    deleteUnreferencedWorkflowDefinition(db, row.hash);
  }
}

function normalizedWorkflowDefinitionSourceManifest(
  row: RawWorkflowDefinitionV11,
): { hash: string; manifestJson: string } | null {
  if (!row.manifest_json) {
    const manifest = entryOnlyWorkflowDefinitionManifestForV21(row.hash, row.code, null);
    return {
      hash: workflowDefinitionHashForV21Migration(manifest),
      manifestJson: canonicalJson(manifest),
    };
  }

  const manifest = JSON.parse(row.manifest_json) as WorkflowDefinitionManifestV11;
  if (manifest.format !== "keel.workflow-definition.v1") return null;
  if (!Array.isArray(manifest.modules)) {
    throw new Error(`workflow definition ${row.hash} manifest modules must be an array`);
  }
  if (manifest.modules.length > 0) return null;

  const normalized = entryOnlyWorkflowDefinitionManifestForV21(row.hash, row.code, manifest);
  return {
    hash: workflowDefinitionHashForV21Migration(normalized),
    manifestJson: canonicalJson(normalized),
  };
}

function entryOnlyWorkflowDefinitionManifestForV21(
  hash: string,
  code: string,
  manifest: WorkflowDefinitionManifestV11 | null,
): Record<string, unknown> {
  const externalImports = legacyEntryOnlyExternalImports(hash, code);
  const externalPackages = legacyExternalPackagesForV21(hash, manifest);
  const runtime =
    manifest?.runtime && typeof manifest.runtime === "object" && !Array.isArray(manifest.runtime)
      ? manifest.runtime
      : {};
  return {
    format: "keel.workflow-definition.v1",
    entry: "entry.ts",
    modules: [{ path: "entry.ts", code }],
    externalImports,
    externalPackages,
    sourceRoot:
      typeof manifest?.sourceRoot === "string" ? manifest.sourceRoot : "client-captured://source",
    runtime: {
      ...runtime,
      workflowSdkAbi:
        typeof runtime.workflowSdkAbi === "number" ? runtime.workflowSdkAbi : WORKFLOW_SDK_ABI_V12,
    },
  };
}

function legacyEntryOnlyExternalImports(hash: string, code: string): string[] {
  const imports = staticImportsForV12Migration(code, "entry.ts");
  const external = new Set<string>();
  for (const spec of imports) {
    if (spec.startsWith(".") || spec.startsWith("/")) {
      throw new Error(
        `workflow definition ${hash} legacy entry-only source imports local module "${spec}"`,
      );
    }
    if (spec !== "@kcosr/keel") {
      throw new Error(
        `workflow definition ${hash} imports unsupported external "${spec}"; only @kcosr/keel is supported`,
      );
    }
    external.add(spec);
  }
  return [...external].sort();
}

function legacyExternalPackagesForV21(
  hash: string,
  manifest: WorkflowDefinitionManifestV11 | null,
): unknown[] {
  if (!manifest) return [];
  if (!Array.isArray(manifest.externalPackages)) {
    throw new Error(`workflow definition ${hash} manifest externalPackages must be an array`);
  }
  for (const pinned of manifest.externalPackages) {
    if (!isCapturedExternalPackageV11(pinned)) {
      throw new Error(`workflow definition ${hash} manifest external package entries are invalid`);
    }
    if (pinned.name !== "@kcosr/keel") {
      throw new Error(
        `workflow definition ${hash} includes unsupported external package "${pinned.name}"`,
      );
    }
  }
  return [];
}

function workflowDefinitionHashForV21Migration(manifest: Record<string, unknown>): string {
  return `${DEFINITION_PREFIX}${sha256Hex(
    canonicalJson({
      format: manifest.format,
      entry: manifest.entry,
      modules: manifest.modules,
      externalImports: manifest.externalImports,
      externalPackages: manifest.externalPackages,
      runtime: manifest.runtime,
    }),
  )}`;
}

function updateWorkflowDefinitionReferences(db: Database, oldHash: string, newHash: string): void {
  db.query("UPDATE runs SET definition_version = ? WHERE definition_version = ?").run(
    newHash,
    oldHash,
  );
  db.query("UPDATE runs SET workflow_ref = ? WHERE workflow_ref = ?").run(newHash, oldHash);
  db.query("UPDATE schedules SET workflow_ref = ? WHERE workflow_ref = ?").run(newHash, oldHash);
  if (tableExists(db, "saved_workflow_versions")) {
    db.query(
      "UPDATE saved_workflow_versions SET definition_hash = ? WHERE definition_hash = ?",
    ).run(newHash, oldHash);
  }
}

function deleteUnreferencedWorkflowDefinition(db: Database, hash: string): void {
  const savedClause = tableExists(db, "saved_workflow_versions")
    ? "AND hash NOT IN (SELECT definition_hash FROM saved_workflow_versions WHERE deleted_at_ms IS NULL)"
    : "";
  db.query(
    `DELETE FROM workflow_definitions
     WHERE hash = ?
       AND hash NOT IN (SELECT definition_version FROM runs)
       AND hash NOT IN (SELECT workflow_ref FROM runs WHERE workflow_ref IS NOT NULL)
       AND hash NOT IN (SELECT workflow_ref FROM schedules)
       ${savedClause}`,
  ).run(hash);
}

function assertWorkflowDefinitionV21CollisionIsMergeable(
  existing: RawWorkflowDefinitionV11,
  oldRow: RawWorkflowDefinitionV11,
  canonicalManifestJson: string,
  newHash: string,
): void {
  if (
    existing.kind !== oldRow.kind ||
    existing.code !== oldRow.code ||
    existing.manifest_json !== canonicalManifestJson
  ) {
    throw new Error(
      `workflow definition source normalization collision for ${newHash}: existing row differs from normalized content`,
    );
  }
}

function migrateDaemonSettingsToV17(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS daemon_settings (
    key           TEXT PRIMARY KEY,
    value_json    TEXT NOT NULL,
    generation    INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS run_setting_snapshot_sets (
    run_id         TEXT PRIMARY KEY,
    settings_hash  TEXT NOT NULL,
    captured_at_ms INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS run_setting_snapshots (
    run_id             TEXT NOT NULL,
    key                TEXT NOT NULL,
    class              TEXT NOT NULL,
    value_json         TEXT NOT NULL,
    default_json       TEXT NOT NULL,
    source             TEXT NOT NULL,
    catalog_generation INTEGER,
    captured_at_ms     INTEGER NOT NULL,
    PRIMARY KEY (run_id, key)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS run_setting_snapshots_by_run
    ON run_setting_snapshots (run_id)`);

  const snapshot = captureWorkflowVisibleSettingsSnapshot([], 0);
  const insertSet = db.query(
    `INSERT OR IGNORE INTO run_setting_snapshot_sets (run_id, settings_hash, captured_at_ms)
     VALUES (?, ?, ?)`,
  );
  const insertRow = db.query(
    `INSERT OR IGNORE INTO run_setting_snapshots (
       run_id, key, class, value_json, default_json, source, catalog_generation, captured_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const runs = db
    .query<{ run_id: string; status: string }, []>("SELECT run_id, status FROM runs")
    .all();
  for (const run of runs) {
    insertSet.run(run.run_id, snapshot.settingsHash, snapshot.capturedAtMs);
    for (const row of snapshot.rows) {
      insertRow.run(
        run.run_id,
        row.key,
        row.class,
        row.valueJson,
        row.defaultJson,
        row.source,
        row.catalogGeneration,
        snapshot.capturedAtMs,
      );
    }
  }

  const active = runs.filter(
    (run) => !["finished", "failed", "cancelled", "continued"].includes(run.status),
  );
  const nextSeq = db.query<{ seq: number | null }, [string]>(
    "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE run_id = ?",
  );
  const insertEvent = db.query(
    `INSERT INTO events (run_id, seq, type, payload_json, emitted_at_ms)
     VALUES (?, ?, 'run.settingSnapshot.defaultMigration', ?, 0)`,
  );
  for (const run of active) {
    const seq = nextSeq.get(run.run_id)?.seq ?? 1;
    insertEvent.run(
      run.run_id,
      seq,
      canonicalJson({
        runId: run.run_id,
        message:
          "Migrated pre-v17 run with explicit workflow-visible daemon setting defaults; historical settings catalog state was not durable.",
      }),
    );
  }
}

function migrateAgentWorkspacesToV18(db: Database): void {
  if (hasColumn(db, "agent_workspaces", "workspace_identity_hash")) return;
  const rows = db.query<RawAgentWorkspaceV16, []>("SELECT * FROM agent_workspaces").all();
  db.exec("ALTER TABLE agent_workspaces RENAME TO agent_workspaces_old");
  db.exec(`CREATE TABLE agent_workspaces (
    run_id                TEXT NOT NULL,
    workspace_id          TEXT NOT NULL,
    mode                  TEXT NOT NULL,
    owner_kind            TEXT NOT NULL,
    key                   TEXT NOT NULL,
    last_attempt          INTEGER,
    retention_policy      TEXT,
    workspace_path        TEXT NOT NULL,
    source_kind           TEXT,
    source_path           TEXT,
    source_uri            TEXT,
    source_bare           INTEGER,
    source_merge_eligible INTEGER NOT NULL DEFAULT 0,
    supplied_path         TEXT,
    source_ref            TEXT,
    resolved_ref          TEXT,
    checkout_branch       TEXT,
    base_commit           TEXT,
    copy_baseline_path    TEXT,
    creation_error_json   TEXT,
    workspace_identity_json TEXT NOT NULL,
    workspace_identity_hash TEXT NOT NULL,
    owned                 INTEGER NOT NULL DEFAULT 0,
    status                TEXT NOT NULL,
    failure_seen          INTEGER NOT NULL DEFAULT 0,
    last_turn_key         TEXT,
    last_turn_attempt     INTEGER,
    active_holder_kind    TEXT,
    active_holder_key     TEXT,
    active_holder_attempt INTEGER,
    active_started_at_ms  INTEGER,
    last_diff_event_seq   INTEGER,
    last_error_event_seq  INTEGER,
    cleanup_error_json    TEXT,
    created_at_ms         INTEGER NOT NULL,
    updated_at_ms         INTEGER NOT NULL,
    merged_at_ms          INTEGER,
    discarded_at_ms       INTEGER,
    removed_at_ms         INTEGER,
    PRIMARY KEY (run_id, workspace_id)
  )`);
  const insert = db.query(
    `INSERT INTO agent_workspaces (
      run_id, workspace_id, mode, owner_kind, key, last_attempt, retention_policy,
      workspace_path, source_kind, source_path, source_uri, source_bare, source_merge_eligible,
      supplied_path, source_ref, resolved_ref, checkout_branch, base_commit, copy_baseline_path,
      creation_error_json, workspace_identity_json, workspace_identity_hash, owned, status,
      failure_seen, last_turn_key, last_turn_attempt, active_holder_kind, active_holder_key,
      active_holder_attempt, active_started_at_ms, last_diff_event_seq, last_error_event_seq,
      cleanup_error_json, created_at_ms, updated_at_ms, merged_at_ms, discarded_at_ms, removed_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    const mode = row.mode === "direct" ? "direct" : "worktree";
    const sourceKind = mode === "direct" ? "direct-path" : "worktree-git";
    const retention = mode === "direct" ? null : (row.retention_policy ?? "remove");
    const identity =
      mode === "direct"
        ? frozenV18DirectWorkspaceIdentity({
            key: row.key,
            ownerKind: row.owner_kind,
            path: row.workspace_path,
            sdkAbiVersion: WORKFLOW_SDK_ABI_V18,
          })
        : frozenV18WorktreeWorkspaceIdentity({
            key: row.key,
            sourcePath: row.source_path,
            sourceRef: row.source_ref ?? "HEAD",
            retentionPolicy: retention as "remove" | "retain-on-failure" | "retain",
            sdkAbiVersion: WORKFLOW_SDK_ABI_V18,
          });
    insert.run(
      row.run_id,
      row.workspace_id,
      mode,
      row.owner_kind,
      row.key,
      row.last_attempt,
      retention,
      row.workspace_path,
      sourceKind,
      row.source_path,
      null,
      null,
      mode === "worktree" ? 1 : 0,
      row.supplied_path,
      row.source_ref,
      null,
      null,
      row.base_commit,
      null,
      null,
      identity.json,
      identity.hash,
      row.owned,
      row.status,
      row.failure_seen,
      row.last_turn_key,
      row.last_turn_attempt,
      row.active_holder_kind,
      row.active_holder_key,
      row.active_holder_attempt,
      row.active_started_at_ms,
      row.last_diff_event_seq,
      row.last_error_event_seq,
      row.cleanup_error_json,
      row.created_at_ms,
      row.updated_at_ms,
      row.merged_at_ms,
      row.discarded_at_ms,
      row.removed_at_ms,
    );
  }
  db.exec("DROP TABLE agent_workspaces_old");
}

function frozenV18DirectWorkspaceIdentity(input: {
  key: string;
  ownerKind: string;
  path: string;
  sdkAbiVersion: number;
}): { json: string; hash: string } {
  const value = {
    key: input.key,
    mode: "direct",
    ownerKind: input.ownerKind,
    path: input.path,
    rulesVersion: DIRECT_WORKSPACE_RULES_VERSION_V18,
    sdkAbiVersion: input.sdkAbiVersion,
  };
  const json = canonicalJson(value);
  return { json, hash: sha256Hex(json) };
}

function frozenV18WorktreeWorkspaceIdentity(input: {
  key: string;
  sourcePath: string;
  sourceRef: string;
  retentionPolicy: "remove" | "retain-on-failure" | "retain";
  sdkAbiVersion: number;
}): { json: string; hash: string } {
  const value = {
    key: input.key,
    mode: "worktree",
    sourcePath: input.sourcePath,
    sourceRef: input.sourceRef,
    retentionPolicy: input.retentionPolicy,
    rulesVersion: WORKTREE_WORKSPACE_RULES_VERSION_V18,
    sdkAbiVersion: input.sdkAbiVersion,
  };
  const json = canonicalJson(value);
  return { json, hash: sha256Hex(json) };
}

function migrateWorktreeIdentitiesToV19(db: Database): void {
  const rows = db
    .query<
      {
        run_id: string;
        workspace_id: string;
        key: string;
        source_path: string | null;
        source_ref: string | null;
        retention_policy: string | null;
        workspace_identity_json: string;
      },
      []
    >(
      `SELECT run_id, workspace_id, key, source_path, source_ref, retention_policy,
              workspace_identity_json
       FROM agent_workspaces
       WHERE mode = 'worktree'`,
    )
    .all();
  const update = db.query(
    `UPDATE agent_workspaces
     SET workspace_identity_json = ?, workspace_identity_hash = ?
     WHERE run_id = ? AND workspace_id = ?`,
  );
  for (const row of rows) {
    const previous = JSON.parse(row.workspace_identity_json) as { sdkAbiVersion?: unknown };
    const sdkAbiVersion =
      typeof previous.sdkAbiVersion === "number" ? previous.sdkAbiVersion : WORKFLOW_SDK_ABI_V18;
    const identity = workspaceIdentity({
      key: row.key,
      mode: "worktree",
      sourcePath: row.source_path ?? "",
      sourceRef: row.source_ref ?? "HEAD",
      retentionPolicy: (row.retention_policy ?? "remove") as
        | "remove"
        | "retain-on-failure"
        | "retain",
      branchPolicy: "detached",
      sdkAbiVersion,
    });
    update.run(identity.json, identity.hash, row.run_id, row.workspace_id);
  }
}

function migrateAgentProfileCatalogToV16(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS agent_profiles (
    name          TEXT PRIMARY KEY,
    config_json   TEXT NOT NULL,
    config_hash   TEXT NOT NULL,
    generation    INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS run_profile_snapshot_sets (
    run_id          TEXT PRIMARY KEY,
    catalog_hash    TEXT NOT NULL,
    captured_at_ms  INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS run_profile_snapshots (
    run_id             TEXT NOT NULL,
    name               TEXT NOT NULL,
    source             TEXT NOT NULL,
    config_json         TEXT NOT NULL,
    config_hash         TEXT NOT NULL,
    catalog_generation  INTEGER,
    captured_at_ms      INTEGER NOT NULL,
    PRIMARY KEY (run_id, name)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS run_profile_snapshots_by_run
    ON run_profile_snapshots (run_id)`);

  const emptyCatalogHash = sha256Hex(canonicalJson([]));
  db.exec(`INSERT OR IGNORE INTO run_profile_snapshot_sets (run_id, catalog_hash, captured_at_ms)
    SELECT run_id, '${emptyCatalogHash}', 0 FROM runs`);

  const active = db
    .query<{ run_id: string; status: string }, []>(
      `SELECT run_id, status FROM runs
       WHERE status NOT IN ('finished', 'failed', 'cancelled', 'continued')`,
    )
    .all();
  const nextSeq = db.query<{ seq: number | null }, [string]>(
    "SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE run_id = ?",
  );
  const insertEvent = db.query(
    `INSERT INTO events (run_id, seq, type, payload_json, emitted_at_ms)
     VALUES (?, ?, 'run.profileSnapshot.emptyMigration', ?, 0)`,
  );
  for (const run of active) {
    const seq = nextSeq.get(run.run_id)?.seq ?? 1;
    insertEvent.run(
      run.run_id,
      seq,
      canonicalJson({
        runId: run.run_id,
        message:
          "Migrated pre-v16 run with an explicit empty agent profile snapshot; historical profile catalog state was not durable.",
      }),
    );
  }
}

interface RawAgentSessionWorkspaceV13 {
  run_id: string;
  agent_key: string;
  workspace_path: string;
  target: string;
  base_commit: string;
  status: string;
  last_turn_key: string | null;
  last_turn_attempt: number | null;
  last_diff_event_seq: number | null;
  last_error_event_seq: number | null;
  created_at_ms: number;
  updated_at_ms: number;
  merged_at_ms: number | null;
  discarded_at_ms: number | null;
}

interface RawAgentWorkspaceV16 {
  run_id: string;
  workspace_id: string;
  mode: string;
  owner_kind: string;
  key: string;
  last_attempt: number | null;
  retention_policy: string | null;
  workspace_path: string;
  source_path: string;
  supplied_path: string | null;
  source_ref: string | null;
  base_commit: string | null;
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

interface RawWorkflowDefinitionV11 {
  hash: string;
  name: string | null;
  kind: string;
  code: string;
  source_map: string | null;
  manifest_json: string | null;
  created_at_ms: number;
}

interface WorkflowDefinitionManifestV11 {
  format?: unknown;
  entry?: unknown;
  modules?: unknown;
  externalImports?: unknown;
  externalPackages?: unknown;
  sourceRoot?: unknown;
  runtime?: Record<string, unknown>;
}

function migrateWorkflowDefinitionManifestsToV12(db: Database): void {
  const rows = db.query<RawWorkflowDefinitionV11, []>("SELECT * FROM workflow_definitions").all();
  for (const row of rows) {
    if (!row.manifest_json) continue;
    const manifest = JSON.parse(row.manifest_json) as WorkflowDefinitionManifestV11;
    if (manifest.format !== "keel.workflow-definition.v1") continue;
    if (typeof manifest.runtime?.workflowSdkAbi === "number") continue;
    validateWorkflowDefinitionManifestForV12Migration(row.hash, row.code, manifest);

    const canonicalManifest = canonicalWorkflowDefinitionManifestV12(manifest);
    const canonicalManifestJson = canonicalJson(canonicalManifest);
    const newHash = workflowDefinitionHashForV12Migration(canonicalManifest);
    const existing = db
      .query<RawWorkflowDefinitionV11, [string]>(
        "SELECT * FROM workflow_definitions WHERE hash = ?",
      )
      .get(newHash);

    if (existing) {
      assertWorkflowDefinitionCollisionIsMergeable(existing, row, canonicalManifestJson, newHash);
    } else {
      db.query(
        `INSERT INTO workflow_definitions (
           hash, name, kind, code, source_map, manifest_json, created_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        newHash,
        row.name,
        row.kind,
        row.code,
        row.source_map,
        canonicalManifestJson,
        row.created_at_ms,
      );
    }

    db.query("UPDATE runs SET definition_version = ? WHERE definition_version = ?").run(
      newHash,
      row.hash,
    );
    db.query("UPDATE runs SET workflow_ref = ? WHERE workflow_ref = ?").run(newHash, row.hash);
    db.query("UPDATE schedules SET workflow_ref = ? WHERE workflow_ref = ?").run(newHash, row.hash);
    db.query(
      `DELETE FROM workflow_definitions
       WHERE hash = ?
         AND hash NOT IN (SELECT definition_version FROM runs)
         AND hash NOT IN (SELECT workflow_ref FROM runs WHERE workflow_ref IS NOT NULL)
         AND hash NOT IN (SELECT workflow_ref FROM schedules)`,
    ).run(row.hash);
  }
}

function assertWorkflowDefinitionCollisionIsMergeable(
  existing: RawWorkflowDefinitionV11,
  oldRow: RawWorkflowDefinitionV11,
  canonicalManifestJson: string,
  newHash: string,
): void {
  if (
    existing.kind !== oldRow.kind ||
    existing.code !== oldRow.code ||
    existing.source_map !== oldRow.source_map ||
    existing.manifest_json !== canonicalManifestJson
  ) {
    throw new Error(
      `workflow definition migration collision for ${newHash}: existing row differs from migrated content`,
    );
  }
}

export function canonicalWorkflowDefinitionManifestV12(
  manifest: WorkflowDefinitionManifestV11,
): Record<string, unknown> {
  const runtime =
    manifest.runtime && typeof manifest.runtime === "object" && !Array.isArray(manifest.runtime)
      ? manifest.runtime
      : {};
  const packages = Array.isArray(manifest.externalPackages)
    ? manifest.externalPackages.filter(
        (pkg) =>
          !(
            pkg &&
            typeof pkg === "object" &&
            "name" in pkg &&
            (pkg as { name?: unknown }).name === "@kcosr/keel"
          ),
      )
    : [];
  return {
    format: manifest.format,
    entry: manifest.entry,
    modules: manifest.modules,
    externalImports: manifest.externalImports,
    externalPackages: packages,
    sourceRoot: manifest.sourceRoot,
    runtime: {
      ...runtime,
      workflowSdkAbi: WORKFLOW_SDK_ABI_V12,
    },
  };
}

export function workflowDefinitionHashForV12Migration(manifest: Record<string, unknown>): string {
  return `${DEFINITION_PREFIX}${sha256Hex(
    canonicalJson({
      format: manifest.format,
      entry: manifest.entry,
      modules: manifest.modules,
      externalImports: manifest.externalImports,
      externalPackages: manifest.externalPackages,
      runtime: manifest.runtime,
    }),
  )}`;
}

function validateWorkflowDefinitionManifestForV12Migration(
  hash: string,
  code: string,
  manifest: WorkflowDefinitionManifestV11,
): void {
  if (!Array.isArray(manifest.modules)) {
    throw new Error(`workflow definition ${hash} manifest modules must be an array`);
  }
  if (!Array.isArray(manifest.externalImports)) {
    throw new Error(`workflow definition ${hash} manifest externalImports must be an array`);
  }
  if (!Array.isArray(manifest.externalPackages)) {
    throw new Error(`workflow definition ${hash} manifest externalPackages must be an array`);
  }
  const modules = manifest.modules.length > 0 ? manifest.modules : [{ path: "entry.ts", code }];
  for (const module of modules) {
    if (!isCapturedModuleV11(module)) {
      throw new Error(`workflow definition ${hash} manifest module entries are invalid`);
    }
  }
  const actualImports = collectExternalImportsForV12Migration(modules).sort();
  for (const spec of actualImports) {
    if (spec !== "@kcosr/keel") {
      throw new Error(`workflow import "${spec}" is not allowed; only @kcosr/keel is supported`);
    }
  }
  const declaredImports = [...manifest.externalImports].sort();
  if (canonicalJson(declaredImports) !== canonicalJson(actualImports)) {
    throw new Error(`workflow definition ${hash} manifest externalImports do not match source`);
  }
  for (const pinned of manifest.externalPackages) {
    if (!isCapturedExternalPackageV11(pinned)) {
      throw new Error(`workflow definition ${hash} manifest external package entries are invalid`);
    }
    if (pinned.name !== "@kcosr/keel") {
      throw new Error(
        `workflow definition ${hash} includes unsupported external package "${pinned.name}"`,
      );
    }
  }
}

function isCapturedModuleV11(value: unknown): value is { path: string; code: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { path?: unknown }).path === "string" &&
    typeof (value as { code?: unknown }).code === "string"
  );
}

function isCapturedExternalPackageV11(value: unknown): value is { name: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

function collectExternalImportsForV12Migration(
  modules: Array<{ path: string; code: string }>,
): string[] {
  const imports = new Set<string>();
  for (const module of modules) {
    for (const spec of staticImportsForV12Migration(module.code, module.path)) {
      if (!spec.startsWith(".") && !spec.startsWith("/")) imports.add(spec);
    }
  }
  return [...imports];
}

function staticImportsForV12Migration(source: string, filename: string): string[] {
  let ast: { type: string } & Record<string, unknown>;
  try {
    ast = parse(tsTranspiler.transformSync(source), {
      ecmaVersion: "latest",
      sourceType: "module",
    }) as unknown as { type: string } & Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `could not parse workflow imports in ${filename}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const imports: string[] = [];
  walkMigrationAst(ast, (node) => {
    if (node.type === "ImportExpression") {
      throw new Error(`dynamic import(...) is not allowed in workflow code: ${filename}`);
    }
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      const src = (node.source as ({ value?: unknown } & Record<string, unknown>) | undefined)
        ?.value;
      if (typeof src === "string") imports.push(src);
    }
  });
  return imports;
}

function walkMigrationAst(
  root: { type: string } & Record<string, unknown>,
  fn: (node: { type: string } & Record<string, unknown>) => void,
): void {
  const visit = (node: { type: string } & Record<string, unknown>): void => {
    fn(node);
    for (const child of childMigrationNodes(node)) visit(child);
  };
  visit(root);
}

function childMigrationNodes(
  node: { type: string } & Record<string, unknown>,
): Array<{ type: string } & Record<string, unknown>> {
  const out: Array<{ type: string } & Record<string, unknown>> = [];
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "type") continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const v of value) if (isMigrationAstNode(v)) out.push(v);
    } else if (isMigrationAstNode(value)) {
      out.push(value);
    }
  }
  return out;
}

function isMigrationAstNode(value: unknown): value is { type: string } & Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}
