# Keel - Design v2 Record

> **Status:** architecture and design-history record for the current system.
> **Codename:** *Keel* (placeholder, swap freely).
> **Provenance:** rebuilt after a feature-by-feature keep/cut review, a phasing
> critique, and an implementation pass. Open decisions appear as **⚠ DECIDE**
> blocks with a recommendation attached.
>
> **How to read:** sections 1–13 are the design; §14 is the scope board
> (keep/defer/cut); §15 is the implementation pipeline (one commit per phase);
> §17 is the decision register.

---

## 0. Implementation Snapshot (2026-06-11)

This section records the implementation state when the design pipeline finished.
It is not the live command reference or the current verification report; use
`USAGE.md`, `README.md`, and the current branch checks for that.

**All 19 phases of the §15 pipeline are built**, one commit each, every commit
green (`bun test` + `tsc --noEmit` + biome), and two subsequent rounds of an
external monitoring review have been incorporated and adversarially verified. 167
tests pass; 3 `KEEL_LIVE`-gated live tests against the real Pi-driven LLM are
skipped by default. See `USAGE.md` for the how-to-use reference (including a
"Known limitations / sharp edges" section) and `README.md` for orientation.

What exists, end to end: the SQLite-WAL journal and content-addressed hashing; the
memoized re-execution core and the write-ahead crash protocol (proven under real
`kill -9`); the deterministic Bun-Worker realm with the acorn determinism lint;
structural versioning, value-hash invalidation and early cutoff; `ctx.agent` with
the live Pi adapter and a deterministic mock; the two-tier artifact store; the
review workload ported and run live; the frozen RPC contract and canonical
RunProjection; the out-of-process daemon + thin CLI with CAS-fenced crash
recovery; liveness (stall-retry, timeouts, blockage); agent capabilities,
explicit managed workspaces, diff gate, and secrets side-channel; durable
`ctx.sleep` with the supervisor and cron; full HITL (`ctx.human`/`ctx.signal`);
time travel (retry/rewind/fork); immutable workflow definition snapshots;
daemon-enforced bearer capabilities; explicit resumable run interruption;
stateless `keel execute`; and ops (artifact GC, `continueAsNew`,
Postgres-dialect discipline).

**Deltas from the original design text, all intentional and noted in place:**

- **Schema coercion is opt-in, not default (§10.3).** The kernel validates
  structured output *strictly* and journals the model's answer faithfully;
  tolerant coercion (lowercase enums, number→string, drop unknowns) is enabled per
  agent via `lenient: true`. The schema is always injected into the prompt.
- **Phase 14 is met as a budget-scaled live rehearsal (§15).** The full 111-agent
  live run against the original aw-gateway repo is unblocked but unrun only because
  that target repo is absent on this machine; shape + durability + crash-resume are
  proven at scale on mock and live at reduced fan-out.
- **`ctx.agent` gained `reasoning`** (Pi `--thinking`), **`lenient`**,
  **`profile`**, and provider-keyed **`providerConfig`**. Named profiles resolve
  into concrete fields *before* versioning, so resolved fields, not the profile
  name, enter the hash. Provider config is strict JSON; only the selected
  provider's entry is folded into identity and passed to the adapter. Capabilities
  + secrets are folded into both the version AND the input hash, identically
  across the realm and in-process paths.
- **Journal ordering uses an explicit `seq` column** (not SQLite `rowid`) so
  rewind/fork cuts stay Postgres-portable, and an **additive forward migration
  ladder** upgrades older journals in place rather than refusing to open.
- **Durable-wait identity:** `ctx.sleep(key, ms)` takes a stable author key
  (timer id `${key}#${ms}`); `ctx.signal` keys by name + per-name occurrence — so
  reordering/inserting waits doesn't reattach a persisted wait to the wrong site.
- **Capability *enforcement* landed (§11):** provider tool policies map to vendor
  flags; provider cwd always comes from a run workspace (explicit, scoped, or
  the default direct workspace at `ctx.run.target`); Keel-owned worktree/copy/
  clone workspaces are explicit `ctx.workspace(...)` handles with retention,
  secrets are injected as trusted-local provider env, `continueAsNew` is
  an atomic transactional handoff with lineage, and fork is fenced to terminal
  runs. The OS-sandbox capability backstop remains the one unimplemented
  hardening.
- **Run authorization is object-capability based.** Launch is open to local
  callers and mints a run capability. Existing-run read/control operations
  require a run capability or an admin capability; the daemon stores only token
  hashes. The CLI writes cap files by default and raw tokens require explicit
  opt-in.
- **Workflow definitions are immutable source bundles.** `runs.definition_version`
  is the content-addressed definition hash; `runs.workflow_ref` is provenance.
  File launches capture the static local `.ts`/`.tsx` import graph client-side,
  and resume/retry/rewind/fork use the stored bundle. Rerun with a source
  override snapshots new source intentionally.
- Agent profiles support both constructor-supplied programmatic profiles and an
  admin-managed persistent catalog. Durable runs freeze the complete effective
  profile catalog in `run_profile_snapshot_sets`/`run_profile_snapshots` so
  replay/resume never reads mutable catalog state. Profile catalog RPC/CLI
  operations require daemon admin authorization.
- **Daemon settings are a typed catalog, not an arbitrary config bag.** Journal
  schema v17 stores set daemon setting rows in `daemon_settings` and freezes the
  complete workflow-visible default set per run in
  `run_setting_snapshot_sets`/`run_setting_snapshots`. Agent default resolution
  is `workflow spec > named profile > run settings snapshot`; a missing or
  partial run settings snapshot is corrupt durable state and fails closed rather
  than falling back to live code defaults.
- The bundled daemon constructs the trusted-local in-memory `SecretStore`.
  Clients can supply run secret values on launch/retry/rewind/rerun; workflows
  request those names through `environment.secrets`. The CLI also wires
  capability credentials (`KEEL_ADMIN_TOKEN`, `KEEL_RUN_CAP`, `KEEL_CAP_FILE`)
  and the retained workspace store (`KEEL_WORKSPACE_STORE`).

---

## 1. Premise

Keel is a **durable agent-workflow orchestrator**. A workflow is an ordinary
`async (ctx, input) => output` function. Every external effect goes through
`ctx.*` and is journaled to a durable store; resume re-runs the function with a
memoizing `ctx` — completed effects replay from the journal, the first incomplete
one runs live. The orchestration body executes in a deterministic realm (no
ambient fs/net/clock/random; only `ctx.*` escapes). A **single-writer Bun
daemon** owns the journal, the realm, scheduling, and the canonical run
projection; CLI/web/MCP are thin clients, and **the daemon — never the CLI —
spawns agent subprocesses**.

In one line: **imperative workflow authoring on the Durable Functions / DBOS
execution model**. The novelty is the combination of three things on top of that
proven model: the **agent effect** (session-resumable, schema-enforced,
capability-declared), **enforced determinism** (not by convention), and
**content-addressed per-step invalidation** (edit one step, re-run only its
dataflow descendants).

## 2. The large fan-out workload (binding constraint)

The design's acceptance stress test is a review-shaped workflow that fans out
**20 finders** (13 subsystem reviewers + 7 cross-cutting lenses), deduplicates
**90 findings** in plain code, fans out **90 adversarial verifiers** (one per
finding), and synthesizes a report: **111 agents** with compact imperative
orchestration and plain-code reducers.

Every API and durability decision is judged against one question: *does this
workload still read as ~140 clear lines, and does it survive a crash at minute
105 without re-running the first 104?*

The active fixture lives at `fixtures/review-workload/`. It keeps the workload shape,
mock-scale regression, compact line-count pressure, and budget-scaled live
rehearsal without carrying historical provider run artifacts.

## 3. Goals & non-goals

### Goals

- **Durable, resumable execution.** A run survives process death, reboot, and
  code edits. Resume re-executes only steps that are incomplete or invalidated.
- **Imperative authoring.** Plain `async` functions — no JSX, no re-render, no
  graph DSL. Authorable by humans *and* agents.
- **Content-addressed, per-step invalidation.** Editing one step invalidates that
  step and its dataflow descendants — never the whole workflow.
- **Determinism by construction.** The orchestration body *cannot* perform
  unjournaled side effects; the kernel enforces it.
- **Durable beyond session files.** Runs live in a shared store (SQLite-WAL at
  `~/.keel/keel.db`, owned exclusively by the daemon) — observable and
  resumable from any client, days later, from another machine.
- **Symmetric observability.** Humans (CLI/web) and agents (MCP) read the *same*
  canonical projection; no surface reconstructs state independently.
- **Capability-gated agents.** Agent tools default to read-only and broader side
  effects are declared explicitly; isolated worktree execution is an explicit
  opt-in with diff-gate review.
- **Time travel.** Retry a step, rewind, fork — backed by the journal and
  workspace snapshots.

### Non-goals

- **Distributed multi-worker execution.** Single-writer daemon, scaling
  vertically. Multi-worker is a deferred scaling story, not a correctness story.
- **Sub-step durability.** The atom of durability is the step / agent call;
  mid-call recovery is via vendor session tokens (§10.4). Millisecond-granular
  workflows are Temporal's domain.
- **General FaaS / high-QPS request handling.**
- **Hot code reload mid-run.** A paused run resumes against its archived
  definition (§7.5); changed code is a new version, with an explicit opt-in
  adoption path.
- **Reimplementing model vendors' tools.** Keel wraps agent CLIs/SDKs.
- **Hosted multi-tenant SaaS** — ruled out (**L17**, §17). Deployment is
  team-internal; no tenant control plane, metering, or per-tenant isolation is
  designed. (Agent sandboxing remains — it guards against untrusted agent code,
  not tenants.)

## 4. Lineage — borrowed, rejected, and the defects being fixed

| System | Adopt | Reject |
|---|---|---|
| **Azure Durable Functions** | Step memoization by `(stepId, inputHash)`; body re-runs, completed steps short-circuit. This *is* the execution model. | Determinism by convention — Keel enforces it. |
| **DBOS** | Journal/DB as the single queryable source of truth; daemon rebuilds from it after a crash. | SQL stored procedures as the authoring unit. |
| **Temporal** | Determinism *enforcement*; error-first DX (fail loudly, never silently memoize a wrong value). | Event-sourced replay of all history — too costly for multi-million-token runs. |
| **Restate / Inngest** | Per-handler versioning; resume by `(key, input hash)`. | Multi-worker coordination (deferred). |
| **Claude Workflow runtime** | Imperative-JS authoring; injected effects; structured output at the tool boundary; plain-code reducers; fan-out/verify/synthesize patterns; stall-detection + retry. | Positional-prefix resume; session-scoped-only persistence. |
| **Vault / OS sandboxes** | Scoped, sealed secret injection; declarative per-workload isolation as capability backstop. | As early dependencies — enforcement is deferred (§15 Phase 15). |

The prior-runtime defects that shaped Keel map to these requirements:

| # | Prior defect | Keel answer |
|---|---|---|
| 1 | Determinism by convention; non-transactional unmount cancellation | Enforced deterministic realm (§6) |
| 2 | Five overlapping dataflow mechanisms | One step model; no parallel/loop effect types (§9.1) |
| 3 | All-or-nothing workflow hash (`RESUME_METADATA_MISMATCH` on a comment fix) | Structural per-step versioning (§5.2) |
| 4 | Multi-process on one SQLite file | Single-writer daemon; clients never touch the DB (§7) |
| 5 | Per-agent-family safety patchwork | One normalized capability layer + backstop (§11) |
| 6 | Read-surface drift (`NodeHasNoOutput`, `[object Object]`) | One canonical projection + golden contract tests (§12.1) |
| 7 | Stack weight / surface sprawl | Explicit scope tiers and a cut list (§14) |

## 5. Core model — durable functions over a journal

### 5.1 The effect taxonomy (the crux)

| Category | What | First run | On resume | `effect_type` |
|---|---|---|---|---|
| **Pure step** | `ctx.step(key, schema, fn)` — `fn` deterministic in its inputs (reducers, transforms). | Execute, validate against schema, persist result + `inputHash`. | `inputHash` and `version` unchanged → **replay** without executing. Changed → re-execute as a new attempt. | `pure` |
| **Effectful step** | `ctx.agent`, `ctx.human`, `ctx.signal` (and `ctx.spawn`, deferred) — result not re-derivable from inputs. | Execute under write-ahead (§5.5), persist result. | **A `completed` effectful step is never re-executed** (exactly-once result replay). **A `pending` one re-executes at-least-once** — which is why agent calls must be idempotent or carry a dedup key. | `effectful` |
| **Command effect** | `ctx.command(spec)` — bounded host-side process execution in an explicit workspace. | Validate workspace/cwd/capabilities/env, write pending row, acquire the workspace holder, run the command, persist bounded result. | Matching completed commands replay without spawning. Matching pending commands may spawn again under at-least-once crash/retry semantics. Pending identity mismatches fail closed. | `command` |
| **Workspace setup** | `ctx.workspace({ setup })` — bounded host-side preparation commands attached to an explicit workspace. | Resolve/create the workspace, compute setup identity, mark setup pending, run setup commands sequentially, persist bounded command diagnostics, then mark the workspace ready. | Matching completed setup is reused for the same run-scoped workspace. Pending setup commands may run again after crash; failed setup fails later workspace resolution. | `workspace_setup` |
| **Completion check effect** | `ctx.completionCheck(spec)` — host-side command/git gate for curated workflow completion. | Validate workspace row and check identity, write pending row, acquire the workspace holder, run the check, persist bounded result and events. | Matching completed checks replay. New completion attempts use new keys and observe current workspace/git/remote state. Pending identity mismatches fail closed. | `completion_check` |
| **Checkpoint effect** | `ctx.checkpoint({ key, message, data? })` — durable, non-parking progress. | Write a strict pending row, then transactionally commit the payload result and one durable `checkpoint` event. | Matching completed checkpoints replay without another event. Matching pending checkpoints re-execute; pending identity mismatches fail closed. | `checkpoint` |
| **Signal drain effect** | `ctx.drainSignals(key, name)` — non-parking FIFO batch consumption. | Write a strict pending row, then consume every currently pending signal of `name` in the same transaction as the completed batch result. | Matching completed drains replay the recorded batch without consuming later signals. Matching pending drains retry; pending identity mismatches fail closed. | `drain_signals` |
| **Ambient** | `ctx.now()`, `ctx.random()`, `ctx.sleep()`. | Generate/record once. | Replay the recorded value (`sleep`: already-elapsed if the wake time passed). | `ambient` |

Plain code *between* `ctx.*` calls (loops, `if`, dedupe logic) is not journaled.
It re-runs on every resume; because the `ctx.*` calls it interleaves
short-circuit, re-running it is milliseconds and correct. The 106-minute,
111-agent body re-runs top-to-bottom on resume — the 111 journaled transcripts
replay instantly, and no agent re-fires.

`ctx.command` is a host-side workflow effect, not a provider tool. It runs as the
daemon user in a required `WorkspaceHandle` plus relative `cwd`, never in the
daemon cwd. Command identity includes the normalized invocation, workspace id
and identity hash, cwd, resolved capabilities, explicit environment policy,
timeouts, output caps, success codes, failure mode, runner version, SDK ABI, and
author bump. Raw secret values, stdout/stderr, exit status, timestamps, process
ids, and observed filesystem state are excluded from identity. Completed
terminal process failures are stored as `CommandResult` values so
`failureMode: "throw"` can replay the same `CommandFailure` without spawning.
If a daemon crash leaves a pending command row, resume may run the process again
in the same workspace; filesystem and external side effects are not rolled back.

Workspace setup is a lifecycle phase on explicit `ctx.workspace` calls. It uses
the same bounded local process runner as `ctx.command`, but setup output is
diagnostic state rather than workflow data. The workspace row stores setup
identity, status, timestamps, and failure JSON. Individual setup command attempts
are journaled as `workspace_setup` rows and emit `workspace.setup.*` events.
Setup identity includes the base workspace identity, SDK ABI, setup
capabilities, ordered commands, cwd, environment names/vars, timeouts, output
caps, and success exit codes. A prepared `WorkspaceHandle` exposes
`setupIdentityHash`, and later agent/session/command identity includes it when
present.

`ctx.completionCheck` is the same durable-effect boundary for reusable
implement/review completion gates. The host effect reads the persisted workspace
row, including generated-worktree base commit and checkout branch metadata, so
`has-commits` and `branch-pushed` do not reconstruct durable workspace state
from shell output. Failed owned-worktree checks mark `failureSeen` for
`retain-on-failure` cleanup semantics.

### 5.2 Step identity & structural versioning

A step is identified by **`(stableKey, inputHash, version)`**.

- **`stableKey`** — author-controlled, stable across resumes. Static steps use a
  literal (`"dedupe"`, `"synthesize"`); fan-out steps derive it from a
  **content-derived id**, never an array index:
  `ctx.stepKey("verify", `${f.file}|${norm(f.title)}`)` — the same key the
  workload already computes for dedupe.

- **`inputHash`** — SHA-256 over the step's inputs, where prior-step outputs
  contribute their **content hash** (for large outputs, the hash of the artifact
  *reference* — §8.2), never the raw blob. See §5.3 for how inputs are
  identified.

- **`version`** — a **structural definition hash**, not raw source text:
  `hash(structuralSchemaHash(outputSchema) + specHash + declaredCapabilities +
  optionalAuthorBump)`, where `specHash` is:
  - for **agent steps**: the hash of the resolved prompt template (prompt text is
    data — directly hashable);
  - for **pure steps**: the hash of the step `fn`'s **bundled-and-minified
    source** — the fn is bundled as its own entry point (so transitively
    referenced local helpers like `dedupeByFileAndTitle` fold in), then
    deterministically minified (comments, whitespace, and consistent renames
    vanish; logic changes — including helper-body changes — survive). This makes
    "edit a comment, nothing re-runs / edit the logic, the step re-runs"
    implementable, closing v1's undefined `normalizedSpec`. *(Phase 5
    deliverable; bundler + minifier versions pinned and stability-tested.)*

### 5.3 Step inputs — explicit, hashed by value

v1 left two holes here: `ctx.step`'s zero-argument closure gave the kernel
nothing to hash, and a "no closure capture" rule that would have rejected the
flagship example (`() => dedupeByFileAndTitle(raw)` captures `raw`). v2 closes
both by making inputs explicit:

```ts
step<T, I extends Json>(key: string, schema: Schema<T>, inputs: I,
                        fn: (inputs: I) => T | Promise<T>): Promise<T>;
```

- `inputs` is a JSON-serializable value; `fn` receives it and **may not capture
  data from outer scope** (module-scope helper *functions* are fine — their
  source folds into the version's `specHash`, §5.2; data must flow through
  `inputs`). Lint-enforced, with an actionable error message.
- `inputHash = sha256(canonicalJson(inputs))`, where any embedded step-result
  envelope contributes its recorded `contentHash` and any artifact-backed value
  contributes its ref hash — never raw blobs.
- For `ctx.agent`, the inputs are the spec itself: the **resolved prompt
  string**, schema structural hash, capabilities, provider, model, workspace id,
  normalized environment, and selected provider config when present. Unselected provider
  config is validated but omitted from identity and invocation; no
  `providerConfig` key is added when no selected config exists. Whatever
  upstream data matters is already interpolated into the prompt — so the hash
  captures exactly the influence that matters, and nothing else.
- The realm acceptance test proves the distinction: explicit inputs hash and
  journal correctly; outer-scope data capture is rejected with guidance.

### 5.4 Invalidation — value hashes, not a tracked graph (D3 resolved)

v1 specified field-level `Proxy` read-capture to derive the dataflow DAG. That
mechanism cannot survive the Worker realm's JSON boundary, and it dies silently
on everyday code — `{...finding}` spreads and string interpolation into prompts
destroy the tracking wrapper exactly where workflows do real work. v2 drops it
entirely. **Correctness comes from value hashing plus the resume re-run
itself:**

- On resume (or source override), the body re-runs; plain code recomputes from
  replayed results. When execution reaches a step, the kernel recomputes its
  `inputHash` from the *current* input values (§5.3) and compares it to the
  journal: match → replay; mismatch → re-execute as a new attempt. **The body
  re-run is the cascade** — no dependency graph is needed for correctness, and
  dynamic fan-out (verifier count = deduped finding count) is handled by
  construction.
- This gives **early cutoff** for free (the Bazel/Nix property — stronger than
  v1's edge-cascade): edit the dedupe logic and resume — dedupe re-executes,
  but if its output is byte-identical, every verifier's prompt is unchanged and
  all 90 replay. v1's graph cascade would have re-run all of them.
- **Dataflow edges for the UI graph and time travel** are recorded best-effort:
  step results return in tagged envelopes `{stepKey, contentHash}`; when a tag
  appears inside another step's inputs during hashing, the edge is journaled as
  `inputDependencies`. Derived values lose the tag — acceptable, because
  correctness never depends on edges, only on value hashes. An explicit
  `{deps: [...]}` option remains for authors who want declared edges.
- **Fan-out key-set drift — subsumed by content-derived keys.** Because fan-out
  keys are content-derived (`ctx.stepKey("verify", findingId)`), a drifted
  upstream simply re-keys the fan-out: genuinely-new children execute,
  unchanged children replay (their key + input are unchanged), and removed
  children are never looked up — they remain in the journal as history. The
  aggregating consumer's input array changes, so it re-executes by value hash.
  There is therefore **no positional mis-alignment to defend against and no
  separate whole-batch invalidation** — value hashing over content keys is
  strictly more precise than v1's keySetHash-and-invalidate-the-batch. The
  `key_set_hash` column stays reserved for optional drift *observability*, not
  correctness. *(Resolved this way during implementation; supersedes v1's
  whole-batch wording.)*

### 5.5 Crash consistency — the write-ahead protocol

Every effectful step:

```
1. Commit journal row { status:'pending', stableKey, inputHash, version,
                        attempt, effect_type }            (fsync / ACID)
2. Execute the effect.
3. Commit { result, status:'completed' }  — or { error, status:'failed' }.
```

On resume: `completed` → replay (*exactly-once result*); `pending` → the process
died mid-effect → re-execute (*at-least-once*). Contract, stated plainly: **pure
steps must be deterministic; agent calls must be idempotent or carry an external
dedup key.** Re-asking a model is harmless; agents that opt into workspace
isolation write into fresh worktrees (§11.3), while non-isolated side effects
must be safe to re-drive or externally deduped. Mid-call recovery for long agent
calls: §10.4.

User-requested `interrupt` is a durable crash-like boundary with a visible parked
status. Keel first commits `runs.status = 'interrupted'` plus `run.interrupted`,
then aborts active workers/providers. Late work from that abandoned execution is
fenced by the active-execution abort state and must not convert pending rows to
failed rows, append final agent transcripts, or overwrite the interrupted status.
Rows completed before the interrupt commit remain completed; rows still pending
re-execute or recover when the user explicitly resumes.

**Supersession (closing a v1 gap).** The journal PK is
`(runId, stableKey, attempt)`. Memoization lookup reads the **highest attempt**
for a `stableKey`: if its `(inputHash, version)` match and status is
`completed` → replay; on mismatch or invalidation, execution proceeds as
`attempt + 1` and the prior row remains as auditable history (time travel reads
it; nothing ever rewrites it).

### 5.6 Resume, in full

```
resume(runId):
  load run row; verify resumable (status not terminal; interrupted is resumable)
  load the archived definition for the run's pinned definitionVersion
  re-execute the body in the deterministic realm, where every ctx.* call:
    - looks up its journal row by (stableKey, inputHash, version), highest attempt
    - pure      + completed + hashes match   -> return persisted result
    - effectful + completed                  -> return persisted result (never re-run)
    - ambient   + recorded                   -> return recorded value
    - pending (effectful)                    -> re-execute under write-ahead
    - missing / invalidated / hash mismatch  -> execute fresh as a new attempt
  on return or park (human/signal/timer) commit terminal/waiting state
```

There is no separate replayer. Resume *is* re-running the function with a
memoizing `ctx` — the DBOS/Durable-Functions model.

## 6. Determinism enforcement (the realm)

The body must be deterministic so resume reaches the same `ctx.*` calls in the
same order. Three enforced layers, all present from the first kernel phase:

1. **Static lint (typecheck-time).** Rejects `Date.now`, arg-less `new Date()`,
   `Math.random`, `crypto.randomUUID`, `fs.*`, `http`/`fetch`, `child_process`,
   `eval`, `Function`, bare `require` inside workflow bodies and pure-step fns.
   The realm-scoped `ctx` types make `Date`/`Math.random` resolve to `never`.
2. **Runtime isolation.** The body and step fns execute in a **Bun Worker
   thread** — input as JSON, output as JSON, no ambient fs/net/clock/random.
   (`vm.runInNewContext` rejected: documented escapes via `globalThis`,
   `Function`, `Reflect`, prototype walks — exactly the
   correctness-by-convention failure Keel exists to eliminate.)
3. **Sealed `ctx`.** Only whitelisted `ctx.*` methods cross the boundary; all are
   journaled. `ctx.now()`/`ctx.random()` are the *only* time/entropy sources.

**Error-first DX.** A **Deterministic Realm Reference** (shipped alongside the
realm, Phase 4–5) lists every allowed/forbidden global and the exact error text
per violation — e.g. touching `fs` throws *"Filesystem access is not allowed in
workflow code. Read files inside a ctx.step() or ctx.agent()."* — never an
opaque `undefined is not a function`.

**Acceptance trio:** (a) illegal capture rejected at init with guidance, legal
input capture journaled (§5.3); (b) `Math.random`/`Date.now` unreachable, only
`ctx.random`/`ctx.now` exist and are journaled; (c) `fs`/`http`/`child_process`
throw the guidance error.

*The stack is **Bun** for daemon, CLI, and realm host (locked — §17 L7). The
v1 spec never named its runtime; v2 anchors realm mechanics, spawn-cost numbers
(~2–5 ms/step Worker spawn), and transpilation (Bun-native TS) to Bun
explicitly. Whether Bun Workers seal ambient globals tightly enough is verified
by the Phase 4 acceptance tests, not assumed.*

## 7. Daemon & client architecture

### 7.1 Single-writer daemon

The kernel is a **daemon — not a library, not multi-worker.** It owns the
journal write path (the property that makes SQLite-WAL safe), the artifact
store, the scheduler/timers/supervisor, the realm host, and the canonical
projection + event stream. CLI, web UI, MCP server, and SDK are **thin clients**
over one RPC contract (local socket / HTTP+WS). Fan-out agent results funnel via
RPC into an in-memory queue the daemon drains sequentially (~1 ms/write × ~1000
writes ≈ 1 s — negligible against 106 minutes).

```
   CLI ──┐  web UI ──┐  MCP ──┐  SDK ──┐
         └──── one RPC contract (socket / HTTP+WS) ────┐
                                                       v
                          ┌────────── Keel daemon ──────────┐
                          │ scheduler · timers · supervisor │
                          │ realm host (Bun Workers)        │
                          │ operation gateway · auth        │
                          │ canonical projection · events   │
                          │ capability resolver · diff gate │
                          └───┬─────────────┬────────────┬──┘
                              v             v            v
                        journal store  artifact store  workspaces
                       (SQLite-WAL/PG) (content-addr)  (git worktrees)
```

Transport adapters are intentionally thin. The local Unix socket owns socket
binding, JSON-line framing, connection-scoped `authenticate`, and connection
cleanup; the local HTTP/SSE web transport owns only HTTP routing, static assets,
bearer-header extraction, SSE framing, heartbeats, and browser projection
wrapping. All daemon operations that read or mutate durable state route through
`KeelOperationGateway`, which centralizes method dispatch, capability
authorization, run ownership claims, launch/fork capability issuance,
approval/signal wakeups, event redaction, long-lived authorization rechecks, and
subscription cleanup. The gateway also receives a transport surface marker for
policy differences such as web `launchRun` requiring admin while trusted local
Unix-socket launch remains open. This keeps transports from becoming independent
authorization boundaries.

**The daemon — never the CLI — spawns agent subprocesses.** The CLI sends one
RPC and exits; the daemon hosts the realm, spawns the agent, holds its handle,
captures the session id, and journals it. This is what makes session capture and
crash-resume a local daemon operation (§17 L4).

### 7.2 Embedded in-process mode

A daemon-in-library mode serves tests and single-shot runs — speaking the
**same RPC contract** over an in-process transport, so library mode and daemon
mode can never diverge.

### 7.3 RPC contract timing (revised from v1)

v1 froze the wire contract at P0 — before any effect, parking, or approval shape
existed, which risks freezing the wrong contract. v2 freezes it **after the
effect shapes exist and before daemon extraction** (Phase 11): the contract is
designed against real `launchRun`/`resumeRun`/`interruptRun`/`getRun`/event-subscription needs
demonstrated by the mock-scale review workload, then the daemon extraction (Phase 12)
is a transport swap, not a redesign — the property v1 actually wanted.

### 7.4 Daemon crash recovery

The journal is the source of truth, not daemon memory. On restart the daemon
rebuilds run state from the journal and resumes incomplete `running` runs.
Operator-interrupted runs are parked with public status `interrupted` and are
not reclaimed by restart recovery, timer supervision, signal delivery, or
approval delivery; only explicit `resume` moves them back to `running`. Run
ownership uses a compare-and-set fence on `runtimeOwnerId` so a restarted daemon
and a stale one cannot both drive one run.

### 7.5 Definition pinning & the edit-and-resume flow

A run pins the **archived definition** it started with; a run paused for days
resumes against it even if the source changed — a paused approval can never
resume into code the human didn't approve. Re-running against changed source is
an explicit `rerun` source override, which snapshots the supplied source as a
new `definitionVersion` and lets structural versioning (§5.2) compute which
steps are invalidated.

**Definitions register at launch.** `launchRun` accepts client-captured workflow
source: either an inline single module or a source bundle whose entry and local
helper modules were captured by the client. The daemon validates module paths,
reachability, import boundaries, lint results, runtime ABI metadata, and then
archives the canonical bundle content-addressed as the run's pinned
`definitionVersion` — there is no separate deploy step. The daemon never opens a
client workflow path. Materialization writes only the persisted bundle into the
definition cache, so deleting or editing original workflow/helper files cannot
change resume, retry, rewind, fork, or schedule fire behavior. Load-bearing for
L22: the common author is an agent submitting a just-written workflow in one
call, exactly the Claude Workflow tool's submit-script-and-run shape.

## 8. Persistence

### 8.1 Journal store

**SQLite-WAL is the backend** (stable path `~/.keel/keel.db`), for solo *and*
team-internal use — the single-writer daemon is the only process touching the
file, and every client (including colleagues on other machines) goes through
the daemon's RPC, never the DB. The **schema stays Postgres-compatible** as
cheap discipline (no SQLite-only types or tricks in the DDL), so a Postgres
swap remains available on demand — but no Postgres implementation is in the
pipeline (L17). Direct multi-process file access is forbidden.

Core tables (DDL in Appendix A): `runs`, `journal`, `artifacts`, `events`
(append-only audit + projection source), `approvals`, `signals`, `timers`.
The `events` table stores durable lifecycle, narration, and message-granular
agent transcript rows; it is not the live token bus.
Optional typed per-schema output tables (`step_outputs_*`, registered by
structural hash) are a **deferred** feature (§14) — the DDL reserves the naming
convention only. `runs.tenant_id` stays as one nullable reserved column (cheap
insurance); everything else multi-tenant is out of scope (**L17**).

### 8.2 Artifact store

Two-tier: outputs ≤ 1 KB inline in the journal row; > 1 KB content-addressed in
`artifacts` (`hash → blob`), referenced from the row. Transactional write: temp
location → journal row committed referencing it → atomic finalize; a crash
leaves a committed row with its artifact, or nothing. `inputHash` hashes the
*reference*, never the blob. Refcount GC (30-day default retention, never
collecting artifacts referenced by non-terminal runs) is deferred to Phase 19.

### 8.3 Durability beyond session files

The SQLite journal at a stable path survives terminal exits and reboots; any
client reaches it through the daemon. Team-internal: one shared daemon host —
a run authored from machine A is observable and resumable from machine B by
pointing a client at the same daemon with the run capability or an admin
capability. The session-scoped JSON of the Claude runtime becomes an *export
view*, not storage.

### 8.4 Workflow definition snapshots

Launch stores an immutable workflow definition snapshot in
`workflow_definitions`, keyed by a `wf_sha256_...` content hash. The run row uses
`runs.definition_version` for that hash and keeps `runs.workflow_ref` only as
provenance. The daemon materializes definitions from the DB into a cache for Bun
import; the cache is not the source of truth.

Saved workflows are a durable naming layer over these immutable definitions:
`name@version` rows store metadata and a pointer to one definition hash. Launch
and schedule creation resolve the saved ref to a concrete hash before inserting
durable state, so later saves do not mutate existing runs or schedules.

Client-captured workflow v1 is intentionally single-file. The only external
import allowed in workflow source is the exact SDK specifier `@kcosr/keel`,
linked from the daemon's installed package during materialization. That SDK is a
runtime-provided bridge guarded by `runtime.workflowSdkAbi` in the definition
manifest, not a byte-for-byte package-tree pin. Compatible Keel upgrades can
resume old definitions when the daemon supports the stored workflow SDK ABI; an
unsupported ABI is a deterministic pre-execution failure. Relative imports, SDK
subpaths, arbitrary packages, dynamic imports, and capability/nondeterministic
imports are rejected by the snapshot/lint boundary. Resume/retry/rewind/fork use
the stored definition. Rerun with a source override creates a new snapshot
intentionally.

The materialized `definitions/<hash>/` tree is a rebuildable cache, not durable
state. It is written through a temp directory and atomic rename so a concurrent
resume never imports a half-written tree. Materialization validates the workflow
SDK ABI and ensures the `@kcosr/keel` link targets the current package root
before execution. Definition-row GC prunes only old rows unreferenced by any run
and by any enabled schedule; cache eviction skips hashes used by running or
parked runs.

### 8.5 Run capabilities

Run id is an identifier, not authority. Launch mints a broad run capability for
that run; daemon methods authorize against bearer capabilities stored only as
hashes in the `capabilities` table. The default run capability covers normal
run lifecycle operations: read, watch/events, output, resume, interrupt, retry,
rewind, fork, and ordinary signal. `ctx.human` approve/deny and daemon-wide list require
an admin capability (`{ kind: "daemon" }`, action `admin`).

The CLI writes run capabilities into private cap files by default and returns
capability references. Raw capabilities are emitted only through explicit
opt-in such as `--emit-capability`.

## 9. The authoring surface

**Agents are the primary authors (L22).** Most workflows will be written by an
agent at run time — the way an assistant authors a Claude Workflow script on
request — and submitted inline via `launchRun` (§7.5). This makes three things
requirements rather than niceties: the `ctx` surface stays small and
JSON-native (reliably generatable by a model), schemas are accepted as raw JSON
Schema (§9.3), and every realm violation returns actionable guidance an agent
can self-correct from (§6).

### 9.0 Operator control surface

`keel execute` is a stateless TypeScript control surface over the daemon API.
It runs outside the deterministic workflow realm, receives injected `keel`,
`args`, `state`, and `env`, and writes only its returned JSON value to stdout.
It is useful for short launch/resume/wait/inspect loops and output shaping.
The tracked control-surface convention and CLI interaction matrix live in
`docs/control-surfaces.md`.

`execute` is not a durable workflow engine: it does not pause and resume its own
stack, and its `--state` input is only an ephemeral convenience for non-secret
handles. Durable pauses remain workflow features (`ctx.sleep`, `ctx.signal`,
`ctx.human`). Saved workflows/tasks and durable child-workflow orchestration are
deferred until the registry/`ctx.spawn` design is implemented.

### 9.1 The `ctx` API (fixed, typed, non-overloaded)

```ts
type Workflow<I, O> = (ctx: Ctx, input: I) => Promise<O>;

// As-built (src/kernel/ctx.ts). The original v2 sketch differed; this matches code.
interface Ctx {
  readonly run: { readonly id: string; readonly target: string };

  workspace(spec: WorkspaceSpec): Promise<WorkspaceHandle>;
  withWorkspace<T>(specOrHandle: WorkspaceSpec | WorkspaceHandle, fn: () => Promise<T>): Promise<T>;

  // Pure, memoized, re-derivable. fn deterministic in its explicit inputs (§5.3).
  step<T, I>(key: string, schema: Schema<T>, inputs: I,
             fn: (inputs: I) => T | Promise<T>, opts?: StepOpts): Promise<T>;

  // Effectful: the real work. Journaled; completed results never re-run.
  agent<T>(spec: AgentSpec<T>): Promise<T>;

  agentSession(spec: AgentSessionSpec): AgentSession;

  // Durable ordered progress; awaits journal + event persistence and never parks.
  checkpoint(spec: { key: string; message: string; data?: Json }): Promise<void>;

  // Non-parking consumption of all currently pending signals under one name.
  drainSignals<T = unknown>(key: string, name: string): Promise<T[]>;

  // Journaled non-determinism — the ONLY time/entropy in realm scope.
  now(): number;
  random(): number;

  // Durable timer; survives reboot. `key` is a stable author identity (timer id
  // is `${key}#${ms}`), so reordering/inserting sleeps never reattaches a
  // persisted timer to the wrong site.
  sleep(key: string, ms: number): Promise<void>;

  // Durable human pause; run parks waiting-human until a decision is delivered.
  human(spec: { key: string; prompt: string; requestedCaps?: Partial<Capabilities> })
    : Promise<{ status: 'approved' | 'denied'; note: string | null; grantedCaps: unknown }>;

  // Durable wait for a named external event; Nth call consumes the Nth signal.
  // Use a signal name with either signal or drainSignals, not both.
  signal<T = unknown>(name: string): Promise<T>;

  // Seal & restart an unbounded run with new input (atomic handoff + lineage).
  continueAsNew(input: unknown): Promise<never>;

  // Stable fan-out key from a semantic name + content-derived id.
  stepKey(semanticName: string, stableId: string): string;

  // Narration (persisted to the event log; advisory).
  log(message: string, data?: Json): void;
  phase(title: string): void;

  // NOTE: ctx.spawn (durable sub-workflows) is deferred — see §14, not yet built.
}

interface AgentSpec<T> {
  key: string;                      // stable step key (use ctx.stepKey for fan-out)
  provider?: string;                // 'pi' (default, v0) | 'claude' | ...
  providerConfig?: Record<string, { [key: string]: Json }>;
  prompt: string;
  schema?: Schema<T>;               // Zod or raw JSON Schema (§9.3), enforced (§10.3)
  model?: string;
  onFailure?: 'throw' | 'null';     // fan-out partial-failure policy — ⚠ DECIDE D7
  toolPolicy?: 'none' | 'read-only' | 'workspace-write' | 'unrestricted';
  allowTools?: string[];            // provider-native additions on top of toolPolicy
  denyTools?: string[];             // provider-native removals from the final allowlist
  workspace?: WorkspaceHandle;      // explicit cwd/lifecycle handle; defaults scoped/direct
  capabilities?: Capabilities;      // §11.1; used when toolPolicy is omitted
  environment?: {
    vars?: Record<string, string>;  // literal non-secret provider env
    secrets?: string[];             // secret names resolved from run side channel
  };
  // note: no memo mode — agents are always memoized (L18); re-think is
  // expressed via retry(stableKey), rerun with a source override, or iteration loops
}
```

**Conventions (settled in v2):** `ctx.step` takes its key positionally (it has
exactly three parameters); `ctx.agent` carries `key` in its option bag.
`toolPolicy` is the public shorthand over the capability enum; `allowTools` and
`denyTools` are provider-native adjustments when a workflow intentionally needs
to add or remove a specific backend tool. Those adjustment lists use exact
provider-native names; known built-in aliases and case variants reject instead of
normalizing to a broader backend tool, while unknown custom provider-native names
pass through unchanged. Workspace selection is explicit via
`ctx.workspace` handles, scoped with `ctx.withWorkspace`, or defaults to the run
`__default` direct workspace at `ctx.run.target`; the resolved workspace id
participates in agent identity. `providerConfig` is provider-owned JSON config,
not a cwd/workspace/secret mechanism; an explicit selected provider object
replaces profile config as a unit and is deep-cloned/frozen before adapter use.
If both `toolPolicy` and `capabilities` are set,
`toolPolicy` controls provider tools. `toolPolicy:'unrestricted'` cannot be combined with
`allowTools` or `denyTools` until provider-native deny semantics are supported.

**One step model.** Fan-out is plain `Promise.all(items.map(...))` — exactly how
the review workload already reads. There are **no** `ctx.parallel` / `ctx.loop`
effect types and no sugar wrappers (cut — §14): extra surface creates
overlapping dataflow mechanisms.

**Memoization policy.** Agents are **`memoized`** — replay the first transcript
on resume; the review workload forces this (otherwise resume re-fires 110 agents).
v1's `ttl`/`validator` modes are **cut**: a "pure" step whose output
legitimately drifts is reading external state the realm forbids — that's an
agent or an input, not a pure step.

> **Resolved (L18, formerly D4): agents are memoized, period.** There is no
> `memo:'never'` mode. Every legitimate "the agent should re-think" case has a
> sharper mechanism: data interpolated into the prompt re-triggers via
> `inputHash` automatically; world-drift the prompt can't see (an agent reading
> files via tools) is an operator judgment expressed once via
> `retry(stableKey)` or `rerun with a source override`; genuine re-polling is a loop
> with iteration-distinct `stepKey`s. A standing re-think mode would fire on
> every crash-recovery resume — exactly when it must not — and cascade-
> invalidate the step's downstream cone through the value hashes.

### 9.2 The binding example (single canonical version)

This is the ergonomics acceptance test: if the port is longer or less clear than
the original ~140 lines, the API is wrong. (v1 carried two divergent versions —
the spec's, with the stricter verdict filter and stats, is canonical; the HTML
variant is retired.)

```ts
import { z } from "zod";
import { domains, lenses } from "./review-config";

const Findings = z.object({ findings: z.array(z.object({
  title: z.string(), category: z.enum(["bug","security","smell","perf"]),
  severity: z.enum(["critical","high","medium","low","info"]),
  file: z.string(), line: z.string(), description: z.string(),
  evidence: z.string(), recommendation: z.string(),
})) });
const Verdict = z.object({
  isReal: z.boolean(), verdict: z.enum(["confirmed","uncertain","rejected"]),
  adjustedSeverity: z.enum(["critical","high","medium","low","info"]),
  reasoning: z.string() });
const Report = z.string();

export default async function review(ctx, { root }) {
  ctx.phase("Review");
  // Fan-out: 13 subsystem reviewers + 7 cross-cutting lenses — effectful agents.
  const finders = [
    ...domains.map(d => ctx.agent({ key: ctx.stepKey("review", d.label),
      prompt: domainPrompt(d, root), schema: Findings, toolPolicy: "read-only" })),
    ...lenses.map(l => ctx.agent({ key: ctx.stepKey("lens", l.label),
      prompt: l.prompt, schema: Findings, toolPolicy: "read-only" })),
  ];
  const raw = (await Promise.all(finders)).flatMap(r => r.findings);

  // Journaled pure step — memoized; body edits don't invalidate it (structural
  // version, §5.2); `raw` is its explicit, hashed input (§5.3).
  const deduped = await ctx.step("dedupe", Findings, { raw },
    ({ raw }) => dedupeByFileAndTitle(raw));

  ctx.phase("Verify");
  // Fan-out keyed by content-derived dedupe id → stable across resume.
  const verified = await Promise.all(deduped.findings.map(f =>
    ctx.agent({ key: ctx.stepKey("verify", `${f.file}|${norm(f.title)}`),
      prompt: verifyPrompt(f, root), schema: Verdict, toolPolicy: "read-only" })
      .then(v => ({ ...f, verdict: v }))));

  const confirmed = verified
    .filter(f => f.verdict.isReal && f.verdict.verdict !== "rejected")
    .sort(bySeverity);

  ctx.phase("Synthesize");
  const summary = await ctx.agent({ key: "synthesize",
    prompt: synthPrompt(confirmed), schema: Report });

  return { summary, confirmed,
           stats: { raw: raw.length, confirmed: confirmed.length } };
}
```

Crash at verifier 90 and resume: the body re-runs, 20 finders + 89 verifiers
replay from the journal in milliseconds, execution continues at verifier 90.
Edit `synthPrompt` and `rerun with a source override`: only `synthesize`'s `version`
changes; 110 agents replay, one re-runs.

### 9.3 Schemas

Schemas may be authored as **Zod or plain JSON Schema**. Agent authors emit JSON
Schema natively, so both are first-class. Zod is the primary TS-facing mechanism,
exported to
**JSON Schema** for the wire format, CLI, and cross-language agents. A schema's **structural hash** is
`sha256(canonicalize(zodShape))` — identical validation logic hashes identically
regardless of authoring style; a schema round-trips through JSON to the same
hash (unit-tested). Output identity is keyed by structural hash, **never JS
object identity**.

## 10. Agent adapters

### 10.1 One contract

`AgentLike.generate()` is the single adapter boundary: spawn the vendor CLI/SDK,
apply capabilities, consume only the selected provider's immutable
`providerConfig` when present, parse the stream, enforce the output schema,
capture transcript + session token, return the result for journaling. Adding a provider =
implementing this interface.

### 10.2 Pi, Claude, and Codex providers

Keel supports daemon-owned provider subprocesses behind one adapter boundary.
The bundled CLI wires Pi, Claude, and Codex; tests also use the deterministic
mock provider.

**The old Pi mechanism is superseded.** Current Pi provider behavior has these
load-bearing properties:

| Point | Old claim | Audited reality |
|---|---|---|
| Drive mode | one-shot CLI, JSON/event flags | long-lived **`pi --mode rpc`** process; commands as JSON-RPC over stdin |
| Session id | read from `payload.id` on an early stream event | returned **synchronously** by a `get_state` RPC right after spawn, *before* the prompt is sent (`stateResponse.data.sessionId`) |
| Resume | `pi --resume --session <id>` | **`--session <id>` at spawn**; no `--resume` flag; semantics = *continue the conversation* |
| Session TTL | ~24 h stale-token branch | **none** — session JSONL persists indefinitely; one-shot `ctx.agent` crash recovery can detect resume failure via stderr ("session not found") and re-execute fresh |
| Disk state | `--session-dir` per step | Pi-managed `$PI_HOME/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl`, header `{type:"session", cwd}` |
| Tool restriction | `noTools` | **neither integration restricts Pi tools** — verify a tools flag against Pi source; until then the OS-sandbox backstop (Phase 15) is the only enforcement |
| Structured output | — | no native schema support visible; Keel's prompt-injected schema + bounded in-session retry is the mechanism |

**Keel's Pi adapter call sequence:**

```
journal { status:'pending' }                                  -- commit
spawn  pi --mode rpc --no-themes [--model m] [--session <id>] -- resume path
rpc    get_state  -> sessionId
journal { session_token: sessionId }                          -- commit (write-ahead)
rpc    prompt { message }                                     -- the step prompt
stream message_* / tool_execution_* / agent_end               -- transcript capture
on agent_end: validate schema (bounded retry by re-prompting in-session)
journal { result, status:'completed' }                        -- commit
```

Because the id arrives synchronously before any work starts, **write-ahead
token capture is deterministic** — the pending-without-token window shrinks to
the spawn→`get_state` gap, and v1's "the stream parser must surface the id
event distinctly" ordering requirement disappears.

**The integration target is the Pi CLI itself** — Keel's daemon spawns and owns
one `pi --mode rpc` subprocess per agent call. Pi mechanics are captured in the
provider implementation and tests, not in vendored reference artifacts.

**Codex targets app-server JSON-RPC**, not a one-shot CLI JSONL mode. The Codex
adapter can own a local stdio `codex app-server` subprocess or connect to a
remote WebSocket / WebSocket-over-UDS app-server selected by
`providerConfig.codex.transport`. Optional `providerConfig.codex.serviceTier`
is part of the selected provider config and therefore replay identity: omitted
leaves Codex defaults in control, `"fast"` requests priority service, and
`"normal"` forces standard routing. Codex thread ids are the session tokens. The
capability mapping is intentionally fail-closed and dispatches on exact resolved
capability shape, not only the `toolPolicy` label: `{ fs:'read', shell:false,
network:'none' }` maps to Codex `read-only`; `{ fs:'workspace-write',
shell:false, network:'none' }` maps to Codex `workspace-write` with the resolved
cwd as the writable root; `{ fs:'workspace-write', shell:true, network:['*'] }`
maps to Codex `danger-full-access`. Codex app-server has no verified no-tools
mapping, so `toolPolicy:'none'`, host network allowlists, shell-without-network,
and provider-native allow/deny tool edits reject instead of widening access.

### 10.3 Structured output

Native structured output for SDK agents; prompt-injected JSON extraction with
**bounded schema-retry** for CLI agents. Validation gates step completion — an
output that fails its schema never enters the journal, so it can never poison a
downstream hash.

Agent stream delivery splits liveness from durability. Provider text/reasoning
and progress deltas are pushed from daemon memory to currently connected
`subscribeEvents` watchers as ephemeral `agent.event` frames and are not
persisted or backfilled. Finalized tool calls and tool results are appended
synchronously as durable `agent.tool_call`/`agent.tool_result` rows as soon as
Keel observes them, with the host journal `attempt` and an optional provider
`toolCallId`. If that append fails, the provider hook fails closed and the agent
operation does not continue with a missing durable audit row. When an agent turn
successfully completes, the daemon persists at most one non-empty `agent.message`
row containing the final assistant answer text used for schema extraction; it no
longer reconstructs interleaved prose from live text deltas. `subscribeEvents`
accepts a request-object cursor, resolves it to a private durable sequence floor,
backfills matching durable rows, then tails pushed durable rows and live
ephemeral frames, so late subscribers see durable tool and final-message rows but
not earlier live deltas. Duplicate-looking tool rows after
retry or recovery remain append-only audit history; replay correctness comes from
the completed journal step result, not transcript rows.

### 10.4 Session capture & mid-call crash recovery

> **Two recovery mechanisms — don't conflate.** A `completed` agent step is
> recovered by **journal replay** (§5.6): the kernel returns the journaled
> structured output; no process spawns; the vendor session is irrelevant. Only
> the **in-flight** call at crash time (`status: 'pending'`) uses **vendor
> session resume** below — reconnecting to the live conversation so the agent
> keeps its accumulated context instead of restarting the task. The replay
> policy (L18) governs the first mechanism; D5 concerns only the second.

A 40-minute `ctx.agent` crashing at minute 39 must not silently restart. On
entry the kernel allocates `(runId, stableKey, attempt)`; the session token is
journaled under the write-ahead row **synchronously from `get_state`, before
the prompt is sent**. On crash:

```
completed row              -> replay result (no respawn)
pending + session_token    -> respawn pi --mode rpc --session <id>; the session
                              JSONL restores the agent's full context (files
                              read, tool calls, partial reasoning); re-prompt
                              the step to continue to a terminal state
pending + no token         -> re-execute fresh (crashed in the spawn→get_state gap)
resume rejected            -> one-shot ctx.agent recovery may re-execute fresh;
                              durable logical agent sessions fail closed instead
```

### 10.5 Durable logical agent sessions

`ctx.agentSession(spec)` creates a realm-only logical participant for workflows
that need multiple durable turns in one backend conversation. A turn is stored as
a normal journal effect under a reserved derived key:

```
__session.<agentKey>.<turnKey>
```

Participant and turn key components are limited to `[A-Za-z0-9_-]+`; ordinary
author keys may not use the `__session.` prefix. The worker resolves profiles,
selected provider config, tool policy, provider-native tool lists, capabilities,
resolved workspace id, and normalized environment before hashing participant identity. The
realm host stores that
hash in `agent_sessions` and rejects drift. Turn identity reuses the journal
row's `(version, input_hash)` for the derived key and is append-only within a
participant.

Session state lives beside the journal:

- `agent_sessions` stores participant identity, the latest completed backend
  session token, and the active turn fence.
- `agent_session_turns` stores per-turn started, observed, and completed tokens.
- `journal.session_token` remains the write-ahead token for the active attempt.

Begin/record/complete/fail update these rows transactionally with the journal
row. A new later turn resumes from `agent_sessions.current_session_token`; a
pending turn resumes from its observed token or the token it started with. If an
interrupt lands after token observation but before completion, the turn remains
pending and explicit resume uses that observed token; there is no fresh-session
fallback for durable sessions. A completed turn replays its journaled output and
does not call the provider. Completing a turn without a token is an error,
because future turns would not be able to continue.

The session path is intentionally fail-closed: providers must declare stable
session support; changing a participant workspace changes identity; and runs
with session rows cannot be rerun, rewound, or forked.
`continueAsNew` starts a fresh run and does
not carry backend session tokens. Provider session-token trace events are
consumed for write-ahead state only and are not persisted in the durable event
stream.

**Vendor resume matrix (one canonical statement, L19):** Pi = designed-in per
the sequence above; Codex = app-server thread id continuity with cwd validation
and active-turn duplicate prevention; Claude = supported when the provider
exposes resume hooks; all other vendors = in-flight calls re-execute fresh on
crash. The asymmetry is accepted — the loss is bounded at one in-flight call.

### 10.6 Deterministic mock provider (core test asset)

A YAML-scripted `AgentLike` implementation (step vocabulary: reasoning / text /
tool_call / wait / error / disconnect) so every kill-and-resume test and the
full 111-agent workload shape run in CI in seconds, for free. The mock's step
vocabulary doubles as the checklist for what the journal event model must
capture. v1 required this in its test strategy but never scheduled it; v2
builds it **before** the first real adapter (Phase 7 vs 10).

## 11. Capability & security model

Trust boundary: orchestration code is **untrusted for side effects** (it runs in
the realm and physically can't reach fs/net); vendor agent CLIs run in the
trusted local development environment with the capabilities the workflow grants;
workspace mode is cwd/lifecycle selection, not a secret or network-exfiltration
boundary; the daemon is trusted (owns journal, secret env
injection, capability resolution). This paragraph is the de-facto threat model;
a standalone threat-model document is not yet written.

### 11.1 Declaration and enforcement

> **As-built (2026-06-11):** capability *enforcement* landed in Phase 15, so the
> "enforcement later" framing below is historical. What is real now: the
> normalized tool policies map to per-vendor tool flags in one place
> (`resolvedToolPolicyToPiArgs`, `resolvedToolPolicyToClaudeArgs`);
> worktree workspaces are explicit handles and fail closed without a run target
> inside a git repository; the diff gate journals review metadata; secrets are resolved
> from the side channel and injected as provider env without requiring workspace
> isolation or redacting agent-visible output; and **capabilities + environment fold
> into both the agent version AND the input hash, identically on the realm and
> in-process paths**. The one remaining hardening is the **OS-sandbox backstop**
> (still unimplemented).
>
> Original text follows for context.

### 11.1 (historical) Declaration now, enforcement later

```ts
type Capabilities = {
  fs: 'none' | 'read' | 'workspace-write';   // default via toolPolicy: 'read-only'
  network: 'none' | string[];                // default 'none'; else allowlist
  shell: boolean;                            // default false
  secrets: string[];                         // default []
};
```

The **declaration** exists from the first kernel phase — it participates in the
step `version` hash and the API surface (`toolPolicy:'read-only'` default). The
**enforcement** machinery (per-vendor mapping + OS-sandbox backstop + isolation
+ diff gate + secrets) lands together in Phase 15 — first of Stage D, per the
L22 workload mix — kept out of the kernel stages so security work
doesn't bury the kernel — the read-only review workload never exercises it.

One adapter layer maps each dimension to vendor enforcement (Claude `--tools`,
Codex `sandbox`, Pi `--tools`/`--no-tools`, …) **plus an OS-sandbox backstop**
for vendors that can't self-enforce. Family-specific enforcement knowledge lives
in one place.

### 11.2 Secrets side-channel and trusted-local outputs

The journal is forever, so raw secret values do not belong in workflow source,
step inputs, or agent configuration. Secrets travel via a side channel keyed by
run id, are resolved by name from `environment.secrets`, injected as provider
environment variables at agent invocation, and wiped on terminal cleanup. A
requested secret name must also be granted in `capabilities.secrets`; missing
values fail the agent step instead of silently injecting an empty environment.
Literal non-secret `environment.vars` participate in replay identity by value.
Agent outputs, streamed events, tool events, diffs, and tolerated-failure errors
are trusted-local workflow data: if an agent emits a secret value, Keel records
it as-is. The side channel keeps secret values out of workflow source and agent
options; it is not an output redaction system.

### 11.3 Run workspaces & the diff gate (plain git — jj dropped)

Server/low-level launch boundaries reject missing or blank run targets instead
of inventing a daemon-cwd fallback. Provider cwd always comes from a run-scoped
workspace row: an explicit `WorkspaceHandle`, the innermost `ctx.withWorkspace`,
or the lazy `__default` direct workspace at `ctx.run.target`.

Direct workspaces point at existing directories, are not owned by Keel, permit
parallel provider invocations, and are hidden from default workspace listings
unless they have operator-actionable metadata. The run target is represented as
the lazy `__default` direct workspace; omitted source paths for path-based modes
derive from that canonical row. Worktree workspaces are Keel-owned git worktrees
under the workspace store, keyed by `(runId, workspaceId)`, checked out from a
resolved source repo/ref, and reused across retries, parks, interrupts, daemon
restarts, and session turns while the run can continue. They are detached by
default; `branch: true` attaches them to a generated `keel/...` branch recorded
in `checkout_branch` with `worktree_checkout_kind = 'branch'`. Copy workspaces
are Keel-owned filesystem snapshots of local
directories, including dirty files but excluding `.git` metadata and storing a
second hidden baseline snapshot for diff/merge. Clone workspaces are Keel-owned
git clones from explicit local paths, `file://` URLs, or remote git URLs; clone
never infers a source from `ctx.run.target`. Only one provider invocation may
actively use a Keel-owned workspace at a time; durable `active_holder_*` row
fields fail concurrent use closed and are cleared on every provider end path or
startup recovery.

Terminal cleanup evaluates Keel-owned workspace retention: `remove`,
`retain-on-failure`, or `retain`. Direct workspaces are never removed, diffed,
merged, discarded, or GC'd by Keel. Changes are never auto-merged; operator
merge/discard/GC commands act on retained workspaces by `(runId, workspaceId)`.
Worktree and supported local-clone merge apply final-tree git patches relative
to `baseCommit`, including commits made inside the workspace plus dirty state.
This does not preserve workspace commits as commits. Copy merge compares
workspace state to the copy baseline and writes back only if affected source
paths still match that baseline. Generated worktree branches are intentionally
not deleted by terminal cleanup, discard, or GC in this release. Remote clone and
local bare clone merge are unsupported because this design does not add push
credentials, branch gates, or commit-preserving merge semantics. Durable agent
sessions fail closed if their
Keel-owned workspace was removed before retry/resume; workflows that need
terminal failed session runs to be retryable should use `retain-on-failure` or
`retain`. These workspaces are trusted-local cwd/lifecycle conveniences, not
filesystem or network sandboxes; provider tools may still access outside cwd
according to host/tool behavior, and retained files may contain secrets. The VCS
lives behind an interface — git worktrees/clones now; jj or container overlays
swappable later (§17 L9).

### 11.4 Approval as a first-class dataflow node

Approval is explicit workflow control (`ctx.human`) and future diff-review merge
control, not an automatic preflight for every write/shell-capable agent in the
trusted-local model. When a workflow asks for approval, the run parks
`waiting-approval` and the journaled decision replays deterministically on
resume; stale/revoked decisions are re-requested.

## 12. Observability & liveness

### 12.1 One canonical projection

A single `RunProjection` is the only run-state read model, served behind one RPC
gateway — web, CLI, and MCP all call `getRun(runId)`; no surface reconstructs
state independently. It is a materialized view over the append-only event log,
refreshed incrementally, with
**golden contract tests** asserting all surfaces return byte-identical
projections.

```ts
type RunProjection = {
  runId; status; definitionVersion; createdAtMs; finishedAtMs?;
  parentRunId?;
  nodes: NodeView[];          // journaled effects; includes durable startedAtMs
  phase?;
  error?;
  stats: { steps; agents; artifacts };
};
```

The run graph is **derived, not declared**: nodes are journaled `ctx.*` calls,
edges the recorded `inputDependencies`. A pre-run **dry-run preview** (stubbed
executors; under-counts dynamic fan-out *by construction* and says so) is a
deferred authoring aid (§14).

### 12.2 Liveness: owner heartbeats, timeouts, stall-retry (core, not polish)

Daemon-owned running rows carry `runtime_owner_id` plus `heartbeat_at_ms`; daemon
ownership recovery, workspace reconciliation, and blockage projection all use the
same owner-stale window derived from the daemon heartbeat interval. The
`stalled_no_heartbeat` blockage reason is reserved for a non-terminal run whose
daemon owner heartbeat is stale or missing. It is not inferred from pending step
age. Unowned in-process runs are reported as diagnostic `running`, not stale.

Agent provider attempts still use per-attempt timeouts and stall-retry. A
provider that exceeds its configured timeout fails with `StepTimeoutError` and
can retry according to the agent policy; slow but healthy provider work remains
visible through durable node `startedAtMs`, which renderers can use to derive
pending age without treating it as a daemon-owner failure.

Daemon-owned agent calls also pass through an in-memory operational concurrency
limiter before provider execution. `agent.maxConcurrentTotal` and
`agent.maxConcurrentByProvider` are daemon-operational settings read at daemon
startup; they do not enter workflow identity or run setting snapshots. A queued
`ctx.agent` call or `ctx.agentSession().turn` keeps the run `running`, waits for
capacity without consuming the agent stall timeout, and resumes automatically
when a permit is released. The queue is not durable: after daemon restart,
normal replay reaches the pending effect and queues it again if the live limits
still require that.

The as-built API method is **`getBlockage(runId)`** (KeelApi), returning
`{ reason, blockedOn, context }`. `running` is a diagnostic state and is not
rendered as a visible blockage by reports, TUI detail, or web projections.
Actionable/current blockage reasons include `agent_concurrency`,
`waiting_human`, `waiting_signal`, `waiting_timer`, `stalled_no_heartbeat`, and
`interrupted`; `waiting_human` surfaces the persisted approval prompt, and
`interrupted` includes the redacted reason, previous status, last phase, and last
wait metadata. This preserves stall debugging as one call instead of log
archaeology while keeping healthy long-running work distinct from stale
ownership.

### 12.3 Agent-facing surface (deferred tier)

The tiered, token-costed MCP tools (`watch_run` ~100 tokens →
`get_run_blockage` ~120 → `get_run_detail` ~300 → `stream_events` unbounded,
plus launch/resume/approve/signal/rewind/fork controls; agents poll the cheap
summary, never the firehose) ride on the projection and ship late (Phase 19).
The token-budget tiering insight is preserved verbatim.

### 12.4 Ops instrumentation (right-sized)

From the start: **fail-loud journal-write p99 guard** (< 100 ms) and an
**artifact-store quota** — the two failures that corrupt or stall everything
else. The fuller alert suite (agent retry-rate, approval SLA) and ops runbooks
ship in Phase 19, when there are operations to run books on. *(v1 mandated the
full suite plus runbooks at P0 — pruned as pre-user over-engineering.)*

## 13. Time travel

All journal-backed, exposed to humans (CLI/web) and agents (MCP) through the
daemon's single write path, in Phase 18:

- **`retry(runId)`** — a FAILED run re-runs from its failed step; the failed rows
  are dropped so they re-execute while completed upstream replays.
- **`rewind(runId, stableKey)`** — truncate the journal after the step (by the
  per-run `seq`), decrement artifact refcounts for the discarded rows, and clear
  *unresolved* waits (unfired timers, pending approvals, unconsumed signals) so the
  run re-parks fresh; resolved waits are preserved for replay; then re-execute.
  *(As-built note: there is no per-step git-snapshot mechanism — write-agent
  worktrees are per-step and removed on every exit. Rewind restores journal/wait
  state, not a workspace snapshot.)*
- **`fork(runId, { atStableKey?, newRunId? })`** — fork a **terminal** run only
  (fenced): copy the journal prefix into a new run (`parentRunId` recorded); a full
  fork also copies the resolved durable-wait history. The new run can be rerun to
  diverge without touching the source.

## 14. Scope board

**Core** (the product is wrong without it):

| Subsystem | Core features |
|---|---|
| Kernel & journal | durable-function execution model · effect taxonomy · step identity + structural versioning · content-addressed invalidation + keySetHash drift · write-ahead crash protocol · journal store (SQLite-WAL, PG-compatible) · two-tier artifact store |
| Realm | three-layer determinism enforcement · error-first DX / Realm Reference |
| Authoring | the `ctx` API · Zod + JSON-Schema + structural hashing · definition pinning + a source override |
| Daemon & clients | single-writer daemon · embedded mode · frozen RPC contract (Phase 11) · thin CLI · crash recovery + CAS fence · daemon-owned agent subprocesses |
| Adapters | `AgentLike` contract · **Pi adapter** · structured-output enforcement · session capture & mid-call resume · stream/transcript capture |
| Capability | declaration enum (in `version` + input hash) AND enforcement — provider tool-policy mapping, fail-closed explicit workspace isolation, diff gate, trusted-local secret env injection (Phase 15). OS-sandbox backstop still deferred. |
| Observability | canonical projection + golden tests · heartbeats/timeouts · stall-retry |
| Testing | deterministic mock provider · kill-and-resume / fault-injection / contract suites · the large fan-out workload regression |
| Cross-cutting | JSON-only `ctx` seam (kernel language swappability) |

**Deferred** (valuable; lands in Phases 13–18 or later, in rough order):
blockage API → HITL (`ctx.human`) + signals + timers + supervisor → capability
*enforcement* + git-worktree isolation + diff gate + secrets side-channel +
approval nodes + threat model → time travel (retry/rewind/fork) →
`ctx.spawn` · `continueAsNew` · additional vendor adapters ·
fallback chains · typed queryable output tables · web read UI · tiered MCP
surface · dry-run preview · derived-graph view · embedding SDK · cron ·
Postgres backend (on demand only — L17) · full ops suite + runbooks.

**Cut** (explicit, so the rewrite never reabsorbs them):

| Cut | Why |
|---|---|
| `ttl`/`validator` memoization modes | Legitimizes nondeterministic "pure" steps — correctness-by-convention reintroduced; no workload needs it. |
| `ctx.parallel` / `ctx.loop` sugar | `Promise.all` already reads clean at 140 lines; extra surface creates overlapping dataflow mechanisms. |
| esbuild AST-rewrite realm fast path | 2–5 ms Worker spawn × a few hundred steps is noise against 106 minutes; revisit only on a failed benchmark. |
| Eval/scorer harness | Output-quality tooling, not durability; reintroduce on demand. |
| Rust + embedded-JS kernel (now) | The JSON `ctx` seam preserves the option at zero cost; designing it today is speculative depth. |
| Non-carried surfaces | Hijack, memory/recall, composite component library, Studio PWA, broad CLI surface area, GEPA optimizer — product sprawl Keel avoids until demanded. |
| Multi-tenant control plane, multi-worker leasing, per-run OS isolation, HMAC journal integrity | Out of the pipeline entirely pending **D2**; not a terminal phase. |

## 15. Implementation pipeline (one commit per phase)

> **✓ Implemented (2026-06-11): all 19 phases complete and green.** Each phase
> below was built as one reviewable commit meeting its exit criteria; see §0 for
> the status summary and `USAGE.md` for usage. The phase table stands as the
> as-built record.

Revised from v1's P0–P6 after the phasing critique. The major fixes: crash
consistency and per-step invalidation move **before** breadth (v1's P0
acceptance tests secretly required P5 machinery and the P1-scheduled write-ahead
protocol); the realm-boundary hashing mechanics are proven in Phase 4 before
anything builds on them (D3 is resolved by design — §5.4); the mock
provider exists **before** the first real adapter so every crash test lives in
CI forever; the RPC freeze moves to when effect shapes exist (Phase 11); and the
the review workload gets an intermediate **mock-scale milestone** (Phase 9) before the
live gate (Phase 14). Every phase ends green and is one reviewable commit.

**Stage A — kernel core (Phases 1–6)**

| # | Phase | Exit criteria (gates the commit) |
|---|---|---|
| 1 | Scaffold + journal store + hashing | CI green; transactional journal rows survive restart and reload identically; failed transaction leaves zero partial rows. |
| 2 | Memoized re-execution core | Crash/resume re-runs only incomplete steps; property tests cover identical `ctx.*` sequence across N re-runs and ambient replay across resume. |
| 3 | Write-ahead crash protocol | Kill-at-every-boundary matrix: `completed` replays exactly-once, `pending` re-executes at-least-once, zero corrupt/dangling journal state. |
| 4 | Deterministic realm + boundary hashing | Phases 2–3 suites pass unchanged inside the Bun Worker realm; forbidden-globals acceptance passes; explicit-input hashing and tagged-envelope edge detection proven across the JSON boundary; steps/sec benchmark recorded. |
| 5 | Structural step identity + determinism lint | Comment/whitespace/rename edits re-execute zero steps; schema or prompt edit re-executes exactly that step; lint trio + capture-rule tests pass. |
| 6 | Value-hash invalidation & early cutoff | Editing one step re-executes exactly the steps whose input values actually change; early-cutoff test: a logic edit yielding identical output re-runs nothing downstream; key-set-drift test: a drifted fan-out invalidates the whole batch, never mis-aligns. |

**Stage B — agents & the workload (Phases 7–10)**

| # | Phase | Exit criteria |
|---|---|---|
| 7 | Mock provider + `ctx.agent` effect | `kill -9` mid-mock-agent resumes at-least-once; completed agent steps replay exactly-once; schema-retry path covered. |
| 8 | Two-tier artifact store | Fault injection between artifact write and journal commit leaves committed-row-with-artifact or nothing; Phase 3 crash matrix stays green. |
| 9 | **True-north port on mock** (first workload milestone) | Port's orchestration body ≤ the original's ~145 lines (like-for-like, excluding prompt/domain config); full 20/90/1 shape completes in seconds in CI; kill at "verifier 90" resumes re-running only the in-flight call; editing `synthPrompt` re-runs exactly one agent. |
| 10 | First real vendor adapter (**Pi**) | Small real-agent workflow completes durably; all four session-resume branches pass under a fake-vendor harness; one manual mid-call kill demonstrates reconnect. |

**Stage C — daemon & operability (Phases 11–14)**

| # | Phase | Exit criteria |
|---|---|---|
| 11 | RPC contract + `RunProjection` (in-process transport) | All prior tests pass driven through the RPC layer; projection golden files locked; contract documented as frozen from this commit. |
| 12 | Daemon extraction + thin CLI | Launch from one process, observe from a second, resume from a third; `kill -9` the daemon mid-run → restart → run resumes; CAS fence prevents double-driving. |
| 13 | Liveness: heartbeats, timeouts, blockage, stall-retry | A scripted stalling mock agent is detected, auto-failed, retried; blockage API returns correct reason/blockedOn for each induced waiting state. |
| 14 | **True-north live run (the binding gate)** | The real ~111-agent run completes despite one mid-run daemon kill; re-executed work ≤ the one in-flight call; port still ≤ ~140 lines. **Implementation status (2026-06-11):** met as a *budget-scaled* live rehearsal — a few real Pi reviewers over a sample target found and adversarially confirmed real issues, surviving a crash injected mid-verify, resuming to a finished run (gated `KEEL_LIVE=1`). The *full* 111-agent live run against the original aw-gateway repo remains open only because that repo is not on this machine; the shape, durability, and crash-resume are proven at scale on mock (Phase 9) and live at reduced fan-out here. |

**Stage D — breadth, ordered by the near-term workload mix (Phases 15–19)**

Sequenced per L22: write-capable pipelines and scheduled runs are near-term;
approval-gated human flows are not. Phase 15 captures reviewable diffs for
worktree workspace agents; the full durable `ctx.human` effect family follows in
Phase 17.

| # | Phase | Exit criteria |
|---|---|---|
| 15 | Write-capable agents: capability enforcement, worktree isolation, diff gate, secrets | `fs:none` agent cannot write; an agent using a worktree workspace has changes confined to that worktree until a journaled approval (via RPC/CLI) merges them; secrets are injected through the side channel and wiped at terminal cleanup. |
| 16 | Scheduling & supervision: `ctx.sleep`, durable timers, supervisor, cron | A cron-scheduled mock workflow fires on time; a due timer fires correctly after a daemon restart (journal-rebuilt); orphaned runs are reclaimed via the heartbeat fence. |
| 17 | Full HITL: `ctx.human`, `ctx.signal`, park/wake | A run parked `waiting-human` with the daemon stopped survives restart and resumes when approved from a second client; `ctx.signal` with timeout parks and wakes correctly. |
| 18 | Time travel | Prompt edit mid-pipeline re-executes only the affected step + descendants with workspace restored; fork diverges with recorded lineage. |
| 19 | Ops hardening + deferred breadth | GC never collects non-terminal runs; web/CLI/MCP byte-identical under golden tests; `continueAsNew` checkpoints a long mock run; scoped-token auth gates non-local clients; a dialect-lint test asserts the DDL stays Postgres-compatible. |

## 16. Test strategy (mapped to phases)

- **Determinism realm** (4–5): violation trio; property test of identical
  `ctx.*` sequences across N re-runs.
- **Memoization & resume** (2–6): kill-and-resume at every boundary;
  exactly-once for `completed`, at-least-once for `pending`; comment edit →
  zero re-runs; schema edit → precise dirty set.
- **Crash consistency** (3, 8): fault injection between fn-completion and
  journal-commit; no dangling artifacts.
- **Key-set drift** (6): drifted fan-out invalidates the batch, never
  mis-replays.
- **Workload regression** (9, 14): the large fan-out workload on mock in CI
  forever; live as the Phase 14 gate; line count tracked as a regression metric
  (v1's unmeasurable "clarity" metric is dropped — the review gate is the
  measure).
- **Projection contract** (11+): golden byte-identical projections across
  surfaces; schema JSON round-trip → same structural hash.
- **Capability confinement + secret injection lifecycle** (15) and **HITL
  durability** (17): as phase exit criteria above.

## 17. Decision register

### Locked (carried from v1's log, conflicts resolved)

- **L1 Execution model:** durable functions over a journal (DF/DBOS lineage);
  rejected replay-everything and re-render execution models.
- **L2 Imperative authoring;** graph derived from the effect log, never declared.
- **L3 Single-writer daemon;** thin RPC clients; no direct DB access.
- **L4 The daemon spawns agent subprocesses — never the CLI.**
- **L5 Per-step structural versioning** (schema + spec + capabilities), not
  source-text hashing.
- **L6 Invalidation by value hashing** (§5.3–5.4): explicit step inputs,
  resolved-prompt hashing for agents, early cutoff; best-effort graph edges via
  tagged envelopes; explicit `{deps}` available. *(Supersedes v1's Proxy
  capture — D3 resolved 2026-06-11.)*
- **L7 Bun** for daemon, CLI, and realm host — named in the spec itself now.
- **L8 The `ctx.*` seam is JSON in/out, no shared mutable state** — the kernel
  language stays swappable (Rust + embedded JS later if ever justified).
- **L9 Plain git** for workspace isolation behind a VCS interface (jj dropped —
  every jj reference in v1 is superseded by this text).
- **L10 Realm = Bun Worker thread** (vm.runInNewContext rejected).
- **L11 SQLite-WAL is the journal backend** (solo and team-internal); schema
  kept Postgres-compatible as discipline; Postgres is an on-demand future swap,
  not pipeline work. *(Updated by L17.)*
- **L12 Two-tier storage;** large values use inline/CAS artifact tiers, while
  secrets use a separate env-injection side channel instead of workflow inputs or
  configuration.
- **L13 Default-deny capabilities,** one normalized adapter layer + OS backstop.
- **L14 Pi is the first agent backend;** Claude second. (v1-internal conflict
  resolved in Pi's favor — the later, deliberate decision.)
- **L15 The review workload constraint** (§2) overrides any decision that violates it.
- **L16 Greenfield repo** *(D1 resolved 2026-06-11)*: a new repo, with reference
  implementations used only for mechanics and only where explicitly named.

- **L17 Team-internal deployment on SQLite** *(D2 resolved 2026-06-11)*: one
  shared single-writer daemon, SQLite-WAL journal, scoped-token auth when the
  daemon serves non-local clients (Phase 19). No multi-tenant SaaS track, no
  Postgres implementation in the pipeline (schema stays PG-compatible as
  discipline; `tenant_id` remains one reserved column).

- **L18 Agents are always memoized** *(D4 resolved 2026-06-11)*: no
  `memo:'never'` mode. Re-thinking is expressed via `retry(stableKey)`,
  `rerun with a source override`, or iteration-keyed loops — never as a standing
  replay-policy override (§9.1).

- **L19 Pi and Claude are provider adapters** *(D5 resolved 2026-06-11, later
  updated)*: Pi and Claude are added behind the same provider boundary. Vendors
  without resume support re-execute in-flight calls fresh on crash.
- **L20 Day-one ops = the fail-loud pair** *(D6 resolved 2026-06-11, delegated)*:
  journal-write p99 guard + artifact-store quota from the first kernel phases;
  alert suite and runbooks in Phase 19.
- **L21 `onFailure: 'throw'` default, `'null'` opt-in** *(D7 resolved
  2026-06-11)*: a terminal agent failure (after bounded retries + stall-retry)
  rejects and fails the run loudly unless the call opted into `'null'`; the
  review workload port opts in for its fan-outs, matching the original's
  `filter(Boolean)` semantics.
- **L22 Workload mix & authorship** *(stated 2026-06-11)*: near-term workloads
  are read-only analysis/review, write-capable pipelines, and
  scheduled/recurring runs; approval-gated human flows are **not** near-term.
  **Workflows are authored primarily by agents, at run time** — the way an
  assistant authors a Claude Workflow script on request. Consequences: Stage D
  is sequenced isolation → scheduling → HITL; `launchRun` accepts an inline
  definition (§7.5); error-first DX and the small JSON-native `ctx` surface are
  load-bearing requirements, not niceties.

### ⚠ DECIDE — genuinely open, owner's call

**None.** All seven (D1–D7) are resolved into the locked list above. New open
decisions get appended here with stable numbering (next: D8) and a
recommendation attached.

### Specify during implementation (v1 gaps, each with an owning phase)

| Gap (undefined in v1) | Owning phase |
|---|---|
| Pure-step `specHash` via per-step bundle + pinned minification — stability tests | 5 |
| Explicit-input hashing + tagged-envelope edge detection (§5.3–5.4), end-to-end | 4–6 |
| Envelope tags surviving realm JSON serialization (boundary mechanics) | 4 |
| `onFailure` semantics and their interaction with bounded schema-retry (D7) | 7 |
| Deterministic Realm Reference (full allowed/forbidden + error-text table) | 4–5 |
| Journal supersession semantics (§5.5 — drafted here; test it) | 2–3 |
| RPC wire contract (method list, event subscription, ownership handoff) | 11 |
| `AgentSpec` finalization incl. provider-specific session opts | 7, 10 |
| Pi source verification — remaining items only: tool-restriction flags in rpc mode; semantics of re-prompting a session whose turn was interrupted mid-generation; `--session` + `--mode rpc` compatibility on the pinned Pi version | before 10 |
| `continueAsNew` carry cap + pending-approval/timer transfer semantics | 19 |
| Workspace snapshot mechanism in plain git (per-step snapshot commits) | 15, 18 |
| Heartbeat/timeout defaults validated against genuinely long agent calls | 13 |
| Optional output-redaction policy, if teams need one separate from trusted-local defaults | future |

---

## Appendix A — Journal schema (DDL sketch)

```sql
CREATE TABLE runs (
  run_id             TEXT PRIMARY KEY,
  workflow_name      TEXT,               -- optional display label; not a handle
  definition_version TEXT NOT NULL,      -- pinned archived definition
  workflow_ref       TEXT,               -- display-only provenance / pinned hash
  status             TEXT NOT NULL,      -- running | waiting-human | waiting-signal
                                         -- | waiting-timer | waiting-approval
                                         -- | interrupted
                                         -- | finished | failed | cancelled | continued
  parent_run_id      TEXT,               -- fork / spawn / continueAsNew lineage
  tenant_id          TEXT,               -- single reserved column (see D2)
  input_ref          TEXT,               -- inline JSON or artifact hash
  output_ref         TEXT,
  error_json         TEXT,
  heartbeat_at_ms    INTEGER,
  runtime_owner_id   TEXT,               -- CAS fence for daemon ownership
  created_at_ms      INTEGER NOT NULL,
  finished_at_ms     INTEGER
);

CREATE TABLE journal (
  run_id            TEXT NOT NULL,
  stable_key        TEXT NOT NULL,
  attempt           INTEGER NOT NULL DEFAULT 1,  -- §5.5: highest attempt wins;
                                                 -- prior rows = auditable history
  effect_type       TEXT NOT NULL,       -- pure | effectful | ambient
  status            TEXT NOT NULL,       -- pending | completed | failed
  version           TEXT NOT NULL,       -- structural definition hash (§5.2)
  input_hash        TEXT NOT NULL,
  input_deps_json   TEXT,                -- [{stepKey, contentHash}] (§5.3/5.4)
  key_set_hash      TEXT,                -- fan-out drift detection
  result_inline     TEXT,                -- <= 1KB
  result_artifact   TEXT,                -- > 1KB -> artifacts.hash
  session_token     TEXT,                -- vendor mid-call resume (§10.4)
  error_json        TEXT,
  started_at_ms     INTEGER,
  finished_at_ms    INTEGER,
  PRIMARY KEY (run_id, stable_key, attempt)
);

CREATE TABLE artifacts (
  hash          TEXT PRIMARY KEY,
  byte_len      INTEGER NOT NULL,
  ref_count     INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  data          BLOB                     -- or external object-store URI
);

CREATE TABLE events (
  run_id        TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  type          TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  emitted_at_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE approvals (
  run_id            TEXT NOT NULL,
  stable_key        TEXT NOT NULL,
  status            TEXT NOT NULL,       -- pending | approved | denied
  granted_caps_json TEXT,                -- the approved capability delta (§11.4)
  decided_by        TEXT,
  note              TEXT,
  requested_at_ms   INTEGER NOT NULL,
  decided_at_ms     INTEGER,
  PRIMARY KEY (run_id, stable_key)
);

CREATE TABLE signals (
  run_id         TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  name           TEXT NOT NULL,
  correlation_id TEXT,
  payload_ref    TEXT,
  received_at_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE timers (
  run_id        TEXT NOT NULL,
  stable_key    TEXT NOT NULL,
  fire_at_ms    INTEGER NOT NULL,
  fired         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, stable_key)
);

-- step_outputs_<structuralHash> tables (typed queryable outputs) are a deferred
-- feature; only the naming convention is reserved here.
```

## Appendix B — Glossary

- **Step** — a journaled `ctx.*` call; the atom of durability.
- **Pure / effectful / ambient** — the effect taxonomy (§5.1) that determines
  resume behavior.
- **`inputHash`** — content hash of a step's inputs (refs, not blobs; §5.3).
- **`version`** — structural definition hash; changes only when *what the step
  does* changes (§5.2).
- **Deterministic realm** — the Bun-Worker-isolated, sealed-`ctx` environment
  the body runs in.
- **Journal** — the authoritative durable record of every effect.
- **Artifact store** — content-addressed storage for large outputs.
- **Canonical projection** — the single `RunProjection` read model all surfaces
  consume.
- **Capability** — the declared `{fs, network, shell, secrets}`, resolved per
  vendor with an OS-sandbox backstop (§11).
- **`continueAsNew`** — seal a long run's journal and restart with carried state.
- **True-north** — the 111-agent review-shaped workload; the binding acceptance
  stress test.
