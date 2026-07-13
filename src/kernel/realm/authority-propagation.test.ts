import { describe, expect, test } from "bun:test";
import { JournalStore } from "../../journal/store.ts";
import { authorityForCeilingProfile } from "../../policy/launch-authority.ts";
import { RealmKernel } from "./realm-host.ts";

const overCeilingWorkflow = {
  name: "authority-propagation",
  source: `
    import { type Ctx } from "@kcosr/keel";

    export default async function workflow(
      ctx: Ctx,
      input: { continueFirst?: boolean; unsafe?: boolean },
    ): Promise<string> {
      if (input.continueFirst) {
        await ctx.continueAsNew({ unsafe: true });
      }
      if (!input.unsafe) return "safe";

      const workspace = await ctx.workspace({
        key: "workspace",
        mode: "direct",
        path: ctx.run.target,
      });
      await ctx.command({
        key: "over-ceiling",
        workspace,
        cwd: ".",
        mode: "argv",
        argv: ["/bin/echo", "escaped"],
        capabilities: {
          fs: "workspace-write",
          shell: true,
          network: "none",
          secrets: [],
        },
        timeoutMs: 1_000,
        maxStdoutBytes: 1_000,
        maxStderrBytes: 1_000,
      });
      return "escaped";
    }
  `,
};

describe("launch authority propagation", () => {
  test("continueAsNew successor still rejects an over-ceiling effect", async () => {
    const store = JournalStore.memory();
    let id = 0;
    const kernel = new RealmKernel(store, { idgen: () => `continue-${id++}` });

    const first = await kernel.launch<{ continuedTo: string }>(
      overCeilingWorkflow,
      { continueFirst: true },
      {
        target: process.cwd(),
        launchAuthority: authorityForCeilingProfile("untrusted-default"),
      },
    ).done;

    expect(first.status).toBe("continued");
    await until(() => store.getRun("continue-1")?.status === "failed");
    expect(store.getRun("continue-1")?.errorJson).toContain("CapabilityCeilingError");
    expect(store.getRun("continue-1")?.errorJson).toContain("ctx.command");
  });

  test("forked run still rejects an over-ceiling effect", async () => {
    const store = JournalStore.memory();
    let id = 0;
    const kernel = new RealmKernel(store, { idgen: () => `fork-${id++}` });

    const source = await kernel.launch<string>(
      overCeilingWorkflow,
      { unsafe: false },
      {
        target: process.cwd(),
        launchAuthority: authorityForCeilingProfile("untrusted-default"),
      },
    ).done;
    expect(source.status).toBe("finished");

    const forkedRunId = kernel.fork(source.runId, { newRunId: "forked" });
    await expect(kernel.rerun(forkedRunId, { input: { unsafe: true } })).rejects.toThrow(
      /exceeds launch-authority ceiling/,
    );
    expect(store.getRun(forkedRunId)?.status).toBe("failed");
  });
});

async function until(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) return;
    await Bun.sleep(25);
  }
  throw new Error("condition was not met before timeout");
}
