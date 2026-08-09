import type { DomainEvent, TaskSpec } from "@mamachi/protocol";

export type TaskState =
  | "queued"
  | "running"
  | "pause_requested"
  | "paused"
  | "awaiting_user"
  | "completed"
  | "failed"
  | "cancelled";

export type RunState = "running" | "paused" | "completed" | "failed" | "cancelled" | "interrupted";

export const MAX_CONCURRENT_TASKS = 4;

export interface WorkspaceConflictRecord {
  paths: string[];
  reason: string;
  detectedAt: string;
}

export interface CodingRecoveryBoundary {
  runId: string;
  reason: string;
  unknownToolCall: boolean;
  recordedAt: string;
}

export interface CodingSessionRecord {
  backend: "omp" | "codex" | "claude";
  id: string;
  file: string | null;
  boundRunId: string;
  recoveryBoundary: CodingRecoveryBoundary | null;
}

export interface SpecHistoryEntry {
  revision: number;
  objective: string;
  revisedAt: string;
}

export interface TaskRecord {
  id: string;
  repositoryId: string;
  state: TaskState;
  spec: TaskSpec;
  revision: number;
  activeRunId: string | null;
  runIds: string[];
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
  terminalSummary: string | null;
  workspaceConflict: WorkspaceConflictRecord | null;
  codingSession?: CodingSessionRecord | null;
  pendingQuestion: string | null;
  specHistory: SpecHistoryEntry[];
}

export interface RunRecord {
  id: string;
  taskId: string;
  taskRevision: number;
  state: RunState;
  startedAt: string;
  endedAt: string | null;
}

export interface QuestionRecord {
  id: string;
  taskId: string;
  taskRevision: number;
  runId: string;
  question: string;
  state: "open" | "resolved";
  resolution: "answered" | "superseded" | "abandoned" | null;
  answer: string | null;
  askedAt: string;
  resolvedAt: string | null;
}

export type ConfirmationState = "pending" | "approved" | "rejected" | "consumed";

export interface ConfirmationRecord {
  id: string;
  taskId: string;
  taskRevision: number;
  category: string;
  summary: string;
  effectFingerprint: string;
  toolName: string;
  state: ConfirmationState;
  createdAt: string;
  resolvedAt: string | null;
  consumedAt: string | null;
}

export interface ControllerState {
  seq: number;
  activeTaskIds: string[];
  queue: string[];
  tasks: Map<string, TaskRecord>;
  runs: Map<string, RunRecord>;
  confirmations: Map<string, ConfirmationRecord>;
  questions: Map<string, QuestionRecord>;
}

export interface ControllerSnapshot {
  seq: number;
  activeTaskId: string | null;
  activeTaskIds?: string[];
  queue: string[];
  tasks: TaskRecord[];
  runs: RunRecord[];
  confirmations: ConfirmationRecord[];
  questions?: QuestionRecord[];
}

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

function requiredTask(state: ControllerState, taskId: string): TaskRecord {
  const task = state.tasks.get(taskId);
  if (!task) throw new Error(`Event references missing task ${taskId}`);
  return task;
}

function requiredRun(state: ControllerState, runId: string): RunRecord {
  const run = state.runs.get(runId);
  if (!run) throw new Error(`Event references missing run ${runId}`);
  return run;
}

function requiredConfirmation(state: ControllerState, confirmationId: string): ConfirmationRecord {
  const confirmation = state.confirmations.get(confirmationId);
  if (!confirmation) throw new Error(`Event references missing confirmation ${confirmationId}`);
  return confirmation;
}

function requiredQuestion(state: ControllerState, questionId: string): QuestionRecord {
  const question = state.questions.get(questionId);
  if (!question) throw new Error(`Event references missing question ${questionId}`);
  return question;
}

function requireTaskId(event: DomainEvent): string {
  if (!event.taskId) throw new Error(`${event.type} is missing taskId`);
  return event.taskId;
}

function removeFromQueue(state: ControllerState, taskId: string): void {
  const index = state.queue.indexOf(taskId);
  if (index !== -1) state.queue.splice(index, 1);
}

/**
 * A task can reach a terminal state (completed, failed, or cancelled) while
 * it still has an open question or a pending confirmation -- most directly
 * via `task.cancel`, which (unlike completion/failure) is accepted from any
 * non-terminal state, including `awaiting_user`. Without this cleanup the
 * question/confirmation record would keep pointing at a task that can never
 * resolve it, and for questions specifically `assertStateInvariants` treats
 * that as corruption (an open question implies `awaiting_user`) and throws.
 * Mirrors the analogous cleanup `task.specRevised` already does for open
 * questions it supersedes, below.
 */
function abandonOpenWorkOn(state: ControllerState, taskId: string, at: string): void {
  for (const question of state.questions.values()) {
    if (question.taskId === taskId && question.state === "open") {
      question.state = "resolved";
      question.resolution = "abandoned";
      question.resolvedAt = at;
    }
  }
  for (const confirmation of state.confirmations.values()) {
    if (confirmation.taskId === taskId && confirmation.state === "pending") {
      confirmation.state = "rejected";
      confirmation.resolvedAt = at;
    }
  }
}

export function applyEvent(state: ControllerState, event: DomainEvent): void {
  if (event.seq !== state.seq + 1) {
    throw new Error(`Non-contiguous event sequence: expected ${state.seq + 1}, received ${event.seq}`);
  }

  switch (event.type) {
    case "task.created": {
      const taskId = requireTaskId(event);
      if (state.tasks.has(taskId)) throw new Error(`Task ${taskId} already exists`);
      state.tasks.set(taskId, {
        id: taskId,
        repositoryId: event.payload.spec.repositoryId,
        state: "queued",
        spec: event.payload.spec,
        revision: event.payload.revision,
        activeRunId: null,
        runIds: [],
        evidenceIds: [],
        createdAt: event.at,
        updatedAt: event.at,
        workspaceConflict: null,
        terminalSummary: null,
        codingSession: null,
        pendingQuestion: null,
        specHistory: [
          {
            revision: event.payload.revision,
            objective: event.payload.spec.objective,
            revisedAt: event.at,
          },
        ],
      });
      break;
    }
    case "task.enqueued": {
      const taskId = requireTaskId(event);
      const task = requiredTask(state, taskId);
      removeFromQueue(state, taskId);
      const position = Math.min(event.payload.position, state.queue.length);
      state.queue.splice(position, 0, taskId);
      task.state = "queued";
      task.updatedAt = event.at;
      break;
    }
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
    case "task.pauseRequested": {
      const task = requiredTask(state, requireTaskId(event));
      task.state = "pause_requested";
      task.updatedAt = event.at;
      break;
    }
    case "task.paused": {
      const task = requiredTask(state, requireTaskId(event));
      const run = requiredRun(state, event.payload.runId);
      if (run.state !== "interrupted") run.state = "paused";
      run.endedAt = event.at;
      task.state = "paused";
      task.activeRunId = null;
      task.updatedAt = event.at;
      break;
    }
    case "task.awaitingUser": {
      const task = requiredTask(state, requireTaskId(event));
      const run = requiredRun(state, event.payload.runId);
      run.state = "paused";
      run.endedAt = event.at;
      task.state = "awaiting_user";
      task.pendingQuestion = event.payload.question;
      task.activeRunId = null;
      task.updatedAt = event.at;
      break;
    }
    case "task.questionAsked": {
      const taskId = requireTaskId(event);
      const task = requiredTask(state, taskId);
      const run = requiredRun(state, event.payload.runId);
      if (state.questions.has(event.payload.questionId)) {
        throw new Error(`Question ${event.payload.questionId} already exists`);
      }
      state.questions.set(event.payload.questionId, {
        id: event.payload.questionId,
        taskId,
        taskRevision: event.payload.revision,
        runId: event.payload.runId,
        question: event.payload.question,
        state: "open",
        resolution: null,
        answer: null,
        askedAt: event.at,
        resolvedAt: null,
      });
      run.state = "paused";
      run.endedAt = event.at;
      task.state = "awaiting_user";
      task.pendingQuestion = event.payload.question;
      task.activeRunId = null;
      task.updatedAt = event.at;
      break;
    }
    case "task.questionAnswered": {
      const question = requiredQuestion(state, event.payload.questionId);
      question.state = "resolved";
      question.resolution = "answered";
      question.answer = event.payload.answer;
      question.resolvedAt = event.at;
      break;
    }
    case "coder.sessionBound": {
      const task = requiredTask(state, requireTaskId(event));
      task.codingSession = {
        backend: event.payload.backend,
        id: event.payload.sessionId,
        file: event.payload.sessionFile,
        boundRunId: event.payload.runId,
        recoveryBoundary: null,
      };
      task.updatedAt = event.at;
      break;
    }
    case "coder.recoveryBoundary": {
      const task = requiredTask(state, requireTaskId(event));
      if (task.codingSession && event.payload.sessionId === task.codingSession.id) {
        task.codingSession.recoveryBoundary = {
          runId: event.payload.runId,
          reason: event.payload.reason,
          unknownToolCall: event.payload.unknownToolCall,
          recordedAt: event.at,
        };
      }
      task.updatedAt = event.at;
      break;
    }
    case "task.specRevised": {
      const task = requiredTask(state, requireTaskId(event));
      task.spec = event.payload.spec;
      task.revision = event.payload.revision;
      task.specHistory.push({
        revision: event.payload.revision,
        objective: event.payload.spec.objective,
        revisedAt: event.at,
      });
      task.pendingQuestion = null;
      task.updatedAt = event.at;
      for (const question of state.questions.values()) {
        if (question.taskId === task.id && question.state === "open") {
          question.state = "resolved";
          question.resolution = "superseded";
          question.resolvedAt = event.at;
        }
      }
      break;
    }
    case "task.completed": {
      const taskId = requireTaskId(event);
      const task = requiredTask(state, taskId);
      const run = requiredRun(state, event.payload.runId);
      run.state = "completed";
      run.endedAt = event.at;
      task.state = "completed";
      task.activeRunId = null;
      task.updatedAt = event.at;
      task.terminalSummary = event.payload.summary;
      task.pendingQuestion = null;
      abandonOpenWorkOn(state, taskId, event.at);
      removeFromQueue(state, taskId);
      state.activeTaskIds = state.activeTaskIds.filter((id) => id !== taskId);
      break;
    }
    case "task.failed": {
      const taskId = requireTaskId(event);
      const task = requiredTask(state, taskId);
      const run = requiredRun(state, event.payload.runId);
      run.state = "failed";
      run.endedAt = event.at;
      task.state = "failed";
      task.activeRunId = null;
      task.updatedAt = event.at;
      task.terminalSummary = event.payload.error;
      task.pendingQuestion = null;
      abandonOpenWorkOn(state, taskId, event.at);
      removeFromQueue(state, taskId);
      state.activeTaskIds = state.activeTaskIds.filter((id) => id !== taskId);
      break;
    }
    case "task.cancelled": {
      const taskId = requireTaskId(event);
      const task = requiredTask(state, taskId);
      if (task.activeRunId) {
        const run = requiredRun(state, task.activeRunId);
        run.state = "cancelled";
        run.endedAt = event.at;
      }
      task.state = "cancelled";
      task.activeRunId = null;
      task.updatedAt = event.at;
      task.terminalSummary = event.payload.reason;
      task.pendingQuestion = null;
      abandonOpenWorkOn(state, taskId, event.at);
      removeFromQueue(state, taskId);
      state.activeTaskIds = state.activeTaskIds.filter((id) => id !== taskId);
      break;
    }
    case "run.interrupted": {
      const run = requiredRun(state, event.payload.runId);
      run.state = "interrupted";
      run.endedAt = event.at;
      break;
    }
    case "policy.decisionRecorded":
      break;
    case "artifact.created": {
      const task = requiredTask(state, requireTaskId(event));
      if (!task.evidenceIds.includes(event.payload.artifactId)) {
        task.evidenceIds.push(event.payload.artifactId);
      }
      task.updatedAt = event.at;
      break;
    }
    case "workspace.conflictDetected": {
      const task = requiredTask(state, requireTaskId(event));
      task.workspaceConflict = {
        paths: [...event.payload.paths],
        reason: event.payload.reason,
        detectedAt: event.at,
      };
      task.updatedAt = event.at;
      break;
    }
    case "workspace.conflictResolved": {
      const task = requiredTask(state, requireTaskId(event));
      task.workspaceConflict = null;
      task.updatedAt = event.at;
      break;
    }
    case "approval.requested": {
      const taskId = requireTaskId(event);
      if (state.confirmations.has(event.payload.confirmationId)) {
        throw new Error(`Confirmation ${event.payload.confirmationId} already exists`);
      }
      state.confirmations.set(event.payload.confirmationId, {
        id: event.payload.confirmationId,
        taskId,
        taskRevision: event.payload.revision,
        category: event.payload.category,
        summary: event.payload.summary,
        effectFingerprint: event.payload.effectFingerprint,
        toolName: event.payload.toolName,
        state: "pending",
        createdAt: event.at,
        resolvedAt: null,
        consumedAt: null,
      });
      break;
    }
    case "approval.resolved": {
      const confirmation = requiredConfirmation(state, event.payload.confirmationId);
      confirmation.state = event.payload.decision === "approve" ? "approved" : "rejected";
      confirmation.resolvedAt = event.at;
      break;
    }
    case "approval.consumed": {
      const confirmation = requiredConfirmation(state, event.payload.confirmationId);
      confirmation.state = "consumed";
      confirmation.consumedAt = event.at;
      break;
    }
    case "queue.reordered": {
      state.queue = [...event.payload.taskIds];
      break;
    }
  }

  state.seq = event.seq;
  assertStateInvariants(state);
}

export function replayEvents(events: readonly DomainEvent[]): ControllerState {
  const state = createEmptyState();
  for (const event of events) applyEvent(state, event);
  return state;
}

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

export function assertStateInvariants(state: ControllerState): void {
  const queued = new Set(state.queue);
  if (queued.size !== state.queue.length) throw new Error("Queue contains duplicate tasks");

  for (const taskId of state.queue) {
    const task = state.tasks.get(taskId);
    if (!task) throw new Error(`Queue references missing task ${taskId}`);
    if (task.state !== "queued") throw new Error(`Queue contains non-queued task ${taskId}`);
  }

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

  for (const task of state.tasks.values()) {
    if (task.activeRunId) {
      const run = state.runs.get(task.activeRunId);
      if (!run) throw new Error(`Task ${task.id} references missing active run ${task.activeRunId}`);
      if (run.taskId !== task.id) throw new Error(`Run ${run.id} belongs to a different task`);
      if (!(["running", "interrupted"] as RunState[]).includes(run.state)) {
        throw new Error(`Task ${task.id} points to inactive run ${run.id}`);
      }
      if (run.state === "interrupted" && !(task.state === "running" || task.state === "pause_requested")) {
        throw new Error(`Interrupted run ${run.id} is attached to task state ${task.state}`);
      }
    }
    const openQuestions = [...state.questions.values()].filter(
      (question) => question.taskId === task.id && question.state === "open",
    );
    if (openQuestions.length > 1) {
      throw new Error(`Task ${task.id} has multiple open questions`);
    }
    if (openQuestions.length === 1 && task.state !== "awaiting_user") {
      throw new Error(`Task ${task.id} has an open question while ${task.state}`);
    }
    if (task.specHistory.at(-1)?.revision !== task.revision) {
      throw new Error(`Task ${task.id} spec history is out of sync with revision ${task.revision}`);
    }
  }
}
