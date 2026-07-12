# Writing & running a Keel workflow

A **workflow** is an `async (ctx, input) => output` function. You call agents and
do work through `ctx`; Keel runs it durably and survives crashes. For a single
workflow, run inline TypeScript with `keel run <<'TS'` so no workflow file is
needed. `keel run` prints a structured JSON envelope by default.
For reusable operational workflows, check `workflows/README.md` and launch the
documented workflow file instead of copying fixture code. Once a workflow is
stable, operators can save it with `keel workflow save <name> <workflow.ts>` and
launch future pinned versions with `keel workflow run <name>`. Use
`keel workflow launch <name> --detach` when the caller needs the run id
immediately; `--emit-capability` mirrors `keel launch` by printing the raw run
capability instead of writing only a capability file reference.
For Keel's curated one-shot review workflows, an operator with admin authority
can install the package with `keel workflow install task-review-guidance`; this
creates ordinary saved workflow versions for `task-code-review`,
`task-plan-review`, and `task-docs-review`.

Assume the daemon is already running and the `keel` CLI is already configured to
reach it. Do not start the daemon, restart systemd, or use admin credentials from
this skill.

---

## 1. The shape

```ts
import type { Ctx } from "@kcosr/keel";
import { jsonSchema, passthrough } from "@kcosr/keel";

export default async function myWorkflow(ctx: Ctx, input: { /* your input */ }) {
  // ...do work via ctx...
  return /* your result (JSON-serializable) */;
}
```

- Default export, `async (ctx, input) => output`.
- `input` and the return value must be JSON-serializable.

## 2. Rules

The body runs in a sandbox. Stay inside it or the run is rejected:

- **No `Date.now()`, `new Date()`, `Math.random()`, `fetch`, `Bun.*`, or
  file/network access** in the body. Use `ctx.now()` / `ctx.random()`; do real
  work via `ctx.agent` or bounded `ctx.command`.
- File-launched workflows may import local static `.ts`/`.tsx` helpers through
  relative specifiers. Inline/stdin workflows are single-module only. The only
  external import allowed in workflow source or helpers is the exact authoring
  SDK specifier `@kcosr/keel`; do not import packages, SDK subpaths, dynamic
  imports, Node/Bun builtins, or operator/control APIs such as
  `@kcosr/keel/execute`.
- Shared helper modules are good for deterministic prompt fragments, review
  rubrics, task lists, and render functions. Keep them pure and deterministic,
  and keep raw secrets out of workflow source and helper modules.
- Workflows can import `workflows/model-routing/model-routing.ts` or a local
  copy when profile/reasoning selection should be captured with the workflow
  source. Static routing is pure TypeScript; agentic routing uses a read-only
  router agent and must keep profile, reasoning, tools, capabilities, secrets,
  and workspace choices bounded by workflow-owned allowlists.
- Saved workflows capture those helper modules as TypeScript source in the
  immutable bundle. Prefer these Keel-native helpers for reusable guidance. Do
  not import agent-pack YAML, mutable task state, task-note files, or external
  runtime guidance packages.
- Bump and save a new workflow version when prompt text, reusable rubrics,
  severity rules, output contracts, or workflow input/output contracts change.
  Pure helper refactors that render byte-identical prompts can keep the same
  saved version.
- **A `ctx.step` callback must use only its `inputs`** — don't read outer variables
  inside a `step` function; pass them in through `inputs`. (Agent prompts can use
  any variable freely.)

## 3. The `ctx` API

```ts
ctx.agent(spec)                       // call an LLM agent (the real work); see §4
ctx.agentSession(spec).turn(spec)     // realm-only multi-turn logical agent; see §4.1
ctx.command(spec)                     // durable bounded host command; see §4.3
ctx.completionCheck(spec)             // durable host completion gate for curated workflows
ctx.checkpoint({ key, message, data? }) // durable, ordered progress; await persistence
ctx.state(namespace, schemas?)          // run-scoped LWW state; journaled set, synchronous get/snapshot
ctx.step(key, schema, inputs, fn)     // pure compute; memoized & re-run only if inputs/code change
ctx.now() / ctx.random()              // the only time / randomness allowed
ctx.sleep(key, ms)                    // durable pause
ctx.human({ key, prompt })            // wait for a human approval → { status, note }
ctx.signal(name)                      // wait for an external signal
ctx.drainSignals(key, name)           // consume all pending signals without parking
ctx.spawn(key, { workflow, input, caps? }) // start a saved workflow as a child
ctx.waitRun(key, child)              // journal the child's terminal outcome
ctx.stepKey(name, id)                 // make a stable key for fan-out
ctx.log(msg) / ctx.phase(title)       // narration
```

**Fan out with `Promise.all`** over `ctx.agent`/`ctx.step`. Keys must be stable per
run — derive fan-out keys from content: `ctx.stepKey("verify", finding.id)`, never
from an array index.

Await `ctx.checkpoint` where progress becomes durable. Its `message` and optional
JSON `data` are part of effect identity; completed checkpoints replay without
duplicating their durable events.

Use `const s = ctx.state<S>("namespace", schemas)` for observable run-scoped
state. Await `s.set({ key, name, value })`; `s.get(name)` and `s.snapshot()`
are synchronous reads of writes already encountered in the current pass. Use
stable author keys, include whole JSON values, and keep one logical writer per
entry. State does not carry through `continueAsNew`; pass the snapshot in input.

Use `ctx.spawn` only with saved workflow refs. Give every spawn and wait its own
stable key, pin `name@version` when the exact version matters, and branch on the
`ctx.waitRun` outcome because child failure is returned rather than thrown.
Spawned children keep running if the parent is interrupted and are not adopted by
`continueAsNew`. Use `caps` to narrow the fresh child run capability.

## 4. Calling an agent (`ctx.agent`)

```ts
ctx.agent({
  key: "review:security",     // unique, stable (use ctx.stepKey for fan-out)
  prompt: "Review the code at /abs/path for security issues. Report each finding.",
  schema: Findings,           // structured output (§5); omit for plain text
  toolPolicy: "read-only",    // lets the agent read/grep the files
  reasoning: "high",          // off | minimal | low | medium | high | xhigh
  onFailure: "null",          // only for optional agents where partial results are OK
  lenient: true,              // tolerant output parsing — recommended
})
```

Filter tolerated failures out with `.filter(Boolean)`. Do not use `onFailure:
"null"` for required agents; let those failures fail the run so the run can be
retried.

Use `profile: "name"` when an operator has configured reusable defaults in the daemon profile catalog. Your explicit `ctx.agent` fields override profile fields. Profile edits affect only future launches/reruns because each run uses a frozen catalog snapshot.

`toolPolicy` is only `"none"`, `"read-only"`, `"workspace-write"`, or
`"unrestricted"`. Use `providerConfig` only for provider-owned JSON settings;
Keel validates the full provider-keyed map, but only the selected provider's
entry affects replay identity or reaches the adapter. It replaces, not deep
merges, profile config for that provider. Do not put raw secrets or workspace
choices in `providerConfig`; request secret names with `environment.secrets`,
supply values at launch/restart time, and use workspace handles for cwd.

Agents run in a resolved workspace: explicit handle, scoped `ctx.withWorkspace`,
or the run default direct workspace at `ctx.run.target`. To let an agent run
shell commands, use explicit capabilities:

```ts
capabilities: { fs: "none", network: "none", shell: true, secrets: [] }
```

To inject a secret value, grant and request the same secret name. The raw value
must be supplied by the run launcher with `--secret`, `--secret-env`, or API
`runSecrets`:

```ts
capabilities: { secrets: ["TOKEN"] },
environment: { secrets: ["TOKEN"] },
```

Codex is available as `provider: "codex"` with default/read-only,
workspace-write, or unrestricted tool policies in an explicit workspace cwd.
When not using the stdio default, supply `providerConfig.codex.transport`
(`stdio`, `ws`, or `uds`). `providerConfig.codex.serviceTier` may be `"fast"`
for Codex priority service or `"normal"` to force standard routing; omitting it
leaves Codex defaults in control. Codex read-only/workspace-write use Codex's
sandbox with network disabled, but may still run sandboxed commands;
unrestricted Codex can access outside the cwd according to the host runtime.
Keep raw secrets out of workflow source and `providerConfig`; remote Codex
transports reject any injected environment.

## 4.1 Multi-Turn Agent Sessions (`ctx.agentSession`)

Use `ctx.agentSession` only when later turns need the same backend conversation
memory as earlier turns. Declare participant identity once, then call `.turn`
with stable turn keys:

```ts
const primary = ctx.agentSession({
  key: "primary",
  provider: "pi",
  toolPolicy: "read-only",
});

await primary.turn({ key: "draft", prompt: draftPrompt, schema: Draft });
const revised = await primary.turn({ key: "revise", prompt: revisePrompt, schema: Draft });
```

Participant and turn keys must match `[A-Za-z0-9_-]+`. Do not use
`__session.` as a `ctx.step` or `ctx.agent` key prefix; Keel reserves it for
derived session-turn journal keys.

Do not use session turns for independent fan-out. A participant is a single
forward-only backend thread, so concurrent turns on the same participant fail.
Use separate participant keys for independent conversations.

Session runs can resume and retry, but not rerun, rewind, or fork. If a session
turn is interrupted after a backend token is observed, explicit resume continues
from that token rather than starting a fresh session. Changing a participant's
resolved provider/model/selected-provider-config/tool/capability/workspace
identity or changing a completed/pending turn's prompt/schema/options for the
same turn key fails closed.

## 4.2 Supervised Worker Loop

Use a durable agent session when a supervisor should steer work between turns.
The conventional signal is `steer` (or `steer:<role>`) with payload
`{ message, from?, atMs }`. Drain it before composing each turn so the steer
content becomes part of that turn's durable prompt identity:

```ts
type Steer = { message: string; from?: string; atMs: number };

const session = ctx.agentSession({ key: "worker", provider: "codex" });
let done = false;
let i = 0;
let lastResult: TurnResult | null = null;

while (!done) {
  const steers = await ctx.drainSignals<Steer>(
    ctx.stepKey("steer", String(i)),
    "steer",
  );
  const turn = await session.turn({
    // Session turn keys must match [A-Za-z0-9_-]+.
    key: `turn_${i}`,
    prompt: compose(taskPrompt, lastResult, steers),
    schema: TurnResultSchema,
  });
  await ctx.checkpoint({
    key: ctx.stepKey("checkpoint", String(i)),
    message: turn.summary,
    data: { iteration: i, steerCount: steers.length },
  });
  lastResult = turn;
  done = turn.done;
  i++;
}
```

`drainSignals` never parks: it atomically consumes every signal currently
pending under that name in delivery order and returns `[]` when none are
pending. A completed drain replays its recorded batch without consuming later
arrivals; a crash before completion leaves the batch pending for retry. Use a
given signal name with either `ctx.signal` or `ctx.drainSignals`, not both.
Both consume the same FIFO, but mixing parking and draining on one name is hard
to reason about.

Signal delivery acknowledges durable enqueue and wake-start handling, not worker
uptake. A steer delivered during an agent turn is available at the next turn
boundary; observe the next checkpoint to confirm uptake.

## 4.3 Durable Commands (`ctx.command`)

Use `ctx.command` for workflow-owned, bounded host-side commands whose output
should affect later workflow logic or prompts: code maps, focused test
discovery, small static checks, or deterministic helper scripts. Do not use it
as an agent shell escape, a generic CI runner, or hidden workspace setup.

```ts
const workspace = await ctx.workspace({ key: "impl", mode: "worktree" });
const result = await ctx.command({
  key: "code-map",
  workspace,
  cwd: ".",
  mode: "argv",
  argv: ["bun", "scripts/code-map.ts", "--json"],
  capabilities: { fs: "workspace-write", shell: true, network: "none" },
  timeoutMs: 30_000,
  maxStdoutBytes: 200_000,
  maxStderrBytes: 32_000,
});
```

Rules:

- Pass a real `WorkspaceHandle`; raw paths are rejected.
- Pass a relative `cwd` under that workspace. Use `"."` for the root.
- Prefer `mode: "argv"`; use `mode: "shell"` only for compound shell syntax.
- Declare command `capabilities` explicitly. In v1 commands require
  `fs: "workspace-write"` and `shell: true`; provider `toolPolicy` does not
  apply.
- Set required `timeoutMs`, `maxStdoutBytes`, and `maxStderrBytes`.
- Use `failureMode: "return"` when the workflow should inspect nonzero exits,
  timeouts, or stderr and decide what to do.
- Command environments are explicit: base allowlist, `environment.vars`, and
  granted `environment.secrets`. Raw secret values stay out of identity and
  started events, but command output is not redacted if the process prints them.
- Completed command results replay. Pending commands are at-least-once after
  crash or interruption, so commands that mutate files or external systems
  should be idempotent or fail clearly when repeated.

The reusable implement/review workflows expose typed `completionChecks` for
command, clean-tree, commit, and pushed-branch gates. Prefer those gates over
prompt-only verification instructions when completion must be machine checked.

Use `ctx.workspace` when agents should run somewhere other than the default
direct workspace at `ctx.run.target`. Choose the mode deliberately:

- `direct`: intentional use of an existing directory.
- `worktree`: local git committed state with final-tree patch merge support.
  Add `branch: true` when the implementation should live on a generated
  Keel-owned branch instead of a detached worktree.
- `copy`: dirty local filesystem state without `.git` metadata. V1 excludes only
  `.git`, so pass a narrow `path` for large repos with caches or dependencies.
- `clone`: explicit local or remote git checkout. Use `repo: ctx.run.target` to
  clone the current repository; remote clone merge is unsupported.

Pass the returned handle explicitly or bind it with `ctx.withWorkspace`:

```ts
const workspace = await ctx.workspace({
  key: "implementation",
  mode: "worktree",
  // branch: true,
  retention: "retain-on-failure",
  setup: {
    capabilities: { fs: "workspace-write", shell: true, network: "none" },
    commands: [{ key: "install", command: "bun", args: ["install", "--frozen-lockfile"] }],
  },
});
await ctx.agent({ key: "impl", workspace, toolPolicy: "workspace-write", prompt });
```

Use workspace `setup` for preparation that must finish before an agent starts:
dependency installs, generated files, cache warmup, or repository bootstrap.
Setup output is retained as bounded diagnostics and is not returned to workflow
code. Use `ctx.command` instead when command stdout/stderr should influence
workflow branching or prompts. Setup can mutate direct workspaces, and pending
setup may run again after a crash.

Retention is `"remove"` (default), `"retain-on-failure"`, or `"retain"` and
applies only to Keel-owned `worktree`, `copy`, and `clone` workspaces. Direct
workspaces, including the default `__default` workspace at `ctx.run.target`, are
never removed by Keel and are not review diff staging areas. Workspace mode is
not a secret, filesystem, or network security boundary, and Keel never
auto-merges retained workspaces. For `worktree`, omitted `path` resolves through
the run's canonical `__default` direct workspace path, not daemon cwd. Generated
branches from `branch: true` are retained for manual inspection/cleanup; Keel
removes filesystem worktrees according to retention but does not delete branch
refs in this release.

For `ctx.agentSession` participants using Keel-owned workspaces, use
`"retain-on-failure"` or `"retain"` if a terminal failed run should be
retryable. Once terminal cleanup removes a session workspace, Keel fails closed
rather than resuming the existing backend conversation in a fresh empty
workspace.

## 5. Schemas

`jsonSchema` for structured agent output, `passthrough` for a plain step value:

```ts
const Findings = jsonSchema<{ findings: { title: string; file: string;
  severity: "high" | "medium" | "low"; detail: string }[] }>({
  type: "object", additionalProperties: false, required: ["findings"],
  properties: { findings: { type: "array", items: { type: "object",
    additionalProperties: false, required: ["title", "file", "severity", "detail"],
    properties: { title: { type: "string" }, file: { type: "string" },
      severity: { type: "string", enum: ["high", "medium", "low"] },
      detail: { type: "string" } } } } },
});
const out = passthrough<unknown>();
```

## 6. Example — adversarial code review

Several reviewers fan out by concern, findings are deduped in plain code, each one
gets an **adversarial verifier** that tries to refute it, and only confirmed
findings are kept. (Drop the verify phase for a plain review.)

```ts
import type { Ctx } from "@kcosr/keel";
import { jsonSchema, passthrough } from "@kcosr/keel";

type Finding = { title: string; file: string; severity: "high" | "medium" | "low"; detail: string };

const Findings = jsonSchema<{ findings: Finding[] }>({
  type: "object", additionalProperties: false, required: ["findings"],
  properties: { findings: { type: "array", items: { type: "object",
    additionalProperties: false, required: ["title", "file", "severity", "detail"],
    properties: { title: { type: "string" }, file: { type: "string" },
      severity: { type: "string", enum: ["high", "medium", "low"] }, detail: { type: "string" } } } } },
});
const Verdict = jsonSchema<{ real: boolean; reason: string }>({
  type: "object", additionalProperties: false, required: ["real", "reason"],
  properties: { real: { type: "boolean" }, reason: { type: "string" } },
});
const out = passthrough<unknown>();

export default async function adversarialReview(ctx: Ctx, input: { root: string }) {
  ctx.phase("Find");
  const lenses = ["security", "correctness", "error-handling"];
  const found = await Promise.all(lenses.map((lens) =>
    ctx.agent({
      key: ctx.stepKey("find", lens),
      prompt: `Review the code under ${input.root} for ${lens} issues. Read the files. Report each problem.`,
      schema: Findings, toolPolicy: "read-only", reasoning: "high", onFailure: "null", lenient: true,
    }),
  ));

  // Dedupe in plain code (deterministic — no agent).
  const seen = new Set<string>();
  const deduped = found.filter(Boolean).flatMap((f) => f!.findings).filter((f) => {
    const k = `${f.file}|${f.title.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  ctx.phase("Verify");
  const checked = await Promise.all(deduped.map((f) =>
    ctx.agent({
      key: ctx.stepKey("verify", `${f.file}|${f.title}`),
      prompt: `Adversarially verify this finding — try to REFUTE it. Is it real? Read ${f.file}.\n${JSON.stringify(f)}`,
      schema: Verdict, toolPolicy: "read-only", reasoning: "high", onFailure: "null", lenient: true,
    }).then((v) => (v?.real ? f : null)),
  ));
  const confirmed = checked.filter(Boolean) as Finding[];

  ctx.phase("Report");
  return ctx.step("report", out, { confirmed, raw: deduped.length }, (x) => ({
    confirmed: x.confirmed,
    confirmedCount: (x.confirmed as Finding[]).length,
    rawCount: x.raw,
  }));
}
```

## 7. Run It Inline

For one workflow, prefer `keel run` with a TypeScript heredoc. Put runtime
input in `--input`; stdin is the workflow source.

```bash
keel run --input '{"root":"/abs/path/to/code"}' <<'TS'
import { type Ctx, jsonSchema, passthrough } from "@kcosr/keel";

const Hostname = jsonSchema<{ hostname: string }>({
  type: "object",
  additionalProperties: false,
  required: ["hostname"],
  properties: { hostname: { type: "string" } },
});
const Out = passthrough<unknown>();

export default async function workflow(ctx: Ctx, input: { root: string }) {
  const report = await ctx.agent({
    key: "report-hostname",
    prompt: "Run hostname and return JSON with the hostname.",
    schema: Hostname,
    capabilities: { fs: "none", network: "none", shell: true, secrets: [] },
    lenient: true,
  });

  const confirm = await ctx.agent({
    key: "confirm-hostname",
    prompt: "Independently run hostname and confirm this value: " + report.hostname,
    schema: Hostname,
    capabilities: { fs: "none", network: "none", shell: true, secrets: [] },
    lenient: true,
  });

  return ctx.step("report", Out, { report, confirm, root: input.root }, (x) => ({
    root: x.root,
    reportedHostname: x.report.hostname,
    confirmedHostname: x.confirm.hostname,
    matches: x.report.hostname === x.confirm.hostname,
  }));
}
TS
```

## 8. Use `execute` For Orchestration

Use `keel execute` when you need a TypeScript control script to drive multiple
run operations. Avoid nesting a full workflow source string inside `execute`
unless you really need orchestration; nested template literals are easy to break.

Inside `execute`, use this TypeScript control surface:

```bash
keel execute -- "$RUN_ID" <<'TS'
const runId = args[0];
if (!runId) throw new Error("missing run id");
const settled = await keel.wait(runId, { timeoutMs: 30_000 });
const projection = await keel.get(runId);
const output = settled.status === "finished" ? await keel.output(runId) : null;
return { runId, status: settled.status, output, phase: projection?.phase ?? null };
TS
```

```ts
await keel.wait(runId);
await keel.get(runId);
await keel.report(runId);
await keel.output(runId);
await keel.retry(runId);
await keel.interrupt(runId, "operator inspection");
await keel.resume(runId);
await keel.signal(runId, "proceed", { ok: true });
await keel.approve(runId, "approve-deploy");
```

`interrupt` is resumable, not terminal cancellation: it stops active work
best-effort and parks the run as `interrupted`; only `resume` continues it.
`signal`, `approve`, and `deny` acknowledge durable delivery and wake-start
handling; call `keel.wait(runId)` afterwards when you need the final status or
output.

`execute` is stateless. Return the small JSON result the caller needs: usually
`runId`, `capabilityRef`, `status`, `output`, and any next-step context. Use
`execute` when the next action is computable from the prior result: start
fan-out, wait, retry, inspect output, shape JSON, or decide a simple branch.
Durable pauses, replayable workflow logic, and long-running state belong in the
workflow itself, not in `execute`.

## 9. Tips

- Use **absolute paths** for the code you're reviewing.
- On optional review fan-out agents, set **`toolPolicy: "read-only"`**, **`lenient:
  true`**, and **`onFailure: "null"`** so one flaky branch doesn't sink the run.
  For required agents, omit `onFailure` so failures can be retried.
- A run resumes from its immutable start-time workflow bundle. Helper edits
  affect only new launches, schedule replacements, or reruns with a new source
  override. Do not use retry/rewind/rerun to continue an interrupted run; resume
  it first.
- Use `run` for a single workflow; use `execute` only for mechanical
  follow-up across one or more runs.
