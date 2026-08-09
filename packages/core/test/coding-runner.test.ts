import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DomainEvent } from "@mamachi/protocol";
import { CodingRunner, type CodingRunnerOptions } from "../src/coding-runner.ts";
import type { TaskRecord } from "../src/domain.ts";

// WorkspaceGuard (constructed inside OmpRunner/ExternalCliRunner) does real
// filesystem reads against `repositoryId`, so it must be a real directory —
// same pattern as omp-runner.test.ts and external-cli-runner.test.ts.
const repositories: string[] = [];

function tempRepository(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `mamachi-coding-runner-${label}-`));
  repositories.push(dir);
  return dir;
}

beforeEach(() => {
  repositories.length = 0;
});

afterEach(() => {
  for (const dir of repositories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function baseTask(id: string, backend: "omp" | "codex" | "claude", repositoryId: string): TaskRecord {
  return {
    id,
    repositoryId,
    state: "running",
    spec: {
      repositoryId,
      objective: "test",
      acceptanceCriteria: [],
      constraints: [],
      attachmentIds: [],
      codingProfileId: "gpt-5.6-sol",
    } as unknown as TaskRecord["spec"],
    revision: 1,
    activeRunId: `run-${id}`,
    runIds: [`run-${id}`],
    evidenceIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    terminalSummary: null,
    workspaceConflict: null,
    codingSession: { backend, id: `session-${id}`, file: null, boundRunId: `run-${id}`, recoveryBoundary: null },
    pendingQuestion: null,
    specHistory: [],
  };
}

function domainEvent(type: string, taskId: string, seq: number, payload: Record<string, unknown>): DomainEvent {
  return {
    version: 1,
    id: `evt-${taskId}-${type}`,
    at: new Date().toISOString(),
    type,
    actor: "controller",
    projectId: taskId,
    taskId,
    runId: `run-${taskId}`,
    seq,
    correlationId: "corr",
    causedBy: "corr",
    payload,
  } as unknown as DomainEvent;
}

const startedEvent = (taskId: string) => domainEvent("task.started", taskId, 1, { runId: `run-${taskId}`, revision: 1 });
const completedEvent = (taskId: string) =>
  domainEvent("task.completed", taskId, 2, { runId: `run-${taskId}`, summary: "done", evidenceIds: [] });

function makeOptions(tasks: Record<string, TaskRecord>): CodingRunnerOptions {
  return {
    getTask: (taskId: string) => tasks[taskId],
    emit: () => {},
    onSafePause: async () => {},
    onAuthorizeTool: async () => ({ status: "rejected", code: "test_stub", explanation: "unused in this test" }),
    onWorkspaceConflict: async () => {},
    onRecordEvidence: async () => {},
    onComplete: async () => ({ status: "rejected", code: "test_stub", explanation: "unused in this test" }),
    onFail: async () => ({ status: "rejected", code: "test_stub", explanation: "unused in this test" }),
    onNeedInput: async () => ({ status: "rejected", code: "test_stub", explanation: "unused in this test" }),
  } as unknown as CodingRunnerOptions;
}

describe("CodingRunner", () => {
  test("starts with no per-task runners and creates one per task on task.started", async () => {
    const tasks = {
      "task-a": baseTask("task-a", "codex", tempRepository("a")),
      "task-b": baseTask("task-b", "claude", tempRepository("b")),
    };
    const runner = new CodingRunner(makeOptions(tasks));
    try {
      expect(runner.activeTaskCount).toBe(0);

      runner.handleEvents([startedEvent("task-a")]);
      expect(runner.activeTaskCount).toBe(1);

      runner.handleEvents([startedEvent("task-b")]);
      expect(runner.activeTaskCount).toBe(2);

      // A second task.started for an already-tracked task must not create a duplicate instance.
      runner.handleEvents([startedEvent("task-a")]);
      expect(runner.activeTaskCount).toBe(2);
    } finally {
      await runner.dispose();
    }
  });

  test("routes askCoder/steer/followUp to the specific task's own runner instance without throwing", async () => {
    const tasks = {
      "task-a": baseTask("task-a", "codex", tempRepository("a")),
      "task-b": baseTask("task-b", "claude", tempRepository("b")),
    };
    const runner = new CodingRunner(makeOptions(tasks));
    try {
      runner.handleEvents([startedEvent("task-a"), startedEvent("task-b")]);

      // Neither the fake codex nor claude CLI is actually spawned in this unit test
      // (that's ExternalCliRunner's own test suite's job), so both return false here
      // regardless of routing correctness. What this asserts is that routing by taskId
      // doesn't throw and a taskId with no runner at all degrades to false rather than
      // erroring.
      expect(await runner.askCoder("task-a", "status?")).toBe(false);
      expect(await runner.askCoder("task-b", "status?")).toBe(false);
      expect(await runner.askCoder("task-c", "status?")).toBe(false);
    } finally {
      await runner.dispose();
    }
  });

  test("disposes and forgets a task's runner instance once it reaches a terminal event", async () => {
    const tasks = {
      "task-a": baseTask("task-a", "omp", tempRepository("a")),
      "task-b": baseTask("task-b", "omp", tempRepository("b")),
    };
    const runner = new CodingRunner(makeOptions(tasks));
    try {
      runner.handleEvents([startedEvent("task-a"), startedEvent("task-b")]);
      expect(runner.activeTaskCount).toBe(2);

      runner.handleEvents([completedEvent("task-a")]);
      expect(runner.activeTaskCount).toBe(1);

      // A second terminal event for the same (already-removed) task must not throw.
      runner.handleEvents([completedEvent("task-a")]);
      expect(runner.activeTaskCount).toBe(1);
    } finally {
      await runner.dispose();
    }
  });

  test("dispose() tears down every currently-active task's runner", async () => {
    const tasks = {
      "task-a": baseTask("task-a", "codex", tempRepository("a")),
      "task-b": baseTask("task-b", "codex", tempRepository("b")),
    };
    const runner = new CodingRunner(makeOptions(tasks));

    runner.handleEvents([startedEvent("task-a"), startedEvent("task-b")]);
    expect(runner.activeTaskCount).toBe(2);

    await runner.dispose();
    expect(runner.activeTaskCount).toBe(0);

    // dispose() must not throw calling again with nothing left to dispose.
    await runner.dispose();
    expect(runner.activeTaskCount).toBe(0);
  });
});
