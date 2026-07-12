# Autoresearch workload

A deterministic, autoresearch-style supervised loop used by the Phase 4 durability matrix.

The workflow deliberately uses keyed `ctx.agent` calls rather than `ctx.agentSession`: source-override reruns reject durable sessions by design. Each iteration drains `steer`, runs a typed optional experiment, applies a score-based keep/revert in plain workflow code, emits a durable checkpoint, and optionally parks for a cooldown. A recorder agent and optional human ship gate close the run.

The scripted fixture provider under `fixtures/autoresearch-workload/` targets the durability and steering machinery, not model quality. Its responses cover a kept experiment, an invalid optional experiment that journals `null`, and a later improvement.
