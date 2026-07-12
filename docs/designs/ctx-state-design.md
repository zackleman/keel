# `ctx.state` — Phase 5 design (run-scoped v1)

**Status:** proposed · **Date:** 2026-07-12 · **Gates:** Phase 5a implementation
**Plan:** `docs/designs/onyx-extensions-plan.md` §Phase 5 · **Evidence:** `docs/designs/workload-test-results.md`

## 1. Context and scope

Phase 4 proved that keel does not need `ctx.state` for correctness: the autoresearch
workload rebuilt `best`/`history` from journaled results after SIGKILL, delayed restart,
and source-override reruns (workload-test-results.md §Findings). `ctx.state` is therefore
an **ergonomics and observability** feature, and v1 is scoped accordingly:

- **In scope (5a):** run-scoped named namespaces, written and read only by workflow code;
  a materialized snapshot supervisors can read over MCP; full replay/rewind/fork/override
  correctness.
- **Deferred:** agent-side state tools (5b, §9), cross-run persistent stores (v2),
  supervisor writes, child-workflow sharing (Phase 6 decides).

`ctx.state` is a sibling of `ctx.checkpoint` and `ctx.drainSignals`: strict-effect path,
explicit author-chosen stable keys, plain-object specs validated in
`src/kernel/state.ts` exactly as `checkpoint.ts` / `drain-signals.ts` do.

## 2. Decision summary

| Decision | Choice |
|---|---|
| Read/replay model | **Option B — deterministic fold over journaled writes** (§3) |
| Write API | `set({ key, name, value })`, strict effect, value ∈ identity (§4) |
| Read API | `get(name)` / `snapshot()` — **synchronous, free, not journaled** (§4) |
| Storage | New `state` table, **migration v22→23**, executor-materialized (§6) |
| Rewind | Delete run's state rows; replay re-materializes (self-healing) (§5.4) |
| Fork | Copy nothing; the fork's first resume re-materializes (§5.4) |
| `continueAsNew` | **No carry** in v1; pass `snapshot()` through the successor's input (§5.5) |
| Observation | Bounded `state` snapshot on `RunProjection` + `getRunState` RPC + MCP `get_state` (§7) |
| ABI | **Ride 13** — branch-unreleased, same argument Phase 3 used (§8) |

## 3. Option A vs Option B

**The invariant at stake:** every `get` must return the same value on replay, and the
journal must remain the single source of truth that rewind/fork can cut.

### Option A — journaled reads

Each `get` is an effect whose recorded result replays. Matches existing machinery, and it
is the only sound model when **external writers** exist (supervisor writes, cross-run
stores), because then a read is genuinely nondeterministic.

Rejected for v1 on three grounds:

1. **Key burden or silent corruption.** Author-keyed reads mean a stable key per `get` —
   unusable in a loop that reads `best` every iteration. Occurrence-keyed reads inherit
   the known `__now#N` fragility: an edit that inserts one `get` shifts every later
   occurrence onto the *wrong recorded value* — the worst failure class keel has (silent,
   not fail-closed).
2. **Stale-read poison under partial invalidation.** After a source-override rerun, an
   upstream write re-executes with a new value, but a downstream read whose own identity
   didn't change **replays its old recorded value**. Fixing that requires folding the
   write history into read identity — at which point Option A has become Option B with
   extra journal rows.
3. **Journal economy.** Keel journals what is not re-derivable. Run-scoped, single-writer
   reads *are* re-derivable; journaling them doubles hot-loop row traffic for nothing.

### Option B — deterministic fold over journaled writes (recommended)

Only **writes** are journaled effects. A read returns the fold (last-writer-wins per
`(namespace, name)`) of the writes that preceded it *in this execution pass*. Concretely:
the workflow worker keeps an in-memory map per namespace; every `set` — whether executed
live or replayed from its completed row — updates that map on return; `get` reads the map
synchronously.

Correct by construction for v1's closed world: all writes flow through the run's own
journaled effects, writes replay deterministically in program order, therefore every read
is deterministic. Reads cost nothing, need no keys, and cannot go stale: a changed
upstream value re-executes the write (value is in its identity, §5.2), the fold re-folds,
and downstream effect identities change only through the values actually fed into them —
exactly how local variables behave today, so source-override suffix invalidation is
preserved precisely.

The price is the closed-world assumption. 5b keeps it by making agent-tool writes
journaled writes in the same run (§9); supervisor influence stays on the steer-signal
channel (which enters turn identity via `drainSignals`); MCP state access is read-only.
Cross-run stores (v2) break the assumption and will need Option A-style journaled reads
at that boundary — that is future work, not a v1 compromise.

**Recommendation: Option B. Firm.**

## 4. API surface

```ts
// src/kernel/ctx.ts (Ctx interface)

/** Open a run-scoped state namespace. Pure handle — no journal row, no await. */
state<S extends Record<string, Json>>(
  namespace: string,
  schemas?: { [K in keyof S]?: Schema<S[K]> },   // keel's jsonSchema<T> parsers
): StateNamespace<S>;

interface StateNamespace<S extends Record<string, Json>> {
  /** Journaled strict-effect write (last-writer-wins per name). */
  set<K extends keyof S & string>(spec: {
    key: string;      // effect stable key, author-chosen (e.g. ctx.stepKey("best", i))
    name: K;          // entry name within the namespace
    value: S[K];      // JSON value; value participates in effect identity
  }): Promise<void>;

  /** Synchronous fold read; undefined before the first write this pass. */
  get<K extends keyof S & string>(name: K): S[K] | undefined;

  /** Synchronous fold read of the whole namespace. */
  snapshot(): Readonly<Partial<S>>;
}
```

Spec-object `set` mirrors `ctx.checkpoint`'s accepted Phase 1 shape (explicit `key` is
the keel-idiomatic stable identity; auto/occurrence keys are rejected — they are
positional, and keel's invariant is content-derived or author-chosen keys). `get` being
synchronous is the visible payoff of Option B and should be advertised as such.

Schemas are optional per-entry `jsonSchema<T>` parsers. Today `Schema.parse` is a
permissive structural carrier (`src/kernel/schema.ts:24-27`), so v1 "schema gating" is
TypeScript-level plus identity-level: `hashJson(schema.structural())` enters the write's
version identity, so a schema edit invalidates and re-executes the affected writes. Real
runtime validation arrives for free when keel's planned schema validation lands — no
bespoke validator for state.

No `update(key, fn)` in v1: with a free synchronous `get` it is one line of sugar
(`set({ key, name, value: fn(s.get(name)) })`) and adding it would smuggle in a
"deterministic fn" contract we cannot enforce.

### Autoresearch rewrite (from `workflows/autoresearch/autoresearch.workflow.ts`)

The `best`/`history` locals (lines ~70–105) move into a namespace; the loop reads via the
fold and supervisors see live values over MCP without waiting for a checkpoint:

```ts
const research = ctx.state<{ best: Candidate; history: HistoryEntry[] }>("research", {
  best: CandidateSchema,
  history: HistorySchema,
});

await research.set({
  key: "state.best.init",
  name: "best",
  value: { score: setup.baselineScore, candidate: "baseline", summary: setup.hypothesis },
});
await research.set({ key: "state.history.init", name: "history", value: [] });

for (let i = 0; i < input.iterations; i++) {
  const steers = await ctx.drainSignals<Steer>(ctx.stepKey("steer", String(i)), "steer");
  const best = research.get("best")!;                      // sync fold read
  const result = await ctx.agent({
    key: ctx.stepKey("experiment", String(i)),
    prompt: composePrompt(i, setup.hypothesis, best, steers),  // state → identity via inputs
    schema: ExperimentResult, onFailure: "null", maxRetries: 0, /* … */
  });

  const accepted = result !== null && result.score > best.score;
  if (accepted) {
    await research.set({ key: ctx.stepKey("state.best", String(i)), name: "best", value: result });
  }
  await research.set({
    key: ctx.stepKey("state.history", String(i)),
    name: "history",
    value: [...research.get("history")!, { iteration: i, accepted, result, steers }],
  });

  await ctx.checkpoint({
    key: ctx.stepKey("checkpoint", String(i)),
    message: `iteration ${i}: ${accepted ? "kept" : "reverted"}`,
    data: { iteration: i, accepted, steers },               // best/history now live in state
  });
  /* cooldown sleep unchanged */
}

const { best, history } = research.snapshot();
```

Note the whole-value LWW model: `history` append rewrites the array each iteration.
Acceptable at v1 scale (values >1KB ride the artifact tier automatically); a list-append
op is possible v2 sugar, not v1.

## 5. Semantics

### 5.1 Namespace identity

A namespace is `(run_id, namespace)` — created implicitly on first write, no
registration, dies with the run. `namespace` and `name`: non-empty, ≤128 chars, must not
start with `__` (reserved, enforced via `assertNotReservedAuthorKey` like sibling
effects). Namespaces are isolated; there is no cross-namespace transaction. Two handles
opened on the same namespace with different schemas are an author error v1 does not
detect (each write validates against its own handle's schema, which is in its identity).

### 5.2 Write identity and journaling

A write is a strict effect (`StepEngine.beginStrictEffect` family,
`src/kernel/step-engine.ts:122-165`), new `EffectType` `"state_write"` (TEXT column — no
migration needed for the type itself):

- `stableKey` = `spec.key` (author-chosen).
- `inputHash` = `hashJson({ namespace, name, value })`. **Value ∈ identity** is
  load-bearing: a write can never silently replay a stale value; when upstream results
  change under a source-override rerun, the write re-executes as a new attempt.
- `version` = structural hash of `{ kind: "state_write", abi: STATE_ABI, schema: structuralHash | null }`.
- Result = the value (so replay can rebuild the fold), inline ≤1KB else artifact tier via
  the existing `prepareStepResult` machinery.
- Completion follows the `completeDrainSignals` pattern: the value-closure passed to
  `commitStep` upserts the materialized `state` row **inside the same transaction** as
  the completed journal row and any artifact write (`step-engine.ts:216-260`). One
  transaction; no window where journal and snapshot disagree.

### 5.3 Write ordering and replay determinism

Writes are awaited effects and serialize in program order within a single execution pass;
on replay the same completed rows return in the same order, so the fold is identical.
Parallel branches (`Promise.all`) interleave exactly as local-variable mutation does
today — `ctx.state` adds **no new ordering guarantee** across concurrent branches.
Documented rule: one logical writer per `(namespace, name)` at a time; concurrent
same-name writes from parallel branches are an author error with last-writer-wins
outcome. This is the same envelope keel already has for locals; state does not widen it.

### 5.4 Crash, rewind, fork

- **Crash after pending row, before commit:** resume hits the strict-path pending guard;
  matching identity re-executes the same attempt (the "execution" is just the commit —
  idempotent, no external side effect). Changed identity (code edited before resume)
  fails closed with the standard "identity changed; use a new key or rewind" error.
- **Rewind:** `deleteRunStateAfter` (`src/journal/store.ts:1973`) additionally deletes
  **all** of the run's `state` rows. The next resume replays the surviving prefix, and
  because the engine also upserts the materialized row on the **replay** branch of
  `beginStateWrite` (replay-touch, idempotent), the snapshot rebuilds in program order.
  This is the same self-healing philosophy as artifact GC ("refcounts are recomputed from
  the journal", store.ts:2098). Between rewind and the next resume the snapshot is
  empty — `get_state` documents "rebuilt on next resume".
- **Fork:** `forkRun` copies the journal prefix and touches state not at all; the fork's
  first resume re-materializes its own rows under the new runId. Zero fork-specific code;
  an unresumed fork simply shows an empty snapshot.

Replay-touch is also why the snapshot converges after a source-override rerun: the pass
touches every live row in program order, so the table always reflects the *current*
execution — not journal insertion order (see the ordering trap in §6).

### 5.5 `continueAsNew`

**State does not carry to the successor in v1** — deviating from the plan's tentative
lean, for three reasons: (a) the successor already has a first-class carry channel, its
input — `ctx.continueAsNew({ ...next, research: research.snapshot() })` is one line;
(b) precedent — agent session rows do not inherit across `continueAsNew`
(`src/kernel/realm/agent-session.test.ts:1444`); (c) carrying would require seeding the
successor's fold with a synthetic journaled "inherited snapshot" effect to keep replay
sound — real machinery for a use case the input channel already covers. That seeding
effect is the named v2 mechanism if ergonomics demand it later.

### 5.6 Source-override invalidation

Reads are not journaled, so state influences downstream effect identity only through the
values the author feeds into effects (prompts, inputs) — identical to locals, which
Phase 4 verified end-to-end (suffix-only re-execution). Writes whose values changed gain
new attempts; unchanged writes replay. Nothing about override semantics changes.

## 6. Storage — new table, migration v22→23

Current `SCHEMA_VERSION = 22` (`src/journal/schema.ts:7`; Phase 3 landed without a bump,
so Phase 5's migration is 22→23, not the plan's speculative 23→24).

```sql
CREATE TABLE IF NOT EXISTS state (
  run_id         TEXT NOT NULL,
  namespace      TEXT NOT NULL,
  name           TEXT NOT NULL,
  value_inline   TEXT,              -- JSON when <= 1KB
  value_artifact TEXT,              -- artifact hash otherwise (borrowed from the write row)
  written_key    TEXT NOT NULL,     -- 'stableKey#attempt' provenance, for debugging
  updated_at_ms  INTEGER NOT NULL,
  PRIMARY KEY (run_id, namespace, name)
);
```

**Why not ride journal rows alone?** It almost works: observation could scan
`effect_type = 'state_write'` rows, latest attempt per stableKey, ordered by seq. But seq
order is journal *insertion* order, and after a source-override rerun it diverges from
program order: write W1 (`name: "best"`, value changed by the edit) re-executes and gets
a fresh high seq, while a *later-in-program-order* write W2 to the same name replays with
its old low seq. A seq-ordered fold then reports W1's value as current — **wrong,
permanently, for that run**. Ordering by first-attempt seq fails the same way when an
edit reorders same-name writes. Program order is knowable only by the executor, so the
executor materializes (§5.2, §5.4). The table also gives supervisors O(1) reads instead
of a journal scan per poll. The journal remains the source of truth; the table is a
rebuildable cache, deleted on rewind and reconstructed by replay.

Artifact note: `value_artifact` borrows the write row's artifact by hash — no refcount
bump. Safe because state rows never outlive the journal rows that own the hash (rewind
deletes state rows in the same transaction that cuts the journal; superseded attempts
remain in the journal) and GC recomputes refcounts from the journal alone.

Migration ships with the mandatory migration test on a copied real DB (AGENTS.md rules);
run-deletion/GC paths cascade `state` rows.

## 7. How supervisors observe state

Daemon RPC first (docs/control-surfaces.md discipline), surfaces adapt:

- **`RunProjection.state`** (canonical, golden-locked): bounded snapshot
  `{ [namespace]: { [name]: Json | { $artifact, byteLen } } }` — values ≤1KB inline,
  larger values as artifact stubs. `state_write` rows already appear as `NodeView`s via
  the existing node builder; no new stats field (nodes + snapshot suffice). Golden tests
  in `src/rpc/rpc.test.ts` update in the same commit.
- **New gateway op `getRunState(runId, namespace?)`**: full values (artifact-resolved),
  per-value cap ~64KB with stubs beyond, run-token scoped like other run reads.
- **New MCP tool `get_state(runId, namespace?)`** in `src/mcp/tools.ts` — the 13th tool,
  a thin `getRunState` adapter, byte-identity-tested against the RPC per DESIGN §12.1.
  `get_run_detail` picks up the projection snapshot for free.

Supervisor loop: poll `watch_run` → drill into `get_state("research")` → steer via
`send_signal` — closing the loop the autoresearch workload currently closes only through
checkpoint payloads.

## 8. ABI

Enforcement (verified): `WORKFLOW_SDK_ABI_VERSION = 13` (`src/workflow-definitions/abi.ts`)
is stamped into each definition manifest at capture and checked with **strict equality**
at materialization — launch *and* resume — throwing `UnsupportedWorkflowSdkAbiError`
(`snapshot.ts:499-503`; resume-rejection covered in `daemon.test.ts`). A bump therefore
deterministically strands every definition captured at the old number.

**Decision: `ctx.state` rides ABI 13.** ABI 13 was minted by Phase 1 *on this unreleased
branch* and Phase 3 already rode it under the "one bump per landing set" rule; nothing at
13 has shipped anywhere. The honest caveat: riding means a state-using definition run
against an older pre-state ABI-13 daemon build fails at runtime (`ctx.state is not a
function`) rather than fail-closed at launch — acceptable strictly while the branch is
unreleased and single-operator. **Condition:** if any pre-state ABI-13 build ever deploys
beyond local dev with non-terminal runs, Phase 5 bumps 13→14 instead. Record whichever
happens in `CHANGELOG.md [Unreleased]`.

## 9. Phase 5b sketch — agent-side state tools (future work)

Give agents `state_read` / `state_write` tools so a turn can consult and update shared
state mid-turn. Not designed here; the shape:

- Extend the `AgentProvider` contract (`src/agents/types.ts`) with optional
  workflow-supplied tool registration. **Claude-first** via MCP config injection (keel
  injects no custom tools today); Pi/Codex bridges follow.
- **Writes must remain journaled writes** to keep the Option B fold closed: host-mediated,
  recorded as attempt-scoped effects deduped by `(runId, turn stableKey#attempt,
  toolCallId)`. A crashed pending turn re-executes at-least-once with fresh tool-call
  ids, so duplicate writes are possible — LWW makes that benign for state, and it matches
  keel's existing at-least-once envelope for pending effects.
- **Reads need no determinism machinery**: they occur inside an effectful step whose
  completed result replays without re-execution.
- Fallback already works and stays documented: agents return structured output; workflow
  code writes state. Phase 4 showed this covers Onyx's demonstrated usage; 5b proceeds
  only if that fallback proves insufficient in practice.

## 10. Non-goals (v1)

- Cross-run / persistent / global stores (v2; requires journaled-read boundary, §3).
- Supervisor or MCP **writes** to state (steer signals remain the influence channel).
- Agent-side tools (5b, above).
- Carrying state across `continueAsNew` (input-channel pattern, §5.5) or into spawned
  children (Phase 6 decides sharing).
- `update(fn)`, list-append, counters, or any op beyond whole-value LWW `set`.
- Cross-namespace atomicity; watch/subscribe; TTL/expiry (state dies with the run).
- Runtime schema validation beyond keel's current permissive `Schema.parse` (§4).
- New ordering guarantees for parallel branches (§5.3).

## 11. Test plan

Replay determinism
- Realm fixture (`src/kernel/realm/fixtures/`) with init + loop writes/reads across two
  namespaces: run to completion, resume-replay → byte-identical output, no new journal
  rows, no duplicate attempts.
- SIGKILL-and-resume mid-loop (Phase 4 harness pattern): fold rebuilt, snapshot table
  matches the in-memory fold at completion.

Crash mid-write
- Fault injection `after-pending` and `before-commit` on a `state_write` (existing
  `host.fault` hooks): resume completes the same attempt exactly once; journal row +
  state row commit atomically (never one without the other).
- Strict-path fail-closed: edit the pending write's value before resume → "identity
  changed" error, run does not silently proceed.

Fold correctness
- `get` before first write → `undefined`; LWW per name; namespace isolation;
  `snapshot()` consistency with `get`.
- **Ordering-trap regression (§6):** source-override rerun where an early same-name write
  re-executes (new value, new seq) while a later same-name write replays (old seq) —
  assert fold and materialized row equal the *later program-order* write's value.
- Suffix invalidation: only writes with changed values gain attempts; downstream agent
  effects invalidate iff their composed inputs changed (mirrors Phase 4 matrix item 4).

Rewind / fork
- Rewind mid-loop: all state rows deleted transactionally; resume re-materializes prefix
  values via replay-touch; post-cut writes re-execute; drain-signal restoration
  (store.ts:1988-2005) unaffected.
- Fork mid-loop: resumed fork materializes its own rows; source run's rows untouched.

Storage / migration
- Migration test v22→23 on a copied real DB; run-deletion cascades state rows; large
  value → artifact-tier write; GC keeps borrowed artifacts alive while journal rows
  reference them and self-heals post-rewind.

Golden projections / surfaces
- `rpc.test.ts` goldens: `state_write` nodes + `RunProjection.state` snapshot incl.
  artifact stub shape.
- MCP `get_state` live-daemon test; byte-identity vs `getRunState` RPC; redaction
  conventions hold.

## 12. Implementation map (5a)

`src/kernel/state.ts` (normalize + `STATE_ABI` + version identity, sibling of
`checkpoint.ts`) · `src/kernel/ctx.ts` (interface + realm and in-process impls, worker
fold map) · `src/kernel/realm/protocol.ts` + `worker-entry.ts` + `realm-host.ts` (wire
`state_write` beside checkpoint/drain) · `src/kernel/step-engine.ts`
(`beginStateWrite` with replay-touch upsert; `completeStateWrite` upserting in the
commit transaction) · `src/journal/types.ts` (`EffectType` + `"state_write"`) ·
`src/journal/schema.ts` + `migrations.ts` (v23 table) · `src/journal/store.ts`
(`putStateRow`/`getRunState`, rewind + delete cascades) · `src/rpc/view-contract.ts` +
`projection.ts` + goldens · gateway op + `src/mcp/tools.ts` `get_state` · docs per
AGENTS.md (USAGE, SKILL, DESIGN §5.1 taxonomy, events/api, control-surfaces matrix,
CHANGELOG).
