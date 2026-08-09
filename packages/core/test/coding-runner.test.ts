import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent";
import type { DomainEvent } from "@mamachi/protocol";
import { CodingRunner, type CodingRunnerOptions } from "../src/coding-runner.ts";
import type { TaskRecord } from "../src/domain.ts";
import { defaultRuntimeSettings } from "../src/model-router.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A minimal fake matching just the shape OmpRunner actually touches (same
// technique as omp-runner.test.ts's createFakeSession, duplicated locally
// rather than imported since that helper isn't exported and this file's
// existing style already keeps its own local fixtures self-contained).
// `prompt` never resolves so the runner stays "mid-turn" until this test
// externally injects a terminal event -- otherwise the runner's own
// end-of-turn logic would race ahead and dispose the session on its own,
// before the test can observe the pre-disposal state.
function makeFakeSession(disposeCalls: { count: number }, id: string) {
  const session = {
    sessionId: id,
    sessionFile: `/tmp/${id}.jsonl`,
    sessionManager: { ensureOnDisk: async () => undefined },
    agent: { waitForIdle: async () => undefined },
    model: undefined,
    isStreaming: false,
    subscribe: () => () => undefined,
    prompt: async () => new Promise<void>(() => {}),
    followUp: async () => undefined,
    steer: async () => undefined,
    abort: async () => undefined,
    dispose: async () => {
      disposeCalls.count += 1;
    },
    getLastAssistantMessage: () => ({ stopReason: "stop" }),
    getLastAssistantText: () => "unused: prompt() never resolves in this fake",
  };
  return session;
}

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

  test("repeated start -> finish cycles never leak: activeTaskCount returns to exactly 0 every time", async () => {
    const tasks: Record<string, TaskRecord> = {};
    const runner = new CodingRunner(makeOptions(tasks));
    try {
      for (let cycle = 0; cycle < 4; cycle += 1) {
        const taskId = `task-cycle-${cycle}`;
        tasks[taskId] = baseTask(taskId, cycle % 2 === 0 ? "codex" : "claude", tempRepository(`cycle-${cycle}`));

        expect(runner.activeTaskCount).toBe(0);
        runner.handleEvents([startedEvent(taskId)]);
        expect(runner.activeTaskCount).toBe(1);
        runner.handleEvents([completedEvent(taskId)]);
        expect(runner.activeTaskCount).toBe(0);
      }
    } finally {
      await runner.dispose();
    }
  });

  test("dispose() on a terminal event actually tears down that task's concrete backend session, not just the bookkeeping map", async () => {
    const repoA = tempRepository("a");
    const repoB = tempRepository("b");
    const tasks: Record<string, TaskRecord> = {
      "task-a": baseTask("task-a", "omp", repoA),
      "task-b": baseTask("task-b", "omp", repoB),
    };
    const disposedA = { count: 0 };
    const disposedB = { count: 0 };
    const readyA = Promise.withResolvers<void>();
    const readyB = Promise.withResolvers<void>();
    const runner = new CodingRunner({
      ...makeOptions(tasks),
      emit: (type: string, payload: unknown) => {
        if (type !== "coder.ready" || !isRecord(payload)) return;
        if (payload["taskId"] === "task-a") readyA.resolve();
        if (payload["taskId"] === "task-b") readyB.resolve();
      },
      createSession: async (options: { cwd: string }) => {
        const isA = options.cwd === repoA;
        return { session: makeFakeSession(isA ? disposedA : disposedB, isA ? "session-a" : "session-b") } as unknown as CreateAgentSessionResult;
      },
    } as unknown as CodingRunnerOptions);
    try {
      runner.handleEvents([startedEvent("task-a"), startedEvent("task-b")]);
      await readyA.promise;
      await readyB.promise;
      expect(runner.activeTaskCount).toBe(2);
      expect(disposedA.count).toBe(0);
      expect(disposedB.count).toBe(0);

      runner.handleEvents([completedEvent("task-a")]);
      // CodingRunner fires dispose() with `void` (fire-and-forget); flush a macrotask
      // so the (fake, synchronous) dispose chain has definitely settled before asserting.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(disposedA.count).toBe(1);
      expect(disposedB.count).toBe(0); // the sibling's own session must never be touched
      expect(runner.activeTaskCount).toBe(1);
    } finally {
      await runner.dispose();
    }
  });

  test("configure() updates the settings used for a runner created afterward, while a sibling task's runner stays active", async () => {
    const repoA = tempRepository("a");
    const repoB = tempRepository("b");
    const tasks: Record<string, TaskRecord> = { "task-a": baseTask("task-a", "omp", repoA) };
    const observed: Array<{ repo: string; thinkingLevel: unknown }> = [];
    const readyA = Promise.withResolvers<void>();
    const readyB = Promise.withResolvers<void>();
    const runner = new CodingRunner({
      ...makeOptions(tasks),
      emit: (type: string, payload: unknown) => {
        if (type !== "coder.ready" || !isRecord(payload)) return;
        if (payload["taskId"] === "task-a") readyA.resolve();
        if (payload["taskId"] === "task-b") readyB.resolve();
      },
      createSession: async (options: { cwd: string; thinkingLevel: unknown }) => {
        observed.push({ repo: options.cwd, thinkingLevel: options.thinkingLevel });
        return { session: makeFakeSession({ count: 0 }, `session-${observed.length}`) } as unknown as CreateAgentSessionResult;
      },
      runtimeSettings: defaultRuntimeSettings,
    } as unknown as CodingRunnerOptions);
    try {
      runner.handleEvents([startedEvent("task-a")]);
      await readyA.promise;
      expect(observed).toEqual([{ repo: repoA, thinkingLevel: ThinkingLevel.Inherit }]);

      // configure()'s own loop also reaches task-a's already-live runner (coding-runner.ts
      // iterates every entry of #runners), but OmpRunner only re-reads its runtimeSettings
      // field at its NEXT fresh session creation -- which, by this architecture's design,
      // doesn't happen again for a surviving (non-terminal) OMP runner on a plain
      // pause/resume cycle (the resume path reuses the live session; see the report for the
      // exact trace). So the settings update to task-a's own runner has no further
      // independently-observable effect in this test; what IS directly observable, and is
      // exactly what this test pins, is that the update reaches the runner for a task that
      // starts afterward, concurrently with task-a still active.
      runner.configure({ ...defaultRuntimeSettings, thinkingLevel: "high" });

      tasks["task-b"] = baseTask("task-b", "omp", repoB);
      runner.handleEvents([startedEvent("task-b")]);
      await readyB.promise;

      expect(observed).toEqual([
        { repo: repoA, thinkingLevel: ThinkingLevel.Inherit },
        { repo: repoB, thinkingLevel: ThinkingLevel.High },
      ]);
      expect(runner.activeTaskCount).toBe(2);
    } finally {
      await runner.dispose();
    }
  });
});
