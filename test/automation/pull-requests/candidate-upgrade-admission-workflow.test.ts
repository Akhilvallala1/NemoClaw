// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { readYaml, type WorkflowJob } from "../../helpers/e2e-workflow-contract";

const workflow = readYaml<{ jobs: Record<string, WorkflowJob> }>(
  ".github/workflows/candidate-upgrade-admission.yaml",
);
const steps = workflow.jobs["candidate-upgrade-admission"]!.steps!;
const start = steps.find((step) => step.id === "identity")!.with!.script as string;
const finish = steps.find((step) => step.name === "Report current candidate upgrade admission")!
  .with!.script as string;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;
const head = "a".repeat(40);
const base = "b".repeat(40);

function fixture() {
  const pr = {
    state: "open",
    head: { sha: head, repo: { full_name: "NVIDIA/NemoClaw" } },
    base: { sha: base, ref: "main", repo: { full_name: "NVIDIA/NemoClaw" } },
  };
  const context = {
    eventName: "pull_request_target",
    repo: { owner: "NVIDIA", repo: "NemoClaw" },
    serverUrl: "https://github.com",
    runId: 456,
    payload: {
      pull_request: { number: 123 },
      issue: { number: 123, pull_request: {} },
      comment: { body: `NemoClaw-Upgrade-E2E: approve ${head} ${base}` },
      changes: { body: { from: "" } },
    },
  };
  const outputs: Record<string, string> = {};
  const status = vi.fn(async (_value: unknown) => ({}));
  const get = vi.fn(async () => ({ data: pr }));
  const github = { rest: { pulls: { get }, repos: { createCommitStatus: status } } };
  return {
    pr,
    context,
    status,
    outputs,
    get,
    start: () =>
      new AsyncFunction("github", "context", "core", start)(github, context, {
        setOutput: (name: string, value: string) => {
          outputs[name] = value;
        },
      }),
    finish: (outcome: string) =>
      new AsyncFunction("github", "context", "process", finish)(github, context, {
        env: {
          UPGRADE_PR_NUMBER: "123",
          UPGRADE_CANDIDATE_SHA: head,
          UPGRADE_BASE_SHA: base,
          UPGRADE_OUTCOME: outcome,
        },
      }),
  };
}

describe("candidate upgrade admission status", () => {
  it("does not admit a PR closed during verification", async () => {
    const f = fixture();
    await f.start();
    f.pr.state = "closed";
    await f.finish("success");
    expect(f.status).toHaveBeenLastCalledWith(expect.objectContaining({ state: "failure" }));
  });

  it.each(["approve", "revoke", "quoted approve"])(
    "invalidates the merge status for %s without granting permission",
    async (action) => {
      const f = fixture();
      f.context.eventName = "issue_comment";
      f.context.payload.comment.body = `NemoClaw-Upgrade-E2E: ${action} ${head} ${base}`;
      await f.start();
      expect(f.status).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sha: head,
          context: "check-hash",
          state: "pending",
        }),
      );
      expect(f.outputs).toEqual({ pr_number: "123", head_sha: head, base_sha: base });
    },
  );

  it("refreshes when editing removes the approval marker", async () => {
    const f = fixture();
    f.context.eventName = "issue_comment";
    f.context.payload.changes.body.from = f.context.payload.comment.body;
    f.context.payload.comment.body = "removed";
    await f.start();
    expect(f.status).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ state: "pending" }));
  });

  it.each(["pull_request", "push", "workflow_dispatch"])(
    "rejects untrusted or unrelated event %s",
    async (event) => {
      const f = fixture();
      f.context.eventName = event;
      await expect(f.start()).rejects.toThrow(/Unexpected upgrade event/);
      expect(f.status).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "fork",
      (f: ReturnType<typeof fixture>) => {
        f.pr.head.repo.full_name = "other/NemoClaw";
      },
    ],
    [
      "base",
      (f: ReturnType<typeof fixture>) => {
        f.pr.base.ref = "release";
      },
    ],
    [
      "commit",
      (f: ReturnType<typeof fixture>) => {
        f.pr.head.sha = "main";
      },
    ],
    [
      "number",
      (f: ReturnType<typeof fixture>) => {
        f.context.payload.pull_request.number = 0;
      },
    ],
  ] as const)("rejects invalid %s before writing status", async (_label, mutate) => {
    const f = fixture();
    mutate(f);
    await expect(f.start()).rejects.toThrow();
    expect(f.status).not.toHaveBeenCalled();
  });

  it.each(["failure", "cancelled", "skipped", ""])(
    "does not turn %s into admission",
    async (outcome) => {
      const f = fixture();
      await f.finish(outcome);
      expect(f.status).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sha: head,
          context: "check-hash",
          state: "failure",
        }),
      );
    },
  );

  it.each(["head", "base"] as const)("denies stale success when the %s changes", async (key) => {
    const f = fixture();
    f.pr[key].sha = "c".repeat(40);
    await f.finish("success");
    expect(f.status).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ state: "failure" }));
  });

  it("reports success only for a completed check on the current open PR", async () => {
    const f = fixture();
    await f.start();
    await f.finish("success");
    expect(f.status.mock.calls.map(([value]) => value)).toEqual([
      expect.objectContaining({ sha: head, context: "check-hash", state: "pending" }),
      expect.objectContaining({ sha: head, context: "check-hash", state: "success" }),
    ]);
  });
});
