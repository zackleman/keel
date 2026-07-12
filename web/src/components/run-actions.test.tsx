import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { KeelWebClient } from "../api/client";
import type { RunProjection } from "../api/types";
import { RunActions } from "./run-actions";

describe("RunActions", () => {
  afterEach(cleanup);

  test("confirms and executes the eligible primary action", async () => {
    const client = { retryRun: vi.fn(async () => ({})) } as unknown as KeelWebClient;
    const onChanged = vi.fn();
    render(
      <RunActions
        client={client}
        run={failedRun()}
        authorization={authorization()}
        onChanged={onChanged}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry failed step" }));
    const dialog = screen.getByRole("dialog", { name: "Retry failed step run" });
    expect(within(dialog).getByText("run_1")).toBeInTheDocument();
    expect(within(dialog).getByText("run:retry")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Retry failed step" }));

    await waitFor(() => expect(client.retryRun).toHaveBeenCalledWith("run_1"));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  test("keeps ineligible actions visible with their reason", () => {
    render(
      <RunActions
        client={{} as KeelWebClient}
        run={failedRun()}
        authorization={authorization()}
        onChanged={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menuitem", { name: /resume/i })).toBeDisabled();
    expect(screen.getByText("Resume is available only for interrupted runs.")).toBeInTheDocument();
  });

  test("closes the fork dialog before navigating to the child run", async () => {
    const client = {
      forkRun: vi.fn(async () => ({ runId: "run_child" })),
    } as unknown as KeelWebClient;
    render(
      <RunActions
        client={client}
        run={failedRun()}
        authorization={authorization()}
        onChanged={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /fork/i }));
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    await waitFor(() => expect(client.forkRun).toHaveBeenCalledWith("run_1", "plan"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(window.location.hash).toBe("#/runs/run_child");
  });

  test("dismisses the action dialog with Escape", () => {
    render(
      <RunActions
        client={{} as KeelWebClient}
        run={failedRun()}
        authorization={authorization()}
        onChanged={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry failed step" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

function failedRun(): RunProjection {
  return {
    runId: "run_1",
    workflowName: "review",
    definitionVersion: "wf_1",
    runTarget: "/tmp/work",
    parentRunId: null,
    status: "failed",
    phase: null,
    createdAtMs: 1,
    finishedAtMs: 2,
    error: { name: "Error", message: "failed" },
    stats: { steps: 1, agents: 1, checkpointCount: 0, artifacts: 0 },
    state: {},
    nodes: [
      {
        stableKey: "plan",
        effectType: "effectful",
        status: "failed",
        attempt: 1,
        startedAtMs: 1,
        dependsOn: [],
        artifactBacked: false,
        checkpoint: null,
      },
    ],
  };
}

function authorization() {
  return {
    resume: true,
    interrupt: true,
    retry: true,
    rerun: true,
    rewind: true,
    fork: true,
    signal: true,
    decideApproval: false,
  };
}
