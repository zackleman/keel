# Phase 4 workload test results

**Date:** 2026-07-11  
**Branch:** `feat/workload-test`  
**Runtime:** macOS, Bun 1.3.14  
**Workload:** `workflows/autoresearch/autoresearch.workflow.ts`

## Workload

The saved `autoresearch@1` workflow runs a typed setup agent, then three experiment iterations. Each iteration drains `steer`, runs a typed `ctx.agent` with `onFailure: "null"`, deterministically keeps or reverts the result by score, emits a checkpoint, and optionally sleeps. A recorder agent and optional `ctx.human` ship gate finish the run.

The workload uses the deterministic provider in `fixtures/autoresearch-workload/scripted-provider.ts`. This keeps the durability exercise repeatable and free: no external model was called and model token usage was zero.

## Chaos matrix

| Item | Outcome | Evidence |
| --- | --- | --- |
| SIGKILL mid-turn, then restart | **PASS** | The daemon was killed while `experiment:1#1` was pending. Before restart the run was `running`, the row was `pending`, and only `checkpoint:0` existed. Orphan recovery completed the same attempt. Cross-process call log keys were `setup, experiment:0, experiment:1, experiment:1, experiment:2, recorder`: the completed prefix replayed, while the pending provider call re-executed at-least-once. Final projection reported four checkpoints and the durable checkpoint keys were unique. |
| Delayed restart from sleep, signals queued while down | **PASS** | The daemon was killed at `waiting-timer` after iteration 0. Two durable `steer` rows were inserted while no daemon process or socket existed, then restart was delayed past the timer deadline and stale-owner window. `experiment:1` received both messages in FIFO order and `checkpoint:1.data.steers` was `[{"message":"queued-one"},{"message":"queued-two"}]`. |
| MCP steer mid-run | **PASS** | The real `keel mcp` stdio process called `send_signal` while `experiment:1` was pending. Tier-1 delivery appeared in the next turn: the `experiment:2` prompt contained `focus on parser`, and `checkpoint:2.data.steers` contained the same message. |
| Edit late prompt + source-override rerun | **PASS** | The v2 fixture changes only the final-iteration instruction. The post-rerun provider call suffix was exactly `experiment:2`; `experiment:0`, `experiment:1`, and `recorder` had no attempt 2, while `experiment:2#2` completed. Its byte-identical output triggered early cutoff, so the recorder replayed. `checkpoint:0` remained a single event. |
| MCP approval park + answer | **PASS** | The run parked with blockage `waiting_human` and approval ID `<runId>:ship`. The real stdio MCP client called `decide_approval(..., "approved", "ship it")`; the run finished with `approval: {status:"approved", note:"ship it"}`. |
| MCP checkpoint cursor resume | **PASS** | MCP client process 1 read two checkpoint frames and persisted `nextCursor`, then closed. A fresh `keel mcp` process read from that cursor. The union contained all four journal checkpoint frames, four distinct monotonically increasing sequence numbers, and no overlap. |

Focused execution:

```text
5 pass
0 fail
31 expect() calls
Ran 5 tests across 1 file. [8.90s]
```

Individual measured times after review hardening were approximately 63 ms for the in-process workflow smoke, 625 ms for SIGKILL recovery, 1.76 s for delayed restart, 134 ms for suffix invalidation, and 6.14 s for the combined MCP steering/approval/cursor scenario.

## Findings

### Phase 1–3 bugs

No kernel, journal, daemon, or MCP bug was found. The Phase 1 checkpoint timeline remained duplicate-free, Phase 3 drains preserved FIFO uptake across restart, and Phase 2's stdio tools steered and approved the live run correctly.

One plan phrase needs a precise interpretation: a pending external agent effect is at-least-once, so the provider invocation interrupted by SIGKILL ran twice. “No duplicate agent turns” can only mean no duplicate **completed journal attempt or downstream durable event**; literal single provider invocation would contradict Keel's preserved crash invariant. No kernel change was made.

### Operational friction

- The MCP surface launches saved workflows but does not save them, so test setup saved `autoresearch@1` through the admin daemon RPC before handing supervision to MCP.
- No RPC/MCP client can send while the daemon and Unix socket are down. The downtime queue case therefore inserted signal rows through `JournalStore`, the same durable store used by daemon delivery. This is fault injection, not a claim that an offline remote client can enqueue through a nonexistent transport.
- `wait_for_run` returns at sleep and human parks, so terminal supervisors must poll `watch_run` or loop waits. The harness used explicit status polling.
- `ctx.agentSession` was intentionally not used because source-override reruns reject session-bearing runs. Keyed `ctx.agent` is the correct workload shape for this matrix.

### Phase 5 and Phase 7 signal

The workflow rebuilt `best` and `history` correctly from journaled results after hard restart, so Phase 5 state is not needed for correctness. It would improve supervisor inspection and cross-turn shared-state ergonomics.

The 1.5 s simulated in-flight turn accepted a steer at the next effect boundary without ambiguity. Phase 4 produced no evidence that Tier-2 mid-turn injection is needed; Phase 7 should remain optional.

## Verification commands

```bash
bun test --isolate ./fixtures/autoresearch-workload/autoresearch.workload.test.ts
bun run typecheck
bun run lint
bun test --isolate ./src ./workflows ./fixtures
```

Final repository gate: typecheck and lint passed; the full suite printed **741 pass, 10 skip, 20 fail** across 79 files in 117.06 s. Every failure is in the Phase 0 documented macOS realpath family (including its listed flaky extensions); the autoresearch workload remained 5/5 green and no new failure appeared.
