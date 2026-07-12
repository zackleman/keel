# Keel Onyx Extensions — Implementation Plan

**Status:** draft for review · **Date:** 2026-07-11 · **Owner:** Zack (fork of upstream keel by Kevin, MIT)

## 0. Context and goals

We are extending keel with the capabilities we admired in the Onyx/Slate orchestration VM
(realmcore's `*.program.ts` runtime), while keeping keel's durable-execution kernel intact.
Onyx's confessed open problem (durability) is keel's solved core; keel's deferred items
(MCP, spawn, richer supervision) are exactly what Onyx demonstrates. The two roadmaps interlock.

**Add, in order:**
1. `ctx.checkpoint` — typed, journaled progress reporting (Onyx's `checkpoint()`)
2. Supervisor MCP server — any agent session can watch/steer/approve runs (Onyx's main-agent channel)
3. External steer delivery, Tier 1 (between-turn) — `ctx.drainSignals` + a documented supervised-loop pattern
4. Realistic workload test v1 — an autoresearch-style heartbeat program, chaos-tested
5. `ctx.state` — typed, durable, shared state namespaces (Onyx's headline feature)
6. `ctx.spawn` — durable child workflows (keel's own deferred item)
7. *(Optional)* Tier 2 mid-turn steer injection (Pi/Codex only; Claude adapter cannot)
8. Remote deployment + untrusted-submission hardening — capability ceilings for
   agent-authored code, review-gated promotion to saved workflows, contained server

**Deployment/trust context.** Target end state: keel runs on a remote (Tailscale-reachable)
server; **agents author the workflow code and submit it to the service** — so workflow
source is untrusted by default. Two submission patterns: (a) *saved* workflows that run
unchanged for weeks (registry `name@version` → immutable definition hash — already native),
and (b) *one-off* runs (client-captured source, minutes-to-an-hour, then GC — already
native). Keel's realm already confines the workflow **body** (JSON-only, effects-only, no
ambient fs/net/clock); the gap is that workflow code **self-declares** its
`toolPolicy`/`capabilities` (USAGE.md:1193, 1536-37) with no per-submitter ceiling, and the
OS sandbox backstop is deferred. Phase 8 closes this.

**Non-goals:** body-driven `h.notify` handles (Tier 3); multi-node execution; per-effect OS
sandboxing (containment is host-level in v1); hosted multi-*tenant* anything (a deployed
single-team daemon is in scope; tenancy is not). All match keel's own non-goals (DESIGN.md §3).

## 1. Invariants we must preserve (verified against source)

These come from four code-level investigations of the repo (journal kernel, daemon API,
agent adapters, repo constraints). File refs are to this repo at the current checkout.

- **Everything crossing the realm is JSON-only, replay-visible, journal-backed.** New ctx
  methods follow the write-ahead lifecycle in `src/kernel/step-engine.ts:39-90` (pending →
  execute → transactional complete) or justify a dedicated table (as sleep/human do).
- **Effect identity is `(stableKey, inputHash, version)`** (`DESIGN.md:251-266`,
  `src/kernel/version.ts`). Anything behavior-affecting enters identity. Fan-out keys are
  content-derived, never positional.
- **Completed effectful steps replay exactly-once; pending re-executes at-least-once.**
  External side effects need idempotency or write-ahead dedup tokens.
- **Durable events are append-only with per-run monotonic `seq`** (`src/journal/store.ts:922-939`);
  clients resume via `after-seq` cursors; never emit duplicate events on replay.
- **One canonical `RunProjection`** (`src/rpc/projection.ts:49-106`), golden-locked in
  `src/rpc/rpc.test.ts` (~line 898). Surfaces adapt it; they never rebuild journal state.
- **New operator surfaces are daemon RPC operations first**; MCP/web/CLI are thin adapters
  (`docs/control-surfaces.md:15-17`, process at :240-248).
- **Schema changes = numbered forward migration + migration test** (`AGENTS.md:24-42`).
  Current `SCHEMA_VERSION = 22`. Postgres-compatible DDL discipline.
- **Any ctx.* signature/replay-visible change bumps `WORKFLOW_SDK_ABI_VERSION`** (currently 12,
  `src/workflow-definitions/abi.ts`). Keel has **no multi-ABI bridge** (`AGENTS.md:56-60`):
  non-terminal runs on the old ABI must be drained/finished or deterministically rejected.
  → **Operational rule:** batch ABI-changing work per phase; finish or interrupt live runs
  before deploying a phase that bumps the ABI.
- **Auth is object-capability bearer tokens** (`src/auth/capabilities.ts`): run tokens are
  scoped to one run; `listRuns`/`decideApproval` need admin. Never print raw tokens.
- **Docs/changelog rules** (`AGENTS.md:83-105`): every phase updates `CHANGELOG.md [Unreleased]`,
  `USAGE.md`, `SKILL.md` (if authoring-facing), `DESIGN.md` (if semantics change),
  `docs/control-surfaces.md` (if surface exposure changes).
- **Checks per phase:** `bun test` (full — kernel/journal/daemon changes require it),
  `bun run typecheck`, `bun run lint`, `bun run web:build` when web/transport is touched.

## 2. Phase overview

| # | Phase | ABI bump | Migration | Risk | Depends on |
|---|-------|----------|-----------|------|------------|
| 0 | Fork & baseline | – | – | low | – |
| 1 | `ctx.checkpoint` | 12→13 | none | low | 0 |
| 2 | Supervisor MCP server | no | none | low | 1 (nicer with it) |
| 3 | Steer Tier 1: `ctx.drainSignals` + pattern | (ride 13 if co-landed, else 13→14) | likely 22→23 (signal consumption bookkeeping) | med | 1 |
| 4 | Workload test v1 (supervisor pattern) | – | – | – | 1–3 |
| 5 | `ctx.state` | +1 | 23→24 (state table) | **high (design)** | 4 learnings |
| 6 | `ctx.spawn` | +1 | possible | high | 2 (MCP obs), 5 optional |
| 7 | Tier 2 mid-turn injection (optional) | maybe | none | med | 4 evidence it's needed |
| 8 | Remote deploy + untrusted-submission hardening | no | possible (policy storage) | med | 2; **required before remote exposure** |

Phases 1+3 should land together on one ABI bump if possible (both are small ctx additions).

---

## Phase 0 — Fork & baseline

- Fork upstream to a personal remote (`git remote rename origin upstream`; add `origin` =
  zackleman fork). MIT license permits this; retain the notice. Keep `main` tracking upstream;
  do feature work on `feat/<phase>` branches; Conventional Commits.
- Run and record the baseline: `bun install && bun test && bun run typecheck && bun run lint
  && bun run web:build && bun run web:test`.
- Smoke the daemon end-to-end once: `keel daemon` + launch a trivial workflow + `keel signal`
  + approve/deny + `keel web`, to establish a known-good operational baseline.
- Decide upstream posture: keep patches PR-able (checkpoint + MCP are strong upstream
  candidates; they match Kevin's own sketched roadmap in `DESIGN.md:1179-1185`).

**Exit:** green baseline, fork remotes configured, one end-to-end manual run.

### Phase 0 status (recorded 2026-07-11)

- Remotes configured: `origin` = zackleman/keel fork, `upstream` = kcosr/keel. Integration
  branch: `onyx-extensions` (pushed).
- Baseline on macOS, Bun 1.3.14: `typecheck`, `lint`, `web:build` green.
- `web:test`: **81/81 green under Node 22** (`~/.nvm/versions/node/v22.21.1`). Node 25 ships a
  broken global `localStorage` that shadows jsdom's → 34 spurious failures. Run web tests as:
  `PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH" node web/node_modules/vitest/vitest.mjs run --config vitest.config.ts` (from `web/`), or any Node ≤24.
- `bun test`: 731+ pass; **14 known pre-existing failures**, all caused by the macOS
  `/var → /private/var` tmpdir symlink (tests compare non-realpathed `mkdtempSync(tmpdir())`
  paths against keel's realpathed cwd; upstream develops on Linux). Do NOT fix these as part
  of feature phases. Verification rule for all agents: **no failures outside this list**:
  - workflow definition snapshots > bundled module paths fall back to real runtime paths without accepting filesystem root
  - keel CLI > workflow commands save, list, source, run, and update lifecycle
  - keel CLI > workflow install task-review-guidance classifies created, unchanged, and conflicts
  - WorkflowCtx workspaces > parallel in-process withWorkspace scopes do not bleed into each other
  - trusted-local agent isolation controls > codex default read-only uses the intended workspace cwd
  - trusted-local agent isolation controls > explicit direct workspace uses the supplied cwd and persists a direct row
  - trusted-local agent isolation controls > withWorkspace works when destructured from ctx
  - durable diff + worktree cleanup > parallel default direct workspace agents are permitted
  - durable diff + worktree cleanup > copy workspace snapshots dirty files, excludes git metadata, and uses managed cwd
  - durable diff + worktree cleanup > clone workspace uses explicit local repo and excludes dirty source files
  - durable diff + worktree cleanup > branch-backed worktree uses default direct source and generated branch cwd
  - durable diff + worktree cleanup > creating branch-backed worktree recovers a verified branch and stale worktree path
  - durable diff + worktree cleanup > creating branch-backed worktree recovery fails closed after stale provider acquisition
  - ctx.command > runs commands in a worktree workspace handle and releases the holder
- Quirks: Bun 1.3.14 sometimes crashes on exit (code 133) *after* printing complete results —
  judge runs by the printed pass/fail summary, not the exit code. Test counts inflate under
  heavy parallel load; run the suite alone when comparing against baseline.
- Deferred from Phase 0: manual daemon smoke run (will be covered by Phase 4's workload test).

---

## Phase 1 — `ctx.checkpoint`

**Semantics.** `ctx.checkpoint({ key, message, data? }): Promise<void>` — a typed, journaled,
non-parking effect. "Non-blocking" means *no external wait*, *not* fire-and-forget: the call
awaits journal+event persistence to preserve workflow ordering and pre-completion durability.

**Identity.** `stableKey = spec.key`; `inputHash = hashJson({message, data})`; `version` =
structural hash `{kind:"checkpoint", abi: CHECKPOINT_ABI, bump?}`. Payload change ⇒ new attempt.
Use the **strict-effect** begin path (pending identity mismatch fails closed) so a crash between
pending row and payload event can't silently swap payloads.

**Durable event.** `checkpoint` with `{stableKey, attempt, message, data}` appended **in the
same transaction** as the completed row (via `completeStep(..., events)` —
`src/kernel/step-engine.ts:171-202`). Replay of a completed checkpoint emits **nothing**.

**Projection.** Add optional `checkpoint: {message, data} | null` to `NodeView`
(`src/rpc/view-contract.ts:7-18`) populated from the journal result; the durable event stream
is the timeline source. Decide stats treatment (recommend: own `checkpointCount`). This is a
frozen-contract change → update golden tests.

**File checklist** (traced against source):
- `src/journal/types.ts:7-13` — add `"checkpoint"` to `EffectType` (TEXT column ⇒ **no migration**)
- `src/kernel/ctx.ts` — `CheckpointSpec`, `Ctx.checkpoint`, in-process impl parity
- `src/kernel/realm/protocol.ts` — worker→host `checkpoint` request (+ reply if needed)
- `src/kernel/realm/worker-entry.ts` — validate spec, derive identity, send, await ack
- `src/kernel/step-engine.ts` — `beginCheckpoint` via strict path (`:92-153`); complete w/ event
- `src/kernel/realm/realm-host.ts` — `case "checkpoint"` beside step/command handlers
- `src/rpc/view-contract.ts`, `src/rpc/projection.ts:63-90` — NodeView field + stats decision
- `src/workflow-definitions/abi.ts` — ABI 12→13 (batch with Phase 3 if co-landing)
- Docs: `docs/api.md`, `docs/events.md`, `DESIGN.md` §5.1 taxonomy, `USAGE.md`, `SKILL.md`,
  `CHANGELOG.md`
- Tests: new realm fixture workflow (`src/kernel/realm/fixtures/`), realm integration test
  (one completed row, correct identity, exactly one durable event, no dup on resume, no park),
  step-engine lifecycle test, projection golden update (`src/rpc/rpc.test.ts`), event-cursor
  backfill test. TUI/CLI display of checkpoints is a follow-up, not a gate.

**Exit:** a fixture workflow emits checkpoints; kill-and-resume replays without duplicate
events; projection + events expose payloads; full checks green.

---

## Phase 2 — Supervisor MCP server

**Shape.** New `src/mcp/` (server.ts, tools.ts, auth.ts) + `keel mcp` CLI subcommand: a stdio
MCP server that is a **thin client of the daemon Unix socket**, reusing `DaemonClient`
(`src/daemon/client.ts`), the RPC contracts, and canonical projections. No daemon changes and
**no SDK ABI change** — every needed operation already exists in the gateway.

**Tools** (aligned with keel's own sketch, `DESIGN.md:1179-1185`; token-tiered):
- `list_runs` (admin) → bounded `listRunsPage`
- `watch_run(runId)` → compact status/phase/blockage summary (~100 tokens; the poll target)
- `get_run_detail(runId)` → `RunProjection` (+ report on request)
- `get_run_blockage(runId)` → waiting reason, pending approval/signal/timer
- `tail_checkpoints(runId, afterSeq?)` → durable `checkpoint` events after cursor (bounded page)
- `tail_events(runId, afterSeq?, types?)` → bounded durable-frame page (never an unbounded stream)
- `send_signal(runId, name, payload)` → gateway `sendSignal` (this is also the steer channel)
- `decide_approval(approvalId, decision, note?)` (admin)
- `interrupt_run(runId)` / `resume_run(runId)`
- `launch_saved_workflow(name@version, input)` — returns runId; **redact the minted capability**
- `wait_for_run(runId)` → terminal/parked outcome

**Cursor discipline.** Tools return `{frames, nextCursor}` pages of **durable** frames only;
the supervisor persists `nextCursor` after processing. Ephemeral frames (live deltas) are
deliberately not exposed in v1.

**Auth.** v1 targets a trusted local supervisor: admin token via `KEEL_ADMIN_TOKEN` (same
credential chain as CLI). Document a least-privilege mode (run-token-scoped instance that can
watch/signal exactly one run but not list/approve). Apply the gateway's token-redaction
conventions to all tool output.

**Docs:** `docs/control-surfaces.md` matrix (MCP column goes live), `USAGE.md`, `CHANGELOG.md`,
a short `docs/mcp.md` with the supervisor pattern (poll `watch_run`, drill via
`tail_checkpoints`, steer via `send_signal`).

**Tests:** tool-level integration tests against a live daemon fixture (launch → watch →
checkpoint tail → signal → approve → interrupt), cursor-resume test, redaction test, and a
projection-byte-identity check (MCP `get_run_detail` === CLI `getRun`) per DESIGN §12.1.

**Remote transport note (Phase 8 dependency):** v1 is stdio + local Unix socket. For the
remote server, the same MCP server runs host-side and is reached via SSH-exec stdio or a
streamable-HTTP binding behind Tailscale; `keel web` already provides the browser surface.
No tool-shape changes — only transport/credential wiring, deferred to Phase 8.

**Exit:** from a Claude Code session with the MCP server configured, I can launch, watch
checkpoints, answer an approval, steer, and interrupt a run — without touching the CLI.

---

## Phase 3 — Steering Tier 1: `ctx.drainSignals` + the supervised-loop pattern

**The insight that keeps this clean:** drain steer messages **in workflow code**, then compose
them into the next agent turn's prompt. The turn's `inputHash` already covers its prompt
(`worker-entry.ts:853-894`), so steer content flows into effect identity *for free* — no
host-side prompt mutation, none of the replay-identity hazards of injecting at the
`realm-host.ts:3374` invocation seam.

**New API.** `ctx.drainSignals<T>(key, name): Promise<T[]>` — non-parking; atomically consumes
**all currently-pending** signals of `name` and returns their payloads in delivery order;
returns `[]` when none pending.
- **Journaling:** a completed journal row (author `key`, strict path) whose result is the
  drained payload batch; signal-row consumption marks (`consumed_by = <stableKey#attempt>`)
  committed **in the same transaction**. Replay returns the recorded batch and consumes
  nothing further.
- **Identity:** `inputHash` over `{name}`; the *result* is the nondeterministic part — this is
  an effectful step (result not re-derivable), exactly-once by replay.
- **Ordering interplay:** consuming N signals advances the same per-name FIFO that
  `ctx.signal(name)` uses (`realm-host.ts:3789-3797`, `store.consumeSignal`). Rule of thumb,
  documented: **use a given signal name with either `ctx.signal` or `ctx.drainSignals`, not
  both** (mixing is well-defined — both pull from the oldest-pending queue — but confusing).
- **Migration:** if the `signals` table's consumption bookkeeping (currently keyed for
  `${name}:${occurrence}` single-consumption, `src/journal/store.ts:2218-2242`) needs a
  batch-consumer column, that's schema v22→23 + migration test.

**Conventions + pattern (docs, no code):** steer messages are signals named `steer` (or
`steer:<role>` for multi-agent programs) with payload `{message, from?, atMs}`. SKILL.md gains
a "supervised worker" template:

```ts
const session = ctx.agentSession({ key: "worker", ... });
let done = false, i = 0;
while (!done) {
  const steers = await ctx.drainSignals<Steer>(ctx.stepKey("steer", i), "steer");
  const turn = await session.turn({
    key: ctx.stepKey("turn", i),
    prompt: compose(taskPrompt, lastResult, steers),   // steer content ⇒ turn identity
    schema: TurnResult,
  });
  await ctx.checkpoint({ key: ctx.stepKey("cp", i), message: turn.summary, data: {...} });
  done = turn.done; i++;
}
```

**Delivery semantics (documented honestly, matching keel's contract):** `send_signal` acks
durability + wake start — **not** that the worker saw the message. The supervisor observes
uptake via the next checkpoint. A steer sent while an agent turn is in flight lands at the
next turn boundary (that's Tier 1's contract; Tier 2 tightens it if ever needed).

**Files:** `src/kernel/ctx.ts`, `worker-entry.ts`, `protocol.ts`, `realm-host.ts`
(park-check-like handler that never parks), `step-engine.ts` or a dedicated begin path,
`src/journal/store.ts` (+ possible migration), ABI bump (batch with Phase 1), docs
(USAGE/SKILL/DESIGN signals section), tests: drain-empty, drain-N-in-order, replay-consumes-
nothing, crash-between-pending-and-complete fails closed, mixed signal/drain FIFO sanity,
fixture workflow with the supervised loop.

**Exit:** `keel signal <run> steer '{"message":"focus on the parser"}'` (or the MCP
`send_signal`) demonstrably alters the next turn's prompt; kill -9 + resume replays the same
drained batches; checks green.

---

## Phase 4 — Realistic workload test v1

Build and run the **autoresearch-style heartbeat program** (our three-way comparison sketch)
as a saved keel workflow, supervised over MCP from a live agent session:

- setup agent → experiment loop: `ctx.agent` (typed `ExperimentResult`, `onFailure:"null"`),
  deterministic keep/revert in plain code, recorder agent, `ctx.checkpoint` per iteration,
  `ctx.drainSignals("steer")` per iteration, `ctx.sleep` cool-down, optional `ctx.human` ship
  gate at the end.
- **Chaos matrix** (each must pass):
  1. `kill -9` the daemon mid-agent-turn → resume → no duplicate agent turns, loop state
     rebuilt, checkpoint timeline intact (no dup events)
  2. reboot-equivalent (daemon restart hours later) → resume from parked sleep
  3. steer mid-run from MCP → visible in next turn's prompt and subsequent checkpoint
  4. edit a late-loop prompt + relaunch-with-override → only invalidated suffix re-runs
  5. approval park → answer from MCP → run completes
  6. supervisor cursor resume: restart the MCP client, `tail_checkpoints(afterSeq)` shows no
     gaps/dups
- Record wall-clock, token, and operational friction notes — these decide Phase 5 scope and
  whether Phase 7 is warranted.

**Exit:** the full matrix passes; a written findings note feeds Phases 5–7 scoping.

---

## Phase 5 — `ctx.state` (design doc first, then build)

The genuinely novel piece; Onyx punted durability *because* of it. **Gate: a one-page design
doc settling the decisions below before code.**

**v1 scope recommendation:** run-scoped namespaces (child-sharable in Phase 6), workflow-code
API only (5a); agent-side tools (5b) as a separate sub-phase. Cross-run persistent stores
(Onyx's "reusable over time") deferred to v2 — checkpoints already give supervisors
cross-run visibility.

**API sketch:** `const s = ctx.state<Schema>(namespace)`; `await s.set(key, value)`;
`await s.get(key)`; maybe `await s.update(key, fn)` (fold; fn must be deterministic).

**The replay invariant (the crux):** every read must return the same value on replay.
Two candidate designs to settle in the doc:
- **(A) Journaled reads:** each `get` is an effect whose recorded result replays. Simple,
  matches ambient/occurrence machinery; occurrence-keyed reads are edit-fragile (the known
  `__now#N` issue) unless author-keyed — heavy ergonomics.
- **(B) Deterministic fold (recommended starting position):** only **writes** are journaled
  effects; a read replays as the fold of journaled writes preceding it in this run's execution.
  Reads cost nothing, need no keys, and are correct by construction *for run-scoped,
  single-writer state with no external writers*. Agent-tool writes (5b) then must also be
  journaled writes, keeping the fold sound.
- **Storage:** materialized `state` table (namespace, key, value_json, run_id, updated_at_ms)
  for query/projection surfaces + journal as source of truth. Schema migration v23→24.
- **Schema gating:** namespace declared with a JSON schema; writes validate (this is Onyx's
  "state gates completion" in keel terms — an agent's structured output already validates;
  state adds a shared, queryable place to put it).
- **`continueAsNew` / fork / rewind semantics:** explicit decisions required (constraints doc);
  recommendation: state carries to `continueAsNew` (it's the openclaw use case), rewind
  truncates the write log with the journal, forks copy.
- **Projection/MCP:** namespace snapshot in run detail + `get_state` MCP tool.

**5b (agent-side `state_read`/`state_write` tools) — separate estimate, per-provider:**
keel injects **no custom tools today** (verified); this requires extending the
`AgentProvider` contract (`src/agents/types.ts:28-80`) plus per-provider bridges (Claude via
MCP config; Pi custom tool registration; Codex dynamic tools). Writes need idempotency keyed
by (run, attempt, tool-call id). **Claude-first, others follow.** If 5b proves heavy, the
fallback pattern — agents return structured output, workflow code writes state — already
covers most of Onyx's demonstrated usage.

**Exit (5a):** the workload program's `best`/`history` move into a schema'd namespace;
kill/resume/rewind/fork behave per the design doc; supervisor reads state over MCP.

---

## Phase 6 — `ctx.spawn` (durable child workflows)

Keel reserves lineage for this (`runs.parent_run_id`, DESIGN §"fork/spawn/continueAsNew")
but defers all semantics. **v1 decisions (from the constraints investigation):**

- `ctx.spawn(key, { workflow, input, caps? })` → `{ runId }` handle; `await ctx.waitRun(key2,
  handle)` for the result (both journaled effects). Fire-and-await-later covers Onyx's
  `spawn`/`h.result()` split.
- **Definition pinning:** resolve `name@version` → immutable definition hash **at spawn
  execution** and record it in the effect result; replay never re-resolves (mutable-name
  re-resolution during replay is unsafe).
- **Idempotent creation:** write-ahead — pending row records a pre-minted child runId; crash
  retry reuses it instead of double-launching.
- **Capabilities:** child gets a freshly minted, attenuated run token; parent's authority is
  never implicitly copied.
- **Lifecycle:** v1 = parent interrupt does **not** cascade (document; supervisor can
  interrupt children via MCP — they're visible as runs with `parentRunId`); no child adoption
  across `continueAsNew` (document); child failure surfaces as the `waitRun` result, author
  decides.
- MCP: `list_runs` already shows children via `parentRunId`; add a `children_of` filter.

**Exit:** a parent workflow spawns two children, awaits both, survives daemon kill between
spawn and wait; no duplicate children; lineage visible in MCP/web.

---

## Phase 7 — (Optional) Tier 2 mid-turn injection

Only if Phase 4/5 experience shows between-turn latency actually hurts. Scope honestly:
- **Claude: not possible** in the current adapter (prompt on argv, `stdin: "ignore"` —
  `src/agents/claude.ts:83-96`); would require a drive-mode change. Out of scope.
- **Pi / Codex: mechanically feasible** (live stdin JSON-RPC / live app-server client —
  `pi.ts:95-111`, `codex.ts:494-514`) but requires: extending `AgentProvider` with a steer
  channel, a host registry mapping active effects → steerable handles, **verified** vendor
  protocol semantics for mid-turn input, and journaled delivery rows (attempt-scoped,
  re-delivered-at-turn-start on retry, flagged as such).
- Default assumption: **skip**. Onyx's own showcase programs steer at effect boundaries.

---

## Phase 8 — Remote deployment + untrusted-submission hardening

**Gate: required before the daemon is exposed beyond the local machine.** Can start any time
after Phase 2; independent of 3–7.

**8a. Launch-authority capability ceilings (the code).** A daemon-side policy attached to the
submitting credential that **caps** what workflow-declared capabilities may resolve to,
enforced in the central capability-resolution seam (per AGENTS.md capability rules; ceilings
are identity/versioning-relevant where they alter effect behavior):
- New credential tier: `submitter` tokens (alongside admin/run tokens) carrying a named
  ceiling profile stored daemon-side (e.g. `untrusted-default`: agents read-only, no
  `ctx.command`, no `completionCheck` host commands, workspaces confined to a per-run root
  under the daemon's runs dir, no secrets, no network capability).
- Resolution rule: `effective = min(declared, ceiling)`; a declaration exceeding the ceiling
  **fails closed at launch/validation** with an actionable error naming the ceiling — no
  silent downgrade (silent downgrade would change effect identity vs. author intent).
- **Escalation path (already keel-native):** `ctx.human({requestedCaps})` parks the run; the
  supervisor reviews via MCP `decide_approval` and grants `grantedCaps`. Untrusted code
  *requests*; authority *grants*. Granted caps may exceed the submitter ceiling (that is the
  point) but are journaled with the approval.
- Tests: ceiling-exceeded launch fails closed; escalate-and-grant flow; ceiling change does
  not retroactively alter running runs (launch-time snapshot into run state).

**8b. Submission governance (policy + small glue).**
- **One-offs** launch under the restrictive ceiling by default.
- **Promotion to saved** (`keel workflow save`, admin-only — already the case) requires a
  review gate first: human review or a reviewer-agent pass over the source (checklist: no
  capability over-asks, no prompt-injection-shaped agent prompts, deterministic keys).
  After promotion, registry immutability (`name@version` → hash) makes the weeks-long flows
  tamper-proof by construction; instances are just runs of the pinned hash.
- Retention: default GC window for one-off runs/definitions; saved workflows exempt.

**8c. Blast-radius containment (ops recipe, no keel code).** The server **is** the sandbox in
v1 — do not build per-effect OS sandboxing yet:
- Dedicated VM/container; daemon under systemd as a dedicated non-privileged user.
- Only the provider credentials the box needs; no personal creds/SSH agent forwarding.
- Per-run workspace roots on a disposable volume; egress firewall (allowlist provider APIs);
  ingress via Tailscale only. `keel web` bound per its service guidance; MCP per Phase 2
  remote-transport note.
- Documented rebuild path (the box is cattle). Per-agent bwrap/landlock (keel's own deferred
  OS backstop, DESIGN Phase 15) remains a future Linux hardening option, not a prerequisite.

**Honest residual risk (documented in ops doc):** a run granted write/command caps acts as
the daemon user on that box; provider tool-flag enforcement is not an OS jail; network
capability is advisory until 8c's egress firewall (host-level) backs it. The containment
boundary is the box, not the process.

**Exit:** an agent on a laptop authors a one-off workflow, submits it over Tailscale with a
submitter token, watches it via MCP; an over-privileged declaration fails closed; an
escalation request is granted via supervisor approval; a reviewed workflow is promoted to
`name@version` and rerun for a week unchanged; the box can be rebuilt from the recipe.

---

## Cross-cutting engineering rules

- **Per phase:** feature branch → implement → full checks (`bun test`, typecheck, lint,
  web:build if touched) → docs+changelog per AGENTS.md → adversarial review of replay
  semantics (explicit kill/resume test for every new effect) → merge.
- **ABI hygiene:** one bump per landing set; drain/interrupt non-terminal runs before daemon
  upgrade; note the bump in CHANGELOG.
- **Golden contracts:** any projection/view change updates golden tests in the same commit;
  MCP output must remain byte-identical to CLI/web projections.
- **Upstreamability:** keep Phases 1–3 as clean, self-contained series — offer them upstream;
  carry 5–6 on the fork until proven.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `ctx.state` design flaw corrupts replay | Design doc gate + fold-based reads (B) + rewind/fork tests before any 5b tool work |
| Signal-consumption migration subtly breaks `ctx.signal` FIFO | Dedicated mixed signal/drain ordering tests; migration test on a copied real DB |
| Upstream drift while we hold a fork | Extensions ride on stable seams (StepEngine, gateway, DaemonClient); rebase per upstream release; upstream Phases 1–3 |
| One-person-upstream bus factor | We own the fork regardless; plan assumes no upstream support |
| MCP admin token overexposure | Least-privilege run-token mode documented; redaction tests; localhost stdio only |
| Agent-tool bridges (5b) balloon | 5b isolated, Claude-first, with the structured-output fallback pattern named in docs |
| Untrusted workflow escalates via self-declared caps | Phase 8a ceilings fail closed at launch; escalation only via journaled human/supervisor grant |
| Remote box compromise via granted-caps run | Phase 8c: disposable VM, dedicated user, no ambient creds, egress allowlist, Tailscale-only ingress |
| One-off sprawl on the server | Phase 8b retention/GC defaults; saved registry exempt |

## Implementation orchestration

Each phase: an engineer agent implements against this plan's file checklist in a worktree;
tests written with the implementation (replay/chaos tests are non-negotiable); an independent
review pass focused on replay semantics and contract/golden updates; I verify the chaos
matrix end-to-end before merge. Phases 1+2 can proceed in parallel (disjoint files); 3 follows
1; 4 gates 5–7.
