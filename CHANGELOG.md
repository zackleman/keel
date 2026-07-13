# Changelog

## [Unreleased]

### Changed
- Added submitter credentials with named launch-authority ceilings, launch-time over-ask
  rejection, run-scoped approval grants through MCP, review-gated immutable workflow
  promotion, seven-day one-off archive retention, schema v24, and the remote deployment
  hardening recipe. Trusted local/admin launches remain unrestricted.
- Added durable child workflows with journaled `ctx.spawn`/`ctx.waitRun`,
  definition pinning, crash-safe child ID reservation, child run lineage, scoped
  child capabilities, and MCP `list_runs.children_of` filtering. The workflow
  SDK ABI is now 14.
- The web console is now a responsive operator workspace with a mobile drawer,
  session-scoped credential dialog, URL-backed live run filters, bounded older-run
  loading, readable status labels, consolidated run-detail views, and
  capability-aware lifecycle actions.
  ([#31](https://github.com/kcosr/keel/pull/31))
- Saved workflows, schedules, catalog profiles, and mutable settings can now be
  managed directly from the web console with validation, generation
  preconditions, and confirmations for destructive operations. Schedule state
  now has canonical admin RPC operations for pause/resume and deletion.
  ([#31](https://github.com/kcosr/keel/pull/31))
- Workflow launch and schedule target fields in the web console now include an
  admin-authorized directory picker backed by the daemon host filesystem.
  ([#31](https://github.com/kcosr/keel/pull/31))
- The README now includes a fuller project introduction, system/replay diagrams,
  tiny workflow examples, and direct routing to the event-stream documentation.
  ([#30](https://github.com/kcosr/keel/pull/30))
- Local `.agent-pack` state directories are now ignored by git.
  ([#29](https://github.com/kcosr/keel/pull/29))
- `keel workflow launch` now provides the saved-workflow counterpart to
  `keel launch`, including attached event streaming, detached `runId` output,
  capability-file output, and explicit raw capability emission.
  ([#28](https://github.com/kcosr/keel/pull/28))
- Sample iterative review workflows now default to caller-controlled follow-up:
  single-reviewer workflows keep waiting after a clean review unless
  `stopWhenClean` is set, autonomous implement/spec-author workflows park before
  completion by default, and all five default/cap review rounds at `10`.
  ([#24](https://github.com/kcosr/keel/pull/24))
- `bun run defaults:seed` now seeds conventional local profiles plus the five
  reusable saved review workflows; `profiles:seed-defaults` and
  `workflows:seed-defaults` are available for narrower seeding.
  ([#24](https://github.com/kcosr/keel/pull/24))
- `bun run profiles:seed-defaults` now seeds `claude-default` with Claude
  `allowTools: ["Bash"]` so read-only reviewer sessions can inspect workspaces
  through shell commands while retaining their workflow-selected tool policy.
  ([#27](https://github.com/kcosr/keel/pull/27))
- `bun run profiles:seed-defaults` now seeds a `claude-fable-5` Claude profile
  matching the local conventional `xhigh` + Bash-enabled setup.
  ([#30](https://github.com/kcosr/keel/pull/30))

### Fixed
- `continueAsNew` successors and forked runs now retain their source run's
  launch-authority ceiling, and rewind/fork reject journal ranges containing
  durable child spawns that cannot be replayed safely.
- Workflow promotion now requires a definition-matched dedicated `review:` approval whenever
  submitter governance is configured, and submitter credentials no longer bypass saved-workflow
  `workflow:run` authorization.
- Web schedule edits now preserve the pinned saved-workflow version and next
  fire time. Long directory listings remain scrollable inside their dialog,
  run-event watches stay connected across projection refreshes, and workflow
  forms and action dialogs preserve or surface transient state correctly.
  ([#31](https://github.com/kcosr/keel/pull/31))
- Codex provider `serviceTier: "fast"` now sends Codex app-server's
  user-facing `"fast"` service-tier value, applies configured service tier
  during thread start/resume as well as turn start.
  ([#30](https://github.com/kcosr/keel/pull/30))
- The web event stream now disables Bun's per-request idle timeout for SSE
  watch requests, preventing live run views from failing with incomplete
  chunked responses while waiting for sparse agent events.
  ([#26](https://github.com/kcosr/keel/pull/26))
- The web run-detail graph now uses the shared run projection effect-type
  contract and renders `command`, `completion_check`, and `workspace_setup`
  journal nodes instead of crashing on unknown icon mappings.
  ([#25](https://github.com/kcosr/keel/pull/25))
- Sample implement review workflows now validate
  `completionCheckFailureAction: "park"` against the resolved
  `completionMode` default, so callers can rely on the default
  `"park-before-complete"` mode without restating it.
  ([#24](https://github.com/kcosr/keel/pull/24))
- Plain `ctx.agent` calls now include resolved execution controls in durable
  version/input identity, matching replay-visible runtime behavior when
  `maxRetries`, `lenient`, `onFailure`, `timeoutMs`, `stallRetries`, or their
  workflow-visible defaults change. `ctx.agentSession` turns now also include
  resolved timeout/stall defaults. The workflow SDK ABI is now 12.
- Resuming a parked run now immediately projects as `running` through `keel get`
  and related surfaces while resumed provider work is still active, instead of
  retaining the old `waiting-*` status until the next park or terminal event.
  ([#22](https://github.com/kcosr/keel/pull/22))

### Added
- Added run-scoped `ctx.state` namespaces with journaled whole-value writes,
  synchronous deterministic fold reads, replay-safe rewind/fork behavior, schema
  migration 22→23, bounded `RunProjection.state`, `getRunState` RPC, and MCP
  `get_state`. The autoresearch workflow now stores its best candidate and
  history in state. This rides the unreleased workflow SDK ABI 13.
- Added a deterministic autoresearch supervised-loop workflow and repeatable live-daemon chaos matrix covering SIGKILL recovery, delayed timer restart, MCP steering and approval, suffix-only source invalidation, and durable checkpoint cursor resume.
- Added `ctx.drainSignals<T>(key, name)` for non-parking, transactional FIFO
  consumption of all currently pending signals. Completed drains replay their
  recorded batch without re-consuming, and the supervised-worker guidance
  composes conventional `steer` signals into the next agent-session turn.
  This rides the unreleased workflow SDK ABI 13 and needs no schema migration.
- Added `ctx.checkpoint({ key, message, data? })` for durable, strictly ordered
  workflow progress. Checkpoints journal through the strict-effect path, emit one
  replay-safe durable `checkpoint` event, appear in `RunProjection`, and raise
  the workflow SDK ABI from 12 to 13 without a schema migration.
- `keel mcp` now serves local stdio supervisor tools for bounded run listing,
  canonical detail and blockage inspection, durable event/checkpoint paging,
  saved-workflow launch, wait, signal, approval, interrupt, and resume actions.
  It uses daemon RPC authorization and capability-token redaction throughout.
- The web console now has opt-in browser diagnostics for run-event streaming
  and transcript coalescing via `localStorage.keelDebug`.
  ([#26](https://github.com/kcosr/keel/pull/26))
- Production React/Vite/TypeScript web UI foundation under `web/`, including
  the shared operator shell, design primitives, typed browser API client,
  fetch-based SSE parser, frontend tests, root `web:*` scripts, and `web/dist`
  build output for `keel web`.
- The production web UI now includes a grouped runs inbox, live run detail tabs,
  fetch-based SSE watching with reconnect cursors, coalesced transcript display,
  raw event inspection, and a RunProjection-backed graph/timeline view.
- Run detail now includes a workflow Flow view backed by a server-extracted
  `flow` operation IR from retained workflow source, with browser live-state
  overlays for node progress and events.
- The production web UI now includes current `ctx.human` approval decisions and
  retained workspace list/detail/diff views with admin-confirmed merge, discard,
  and workspace GC controls.
- The production web UI now includes saved workflow list/detail/source views, a
  browser-secret-free saved workflow launch form, schedule lifecycle management,
  profile and setting editors, and system status cards backed by `/health` and
  `/api/system`.
- The production web UI now includes final console polish: container-responsive
  runs tables, keyboard row navigation, consolidated action menus, and a denser
  workspace review panel with explicit disabled-state explanations.
- The web runs projection now defaults to a bounded latest-run page, accepts an
  explicit `limit` up to the documented maximum, uses a bounded daemon
  `listRunsPage` RPC before per-run enrichment, enforces the same maximum on
  direct RPC calls, and returns page metadata so the UI can disclose truncated
  browser history without materializing every historical run.
- Agent specs and persistent profiles now support `environment: { vars, secrets }`.
  Literal `vars` are passed as provider environment variables and hashed by
  value; `environment.secrets` requests named run-secret values supplied through
  the side channel. Secret requests must be granted by `capabilities.secrets`.
- `runSecrets` are accepted on daemon launch/restart APIs and exposed in the CLI
  through repeatable `--secret NAME=VALUE` and `--secret-env NAME[=ENV]` flags
  on `launch`, `run`, `workflow run`, `retry`, and `rewind`.
- Programmatic embedders can import `SecretStore` from `@kcosr/keel/secrets`;
  the workflow authoring SDK exports the `AgentEnvironmentSpec` type.
- Codex `providerConfig.codex.serviceTier` now lets workflows and agent
  profiles request `"fast"` priority service or force `"normal"` standard
  routing as replay-visible agent identity.
- Run blockage diagnostics now reserve `stalled_no_heartbeat` for stale
  daemon-owner heartbeats instead of long pending step age. Reports and web/TUI
  projections hide diagnostic `running` as a visible blockage, while node views
  expose durable `startedAtMs` for surfaces that want to derive pending age.
- Daemon-owned agent calls now support restart-applied operational concurrency
  limits through `agent.maxConcurrentTotal` and
  `agent.maxConcurrentByProvider`. Queued calls stay in `running` state and
  surface as `agent_concurrency` blockage in `getBlockage`/reports.
- Local web API transport via `keel web`, with localhost-only default binding,
  `/health`, `/rpc`, projection routes, static asset serving, and SSE run event
  streams using the shared cursor/control-frame contract.
- Documented opt-in diagnostics for provider raw JSONL logs and web/daemon
  gateway projection timing logs.
- Shared event stream cursor contract for daemon, CLI, TUI, execute, and
  in-process subscriptions, plus `keel watch --from`, `--after-seq`, and
  `--tail` cursor controls.
- Accepted-work `attachCursor` values on launch and wake/restart operations;
  attached lifecycle watches now attach from the accepted operation's cursor
  instead of replaying stale pre-operation history.
- Durable `docs/events.md` reference covering event envelopes, cursor semantics,
  accepted-work cursors, catch-up/closed boundaries, and stream authorization
  behavior.
- Source-backed daemon API orientation in `docs/api.md` and a more granular
  control-surface matrix for run, workflow, schedule, workspace, profile, and
  settings operation families.
- Tracked documentation ownership guide in `docs/documentation.md`, plus README
  and agent-rule routing for future documentation updates.
- Admin-gated schedule read API across daemon/RPC/client, CLI, and `keel execute`:
  `listSchedules`/`getSchedule`, `keel schedule list`, and `keel schedule show`
  now expose stable schedule projections, opt-in source inclusion, missing
  definition state for disabled/old rows, last-run status, and persisted schedule
  error parse failures.
- Codex provider tool-policy mapping now supports default/read-only and
  workspace-write capability shapes with Codex app-server sandboxes while
  preserving explicit unrestricted `danger-full-access`; unsupported no-tools,
  lossy network, and allow/deny tool shapes still fail closed.
- Saved workflow registry schema v20 and RPC/CLI commands (`keel workflow ...`)
  for saving captured workflow bundles as `name@version`, listing/showing
  metadata, printing exact stored source, launching pinned saved versions, and
  enable/disable/deprecate/tombstone lifecycle operations.
- `keel workflow source` can now display exact retained workflow definition
  source by `--run <runId>` or admin-only `--definition <wf_sha256_hash>`, with
  text and JSON output. Launch-minted run capabilities now include explicit
  `run:source`; existing run capabilities without that action fail closed.
- Saved-ref schedule creation (`keel schedule put <name> --workflow saved-name`)
  resolves the saved version once at schedule creation and persists the immutable
  definition hash. Schedule creation remains admin-only.
- Typed daemon settings catalog with admin RPC/CLI management (`keel settings ...`), JSON value parsing, validation/check diagnostics, optimistic generation guards, and read-only snapshotted defaults such as `agent.defaultOnFailure`.
- Journal schema v17 stores daemon setting overrides plus immutable run setting snapshot sets; migrating older journals backfills explicit workflow-visible default settings for every run and warning events for non-terminal pre-v17 runs.
- Persistent daemon-owned agent profile catalog with admin RPC/CLI management (`keel profiles ...`), validation/check diagnostics, programmatic-profile coexistence, and frozen per-run profile snapshots for deterministic replay.
- Journal schema v16 stores catalog profiles plus immutable run profile snapshot sets; migrating older journals backfills explicit empty snapshots and warning events for non-terminal pre-v16 runs.
- First-cut `codex` app-server agent provider with stdio, WebSocket, and WebSocket-over-Unix-socket transports via `providerConfig.codex.transport`. Codex uses Keel's resolved workspace cwd, captures app-server thread ids as session tokens, and supports opt-in raw protocol logging with `KEEL_CODEX_RAW_LOG`.
- Provider-keyed `providerConfig` for `ctx.agent`, `ctx.agentSession`, and agent profiles. Keel validates the full map as strict JSON, includes only the selected provider's config in replay identity, and passes only that immutable selected config to provider adapters.
- Workflow-scoped `ctx.workspace`/`ctx.withWorkspace` with direct and git-worktree modes, `WorkspaceHandle` sharing across agents/sessions, and a lazy `__default` direct workspace at `ctx.run.target`.
- Managed workspace `copy` and `clone` modes. `copy` snapshots dirty local directories without `.git` metadata and supports baseline diff/merge back to unchanged sources; `clone` creates explicit local or remote git clones, supports local non-bare clone merge, and reports remote/local-bare clone merge as unsupported. Workspace RPC/CLI views now expose source kind, source URI/ref/branch/base commit, copy baseline path, merge/diff support, and mode-aware diff metadata.
- Branch-backed worktree workspaces via `ctx.workspace({ mode: "worktree", branch: true })`. Keel generates and records a valid `keel/...` branch name, attaches the managed worktree to it, reattaches removed workspaces to the persisted branch, and leaves generated branch refs for manual cleanup while retention/discard/GC remove filesystem state only.
- Journal schema v19 adds worktree checkout kind and branch ownership metadata. Workflow SDK ABI bumped to 7 and `WORKTREE_WORKSPACE_RULES_VERSION` to 2 for the `branch` workspace option and branch-policy workspace identity input; drain non-terminal older-ABI runs before upgrade or accept the existing unsupported-ABI resume failure.
- Workflow SDK ABI bumped to 8 for the workflow-facing agent environment shape.
  Re-register workflow definitions after upgrade and drain suspended or
  non-terminal older-ABI runs first unless Keel gains a real multi-ABI bridge.
- Durable workflow command effects are available through `ctx.command(...)`.
  Commands require an explicit `WorkspaceHandle`, relative `cwd`, argv or shell
  invocation, command capabilities, wall-clock timeout, and stdout/stderr caps.
  Completed command results replay from the journal; pending commands are
  at-least-once after crash or interruption. Command execution runs as the local
  daemon user, is not provider sandboxed, uses an explicit environment allowlist
  plus literal vars and granted run secrets, and does not redact command output.
  Workflow SDK ABI bumped to 9 for the new SDK surface and worker/host protocol.
- Reusable implement/review workflows now use typed `completionChecks` instead
  of `verificationCommand`. Checks can run daemon-owned commands, require clean
  git state, require commits after the selected base, and require local `HEAD`
  to equal a configured remote ref. Failed checks produce bounded diagnostics,
  can continue the implementation loop, park, or block, and mark owned
  worktrees `failureSeen` for `retain-on-failure`. Workflow SDK ABI bumped to
  10 for the `ctx.completionCheck(...)` surface and worker/host protocol.
- Added a runnable fixture workflow covering a direct workspace, durable
  `ctx.command(...)`, and durable completion checks.
- Explicit workspaces can now declare lifecycle `setup` commands. Setup runs
  before agents, sessions, or commands use the workspace, records bounded
  diagnostics as journaled setup command rows, reuses completed setup on replay,
  and exposes setup status in workspace views. Journal schema v22 adds setup
  metadata, and Workflow SDK ABI bumped to 11 for the new workspace contract.
- Workflow SDK ABI bumped to 6 and journal schema to v17 for copy/clone workspace modes and canonical workspace identity hashes. Non-terminal runs captured with older SDK ABIs must be drained before upgrade or will fail resume with the existing unsupported-ABI error.
- Workspace lifecycle metadata now distinguishes `mode`, `ownerKind`, source path, provider cwd, ownership, retention, and active worktree holders in RPC/CLI/execute views.
- `keel execute` control scripts can list/get/diff/merge/discard/GC run workspaces through the daemon client.
- Run/schedule targets via `--target`; the run target feeds the default workspace instead of acting as a per-agent cwd override.
- Top-level `workflows/` directory for reusable operational workflows, starting
  with `iterative-review.workflow.ts`, a signal-driven multi-turn review loop,
  and `implement-review-loop.workflow.ts`, a bounded write-capable
  implementer/read-only reviewer loop backed by `ctx.agentSession`.
- Reusable spec-authoring workflows: a creator-driven `spec-review-loop` that
  preserves reviewer correspondence while the invoking agent owns the main spec,
  and a fully orchestrated `spec-author-review-loop` that loops a spec creator
  with a correspondence reviewer.
- Reusable `workflows/task-review-guidance/` package with shared TypeScript
  checklist/rubric/prompt helpers, one-shot `task-code-review` and
  `task-plan-review` saved workflow packaging examples, strict in-workflow
  review-output validation, and captured helper source display coverage.
- `keel workflow install task-review-guidance` installs the curated code, plan,
  and docs review workflows as immutable saved workflow versions with per-entry
  `created`/`unchanged`/`conflict`/`failed` reporting. The package now includes
  a read-only docs review workflow and richer Keel-native review rubrics.
- `scripts/seed-default-profiles.sh` and `bun run profiles:seed-defaults` seed
  the conventional `codex-default`, `claude-default`, and work-prefixed Pi
  catalog profiles with explicit provider/model/reasoning defaults.
- Reusable `workflows/model-routing/` helper package for captured static or
  read-only-agent routing of profile/reasoning choices, with guardrails for
  allowlisted profiles, allowlisted reasoning levels, critical surface/risk
  floors, and workflow-owned timeout/verification hints.
- `ctx.agentSession({ key, ... }).turn({ key, prompt, ... })` for realm
  workflows that need one logical Pi/Codex or Claude backend conversation across
  multiple durable turns in the same run. Session runs fail closed for
  rerun/rewind/fork, reject participant or turn identity drift, and include
  `KEEL_LIVE=1` backend-continuity smokes for Claude and the Pi/Codex adapter.
- `keel execute` runs stateless TypeScript control scripts outside the workflow
  realm with injected `keel`, `args`, `state`, and `env`; stdout is always the
  returned JSON value and runtime failures are structured JSON on stderr.
- `keel run [workflow.ts] [--input json] [--output json|text|ndjson]` launches a
  workflow and prints a JSON envelope by default, or a text transcript / NDJSON
  event stream when requested.
- `keel output <runId>` prints the terminal workflow output as JSON.
- `keel report <runId> [--output json|text]` prints a journaled per-node result
  digest, and execute control scripts can call `keel.report(runId)`.
- `keel list [--output text|json]` now has an explicit JSON envelope for scripts
  and includes created/finished/parent run metadata in run summaries.
- `keel tui [runId] [--status status] [--limit n]` opens an interactive terminal
  run browser/detail/watch UI with local filtering, `subscribeEvents` backfill,
  conservative lifecycle controls, and terminal restore guards.
- `keel gc` prunes old unreferenced workflow definition rows and rebuildable
  materialized definition cache directories.
- Immutable workflow definition snapshots are stored by content hash and
  materialized from the journal for run execution and resume.
- File-launched workflows can import local static `.ts`/`.tsx` helper modules
  through relative specifiers. The client captures the reachable helper graph,
  infers a bundle root from the captured files, and the daemon validates and
  persists the complete source bundle under one immutable definition hash.
- Daemon-enforced bearer capabilities for run control, including launch-minted
  run capabilities, admin capabilities, and client-side capability files.
- `keel interrupt <runId> [reason]` and `interruptRun` park non-terminal runs in
  public status `interrupted` until an explicit `resume`, with durable
  `run.interrupted` audit events and best-effort active worker/provider abort.

### Added
- The web run-detail view has a new "Flow" tab that renders the workflow's
  authored structure as an interactive flowchart in the console's own styling
  (phases as bands, parallel fan-out/join markers, branch gates, loop repeat
  edges) and overlays runtime status from the journal projection (per-operation
  done/running/failed colouring, current phase, and map-loop cardinality). The
  `keel web` transport parses the run's captured workflow source into the
  operation/container IR the browser renders; the TypeScript parser stays on the
  server so the browser bundle is unaffected.

### Changed
- The web run-detail Flow tab now preserves deterministic lanes for literal
  `Promise.all([...])` fan-outs, so sequential work inside each array element
  stacks vertically before the fan-in join instead of flattening every operation
  into one wide sibling row.
- The web run-detail Flow tab now applies keyed live event state while watching
  a run, so matching operations can update to running, blocked, completed, or
  failed without waiting for a full run projection refresh.
- The web run-detail Flow tab now applies live phase events to the wide phase
  rows and subtly pulses running or blocked operations/phases while watching.
- The web run-detail Graph tab now renders projection nodes as an interactive
  flowchart — node boxes laid out in dependency columns, connected by SVG edges,
  with status colouring, dashed pending nodes, click-to-select node detail, and
  zoom controls — replacing the earlier lane/stage layout. It still shows the
  empty state for runs that record no journal nodes.
- Workflow-facing top-level agent `secrets` was replaced by
  `environment.secrets`; the bundled daemon now constructs the in-memory
  `SecretStore` by default, and missing run secret values fail the agent step
  instead of being silently omitted.
- The web transport rejects `runSecrets` on launch/restart requests until a
  browser-specific local secret authorization model exists.
- Saved workflow launches and saved-ref schedules no longer accept the
  undocumented daemon RPC `clientDefaultTarget` wrapper field. Use explicit
  `target`/`--target`, or configure a saved workflow default target.
- Pi RPC stdout is now treated as a strict JSON-lines protocol: non-empty
  malformed stdout fails the agent attempt with a bounded excerpt instead of
  being ignored as diagnostic noise.
- RealmKernel launch boundaries now reject missing or blank run targets before
  persisting a run; CLI/client layers remain responsible for cwd defaults.
- Workflow definition schema v21 normalizes legacy code-only and empty-module
  source rows during migration; runtime source display and materialization now
  reject current rows that lack a manifest or persisted modules.
- Codex app-server notification parsing now accepts only the current v2 scoped
  event shapes: `thread/started` uses nested `thread.id`, turn lifecycle events
  use `threadId` plus nested `turn.id`/status, item and error events use
  top-level `threadId`/`turnId`, agent-message deltas use top-level `delta`,
  completed agent messages use `type: "agentMessage"` with `text`, and unscoped
  or alternate-shape notifications are ignored instead of being applied to the
  active turn. Ignored current-thread turn lifecycle and error notifications now
  emit a diagnostic error trace event before Keel waits for the eventual
  terminal event.
- The legacy in-process `Kernel` class has been removed. Durable workflow
  launch/resume now uses `RealmKernel` exclusively, including crash-consistency
  tests, so persisted runs always resume from immutable workflow definition
  snapshots instead of caller-supplied `v0` functions.
- Obsolete `AgentSessionWorkspace` store APIs/types have been removed; runtime
  code and tests use unified `AgentWorkspaceRow` records outside migrations.
- The current capability auth contract no longer exposes deferred
  approval-scoped resources or saved-task actions; approval decisions remain
  admin-only until scoped approvals or saved tasks ship.
- `allowTools` and `denyTools` now require exact provider-native tool names for
  known built-in tools. Generic aliases for the selected provider, such as
  `shell`, `run`, `exec`, `list`, and Claude's `fetch`/`search`, plus
  provider-specific case variants, reject instead of normalizing to a broader
  backend tool; unknown custom provider-native tool names still pass through.
- `keel signal`, `keel approve`, `keel deny`, and the matching daemon/execute
  APIs now acknowledge durable delivery and wake-start handling instead of
  waiting for the resumed workflow to finish, fail, or park again. Use
  `keel watch <runId> --output text` or `waitForRun`/`keel.wait` to observe
  follow-up progress.
- `ctx.agent` and `ctx.agentSession().turn` default `maxRetries`, `lenient`, `onFailure`, `timeoutMs`, and `stallRetries` from each run's settings snapshot after explicit workflow and profile values, so resume/retry/rewind/fork do not observe later daemon setting edits. Codex `turn/completed` waits now receive the host-resolved per-call agent timeout.
- `keel gc` / `gcDefinitions` use `workflowDefinition.gcTtlMs` as the default workflow definition TTL when the request does not supply `ttlMs`; `KEEL_DEFINITION_TTL_MS` is no longer honored. `codex.rpcTimeoutMs` and `codex.connectTimeoutMs` apply when the Codex provider is constructed, normally at daemon restart.
- Reusable implementation/review workflows now resolve `input.repository` to a
  direct workspace, defaulting to the run target when omitted, so prompts and
  agent cwd stay aligned while still supporting manually-created git worktrees
  passed with `--target`.
- Codex app-server turns now use Keel's long-running agent timeout for
  `turn/completed` instead of the short setup RPC timeout, and provider-side
  failures interrupt an active remote turn best-effort before closing the
  transport. Resume/retry of an active Codex thread now discovers the in-progress
  turn through `thread/turns/list`, interrupts it, and fails closed unless
  interruption is confirmed.
- `keel list` and the TUI run browser now show newest runs first by default, and
  the browser keeps the selected row visible while moving through long lists.
- The TUI detail view keeps live watch output visible in constrained terminals and
  ignores unrecognized escape/CSI input sequences without leaking their bytes into
  prompts or navigation.
- Terminal text rendering for list/report/watch/TUI now uses shared sanitization,
  avoids unbounded table width argument spreads, and bounds retained TUI watch row
  text for long coalesced streams.
- Agent provider `cwd` is now always the resolved workspace path: explicit
  handle, scoped workspace, or the default direct workspace at the run target.
  Worktree mode resolves the supplied path to an enclosing git repository root.
  Raw daemon/RPC launch and schedule calls reject missing or blank targets, while
  CLI/client wrappers still capture their own cwd as the default target. The
  supervisor disables persisted schedules with invalid targets instead of letting
  one bad schedule break a tick.
- Omitted `path` for `direct`, `copy`, and `worktree` modes now resolves through
  the run's persisted `__default` direct workspace row. Worktree diff and merge
  now use final-tree patches relative to `baseCommit`, so commits made inside
  detached or branch-backed worktrees are included along with dirty state.
  Clone/worktree final-tree `contentDiff` output is capped at the same durable
  diff byte limit and includes the retained-workspace truncation notice when
  exceeded.
- Workflow SDK ABI bumped to 5 for workflow-visible provider-specific agent config. Pre-bump workflow definitions must be re-registered, and suspended/non-terminal runs pinned to older SDK ABIs must be drained before upgrade or will fail resume with the existing unsupported-ABI error. The journal schema is unchanged for this provider-config change.
- Workflow SDK ABI bumped to 4 and journal schema to v15 for the workflow workspace API; non-terminal runs captured with older SDK ABIs must be drained before upgrade or will fail resume with the existing unsupported-ABI error.
- Public `workspaceIsolation`, `workspaceRetention`, and per-agent/profile `target` options were removed. Use `ctx.workspace({ key, mode: "worktree", retention })` and pass the returned handle to agents/sessions.
- Worktree retention names are now `"remove"`, `"retain-on-failure"`, and `"retain"`; retention applies only to Keel-owned worktrees, never direct workspaces.
- Durable agent sessions fail closed if a referenced worktree was removed by terminal cleanup; use `"retain-on-failure"` or `"retain"` for retryable failed session runs.
- Agent/session `agent.diff` and `workspace.diff_error` event payloads include the durable `workspaceId` and workspace source/cwd metadata for RPC/CLI selectors.
- Durable workspace diff payloads now cap `agent.diff.contentDiff` and changed
  path arrays with retained-workspace truncation/omission metadata, and
  oversized `git status`/`git diff` output crosses explicit buffer limits into
  `workspace.diff_error` instead of relying on Node's default `maxBuffer`.
- Agent secrets are trusted-local env injection only: secrets do not require
  worktree mode, and exact secret values emitted by agents are not redacted from
  outputs, events, tolerated failures, or workspace diffs.
- Attached CLI text transcripts now coalesce adjacent live agent text/reasoning
  chunks under one header for human-readable streaming output, while NDJSON
  event streams remain full-fidelity envelopes.
- `keel watch` no longer uses durable per-token `agent.event` rows as its live
  stream. Agent deltas are pushed as ephemeral live frames, finalized tool
  calls/results are persisted immediately as `agent.tool_call`/`agent.tool_result`
  rows with `attempt` and optional `toolCallId`, and successful turns persist at
  most one non-empty final-answer `agent.message` row.
- Workflow launch is now client-captured source only. `keel launch ./wf.ts`,
  `keel run ./wf.ts`, and `keel execute ./control.ts` read files in the client;
  omitting the file reads source from stdin. The daemon no longer reads client
  workflow paths.
- Workflow input for `launch` and `run` is now `--input <json>`; the positional
  argument is source only. Stdin launches may be unnamed, and JSON projections
  represent unnamed runs as `null`.
- Stdin workflow sources remain single-module `entry.ts` definitions and cannot
  use local helper imports. Package imports, SDK subpaths, dynamic imports,
  symlinked source paths, and relative imports through `node_modules` remain
  rejected for workflow bundles.
- Path-launched workflow definition hashes now include the normalized entry
  path and every captured helper path/source byte. Single-file path launches use
  the entry basename; stdin/string launches keep the stable `entry.ts` path.
- Schedules now pin the captured workflow definition hash at creation time.
  Existing path-based schedules are disabled by migration.
- `keel launch --detach` now returns JSON containing `runId` and
  `capabilityRef` by default. Raw run capabilities require `--emit-capability`.
- CLI output selection now uses shared `--output json|text|ndjson` rendering
  flags. `--json` has been removed, `watch` and attached `launch` default to
  NDJSON event streams, and human transcripts require `--output text`.
- `keel list` now defaults to a headered, aligned text table instead of raw
  tab-separated rows; scripts should use `keel list --output json`.
- `getRun`/`getRunReport` projections include `createdAtMs` and `finishedAtMs`
  so direct run detail views can render the same timestamps and durations as
  `keel list`.
- Compact text transcripts hide agent tool calls/results by default. Add
  `--tools` to attached text commands to include them.
- Run lifecycle operations are capability-gated by the daemon. Run id alone is
  no longer authority to inspect or mutate a run.
- Interrupted runs are skipped by daemon restart recovery, timer supervisor wake,
  signal delivery, and approval delivery; interruption reasons are redacted
  before durable persistence and appear in blockage/report output.
- Resume/retry/rewind/fork execute the run's stored workflow definition snapshot;
  rerun with a source override creates a fresh snapshot.
- Workflow resume across compatible Keel upgrades now uses an explicit workflow
  SDK ABI for `@kcosr/keel` instead of pinning the full package tree.
- Reusable implement/review and spec-review workflows can now park after a clean
  review with `completionMode: "park-before-complete"`, allowing an orchestrator
  to request another round or explicitly signal final completion.
- Reusable review/spec/implementation workflows now default to the
  `codex-default` and `claude-default` agent profiles while exposing profile and
  reasoning overrides for normal launches.
- Long-lived waits/event streams re-check capability validity and fail when a
  presented capability is revoked or expires; each wait/subscription is bound to
  the credential presented when it was started.
- `KEEL_TOKENS`/`KEEL_TOKEN` read-write auth has been replaced by
  `KEEL_ADMIN_TOKEN`, `KEEL_RUN_CAP`, `KEEL_CAP_FILE`, and cap files under
  `KEEL_CAP_DIR`.

### Fixed
- Approval blockage and web approval projections now use the persisted
  `requested_at_ms` timestamp instead of rendering pending human gates as the
  Unix epoch.
- Codex agent resume now calls app-server `thread/resume` directly so cold
  persisted threads can be loaded after app-server or daemon restart instead of
  failing on a pre-resume `notLoaded` `thread/read` view.
- Web UI layout and usability pass: transcript/event status pills no longer
  stretch into oversized circles when a row grows tall (pills are pinned to
  their intrinsic size), the run-detail tab bar scrolls horizontally instead of
  clipping on narrow viewports, the detail inspector rail is now collapsible
  (persisted) and the side-by-side layout gives the master pane more room in the
  981-1320px band, empty-state cards no longer nest a card inside a card, code
  and JSON panels use the light theme palette with shrink-to-fit JSON blocks,
  the top-bar search box is hidden on screens that do not consume it, transcript
  previews render a compact time/event/message view, muted text meets WCAG AA
  contrast, and keyboard focus rings are visible on all custom controls.
- Transcript `log` events now render their structured `data` payload as JSON
  instead of `[object Object]`; long transcript messages truncate to a readable
  length with the full text available on hover, and long identifiers in table
  name cells (e.g. profile config hashes) truncate with an ellipsis instead of
  overflowing into adjacent columns.
- Codex remote app-server transports now accept Desktop app-server response and
  notification frames that omit the optional `jsonrpc: "2.0"` marker while still
  rejecting malformed frames.
- Codex app-server launches now opt out of `thread/started` notifications and
  ignore any that still arrive, avoiding false thread-id mismatches when a
  shared app-server broadcasts another client's thread start during concurrent
  Keel agent launches.
- `keel watch` and attached lifecycle commands no longer exit on stale
  historical parked/terminal events when replaying a run that later resumed.
- The live review workload fixture now uses a valid repository target when
  exercising workspace isolation.
- Provider session tokens are no longer persisted as `agent.event` payloads.
- Workflow snapshotting resolves the `@kcosr/keel` SDK package root from the
  repository (env override, source location, then runtime paths) instead of
  `import.meta.url` alone, which resolved to the filesystem root in the compiled
  standalone binary and triggered a recursive scan from `/` (surfacing as
  `EACCES … /etc/.pwd.lock`). The root is resolved lazily and the daemon asserts
  it at startup, failing fast with an actionable message if it cannot be found.
- CLI commands no longer hang after a daemon-side error. Every daemon client
  opened during a command is closed by the dispatcher, so a rejected RPC (auth,
  lint, not-found, precondition) prints the error and exits instead of leaking the
  socket and stalling on the open handle.
- CLI exit handling no longer uses `process.exit(code)` after writes, avoiding
  truncated piped JSON output.
- `run.finished` events include small terminal outputs and omit large outputs
  with byte metadata; `keel output` and `waitForRun` return the full value.
- Workflow determinism checks now reject `Bun.*`, process/module/dynamic-code
  escape paths, Node builtins, and workflow imports of the operator-side
  `@kcosr/keel/execute` surface.
- Capability-looking tokens are redacted from CLI/daemon diagnostic output.
- Bootstrap admin capability setup no longer re-enables a revoked bootstrap token
  on daemon restart.
- Workflow snapshots now fail closed when persisted definitions require an
  unsupported workflow SDK ABI, and automatic timer/orphan/schedule drive paths
  persist that deterministic failure instead of retrying silently.
- `@kcosr/keel` workflow snapshot materialization now links to the package root
  instead of its parent directory.
