import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { KeelWebClient } from "../api/client";
import type { RunListItem, RunStatus } from "../api/types";
import { RunsScreen } from "./runs";

describe("RunsScreen", () => {
  test("groups live run projections and keeps each group newest first", async () => {
    const client = {
      listRuns: async () => ({
        runs: [
          run("run_old", "running", 10),
          run("run_done", "finished", 30),
          run("run_wait", "waiting-human", 20, "waiting_human"),
          run("run_new", "running", 40),
        ],
        page: page(4),
      }),
    } as KeelWebClient;

    render(<RunsScreen client={client} refreshKey={0} />);

    await screen.findByText("Needs Decision");
    expect(screen.getByText("Recently Finished")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Other" })).not.toBeInTheDocument();
    expect(
      Array.from(document.querySelectorAll(".run-group .section-title")).map(
        (heading) => heading.textContent,
      ),
    ).toEqual(["Active", "Recently Finished", "Needs Decision"]);

    const active = screen.getByRole("heading", { name: "Active" }).closest("section");
    expect(active).not.toBeNull();
    expect(
      within(active as HTMLElement)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["run_new", "run_old"]);
  });

  test("discloses when the browser run list is truncated", async () => {
    const client = {
      listRuns: async () => ({
        runs: [
          run("run_new", "running", 40),
          run("run_wait", "waiting-human", 20, "waiting_human"),
        ],
        page: page(150, { returned: 2, truncated: true }),
      }),
    } as KeelWebClient;

    render(<RunsScreen client={client} refreshKey={0} />);

    expect(await screen.findByText(/Showing the latest 2 of 150 runs/i)).toBeInTheDocument();
    expect(screen.getByText(/2 active on page/)).toBeInTheDocument();
    expect(screen.getByText(/1 blocked on page/)).toBeInTheDocument();
    expect(screen.getByText("2 shown")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /load older runs/i }));
    expect(window.location.hash).toContain("limit=200");
  });
});

function page(
  total: number,
  overrides: Partial<{
    limit: number;
    defaultLimit: number;
    maxLimit: number;
    returned: number;
    truncated: boolean;
  }> = {},
) {
  return {
    limit: 100,
    defaultLimit: 100,
    maxLimit: 500,
    returned: total,
    total,
    truncated: false,
    ...overrides,
  };
}

function run(
  runId: string,
  status: RunStatus,
  createdAtMs: number,
  blockageReason?: "waiting_human",
): RunListItem {
  return {
    runId,
    workflowName: "workflow",
    status,
    runTarget: "target-a",
    createdAtMs,
    finishedAtMs: status === "running" || status.startsWith("waiting") ? null : createdAtMs + 10,
    parentRunId: null,
    run: {
      runId,
      workflowName: "workflow",
      status,
      definitionVersion: "wf_sha",
      runTarget: "target-a",
      parentRunId: null,
      createdAtMs,
      finishedAtMs: null,
      nodes: [
        {
          stableKey: "step",
          effectType: "pure",
          status: status === "running" ? "pending" : "completed",
          attempt: 1,
          startedAtMs: createdAtMs,
          dependsOn: [],
          artifactBacked: false,
          checkpoint: null,
        },
      ],
      phase: null,
      error: null,
      stats: { steps: 1, agents: 0, checkpointCount: 0, artifacts: 0 },
    },
    blockage: blockageReason
      ? {
          reason: blockageReason,
          blockedOn: { stableKey: "gate", since: createdAtMs },
          context: "awaiting decision: approve",
        }
      : null,
    workspaceSummary: { count: 0 },
  };
}
