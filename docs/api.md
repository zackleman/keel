# API Reference

## Purpose

This page orients API callers to Keel's daemon contract without duplicating every
TypeScript shape. The source of truth for exact request, response, and projection
types is:

- `src/rpc/contract.ts` for the `KeelApi` interface and RPC request/response
  types.
- `src/rpc/projection.ts` for `RunProjection`, `RunReport`, `RunSummary`,
  `RunSummaryPage`,
  schedule projections, and blockage/read-model shapes.
- `src/daemon/gateway.ts` for socket/RPC authorization and transport method
  names.
- `src/execute/runtime.ts` for the smaller `keel execute` wrapper API.

When this document and source differ, source wins and this document should be
updated in the same branch.

## Contract Model

Public callers use the daemon RPC/gateway operation boundary. Most operations
map directly to the daemon-owned `KeelApi`; signal delivery and approval
decisions are gateway methods that persist input and trigger eligible wakes. The
CLI and `keel execute` are adapters over that boundary; planned web and MCP
surfaces should also adapt the same operations and projections rather than
reconstructing state independently.

Run-starting methods return after work is accepted, not after workflow
completion. Use `waitForRun`, `subscribeEvents`, `keel watch`, or the TUI to
observe progress.

## Operation Families

| Family | RPC methods | CLI surface | Execute surface | Notes |
|---|---|---|---|---|
| Run launch | `launchRun`, `launchSavedWorkflow` | `launch`, `run`, `workflow launch`, `workflow run` | `keel.launch` | Launch mints a run capability for follow-up run-scoped operations. Request `runSecrets`/`--secret*` here when agents use `environment.secrets`. |
| Run reads | `listRuns`, `listRunsPage`, `getRun`, `getRunState`, `getRunReport`, `getRunOutput`, `getBlockage` | `list`, `get`, `report`, `output` | `keel.get`, `keel.report`, `keel.output`, `keel.blockage` | `listRuns` remains the unbounded CLI/TUI summary source; `listRunsPage({ limit })` returns newest summaries plus total count for bounded browser inboxes and rejects limits above 500. RPC `getRunOutput` returns the current run outcome; CLI `output` and execute `keel.output` require finished output. `getBlockage` may return diagnostic `running`; report/projection surfaces render only actionable blockage such as agent concurrency queues, durable waits, interruptions, or stale owner heartbeats. |
| Run events/wait | `waitForRun`, `subscribeEvents` | `watch`; attached lifecycle commands reuse watch formatting | `keel.wait`, `keel.events` | Durable events backfill by sequence; ephemeral live frames are not replayed. |
| Run lifecycle | `resumeRun`, `retryRun`, `rewindRun`, `forkRun`, `interruptRun`, `rerunRun` | `resume`, `retry`, `rewind`, `fork`, `interrupt`; no CLI rerun command | `keel.resume`, `keel.retry`, `keel.rewind`, `keel.fork`, `keel.interrupt`; no execute rerun helper | `retryRun`, `rewindRun`, and RPC-only `rerunRun` accept fresh `runSecrets` for re-executed agents. |
| Signals and approvals | gateway `sendSignal`, gateway `decideApproval` | `signal`, `approve`, `deny` | `keel.signal`, `keel.approve`, `keel.deny` | Signal uses run authority; approval decisions are admin-only. Delivery acknowledges durable input plus wake start; it does not wait for resumed work to finish. |
| Schedules | `putSchedule`, `listSchedules`, `getSchedule` | `schedule put`, `schedule list`, `schedule show` | `keel.listSchedules`, `keel.getSchedule` | Execute exposes read operations only. |
| Saved workflows | `saveWorkflow`, `listSavedWorkflows`, `getSavedWorkflow`, `getSavedWorkflowSource`, `launchSavedWorkflow`, lifecycle setters/deleters | `workflow save`, `install`, `list`, `show`, `source`, `launch`, `run`, `enable`, `disable`, `enable-version`, `disable-version`, `deprecate`, `delete`, `delete-version` | deferred | Saved workflow versions pin immutable workflow definition hashes. |
| Workflow definitions | `previewWorkflowDefinition`, `getWorkflowDefinitionSource`, `gcDefinitions` | `workflow source`, `gc`; preview is used by `workflow install` | deferred | Definition source is journal-backed and does not read original client paths. |
| Workspaces | `listRunWorkspaces`, `getRunWorkspace`, `getRunWorkspaceDiff`, `mergeRunWorkspace`, `discardRunWorkspace`, `gcWorkspaces` | `workspace list`, `show`, `diff`, `merge`, `discard`, `gc` | `keel.listRunWorkspaces`, `keel.getRunWorkspace`, `keel.getRunWorkspaceDiff`, `keel.mergeRunWorkspace`, `keel.discardRunWorkspace`, `keel.gcWorkspaces` | Read/diff is run-scoped; merge/discard/GC are admin operations. |
| Agent profiles | `listAgentProfiles`, `getAgentProfile`, `putAgentProfile`, `deleteAgentProfile`, `checkAgentProfile` | `profiles list`, `get`, `set`, `delete`, `check` | deferred | Runs snapshot effective programmatic plus persistent catalog profiles at launch/rerun. |
| Settings | `listSettings`, `getSetting`, `putSetting`, `deleteSetting`, `checkSetting` | `settings list`, `get`, `set`, `unset`, `check` | deferred | Runs snapshot workflow-visible settings at launch/rerun. Daemon-operational settings such as agent concurrency limits are read by the daemon at their documented apply boundary. |

## Launch Source And Targets

`LaunchRequest.source` is `WorkflowSourceInput`, not a filesystem path. The CLI
captures workflow source before sending it to the daemon:

- stdin/inline launches are single-module source;
- file launches capture the static local `.ts`/`.tsx` helper import graph;
- the daemon never opens the original client path.

`target` is the daemon-resolvable run target used by the default direct
workspace. Path-based CLI launches default it from the invoking cwd unless
`--target` is provided. Saved workflow launches and saved-ref schedules resolve
target in this order: explicit request target, then saved workflow default
target. Raw RPC callers must provide a non-empty target where required by the
gateway/daemon boundary.

`LaunchRequest.runSecrets` and `LaunchSavedWorkflowRequest.runSecrets` are
trusted-local raw secret values keyed by environment variable name. They are not
persisted in the journal; the daemon stores them in its in-memory side channel
for the run and wipes them when the run reaches a terminal cleanup path. The same
shape is accepted on `retryRun`, `rewindRun`, and `rerunRun` options for agents
that re-execute after the original values have expired or rotated. The web
transport rejects these raw secret fields until Keel has a browser-specific
local secret authorization model.

## Authority Notes

Capabilities are enforced by resource/action, not by client type:

- Launch on the local socket is open; the returned run capability controls
  follow-up run-scoped operations.
- `run:read`, `run:watch`, `run:events`, `run:output`, `run:source`,
  `run:resume`, `run:interrupt`, `run:retry`, `run:rewind`, `run:fork`, and
  `run:signal` authorize run-scoped operations.
- `workflow:read`, `workflow:run`, and `workflow:save` authorize scoped saved
  workflow operations where supported.
- `admin` is required for daemon-wide lists, schedules, settings/profiles,
  approval decisions, workflow install/list/delete, direct definition lookup,
  workspace merge/discard/GC, and definition GC.

See `docs/control-surfaces.md` for the cross-surface status matrix.

## Event Delivery

`EventEnvelope` is either durable or ephemeral:

- Durable events have `kind: "durable"` and a per-run monotonic `seq`.
- Ephemeral events have `kind: "ephemeral"` and no durable sequence.
- `subscribeEvents({ runId, cursor }, onEvent)` accepts `beginning`,
  `after-seq`, `tail`, and `now` cursors, then tails new durable events and live
  ephemeral frames after catch-up.
- Late subscribers do not receive past ephemeral frames.
- `RunProjection.state` contains the current bounded materialized state: inline
  values up to 1 KiB and `{ $artifact, byteLen }` stubs above it.
- `getRunState(runId, namespace?)` resolves values up to 64 KiB and returns
  larger values as the same artifact stub. It requires `run:read`.
- Completed `ctx.checkpoint` calls appear as canonical projection nodes with a
  `checkpoint: { message, data }` payload and append a durable `checkpoint`
  event in the same transaction as checkpoint completion.
- `listRunsPage({ limit, parentRunId? })` optionally returns only direct children
  and reports a filtered `total`. Child projections expose the same
  `parentRunId` lineage used by `ctx.spawn`.

`keel watch --output text` and the TUI format event streams for humans; scripts
should prefer JSON/NDJSON or direct API calls.

See `docs/events.md` for the shared cursor and stream-boundary contract.

Start and wake operations that can be followed by a stream return an
`attachCursor`; callers can subscribe from that cursor to observe the accepted
operation without replaying stale pre-operation history.

## Execute Wrapper

`keel execute` injects a smaller `keel` object for stateless control scripts.
It intentionally does not expose the full `KeelApi`; for example, saved workflow
management, profile/settings management, definition GC, and `rerunRun` are not
execute helpers at this baseline. Execute helpers authenticate with captured run
capabilities where possible and restore the control credential for admin-only
operations.
