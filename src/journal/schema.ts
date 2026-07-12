// Journal DDL (DESIGN.md Appendix A).
//
// Kept Postgres-compatible as discipline (L11/L17): no SQLite-only column types
// or tricks. Integers are epoch-ms; JSON travels as TEXT. Reserved tables
// (approvals/signals/timers) are created now though their effects land later.

export const SCHEMA_VERSION = 23;

export const DDL = /* sql */ `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id             TEXT PRIMARY KEY,
  workflow_name      TEXT,
  definition_version TEXT NOT NULL,
  workflow_ref       TEXT,
  run_target         TEXT,
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

CREATE TABLE IF NOT EXISTS journal (
  run_id          TEXT NOT NULL,
  stable_key      TEXT NOT NULL,
  attempt         INTEGER NOT NULL DEFAULT 1,
  -- per-run monotonic insertion order (portable; replaces SQLite rowid for
  -- rewind/fork cuts so the dialect stays Postgres-compatible, L11/L17).
  seq             INTEGER NOT NULL DEFAULT 0,
  effect_type     TEXT NOT NULL,
  status          TEXT NOT NULL,
  version         TEXT NOT NULL,
  input_hash      TEXT NOT NULL,
  input_deps_json TEXT,
  key_set_hash    TEXT,
  result_inline   TEXT,
  result_artifact TEXT,
  session_token   TEXT,
  error_json      TEXT,
  started_at_ms   INTEGER,
  finished_at_ms  INTEGER,
  PRIMARY KEY (run_id, stable_key, attempt)
);

CREATE INDEX IF NOT EXISTS journal_by_run ON journal (run_id);

CREATE TABLE IF NOT EXISTS state (
  run_id         TEXT NOT NULL,
  namespace      TEXT NOT NULL,
  name           TEXT NOT NULL,
  value_inline   TEXT,
  value_artifact TEXT,
  written_key    TEXT NOT NULL,
  updated_at_ms  INTEGER NOT NULL,
  PRIMARY KEY (run_id, namespace, name)
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  run_id                    TEXT NOT NULL,
  agent_key                 TEXT NOT NULL,
  identity_hash             TEXT NOT NULL,
  identity_json             TEXT NOT NULL,
  current_session_token     TEXT,
  latest_completed_turn_key TEXT,
  latest_completed_attempt  INTEGER,
  active_turn_key           TEXT,
  active_turn_attempt       INTEGER,
  created_at_ms             INTEGER NOT NULL,
  updated_at_ms             INTEGER NOT NULL,
  PRIMARY KEY (run_id, agent_key)
);

CREATE TABLE IF NOT EXISTS agent_session_turns (
  run_id                  TEXT NOT NULL,
  agent_key               TEXT NOT NULL,
  turn_key                TEXT NOT NULL,
  attempt                 INTEGER NOT NULL,
  stable_key              TEXT NOT NULL,
  status                  TEXT NOT NULL,
  started_session_token   TEXT,
  observed_session_token  TEXT,
  completed_session_token TEXT,
  started_at_ms           INTEGER,
  finished_at_ms          INTEGER,
  PRIMARY KEY (run_id, agent_key, turn_key, attempt),
  UNIQUE (run_id, stable_key, attempt)
);

CREATE TABLE IF NOT EXISTS agent_workspaces (
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
  setup_identity_json   TEXT,
  setup_identity_hash   TEXT,
  setup_status          TEXT NOT NULL DEFAULT 'none',
  setup_started_at_ms   INTEGER,
  setup_finished_at_ms  INTEGER,
  setup_error_json      TEXT,
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

CREATE TABLE IF NOT EXISTS artifacts (
  hash          TEXT PRIMARY KEY,
  byte_len      INTEGER NOT NULL,
  ref_count     INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  data          BLOB
);

CREATE TABLE IF NOT EXISTS events (
  run_id        TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  type          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  emitted_at_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS approvals (
  run_id            TEXT NOT NULL,
  stable_key        TEXT NOT NULL,
  status            TEXT NOT NULL,
  -- what the human is being asked (§17); persisted so a UI/API can render the
  -- decision without reading workflow source.
  prompt            TEXT,
  requested_caps_json TEXT,
  granted_caps_json TEXT,
  decided_by        TEXT,
  note              TEXT,
  requested_at_ms   INTEGER NOT NULL,
  decided_at_ms     INTEGER,
  PRIMARY KEY (run_id, stable_key)
);

CREATE TABLE IF NOT EXISTS signals (
  run_id         TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  name           TEXT NOT NULL,
  correlation_id TEXT,
  payload_ref    TEXT,
  received_at_ms INTEGER NOT NULL,
  -- the ctx.signal call (stable key) that consumed this signal, NULL if pending.
  consumed_key   TEXT,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE IF NOT EXISTS timers (
  run_id     TEXT NOT NULL,
  stable_key TEXT NOT NULL,
  fire_at_ms INTEGER NOT NULL,
  fired      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, stable_key)
);

CREATE TABLE IF NOT EXISTS schedules (
  name         TEXT PRIMARY KEY,
  workflow_ref TEXT NOT NULL,
  input_json   TEXT,
  schedule_target TEXT,
  interval_ms  INTEGER NOT NULL,
  next_fire_ms INTEGER NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_run_id  TEXT,
  last_error_json TEXT,
  last_failed_at_ms INTEGER
);

CREATE TABLE IF NOT EXISTS workflow_definitions (
  hash          TEXT PRIMARY KEY,
  name          TEXT,
  kind          TEXT NOT NULL,
  code          TEXT NOT NULL,
  source_map    TEXT,
  manifest_json TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_workflows (
  name              TEXT PRIMARY KEY,
  title             TEXT,
  description       TEXT,
  tags_json         TEXT,
  created_at_ms     INTEGER NOT NULL,
  updated_at_ms     INTEGER NOT NULL,
  disabled_at_ms    INTEGER,
  deleted_at_ms     INTEGER
);

CREATE TABLE IF NOT EXISTS saved_workflow_versions (
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
);

CREATE INDEX IF NOT EXISTS saved_workflow_versions_by_definition
  ON saved_workflow_versions (definition_hash);

CREATE INDEX IF NOT EXISTS saved_workflow_versions_by_name_version
  ON saved_workflow_versions (name, version DESC);

CREATE INDEX IF NOT EXISTS saved_workflow_versions_by_name_created
  ON saved_workflow_versions (name, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS capabilities (
  id             TEXT PRIMARY KEY,
  secret_hash    TEXT NOT NULL UNIQUE,
  resource_json  TEXT NOT NULL,
  actions_json   TEXT NOT NULL,
  created_at_ms  INTEGER NOT NULL,
  expires_at_ms  INTEGER,
  revoked_at_ms  INTEGER,
  note           TEXT
);

CREATE TABLE IF NOT EXISTS agent_profiles (
  name          TEXT PRIMARY KEY,
  config_json   TEXT NOT NULL,
  config_hash   TEXT NOT NULL,
  generation    INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run_profile_snapshot_sets (
  run_id          TEXT PRIMARY KEY,
  catalog_hash    TEXT NOT NULL,
  captured_at_ms  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run_profile_snapshots (
  run_id             TEXT NOT NULL,
  name               TEXT NOT NULL,
  source             TEXT NOT NULL,
  config_json         TEXT NOT NULL,
  config_hash         TEXT NOT NULL,
  catalog_generation  INTEGER,
  captured_at_ms      INTEGER NOT NULL,
  PRIMARY KEY (run_id, name)
);

CREATE INDEX IF NOT EXISTS run_profile_snapshots_by_run
  ON run_profile_snapshots (run_id);

CREATE TABLE IF NOT EXISTS daemon_settings (
  key           TEXT PRIMARY KEY,
  value_json    TEXT NOT NULL,
  generation    INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run_setting_snapshot_sets (
  run_id         TEXT PRIMARY KEY,
  settings_hash  TEXT NOT NULL,
  captured_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run_setting_snapshots (
  run_id             TEXT NOT NULL,
  key                TEXT NOT NULL,
  class              TEXT NOT NULL,
  value_json         TEXT NOT NULL,
  default_json       TEXT NOT NULL,
  source             TEXT NOT NULL,
  catalog_generation INTEGER,
  captured_at_ms     INTEGER NOT NULL,
  PRIMARY KEY (run_id, key)
);

CREATE INDEX IF NOT EXISTS run_setting_snapshots_by_run
  ON run_setting_snapshots (run_id);
`;
