import type { ActionResult, DomainEvent } from "@mamachi/protocol";
import {
  ExternalCliRunner,
  type ExternalCliRunnerOptions,
} from "./external-cli-runner.ts";
import {
  defaultRuntimeSettings,
  type CodingBackend,
  type RuntimeSettings,
} from "./model-router.ts";
import { OmpRunner, type OmpRunnerOptions } from "./omp-runner.ts";
import type { EditorDocumentState } from "./workspace-guard.ts";

interface CodingBackendRunner {
  configure(settings: RuntimeSettings): void;
  updateEditorState(state: EditorDocumentState): void;
  askCoder(taskId: string, question: string): Promise<boolean>;
  steer(taskId: string, clarification: string): Promise<boolean>;
  followUp(taskId: string, addition: string): Promise<boolean>;
  handleEvents(events: readonly DomainEvent[]): void;
  dispose(): Promise<void>;
}

export interface CodingRunnerOptions
  extends Omit<OmpRunnerOptions, "onSessionBound" | "runtimeSettings" | "workspaceGuard"> {
  onSessionBound?: (
    taskId: string,
    runId: string,
    backend: CodingBackend,
    sessionId: string,
    sessionFile: string | null,
  ) => Promise<ActionResult>;
  runtimeSettings?: RuntimeSettings;
  codexExecutable?: string;
  claudeExecutable?: string;
}

const TERMINAL_EVENT_TYPES = new Set(["task.completed", "task.failed", "task.cancelled"]);

export class CodingRunner {
  readonly #options: CodingRunnerOptions;
  readonly #runners = new Map<string, CodingBackendRunner>();
  #runtimeSettings: RuntimeSettings;

  constructor(options: CodingRunnerOptions) {
    this.#options = options;
    this.#runtimeSettings = options.runtimeSettings ?? defaultRuntimeSettings;
  }

  /** Number of tasks that currently have a live backend-runner instance. */
  get activeTaskCount(): number {
    return this.#runners.size;
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
      if (TERMINAL_EVENT_TYPES.has(event.type)) {
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
