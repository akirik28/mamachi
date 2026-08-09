# Multi-agent (concurrent tasks) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the daemon run up to `MAX_CONCURRENT_TASKS` coding tasks at once (never two on the same `repositoryId`), instead of hard-enforcing exactly one active task, while keeping one voice conversation and changing the smallest possible surface.

**Architecture:** `domain.ts` replaces the scalar `activeTaskId` slot with an `activeTaskIds` list plus a per-repository mutex invariant. `controller.ts`'s 14 call sites that compared against the scalar switch to list membership; `#submit`/`#startNextEvent` gain capacity+mutex checks. `coding-runner.ts` stops holding three eager backend-type singletons and instead creates one backend-runner instance per concurrently-active task (each instance is unchanged internally — still exactly the single-task-safe class it always was — concurrency comes from having N instances, not from making one instance multi-task-aware). The wire-facing `ControllerSnapshot` gets a new `activeTaskIds` field additively; the legacy `activeTaskId` field is kept, now derived as "the first/oldest active task," so every existing consumer (voice bridges, fact projector, demo script, and ~40 test fixtures) keeps compiling and behaving exactly as today with zero changes. Swift adds a client-local "focus" concept (tap a running task row to make it the one shown/steered) layered on top of the same derived default.

**Tech Stack:** TypeScript + Bun (packages/core), Swift 6 + SwiftUI (apps/macos).

## Global Constraints

- `MAX_CONCURRENT_TASKS = 4` (exported const in `domain.ts`). Not user-configurable — YAGNI.
- At most one active task per `repositoryId`, always, enforced independently at both the pre-check (controller.ts, before an event is even created) and the invariant (domain.ts `assertStateInvariants`, after every event applied) layers, matching this codebase's existing belt-and-suspenders pattern.
- `ControllerSnapshot.activeTaskId` (legacy scalar) must keep meaning exactly what it means today for every existing consumer — do not repurpose it. It is derived, never independently mutated.
- No protocol/codegen changes. `ControllerSnapshot` is a hand-written TS interface consumed via raw `[String: Any]` dictionary access in Swift (confirmed: `grep -rn "activeTaskId" packages/protocol/src/index.ts` is empty, and `AppModel.swift:959` reads `rawSnapshot["activeTaskId"] as? String`) — adding a key is additive and safe on both sides without touching `packages/protocol` or running `bindings:generate`.
- Match existing style exactly: tabs/spaces, private `#fields` in TS classes, no new dependencies, no formatter config (copy the neighbours), per `CONTRIBUTING.md`.
- Every new behavior needs a test that fails without the change (per `CONTRIBUTING.md`'s PR checklist).

---

### Task 1: `domain.ts` — concurrent active-task-list state

**Files:**
- Modify: `packages/core/src/domain.ts:98-128` (state/snapshot shapes + `createEmptyState`), `:208-233` (task.started/resumed case), `:341-387` (completed/failed/cancelled cases), `:462-478` (snapshotState), `:480-524` (assertStateInvariants)
- Test: `packages/core/test/controller.test.ts` (no `domain.test.ts` exists in this repo; domain-level behavior is exercised through `TaskController` — follow that existing convention, don't create a new file)

**Interfaces:**
- Produces: `export const MAX_CONCURRENT_TASKS = 4;` (new, exported from `domain.ts`)
- Produces: `ControllerState.activeTaskIds: string[]` (renamed from `activeTaskId: string | null`; internal-only type, never read directly by tests or other modules — confirmed via `grep -rn "activeTaskId" packages/core/src packages/core/test apps` — every external reference goes through `ControllerSnapshot`, not `ControllerState`)
- Produces: `ControllerSnapshot.activeTaskIds: string[]` (new field, additive) alongside the unchanged `ControllerSnapshot.activeTaskId: string | null` (now derived as `activeTaskIds[0] ?? null` inside `snapshotState`)
- Consumes (Task 2): `controller.ts` will read `this.#state.activeTaskIds` and import `MAX_CONCURRENT_TASKS`

- [ ] **Step 1: Write the failing tests**

Add to `packages/core/test/controller.test.ts`, in the existing `describe("TaskController", () => { ... })` block, near the other queueing tests:

```typescript
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
    expect(snapshot.activeTaskIds.sort()).toEqual([firstTaskId, secondTaskId.taskId].sort());
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
    expect(snapshot.activeTaskIds).toEqual([firstTaskId]);
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
    expect(snapshot.activeTaskIds).toHaveLength(4);
    expect(snapshot.queue).toEqual([taskIds[4]]);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && bun test test/controller.test.ts`
Expected: FAIL — `snapshot.activeTaskIds` is `undefined` (property doesn't exist yet), and the "starts a second task immediately" test fails because today's `#submit` only auto-starts when nothing is active at all, regardless of repository.

- [ ] **Step 3: Implement the state-shape and reducer changes**

In `packages/core/src/domain.ts`, add near the top-level exports (after the `RunState` type, ~line 13):

```typescript
export const MAX_CONCURRENT_TASKS = 4;
```

Change `ControllerState` (was `activeTaskId: string | null;` at line 100):

```typescript
export interface ControllerState {
  seq: number;
  activeTaskIds: string[];
  queue: string[];
  tasks: Map<string, TaskRecord>;
  runs: Map<string, RunRecord>;
  confirmations: Map<string, ConfirmationRecord>;
  questions: Map<string, QuestionRecord>;
}
```

Change `ControllerSnapshot` (was `activeTaskId: string | null;` at line 110) to keep the legacy field and add the new one:

```typescript
export interface ControllerSnapshot {
  seq: number;
  activeTaskId: string | null;
  activeTaskIds: string[];
  queue: string[];
  tasks: TaskRecord[];
  runs: RunRecord[];
  confirmations: ConfirmationRecord[];
  questions?: QuestionRecord[];
}
```

Change `createEmptyState` (was `activeTaskId: null,` at line 121):

```typescript
export function createEmptyState(): ControllerState {
  return {
    seq: 0,
    activeTaskIds: [],
    queue: [],
    tasks: new Map(),
    runs: new Map(),
    confirmations: new Map(),
    questions: new Map(),
  };
}
```

Replace the `task.started`/`task.resumed` case body (lines 208-233) with:

```typescript
    case "task.started":
    case "task.resumed": {
      const taskId = requireTaskId(event);
      const task = requiredTask(state, taskId);
      const runId = event.payload.runId;
      if (!state.activeTaskIds.includes(taskId)) {
        if (state.activeTaskIds.length >= MAX_CONCURRENT_TASKS) {
          throw new Error(`Cannot start ${taskId}; ${MAX_CONCURRENT_TASKS} tasks are already active`);
        }
        const conflictingTaskId = state.activeTaskIds.find(
          (activeId) => requiredTask(state, activeId).repositoryId === task.repositoryId,
        );
        if (conflictingTaskId) {
          throw new Error(`Cannot start ${taskId}; ${conflictingTaskId} already owns repository ${task.repositoryId}`);
        }
      }
      if (state.runs.has(runId)) throw new Error(`Run ${runId} already exists`);
      removeFromQueue(state, taskId);
      task.state = "running";
      task.pendingQuestion = null;
      task.activeRunId = runId;
      task.runIds.push(runId);
      task.updatedAt = event.at;
      state.runs.set(runId, {
        id: runId,
        taskId,
        taskRevision: event.payload.revision,
        state: "running",
        startedAt: event.at,
        endedAt: null,
      });
      if (!state.activeTaskIds.includes(taskId)) state.activeTaskIds.push(taskId);
      break;
    }
```

In the `task.completed`, `task.failed`, and `task.cancelled` cases, replace each occurrence of
`if (state.activeTaskId === taskId) state.activeTaskId = null;` (three occurrences, originally
lines 353, 368, 385) with:

```typescript
      state.activeTaskIds = state.activeTaskIds.filter((id) => id !== taskId);
```

In `snapshotState` (lines 468-478), add the two active-task fields:

```typescript
export function snapshotState(state: ControllerState): ControllerSnapshot {
  return {
    seq: state.seq,
    activeTaskId: state.activeTaskIds[0] ?? null,
    activeTaskIds: [...state.activeTaskIds],
    queue: [...state.queue],
    tasks: [...state.tasks.values()].map((task) => structuredClone(task)),
    runs: [...state.runs.values()].map((run) => structuredClone(run)),
    confirmations: [...state.confirmations.values()].map((confirmation) => structuredClone(confirmation)),
    questions: [...state.questions.values()].map((question) => structuredClone(question)),
  };
}
```

Replace the single-active-task block in `assertStateInvariants` (lines 490-497):

```typescript
  if (state.activeTaskIds.length > MAX_CONCURRENT_TASKS) {
    throw new Error(`${state.activeTaskIds.length} tasks are active; the cap is ${MAX_CONCURRENT_TASKS}`);
  }
  if (new Set(state.activeTaskIds).size !== state.activeTaskIds.length) {
    throw new Error("Active task list contains duplicates");
  }
  const activeRepositories = new Set<string>();
  for (const taskId of state.activeTaskIds) {
    const task = state.tasks.get(taskId);
    if (!task) throw new Error(`Active slot references missing task ${taskId}`);
    if (!(["running", "pause_requested", "paused", "awaiting_user"] as TaskState[]).includes(task.state)) {
      throw new Error(`Active task ${task.id} has invalid state ${task.state}`);
    }
    if (queued.has(task.id)) throw new Error(`Active task ${task.id} is also queued`);
    if (activeRepositories.has(task.repositoryId)) {
      throw new Error(`Repository ${task.repositoryId} has more than one active task`);
    }
    activeRepositories.add(task.repositoryId);
  }
```

Note: this is everything domain.ts needs for Task 1. `controller.ts` still references `this.#state.activeTaskId` in 14 places — that file won't compile until Task 2. That's expected; Task 2 is next and this plan is meant to be executed task-by-task, not have every intermediate commit typecheck in isolation across files that share state ownership this tightly. If your workflow requires each task to typecheck standalone, do Task 1 and Task 2 as one commit — see the note at the start of Task 2.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && bun test test/controller.test.ts`
Expected: still FAIL at this point — `controller.ts` doesn't compile yet (references the removed `activeTaskId` field). This is expected; proceed to Task 2 before re-running.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/domain.ts packages/core/test/controller.test.ts
git commit -m "feat(domain): replace single active-task slot with a concurrent task list"
```

---

### Task 2: `controller.ts` — concurrency-aware guards, submit, and recovery

**Files:**
- Modify: `packages/core/src/controller.ts` (14 sites listed below, plus `#submit`, `#startNextEvent`, `recoverAfterRestart`)
- Test: `packages/core/test/controller.test.ts` (same file as Task 1 — this task makes those tests compile and pass, and adds recovery/queue-skip tests of its own)

**Interfaces:**
- Consumes: `MAX_CONCURRENT_TASKS` from `./domain.ts` (Task 1); `ControllerState.activeTaskIds: string[]` (Task 1)
- Produces: `TaskController#isRepositoryActive(repositoryId: string): boolean` (new private helper, used by `#submit` and `#startNextEvent`)

- [ ] **Step 1: Update the import**

In `packages/core/src/controller.ts:11-18`, add `MAX_CONCURRENT_TASKS` to the existing `./domain.ts` import:

```typescript
import {
  applyEvent,
  replayEvents,
  snapshotState,
  MAX_CONCURRENT_TASKS,
  type ControllerSnapshot,
  type ControllerState,
  type TaskRecord,
} from "./domain.ts";
```

- [ ] **Step 2: Mechanically replace the 11 simple scalar-comparison guards**

These 11 sites are a pure `===`/`!==` → `.includes()`/`!.includes()` swap, no other logic changes. Original line numbers (before Task 1/2 edits shift them — search for the quoted text, don't rely on line numbers):

1. `awaitUserInput`: `if (task.id !== this.#state.activeTaskId || task.state !== "running" || !task.activeRunId) {` → `if (!this.#state.activeTaskIds.includes(task.id) || task.state !== "running" || !task.activeRunId) {`
2. `recordCoderSession`: `if (task.id !== this.#state.activeTaskId || task.activeRunId !== runId) {` → `if (!this.#state.activeTaskIds.includes(task.id) || task.activeRunId !== runId) {`
3. `authorizeToolCall`: `if (current.id !== this.#state.activeTaskId || current.state !== "running" || !current.activeRunId) {` → `if (!this.#state.activeTaskIds.includes(current.id) || current.state !== "running" || !current.activeRunId) {`
4. `recordArtifact`: `if (task.id !== this.#state.activeTaskId || task.activeRunId !== artifact.runId) {` → `if (!this.#state.activeTaskIds.includes(task.id) || task.activeRunId !== artifact.runId) {`
5. `reportWorkspaceConflict`: `if (task.id !== this.#state.activeTaskId || !task.activeRunId || task.state !== "running") {` → `if (!this.#state.activeTaskIds.includes(task.id) || !task.activeRunId || task.state !== "running") {`
6. `#requestPause`: `if (task.id !== this.#state.activeTaskId || task.state !== "running") {` → `if (!this.#state.activeTaskIds.includes(task.id) || task.state !== "running") {`
7. `#revise`: `if (!(task.state === "paused" || task.state === "awaiting_user") || task.id !== this.#state.activeTaskId) {` → `if (!(task.state === "paused" || task.state === "awaiting_user") || !this.#state.activeTaskIds.includes(task.id)) {`
8. `#resume`: same pattern as #7 (identical text, different method) → same replacement pattern
9. `#answerQuestion`: `... || task.state !== "awaiting_user" || task.id !== this.#state.activeTaskId` (last clause of a multi-line `if`) → `... || task.state !== "awaiting_user" || !this.#state.activeTaskIds.includes(task.id)`
10. `#resolveApproval`: `if (task.state !== "awaiting_user" || task.id !== this.#state.activeTaskId) {` → `if (task.state !== "awaiting_user" || !this.#state.activeTaskIds.includes(task.id)) {`
11. `#finishTask`: `if (task.id !== this.#state.activeTaskId || !task.activeRunId) {` → `if (!this.#state.activeTaskIds.includes(task.id) || !task.activeRunId) {`

And one boolean assignment in `#cancel`:

`const wasActive = task.id === this.#state.activeTaskId;` → `const wasActive = this.#state.activeTaskIds.includes(task.id);`

- [ ] **Step 3: Run tests to check progress**

Run: `cd packages/core && bun test test/controller.test.ts`
Expected: compiles now (all `activeTaskId` scalar references gone except the three below); the new Task-1 tests for "starts a second task immediately" and "caps concurrent" still FAIL because `#submit`/`#startNextEvent`/`recoverAfterRestart` haven't changed yet.

- [ ] **Step 4: Add the repository-mutex helper**

Add as a new private method, near `#requiredTask` (~line 859):

```typescript
  #isRepositoryActive(repositoryId: string): boolean {
    return this.#state.activeTaskIds.some(
      (taskId) => this.#requiredTask(taskId).repositoryId === repositoryId,
    );
  }
```

- [ ] **Step 5: Update `#submit` to check capacity and the per-repository mutex**

Replace (originally ~line 536):

```typescript
    if (!this.#state.activeTaskId) {
```

with:

```typescript
    const canStartNow =
      this.#state.activeTaskIds.length < MAX_CONCURRENT_TASKS && !this.#isRepositoryActive(spec.repositoryId);
    if (canStartNow) {
```

(The rest of the `if` block — pushing a `task.started` event — is unchanged.)

- [ ] **Step 6: Update `#startNextEvent` with the same checks**

Replace the full method (originally lines 845-857):

```typescript
  #startNextEvent(correlationId: string): NewDomainEvent<"task.started"> | null {
    const nextTaskId = this.#state.queue[0];
    if (!nextTaskId) return null;
    if (this.#state.activeTaskIds.length >= MAX_CONCURRENT_TASKS) return null;
    const nextTask = this.#requiredTask(nextTaskId);
    if (this.#isRepositoryActive(nextTask.repositoryId)) return null;
    const runId = this.#createId();
    return this.#event(
      "task.started",
      { runId, revision: nextTask.revision },
      correlationId,
      nextTask,
      runId,
    );
  }
```

This intentionally does **not** scan past `queue[0]` looking for a queued task on a free repository — it keeps today's strict FIFO semantics (a queued task can sit behind an unrelated repository's queued task) rather than adding skip-ahead scheduling. The common "start a second concurrent task" path goes through `#submit`'s own immediate-start check in Step 5, which is unaffected by this trade-off; only the secondary "service the backlog as things finish" path is strict-FIFO. This is a deliberate scope cut — see the design doc §3 rationale (multi-instance runners, not a scheduler rewrite) if reconsidering it later.

- [ ] **Step 7: Rewrite `recoverAfterRestart` for multiple active tasks**

Replace the full method (originally lines 428-483):

```typescript
  recoverAfterRestart(recoveryId: string): ActionResult {
    const execution = this.#store.executeCommand(
      {
        id: recoveryId,
        type: "internal.recoverAfterRestart",
        actor: "controller",
        expectedRevision: null,
        payload: {},
        createdAt: this.#now(),
      },
      () => {
        const recoverableTaskIds = this.#state.activeTaskIds.filter((taskId) => {
          const task = this.#requiredTask(taskId);
          return (task.state === "running" || task.state === "pause_requested") && task.activeRunId;
        });
        if (recoverableTaskIds.length === 0) {
          return this.#reject("nothing_to_recover", "No task owns an active slot");
        }

        const events: NewDomainEvent[] = [];
        for (const taskId of recoverableTaskIds) {
          const task = this.#requiredTask(taskId);
          const runId = task.activeRunId as string;
          events.push(
            this.#event(
              "run.interrupted",
              { runId, reason: "daemon restarted with an unfinished run" },
              recoveryId,
              task,
              runId,
            ),
          );
          if (task.codingSession) {
            events.push(
              this.#event(
                "coder.recoveryBoundary",
                {
                  sessionId: task.codingSession.id,
                  runId,
                  reason: "Daemon recovery stopped at an unknown in-flight tool boundary; no tool call was replayed",
                  unknownToolCall: true,
                },
                recoveryId,
                task,
                runId,
                "coder",
              ),
            );
          }
          events.push(
            this.#event(
              "task.paused",
              { runId, reason: "recovery requires explicit resume" },
              recoveryId,
              task,
              runId,
            ),
          );
        }
        return this.#accept(events);
      },
    );

    for (const event of execution.events) applyEvent(this.#state, event);
    return execution.result;
  }
```

`#accept(events)` is called without a `taskId` (the second parameter is optional — see `#accept`'s signature at the bottom of the class) since recovery now spans multiple tasks and no single one is "the" result. Confirmed safe: `recoverAfterRestart`'s only caller, `ipc-server.ts:431-435`, awaits the `ActionResult` but never reads `.taskId` off it.

- [ ] **Step 8: Write the remaining failing tests, then watch them pass**

Add to `packages/core/test/controller.test.ts`:

```typescript
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
    const secondTaskId = controller.snapshot().activeTaskIds.find((id) => id !== firstTaskId)!;

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
    const controller = new TaskController(store);
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
    controller.completeTask(Bun.randomUUIDv7(), repoBTask.taskId!, "done", []);
    expect(controller.snapshot().queue).toEqual([repoATaskTwo]);
    expect(controller.snapshot().activeTaskIds).toEqual([repoATaskOne]);

    controller.completeTask(Bun.randomUUIDv7(), repoATaskOne, "done", []);
    expect(controller.snapshot().queue).toEqual([]);
    expect(controller.snapshot().activeTaskIds).toEqual([repoATaskTwo]);
  } finally {
    store.close();
  }
});
```

Run: `cd packages/core && bun test test/controller.test.ts`
Expected: all tests in the file PASS, including the ones added in Task 1.

- [ ] **Step 9: Run the full package test suite**

Run: `cd packages/core && bun test`
Expected: PASS. This surfaces any other test file that assumed single-task semantics through `TaskController` (as opposed to through `ControllerSnapshot.activeTaskId`, which stays compatible). If something else fails, read the failure — do not paper over it by weakening an assertion.

- [ ] **Step 10: Commit**

```bash
git add packages/core/src/controller.ts packages/core/test/controller.test.ts
git commit -m "feat(controller): allow concurrent tasks across distinct repositories"
```

---

### Task 3: `coding-runner.ts` — one backend-runner instance per active task

**Files:**
- Modify: `packages/core/src/coding-runner.ts` (full rewrite of the class body; the `CodingBackendRunner` interface at lines 14-22 and `CodingRunnerOptions` at lines 24-36 are unchanged)
- Test: Create `packages/core/test/coding-runner.test.ts` (no such file exists today)

**Interfaces:**
- Consumes: `CodingBackendRunner` (unchanged 7-member interface, `coding-runner.ts:14-22`), `CodingRunnerOptions` (unchanged, `coding-runner.ts:24-36`)
- Produces: `CodingRunner.askCoder(taskId, question)` / `.steer(...)` / `.followUp(...)` now genuinely route by `taskId` instead of ignoring it (the parameter existed before but was dead — confirmed via `grep -n "askCoder\|steer(\|followUp(" packages/core/src/daemon.ts packages/core/src/voice-toolkit.ts`, callers already pass a real `taskId`)

- [ ] **Step 1: Write the failing tests**

Create `packages/core/test/coding-runner.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { DomainEvent } from "@mamachi/protocol";
import { CodingRunner, type CodingRunnerOptions } from "../src/coding-runner.ts";
import type { TaskRecord } from "../src/domain.ts";

function baseTask(id: string, backend: "omp" | "codex" | "claude"): TaskRecord {
  return {
    id,
    repositoryId: `repo-${id}`,
    state: "running",
    spec: {
      repositoryId: `repo-${id}`,
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

function startedEvent(taskId: string): DomainEvent {
  return {
    version: 1,
    id: `evt-${taskId}-start`,
    at: new Date().toISOString(),
    type: "task.started",
    actor: "controller",
    projectId: `repo-${taskId}`,
    taskId,
    runId: `run-${taskId}`,
    seq: 1,
    correlationId: "corr",
    causedBy: "corr",
    payload: { runId: `run-${taskId}`, revision: 1 },
  } as unknown as DomainEvent;
}

function completedEvent(taskId: string): DomainEvent {
  return {
    version: 1,
    id: `evt-${taskId}-done`,
    at: new Date().toISOString(),
    type: "task.completed",
    actor: "controller",
    projectId: `repo-${taskId}`,
    taskId,
    runId: `run-${taskId}`,
    seq: 2,
    correlationId: "corr",
    causedBy: "corr",
    payload: { runId: `run-${taskId}`, summary: "done", evidenceIds: [] },
  } as unknown as DomainEvent;
}

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
  test("routes askCoder/steer/followUp to the specific task's own runner instance", async () => {
    const tasks = { "task-a": baseTask("task-a", "codex"), "task-b": baseTask("task-b", "claude") };
    const runner = new CodingRunner(makeOptions(tasks));

    runner.handleEvents([startedEvent("task-a"), startedEvent("task-b")]);

    // Neither the fake codex nor claude CLI is actually spawned in this unit test
    // (that's ExternalCliRunner's own test suite's job); askCoder/steer/followUp on a
    // real ExternalCliRunner instance return false until a process is attached, which
    // is exactly what we're asserting here: both tasks are independently routable and
    // neither call throws or silently no-ops onto the other task's instance.
    const askA = await runner.askCoder("task-a", "status?");
    const askB = await runner.askCoder("task-b", "status?");
    expect(askA).toBe(false);
    expect(askB).toBe(false);

    // A taskId with no runner at all (never started) must not throw.
    const askUnknown = await runner.askCoder("task-c", "status?");
    expect(askUnknown).toBe(false);
  });

  test("disposes and forgets a task's runner instance once it reaches a terminal event", async () => {
    const tasks = { "task-a": baseTask("task-a", "omp") };
    const runner = new CodingRunner(makeOptions(tasks));

    runner.handleEvents([startedEvent("task-a")]);
    runner.handleEvents([completedEvent("task-a")]);

    // After disposal, routing to task-a must behave like "no runner for this task"
    // (false), not throw and not resurrect a disposed instance.
    const ask = await runner.askCoder("task-a", "status?");
    expect(ask).toBe(false);
  });

  test("dispose() tears down every currently-active task's runner", async () => {
    const tasks = { "task-a": baseTask("task-a", "codex"), "task-b": baseTask("task-b", "codex") };
    const runner = new CodingRunner(makeOptions(tasks));

    runner.handleEvents([startedEvent("task-a"), startedEvent("task-b")]);
    await runner.dispose();

    // dispose() must not throw calling again with nothing left to dispose.
    await runner.dispose();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/core && bun test test/coding-runner.test.ts`
Expected: FAIL — with today's code, `runner.askCoder("task-a", ...)` routes through the single `#activeBackend` (which after both `startedEvent` calls will be whatever the *last* `task.started` event's backend was — `"claude"` for task-b — so `askCoder("task-a", ...)` would silently be routed to the **claude** runner instance instead of task-a's own **codex** runner, i.e. cross-task bleed). The test as written mostly checks "doesn't throw, returns false" so the clearest failure will likely be in the second test (disposal) or require inspecting behavior more directly — if the first test happens to pass by coincidence (both return `false` either way, since neither real CLI is spawned), that's fine: it isn't the test carrying the signal. The disposal test is the one that must fail against the old code — today's `CodingRunner` has no per-task disposal at all, and there's no way to observe "is task-a's runner still there" without triggering a real process; if this test doesn't clearly fail against old code, treat this as confirmation that the *observable behavior* needs a sharper assertion, and add one: assert that `(runner as any).runners` (or a small test-only accessor, see Step 3 note) reflects the map shrinking. Prefer changing the test to something observable over skipping the "watch it fail" step.

- [ ] **Step 3: Implement the per-task runner map**

Replace the full body of `packages/core/src/coding-runner.ts` (keep the imports and the `CodingBackendRunner`/`CodingRunnerOptions` declarations at the top, lines 1-36, unchanged) with:

```typescript
export class CodingRunner {
  readonly #options: CodingRunnerOptions;
  readonly #runners = new Map<string, CodingBackendRunner>();
  #runtimeSettings: RuntimeSettings;

  constructor(options: CodingRunnerOptions) {
    this.#options = options;
    this.#runtimeSettings = options.runtimeSettings ?? defaultRuntimeSettings;
  }

  configure(settings: RuntimeSettings): void {
    this.#runtimeSettings = settings;
    for (const runner of this.#runners.values()) runner.configure(settings);
  }

  updateEditorState(state: EditorDocumentState): void {
    for (const runner of this.#runners.values()) runner.updateEditorState(state);
  }

  async askCoder(taskId: string, question: string): Promise<boolean> {
    const runner = this.#runners.get(taskId);
    return runner ? runner.askCoder(taskId, question) : false;
  }

  async steer(taskId: string, clarification: string): Promise<boolean> {
    const runner = this.#runners.get(taskId);
    return runner ? runner.steer(taskId, clarification) : false;
  }

  async followUp(taskId: string, addition: string): Promise<boolean> {
    const runner = this.#runners.get(taskId);
    return runner ? runner.followUp(taskId, addition) : false;
  }

  handleEvents(events: readonly DomainEvent[]): void {
    for (const event of events) {
      if (!event.taskId) continue;
      if (event.type === "task.started" || event.type === "task.resumed") {
        if (!this.#runners.has(event.taskId)) {
          const task = this.#options.getTask(event.taskId);
          const backend = task?.codingSession?.backend ?? this.#runtimeSettings.codingBackend;
          this.#runners.set(event.taskId, this.#createRunner(backend));
        }
      }
      this.#runners.get(event.taskId)?.handleEvents([event]);
      if (
        event.type === "task.completed" ||
        event.type === "task.failed" ||
        event.type === "task.cancelled"
      ) {
        const finished = this.#runners.get(event.taskId);
        if (finished) {
          this.#runners.delete(event.taskId);
          void finished.dispose();
        }
      }
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.#runners.values()].map((runner) => runner.dispose()));
    this.#runners.clear();
  }

  #createRunner(backend: CodingBackend): CodingBackendRunner {
    const options = this.#options;
    if (backend === "omp") {
      return new OmpRunner({
        getTask: options.getTask,
        ...(options.getArtifacts ? { getArtifacts: options.getArtifacts } : {}),
        emit: options.emit,
        onSafePause: options.onSafePause,
        onAuthorizeTool: options.onAuthorizeTool,
        onWorkspaceConflict: options.onWorkspaceConflict,
        onRecordEvidence: options.onRecordEvidence,
        onComplete: options.onComplete,
        onFail: options.onFail,
        onNeedInput: options.onNeedInput,
        ...(options.onSessionBound ? { onSessionBound: options.onSessionBound } : {}),
        ...(options.authStorage ? { authStorage: options.authStorage } : {}),
        ...(options.createSession ? { createSession: options.createSession } : {}),
        ...(options.openSession ? { openSession: options.openSession } : {}),
        runtimeSettings: this.#runtimeSettings,
      });
    }
    const sharedExternal: Omit<ExternalCliRunnerOptions, "backend" | "executable" | "workspaceGuard"> = {
      getTask: options.getTask,
      ...(options.getArtifacts ? { getArtifacts: options.getArtifacts } : {}),
      emit: options.emit,
      onSafePause: options.onSafePause,
      onAuthorizeTool: options.onAuthorizeTool,
      onWorkspaceConflict: options.onWorkspaceConflict,
      onRecordEvidence: options.onRecordEvidence,
      onComplete: options.onComplete,
      onFail: options.onFail,
      onNeedInput: options.onNeedInput,
      ...(options.onSessionBound ? { onSessionBound: options.onSessionBound } : {}),
      runtimeSettings: this.#runtimeSettings,
    };
    return new ExternalCliRunner({
      ...sharedExternal,
      backend,
      ...(backend === "codex" && options.codexExecutable ? { executable: options.codexExecutable } : {}),
      ...(backend === "claude" && options.claudeExecutable ? { executable: options.claudeExecutable } : {}),
    });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/core && bun test test/coding-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full package test suite**

Run: `cd packages/core && bun test`
Expected: PASS. Pay particular attention to `omp-runner.test.ts` and `external-cli-runner.test.ts` — they test those classes directly, not through `CodingRunner`, so they should be unaffected, but confirm rather than assume.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/coding-runner.ts packages/core/test/coding-runner.test.ts
git commit -m "feat(coding-runner): one backend-runner instance per concurrently-active task"
```

---

### Task 4: Swift — `AppModel` gains a task list and a client-local focus

**Files:**
- Modify: `apps/macos/Sources/Mamachi/AppModel.swift:12` (field), `:73-76` (computed `activeTask`), `:959` (applySnapshot assignment), and one new method
- Test: Create `apps/macos/Tests/MamachiTests/AppModelConcurrentTasksTests.swift`

**Interfaces:**
- Produces: `AppModel.activeTaskIds: [String]` (new `@Published`, all currently-active tasks reported by the daemon)
- Produces: `AppModel.focusedTaskId: String?` (new `@Published`, client-local override, nil = no override)
- Produces: `AppModel.activeTaskId: String?` (same public name and type as today, now a *computed* property instead of stored — resolves `focusedTaskId` if it's still active, else falls back to the daemon's primary)
- Produces: `AppModel.focusTask(_ taskId: String)` (new method — sets `focusedTaskId`)
- Consumes (Task 5): Swift views read `activeTask`, `activeTaskIds`, and call `focusTask(_:)`

- [ ] **Step 1: Write the failing test**

Create `apps/macos/Tests/MamachiTests/AppModelConcurrentTasksTests.swift`:

```swift
import XCTest
@testable import Mamachi

final class AppModelConcurrentTasksTests: XCTestCase {
    @MainActor
    func testActiveTaskDefaultsToThePrimaryDaemonReportedTask() {
        let model = AppModel()
        model.tasks = [
            TaskViewState(id: "a", state: "running", revision: 1, objective: "A", terminalSummary: nil, recentActivity: nil),
            TaskViewState(id: "b", state: "running", revision: 1, objective: "B", terminalSummary: nil, recentActivity: nil),
        ]
        model.activeTaskIds = ["a", "b"]
        model.primaryActiveTaskId = "a"

        XCTAssertEqual(model.activeTaskId, "a")
        XCTAssertEqual(model.activeTask?.id, "a")
    }

    @MainActor
    func testFocusTaskOverridesThePrimaryTaskWhileStillActive() {
        let model = AppModel()
        model.tasks = [
            TaskViewState(id: "a", state: "running", revision: 1, objective: "A", terminalSummary: nil, recentActivity: nil),
            TaskViewState(id: "b", state: "running", revision: 1, objective: "B", terminalSummary: nil, recentActivity: nil),
        ]
        model.activeTaskIds = ["a", "b"]
        model.primaryActiveTaskId = "a"

        model.focusTask("b")

        XCTAssertEqual(model.activeTaskId, "b")
        XCTAssertEqual(model.activeTask?.id, "b")
    }

    @MainActor
    func testFocusFallsBackToPrimaryOnceTheFocusedTaskIsNoLongerActive() {
        let model = AppModel()
        model.tasks = [
            TaskViewState(id: "a", state: "running", revision: 1, objective: "A", terminalSummary: nil, recentActivity: nil),
        ]
        model.activeTaskIds = ["a", "b"]
        model.primaryActiveTaskId = "a"
        model.focusTask("b")
        XCTAssertEqual(model.activeTaskId, "b")

        // "b" finishes: the daemon's next snapshot no longer reports it as active.
        model.activeTaskIds = ["a"]

        XCTAssertEqual(model.activeTaskId, "a", "focus must not point at a task that's no longer active")
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `swift test --package-path apps/macos --filter AppModelConcurrentTasksTests`
Expected: FAIL to compile — `activeTaskIds`, `primaryActiveTaskId`, and `focusTask(_:)` don't exist yet.

- [ ] **Step 3: Implement**

In `apps/macos/Sources/Mamachi/AppModel.swift`, replace the stored field at line 12:

```swift
    @Published var activeTaskId: String?
```

with:

```swift
    @Published var primaryActiveTaskId: String?
    @Published var activeTaskIds: [String] = []
    @Published var focusedTaskId: String?
```

Replace the computed `activeTask` property at lines 73-76:

```swift
    var activeTask: TaskViewState? {
        guard let activeTaskId else { return nil }
        return tasks.first(where: { $0.id == activeTaskId })
    }
```

with:

```swift
    /// The task the compact pill, menu bar, and drawer focus on: the user's
    /// explicit tap-to-focus choice if it's still active, else the daemon's
    /// primary (oldest-started) active task.
    var activeTaskId: String? {
        if let focusedTaskId, activeTaskIds.contains(focusedTaskId) {
            return focusedTaskId
        }
        return primaryActiveTaskId
    }

    var activeTask: TaskViewState? {
        guard let activeTaskId else { return nil }
        return tasks.first(where: { $0.id == activeTaskId })
    }

    /// Tap-to-focus: make `taskId` the one shown in the compact pill and
    /// steered by voice commands that don't name a task explicitly. Purely
    /// client-local — the daemon has no concept of "focus", only of which
    /// tasks are active (`activeTaskIds`).
    func focusTask(_ taskId: String) {
        focusedTaskId = taskId
    }
```

In `applySnapshot` (~line 959), replace:

```swift
        activeTaskId = rawSnapshot["activeTaskId"] as? String
```

with:

```swift
        primaryActiveTaskId = rawSnapshot["activeTaskId"] as? String
        activeTaskIds = rawSnapshot["activeTaskIds"] as? [String] ?? []
        if let focusedTaskId, !activeTaskIds.contains(focusedTaskId) {
            self.focusedTaskId = nil
        }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `swift test --package-path apps/macos --filter AppModelConcurrentTasksTests`
Expected: PASS.

- [ ] **Step 5: Run the full Swift test suite**

Run: `swift test --package-path apps/macos`
Expected: PASS. `activeTaskId` changed from stored to computed but kept its exact name and type (`String?`), so no other file should need changes — confirm this rather than assume it (grep found no direct View-level reads of `model.activeTaskId`, only of `model.activeTask`/`model.pendingConfirmation`, but re-check after this edit in case something was missed).

- [ ] **Step 6: Commit**

```bash
git add apps/macos/Sources/Mamachi/AppModel.swift apps/macos/Tests/MamachiTests/AppModelConcurrentTasksTests.swift
git commit -m "feat(macos): track all active tasks and add client-local task focus"
```

---

### Task 5: Swift — show and switch between concurrently-running tasks

**Files:**
- Modify: `apps/macos/Sources/Mamachi/TaskDrawerView.swift` (new section + prop), `apps/macos/Sources/Mamachi/OverlayView.swift:216-235` (pass the two new props)

**Interfaces:**
- Consumes: `TaskViewState.isTerminal`, `.stateLabel` (existing, `AppTypes.swift`), `AppModel.activeTaskIds`, `AppModel.focusTask(_:)` (Task 4)

- [ ] **Step 1: Add the new props and computed list to `TaskDrawerView`**

In `apps/macos/Sources/Mamachi/TaskDrawerView.swift`, add two properties to the struct (near the existing `queue`/`onReorderQueue` declarations, ~lines 10-16):

```swift
    let activeTaskIds: [String]
    var onFocusTask: ((String) -> Void)?
```

Add a computed property near `historyTasks` (~line 23):

```swift
    /// Tasks that are running concurrently but aren't the one currently
    /// focused — invisible before multi-agent, since only one non-terminal
    /// task could ever exist at a time.
    private var otherRunningTasks: [TaskViewState] {
        tasks.filter { !$0.isTerminal && $0.id != activeTask?.id && !queue.contains($0.id) }
    }
```

- [ ] **Step 2: Render the new section**

In `body` (~lines 27-49), add the section between the queue section and the fact sections:

```swift
                if !queue.isEmpty {
                    queueSection
                }
                if !otherRunningTasks.isEmpty {
                    otherRunningSection
                }
                if let task = focusTask {
                    factSections(task)
                }
```

Add the section view, near `queueSection` for style parity:

```swift
    private var otherRunningSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "bolt.fill")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                SectionLabel("Also running")
                Spacer()
            }
            ForEach(otherRunningTasks) { task in
                Button {
                    onFocusTask?(task.id)
                } label: {
                    HStack(alignment: .top, spacing: 7) {
                        Circle()
                            .fill(Theme.statusColor(task.state))
                            .frame(width: 6, height: 6)
                            .padding(.top, 4)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(task.objective)
                                .font(.system(size: 10.5, weight: .semibold))
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                            Text(task.stateLabel)
                                .font(.system(size: 9))
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                }
                .buttonStyle(.plain)
                if task.id != otherRunningTasks.last?.id {
                    Divider().opacity(0.4)
                }
            }
        }
        .padding(12)
        .glassCard()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Other running tasks, \(otherRunningTasks.count)")
    }
```

- [ ] **Step 3: Wire the new props at the call site**

In `apps/macos/Sources/Mamachi/OverlayView.swift`, in the `taskDrawer` computed property (lines 215-236), add two arguments to the `TaskDrawerView(...)` call:

```swift
    private var taskDrawer: some View {
        TaskDrawerView(
            workspace: model.workspace,
            activeTask: model.activeTask,
            tasks: model.tasks,
            queue: model.queue,
            activeTaskIds: model.activeTaskIds,
            pendingContexts: model.pendingContexts,
            attentionMessage: model.attentionMessage,
            hasPendingApproval: model.pendingConfirmation != nil,
            onControlTask: model.controlActiveTask,
            onFocusTask: model.focusTask,
            onReorderQueue: { taskId, offset in
                model.moveQueuedTask(taskId, up: offset < 0)
            },
            onRemoveQueued: { taskId in
                guard let task = model.tasks.first(where: { $0.id == taskId }) else { return }
                model.cancelQueuedTask(task)
            },
            onRemoveContext: { context in
                model.removeContext(context.id)
            }
        )
    }
```

- [ ] **Step 4: Build and run the Swift suite**

Run: `swift build --package-path apps/macos`
Expected: builds clean (this section has no dedicated snapshot test in this task — `OverlaySnapshotTests.swift` covers full-panel rendering separately and is exercised in Task 6's verification pass; adding a new snapshot case for `otherRunningSection` is a reasonable follow-up but not required for this task to be complete, since `AppModelConcurrentTasksTests` in Task 4 already covers the actual focus-resolution logic this view depends on).

Run: `swift test --package-path apps/macos`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/macos/Sources/Mamachi/TaskDrawerView.swift apps/macos/Sources/Mamachi/OverlayView.swift
git commit -m "feat(macos): show other concurrently-running tasks and let the user focus one"
```

---

### Task 6: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Run the full check script**

Run: `bun run check`
Expected: `typecheck && version:check && test && protocol:check && macos:test` all PASS. `protocol:check` passing with zero diff confirms Task 1-3's changes genuinely needed no `packages/protocol` edits, as designed.

- [ ] **Step 2: Confirm no OpenAI/provider key was needed anywhere in the above**

Run: `env -u OPENAI_API_KEY -u ANTHROPIC_API_KEY bun run check`
Expected: same PASS result — this is the claim the design doc and PR description make ("everything above runs with no OpenAI key"); actually run it with the keys unset rather than asserting it from memory.

- [ ] **Step 3: Manual sanity pass with `bun run demo`**

Run: `bun run demo`
Expected: the scripted walkthrough still completes (it drives the controller directly; if it hardcodes assumptions about a single active task, this is where that surfaces before a human hits it).

- [ ] **Step 4: Update `docs/ARCHITECTURE.md` §11 if applicable**

Read `docs/ARCHITECTURE.md#11-design-vs-implementation`. This PR doesn't close any of the five listed gaps, so no entry should be removed — confirm that's still true (re-read the section, don't assume it's unchanged) rather than skipping this step.

- [ ] **Step 5: Final review pass**

`git diff main --stat` and read through every changed file once, end to end, checking for: leftover debug code, a stray `console.log`, a TODO you meant to resolve, an assertion you loosened instead of fixing the code. This mirrors `CONTRIBUTING.md`'s own PR checklist.

- [ ] **Step 6: Stop — do not push or open the PR yet**

This plan produces a branch ready for review, not a published PR. Report back (to whoever is coordinating this work) with: the commit list, `git diff main --stat`, full test output from Step 1, and a drafted PR title/body that explicitly notes the conflict with `docs/product-requirements.md` §6.1-6.2 non-goals per the design doc's §2 framing, before anyone runs `git push` / `gh pr create`.
