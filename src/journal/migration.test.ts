// Forward migrations — an older journal upgrades in place instead of failing to
// open, and persisted meaning changes are handled at the migration boundary.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RealmKernel } from "../kernel/realm/realm-host.ts";
import { buildScheduleView } from "../rpc/projection.ts";
import {
  WORKFLOW_SDK_ABI_VERSION,
  materializeWorkflowDefinition,
  snapshotWorkflowSource,
} from "../workflow-definitions/snapshot.ts";
import { workflowDefinitionSourceSelection } from "../workflow-definitions/source-view.ts";
import {
  applyMigration,
  canonicalWorkflowDefinitionManifestV12,
  workflowDefinitionHashForV12Migration,
} from "./migrations.ts";
import { DDL, SCHEMA_VERSION } from "./schema.ts";
import { JournalStore } from "./store.ts";

/** Build a minimal v4-era DB by hand: journal WITHOUT seq, approvals WITHOUT
 * prompt/requested_caps_json, schema_version = 4. */
function makeV4Db(path: string): void {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, workflow_name TEXT, definition_version TEXT,
      workflow_ref TEXT, status TEXT, parent_run_id TEXT, tenant_id TEXT, input_ref TEXT,
      output_ref TEXT, error_json TEXT, heartbeat_at_ms INTEGER, runtime_owner_id TEXT,
      created_at_ms INTEGER, finished_at_ms INTEGER);
    CREATE TABLE journal (run_id TEXT, stable_key TEXT, attempt INTEGER DEFAULT 1,
      effect_type TEXT, status TEXT, version TEXT, input_hash TEXT, input_deps_json TEXT,
      key_set_hash TEXT, result_inline TEXT, result_artifact TEXT, session_token TEXT,
      error_json TEXT, started_at_ms INTEGER, finished_at_ms INTEGER,
      PRIMARY KEY (run_id, stable_key, attempt));
    CREATE TABLE approvals (run_id TEXT, stable_key TEXT, status TEXT, granted_caps_json TEXT,
      decided_by TEXT, note TEXT, requested_at_ms INTEGER, decided_at_ms INTEGER,
      PRIMARY KEY (run_id, stable_key));
    CREATE TABLE signals (run_id TEXT, seq INTEGER, name TEXT, correlation_id TEXT,
      payload_ref TEXT, received_at_ms INTEGER, consumed_key TEXT, PRIMARY KEY (run_id, seq));
  `);
  db.query("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '4')").run();
  // two journal rows so seq backfill has something to order
  db.query(
    "INSERT INTO journal (run_id, stable_key, effect_type, status, version, input_hash) VALUES ('r','a','pure','completed','v','h1')",
  ).run();
  db.query(
    "INSERT INTO journal (run_id, stable_key, effect_type, status, version, input_hash) VALUES ('r','b','pure','completed','v','h2')",
  ).run();
  db.close();
}

/** Build a v8 DB with the pre-v9 schedule meaning and pre-v10 NOT NULL names. */
function makeV8Db(path: string): void {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE runs (
      run_id             TEXT PRIMARY KEY,
      workflow_name      TEXT NOT NULL,
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
    );
    CREATE TABLE schedules (
      name         TEXT PRIMARY KEY,
      workflow_ref TEXT NOT NULL,
      input_json   TEXT,
      interval_ms  INTEGER NOT NULL,
      next_fire_ms INTEGER NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      last_run_id  TEXT
    );
    CREATE TABLE workflow_definitions (
      hash          TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      kind          TEXT NOT NULL,
      code          TEXT NOT NULL,
      source_map    TEXT,
      manifest_json TEXT,
      created_at_ms INTEGER NOT NULL
    );
  `);
  db.query("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '8')").run();
  db.query(
    `INSERT INTO runs (
      run_id, workflow_name, definition_version, workflow_ref, status, input_ref, created_at_ms
    ) VALUES ('r_path', 'path-run', 'wf_sha256_old', '/daemon/path.workflow.ts', 'finished', 'null', 1)`,
  ).run();
  db.query(
    `INSERT INTO schedules (
      name, workflow_ref, input_json, interval_ms, next_fire_ms, enabled
    ) VALUES ('hourly', '/daemon/path.workflow.ts', 'null', 3600000, 1000, 1)`,
  ).run();
  db.query(
    `INSERT INTO workflow_definitions (
      hash, name, kind, code, source_map, manifest_json, created_at_ms
    ) VALUES ('wf_sha256_old', 'path-run', 'path', 'export default async () => 1;', NULL, '{}', 1)`,
  ).run();
  db.close();
}

const sdkWorkflowSource =
  'import { passthrough } from "@kcosr/keel";\nexport default async () => passthrough<number>().parse(1);\n';

function oldWorkflowManifest(source = sdkWorkflowSource, integrity = "sha256-old") {
  return {
    format: "keel.workflow-definition.v1",
    entry: "entry.ts",
    modules: [{ path: "entry.ts", code: source }],
    externalImports: ["@kcosr/keel"],
    externalPackages: [
      {
        name: "@kcosr/keel",
        root: "/old/keel",
        integrity,
      },
    ],
    sourceRoot: "client-captured://source",
    runtime: {
      bunVersion: Bun.version,
      keelDefinitionAbi: 1,
    },
  };
}

function makeV11Db(path: string): void {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE runs (
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
    );
    CREATE TABLE schedules (
      name         TEXT PRIMARY KEY,
      workflow_ref TEXT NOT NULL,
      input_json   TEXT,
      interval_ms  INTEGER NOT NULL,
      next_fire_ms INTEGER NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      last_run_id  TEXT
    );
    CREATE TABLE workflow_definitions (
      hash          TEXT PRIMARY KEY,
      name          TEXT,
      kind          TEXT NOT NULL,
      code          TEXT NOT NULL,
      source_map    TEXT,
      manifest_json TEXT,
      created_at_ms INTEGER NOT NULL
    );
  `);
  db.query("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '11')").run();
  db.close();
}

function makeV20Db(path: string): void {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(DDL);
  db.query("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '20')").run();
  db.close();
}

function insertOldWorkflowDefinition(
  db: Database,
  hash: string,
  manifest: ReturnType<typeof oldWorkflowManifest>,
): void {
  const [entry] = manifest.modules;
  if (!entry) throw new Error("old workflow manifest is missing entry module");
  db.query(
    `INSERT INTO workflow_definitions (
      hash, name, kind, code, source_map, manifest_json, created_at_ms
    ) VALUES (?, 'wf', 'source', ?, NULL, ?, 1)`,
  ).run(hash, entry.code, JSON.stringify(manifest));
}

describe("schema migrations", () => {
  test("a copied v22 journal migrates to v23 with the state table", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mig-v23-state-"));
    try {
      const sourcePath = join(dir, "source.db");
      JournalStore.open(sourcePath).close();
      const path = join(dir, "old.db");
      copyFileSync(sourcePath, path);
      const old = new Database(path);
      old.exec("DROP TABLE state");
      old.query("UPDATE schema_meta SET value = '22' WHERE key = 'schema_version'").run();
      old.close();

      const store = JournalStore.open(path);
      expect(
        store.db
          .query<{ value: string }, []>(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'",
          )
          .get()?.value,
      ).toBe("23");
      store.putStateRow({
        runId: "run",
        namespace: "research",
        name: "best",
        valueInline: "1",
        valueArtifact: null,
        writtenKey: "write#1",
        updatedAtMs: 1,
      });
      expect(store.getRunState("run")).toHaveLength(1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a v4 DB migrates forward to the current schema in place and idempotently", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mig-"));
    try {
      const path = join(dir, "old.db");
      makeV4Db(path);

      // Opening with current code must NOT throw; it migrates forward.
      const store = JournalStore.open(path);

      // schema bumped to current
      const ver = store.db
        .query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key='schema_version'")
        .get();
      expect(ver?.value).toBe(String(SCHEMA_VERSION));

      // new columns exist
      const jcols = store.db.query<{ name: string }, []>("PRAGMA table_info(journal)").all();
      expect(jcols.some((c) => c.name === "seq")).toBe(true);
      const acols = store.db.query<{ name: string }, []>("PRAGMA table_info(approvals)").all();
      expect(acols.some((c) => c.name === "prompt")).toBe(true);
      expect(acols.some((c) => c.name === "requested_caps_json")).toBe(true);
      const wdefs = store.db
        .query<{ name: string }, []>("PRAGMA table_info(workflow_definitions)")
        .all();
      expect(wdefs.some((c) => c.name === "hash")).toBe(true);
      expect(wdefs.some((c) => c.name === "manifest_json")).toBe(true);
      const caps = store.db.query<{ name: string }, []>("PRAGMA table_info(capabilities)").all();
      expect(caps.some((c) => c.name === "secret_hash")).toBe(true);
      expect(caps.some((c) => c.name === "resource_json")).toBe(true);
      const sessions = store.db
        .query<{ name: string }, []>("PRAGMA table_info(agent_sessions)")
        .all();
      expect(sessions.some((c) => c.name === "identity_hash")).toBe(true);
      const turns = store.db
        .query<{ name: string }, []>("PRAGMA table_info(agent_session_turns)")
        .all();
      expect(turns.some((c) => c.name === "observed_session_token")).toBe(true);
      const runCols = store.db.query<{ name: string }, []>("PRAGMA table_info(runs)").all();
      expect(runCols.some((c) => c.name === "run_target")).toBe(true);
      const scheduleCols = store.db
        .query<{ name: string }, []>("PRAGMA table_info(schedules)")
        .all();
      expect(scheduleCols.some((c) => c.name === "schedule_target")).toBe(true);
      const workspaces = store.db
        .query<{ name: string }, []>("PRAGMA table_info(agent_workspaces)")
        .all();
      expect(workspaces.some((c) => c.name === "workspace_id")).toBe(true);
      expect(workspaces.some((c) => c.name === "mode")).toBe(true);
      expect(workspaces.some((c) => c.name === "owner_kind")).toBe(true);
      expect(workspaces.some((c) => c.name === "source_path")).toBe(true);
      expect(workspaces.some((c) => c.name === "owned")).toBe(true);
      expect(workspaces.some((c) => c.name === "active_holder_kind")).toBe(true);
      expect(workspaces.some((c) => c.name === "retention_policy")).toBe(true);
      expect(workspaces.some((c) => c.name === "worktree_checkout_kind")).toBe(true);
      expect(workspaces.some((c) => c.name === "worktree_branch_owned")).toBe(true);

      // existing rows preserved (additive) and seq backfilled per-run monotonic
      const rows = store.listJournalRows("r");
      expect(rows.length).toBe(2);
      const seqs = store.db
        .query<{ seq: number }, []>("SELECT seq FROM journal WHERE run_id='r' ORDER BY seq")
        .all()
        .map((r) => r.seq);
      expect(seqs).toEqual([1, 2]);
      store.close();

      // re-open: idempotent, no migration runs again
      const store2 = JournalStore.open(path);
      expect(store2.listJournalRows("r").length).toBe(2);
      store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v12 migration creates retained workspace metadata when base DDL has not pre-created it", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE runs (
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
        );
        CREATE TABLE schedules (
          name              TEXT PRIMARY KEY,
          workflow_ref      TEXT NOT NULL,
          input_json        TEXT,
          interval_ms       INTEGER NOT NULL,
          next_fire_ms      INTEGER NOT NULL,
          enabled           INTEGER NOT NULL DEFAULT 1,
          last_run_id       TEXT,
          last_error_json   TEXT,
          last_failed_at_ms INTEGER
        );
      `);

      applyMigration(db, 12);

      const runCols = db.query<{ name: string }, []>("PRAGMA table_info(runs)").all();
      expect(runCols.some((c) => c.name === "run_target")).toBe(true);
      const scheduleCols = db.query<{ name: string }, []>("PRAGMA table_info(schedules)").all();
      expect(scheduleCols.some((c) => c.name === "schedule_target")).toBe(true);
      const workspaceCols = db
        .query<{ name: string }, []>("PRAGMA table_info(agent_session_workspaces)")
        .all()
        .map((c) => c.name);
      expect(workspaceCols).toContain("workspace_path");
      expect(workspaceCols).toContain("discarded_at_ms");
    } finally {
      db.close();
    }
  });

  test("v13 migration preserves session workspaces as always-retained legacy unified rows", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE agent_session_workspaces (
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
        );
        INSERT INTO agent_session_workspaces VALUES (
          'r', 'primary', '/tmp/ws', '/repo', 'abc', 'pending_review', 'turn', 2, 3, NULL, 10, 20, NULL, NULL
        );
      `);
      applyMigration(db, 13);
      const row = db
        .query<{ workspace_id: string; kind: string; key: string; retention_policy: string }, []>(
          "SELECT workspace_id, kind, key, retention_policy FROM agent_workspaces",
        )
        .get();
      expect(row).toEqual({
        workspace_id: "ws_02462eede4cdc58d4a2d732a05e6f5c8",
        kind: "agent_session",
        key: "primary",
        retention_policy: "always",
      });
      const oldTable = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_session_workspaces'",
        )
        .get();
      expect(oldTable).toBeNull();
    } finally {
      db.close();
    }
  });

  test("v14 migration converts legacy workspaces to workflow workspace rows", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE agent_workspaces (
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
        );
        INSERT INTO agent_workspaces VALUES (
          'r', 'ws_agent', 'agent_session', 'primary', NULL, 'on-failure', '/tmp/ws', '/repo', 'abc', 'removed', 1, 'turn', 2, 3, 4, NULL, 10, 20, NULL, NULL, 30
        );
      `);
      applyMigration(db, 14);
      const row = db
        .query<
          {
            mode: string;
            owner_kind: string;
            source_path: string;
            source_ref: string | null;
            base_commit: string | null;
            retention_policy: string | null;
            owned: number;
            status: string;
            removed_at_ms: number | null;
            active_holder_kind: string | null;
          },
          []
        >(
          `SELECT mode, owner_kind, source_path, source_ref, base_commit, retention_policy, owned,
                  status, removed_at_ms, active_holder_kind
           FROM agent_workspaces`,
        )
        .get();
      expect(row).toEqual({
        mode: "worktree",
        owner_kind: "agent_session",
        source_path: "/repo",
        source_ref: "HEAD",
        base_commit: "abc",
        retention_policy: "retain-on-failure",
        owned: 1,
        status: "removed",
        removed_at_ms: 30,
        active_holder_kind: null,
      });
      const cols = db.query<{ name: string }, []>("PRAGMA table_info(agent_workspaces)").all();
      expect(cols.some((c) => c.name === "kind")).toBe(false);
      expect(cols.some((c) => c.name === "target")).toBe(false);
    } finally {
      db.close();
    }
  });

  test("v15 databases receive explicit empty profile snapshots and warnings", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mig-v15-"));
    try {
      const path = join(dir, "old.db");
      const db = new Database(path, { create: true });
      db.exec(`
        CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY,
          workflow_name TEXT,
          definition_version TEXT NOT NULL,
          workflow_ref TEXT,
          run_target TEXT,
          status TEXT NOT NULL,
          parent_run_id TEXT,
          tenant_id TEXT,
          input_ref TEXT,
          output_ref TEXT,
          error_json TEXT,
          heartbeat_at_ms INTEGER,
          runtime_owner_id TEXT,
          created_at_ms INTEGER NOT NULL,
          finished_at_ms INTEGER
        );
        CREATE TABLE events (
          run_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          emitted_at_ms INTEGER NOT NULL,
          PRIMARY KEY (run_id, seq)
        );
      `);
      db.query("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '15')").run();
      db.query(
        `INSERT INTO runs (run_id, definition_version, status, created_at_ms)
         VALUES ('r_running', 'wf_sha256_x', 'running', 1), ('r_finished', 'wf_sha256_x', 'finished', 2)`,
      ).run();
      db.close();

      const store = JournalStore.open(path);
      expect(store.getRunProfileSnapshotSet("r_running")).not.toBeNull();
      expect(store.getRunProfileSnapshotSet("r_finished")).not.toBeNull();
      expect(store.listRunProfileSnapshots("r_running")).toEqual([]);
      const warning = store.db
        .query<{ type: string }, []>("SELECT type FROM events WHERE run_id = 'r_running'")
        .get();
      expect(warning?.type).toBe("run.profileSnapshot.emptyMigration");
      const finishedWarning = store.db
        .query<{ type: string }, []>("SELECT type FROM events WHERE run_id = 'r_finished'")
        .get();
      expect(finishedWarning).toBeNull();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fresh DB initializes at the current version with no migration", () => {
    const store = JournalStore.memory();
    const ver = store.db
      .query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key='schema_version'")
      .get();
    expect(ver?.value).toBe(String(SCHEMA_VERSION));
    const savedWorkflows = store.db
      .query<{ name: string }, []>("PRAGMA table_info(saved_workflows)")
      .all();
    expect(savedWorkflows.some((c) => c.name === "name")).toBe(true);
    const savedVersions = store.db
      .query<{ name: string }, []>("PRAGMA table_info(saved_workflow_versions)")
      .all();
    expect(savedVersions.some((c) => c.name === "definition_hash")).toBe(true);
    const indexes = store.db
      .query<{ name: string }, []>("PRAGMA index_list(saved_workflow_versions)")
      .all()
      .map((row) => row.name);
    expect(indexes).toContain("saved_workflow_versions_by_definition");
    expect(indexes).toContain("saved_workflow_versions_by_name_version");
    expect(indexes).toContain("saved_workflow_versions_by_name_created");
    expect(
      store.db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daemon_settings'",
        )
        .get(),
    ).not.toBeNull();
    store.close();
  });

  test("v16 databases receive explicit workflow-visible setting snapshots and warnings", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mig-v16-"));
    try {
      const path = join(dir, "old.db");
      const db = new Database(path, { create: true });
      db.exec(`
        CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY,
          workflow_name TEXT,
          definition_version TEXT NOT NULL,
          workflow_ref TEXT,
          run_target TEXT,
          status TEXT NOT NULL,
          parent_run_id TEXT,
          tenant_id TEXT,
          input_ref TEXT,
          output_ref TEXT,
          error_json TEXT,
          heartbeat_at_ms INTEGER,
          runtime_owner_id TEXT,
          created_at_ms INTEGER NOT NULL,
          finished_at_ms INTEGER
        );
        CREATE TABLE events (
          run_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          emitted_at_ms INTEGER NOT NULL,
          PRIMARY KEY (run_id, seq)
        );
      `);
      db.query("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '16')").run();
      db.query(
        `INSERT INTO runs (run_id, definition_version, status, created_at_ms)
         VALUES ('r_running', 'wf_sha256_x', 'running', 1), ('r_finished', 'wf_sha256_x', 'finished', 2)`,
      ).run();
      db.close();

      const store = JournalStore.open(path);
      expect(store.getRunSettingSnapshotSet("r_running")).not.toBeNull();
      expect(store.getRunSettingSnapshotSet("r_finished")).not.toBeNull();
      const rows = store.listRunSettingSnapshots("r_running");
      expect(rows.map((row) => row.key)).toEqual([
        "agent.defaultLenient",
        "agent.defaultMaxRetries",
        "agent.defaultOnFailure",
        "agent.defaultStallRetries",
        "agent.defaultTimeoutMs",
      ]);
      expect(rows.every((row) => row.source === "default")).toBe(true);
      expect(rows.find((row) => row.key === "agent.defaultTimeoutMs")?.valueJson).toBe("3600000");
      const warning = store.db
        .query<{ type: string }, []>("SELECT type FROM events WHERE run_id = 'r_running'")
        .get();
      expect(warning?.type).toBe("run.settingSnapshot.defaultMigration");
      const finishedWarning = store.db
        .query<{ type: string }, []>("SELECT type FROM events WHERE run_id = 'r_finished'")
        .get();
      expect(finishedWarning).toBeNull();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v8 path schedules are disabled and display-name columns become nullable", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mig-v8-"));
    try {
      const path = join(dir, "old.db");
      makeV8Db(path);

      const store = JournalStore.open(path);
      const ver = store.db
        .query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key='schema_version'")
        .get();
      expect(ver?.value).toBe(String(SCHEMA_VERSION));

      const schedule = store.db
        .query<
          {
            enabled: number;
            workflow_ref: string;
            schedule_target: string | null;
            last_error_json: string | null;
          },
          []
        >(
          "SELECT enabled, workflow_ref, schedule_target, last_error_json FROM schedules WHERE name = 'hourly'",
        )
        .get();
      expect(schedule).toEqual({
        enabled: 0,
        workflow_ref: "/daemon/path.workflow.ts",
        schedule_target: null,
        last_error_json: null,
      });
      expect(buildScheduleView(store, "hourly", { includeSource: true })).toMatchObject({
        name: "hourly",
        enabled: false,
        workflowRef: "/daemon/path.workflow.ts",
        definitionState: "missing",
        workflowName: null,
        workflowKind: null,
        target: null,
        lastError: { kind: "none" },
        input: null,
        inputJson: "null",
        source: null,
      });
      expect(store.getRun("r_path")?.workflowName).toBe("path-run");
      expect(store.getWorkflowDefinition("wf_sha256_old")?.name).toBe("path-run");

      store.insertRun({
        runId: "r_null",
        workflowName: null,
        definitionVersion: "wf_sha256_new",
        workflowRef: "stdin",
        status: "running",
        parentRunId: null,
        tenantId: null,
        inputRef: "null",
        outputRef: null,
        errorJson: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        createdAtMs: 2,
      });
      store.putWorkflowDefinition({
        hash: "wf_sha256_new",
        name: null,
        kind: "source",
        code: "export default async () => 1;",
        sourceMap: null,
        manifestJson: "{}",
        createdAtMs: 2,
      });
      expect(store.getRun("r_null")?.workflowName).toBeNull();
      expect(store.getWorkflowDefinition("wf_sha256_new")?.name).toBeNull();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v11 workflow definitions migrate to SDK ABI manifests and repoint runs and schedules", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mig-v11-"));
    try {
      const path = join(dir, "old.db");
      makeV11Db(path);
      const db = new Database(path);
      const oldHash = "wf_sha256_old_sdk";
      const oldManifest = oldWorkflowManifest();
      const newHash = workflowDefinitionHashForV12Migration(
        canonicalWorkflowDefinitionManifestV12(oldManifest),
      );
      insertOldWorkflowDefinition(db, oldHash, oldManifest);
      db.query(
        `INSERT INTO runs (
          run_id, workflow_name, definition_version, workflow_ref, status,
          input_ref, created_at_ms
        ) VALUES ('r_active', 'wf', ?, 'stdin', 'waiting-timer', 'null', 1)`,
      ).run(oldHash);
      db.query(
        `INSERT INTO runs (
          run_id, workflow_name, definition_version, workflow_ref, status,
          input_ref, created_at_ms
        ) VALUES ('r_scheduled', 'wf', ?, ?, 'finished', 'null', 2)`,
      ).run(oldHash, oldHash);
      db.query(
        `INSERT INTO runs (
          run_id, workflow_name, definition_version, workflow_ref, status,
          input_ref, created_at_ms
        ) VALUES ('r_null_ref', 'wf', ?, NULL, 'finished', 'null', 3)`,
      ).run(oldHash);
      db.query(
        `INSERT INTO schedules (
          name, workflow_ref, input_json, interval_ms, next_fire_ms, enabled
        ) VALUES ('hourly', ?, 'null', 60000, 1, 1)`,
      ).run(oldHash);
      db.close();

      const cacheRoot = join(dir, "definitions");
      const store = JournalStore.open(path);
      expect(store.getRun("r_active")?.definitionVersion).toBe(newHash);
      expect(store.getRun("r_scheduled")).toMatchObject({
        definitionVersion: newHash,
        workflowRef: newHash,
      });
      expect(store.getRun("r_null_ref")).toMatchObject({
        definitionVersion: newHash,
        workflowRef: null,
      });
      const schedule = store.db
        .query<{ workflow_ref: string; last_error_json: string | null }, []>(
          "SELECT workflow_ref, last_error_json FROM schedules WHERE name = 'hourly'",
        )
        .get();
      expect(schedule).toEqual({ workflow_ref: newHash, last_error_json: null });
      expect(store.getWorkflowDefinition(oldHash)).toBeNull();
      expect(store.getWorkflowDefinition(newHash)).not.toBeNull();

      expect(() => materializeWorkflowDefinition(store, newHash, cacheRoot)).toThrow(
        `requires workflow SDK ABI 1, but this daemon supports ABI ${WORKFLOW_SDK_ABI_VERSION}`,
      );
      const kernel = new RealmKernel(store, { clock: () => 2, definitionCacheRoot: cacheRoot });
      await expect(kernel.resume("r_active")).rejects.toThrow(
        `requires workflow SDK ABI 1, but this daemon supports ABI ${WORKFLOW_SDK_ABI_VERSION}`,
      );
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v11 workflow migration fails on a recomputed hash collision with different content", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mig-v11-collision-"));
    try {
      const path = join(dir, "old.db");
      makeV11Db(path);
      const db = new Database(path);
      const oldManifest = oldWorkflowManifest();
      const newHash = workflowDefinitionHashForV12Migration(
        canonicalWorkflowDefinitionManifestV12(oldManifest),
      );
      insertOldWorkflowDefinition(db, "wf_sha256_old_collision", oldManifest);
      db.query(
        `INSERT INTO workflow_definitions (
          hash, name, kind, code, source_map, manifest_json, created_at_ms
        ) VALUES (?, 'other', 'source', 'export default async () => 2;', NULL, '{}', 1)`,
      ).run(newHash);
      db.close();

      expect(() => JournalStore.open(path)).toThrow(/workflow definition migration collision/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v11 workflow migration rejects persisted SDK subpaths and arbitrary package imports", () => {
    const cases = [
      {
        hash: "wf_sha256_bad_subpath",
        source:
          'import { runExecuteScript } from "@kcosr/keel/execute"; export default async () => runExecuteScript;\n',
        externalImports: ["@kcosr/keel/execute"],
        externalPackages: [{ name: "@kcosr/keel", root: "/old/keel", integrity: "sha256-old" }],
        message: /@kcosr\/keel\/execute" is not allowed/,
      },
      {
        hash: "wf_sha256_bad_package",
        source: 'import leftPad from "left-pad"; export default async () => leftPad;\n',
        externalImports: ["left-pad"],
        externalPackages: [
          { name: "left-pad", root: "/old/node_modules/left-pad", integrity: "sha256-old" },
        ],
        message: /left-pad" is not allowed/,
      },
    ];

    for (const c of cases) {
      const dir = mkdtempSync(join(tmpdir(), "keel-mig-v11-invalid-import-"));
      try {
        const path = join(dir, "old.db");
        makeV11Db(path);
        const db = new Database(path);
        insertOldWorkflowDefinition(db, c.hash, {
          ...oldWorkflowManifest(c.source),
          externalImports: c.externalImports,
          externalPackages: c.externalPackages,
        });
        db.close();

        expect(() => JournalStore.open(path)).toThrow(c.message);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("v11 workflow migration collapses duplicate definitions that differ only by SDK pin", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mig-v11-duplicates-"));
    try {
      const path = join(dir, "old.db");
      makeV11Db(path);
      const db = new Database(path);
      const oldA = oldWorkflowManifest(sdkWorkflowSource, "sha256-old-a");
      const oldB = oldWorkflowManifest(sdkWorkflowSource, "sha256-old-b");
      const newHash = workflowDefinitionHashForV12Migration(
        canonicalWorkflowDefinitionManifestV12(oldA),
      );
      insertOldWorkflowDefinition(db, "wf_sha256_old_a", oldA);
      insertOldWorkflowDefinition(db, "wf_sha256_old_b", oldB);
      db.query(
        `INSERT INTO runs (
          run_id, workflow_name, definition_version, workflow_ref, status,
          input_ref, created_at_ms
        ) VALUES ('r_a', 'wf', 'wf_sha256_old_a', 'wf_sha256_old_a', 'running', 'null', 1)`,
      ).run();
      db.query(
        `INSERT INTO schedules (
          name, workflow_ref, input_json, interval_ms, next_fire_ms, enabled
        ) VALUES ('hourly', 'wf_sha256_old_b', 'null', 60000, 1, 0)`,
      ).run();
      db.close();

      const store = JournalStore.open(path);
      expect(store.getRun("r_a")).toMatchObject({
        definitionVersion: newHash,
        workflowRef: newHash,
      });
      expect(
        store.db.query<{ workflow_ref: string }, []>("SELECT workflow_ref FROM schedules").get()
          ?.workflow_ref,
      ).toBe(newHash);
      expect(store.getWorkflowDefinition("wf_sha256_old_a")).toBeNull();
      expect(store.getWorkflowDefinition("wf_sha256_old_b")).toBeNull();
      expect(
        store.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM workflow_definitions").get()
          ?.c,
      ).toBe(1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v21 workflow source migration normalizes legacy code-only and empty-module definitions", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mig-v21-workflow-source-"));
    try {
      const path = join(dir, "old.db");
      makeV20Db(path);
      const db = new Database(path);
      const codeOnlyHash = "wf_sha256_legacy_codeonly";
      const emptyModulesHash = "wf_sha256_legacy_empty_modules";
      const codeOnlySource =
        'import { passthrough } from "@kcosr/keel";\nexport default async () => passthrough<string>().parse("ok");\n';
      const emptyModulesSource = "export default async () => 7;\n";
      db.query(
        `INSERT INTO workflow_definitions (
          hash, name, kind, code, source_map, manifest_json, created_at_ms
        ) VALUES (?, 'legacy-code', 'source', ?, NULL, NULL, 1)`,
      ).run(codeOnlyHash, codeOnlySource);
      db.query(
        `INSERT INTO workflow_definitions (
          hash, name, kind, code, source_map, manifest_json, created_at_ms
        ) VALUES (?, 'legacy-empty', 'source', ?, NULL, ?, 2)`,
      ).run(
        emptyModulesHash,
        emptyModulesSource,
        JSON.stringify({
          format: "keel.workflow-definition.v1",
          entry: "ignored.ts",
          modules: [],
          externalImports: [],
          externalPackages: [],
          sourceRoot: "client-captured://source",
          runtime: {
            bunVersion: Bun.version,
            keelDefinitionAbi: 1,
            workflowSdkAbi: WORKFLOW_SDK_ABI_VERSION,
          },
        }),
      );
      db.query(
        `INSERT INTO runs (
          run_id, workflow_name, definition_version, workflow_ref, run_target, status,
          input_ref, created_at_ms
        ) VALUES ('r_code', 'legacy-code', ?, ?, '/tmp/repo', 'finished', 'null', 1)`,
      ).run(codeOnlyHash, codeOnlyHash);
      db.query(
        `INSERT INTO schedules (
          name, workflow_ref, input_json, schedule_target, interval_ms, next_fire_ms, enabled
        ) VALUES ('hourly', ?, 'null', '/tmp/repo', 60000, 1, 1)`,
      ).run(emptyModulesHash);
      db.query(
        `INSERT INTO saved_workflows (
          name, tags_json, created_at_ms, updated_at_ms
        ) VALUES ('legacy', '[]', 1, 1)`,
      ).run();
      db.query(
        `INSERT INTO saved_workflow_versions (
          name, version, definition_hash, created_at_ms
        ) VALUES ('legacy', 1, ?, 1)`,
      ).run(codeOnlyHash);
      db.close();

      const store = JournalStore.open(path);
      const migratedRun = store.getRun("r_code");
      const schedule = store.db
        .query<{ workflow_ref: string }, []>(
          "SELECT workflow_ref FROM schedules WHERE name='hourly'",
        )
        .get();
      const saved = store.db
        .query<{ definition_hash: string }, []>(
          "SELECT definition_hash FROM saved_workflow_versions WHERE name='legacy'",
        )
        .get();
      expect(migratedRun).not.toBeNull();
      expect(schedule).not.toBeNull();
      if (!migratedRun) throw new Error("missing migrated run");
      if (!schedule) throw new Error("missing migrated schedule");
      expect(migratedRun.workflowRef).not.toBeNull();
      expect(migratedRun.definitionVersion).not.toBe(codeOnlyHash);
      expect(migratedRun.definitionVersion).toBe(migratedRun.workflowRef as string);
      expect(saved?.definition_hash).toBe(migratedRun.definitionVersion);
      expect(schedule.workflow_ref).not.toBe(emptyModulesHash);
      expect(store.getWorkflowDefinition(codeOnlyHash)).toBeNull();
      expect(store.getWorkflowDefinition(emptyModulesHash)).toBeNull();

      const codeDefinition = store.getWorkflowDefinition(migratedRun.definitionVersion);
      expect(codeDefinition?.manifestJson).not.toBeNull();
      expect(
        workflowDefinitionSourceSelection(codeDefinition as NonNullable<typeof codeDefinition>),
      ).toEqual({
        entry: "entry.ts",
        files: [{ path: "entry.ts", code: codeOnlySource, entry: true }],
      });
      const emptyModulesDefinition = store.getWorkflowDefinition(schedule.workflow_ref);
      expect(
        workflowDefinitionSourceSelection(
          emptyModulesDefinition as NonNullable<typeof emptyModulesDefinition>,
        ),
      ).toEqual({
        entry: "entry.ts",
        files: [{ path: "entry.ts", code: emptyModulesSource, entry: true }],
      });
      const entryPath = materializeWorkflowDefinition(
        store,
        schedule.workflow_ref,
        join(dir, "definitions"),
      );
      expect(readFileSync(entryPath, "utf8")).toBe(emptyModulesSource);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v21 workflow source migration merges source-map-only legacy collisions", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mig-v21-source-map-collision-"));
    try {
      const path = join(dir, "old.db");
      makeV20Db(path);
      const db = new Database(path);
      const source = "export default async () => 'ok';\n";
      db.query(
        `INSERT INTO workflow_definitions (
          hash, name, kind, code, source_map, manifest_json, created_at_ms
        ) VALUES ('wf_sha256_legacy_a', 'legacy-a', 'source', ?, 'old-map-a', NULL, 1)`,
      ).run(source);
      db.query(
        `INSERT INTO workflow_definitions (
          hash, name, kind, code, source_map, manifest_json, created_at_ms
        ) VALUES ('wf_sha256_legacy_b', 'legacy-b', 'source', ?, 'old-map-b', NULL, 2)`,
      ).run(source);
      db.query(
        `INSERT INTO runs (
          run_id, workflow_name, definition_version, workflow_ref, run_target, status,
          input_ref, created_at_ms
        ) VALUES ('r_a', 'legacy-a', 'wf_sha256_legacy_a', 'wf_sha256_legacy_a', '/tmp/repo', 'finished', 'null', 1)`,
      ).run();
      db.query(
        `INSERT INTO runs (
          run_id, workflow_name, definition_version, workflow_ref, run_target, status,
          input_ref, created_at_ms
        ) VALUES ('r_b', 'legacy-b', 'wf_sha256_legacy_b', 'wf_sha256_legacy_b', '/tmp/repo', 'finished', 'null', 2)`,
      ).run();
      db.close();

      const store = JournalStore.open(path);
      const runA = store.getRun("r_a");
      const runB = store.getRun("r_b");
      expect(runA?.definitionVersion).toBe(runB?.definitionVersion);
      expect(runA?.workflowRef).toBe(runA?.definitionVersion);
      expect(runB?.workflowRef).toBe(runB?.definitionVersion);
      expect(store.getWorkflowDefinition("wf_sha256_legacy_a")).toBeNull();
      expect(store.getWorkflowDefinition("wf_sha256_legacy_b")).toBeNull();
      expect(
        store.db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM workflow_definitions").get()
          ?.c,
      ).toBe(1);
      const normalized = store.getWorkflowDefinition(runA?.definitionVersion ?? "");
      expect(normalized?.sourceMap).toBe("old-map-a");
      expect(
        workflowDefinitionSourceSelection(normalized as NonNullable<typeof normalized>),
      ).toEqual({
        entry: "entry.ts",
        files: [{ path: "entry.ts", code: source, entry: true }],
      });
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v21 workflow source migration rejects legacy entry-only local imports", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mig-v21-workflow-source-invalid-"));
    try {
      const path = join(dir, "old.db");
      makeV20Db(path);
      const db = new Database(path);
      db.query(
        `INSERT INTO workflow_definitions (
          hash, name, kind, code, source_map, manifest_json, created_at_ms
        ) VALUES ('wf_sha256_legacy_local_import', 'legacy', 'source', ?, NULL, NULL, 1)`,
      ).run('import "./helper";\nexport default async () => 1;\n');
      db.close();

      expect(() => JournalStore.open(path)).toThrow(
        /legacy entry-only source imports local module "\.\/helper"/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v12 migration stamps the historical workflow SDK ABI", () => {
    const store = JournalStore.memory();
    try {
      const { snapshot } = snapshotWorkflowSource(store, sdkWorkflowSource, {
        name: "lock",
        nowMs: 1,
      });
      const { workflowSdkAbi: _workflowSdkAbi, ...oldRuntime } = snapshot.manifest.runtime;
      const migrated = canonicalWorkflowDefinitionManifestV12({
        ...snapshot.manifest,
        externalPackages: [{ name: "@kcosr/keel", root: "/old/keel", integrity: "sha256-old" }],
        runtime: oldRuntime,
      });
      expect((migrated.runtime as { workflowSdkAbi: number }).workflowSdkAbi).toBe(1);
      expect(workflowDefinitionHashForV12Migration(migrated)).not.toBe(snapshot.hash);
    } finally {
      store.close();
    }
  });

  test("v16 agent workspaces migrate source metadata and identity hashes", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mig-v16-workspaces-"));
    try {
      const path = join(dir, "old.db");
      const db = new Database(path, { create: true });
      db.exec(`
        CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO schema_meta (key, value) VALUES ('schema_version', '16');
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY, workflow_name TEXT, definition_version TEXT NOT NULL,
          workflow_ref TEXT, run_target TEXT, status TEXT NOT NULL, parent_run_id TEXT,
          tenant_id TEXT, input_ref TEXT, output_ref TEXT, error_json TEXT,
          heartbeat_at_ms INTEGER, runtime_owner_id TEXT, created_at_ms INTEGER NOT NULL,
          finished_at_ms INTEGER
        );
        CREATE TABLE journal (
          run_id TEXT, stable_key TEXT, attempt INTEGER DEFAULT 1, seq INTEGER DEFAULT 0,
          effect_type TEXT, status TEXT, version TEXT, input_hash TEXT, input_deps_json TEXT,
          key_set_hash TEXT, result_inline TEXT, result_artifact TEXT, session_token TEXT,
          error_json TEXT, started_at_ms INTEGER, finished_at_ms INTEGER,
          PRIMARY KEY (run_id, stable_key, attempt)
        );
        CREATE TABLE agent_sessions (
          run_id TEXT, agent_key TEXT, identity_hash TEXT, identity_json TEXT,
          current_session_token TEXT, latest_completed_turn_key TEXT,
          latest_completed_attempt INTEGER, active_turn_key TEXT, active_turn_attempt INTEGER,
          created_at_ms INTEGER, updated_at_ms INTEGER, PRIMARY KEY (run_id, agent_key)
        );
        CREATE TABLE agent_session_turns (
          run_id TEXT, agent_key TEXT, turn_key TEXT, attempt INTEGER, stable_key TEXT,
          status TEXT, started_session_token TEXT, observed_session_token TEXT,
          completed_session_token TEXT, started_at_ms INTEGER, finished_at_ms INTEGER,
          PRIMARY KEY (run_id, agent_key, turn_key, attempt)
        );
        CREATE TABLE agent_workspaces (
          run_id TEXT NOT NULL, workspace_id TEXT NOT NULL, mode TEXT NOT NULL,
          owner_kind TEXT NOT NULL, key TEXT NOT NULL, last_attempt INTEGER,
          retention_policy TEXT, workspace_path TEXT NOT NULL, source_path TEXT NOT NULL,
          supplied_path TEXT, source_ref TEXT, base_commit TEXT, owned INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL, failure_seen INTEGER NOT NULL DEFAULT 0, last_turn_key TEXT,
          last_turn_attempt INTEGER, active_holder_kind TEXT, active_holder_key TEXT,
          active_holder_attempt INTEGER, active_started_at_ms INTEGER, last_diff_event_seq INTEGER,
          last_error_event_seq INTEGER, cleanup_error_json TEXT, created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL, merged_at_ms INTEGER, discarded_at_ms INTEGER,
          removed_at_ms INTEGER, PRIMARY KEY (run_id, workspace_id)
        );
      `);
      db.query(
        `INSERT INTO agent_workspaces (
          run_id, workspace_id, mode, owner_kind, key, last_attempt, retention_policy,
          workspace_path, source_path, supplied_path, source_ref, base_commit, owned, status,
          failure_seen, created_at_ms, updated_at_ms
        ) VALUES ('r', 'checkout', 'worktree', 'workflow', 'checkout', NULL, 'retain',
          '/store/r/checkout', '/repo', NULL, 'HEAD', 'abc', 1, 'pending_review', 0, 1, 1)`,
      ).run();
      db.close();

      const store = JournalStore.open(path);
      const row = store.getAgentWorkspace("r", "checkout");
      expect(row).toMatchObject({
        sourceKind: "worktree-git",
        sourceMergeEligible: true,
        worktreeCheckoutKind: "detached",
        worktreeBranchOwned: false,
        workspaceIdentityHash: expect.any(String),
      });
      expect(row?.workspaceIdentityHash).not.toBe("");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v18 workspaces migrate worktree checkout metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-mig-v18-worktree-checkout-"));
    try {
      const path = join(dir, "old.db");
      const db = new Database(path, { create: true });
      db.exec(`
        CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO schema_meta (key, value) VALUES ('schema_version', '18');
        CREATE TABLE agent_workspaces (
          run_id TEXT NOT NULL, workspace_id TEXT NOT NULL, mode TEXT NOT NULL,
          owner_kind TEXT NOT NULL, key TEXT NOT NULL, last_attempt INTEGER,
          retention_policy TEXT, workspace_path TEXT NOT NULL, source_kind TEXT,
          source_path TEXT, source_uri TEXT, source_bare INTEGER,
          source_merge_eligible INTEGER NOT NULL DEFAULT 0, supplied_path TEXT,
          source_ref TEXT, resolved_ref TEXT, checkout_branch TEXT, base_commit TEXT,
          copy_baseline_path TEXT, creation_error_json TEXT,
          workspace_identity_json TEXT NOT NULL, workspace_identity_hash TEXT NOT NULL,
          owned INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
          failure_seen INTEGER NOT NULL DEFAULT 0, last_turn_key TEXT,
          last_turn_attempt INTEGER, active_holder_kind TEXT, active_holder_key TEXT,
          active_holder_attempt INTEGER, active_started_at_ms INTEGER,
          last_diff_event_seq INTEGER, last_error_event_seq INTEGER,
          cleanup_error_json TEXT, created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL, merged_at_ms INTEGER, discarded_at_ms INTEGER,
          removed_at_ms INTEGER, PRIMARY KEY (run_id, workspace_id)
        );
        INSERT INTO agent_workspaces (
          run_id, workspace_id, mode, owner_kind, key, retention_policy,
          workspace_path, source_kind, source_path, source_merge_eligible,
          source_ref, resolved_ref, checkout_branch, base_commit,
          workspace_identity_json, workspace_identity_hash, owned, status,
          failure_seen, created_at_ms, updated_at_ms
        ) VALUES
          ('r', 'wt', 'worktree', 'workflow', 'wt', 'retain', '/store/wt',
           'worktree-git', '/repo', 1, 'HEAD', 'HEAD', NULL, 'abc',
           '{"sdkAbiVersion":6}', 'old-wt', 1, 'pending_review', 0, 1, 1),
          ('r', 'clone', 'clone', 'workflow', 'clone', 'retain', '/store/clone',
           'local-clone-git', '/repo', 1, NULL, 'main', 'main', 'def',
           '{"sdkAbiVersion":6}', 'old-clone', 1, 'pending_review', 0, 1, 1);
      `);
      db.close();

      const store = JournalStore.open(path);
      const wt = store.getAgentWorkspace("r", "wt");
      expect(wt).toMatchObject({
        worktreeCheckoutKind: "detached",
        worktreeBranchOwned: false,
        checkoutBranch: null,
      });
      expect(JSON.parse(wt?.workspaceIdentityJson ?? "{}")).toMatchObject({
        branchPolicy: "detached",
        rulesVersion: 2,
        sdkAbiVersion: 6,
      });
      expect(wt?.workspaceIdentityHash).not.toBe("old-wt");
      const clone = store.getAgentWorkspace("r", "clone");
      expect(clone).toMatchObject({
        worktreeCheckoutKind: null,
        worktreeBranchOwned: false,
        checkoutBranch: "main",
      });
      expect(clone?.workspaceIdentityHash).toBe("old-clone");
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("v19 migration creates saved workflow registry tables and indexes", () => {
    const db = new Database(":memory:");
    try {
      applyMigration(db, 19);
      const workflows = db.query<{ name: string }, []>("PRAGMA table_info(saved_workflows)").all();
      expect(workflows.some((column) => column.name === "name")).toBe(true);
      const versions = db
        .query<{ name: string }, []>("PRAGMA table_info(saved_workflow_versions)")
        .all();
      expect(versions.some((column) => column.name === "definition_hash")).toBe(true);
      const indexes = db
        .query<{ name: string }, []>("PRAGMA index_list(saved_workflow_versions)")
        .all()
        .map((row) => row.name);
      expect(indexes).toContain("saved_workflow_versions_by_definition");
      expect(indexes).toContain("saved_workflow_versions_by_name_version");
      expect(indexes).toContain("saved_workflow_versions_by_name_created");
    } finally {
      db.close();
    }
  });

  test("saved workflow store validates names, duplicates, latest, and tombstones", () => {
    const store = JournalStore.memory();
    try {
      const definition = {
        hash: "wf_sha256_savedtest",
        name: "wf",
        kind: "source",
        code: "export default async () => 1;",
        sourceMap: null,
        manifestJson: JSON.stringify({
          format: "keel.workflow-definition.v1",
          entry: "entry.ts",
          modules: [{ path: "entry.ts", code: "export default async () => 1;" }],
          externalImports: [],
          externalPackages: [],
          sourceRoot: "client-captured://source",
          runtime: {
            bunVersion: Bun.version,
            keelDefinitionAbi: 1,
            workflowSdkAbi: WORKFLOW_SDK_ABI_VERSION,
          },
        }),
        createdAtMs: 1,
      };
      expect(() =>
        store.putSavedWorkflowVersion({
          name: "wf_sha256_deadbeef",
          definition,
          createdAtMs: 1,
        }),
      ).toThrow(/reserved/);
      expect(() =>
        store.putSavedWorkflowVersion({
          name: "missing-def",
          definitionHash: "wf_sha256_missing",
          createdAtMs: 1,
        }),
      ).toThrow(/does not exist/);
      const v1 = store.putSavedWorkflowVersion({
        name: "review-loop",
        version: 1,
        definition,
        createdAtMs: 10,
      });
      expect(v1.version).toBe(1);
      expect(() =>
        store.putSavedWorkflowVersion({
          name: "review-loop",
          definitionHash: definition.hash,
          createdAtMs: 11,
        }),
      ).toThrow(/already has definition/);
      const v3 = store.putSavedWorkflowVersion({
        name: "review-loop",
        version: 3,
        definitionHash: definition.hash,
        createdAtMs: 1,
        allowDuplicateDefinition: true,
      });
      expect(v3.version).toBe(3);
      expect(store.resolveSavedWorkflowRef({ name: "review-loop" }).version).toBe(3);
      store.deprecateSavedWorkflowVersion("review-loop", 3, "old", 20);
      expect(store.resolveSavedWorkflowRef({ name: "review-loop" }).version).toBe(1);
      expect(
        store.resolveSavedWorkflowRef({ name: "review-loop", allowDeprecated: true }).version,
      ).toBe(3);
      expect(() => store.resolveSavedWorkflowRef({ name: "review-loop", version: 3 })).toThrow(
        /deprecated/,
      );
      expect(
        store.resolveSavedWorkflowRef({
          name: "review-loop",
          version: 3,
          allowDeprecated: true,
        }).version,
      ).toBe(3);
      store.deleteSavedWorkflowVersion("review-loop", 1, 30);
      expect(() => store.resolveSavedWorkflowRef({ name: "review-loop" })).toThrow(/matching/);
      expect(store.getWorkflowDefinition(definition.hash)).not.toBeNull();
      expect(store.pruneWorkflowDefinitions({ nowMs: 100_000, ttlMs: 1 })).toBe(0);

      expect(() =>
        store.putSavedWorkflowVersion({
          name: "partial-failure",
          version: 0,
          definition,
          createdAtMs: 40,
          allowDuplicateDefinition: true,
        }),
      ).toThrow(/positive integer/);
      expect(store.getSavedWorkflow("partial-failure")).toBeNull();
      const partialVersions = store.db
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM saved_workflow_versions WHERE name = ?",
        )
        .get("partial-failure");
      expect(partialVersions?.count).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe("workspace setup migration", () => {
  test("v21 agent workspace rows migrate with setup status none", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-migrate-setup-"));
    const dbPath = join(dir, "journal.sqlite");
    const db = new Database(dbPath, { create: true });
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO schema_meta (key, value) VALUES ('schema_version', '21');
      CREATE TABLE agent_workspaces (
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
        worktree_checkout_kind TEXT,
        worktree_branch_owned INTEGER NOT NULL DEFAULT 0,
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
      );
      INSERT INTO agent_workspaces (
        run_id, workspace_id, mode, owner_kind, key, last_attempt, retention_policy,
        workspace_path, source_kind, source_path, source_uri, source_bare, source_merge_eligible,
        supplied_path, source_ref, resolved_ref, checkout_branch, worktree_checkout_kind,
        worktree_branch_owned, base_commit, copy_baseline_path, creation_error_json,
        workspace_identity_json, workspace_identity_hash, owned, status, failure_seen,
        last_turn_key, last_turn_attempt, active_holder_kind, active_holder_key,
        active_holder_attempt, active_started_at_ms, last_diff_event_seq, last_error_event_seq,
        cleanup_error_json, created_at_ms, updated_at_ms, merged_at_ms, discarded_at_ms, removed_at_ms
      ) VALUES (
        'r', 'ws', 'direct', 'workflow', 'ws', NULL, NULL,
        '/tmp/ws', 'direct-path', '/tmp/ws', NULL, NULL, 0,
        '/tmp/ws', NULL, NULL, NULL, NULL,
        0, NULL, NULL, NULL,
        '{}', 'identity', 0, 'idle', 0,
        NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL,
        NULL, 1, 1, NULL, NULL, NULL
      );
    `);
    db.close();
    try {
      const store = JournalStore.open(dbPath);
      expect(
        store.db
          .query<{ value: string }, [string]>("SELECT value FROM schema_meta WHERE key = ?")
          .get("schema_version")?.value,
      ).toBe(String(SCHEMA_VERSION));
      expect(store.getAgentWorkspace("r", "ws")).toMatchObject({
        setupStatus: "none",
        setupIdentityHash: null,
        setupErrorJson: null,
      });
      const cols = store.db
        .query<{ name: string }, []>("PRAGMA table_info(agent_workspaces)")
        .all()
        .map((col) => col.name);
      expect(cols).toEqual(expect.arrayContaining(["setup_status", "setup_identity_hash"]));
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
