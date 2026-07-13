# Onyx extensions — adversarial pre-merge review

**Date:** 2026-07-12 · **Scope:** `git diff upstream/main..HEAD` on `onyx-extensions` (15 commits, 82 files, +6658)
**Reviewed:** ctx.checkpoint (ABI 13), `keel mcp` supervisor server, ctx.drainSignals, autoresearch workload + chaos matrix, ctx.state (schema v23), ctx.spawn/ctx.waitRun (ABI 14), Phase 8 submission hardening (schema v24).
**Method:** every finding was verified against the checked-out source, not the diff hunk alone. Read-only review — no source changed, nothing committed. Pre-existing macOS `/private/var` realpath test failures excluded per the Phase 0 baseline.

**Verdict.** The replay kernel work (Phases 1–6) is genuinely solid: the write-ahead lifecycle, transactional completion, content-addressed invalidation, and rewind/fork self-healing all check out (see *Verified sound*). **Phase 8 (untrusted-submission hardening) is not shippable to a remote box yet** — the submitter-ceiling model has multiple full-bypass routes and a fail-open promotion gate, and a background GC path leaks artifacts. Every issue is narrowly fixable; none undermine the kernel design.

**Counts: 3 critical · 7 major · 11 minor.**

> Note on provenance: an earlier aborted review session left a partial artifact at this path. This report supersedes it. Its three criticals were real and are retained (C1–C3); its "verified sound" claim that one-off GC is artifact-safe was **wrong** and is corrected here into a proper finding (M2).

---

## Critical

### C1. Workspace-setup commands execute arbitrary shell with no ceiling check

`assertRunCapabilities` is called at exactly four sites — `ctx.agent` (`src/kernel/realm/realm-host.ts:3165`), `ctx.agentSession` (`:3449`), `ctx.command` (`:3895`), `completionCheck` (`:4049`) — and **never on the workspace-setup path**. `runWorkspaceSetupCommand` (`src/kernel/realm/realm-host.ts:1704`) runs author-declared setup commands via `runBoundedProcess` and resolves `environment.secrets`, even though the setup spec declares its own `capabilities` (`src/kernel/workspace-setup.ts:98`, carried at `:175`, in effect identity at `:153`).

**Failure scenario:** a submitter under the `untrusted-default` ceiling (`READ_ONLY`: `shell:false`, `network:none`) submits a one-off whose agent workspace spec includes `setup: { commands: [{ run: "curl … | sh" }], capabilities: { shell: true } }`. The command executes as the daemon user. `normalizeSetupCapabilities` requires `shell:true` for any setup command, so *every* setup-bearing workflow should already fail the ceiling and instead runs unchecked.

**Fix:** before executing setup commands, call `this.assertRunCapabilities(runId, setup.capabilities, \`workspaceSetup("…")\`)` with the same fail-closed shape as the `ctx.command` site (`:3895`). Add a ceiling test with a setup-bearing workflow.

### C2. `continueAsNew` drops the launch-authority snapshot — self-serve ceiling escape

The successor `insertRun` in `case "continue"` (`src/kernel/realm/realm-host.ts:4258`) copies name / definition / target / profile / settings but **not `launchAuthorityJson`**. The successor's authority is therefore `null`, which makes `assertRunCapabilities` a no-op for the entire successor run (`launchAuthorityForRun` → `parseLaunchAuthority(null)` → `null` → `assertCapabilitiesWithinAuthority` returns early, `:473`, `launch-authority.ts:49`).

**Failure scenario:** an untrusted one-off's first statement is `if (!input.hop) return ctx.continueAsNew({ ...input, hop: 1 })`. The second hop runs every agent/command/setup effect with no ceiling. No admin interaction, no approval — fully self-serve.

**Fix:** carry `launchAuthorityJson: run.launchAuthorityJson` into the successor row, mirroring what `ctx.spawn` already does for children (`:3782` region). Regression test: a ceiling-launched run continues; the successor's over-ceiling effect still fails closed.

### C3. `forkRun` drops the launch-authority snapshot, and the gateway hands the submitter the keys

`store.forkRun` (`src/journal/store.ts:2133`) inserts the fork row without `launchAuthorityJson` — nullable-optional in `NewRunRow` (`src/journal/types.ts:52`), so it silently defaults to `null`. The gateway `forkRun` op requires only `run:fork` on the *source* run and then mints and returns a fresh full-action capability for the fork. `DEFAULT_RUN_CAPABILITY_ACTIONS` (`src/auth/capabilities.ts:45`) includes `run:fork`, `run:resume`, `run:rewind`, and `launchRun` returns that run cap straight to the submitter.

**Failure scenario:** a submitter launches a one-off (ceiling snapshotted; an over-ceiling effect fails closed → run goes terminal), calls `forkRun` with the returned run token, receives the fork's capability, then `resumeRun`s the fork → the suffix re-executes with **no ceiling**.

**Fix:** copy `launchAuthorityJson` in `store.forkRun`. Root-cause fix (shared with C2): make `launchAuthorityJson` a required, explicitly-listed field on `NewRunRow` so every `insertRun` call site type-errors on omission — there are five (`store.ts:2137`, `realm-host.ts:562`, `:631`, `:3782`, `:4258`) and the type currently lets three of them forget it. Same regression-test shape as C2.

---

## Major

### M1. Promotion review gate fails open for modified or never-run source

`assertPromotionReviewed` (`src/daemon/gateway.ts:795`) requires `reviewApproval` **only when** the promoted source hashes to the definition of an existing one-off run (`if (!hasOneOffRun) return`). Any source that never ran — including a one-off source altered by a single byte after its reviewed run — skips the gate entirely. This inverts the intent: the exact case the gate exists for (agent-authored source reaching the immutable registry) is the one that bypasses it. Additionally, *any* approved approval on the reviewed run qualifies (`getApproval(review.runId, review.key)` with `status === "approved"`), so a workflow's own `ship` gate doubles as "promotion review." `docs/deployment-hardening.md:44` claims the stronger property.

**Fix:** flip the default — when any submitter credential exists (a launch-authority regime is active), *all* `saveWorkflow` calls require a review approval whose run's `definitionVersion` equals the promoted hash; keep the existing hash-match check. Consider a dedicated approval kind (e.g. a `review:` key prefix) so ship gates cannot satisfy promotion.

### M2. One-off GC leaks artifacts permanently — `gcArtifacts()` has no production caller

`pruneOneOffRuns` (`src/journal/store.ts:~205`) raw-deletes `journal` rows for pruned one-off runs. That is only safe if artifact refcounts are subsequently recomputed from the journal — but `gcArtifacts()` (`src/journal/store.ts:2210`) is invoked from **nowhere in production**: the only callers are `src/journal/gc.test.ts` and `src/kernel/state.test.ts`. `gcDefinitions` (the operation `keel gc` runs) calls `pruneOneOffRuns`, `pruneWorkflowDefinitions`, and `evictWorkflowDefinitionCache` — never `gcArtifacts`. So every artifact-backed result (agent outputs, >1KB state values, large step results) owned by a pruned one-off is orphaned in the `artifacts` table forever, with a now-stale positive refcount.

> This corrects the prior artifact's "verified sound" bullet, which asserted the deletion was safe "because artifact GC recomputes refcounts from the journal." The recompute exists but is never run.

**Failure scenario:** a remote box runs one-off workloads for a week; nightly `keel gc` prunes terminal one-offs (per M-doc default) but reclaims none of their artifact bytes. Disk grows unbounded on the "cattle" box the deployment doc says is disposable.

**Fix:** call `this.gcArtifacts()` inside `gcDefinitions` after the prune steps (it already recomputes refcounts from the journal, so it self-heals the refcount drift too). Add a retention test asserting an artifact owned only by a pruned one-off is removed.

### M3. `keel gc` now deletes run history by default, with stale help text and no CLI TTL flag

`gcDefinitions` gained a `pruneOneOffRuns` step (`src/daemon/gateway.ts:701`, `src/rpc/in-process.ts:925`) that deletes terminal one-off runs older than `DEFAULT_ONE_OFF_RUN_TTL_MS` (7 days). But the `keel gc` CLI command (`src/cli/keel.ts:550`) calls `client.gcDefinitions()` with **no arguments** — so an operator running `keel gc` to "prune unreferenced workflow definitions and cache entries" (its literal help text, `src/cli/keel.ts:169`) now also destroys a week of one-off run journals/events/state, with no flag to opt out or override the TTL. The RPC accepts `runTtlMs`; the CLI never exposes it.

**Fix:** update the `gc` help string to state that terminal one-off runs are pruned; add a `--run-ttl-ms` flag (and/or `--no-run-gc`) threaded into `gcDefinitions({ runTtlMs })`. Confirm this is the intended default before shipping — silent history deletion on a maintenance command is surprising.

### M4. The submitter ceiling is transport-optional; no deployment shape makes it mandatory

`launchAuthorityForCredential` (`src/daemon/gateway.ts:773`) returns `null` (no ceiling) for `credential === null`, and the Unix-socket surface never forces authentication. The web surface gates `launchRun` behind **admin** (`webRequiresAdmin`, `:736`), so a submitter token cannot launch there at all. Net: the only transport where a submitter token *works* is the Unix socket — where presenting it is voluntary. The documented topology (`docs/deployment-hardening.md:20`, SSH-exec to the box) gives a remote laptop a process running as the `keel` user with raw socket access; omitting the token yields **trusted-local, ceiling-free** launches. Phase 8's exit criterion ("submit over Tailscale with a submitter token … over-privileged declaration fails closed") has no transport on which the ceiling is enforced against a non-cooperating client.

**Fix (decision required):** either a daemon `--require-auth` mode that rejects null-credential sessions on the socket, or a submitter-capable authenticated remote transport (web `launchRun` accepting submitter tokens with the ceiling applied). At minimum, `deployment-hardening.md` must state that socket access = full trust and the submitter token is only meaningful behind an authenticating transport boundary.

### M5. Submitter tokens bypass per-workflow authorization on `launchSavedWorkflow`

In the gateway `launchSavedWorkflow` handler (`src/daemon/gateway.ts:229`), when `launchAuthorityForCredential(credential, true)` returns a submitter authority, **both** `authorizeWorkflow(… "workflow:run")` checks are skipped (`if (!launchAuthority) …`). A submitter token carries only `workflow:submit`, so the intent is clearly "submitters may launch saved workflows under a ceiling" — but the effect is that a submitter can launch **any** saved workflow by name, with no per-workflow `workflow:run` grant, capped only by the capability ceiling. That is a real policy expansion (submitters were conceived for one-off source, not arbitrary saved-registry execution) and it is undocumented.

**Fix:** decide and document the intended authority. If submitters *should* run saved workflows, say so in `deployment-hardening.md` and keep the ceiling; if not, require an explicit `workflow:run` grant even when a launch authority is present. Add a test pinning whichever policy is chosen.

### M6. Rewind past a completed `spawn` double-launches children; fork of a spawn-bearing run is a dead end

`startRewind` (`src/kernel/realm/realm-host.ts:849`) guards durable agent sessions but not spawns. Rewinding past a completed spawn deletes the spawn journal row; re-execution hits `beginSpawn` with no existing row → mints a **new** child runId → a second child runs the same workflow+input while the original keeps running (interrupts don't cascade, by design). `children_of` then shows both. Fork (`store.ts:2133` / host `fork()`) copies the completed spawn row, so the forked run's replayed handle points at the *source's* child; `ctx.waitRun` then fails its `child.parentRunId !== runId` guard (`:3868`) and the fork is unusable — fail-closed, but a guaranteed dead end.

**Fix:** in `startRewind`, refuse when journal rows with `effect_type='spawn'` fall after the cut (message parity with the agent-session guard at `:859`), or cascade-interrupt orphaned children. In `fork()`, refuse when the copied prefix contains spawn rows. Both mirror the existing `hasAgentSessions` precedent.

### M7. Spawn/wait-run handler exceptions abort the run as a HostFault loop instead of failing the workflow

Inside `case "spawn"` (`src/kernel/realm/realm-host.ts:3711`) only `beginSpawn` is wrapped. `resolveSavedWorkflowRef` (`:3746` — an unknown/disabled workflow name, i.e. an ordinary author typo), `requireRunTarget`, and `materializeWorkflowDefinition` throw into the generic `worker.onmessage` catch (`:4310`), which records `run.aborted {name:"HostFault"}` and leaves the run **resumable**. Every resume re-throws identically — an infinite abort/resume loop that never surfaces as a workflow failure the author or a `waitRun` caller can handle. `case "wait-run"`'s store lookups have the same exposure.

**Fix:** wrap resolution/creation in `try → replyError(m.id, err)` so the error propagates into the workflow as a normal effect failure, matching the `ctx.agent` capability-failure pattern (`:3160`).

---

## Minor

1. **Approval `grantedCaps` scope is run-wide and heritable.** `grantRunCapabilities` (`realm-host.ts:487`, applied at `:4178`) permanently raises the *run's* ceiling; children spawned after the grant inherit the raised authority (`:3782` copies `launchAuthorityJson`). Defensible per "authority grants," but nothing documents that a single step-scoped grant escalates the whole remainder of the run plus descendants. Document, or store grants per-effect.
2. **`ctx.spawn`'s `caps` attenuation is functionally inert.** The child capability is minted inside the creation transaction (`realm-host.ts:3782` region, `issueRunCapability(… { actions: m.spawn.caps })`) and the returned token is **discarded** — never surfaced to the parent, never returned from `ctx.spawn` (which resolves to `{ runId }` only). So narrowing `caps` narrows a token nobody can retrieve; a supervisor reaches children via admin/parent credentials regardless. Either surface the child token or document that `caps` only constrains a child's *self-issued* capability row, not any usable handle.
3. **Unbounded checkpoint payloads in the projection.** `buildProjection` inlines a checkpoint node's `data` via `readJournalResult(store, r)` (`src/rpc/projection.ts:77`), which fully materializes artifact-backed results with no stub — unlike `RunProjection.state`, which caps inline values at 1KB and stubs the rest (`:108`, `MAX_RUN_STATE_VALUE_BYTES`). A workflow that checkpoints a large `data` blob makes every `get_run_detail` / `getRun` return the whole blob. Consider the same artifact-stub treatment for checkpoint payloads.
4. **Redaction only matches `kc_run_`/`kc_admin_` prefixes** (`src/auth/redaction.ts:1`). Submitter bootstrap tokens (`kc_submitter_…`) and operator-supplied tokens in other formats are never redacted if they enter journaled content or error messages. Extend the pattern to include `submitter` (and ideally redact `CapabilityCeilingError` envelope fields uniformly, `gateway.ts:746`).
5. **Docs drift — USAGE ctx summary table.** The `ctx` API table (`USAGE.md:1023-1025`) lists `checkpoint`/`state`/`drainSignals` but **omits `spawn` and `waitRun`** rows, though both are fully documented later at `USAGE.md:1670-1681`. Add the two rows for table completeness.
6. **Docs drift — SKILL param name.** `SKILL.md:89` names `ctx.waitRun`'s second parameter `child`, while the code and USAGE call it `handle` (`spawn.ts` / `USAGE.md:1677`). Align on `handle`.
7. **Docs drift — MCP credential list.** `USAGE.md`'s `keel mcp` section lists accepted credentials as `KEEL_ADMIN_TOKEN`, `KEEL_RUN_CAP`, or `KEEL_CAP_FILE`, but `loadMcpCredential` (`src/mcp/auth.ts:13-19`) also accepts `KEEL_SUBMITTER_TOKEN`. Add it to the MCP docs.
8. **API-shape asymmetry across the new primitives.** `checkpoint({key,…})` and `state.set({key,…})` put the stable key inside a spec object; `drainSignals(key, name)` and `waitRun(key, handle)` are positional; `spawn(key, {workflow,…})` is mixed. Any one convention is fine; three is not — settle before an upstream PR. Also `ctx.waitRun` of a child that `continueAsNew`s returns `status:"continued"` with `output:{continuedTo}` — correct per "no adoption," but undocumented in USAGE's waitRun section.
9. **`checkpointCount` counts pending/failed checkpoint nodes**, not just completed payloads (`src/rpc/projection.ts:94` filters `effectType === "checkpoint"` without a status guard, whereas the node's `checkpoint` payload is populated only when `status === "completed"`, `:77`). Harmless, but the docs read as "checkpoints emitted." Filter on completed for consistency.
10. **Chaos-matrix assertions are weaker than `workload-test-results.md` claims.** The cursor-resume test asserts 4 distinct seqs but not cross-page ordering/contiguity (`fixtures/autoresearch-workload/autoresearch.workload.test.ts:301-318`); the SIGKILL test never asserts *exactly one* completed attempt for `experiment:1` (`:144-161`); fixed 400/800 ms sleeps are timing assumptions (`:115-140,181-195`). The results doc's "no duplicate completed attempt / monotonically increasing / no gaps" claims are stronger than what's tested. Tighten before citing the matrix upstream.
11. **`stateValues` is module-global in the worker** (`src/kernel/realm/worker-entry.ts:526`). Safe today because `execute()` creates a fresh Worker per pass (`realm-host.ts:~2956`), but a worker-reuse refactor would silently bleed state across runs. A one-line comment pinning the "fresh worker per run" invariant would cheaply protect it.

---

## Verified sound (personally checked, no finding)

- **Checkpoint replay-exactness.** The durable `checkpoint` event is appended inside the `commitStep` transaction alongside the completed row (`step-engine.ts:395-420`); the replay branch replies without re-emitting (`realm-host.ts:3624`); identity = author key + `hashJson({message,data})` + versioned `{kind:"checkpoint"}` (`checkpoint.ts`).
- **drainSignals transactionality & rewind.** FIFO consumption runs inside the commit transaction via the value closure (`step-engine.ts:296` `completeDrainSignals` → `store.drainSignals`); replay consumes nothing (`realm-host.ts` drain-signals replay branch); rewind restores exactly the batches owned by *discarded* drain rows before clearing still-pending signals (`store.ts:2095-2112`), preserving seq order. Bun-SQLite's synchronous single-connection model makes the select-then-update pair race-free.
- **ctx.state fold correctness.** Value ∈ `inputHash` (`state.ts` identity `{namespace,name,value}`) so no stale-value replay; the materialized row is upserted in the commit transaction (`completeStateWrite`, `step-engine.ts:335`) and re-upserted on the replay branch (`beginStateWrite` replay-touch, `:196`) rebuilding the table in program order — the ordering-trap regression covers this; rewind deletes all state rows inside the cut transaction (`store.ts:2087`); projection stubs >1KB artifact values and `getRunState` resolves ≤64KB, matching `ctx-state-design.md §7`.
- **spawn write-ahead.** The child runId is pre-minted into the pending row (`beginSpawn`, `step-engine.ts:137`); the definition hash is pinned at first execution and re-recorded on the reservation; a crash between child creation and parent commit reuses the reservation (`spawn.test.ts:119`, `daemon.test.ts` kill-recovery). The child-creation transaction includes lineage, profile/setting snapshot copies, capability mint, and `run.started`; parent/definition validation fails closed on reservation conflict. The child inherits the parent's `launchAuthorityJson` — the one place Phase 8 authority propagation was done correctly (contrast C2/C3).
- **waitRun.** Strict effect keyed on `{runId}`; the subscription + immediate-settle check (`waitForChildOutcome`, `realm-host.ts:2900` region) avoids the missed-event race; aborts on interrupt; the terminal outcome is journaled exactly once. `run.outputRef` holds full JSON (the 8KB inline cap applies to the `run.finished` *event*, not the row), so `childOutcome`'s `JSON.parse` is safe for large outputs.
- **DaemonClient backpressure change.** The write-queue fix is correct: a single FIFO with per-item `offset`, drain-driven flush, `written < 0` → `close()`, `written === 0` → yield, and no interleaving across `rpc()` callers. Close-mid-frame leaves only a partial trailing line the server discards on disconnect; message ordering is preserved. (Two *pre-existing* adjacent issues noted for upstream, not caused by this diff: `rpc()` after `close()` queues silently and hangs rather than rejecting; `onData`'s per-chunk `data.toString("utf8")` at `client.ts:91` can corrupt a multi-byte UTF-8 sequence split across socket chunks — newly load-bearing now that checkpoint messages and state values flow through MCP tails. A `TextDecoder({stream:true})` or byte-buffer framing would fix it.)
- **MCP surface.** All authorization is daemon-side (run-token scoping, admin ops, submitter path); no direct store access; `launch_saved_workflow` returns only `{ runId }` and discards the minted capability (`tools.ts:154`); event frames are redacted at both the gateway and the tool layer (`safe()` → `redactCapabilityTokensInValue`), with an injection test.
- **Migrations.** Schema 22→23 (state table) and 23→24 (launch-authority column + capability ceiling column) are additive, `IF NOT EXISTS`/`addColumn`, and covered on a copied real DB (`migration.test.ts`). `pruneOneOffRuns` correctly excludes saved refs, runs with children, and runs with live workspaces (`store.ts:214-259`). (Artifact reclamation gap is M2, not a migration issue.)
- **ABI enforcement.** `WORKFLOW_SDK_ABI_VERSION = 14`, strict-equality checked at launch and resume. `ctx.command` requires declared `shell:true`/`workspace-write`, so the ceiling assertion cannot be dodged by omission; agent `environment.secrets` must be granted by `capabilities.secrets` (`environment.ts:73-76`); secrets remain run-scoped launcher-provided values.

---

## Fix orchestration

Stable IDs preserved for dispatch. Coupling constraints:

- **C2 + C3 → one agent.** Same root cause: `launchAuthorityJson` is optional in `NewRunRow`, so run-creation sites silently omit it. The correct fix is a single type-level change (make the field required / explicitly listed so all five `insertRun` sites type-error on omission) plus the two site copies and one shared regression-test shape. Two parallel agents would each land a divergent one-line patch and neither would make the type fix that prevents recurrence.
- **C3 + M6 → one agent, or strictly sequenced.** Both edit the fork machinery: C3 adds the authority copy in `store.forkRun`; M6 adds a "refuse fork when the copied prefix contains spawn rows" guard in `fork()`/`startRewind`. They don't change each other's *semantics*, but they edit the same function/flow — parallel edits guarantee a textual conflict, and M6's refusal check should sit around C3's copy.
- **C1, M1, M5, M7 → freely parallelizable.** C1 (setup-path assert) touches the realm-host workspace-setup section; M7 (spawn/wait-run `replyError` routing) touches the `case "spawn"`/`case "wait-run"` handlers; M1 (promotion-gate default flip) and M5 (submitter saved-workflow authz) are gateway-only. No semantic interaction. Caveat: C1 and M7 both edit `realm-host.ts` in different regions — fine with worktree isolation, mild rebase friction otherwise.
- **M2, M3 → one agent (both live in the GC path).** M2 adds the `gcArtifacts()` call inside `gcDefinitions`; M3 fixes the `keel gc` CLI help/flags for the one-off-run prune. Adjacent, same feature area, cheaper as one change with one retention test covering both.
- **M4 → decision, then docs or code.** Requires a product call (require-auth mode vs authenticated submitter transport) before implementation; land the doc correction now regardless.
- **Doc-only minors (5, 6, 7, and the doc half of M4) → one agent** in a single docs pass.

**Recommended order:** (1) C1/C2/C3 — small mechanical patches + regression tests, C2/C3 the shared row-copy/type fix. (2) M1 (invert promotion default), M2/M3 (GC leak + CLI), M6 (fork/rewind spawn guards). (3) M4 decision + M5 policy pin. (4) M7 and the doc/test polish before offering Phases 1–3 upstream.
