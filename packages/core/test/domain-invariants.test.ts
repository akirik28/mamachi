import { describe, expect, test } from "bun:test";
import type { TaskSpec } from "@mamachi/protocol";
import {
  assertStateInvariants,
  createEmptyState,
  MAX_CONCURRENT_TASKS,
  type ConfirmationRecord,
  type ControllerState,
  type QuestionRecord,
  type RunRecord,
  type RunState,
  type TaskRecord,
  type TaskState,
} from "../src/domain.ts";

// This file tests `assertStateInvariants` directly, as a last line of
// defense, by constructing an in-memory `ControllerState` by hand (never
// going through `TaskController`/`applyEvent`, which would never let a bad
// state occur in the first place -- that path is covered by
// controller.test.ts instead). Each test violates exactly one invariant and
// pins the exact message that invariant throws, so a regression that
// silently drops a check is caught by a specific, named test rather than by
// some unrelated test failing for a confusing reason.

const at = "2026-01-01T00:00:00.000Z";

function taskSpec(repositoryId: string): TaskSpec {
  return {
    repositoryId,
    objective: "Change an observable behavior",
    acceptanceCriteria: ["The changed behavior is verified"],
    constraints: [],
    attachmentIds: [],
    codingProfileId: null,
  };
}

function makeTask(id: string, repositoryId: string, state: TaskState, overrides: Partial<TaskRecord> = {}): TaskRecord {
  const revision = overrides.revision ?? 1;
  return {
    id,
    repositoryId,
    state,
    spec: taskSpec(repositoryId),
    revision,
    activeRunId: null,
    runIds: [],
    evidenceIds: [],
    createdAt: at,
    updatedAt: at,
    terminalSummary: null,
    workspaceConflict: null,
    codingSession: null,
    pendingQuestion: null,
    specHistory: [{ revision, objective: "Change an observable behavior", revisedAt: at }],
    ...overrides,
  };
}

function makeRun(id: string, taskId: string, state: RunState, overrides: Partial<RunRecord> = {}): RunRecord {
  return { id, taskId, taskRevision: 1, state, startedAt: at, endedAt: null, ...overrides };
}

function makeQuestion(id: string, taskId: string, overrides: Partial<QuestionRecord> = {}): QuestionRecord {
  return {
    id,
    taskId,
    taskRevision: 1,
    runId: "run-1",
    question: "Which target?",
    state: "open",
    resolution: null,
    answer: null,
    askedAt: at,
    resolvedAt: null,
    ...overrides,
  };
}

// Only used to prove the confirmation type round-trips through ControllerState;
// no invariant in `assertStateInvariants` currently inspects confirmations, so
// there is deliberately no dedicated bad-state test for it below.
function makeConfirmation(id: string, taskId: string, overrides: Partial<ConfirmationRecord> = {}): ConfirmationRecord {
  return {
    id,
    taskId,
    taskRevision: 1,
    category: "destructive_git",
    summary: "git push",
    effectFingerprint: "fp",
    toolName: "bash",
    state: "pending",
    createdAt: at,
    resolvedAt: null,
    consumedAt: null,
    ...overrides,
  };
}

describe("assertStateInvariants", () => {
  test("a freshly created empty state satisfies every invariant", () => {
    expect(() => assertStateInvariants(createEmptyState())).not.toThrow();
  });

  test("throws when the queue contains a duplicate task id", () => {
    const state = createEmptyState();
    state.tasks.set("t1", makeTask("t1", "repo_a", "queued"));
    state.queue = ["t1", "t1"];
    expect(() => assertStateInvariants(state)).toThrow("Queue contains duplicate tasks");
  });

  test("throws when the queue references a task that does not exist", () => {
    const state = createEmptyState();
    state.queue = ["ghost"];
    expect(() => assertStateInvariants(state)).toThrow("Queue references missing task ghost");
  });

  test("throws when the queue contains a task whose state is not queued", () => {
    const state = createEmptyState();
    state.tasks.set("t1", makeTask("t1", "repo_a", "running"));
    state.queue = ["t1"];
    expect(() => assertStateInvariants(state)).toThrow("Queue contains non-queued task t1");
  });

  test(`throws when more than ${MAX_CONCURRENT_TASKS} tasks are active`, () => {
    const state = createEmptyState();
    state.activeTaskIds = Array.from({ length: MAX_CONCURRENT_TASKS + 1 }, (_, index) => `t${index}`);
    expect(() => assertStateInvariants(state)).toThrow(
      `${MAX_CONCURRENT_TASKS + 1} tasks are active; the cap is ${MAX_CONCURRENT_TASKS}`,
    );
  });

  test("throws when the active task list contains a duplicate id", () => {
    const state = createEmptyState();
    state.activeTaskIds = ["t1", "t1"];
    expect(() => assertStateInvariants(state)).toThrow("Active task list contains duplicates");
  });

  test("throws when an active slot references a task that does not exist", () => {
    const state = createEmptyState();
    state.activeTaskIds = ["ghost"];
    expect(() => assertStateInvariants(state)).toThrow("Active slot references missing task ghost");
  });

  test("throws when an active task's state is not one of the active-eligible states", () => {
    const state = createEmptyState();
    state.tasks.set("t1", makeTask("t1", "repo_a", "completed"));
    state.activeTaskIds = ["t1"];
    expect(() => assertStateInvariants(state)).toThrow("Active task t1 has invalid state completed");
  });

  // "Active task X is also queued" (domain.ts, the `queued.has(task.id)` check
  // inside the active-task loop) is unreachable given the current TaskState
  // union and check ordering: the queue loop runs first and already throws
  // "Queue contains non-queued task" for any queued entry whose state isn't
  // exactly "queued", and the active loop's own state check (the test above)
  // throws first for any active entry whose state isn't one of the four
  // active-eligible states. No single TaskState value is both "queued" and
  // active-eligible, so a task can never survive both checks and reach the
  // "is also queued" line. The invariant it protects -- active and queued are
  // disjoint -- still holds; it's just enforced entirely by the state field
  // rather than by this specific membership check. This test pins that the
  // invariant is still caught (just via a different, earlier message) so a
  // future change to TaskState that made the two sets overlappable would be
  // caught by a test failing here, not by silently losing coverage.
  test("an active-and-queued task is still rejected (via the state checks, not the dead 'also queued' branch)", () => {
    const state = createEmptyState();
    state.tasks.set("t1", makeTask("t1", "repo_a", "running"));
    state.activeTaskIds = ["t1"];
    state.queue = ["t1"];
    expect(() => assertStateInvariants(state)).toThrow("Queue contains non-queued task t1");
  });

  test("throws when two active tasks claim the same repository", () => {
    const state = createEmptyState();
    state.tasks.set("t1", makeTask("t1", "repo_a", "running"));
    state.tasks.set("t2", makeTask("t2", "repo_a", "running"));
    state.activeTaskIds = ["t1", "t2"];
    expect(() => assertStateInvariants(state)).toThrow("Repository repo_a has more than one active task");
  });

  test("throws when a task's active run does not exist", () => {
    const state = createEmptyState();
    state.tasks.set("t1", makeTask("t1", "repo_a", "running", { activeRunId: "run-ghost" }));
    expect(() => assertStateInvariants(state)).toThrow("Task t1 references missing active run run-ghost");
  });

  test("throws when a task's active run belongs to a different task", () => {
    const state = createEmptyState();
    state.tasks.set("t1", makeTask("t1", "repo_a", "running", { activeRunId: "run-1" }));
    state.runs.set("run-1", makeRun("run-1", "t2", "running"));
    expect(() => assertStateInvariants(state)).toThrow("Run run-1 belongs to a different task");
  });

  test("throws when a task's active run is in a terminal (non-active) run state", () => {
    const state = createEmptyState();
    state.tasks.set("t1", makeTask("t1", "repo_a", "running", { activeRunId: "run-1" }));
    state.runs.set("run-1", makeRun("run-1", "t1", "completed"));
    expect(() => assertStateInvariants(state)).toThrow("Task t1 points to inactive run run-1");
  });

  test("throws when an interrupted run is attached to a task that isn't running or pause_requested", () => {
    const state = createEmptyState();
    state.tasks.set("t1", makeTask("t1", "repo_a", "paused", { activeRunId: "run-1" }));
    state.runs.set("run-1", makeRun("run-1", "t1", "interrupted"));
    expect(() => assertStateInvariants(state)).toThrow("Interrupted run run-1 is attached to task state paused");
  });

  test("throws when a task has more than one open question", () => {
    const state = createEmptyState();
    state.tasks.set("t1", makeTask("t1", "repo_a", "awaiting_user"));
    state.questions.set("q1", makeQuestion("q1", "t1"));
    state.questions.set("q2", makeQuestion("q2", "t1"));
    expect(() => assertStateInvariants(state)).toThrow("Task t1 has multiple open questions");
  });

  test("throws when a task has an open question but isn't awaiting_user", () => {
    const state = createEmptyState();
    state.tasks.set("t1", makeTask("t1", "repo_a", "running"));
    state.questions.set("q1", makeQuestion("q1", "t1"));
    expect(() => assertStateInvariants(state)).toThrow("Task t1 has an open question while running");
  });

  test("throws when a task's spec history no longer ends at its current revision", () => {
    const state = createEmptyState();
    state.tasks.set(
      "t1",
      makeTask("t1", "repo_a", "queued", {
        revision: 2,
        specHistory: [{ revision: 1, objective: "Change an observable behavior", revisedAt: at }],
      }),
    );
    expect(() => assertStateInvariants(state)).toThrow("Task t1 spec history is out of sync with revision 2");
  });

  test("a maximally-populated, internally-consistent state satisfies every invariant", () => {
    // Sanity check that the builders above produce states that pass when
    // nothing is deliberately broken -- otherwise the negative tests above
    // could be vacuously true for the wrong reason (e.g. a typo that makes
    // every state throw regardless of what's being tested).
    const state = createEmptyState();
    state.tasks.set("running", makeTask("running", "repo_a", "running", { activeRunId: "run-running" }));
    state.tasks.set("paused", makeTask("paused", "repo_b", "paused"));
    state.tasks.set(
      "awaiting",
      makeTask("awaiting", "repo_c", "awaiting_user", { pendingQuestion: "Which target?" }),
    );
    state.tasks.set("queued", makeTask("queued", "repo_a", "queued"));
    state.tasks.set("done", makeTask("done", "repo_d", "completed"));
    state.runs.set("run-running", makeRun("run-running", "running", "running"));
    state.activeTaskIds = ["running", "paused", "awaiting"];
    state.queue = ["queued"];
    state.questions.set("q1", makeQuestion("q1", "awaiting"));
    state.confirmations.set("c1", makeConfirmation("c1", "awaiting"));
    expect(() => assertStateInvariants(state)).not.toThrow();
  });
});
