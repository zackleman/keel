# Supervisor MCP Server

`keel mcp` runs a local MCP server over stdio. It connects to the existing Keel
daemon Unix socket and exposes daemon RPC operations; it does not open the
journal database or implement a second control plane.

Configure an MCP client to spawn the command with the daemon socket and an admin
credential in its environment:

```json
{
  "command": "keel",
  "args": ["mcp"],
  "env": {
    "KEEL_SOCKET": "/home/me/.keel/keel.sock",
    "KEEL_ADMIN_TOKEN": "kc_admin_..."
  }
}
```

The credential chain matches the CLI: `KEEL_ADMIN_TOKEN`, then `KEEL_RUN_CAP`,
then a JSON `KEEL_CAP_FILE`. Admin authority is required for `list_runs` and
`decide_approval`. A run token creates a least-privilege server instance that
can inspect, watch, signal, interrupt, and resume exactly that run, subject to
the capability's actions, but cannot list runs or decide approvals.

## Tools

| Tool | Result |
|---|---|
| `list_runs` | Bounded newest-run summary page; optional `children_of` returns direct children only. |
| `watch_run` | Compact status, phase, and blockage polling result. |
| `get_run_detail` | Canonical `RunProjection`, optionally paired with its report. |
| `get_state` | Current run-scoped state, optionally filtered to one namespace. |
| `get_run_blockage` | Waiting reason and an `approvalId` for a pending human gate. |
| `tail_checkpoints` | Bounded durable `checkpoint` event page. |
| `tail_events` | Bounded durable event page, optionally filtered by event type. |
| `send_signal` | Durable signal delivery and wake-start acknowledgement. |
| `decide_approval` | Approve or deny an `approvalId`; admin only. |
| `interrupt_run` | Interrupt a non-terminal run. |
| `resume_run` | Resume an interrupted or otherwise resumable run. |
| `launch_saved_workflow` | Launch `name` or `name@version`; returns only `runId`. |
| `wait_for_run` | Wait for the next terminal or parked outcome. |

`tail_events` and `tail_checkpoints` return `{frames, nextCursor}`. They expose
durable frames only. Persist `nextCursor` after processing a page and pass it as
the next `afterSeq`; ephemeral live deltas are intentionally excluded.

## Supervisor Pattern

1. Launch a reviewed saved workflow with `launch_saved_workflow`.
2. Poll `watch_run` for its compact state.
3. Read progress with `tail_checkpoints`, persisting `nextCursor` after each page,
   and inspect live workflow state with `get_state`.
4. Use `send_signal` to steer workflows that consume that signal.
5. When `get_run_blockage` reports `waiting_human`, pass its `approvalId` to
   `decide_approval`.
6. Use `interrupt_run` to stop active work and `resume_run` when it may proceed.

Signal and approval tools acknowledge durable delivery and any accepted wake;
they do not wait for subsequent workflow work. All tool output uses Keel's
capability-token redaction, and saved-workflow launch never returns the minted
run capability.

Version 1 is local stdio plus the local Unix socket. Remote transport and
credential wiring are deliberately deferred.
