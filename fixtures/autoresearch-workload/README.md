# Autoresearch chaos harness

Run the repeatable Phase 4 matrix with:

```bash
bun test --isolate ./fixtures/autoresearch-workload/autoresearch.workload.test.ts
```

`workload-daemon.ts` starts a real `KeelDaemon` in a child process using only the caller-provided `KEEL_SOCKET`, `KEEL_DB`, and call-log paths. Tests create those paths in a realpathed temporary directory and delete them after each scenario. It never reads or writes `~/.keel`.

The scripted provider logs each invocation before returning, so its NDJSON file survives SIGKILL and exposes at-least-once re-execution across process boundaries. The MCP scenario starts the repository's actual `keel mcp` stdio CLI through the MCP SDK client.
