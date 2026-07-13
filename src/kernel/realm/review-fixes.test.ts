// Regression tests for review findings: helper-closure versioning (#1), resume
// uses immutable snapshots (#2), rerun persists override input + clears stale
// result (#3).

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JournalStore } from "../../journal/store.ts";
import { captureWorkflowFile } from "../../workflow-definitions/capture.ts";
import { RealmKernel } from "./realm-host.ts";

const FIX = new URL("./fixtures/", import.meta.url);
const url = (f: string) => captureWorkflowFile(new URL(f, FIX).pathname);

function fixed(store: JournalStore, extra: Record<string, unknown> = {}): RealmKernel {
  let id = 0;
  return new RealmKernel(store, {
    idgen: () => `run_${id++}`,
    clock: () => 1,
    rng: () => 0.5,
    ...extra,
  });
}

describe("#1 helper-closure versioning", () => {
  test("editing a module helper re-executes the step that calls it", async () => {
    const store = JournalStore.memory();
    const exec: string[] = [];
    const k = fixed(store, { onStepExecute: (key: string) => exec.push(key) });

    const first = await k.run<number>(
      url("helper-v1.workflow.ts"),
      { n: 5 },
      {
        name: "h",
        target: process.cwd(),
      },
    );
    expect(first.output).toBe(10); // 5 * 2
    expect(exec).toEqual(["compute"]);
    exec.length = 0;

    // Same fn body, but the `transform` helper changed (×2 → ×3).
    const second = await k.rerun<number>("run_0", url("helper-v2.workflow.ts"));
    expect(second.output).toBe(15); // 5 * 3 — the step RE-EXECUTED
    expect(exec).toEqual(["compute"]);
  });

  test("extensionless relative helper imports are captured and versioned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-helper-import-"));
    try {
      const workflow = join(dir, "wf.ts");
      const helper = join(dir, "helper.ts");
      writeFileSync(
        workflow,
        `
          import { transform } from "./helper";
          export default async function wf(ctx, input) {
            const Schema = { parse: (v) => v };
            return ctx.step("compute", Schema, { n: input.n }, ({ n }) => transform(n));
          }
        `,
      );
      writeFileSync(helper, "export function transform(n) { return n * 2; }\n");

      const store = JournalStore.memory();
      const exec: string[] = [];
      const kernel = fixed(store, {
        definitionCacheRoot: join(dir, "definitions"),
        onStepExecute: (key: string) => exec.push(key),
      });
      const first = await kernel.run<number>(
        captureWorkflowFile(workflow),
        { n: 5 },
        {
          target: dir,
        },
      );
      expect(first.output).toBe(10);
      expect(exec).toEqual(["compute"]);

      exec.length = 0;
      writeFileSync(helper, "export function transform(n) { return n * 3; }\n");
      const second = await kernel.rerun<number>("run_0", {
        ...captureWorkflowFile(workflow),
        input: { n: 5 },
      });
      expect(second.output).toBe(15);
      expect(exec).toEqual(["compute"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#2 resume uses immutable workflow snapshots", () => {
  test("resuming a non-terminal run ignores a caller-supplied mutable workflow path", async () => {
    const store = JournalStore.memory();
    // start a run and abort it (leave non-terminal) using the clean fixture
    const k1 = fixed(store, {
      fault: (p: string, key: string) => {
        if (p === "after-pending" && key === "compute") throw new Error("CRASH");
      },
    });
    await k1
      .run(url("helper-v1.workflow.ts"), { n: 1 }, { name: "h", target: process.cwd() })
      .catch(() => null);
    expect(store.getRun("run_0")?.status).toBe("running");

    // The supplied path is ignored for snapshotted runs; resume uses the stored
    // immutable definition hash from launch.
    const resumed = await fixed(store).resume<number>("run_0");
    expect(resumed.status).toBe("finished");
    expect(resumed.output).toBe(2);
  });

  test("resume succeeds after the original workflow file is deleted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-snapshot-"));
    try {
      const workflow = join(dir, "snapshot.workflow.ts");
      const cacheRoot = join(dir, "definitions");
      writeFileSync(
        workflow,
        `
          export default async function wf(ctx, input) {
            const Schema = { parse: (v) => v };
            return ctx.step("compute", Schema, { n: input.n }, ({ n }) => n * 2);
          }
        `,
      );

      const store = JournalStore.memory();
      const k1 = fixed(store, {
        definitionCacheRoot: cacheRoot,
        fault: (p: string, key: string) => {
          if (p === "after-pending" && key === "compute") throw new Error("CRASH");
        },
      });
      const captured = captureWorkflowFile(workflow);
      await k1.run(captured, { n: 7 }, { name: "snapshot", target: dir }).catch(() => null);
      expect(store.getRun("run_0")?.status).toBe("running");
      expect(store.getRun("run_0")?.definitionVersion.startsWith("wf_sha256_")).toBe(true);

      rmSync(workflow);

      const resumed = await fixed(store, { definitionCacheRoot: cacheRoot }).resume<number>(
        "run_0",
      );
      expect(resumed.status).toBe("finished");
      expect(resumed.output).toBe(14);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("resume succeeds after an imported helper file is deleted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-snapshot-helper-"));
    try {
      const workflow = join(dir, "snapshot.workflow.ts");
      const helper = join(dir, "helper.ts");
      const cacheRoot = join(dir, "definitions");
      writeFileSync(helper, "export function transform(n) { return n * 2; }\n");
      writeFileSync(
        workflow,
        `
          import { transform } from "./helper";
          export default async function wf(ctx, input) {
            const Schema = { parse: (v) => v };
            return ctx.step("compute", Schema, { n: input.n }, ({ n }) => transform(n));
          }
        `,
      );

      const store = JournalStore.memory();
      const k1 = fixed(store, {
        definitionCacheRoot: cacheRoot,
        fault: (p: string, key: string) => {
          if (p === "after-pending" && key === "compute") throw new Error("CRASH");
        },
      });
      await k1
        .run(captureWorkflowFile(workflow), { n: 7 }, { name: "snapshot", target: dir })
        .catch(() => null);
      expect(store.getRun("run_0")?.status).toBe("running");

      rmSync(helper);
      rmSync(workflow);

      const resumed = await fixed(store, { definitionCacheRoot: cacheRoot }).resume<number>(
        "run_0",
      );
      expect(resumed.status).toBe("finished");
      expect(resumed.output).toBe(14);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("legacy non-snapshot runs fail closed instead of using workflow_ref", async () => {
    const store = JournalStore.memory();
    store.insertRun({
      runId: "run_legacy",
      workflowName: "legacy",
      definitionVersion: "v0",
      workflowRef: "client-file:/tmp/helper-v1.workflow.ts",
      status: "running",
      parentRunId: null,
      tenantId: null,
      inputRef: '{"n":1}',
      outputRef: null,
      errorJson: null,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      launchAuthorityJson: null,
      createdAtMs: 1,
    });

    await expect(fixed(store).resume("run_legacy")).rejects.toThrow(
      /no immutable workflow definition snapshot/,
    );
  });

  test("missing snapshot rows fail closed", async () => {
    const store = JournalStore.memory();
    store.insertRun({
      runId: "run_missing_snapshot",
      workflowName: "missing",
      definitionVersion: "wf_sha256_missing",
      workflowRef: "client-file:/tmp/helper-v1.workflow.ts",
      status: "running",
      parentRunId: null,
      tenantId: null,
      inputRef: '{"n":1}',
      outputRef: null,
      errorJson: null,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      launchAuthorityJson: null,
      createdAtMs: 1,
    });

    await expect(fixed(store).resume("run_missing_snapshot")).rejects.toThrow(
      /workflow definition wf_sha256_missing not found/,
    );
  });

  test("external package imports are rejected by source capture", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-external-drift-"));
    try {
      const pkgRoot = join(dir, "node_modules", "pkg");
      mkdirSync(pkgRoot, { recursive: true });
      writeFileSync(join(pkgRoot, "package.json"), '{"name":"pkg","type":"module"}\n');
      writeFileSync(join(pkgRoot, "index.js"), "export const value = 2;\n");
      writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
      const workflow = join(dir, "wf.ts");
      writeFileSync(
        workflow,
        `
          import { value } from "pkg";
          export default async function wf(ctx, input) {
            const Schema = { parse: (v) => v };
            return ctx.step("compute", Schema, { n: input.n }, ({ n }) => n * value);
          }
        `,
      );

      const store = JournalStore.memory();
      expect(() => captureWorkflowFile(workflow)).toThrow(/only @kcosr\/keel is supported/);
      expect(store.listRuns()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#3 rerun persists override input and clears stale result", () => {
  test("an override input is persisted; a later input-less rerun uses it", async () => {
    const store = JournalStore.memory();
    const k = fixed(store);
    await k.run<number>(
      url("helper-v1.workflow.ts"),
      { n: 5 },
      {
        name: "h",
        target: process.cwd(),
      },
    );
    expect(JSON.parse(store.getRun("run_0")?.inputRef ?? "null")).toEqual({ n: 5 });

    // rerun with an override input
    const r1 = await k.rerun<number>("run_0", {
      ...url("helper-v1.workflow.ts"),
      input: { n: 9 },
    });
    expect(r1.output).toBe(18);
    expect(JSON.parse(store.getRun("run_0")?.inputRef ?? "null")).toEqual({ n: 9 });

    // a later input-less rerun uses the persisted (n:9) input, not the original (n:5)
    const r2 = await k.rerun<number>("run_0", url("helper-v1.workflow.ts"));
    expect(r2.output).toBe(18);
  });
});
