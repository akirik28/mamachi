import { describe, expect, test } from "bun:test";
import { TaskController } from "../src/controller.ts";
import { EventStore } from "../src/event-store.ts";

// A small, fast, fully-deterministic (fixed-seed) randomized stress test.
// Unlike the example-based tests in controller.test.ts, which each pin one
// specific scenario, this generates long, mixed sequences of every command
// and internal signal across several repositories and asserts only one
// thing: the controller never lets `assertStateInvariants` throw. Every
// `TaskController` method that emits an event runs `applyEvent` for it
// immediately (see controller.ts), and `applyEvent` runs
// `assertStateInvariants` after every event -- so an uncaught exception
// anywhere in this test *is* an invariant violation (or a reference to a
// nonexistent task/run/question/confirmation, which is its own kind of bug),
// and the failure naturally comes with the exact sequence via `steps`.
//
// A "rejected" or "conflict" result is an expected, normal outcome (most
// random actions target the wrong task in the wrong state on purpose, to
// cover more transition edges) and is never treated as a failure -- only a
// thrown exception is.
//
// This is exactly how the fix bundled in this commit was found: this test
// used to throw "Task ... has an open question while cancelled" almost
// immediately, because task.cancelled didn't used to resolve a task's open
// question (see domain.ts's abandonOpenWorkOn and its callers).

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T | undefined {
  if (items.length === 0) return undefined;
  return items[Math.floor(random() * items.length)];
}

const acceptingEvidenceValidator = {
  validateEvidence: () => ({
    valid: true,
    implementationComplete: true,
    verificationComplete: true,
    explanation: "stress test evidence accepted",
  }),
};

function taskSpec(repositoryId: string, fast: boolean) {
  return {
    repositoryId,
    objective: "Change an observable behavior",
    acceptanceCriteria: ["The changed behavior is verified"],
    constraints: [],
    attachmentIds: [],
    codingProfileId: fast ? "fast" : null,
  };
}

function runStressSequence(seed: number, stepCount: number): string[] {
  const random = mulberry32(seed);
  const repos = ["repo_0", "repo_1", "repo_2", "repo_3", "repo_4", "repo_5"];
  const store = new EventStore();
  const steps: string[] = [];
  try {
    const controller = new TaskController(store, acceptingEvidenceValidator);

    const actions: Array<() => void> = [
      // submit
      () => {
        const repositoryId = pick(random, repos)!;
        const fast = random() < 0.3;
        const result = controller.handle({
          id: Bun.randomUUIDv7(),
          type: "task.submit",
          actor: "voice",
          expectedRevision: null,
          payload: taskSpec(repositoryId, fast),
        });
        steps.push(`submit(${repositoryId}, fast=${fast}) -> ${result.status}`);
      },
      // requestPause
      () => {
        const task = pick(random, controller.snapshot().tasks.filter((candidate) => candidate.state === "running"));
        if (!task) return;
        const result = controller.handle({
          id: Bun.randomUUIDv7(),
          type: "task.requestPause",
          actor: "voice",
          expectedRevision: task.revision,
          payload: { taskId: task.id, reason: "stress pause" },
        });
        steps.push(`requestPause(${task.id}) -> ${result.status}`);
      },
      // pauseAtSafeBoundary (the internal signal a coding runner sends once paused)
      () => {
        const task = pick(
          random,
          controller.snapshot().tasks.filter((candidate) => candidate.state === "pause_requested"),
        );
        if (!task) return;
        const result = controller.pauseAtSafeBoundary(Bun.randomUUIDv7(), task.id);
        steps.push(`pauseAtSafeBoundary(${task.id}) -> ${result.status}`);
      },
      // resume
      () => {
        const task = pick(
          random,
          controller.snapshot().tasks.filter((candidate) => candidate.state === "paused" || candidate.state === "awaiting_user"),
        );
        if (!task) return;
        const result = controller.handle({
          id: Bun.randomUUIDv7(),
          type: "task.resume",
          actor: "voice",
          expectedRevision: task.revision,
          payload: { taskId: task.id },
        });
        steps.push(`resume(${task.id}) -> ${result.status}`);
      },
      // cancel
      () => {
        const task = pick(
          random,
          controller.snapshot().tasks.filter((candidate) => !["completed", "failed", "cancelled"].includes(candidate.state)),
        );
        if (!task) return;
        const result = controller.handle({
          id: Bun.randomUUIDv7(),
          type: "task.cancel",
          actor: "voice",
          expectedRevision: task.revision,
          payload: { taskId: task.id, reason: "stress cancel" },
        });
        steps.push(`cancel(${task.id}) -> ${result.status}`);
      },
      // complete
      () => {
        const task = pick(random, controller.snapshot().tasks.filter((candidate) => candidate.state === "running"));
        if (!task) return;
        const result = controller.completeTask(Bun.randomUUIDv7(), task.id, "stress completion", []);
        steps.push(`complete(${task.id}) -> ${result.status}`);
      },
      // fail
      () => {
        const task = pick(
          random,
          controller.snapshot().tasks.filter((candidate) => candidate.state === "running" || candidate.state === "pause_requested"),
        );
        if (!task) return;
        const result = controller.failTask(Bun.randomUUIDv7(), task.id, "stress failure");
        steps.push(`fail(${task.id}) -> ${result.status}`);
      },
      // ask a coder question (internal signal)
      () => {
        const task = pick(random, controller.snapshot().tasks.filter((candidate) => candidate.state === "running"));
        if (!task) return;
        const result = controller.awaitUserInput(Bun.randomUUIDv7(), task.id, "Which target should I use?");
        steps.push(`awaitUserInput(${task.id}) -> ${result.status}`);
      },
      // answer an open question
      () => {
        const question = pick(random, (controller.snapshot().questions ?? []).filter((candidate) => candidate.state === "open"));
        if (!question) return;
        const task = controller.snapshot().tasks.find((candidate) => candidate.id === question.taskId);
        const result = controller.handle({
          id: Bun.randomUUIDv7(),
          type: "task.answerQuestion",
          actor: "voice",
          expectedRevision: task?.revision ?? question.taskRevision,
          payload: { taskId: question.taskId, questionId: question.id, answer: "Use staging." },
        });
        steps.push(`answerQuestion(${question.taskId}, ${question.id}) -> ${result.status}`);
      },
      // propose a risky tool call (internal signal; may create a pending confirmation)
      () => {
        const task = pick(random, controller.snapshot().tasks.filter((candidate) => candidate.state === "running"));
        if (!task) return;
        const risky = random() < 0.5;
        const result = controller.authorizeToolCall(
          Bun.randomUUIDv7(),
          task.id,
          "bash",
          { command: risky ? "git push origin main" : "echo hello" },
        );
        steps.push(`authorizeToolCall(${task.id}, risky=${risky}) -> ${result.status}`);
      },
      // resolve a pending confirmation
      () => {
        const confirmation = pick(random, controller.snapshot().confirmations.filter((candidate) => candidate.state === "pending"));
        if (!confirmation) return;
        const task = controller.snapshot().tasks.find((candidate) => candidate.id === confirmation.taskId);
        const decision = random() < 0.7 ? "approve" : "reject";
        const result = controller.handle({
          id: Bun.randomUUIDv7(),
          type: "approval.resolve",
          actor: "voice",
          expectedRevision: task?.revision ?? confirmation.taskRevision,
          payload: { confirmationId: confirmation.id, decision },
        });
        steps.push(`resolveApproval(${confirmation.id}, ${decision}) -> ${result.status}`);
      },
      // reorder the queue
      () => {
        const queue = controller.snapshot().queue;
        const taskId = pick(random, queue);
        if (!taskId) return;
        const result = controller.handle({
          id: Bun.randomUUIDv7(),
          type: "queue.move",
          actor: "voice",
          expectedRevision: null,
          payload: { taskId, operation: "move_first", anchorTaskId: null },
        });
        steps.push(`moveQueue(${taskId}) -> ${result.status}`);
      },
      // simulate a daemon restart mid-sequence
      () => {
        const result = controller.recoverAfterRestart(Bun.randomUUIDv7());
        steps.push(`recoverAfterRestart() -> ${result.status}`);
      },
    ];

    for (let step = 0; step < stepCount; step += 1) {
      const action = pick(random, actions)!;
      action();
    }
  } finally {
    store.close();
  }
  return steps;
}

describe("TaskController randomized invariant stress test", () => {
  test("assertStateInvariants never throws across a long, deterministic, mixed random sequence", () => {
    let steps: string[] = [];
    try {
      steps = runStressSequence(0xc0ffee, 400);
    } catch (error) {
      throw new Error(
        `Invariant stress sequence failed after ${steps.length} steps. Last 15 steps:\n${steps
          .slice(-15)
          .join("\n")}\n\nOriginal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      );
    }
    // `stepCount` is the number of loop iterations attempted, not the number
    // of recorded steps: an action silently no-ops (without pushing to
    // `steps`) when there's currently no valid target for it (e.g. "answer a
    // question" when none is open), which is expected and not itself
    // meaningful. What *is* meaningful, and what this checks, is that the
    // sequence wasn't almost entirely no-ops -- i.e. it actually exercised
    // the state machine rather than passing vacuously.
    expect(steps.length).toBeGreaterThan(100);
    expect(steps.some((step) => step.includes("-> accepted"))).toBe(true);
  });

  test("a second, differently-seeded sequence also never throws", () => {
    let steps: string[] = [];
    try {
      steps = runStressSequence(0x1234abcd, 400);
    } catch (error) {
      throw new Error(
        `Invariant stress sequence failed after ${steps.length} steps. Last 15 steps:\n${steps
          .slice(-15)
          .join("\n")}\n\nOriginal error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      );
    }
    expect(steps.length).toBeGreaterThan(100);
    expect(steps.some((step) => step.includes("-> accepted"))).toBe(true);
  });
});
