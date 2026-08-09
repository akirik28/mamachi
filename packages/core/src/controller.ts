import {
  parseCommand,
  type ActionResult,
  type Command,
  type EventPayload,
  type EventActor,
  type EventType,
  type NewDomainEvent,
  type TaskSpec,
} from "@mamachi/protocol";
import {
  applyEvent,
  replayEvents,
  snapshotState,
  MAX_CONCURRENT_TASKS,
  type ControllerSnapshot,
  type ControllerState,
  type TaskRecord,
} from "./domain.ts";
import { EventStore, type CommandDecision } from "./event-store.ts";
import { assessToolCall, type ToolPolicyAssessment } from "./policy.ts";
import type {
  CompletionEvidenceValidation,
  EvidenceArtifact,
} from "./artifact-store.ts";

export type ToolPolicyAssessor = (toolName: string, input: unknown, repository: string) => ToolPolicyAssessment;
export type CompletionEvidenceValidator = (
  taskId: string,
  runId: string,
  evidenceIds: readonly string[],
) => CompletionEvidenceValidation;

export interface ControllerOptions {
  createId?: () => string;
  now?: () => string;
  assessTool?: ToolPolicyAssessor;
  validateEvidence?: CompletionEvidenceValidator;
}

export class TaskController {
  readonly #store: EventStore;
  readonly #createId: () => string;
  readonly #now: () => string;
  readonly #assessTool: ToolPolicyAssessor;
  readonly #validateEvidence: CompletionEvidenceValidator;
  #state: ControllerState;

  constructor(store: EventStore, options: ControllerOptions = {}) {
    this.#store = store;
    this.#createId = options.createId ?? (() => Bun.randomUUIDv7());
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#assessTool = options.assessTool ?? assessToolCall;
    this.#validateEvidence =
      options.validateEvidence ??
      (() => ({
        valid: false,
        implementationComplete: false,
        verificationComplete: false,
        explanation: "No persisted evidence validator is configured",
      }));
    this.#state = replayEvents(store.readAfter());
  }

  handle(input: unknown): ActionResult {
    const command = parseCommand(input);
    const execution = this.#store.executeCommand(
      {
        id: command.id,
        type: command.type,
        actor: command.actor,
        expectedRevision: command.expectedRevision,
        payload: command.payload,
        createdAt: this.#now(),
      },
      () => this.#decide(command),
    );

    for (const event of execution.events) applyEvent(this.#state, event);
    return execution.result;
  }

  pauseAtSafeBoundary(signalId: string, taskId: string, reason = "safe tool boundary reached"): ActionResult {
    const execution = this.#store.executeCommand(
      {
        id: signalId,
        type: "internal.safeBoundaryReached",
        actor: "coder",
        expectedRevision: null,
        payload: { taskId, reason },
        createdAt: this.#now(),
      },
      () => {
        const task = this.#state.tasks.get(taskId);
        if (!task) return this.#reject("task_not_found", `Task ${taskId} does not exist`);
        if (task.state !== "pause_requested" || !task.activeRunId) {
          return this.#reject("invalid_state", `Task ${taskId} is not waiting for a safe pause boundary`);
        }
        const event = this.#event(
          "task.paused",
          { runId: task.activeRunId, reason },
          signalId,
          task,
          task.activeRunId,
        );
        return this.#accept([event], task.id);
      },
    );

    for (const event of execution.events) applyEvent(this.#state, event);
    return execution.result;
  }

  awaitUserInput(questionId: string, taskId: string, question: string): ActionResult {
    const execution = this.#store.executeCommand(
      {
        id: questionId,
        type: "internal.task.questionAsked",
        actor: "coder",
        expectedRevision: null,
        payload: { taskId, questionId, question },
        createdAt: this.#now(),
      },
      () => {
        const task = this.#state.tasks.get(taskId);
        if (!task) return this.#reject("task_not_found", `Task ${taskId} does not exist`);
        if (!this.#state.activeTaskIds.includes(task.id) || task.state !== "running" || !task.activeRunId) {
          return this.#reject("invalid_state", `Task ${taskId} is not running`);
        }
        const duplicateOpenQuestion = [...this.#state.questions.values()].some(
          (candidate) => candidate.taskId === task.id && candidate.state === "open",
        );
        if (duplicateOpenQuestion) {
          return this.#reject("question_pending", `Task ${taskId} already has an open question`);
        }
        const event = this.#event(
          "task.questionAsked",
          {
            questionId,
            runId: task.activeRunId,
            revision: task.revision,
            question,
          },
          questionId,
          task,
          task.activeRunId,
          "coder",
        );
        return this.#accept([event], task.id);
      },
    );
    for (const event of execution.events) applyEvent(this.#state, event);
    return execution.result;
  }

  recordCoderSession(
    signalId: string,
    taskId: string,
    runId: string,
    backend: "omp" | "codex" | "claude",
    sessionId: string,
    sessionFile: string | null,
  ): ActionResult {
    const execution = this.#store.executeCommand(
      {
        id: signalId,
        type: "internal.coder.sessionBound",
        actor: "coder",
        expectedRevision: null,
        payload: { taskId, runId, backend, sessionId, sessionFile },
        createdAt: this.#now(),
      },
      () => {
        const task = this.#state.tasks.get(taskId);
        if (!task) return this.#reject("task_not_found", `Task ${taskId} does not exist`);
        if (!this.#state.activeTaskIds.includes(task.id) || task.activeRunId !== runId) {
          return this.#reject("stale_run", `Run ${runId} is not active for task ${taskId}`);
        }
        const event = this.#event(
          "coder.sessionBound",
          { backend, sessionId, sessionFile, runId },
          signalId,
          task,
          runId,
          "coder",
        );
        return this.#accept([event], task.id);
      },
    );
    for (const event of execution.events) applyEvent(this.#state, event);
    return execution.result;
  }

  authorizeToolCall(signalId: string, taskId: string, toolName: string, input: unknown): ActionResult {
    const task = this.#state.tasks.get(taskId);
    if (!task) return { status: "rejected", code: "task_not_found", explanation: `Task ${taskId} does not exist` };
    const assessment = this.#assessTool(toolName, input, task.repositoryId);
    const policyEventPayload = {
      category: assessment.category,
      summary: assessment.summary,
      effectFingerprint: assessment.effectFingerprint,
      toolName: assessment.toolName,
    };
    const execution = this.#store.executeCommand(
      {
        id: signalId,
        type: "internal.policy.authorizeTool",
        actor: "coder",
        expectedRevision: task.revision,
        payload: assessment,
        createdAt: this.#now(),
      },
      () => {
        const current = this.#state.tasks.get(taskId);
        if (!current) return this.#reject("task_not_found", `Task ${taskId} does not exist`);
        if (!this.#state.activeTaskIds.includes(current.id) || current.state !== "running" || !current.activeRunId) {
          return this.#reject("invalid_state", `Task ${taskId} is not running`);
        }

        const approved = [...this.#state.confirmations.values()].find(
          (confirmation) =>
            confirmation.taskId === taskId &&
            confirmation.taskRevision === current.revision &&
            confirmation.effectFingerprint === assessment.effectFingerprint &&
            confirmation.state === "approved",
        );
        if (approved) {
          const policyEvent = this.#event(
            "policy.decisionRecorded",
            { ...policyEventPayload, decision: "automatic" },
            signalId,
            current,
            current.activeRunId,
            "policy",
          );
          const consumed = this.#event(
            "approval.consumed",
            {
              confirmationId: approved.id,
              revision: current.revision,
              effectFingerprint: assessment.effectFingerprint,
            },
            signalId,
            current,
            current.activeRunId,
            "policy",
          );
          return this.#accept([policyEvent, consumed], taskId);
        }

        if (assessment.tier === "automatic") {
          const event = this.#event(
            "policy.decisionRecorded",
            { ...policyEventPayload, decision: "automatic" },
            signalId,
            current,
            current.activeRunId,
            "policy",
          );
          return this.#accept([event], taskId);
        }
        if (assessment.tier === "reject") {
          const event = this.#event(
            "policy.decisionRecorded",
            { ...policyEventPayload, decision: "rejected" },
            signalId,
            current,
            current.activeRunId,
            "policy",
          );
          return {
            result: { status: "rejected", code: "policy_violation", explanation: assessment.summary },
            events: [event],
          };
        }

        const pending = [...this.#state.confirmations.values()].find(
          (confirmation) =>
            confirmation.taskId === taskId &&
            confirmation.taskRevision === current.revision &&
            confirmation.effectFingerprint === assessment.effectFingerprint &&
            confirmation.state === "pending",
        );
        if (pending) {
          return {
            result: {
              status: "confirmation_required",
              confirmationId: pending.id,
              summary: pending.summary,
            },
            events: [],
          };
        }

        const confirmationId = this.#createId();
        const policyEvent = this.#event(
          "policy.decisionRecorded",
          { ...policyEventPayload, decision: "confirmation_required" },
          signalId,
          current,
          current.activeRunId,
          "policy",
        );
        const requested = this.#event(
          "approval.requested",
          {
            confirmationId,
            revision: current.revision,
            category: assessment.category,
            summary: assessment.summary,
            effectFingerprint: assessment.effectFingerprint,
            toolName,
          },
          signalId,
          current,
          current.activeRunId,
          "policy",
        );
        const awaiting = this.#event(
          "task.awaitingUser",
          { runId: current.activeRunId, question: assessment.summary },
          signalId,
          current,
          current.activeRunId,
        );
        return {
          result: { status: "confirmation_required", confirmationId, summary: assessment.summary },
          events: [policyEvent, requested, awaiting],
        };
      },
    );
    for (const event of execution.events) applyEvent(this.#state, event);
    return execution.result;
  }

  recordArtifact(signalId: string, taskId: string, artifact: EvidenceArtifact): ActionResult {
    const execution = this.#store.executeCommand(
      {
        id: signalId,
        type: "internal.artifact.recorded",
        actor: "coder",
        expectedRevision: null,
        payload: { taskId, artifactId: artifact.id },
        createdAt: this.#now(),
      },
      () => {
        const task = this.#state.tasks.get(taskId);
        if (!task) return this.#reject("task_not_found", `Task ${taskId} does not exist`);
        if (!this.#state.activeTaskIds.includes(task.id) || task.activeRunId !== artifact.runId) {
          return this.#reject("stale_run", `Artifact ${artifact.id} does not belong to the active task run`);
        }
        const event = this.#event(
          "artifact.created",
          {
            artifactId: artifact.id,
            runId: artifact.runId,
            kind: artifact.kind,
            summary: artifact.summary,
            successful: artifact.successful,
          },
          signalId,
          task,
          artifact.runId,
        );
        return this.#accept([event], task.id);
      },
    );
    for (const event of execution.events) applyEvent(this.#state, event);
    return execution.result;
  }

  reportWorkspaceConflict(
    signalId: string,
    taskId: string,
    paths: string[],
    reason: string,
  ): ActionResult {
    const uniquePaths = [...new Set(paths.map((path) => path.trim()).filter(Boolean))].sort();
    if (uniquePaths.length === 0) {
      return { status: "rejected", code: "invalid_conflict", explanation: "A workspace conflict requires a path" };
    }
    const execution = this.#store.executeCommand(
      {
        id: signalId,
        type: "internal.workspace.conflict",
        actor: "coder",
        expectedRevision: null,
        payload: { taskId, paths: uniquePaths, reason },
        createdAt: this.#now(),
      },
      () => {
        const task = this.#state.tasks.get(taskId);
        if (!task) return this.#reject("task_not_found", `Task ${taskId} does not exist`);
        if (!this.#state.activeTaskIds.includes(task.id) || !task.activeRunId || task.state !== "running") {
          return this.#reject("stale_run", `Task ${taskId} has no running slot for a workspace conflict`);
        }
        const runId = task.activeRunId;
        const conflict = this.#event(
          "workspace.conflictDetected",
          { runId, paths: uniquePaths, reason },
          signalId,
          task,
          runId,
          "coder",
        );
        const question = `I paused before overwriting user changes in ${uniquePaths.join(", ")}. Review those changes, then resume to reconcile them.`;
        const awaiting = this.#event(
          "task.awaitingUser",
          { runId, question },
          signalId,
          task,
          runId,
        );
        return this.#accept([conflict, awaiting], task.id);
      },
    );
    for (const event of execution.events) applyEvent(this.#state, event);
    return execution.result;
  }

  completeTask(signalId: string, taskId: string, summary: string, evidenceIds: string[]): ActionResult {
    return this.#finishTask(signalId, taskId, "completed", summary, evidenceIds);
  }

  failTask(signalId: string, taskId: string, error: string): ActionResult {
    return this.#finishTask(signalId, taskId, "failed", error, []);
  }

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

  snapshot(): ControllerSnapshot {
    return snapshotState(this.#state);
  }

  eventsAfter(afterSeq = 0) {
    return this.#store.readAfter(afterSeq);
  }

  #decide(command: Command): CommandDecision {
    switch (command.type) {
      case "task.submit":
        return this.#submit(command);
      case "task.requestPause":
        return this.#requestPause(command);
      case "task.revise":
        return this.#revise(command);
      case "task.resume":
        return this.#resume(command);
      case "task.answerQuestion":
        return this.#answerQuestion(command);
      case "task.cancel":
        return this.#cancel(command);
      case "queue.move":
        return this.#moveQueue(command);
      case "approval.resolve":
        return this.#resolveApproval(command);
    }
  }

  #submit(command: Extract<Command, { type: "task.submit" }>): CommandDecision {
    const taskId = this.#createId();
    const spec = structuredClone(command.payload) as TaskSpec;
    const created = this.#event(
      "task.created",
      { spec, revision: 1 },
      command.id,
      { id: taskId, repositoryId: spec.repositoryId },
    );
    const queuePosition = spec.codingProfileId === "fast"
      ? this.#state.queue.length
      : this.#state.queue.findIndex((queuedTaskId) =>
        this.#requiredTask(queuedTaskId).spec.codingProfileId === "fast"
      );
    const enqueued = this.#event(
      "task.enqueued",
      { position: queuePosition < 0 ? this.#state.queue.length : queuePosition },
      command.id,
      { id: taskId, repositoryId: spec.repositoryId },
    );
    const events: NewDomainEvent[] = [created, enqueued];

    const canStartNow =
      this.#state.activeTaskIds.length < MAX_CONCURRENT_TASKS && !this.#isRepositoryActive(spec.repositoryId);
    if (canStartNow) {
      events.push(
        this.#event(
          "task.started",
          { runId: this.#createId(), revision: 1 },
          command.id,
          { id: taskId, repositoryId: spec.repositoryId },
        ),
      );
    }

    return this.#accept(events, taskId);
  }

  #requestPause(command: Extract<Command, { type: "task.requestPause" }>): CommandDecision {
    const task = this.#state.tasks.get(command.payload.taskId);
    if (!task) return this.#reject("task_not_found", `Task ${command.payload.taskId} does not exist`);
    const revisionConflict = this.#checkRevision(task, command.expectedRevision);
    if (revisionConflict) return revisionConflict;
    if (!this.#state.activeTaskIds.includes(task.id) || task.state !== "running") {
      return this.#reject("invalid_state", `Task ${task.id} is not the running task`);
    }

    const event = this.#event(
      "task.pauseRequested",
      { reason: command.payload.reason },
      command.id,
      task,
      task.activeRunId ?? undefined,
    );
    return this.#accept([event], task.id);
  }

  #revise(command: Extract<Command, { type: "task.revise" }>): CommandDecision {
    const task = this.#state.tasks.get(command.payload.taskId);
    if (!task) return this.#reject("task_not_found", `Task ${command.payload.taskId} does not exist`);
    const revisionConflict = this.#checkRevision(task, command.expectedRevision);
    if (revisionConflict) return revisionConflict;
    if (!(task.state === "paused" || task.state === "awaiting_user") || !this.#state.activeTaskIds.includes(task.id)) {
      return this.#reject("invalid_state", `Task ${task.id} must be paused or awaiting input before revision`);
    }
    if (command.payload.spec.repositoryId !== task.repositoryId) {
      return this.#reject("repository_immutable", "A task revision cannot retarget its repository");
    }

    const revision = task.revision + 1;
    const event = this.#event(
      "task.specRevised",
      {
        previousRevision: task.revision,
        revision,
        spec: structuredClone(command.payload.spec) as TaskSpec,
      },
      command.id,
      task,
    );
    return this.#accept([event], task.id);
  }

  #resume(command: Extract<Command, { type: "task.resume" }>): CommandDecision {
    const task = this.#state.tasks.get(command.payload.taskId);
    if (!task) return this.#reject("task_not_found", `Task ${command.payload.taskId} does not exist`);
    const revisionConflict = this.#checkRevision(task, command.expectedRevision);
    if (revisionConflict) return revisionConflict;
    if (!(task.state === "paused" || task.state === "awaiting_user") || !this.#state.activeTaskIds.includes(task.id)) {
      return this.#reject("invalid_state", `Task ${task.id} does not own a resumable active slot`);
    }

    const openQuestion = [...this.#state.questions.values()].find(
      (question) => question.taskId === task.id && question.state === "open",
    );
    if (openQuestion) {
      return this.#reject(
        "question_pending",
        `Question ${openQuestion.id} must be answered with task.answerQuestion`,
      );
    }
    const pendingApproval = [...this.#state.confirmations.values()].some(
      (confirmation) =>
        confirmation.taskId === task.id &&
        confirmation.taskRevision === task.revision &&
        confirmation.state === "pending",
    );
    if (pendingApproval) {
      return this.#reject("confirmation_pending", "Resolve the pending permission card before resuming this task");
    }

    const runId = this.#createId();
    const events: NewDomainEvent[] = [];
    if (task.workspaceConflict) {
      events.push(
        this.#event(
          "workspace.conflictResolved",
          { paths: task.workspaceConflict.paths, resolution: "accepted_external_changes" },
          command.id,
          task,
        ),
      );
    }
    events.push(
      this.#event(
        "task.resumed",
        { runId, revision: task.revision },
        command.id,
        task,
        runId,
      ),
    );
    return this.#accept(events, task.id);
  }

  #answerQuestion(command: Extract<Command, { type: "task.answerQuestion" }>): CommandDecision {
    const task = this.#state.tasks.get(command.payload.taskId);
    if (!task) return this.#reject("task_not_found", `Task ${command.payload.taskId} does not exist`);
    const revisionConflict = this.#checkRevision(task, command.expectedRevision);
    if (revisionConflict) return revisionConflict;
    const question = this.#state.questions.get(command.payload.questionId);
    if (!question || question.taskId !== task.id) {
      return this.#reject(
        "question_not_found",
        `Question ${command.payload.questionId} does not belong to task ${task.id}`,
      );
    }
    if (
      question.state !== "open" ||
      question.taskRevision !== task.revision ||
      task.state !== "awaiting_user" ||
      !this.#state.activeTaskIds.includes(task.id)
    ) {
      return this.#reject("stale_question", "This question is stale or was already answered");
    }

    const runId = this.#createId();
    const answered = this.#event(
      "task.questionAnswered",
      {
        questionId: question.id,
        runId: question.runId,
        revision: question.taskRevision,
        answer: command.payload.answer,
      },
      command.id,
      task,
      question.runId,
      command.actor === "user" ? "ui" : command.actor,
    );
    const resumed = this.#event(
      "task.resumed",
      { runId, revision: task.revision },
      command.id,
      task,
      runId,
    );
    return this.#accept([answered, resumed], task.id);
  }

  #cancel(command: Extract<Command, { type: "task.cancel" }>): CommandDecision {
    const task = this.#state.tasks.get(command.payload.taskId);
    if (!task) return this.#reject("task_not_found", `Task ${command.payload.taskId} does not exist`);
    const revisionConflict = this.#checkRevision(task, command.expectedRevision);
    if (revisionConflict) return revisionConflict;
    if (["completed", "failed", "cancelled"].includes(task.state)) {
      return this.#reject("terminal_task", `Task ${task.id} is already ${task.state}`);
    }

    const wasActive = this.#state.activeTaskIds.includes(task.id);
    const events: NewDomainEvent[] = [
      this.#event(
        "task.cancelled",
        { reason: command.payload.reason },
        command.id,
        task,
        task.activeRunId ?? undefined,
      ),
    ];
    if (wasActive) {
      const startNext = this.#startNextEvent(command.id, task.id);
      if (startNext) events.push(startNext);
    }
    return this.#accept(events, task.id);
  }

  #moveQueue(command: Extract<Command, { type: "queue.move" }>): CommandDecision {
    const { taskId, operation, anchorTaskId } = command.payload;
    const task = this.#state.tasks.get(taskId);
    if (!task || task.state !== "queued" || !this.#state.queue.includes(taskId)) {
      return this.#reject("not_queued", `Task ${taskId} is not queued`);
    }

    const queue = this.#state.queue.filter((id) => id !== taskId);
    if (operation === "move_first") {
      if (anchorTaskId !== null) return this.#reject("invalid_anchor", "move_first does not accept an anchor");
      queue.unshift(taskId);
    } else if (operation === "move_last") {
      if (anchorTaskId !== null) return this.#reject("invalid_anchor", "move_last does not accept an anchor");
      queue.push(taskId);
    } else {
      if (!anchorTaskId || anchorTaskId === taskId) {
        return this.#reject("invalid_anchor", `${operation} requires a different queued anchor`);
      }
      const anchorIndex = queue.indexOf(anchorTaskId);
      if (anchorIndex === -1) return this.#reject("invalid_anchor", `Anchor task ${anchorTaskId} is not queued`);
      queue.splice(operation === "move_before" ? anchorIndex : anchorIndex + 1, 0, taskId);
    }

    const event = this.#event("queue.reordered", { taskIds: queue }, command.id, task);
    return this.#accept([event], task.id);
  }

  #resolveApproval(command: Extract<Command, { type: "approval.resolve" }>): CommandDecision {
    const confirmation = this.#state.confirmations.get(command.payload.confirmationId);
    if (!confirmation) {
      return this.#reject("confirmation_not_found", `Confirmation ${command.payload.confirmationId} does not exist`);
    }
    const task = this.#state.tasks.get(confirmation.taskId);
    if (!task) return this.#reject("task_not_found", `Task ${confirmation.taskId} does not exist`);
    const revisionConflict = this.#checkRevision(task, command.expectedRevision);
    if (revisionConflict) return revisionConflict;
    if (confirmation.taskRevision !== task.revision || confirmation.state !== "pending") {
      return this.#reject("stale_confirmation", "This confirmation is stale or was already resolved");
    }
    if (task.state !== "awaiting_user" || !this.#state.activeTaskIds.includes(task.id)) {
      return this.#reject("invalid_state", `Task ${task.id} is not awaiting this approval`);
    }

    const resolved = this.#event(
      "approval.resolved",
      { confirmationId: confirmation.id, revision: task.revision, decision: command.payload.decision },
      command.id,
      task,
      undefined,
      "policy",
    );
    if (command.payload.decision === "approve") {
      const runId = this.#createId();
      const resumed = this.#event(
        "task.resumed",
        { runId, revision: task.revision },
        command.id,
        task,
        runId,
      );
      return this.#accept([resolved, resumed], task.id);
    }

    const lastRunId = task.runIds.at(-1);
    if (!lastRunId) return this.#reject("invalid_state", `Task ${task.id} has no run to pause`);
    const paused = this.#event(
      "task.paused",
      { runId: lastRunId, reason: "User rejected the requested effect" },
      command.id,
      task,
      lastRunId,
    );
    return this.#accept([resolved, paused], task.id);
  }

  #finishTask(
    signalId: string,
    taskId: string,
    outcome: "completed" | "failed",
    detail: string,
    evidenceIds: string[],
  ): ActionResult {
    const execution = this.#store.executeCommand(
      {
        id: signalId,
        type: `internal.task.${outcome}`,
        actor: "coder",
        expectedRevision: null,
        payload: { taskId, detail, evidenceIds },
        createdAt: this.#now(),
      },
      () => {
        const task = this.#state.tasks.get(taskId);
        if (!task) return this.#reject("task_not_found", `Task ${taskId} does not exist`);
        if (!this.#state.activeTaskIds.includes(task.id) || !task.activeRunId) {
          return this.#reject("invalid_state", `Task ${task.id} has no active run`);
        }
        if (!(task.state === "running" || task.state === "pause_requested")) {
          return this.#reject("invalid_state", `Task ${task.id} cannot finish from ${task.state}`);
        }

        const runId = task.activeRunId;
        const finished =
          outcome === "completed"
            ? this.#event(
                "task.completed",
                { runId, summary: detail, evidenceIds },
                signalId,
                task,
                runId,
              )
            : this.#event("task.failed", { runId, error: detail }, signalId, task, runId);
        if (outcome === "completed") {
          const validation = this.#validateEvidence(task.id, runId, evidenceIds);
          if (!validation.valid) return this.#reject("verification_incomplete", validation.explanation);
        }
        const events: NewDomainEvent[] = [finished];
        const startNext = this.#startNextEvent(signalId, task.id);
        if (startNext) events.push(startNext);
        return this.#accept(events, task.id);
      },
    );

    for (const event of execution.events) applyEvent(this.#state, event);
    return execution.result;
  }

  /**
   * `excludingTaskId` is the task whose termination/cancellation triggered this
   * call: it still occupies `activeTaskIds` at this point (that event hasn't been
   * applied yet — events are only applied after this whole command decision
   * returns), so it must be discounted or it would appear to block its own
   * repository from immediately handing off to the next queued task.
   */
  #startNextEvent(correlationId: string, excludingTaskId?: string): NewDomainEvent<"task.started"> | null {
    const nextTaskId = this.#state.queue[0];
    if (!nextTaskId) return null;
    const otherActiveTaskIds = this.#state.activeTaskIds.filter((id) => id !== excludingTaskId);
    if (otherActiveTaskIds.length >= MAX_CONCURRENT_TASKS) return null;
    const nextTask = this.#requiredTask(nextTaskId);
    const repositoryBusy = otherActiveTaskIds.some(
      (id) => this.#requiredTask(id).repositoryId === nextTask.repositoryId,
    );
    if (repositoryBusy) return null;
    const runId = this.#createId();
    return this.#event(
      "task.started",
      { runId, revision: nextTask.revision },
      correlationId,
      nextTask,
      runId,
    );
  }

  #requiredTask(taskId: string): TaskRecord {
    const task = this.#state.tasks.get(taskId);
    if (!task) throw new Error(`Task ${taskId} does not exist`);
    return task;
  }

  #isRepositoryActive(repositoryId: string): boolean {
    return this.#state.activeTaskIds.some(
      (taskId) => this.#requiredTask(taskId).repositoryId === repositoryId,
    );
  }

  #checkRevision(task: TaskRecord, expectedRevision: number): CommandDecision | null {
    if (task.revision === expectedRevision) return null;
    return {
      result: {
        status: "conflict",
        currentRevision: task.revision,
        explanation: `Task ${task.id} is at revision ${task.revision}, not ${expectedRevision}`,
      },
      events: [],
    };
  }

  #event<T extends EventType>(
    type: T,
    payload: EventPayload<T>,
    correlationId: string,
    task: Pick<TaskRecord, "id" | "repositoryId">,
    runId?: string,
    actor: EventActor = "controller",
  ): NewDomainEvent<T> {
    return {
      version: 1,
      id: this.#createId(),
      at: this.#now(),
      type,
      actor,
      projectId: task.repositoryId,
      taskId: task.id,
      ...(runId ? { runId } : {}),
      correlationId,
      causedBy: correlationId,
      payload,
    } as NewDomainEvent<T>;
  }

  #accept(events: NewDomainEvent[], taskId?: string): CommandDecision {
    const event = events.at(-1);
    if (!event) throw new Error("Accepted decisions require at least one event");
    return {
      result: {
        status: "accepted",
        eventId: event.id,
        ...(taskId ? { taskId } : {}),
      },
      events,
    };
  }

  #reject(code: string, explanation: string): CommandDecision {
    return {
      result: { status: "rejected", code, explanation },
      events: [],
    };
  }
}
