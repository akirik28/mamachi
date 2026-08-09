import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifact-store.ts";
import { TaskController } from "../src/controller.ts";
import { EventStore } from "../src/event-store.ts";

const spec = {
  repositoryId: "repo_alpha",
  objective: "Change an observable behavior",
  acceptanceCriteria: ["The changed behavior is verified"],
  constraints: ["Preserve existing user work"],
  attachmentIds: [],
  codingProfileId: "gpt-5.6-sol",
};

function submit(
  controller: TaskController,
  id = Bun.randomUUIDv7(),
  codingProfileId = spec.codingProfileId,
): string {
  const result = controller.handle({
    id,
    type: "task.submit",
    actor: "voice",
    expectedRevision: null,
    payload: { ...spec, codingProfileId },
  });
  if (result.status !== "accepted" || !result.taskId) throw new Error("Task submission failed");
  return result.taskId;
}

function submitToRepo(controller: TaskController, repositoryId: string): string {
  const result = controller.handle({
    id: Bun.randomUUIDv7(),
    type: "task.submit",
    actor: "voice",
    expectedRevision: null,
    payload: { ...spec, repositoryId },
  });
  if (result.status !== "accepted" || !result.taskId) throw new Error(`Submission to ${repositoryId} failed`);
  return result.taskId;
}

const acceptingEvidenceValidator = {
  validateEvidence: () => ({
    valid: true,
    implementationComplete: true,
    verificationComplete: true,
    explanation: "test evidence accepted",
  }),
};

describe("TaskController", () => {
  test("runs one task and atomically starts the next queued task", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store, {
        validateEvidence: () => ({
          valid: true,
          implementationComplete: true,
          verificationComplete: true,
          explanation: "test evidence accepted",
        }),
      });
      const firstTaskId = submit(controller);
      const secondTaskId = submit(controller);

      let snapshot = controller.snapshot();
      expect(snapshot.activeTaskId).toBe(firstTaskId);
      expect(snapshot.queue).toEqual([secondTaskId]);

      const completion = controller.completeTask(
        Bun.randomUUIDv7(),
        firstTaskId,
        "The requested behavior was verified",
        [Bun.randomUUIDv7()],
      );
      expect(completion.status).toBe("accepted");

      snapshot = controller.snapshot();
      expect(snapshot.activeTaskId).toBe(secondTaskId);
      expect(snapshot.queue).toEqual([]);
      expect(snapshot.tasks.find((task) => task.id === firstTaskId)?.state).toBe("completed");
      expect(snapshot.tasks.find((task) => task.id === secondTaskId)?.state).toBe("running");
      expect(controller.eventsAfter().map((event) => event.type).slice(-2)).toEqual([
        "task.completed",
        "task.started",
      ]);
    } finally {
      store.close();
    }
  });

  test("prioritizes substantive coding work ahead of queued fast research", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const activeTaskId = submit(controller);
      const firstResearchId = submit(controller, Bun.randomUUIDv7(), "fast");
      const secondResearchId = submit(controller, Bun.randomUUIDv7(), "fast");
      const codingTaskId = submit(controller);

      expect(controller.snapshot().activeTaskId).toBe(activeTaskId);
      expect(controller.snapshot().queue).toEqual([
        codingTaskId,
        firstResearchId,
        secondResearchId,
      ]);
    } finally {
      store.close();
    }
  });

  test("starts a second task immediately when it targets a different repository", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const firstTaskId = submit(controller);
      const secondTaskId = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.submit",
        actor: "voice",
        expectedRevision: null,
        payload: { ...spec, repositoryId: "repo_beta" },
      });
      if (secondTaskId.status !== "accepted" || !secondTaskId.taskId) {
        throw new Error("Second task submission failed");
      }

      const snapshot = controller.snapshot();
      expect((snapshot.activeTaskIds ?? []).sort()).toEqual([firstTaskId, secondTaskId.taskId].sort());
      expect(snapshot.queue).toEqual([]);
      expect(snapshot.tasks.find((task) => task.id === firstTaskId)?.state).toBe("running");
      expect(snapshot.tasks.find((task) => task.id === secondTaskId.taskId)?.state).toBe("running");
    } finally {
      store.close();
    }
  });

  test("queues a second task targeting the same repository as an already-active task", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const firstTaskId = submit(controller);
      const secondTaskId = submit(controller);

      const snapshot = controller.snapshot();
      expect(snapshot.activeTaskIds ?? []).toEqual([firstTaskId]);
      expect(snapshot.queue).toEqual([secondTaskId]);
    } finally {
      store.close();
    }
  });

  test("caps concurrent active tasks at MAX_CONCURRENT_TASKS even across distinct repositories", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskIds: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const result = controller.handle({
          id: Bun.randomUUIDv7(),
          type: "task.submit",
          actor: "voice",
          expectedRevision: null,
          payload: { ...spec, repositoryId: `repo_${index}` },
        });
        if (result.status !== "accepted" || !result.taskId) throw new Error("Submission failed");
        taskIds.push(result.taskId);
      }

      const snapshot = controller.snapshot();
      expect(snapshot.activeTaskIds ?? []).toHaveLength(4);
      expect(snapshot.queue).toEqual([taskIds[4]!]);
    } finally {
      store.close();
    }
  });

  test("legacy activeTaskId reports the oldest active task for unchanged consumers", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const firstTaskId = submit(controller);
      controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.submit",
        actor: "voice",
        expectedRevision: null,
        payload: { ...spec, repositoryId: "repo_beta" },
      });

      expect(controller.snapshot().activeTaskId).toBe(firstTaskId);
    } finally {
      store.close();
    }
  });

  test("recovers every active task after a restart, not just one", () => {
    const store = new EventStore();
    try {
      let controller = new TaskController(store);
      const firstTaskId = submit(controller);
      controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.submit",
        actor: "voice",
        expectedRevision: null,
        payload: { ...spec, repositoryId: "repo_beta" },
      });
      const secondTaskId = (controller.snapshot().activeTaskIds ?? []).find((id) => id !== firstTaskId)!;

      // Simulate a restart: rebuild the controller from the same event log.
      controller = new TaskController(store);
      const recovery = controller.recoverAfterRestart(Bun.randomUUIDv7());
      expect(recovery.status).toBe("accepted");

      const snapshot = controller.snapshot();
      expect(snapshot.tasks.find((task) => task.id === firstTaskId)?.state).toBe("paused");
      expect(snapshot.tasks.find((task) => task.id === secondTaskId)?.state).toBe("paused");
    } finally {
      store.close();
    }
  });

  test("a queued task waits behind a same-repository task even once a different repository frees up", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store, {
        validateEvidence: () => ({
          valid: true,
          implementationComplete: true,
          verificationComplete: true,
          explanation: "test evidence accepted",
        }),
      });
      const repoATaskOne = submit(controller);
      const repoATaskTwo = submit(controller); // queues, same repo as repoATaskOne
      const repoBTask = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.submit",
        actor: "voice",
        expectedRevision: null,
        payload: { ...spec, repositoryId: "repo_beta" },
      });
      if (repoBTask.status !== "accepted") throw new Error("repo_beta submission failed");

      expect(controller.snapshot().queue).toEqual([repoATaskTwo]);

      // Finishing the unrelated repo_beta task must not start the queued repo_alpha task,
      // because repo_alpha is still owned by repoATaskOne.
      const repoBCompletion = controller.completeTask(Bun.randomUUIDv7(), repoBTask.taskId!, "done", []);
      expect(repoBCompletion.status).toBe("accepted");
      expect(controller.snapshot().queue).toEqual([repoATaskTwo]);
      expect(controller.snapshot().activeTaskIds ?? []).toEqual([repoATaskOne]);

      const repoACompletion = controller.completeTask(Bun.randomUUIDv7(), repoATaskOne, "done", []);
      expect(repoACompletion.status).toBe("accepted");
      expect(controller.snapshot().queue).toEqual([]);
      expect(controller.snapshot().activeTaskIds ?? []).toEqual([repoATaskTwo]);
    } finally {
      store.close();
    }
  });

  test("a later-queued task for a free repository starts without waiting for an earlier blocked queue entry", () => {
    // Regression test for head-of-line blocking: with 4 slots full across
    // repos A/B/D/E, A2 (repo A, already owned) and C1 (repo C, free) both
    // queue -- A2 because its repo is busy, C1 purely because capacity is
    // full. When B1 finishes, a slot opens. C1 has no repository conflict at
    // all and must start; A2 must keep waiting on A1, not on queue position.
    const store = new EventStore();
    try {
      const controller = new TaskController(store, acceptingEvidenceValidator);
      const a1 = submitToRepo(controller, "repo_a");
      const b1 = submitToRepo(controller, "repo_b");
      const d1 = submitToRepo(controller, "repo_d");
      const e1 = submitToRepo(controller, "repo_e");
      expect(controller.snapshot().activeTaskIds ?? []).toHaveLength(4);

      const a2 = submitToRepo(controller, "repo_a"); // blocked: repo_a busy (a1)
      const c1 = submitToRepo(controller, "repo_c"); // blocked: capacity full
      expect(controller.snapshot().queue).toEqual([a2, c1]);

      const completion = controller.completeTask(Bun.randomUUIDv7(), b1, "done", []);
      expect(completion.status).toBe("accepted");

      const snapshot = controller.snapshot();
      expect(snapshot.activeTaskIds ?? []).toContain(c1);
      expect(snapshot.tasks.find((task) => task.id === c1)?.state).toBe("running");
      // a2 is still blocked by a1, which never finished -- it must still be queued.
      expect(snapshot.queue).toEqual([a2]);
      expect(snapshot.tasks.find((task) => task.id === a2)?.state).toBe("queued");
    } finally {
      store.close();
    }
  });

  test("same-repository queue order is preserved even when a different repository is free to skip ahead", () => {
    // A1 running; queue is A2, A3, B1 (B1 queued only because capacity is
    // full in this setup). Two slots free up. B1 (different repo) may start
    // immediately, but A3 must never start before A2 -- same-repository FIFO
    // is not something capacity or a different repo's eligibility can break.
    const store = new EventStore();
    try {
      const controller = new TaskController(store, acceptingEvidenceValidator);
      const a1 = submitToRepo(controller, "repo_a");
      const x1 = submitToRepo(controller, "repo_x");
      const y1 = submitToRepo(controller, "repo_y");
      const z1 = submitToRepo(controller, "repo_z");
      expect(controller.snapshot().activeTaskIds ?? []).toHaveLength(4);

      const a2 = submitToRepo(controller, "repo_a"); // blocked: repo_a busy
      const a3 = submitToRepo(controller, "repo_a"); // blocked: repo_a busy, and behind a2
      const b1 = submitToRepo(controller, "repo_b"); // blocked: capacity full (4/4)
      expect(controller.snapshot().queue).toEqual([a2, a3, b1]);
      void z1;

      // Free two slots at once (x1 and y1 finish); a1/repo_a is still busy.
      controller.completeTask(Bun.randomUUIDv7(), x1, "done", []);
      controller.completeTask(Bun.randomUUIDv7(), y1, "done", []);

      const snapshot = controller.snapshot();
      expect(snapshot.tasks.find((task) => task.id === b1)?.state).toBe("running");
      expect(snapshot.tasks.find((task) => task.id === a2)?.state).toBe("queued");
      expect(snapshot.tasks.find((task) => task.id === a3)?.state).toBe("queued");
      expect(snapshot.queue).toEqual([a2, a3]);

      // Now repo_a frees up: a2 must start before a3 even gets a chance.
      controller.completeTask(Bun.randomUUIDv7(), a1, "done", []);
      const afterA1 = controller.snapshot();
      expect(afterA1.tasks.find((task) => task.id === a2)?.state).toBe("running");
      expect(afterA1.tasks.find((task) => task.id === a3)?.state).toBe("queued");
      expect(afterA1.queue).toEqual([a3]);
    } finally {
      store.close();
    }
  });

  test("spare global capacity never lets a second same-repository task skip the FIFO queue", () => {
    // 3 active of 4 slots (genuine slack -- b1/c1 only claim 2 repos, a1 a
    // third), with a2 and a3 both queued behind a1 on repo_a. A single
    // finish can only ever free one repository, so even though a spare
    // global slot exists throughout, exactly one task (a2) starts -- never
    // both, and never a3 ahead of a2.
    const store = new EventStore();
    try {
      const controller = new TaskController(store, acceptingEvidenceValidator);
      const a1 = submitToRepo(controller, "repo_a");
      submitToRepo(controller, "repo_b");
      submitToRepo(controller, "repo_c");
      expect(controller.snapshot().activeTaskIds ?? []).toHaveLength(3);

      // Both block on repo_a specifically, not on capacity -- one global
      // slot is free the whole time.
      const a2 = submitToRepo(controller, "repo_a");
      const a3 = submitToRepo(controller, "repo_a");
      expect(controller.snapshot().queue).toEqual([a2, a3]);
      expect(controller.snapshot().activeTaskIds ?? []).toHaveLength(3);

      controller.completeTask(Bun.randomUUIDv7(), a1, "done", []);

      const snapshot = controller.snapshot();
      expect(snapshot.tasks.find((task) => task.id === a2)?.state).toBe("running");
      expect(snapshot.tasks.find((task) => task.id === a3)?.state).toBe("queued");
      expect(snapshot.queue).toEqual([a3]);
      // a1 left, a2 joined: still 3, never spiked to 4 -- one finish, one start.
      expect(snapshot.activeTaskIds ?? []).toHaveLength(3);
    } finally {
      store.close();
    }
  });

  test("deduplicates a repeated command without appending events", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const commandId = Bun.randomUUIDv7();
      const command = {
        id: commandId,
        type: "task.submit",
        actor: "voice",
        expectedRevision: null,
        payload: spec,
      };

      const first = controller.handle(command);
      const eventCount = store.eventCount();
      const repeated = controller.handle(command);

      expect(repeated).toEqual(first);
      expect(store.eventCount()).toBe(eventCount);
      expect(controller.snapshot().tasks).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test("pauses at a safe boundary, revises immutably, and resumes in a new run", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskId = submit(controller);

      const requested = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.requestPause",
        actor: "voice",
        expectedRevision: 1,
        payload: { taskId, reason: "The architecture changed" },
      });
      expect(requested.status).toBe("accepted");
      expect(controller.snapshot().tasks[0]?.state).toBe("pause_requested");

      const paused = controller.pauseAtSafeBoundary(Bun.randomUUIDv7(), taskId);
      expect(paused.status).toBe("accepted");
      let snapshot = controller.snapshot();
      expect(snapshot.activeTaskId).toBe(taskId);
      expect(snapshot.tasks[0]?.state).toBe("paused");
      expect(snapshot.runs[0]?.state).toBe("paused");

      const revised = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.revise",
        actor: "voice",
        expectedRevision: 1,
        payload: {
          taskId,
          spec: {
            ...spec,
            acceptanceCriteria: [...spec.acceptanceCriteria, "The revised architecture is used"],
          },
        },
      });
      expect(revised.status).toBe("accepted");

      const staleResume = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.resume",
        actor: "voice",
        expectedRevision: 1,
        payload: { taskId },
      });
      expect(staleResume).toEqual({
        status: "conflict",
        currentRevision: 2,
        explanation: `Task ${taskId} is at revision 2, not 1`,
      });

      const resumed = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.resume",
        actor: "voice",
        expectedRevision: 2,
        payload: { taskId },
      });
      expect(resumed.status).toBe("accepted");

      snapshot = controller.snapshot();
      expect(snapshot.tasks[0]?.revision).toBe(2);
      expect(snapshot.tasks[0]?.runIds).toHaveLength(2);
      expect(snapshot.runs.map((run) => run.state)).toEqual(["paused", "running"]);
    } finally {
      store.close();
    }
  });

  test("keeps the repository identity immutable across revisions", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskId = submit(controller);
      controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.requestPause",
        actor: "voice",
        expectedRevision: 1,
        payload: { taskId, reason: "Revise the task" },
      });
      controller.pauseAtSafeBoundary(Bun.randomUUIDv7(), taskId);

      const result = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.revise",
        actor: "voice",
        expectedRevision: 1,
        payload: {
          taskId,
          spec: { ...spec, repositoryId: "repo_other" },
        },
      });

      expect(result.status).toBe("rejected");
      expect(controller.snapshot().tasks[0]?.repositoryId).toBe("repo_alpha");
      expect(controller.snapshot().tasks[0]?.revision).toBe(1);
    } finally {
      store.close();
    }
  });

  test("recovers an unfinished run as paused and never resumes it implicitly", () => {
    const directory = mkdtempSync(join(tmpdir(), "mamachi-controller-"));
    const databasePath = join(directory, "state.sqlite");
    try {
      const firstStore = new EventStore(databasePath);
      const firstController = new TaskController(firstStore);
      const taskId = submit(firstController);
      const runId = firstController.snapshot().tasks[0]?.activeRunId;
      if (!runId) throw new Error("Submitted task did not start");
      expect(
        firstController.recordCoderSession(
          Bun.randomUUIDv7(),
          taskId,
          runId,
          "omp",
          "omp-session-1",
          "/tmp/omp-session-1.jsonl",
        ).status,
      ).toBe("accepted");
      firstStore.close();

      const recoveryStore = new EventStore(databasePath);
      const recoveryController = new TaskController(recoveryStore);
      expect(recoveryController.snapshot().tasks[0]?.state).toBe("running");
      const recovery = recoveryController.recoverAfterRestart(Bun.randomUUIDv7());
      expect(recovery.status).toBe("accepted");
      let snapshot = recoveryController.snapshot();
      expect(snapshot.activeTaskId).toBe(taskId);
      expect(snapshot.tasks[0]?.state).toBe("paused");
      expect(snapshot.runs[0]?.state).toBe("interrupted");
      expect(snapshot.tasks[0]?.codingSession).toMatchObject({
        backend: "omp",
        id: "omp-session-1",
        file: "/tmp/omp-session-1.jsonl",
        recoveryBoundary: {
          runId,
          unknownToolCall: true,
        },
      });
      expect(recoveryController.eventsAfter().slice(-3).map((event) => event.type)).toEqual([
        "run.interrupted",
        "coder.recoveryBoundary",
        "task.paused",
      ]);
      recoveryStore.close();

      const replayStore = new EventStore(databasePath);
      const replayController = new TaskController(replayStore);
      snapshot = replayController.snapshot();
      expect(snapshot.tasks[0]?.state).toBe("paused");
      expect(snapshot.runs[0]?.state).toBe("interrupted");
      expect(snapshot.tasks[0]?.codingSession?.recoveryBoundary?.unknownToolCall).toBe(true);
      expect(replayController.recoverAfterRestart(Bun.randomUUIDv7()).status).toBe("rejected");
      replayStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reorders only queued tasks and preserves the active slot", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const activeTaskId = submit(controller);
      const secondTaskId = submit(controller);
      const thirdTaskId = submit(controller);

      const moved = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "queue.move",
        actor: "voice",
        expectedRevision: null,
        payload: {
          taskId: thirdTaskId,
          operation: "move_before",
          anchorTaskId: secondTaskId,
        },
      });

      expect(moved.status).toBe("accepted");
      expect(controller.snapshot().activeTaskId).toBe(activeTaskId);
      expect(controller.snapshot().queue).toEqual([thirdTaskId, secondTaskId]);
    } finally {
      store.close();
    }
  });

  test("binds a coder question to its task revision and run, then accepts one exact answer", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskId = submit(controller);
      const questionId = Bun.randomUUIDv7();
      const originalRunId = controller.snapshot().tasks[0]?.activeRunId;
      const awaiting = controller.awaitUserInput(
        questionId,
        taskId,
        "Which deployment target should I use?",
      );
      expect(awaiting.status).toBe("accepted");
      let snapshot = controller.snapshot();
      expect(snapshot.activeTaskId).toBe(taskId);
      expect(snapshot.tasks[0]).toMatchObject({
        state: "awaiting_user",
        pendingQuestion: "Which deployment target should I use?",
      });
      expect(snapshot.runs[0]?.state).toBe("paused");
      expect(snapshot.questions?.[0]).toMatchObject({
        id: questionId,
        taskId,
        taskRevision: 1,
        runId: originalRunId,
        state: "open",
      });
      expect(controller.eventsAfter().at(-1)?.type).toBe("task.questionAsked");

      const genericResume = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.resume",
        actor: "ui",
        expectedRevision: 1,
        payload: { taskId },
      });
      expect(genericResume).toMatchObject({ status: "rejected", code: "question_pending" });

      const answer = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.answerQuestion",
        actor: "ui",
        expectedRevision: 1,
        payload: { taskId, questionId, answer: "Deploy to staging." },
      });
      expect(answer.status).toBe("accepted");
      snapshot = controller.snapshot();
      expect(snapshot.tasks[0]).toMatchObject({ state: "running", pendingQuestion: null });
      expect(snapshot.runs).toHaveLength(2);
      expect(snapshot.questions?.[0]).toMatchObject({
        id: questionId,
        state: "resolved",
        resolution: "answered",
        answer: "Deploy to staging.",
      });
      expect(controller.eventsAfter().slice(-2).map((event) => event.type)).toEqual([
        "task.questionAnswered",
        "task.resumed",
      ]);

      const duplicate = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.answerQuestion",
        actor: "ui",
        expectedRevision: 1,
        payload: { taskId, questionId, answer: "Deploy to production instead." },
      });
      expect(duplicate).toMatchObject({ status: "rejected", code: "stale_question" });
    } finally {
      store.close();
    }
  });

  test("rejects an answer after a consequential task revision supersedes its question", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskId = submit(controller);
      const questionId = Bun.randomUUIDv7();
      expect(
        controller.awaitUserInput(questionId, taskId, "Should this alter the public API?").status,
      ).toBe("accepted");
      expect(
        controller.handle({
          id: Bun.randomUUIDv7(),
          type: "task.revise",
          actor: "ui",
          expectedRevision: 1,
          payload: {
            taskId,
            spec: { ...spec, objective: "Change the behavior without altering the public API" },
          },
        }).status,
      ).toBe("accepted");

      const stale = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.answerQuestion",
        actor: "ui",
        expectedRevision: 2,
        payload: { taskId, questionId, answer: "Yes." },
      });
      expect(stale).toMatchObject({ status: "rejected", code: "stale_question" });
      expect(controller.snapshot().questions?.[0]).toMatchObject({
        state: "resolved",
        resolution: "superseded",
        answer: null,
      });
    } finally {
      store.close();
    }
  });

  test("requires revision-bound single-use approval for risky tool effects", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskId = submit(controller);
      const proposed = controller.authorizeToolCall(
        Bun.randomUUIDv7(),
        taskId,
        "bash",
        { command: "git push origin main" },
      );
      if (proposed.status !== "confirmation_required") throw new Error("Risky action was not held for approval");

      let snapshot = controller.snapshot();
      expect(snapshot.tasks[0]?.state).toBe("awaiting_user");
      expect(snapshot.confirmations[0]).toMatchObject({
        id: proposed.confirmationId,
        taskId,
        taskRevision: 1,
        state: "pending",
      });

      const bypass = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.resume",
        actor: "ui",
        expectedRevision: 1,
        payload: { taskId },
      });
      expect(bypass).toMatchObject({ status: "rejected", code: "confirmation_pending" });

      const approved = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "approval.resolve",
        actor: "ui",
        expectedRevision: 1,
        payload: { confirmationId: proposed.confirmationId, decision: "approve" },
      });
      expect(approved.status).toBe("accepted");

      const consumed = controller.authorizeToolCall(
        Bun.randomUUIDv7(),
        taskId,
        "bash",
        { command: "git push origin main" },
      );
      expect(consumed.status).toBe("accepted");
      snapshot = controller.snapshot();
      expect(snapshot.confirmations[0]?.state).toBe("consumed");

      const repeated = controller.authorizeToolCall(
        Bun.randomUUIDv7(),
        taskId,
        "bash",
        { command: "git push origin main" },
      );
      expect(repeated.status).toBe("confirmation_required");
      expect(controller.snapshot().confirmations).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  test("pauses on a workspace conflict and records explicit reconciliation before resuming", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskId = submit(controller);
      const originalRunId = controller.snapshot().tasks[0]?.activeRunId;
      const conflict = controller.reportWorkspaceConflict(
        Bun.randomUUIDv7(),
        taskId,
        ["src/feature.ts"],
        "The user changed a target file",
      );
      expect(conflict.status).toBe("accepted");
      expect(controller.snapshot().tasks[0]).toMatchObject({
        state: "awaiting_user",
        activeRunId: null,
        workspaceConflict: {
          paths: ["src/feature.ts"],
          reason: "The user changed a target file",
        },
      });

      const resumed = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.resume",
        actor: "ui",
        expectedRevision: 1,
        payload: { taskId },
      });
      expect(resumed.status).toBe("accepted");
      const task = controller.snapshot().tasks[0];
      expect(task).toMatchObject({
        state: "running",
        workspaceConflict: null,
      });
      expect(task?.activeRunId).not.toBe(originalRunId);
      expect(controller.eventsAfter().map((event) => event.type).slice(-2)).toEqual([
        "workspace.conflictResolved",
        "task.resumed",
      ]);
    } finally {
      store.close();
    }
  });

  test("tracks the pending question and spec history through revision and replay", () => {
    const directory = mkdtempSync(join(tmpdir(), "mamachi-spec-history-"));
    const databasePath = join(directory, "events.sqlite");
    try {
      const store = new EventStore(databasePath);
      const controller = new TaskController(store);
      const taskId = submit(controller);
      let task = controller.snapshot().tasks[0];
      expect(task?.pendingQuestion).toBeNull();
      expect(task?.specHistory).toEqual([
        { revision: 1, objective: spec.objective, revisedAt: task?.createdAt ?? "" },
      ]);

      const question = "Should the new endpoint be versioned?";
      expect(controller.awaitUserInput(Bun.randomUUIDv7(), taskId, question).status).toBe("accepted");
      task = controller.snapshot().tasks[0];
      expect(task?.state).toBe("awaiting_user");
      expect(task?.pendingQuestion).toBe(question);

      const revisedObjective = "Change an observable behavior and record telemetry";
      const revised = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.revise",
        actor: "voice",
        expectedRevision: 1,
        payload: { taskId, spec: { ...spec, objective: revisedObjective } },
      });
      expect(revised.status).toBe("accepted");
      task = controller.snapshot().tasks[0];
      expect(task?.revision).toBe(2);
      expect(task?.pendingQuestion).toBeNull();
      expect(task?.specHistory.map((entry) => [entry.revision, entry.objective])).toEqual([
        [1, spec.objective],
        [2, revisedObjective],
      ]);

      const resumed = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.resume",
        actor: "ui",
        expectedRevision: 2,
        payload: { taskId },
      });
      expect(resumed.status).toBe("accepted");
      expect(controller.snapshot().tasks[0]?.pendingQuestion).toBeNull();

      const live = controller.snapshot();
      store.close();
      const replayStore = new EventStore(databasePath);
      const replayed = new TaskController(replayStore).snapshot();
      expect(replayed.tasks).toEqual(live.tasks);
      replayStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("completing one task leaves a concurrently-active sibling's full record untouched", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store, acceptingEvidenceValidator);
      const taskA = submitToRepo(controller, "repo_a");
      const taskB = submitToRepo(controller, "repo_b");
      const beforeB = controller.snapshot().tasks.find((task) => task.id === taskB);

      const completion = controller.completeTask(Bun.randomUUIDv7(), taskA, "done", []);
      expect(completion.status).toBe("accepted");

      const afterB = controller.snapshot().tasks.find((task) => task.id === taskB);
      expect(afterB).toEqual(beforeB);
      expect(controller.snapshot().activeTaskIds).toEqual([taskB]);
    } finally {
      store.close();
    }
  });

  test("failing one task leaves a concurrently-active sibling's full record untouched", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskA = submitToRepo(controller, "repo_a");
      const taskB = submitToRepo(controller, "repo_b");
      const beforeB = controller.snapshot().tasks.find((task) => task.id === taskB);

      const failure = controller.failTask(Bun.randomUUIDv7(), taskA, "unrecoverable error");
      expect(failure.status).toBe("accepted");

      const afterB = controller.snapshot().tasks.find((task) => task.id === taskB);
      expect(afterB).toEqual(beforeB);
      expect(controller.snapshot().activeTaskIds).toEqual([taskB]);
    } finally {
      store.close();
    }
  });

  test("cancelling one task leaves a concurrently-active sibling's full record untouched and releases only its own repository", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskA = submitToRepo(controller, "repo_a");
      const taskB = submitToRepo(controller, "repo_b");
      const beforeB = controller.snapshot().tasks.find((task) => task.id === taskB);

      const cancelled = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.cancel",
        actor: "ui",
        expectedRevision: 1,
        payload: { taskId: taskA, reason: "No longer needed" },
      });
      expect(cancelled.status).toBe("accepted");

      const afterB = controller.snapshot().tasks.find((task) => task.id === taskB);
      expect(afterB).toEqual(beforeB);
      expect(controller.snapshot().activeTaskIds).toEqual([taskB]);

      // repo_a is free again: a new task targeting it starts immediately rather than queuing.
      const thirdTaskId = submitToRepo(controller, "repo_a");
      expect(controller.snapshot().tasks.find((task) => task.id === thirdTaskId)?.state).toBe("running");
      expect(controller.snapshot().queue).toEqual([]);
    } finally {
      store.close();
    }
  });

  test("pausing one task leaves other concurrently-active tasks' full records byte-identical", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskA = submitToRepo(controller, "repo_a");
      const taskB = submitToRepo(controller, "repo_b");
      const taskC = submitToRepo(controller, "repo_c");
      const beforeB = controller.snapshot().tasks.find((task) => task.id === taskB);
      const beforeC = controller.snapshot().tasks.find((task) => task.id === taskC);

      const requested = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.requestPause",
        actor: "voice",
        expectedRevision: 1,
        payload: { taskId: taskA, reason: "Pause A only" },
      });
      expect(requested.status).toBe("accepted");
      const paused = controller.pauseAtSafeBoundary(Bun.randomUUIDv7(), taskA);
      expect(paused.status).toBe("accepted");

      const afterB = controller.snapshot().tasks.find((task) => task.id === taskB);
      const afterC = controller.snapshot().tasks.find((task) => task.id === taskC);
      expect(afterB).toEqual(beforeB);
      expect(afterC).toEqual(beforeC);
    } finally {
      store.close();
    }
  });

  test("a paused task still occupies its repository slot: a same-repository submission queues instead of starting", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskA = submitToRepo(controller, "repo_a");
      controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.requestPause",
        actor: "voice",
        expectedRevision: 1,
        payload: { taskId: taskA, reason: "Pause A" },
      });
      controller.pauseAtSafeBoundary(Bun.randomUUIDv7(), taskA);
      expect(controller.snapshot().tasks.find((task) => task.id === taskA)?.state).toBe("paused");
      expect(controller.snapshot().activeTaskIds).toEqual([taskA]);

      const secondTaskId = submitToRepo(controller, "repo_a");
      const snapshot = controller.snapshot();
      expect(snapshot.tasks.find((task) => task.id === secondTaskId)?.state).toBe("queued");
      expect(snapshot.queue).toEqual([secondTaskId]);
      expect(snapshot.activeTaskIds).toEqual([taskA]);
    } finally {
      store.close();
    }
  });

  test("an awaiting_user task still occupies its repository slot: a same-repository submission queues instead of starting", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskA = submitToRepo(controller, "repo_a");
      const awaiting = controller.awaitUserInput(Bun.randomUUIDv7(), taskA, "Which target should I use?");
      expect(awaiting.status).toBe("accepted");
      expect(controller.snapshot().tasks.find((task) => task.id === taskA)?.state).toBe("awaiting_user");
      expect(controller.snapshot().activeTaskIds).toEqual([taskA]);

      const secondTaskId = submitToRepo(controller, "repo_a");
      const snapshot = controller.snapshot();
      expect(snapshot.tasks.find((task) => task.id === secondTaskId)?.state).toBe("queued");
      expect(snapshot.queue).toEqual([secondTaskId]);
      expect(snapshot.activeTaskIds).toEqual([taskA]);
    } finally {
      store.close();
    }
  });

  test("a question bound to one task cannot be answered by addressing a different task", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskA = submitToRepo(controller, "repo_a");
      const taskB = submitToRepo(controller, "repo_b");
      const questionId = Bun.randomUUIDv7();
      expect(controller.awaitUserInput(questionId, taskA, "Which target for A?").status).toBe("accepted");
      const taskBRevision = controller.snapshot().tasks.find((task) => task.id === taskB)?.revision ?? 1;

      const wrongTask = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "task.answerQuestion",
        actor: "voice",
        expectedRevision: taskBRevision,
        payload: { taskId: taskB, questionId, answer: "Deploy to staging." },
      });
      expect(wrongTask).toMatchObject({ status: "rejected", code: "question_not_found" });

      // The question is untouched -- still open, still unanswered -- and B never left "running".
      expect(controller.snapshot().questions?.find((question) => question.id === questionId)).toMatchObject({
        state: "open",
        answer: null,
      });
      expect(controller.snapshot().tasks.find((task) => task.id === taskA)?.state).toBe("awaiting_user");
      expect(controller.snapshot().tasks.find((task) => task.id === taskB)?.state).toBe("running");
    } finally {
      store.close();
    }
  });

  test("resolving one task's confirmation leaves a sibling task's separate pending confirmation untouched", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskA = submitToRepo(controller, "repo_a");
      const taskB = submitToRepo(controller, "repo_b");

      const proposedA = controller.authorizeToolCall(Bun.randomUUIDv7(), taskA, "bash", {
        command: "git push origin main",
      });
      if (proposedA.status !== "confirmation_required") throw new Error("Expected A's risky action to require approval");
      const proposedB = controller.authorizeToolCall(Bun.randomUUIDv7(), taskB, "bash", {
        command: "rm -rf build",
      });
      if (proposedB.status !== "confirmation_required") throw new Error("Expected B's risky action to require approval");

      const beforeB = controller.snapshot().confirmations.find((confirmation) => confirmation.id === proposedB.confirmationId);
      expect(beforeB?.state).toBe("pending");

      const resolvedA = controller.handle({
        id: Bun.randomUUIDv7(),
        type: "approval.resolve",
        actor: "ui",
        expectedRevision: 1,
        payload: { confirmationId: proposedA.confirmationId, decision: "approve" },
      });
      expect(resolvedA.status).toBe("accepted");

      const afterB = controller.snapshot().confirmations.find((confirmation) => confirmation.id === proposedB.confirmationId);
      expect(afterB).toEqual(beforeB);
      expect(controller.snapshot().tasks.find((task) => task.id === taskA)?.state).toBe("running");
      expect(controller.snapshot().tasks.find((task) => task.id === taskB)?.state).toBe("awaiting_user");
    } finally {
      store.close();
    }
  });

  test("a run id belonging to a different task is rejected as stale rather than accepted cross-task", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store);
      const taskA = submitToRepo(controller, "repo_a");
      const taskB = submitToRepo(controller, "repo_b");
      const runIdOfA = controller.snapshot().tasks.find((task) => task.id === taskA)?.activeRunId;
      if (!runIdOfA) throw new Error("Task A did not start");

      const crossed = controller.recordCoderSession(
        Bun.randomUUIDv7(),
        taskB,
        runIdOfA,
        "omp",
        "cross-task-session",
        "/tmp/cross-task-session.jsonl",
      );
      expect(crossed).toMatchObject({ status: "rejected", code: "stale_run" });
      expect(controller.snapshot().tasks.find((task) => task.id === taskB)?.codingSession).toBeNull();
    } finally {
      store.close();
    }
  });

  test("late signals addressed to a task's old run cannot mutate it once the task has finished", () => {
    const store = new EventStore();
    try {
      const controller = new TaskController(store, acceptingEvidenceValidator);
      const taskId = submit(controller);
      const originalRunId = controller.snapshot().tasks[0]?.activeRunId;
      if (!originalRunId) throw new Error("Task did not start");

      const completion = controller.completeTask(Bun.randomUUIDv7(), taskId, "done", []);
      expect(completion.status).toBe("accepted");

      const lateArtifact = controller.recordArtifact(Bun.randomUUIDv7(), taskId, {
        id: Bun.randomUUIDv7(),
        ordinal: 1,
        taskId,
        runId: originalRunId,
        toolCallId: "late-1",
        toolName: "bash",
        kind: "tool_result",
        summary: "A late tool result from the finished run",
        successful: true,
        payload: {},
        createdAt: new Date().toISOString(),
      });
      expect(lateArtifact).toMatchObject({ status: "rejected", code: "stale_run" });

      const lateAuthorize = controller.authorizeToolCall(Bun.randomUUIDv7(), taskId, "bash", { command: "echo hi" });
      expect(lateAuthorize).toMatchObject({ status: "rejected", code: "invalid_state" });

      const latePause = controller.pauseAtSafeBoundary(Bun.randomUUIDv7(), taskId);
      expect(latePause).toMatchObject({ status: "rejected", code: "invalid_state" });

      const lateQuestion = controller.awaitUserInput(Bun.randomUUIDv7(), taskId, "Still relevant?");
      expect(lateQuestion).toMatchObject({ status: "rejected", code: "invalid_state" });

      expect(controller.snapshot().tasks[0]).toMatchObject({ state: "completed", evidenceIds: [] });
    } finally {
      store.close();
    }
  });

  test("task B cannot complete using task A's evidence, even though both tasks are concurrently active", () => {
    const directory = mkdtempSync(join(tmpdir(), "mamachi-cross-evidence-"));
    const databasePath = join(directory, "state.sqlite");
    const events = new EventStore(databasePath);
    const artifacts = new ArtifactStore(databasePath);
    try {
      const controller = new TaskController(events, {
        validateEvidence: (taskId, runId, evidenceIds) => artifacts.validateCompletion(taskId, runId, evidenceIds),
      });
      const taskA = submitToRepo(controller, "repo_evidence_a");
      const taskB = submitToRepo(controller, "repo_evidence_b");
      const runA = controller.snapshot().tasks.find((task) => task.id === taskA)?.activeRunId;
      if (!runA) throw new Error("Task A did not start");

      const changedA = artifacts.recordToolEvidence({
        taskId: taskA,
        runId: runA,
        repository: "repo_evidence_a",
        toolCallId: "write-a",
        toolName: "write",
        input: { path: "a.ts", content: "export const a = 1;" },
        result: { status: "ok" },
        isError: false,
      });
      expect(controller.recordArtifact(Bun.randomUUIDv7(), taskA, changedA).status).toBe("accepted");
      const verifiedA = artifacts.recordToolEvidence({
        taskId: taskA,
        runId: runA,
        repository: "repo_evidence_a",
        toolCallId: "test-a",
        toolName: "bash",
        input: { command: "bun test" },
        result: { exitCode: 0 },
        isError: false,
      });
      expect(controller.recordArtifact(Bun.randomUUIDv7(), taskA, verifiedA).status).toBe("accepted");

      // If A's evidence (bug) leaked into B's completion check, citing it would wrongly satisfy B's gate.
      const crossCompletion = controller.completeTask(Bun.randomUUIDv7(), taskB, "Borrowed A's evidence", [
        changedA.id,
        verifiedA.id,
      ]);
      expect(crossCompletion).toMatchObject({ status: "rejected", code: "verification_incomplete" });
      expect(controller.snapshot().tasks.find((task) => task.id === taskB)?.state).toBe("running");

      // A's own completion, citing its own evidence, legitimately succeeds -- proving the
      // gate isn't just unconditionally rejecting, only cross-task evidence specifically.
      const ownCompletion = controller.completeTask(Bun.randomUUIDv7(), taskA, "Implemented and verified", [
        changedA.id,
        verifiedA.id,
      ]);
      expect(ownCompletion.status).toBe("accepted");
    } finally {
      artifacts.close();
      events.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("recovering twice in a row finds nothing left to recover the second time", () => {
    const directory = mkdtempSync(join(tmpdir(), "mamachi-recovery-idempotent-"));
    const databasePath = join(directory, "state.sqlite");
    try {
      const firstStore = new EventStore(databasePath);
      const firstController = new TaskController(firstStore);
      submitToRepo(firstController, "repo_a");
      submitToRepo(firstController, "repo_b");
      firstStore.close();

      const recoveryStore = new EventStore(databasePath);
      const recoveryController = new TaskController(recoveryStore);
      const first = recoveryController.recoverAfterRestart(Bun.randomUUIDv7());
      expect(first.status).toBe("accepted");
      // Calling it again on the same controller, without an intervening resume,
      // must not re-interrupt already-paused tasks: there is nothing running anymore.
      const second = recoveryController.recoverAfterRestart(Bun.randomUUIDv7());
      expect(second).toMatchObject({ status: "rejected", code: "nothing_to_recover" });

      const snapshot = recoveryController.snapshot();
      expect(snapshot.tasks.every((task) => task.state === "paused")).toBe(true);
      recoveryStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("recovery only touches genuinely running/pause_requested tasks, leaving already-paused and awaiting_user tasks alone", () => {
    const directory = mkdtempSync(join(tmpdir(), "mamachi-recovery-mixed-"));
    const databasePath = join(directory, "state.sqlite");
    try {
      const firstStore = new EventStore(databasePath);
      const firstController = new TaskController(firstStore);
      const runningTask = submitToRepo(firstController, "repo_running");
      const pausedTask = submitToRepo(firstController, "repo_paused");
      const awaitingTask = submitToRepo(firstController, "repo_awaiting");

      firstController.handle({
        id: Bun.randomUUIDv7(),
        type: "task.requestPause",
        actor: "voice",
        expectedRevision: 1,
        payload: { taskId: pausedTask, reason: "Pause before recovery" },
      });
      firstController.pauseAtSafeBoundary(Bun.randomUUIDv7(), pausedTask);
      firstController.awaitUserInput(Bun.randomUUIDv7(), awaitingTask, "Which target?");

      const beforePaused = firstController.snapshot().tasks.find((task) => task.id === pausedTask);
      const beforeAwaiting = firstController.snapshot().tasks.find((task) => task.id === awaitingTask);
      firstStore.close();

      const recoveryStore = new EventStore(databasePath);
      const recoveryController = new TaskController(recoveryStore);
      const recovery = recoveryController.recoverAfterRestart(Bun.randomUUIDv7());
      expect(recovery.status).toBe("accepted");

      const snapshot = recoveryController.snapshot();
      expect(snapshot.tasks.find((task) => task.id === runningTask)?.state).toBe("paused");
      // Recovery is scoped exactly to the one task that genuinely needed it; the two
      // tasks that were already stopped for a different reason are untouched.
      expect(snapshot.tasks.find((task) => task.id === pausedTask)).toEqual(beforePaused);
      expect(snapshot.tasks.find((task) => task.id === awaitingTask)).toEqual(beforeAwaiting);
      recoveryStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("recovery never crosses task/run association even when multiple tasks have bound coder sessions", () => {
    const directory = mkdtempSync(join(tmpdir(), "mamachi-recovery-association-"));
    const databasePath = join(directory, "state.sqlite");
    try {
      const firstStore = new EventStore(databasePath);
      const firstController = new TaskController(firstStore);
      const taskA = submitToRepo(firstController, "repo_a");
      const taskB = submitToRepo(firstController, "repo_b");
      const runA = firstController.snapshot().tasks.find((task) => task.id === taskA)?.activeRunId;
      const runB = firstController.snapshot().tasks.find((task) => task.id === taskB)?.activeRunId;
      if (!runA || !runB) throw new Error("Both tasks should have started");
      expect(
        firstController.recordCoderSession(Bun.randomUUIDv7(), taskA, runA, "omp", "session-a", "/tmp/session-a.jsonl")
          .status,
      ).toBe("accepted");
      expect(
        firstController.recordCoderSession(Bun.randomUUIDv7(), taskB, runB, "codex", "session-b", null).status,
      ).toBe("accepted");
      firstStore.close();

      const recoveryStore = new EventStore(databasePath);
      const recoveryController = new TaskController(recoveryStore);
      expect(recoveryController.recoverAfterRestart(Bun.randomUUIDv7()).status).toBe("accepted");

      const snapshot = recoveryController.snapshot();
      const finalA = snapshot.tasks.find((task) => task.id === taskA);
      const finalB = snapshot.tasks.find((task) => task.id === taskB);
      expect(finalA?.codingSession).toMatchObject({ backend: "omp", id: "session-a" });
      expect(finalA?.codingSession?.recoveryBoundary).toMatchObject({ runId: runA });
      expect(finalB?.codingSession).toMatchObject({ backend: "codex", id: "session-b" });
      expect(finalB?.codingSession?.recoveryBoundary).toMatchObject({ runId: runB });
      recoveryStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("an event log recorded before multi-repo concurrency (never more than one active task) replays cleanly through the current reducer", () => {
    const directory = mkdtempSync(join(tmpdir(), "mamachi-backward-compat-"));
    const databasePath = join(directory, "state.sqlite");
    try {
      const store = new EventStore(databasePath);
      const controller = new TaskController(store, acceptingEvidenceValidator);
      // Exercise exactly the pattern the single-task-only version of this app produced:
      // submit, complete, submit, complete -- activeTaskIds never exceeds length 1.
      const first = submit(controller);
      expect(controller.completeTask(Bun.randomUUIDv7(), first, "done", []).status).toBe("accepted");
      const second = submit(controller);
      expect(controller.completeTask(Bun.randomUUIDv7(), second, "done", []).status).toBe("accepted");
      const liveSnapshot = controller.snapshot();
      store.close();

      const replayStore = new EventStore(databasePath);
      const replayed = new TaskController(replayStore, acceptingEvidenceValidator).snapshot();
      expect(replayed.tasks).toEqual(liveSnapshot.tasks);
      expect(replayed.activeTaskIds).toEqual([]);
      expect(replayed.activeTaskId).toBeNull();
      replayStore.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
