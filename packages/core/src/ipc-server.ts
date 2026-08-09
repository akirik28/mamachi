import { timingSafeEqual } from "node:crypto";
import { copyFileSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { parseCommand, type ActionResult, type DomainEvent } from "@mamachi/protocol";
import { TaskController } from "./controller.ts";
import { EventStore } from "./event-store.ts";
import {
  ArtifactStore,
  type CapturedContext,
  type ContextKind,
  type EvidenceArtifact,
  type ToolEvidenceInput,
  type ObserverInterpretation,
  type ObserverInterpretationInput,
} from "./artifact-store.ts";
import { parseRuntimeSettings, type RuntimeSettings } from "./model-router.ts";
import { FactProjector, type FactSnapshot, type TaskFacts } from "./fact-projector.ts";
import type { EditorDocumentState, WorkspaceConflict } from "./workspace-guard.ts";
import type { RealtimePlaybackCursor } from "./realtime-bridge.ts";
import {
  EditorContextRequestBroker,
  editorContextKinds,
  type EditorContextCapture,
  type EditorContextError,
} from "./editor-context-request.ts";
import { MemoryStore, type MemoryFact, type MemoryScope } from "./memory-store.ts";
import type { SensitiveFieldKey } from "./sensitive-field-codec.ts";

interface ClientData {
  id: string;
}

type ClientSocket = ServerWebSocket<ClientData>;

interface RequestEnvelope {
  version: 1;
  id: string;
  type:
    | "state.get"
    | "workspace.select"
    | "workspace.focus"
    | "editor.state"
    | "context.capture"
    | "context.remove"
    | "command.execute"
    | "settings.update"
    | "voice.connect"
    | "voice.disconnect"
    | "voice.engagement"
    | "voice.interrupt"
    | "voice.text"
    | "voice.mode"
    | "editor.context.response";
  payload: unknown;
}

export interface DaemonHooks {
  onAudioInput?: (pcm: Uint8Array) => void;
  onTaskEvents?: (events: DomainEvent[]) => void | Promise<void>;
  onContextCaptured?: (context: CapturedContext) => void;
  onContextRemoved?: (id: string) => void;
  onEditorState?: (state: EditorDocumentState) => void;
  onSettingsUpdate?: (settings: RuntimeSettings) => void;
  onVoiceConnect?: (keys: { apiKey?: string; elevenLabsApiKey?: string }) => void | Promise<void>;
  onVoiceDisconnect?: () => void | Promise<void>;
  onVoiceEngagement?: (engaged: boolean, playback: RealtimePlaybackCursor | null) => void;
  onVoiceInterrupt?: (playback: RealtimePlaybackCursor | null) => void;
  onVoiceText?: (text: string) => void | Promise<void>;
  onVoiceMode?: (mode: "voice" | "text") => void;
}

export interface IpcServerOptions {
  token: string;
  port?: number;
  hostname?: string;
  databasePath?: string;
  initialWorkspace?: string;
  encryptionKey?: SensitiveFieldKey;
  editorContextTimeoutMs?: number;
  hooks?: DaemonHooks;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}


function parsePlaybackCursor(value: unknown): RealtimePlaybackCursor | null {
  if (value === null) return null;
  if (
    !isObject(value) ||
    !hasOnlyKeys(value, ["itemId", "contentIndex", "audioEndMs"]) ||
    typeof value["itemId"] !== "string" ||
    value["itemId"].length === 0 ||
    !Number.isInteger(value["contentIndex"]) ||
    (value["contentIndex"] as number) < 0 ||
    !Number.isInteger(value["audioEndMs"]) ||
    (value["audioEndMs"] as number) < 0
  ) {
    throw new Error("Playback cursor is invalid");
  }
  return {
    itemId: value["itemId"],
    contentIndex: value["contentIndex"] as number,
    audioEndMs: value["audioEndMs"] as number,
  };
}
function parseRequest(input: unknown): RequestEnvelope {
  if (!isObject(input) || !hasOnlyKeys(input, ["version", "id", "type", "payload"])) {
    throw new Error("Invalid IPC request envelope");
  }
  if (input["version"] !== 1 || typeof input["id"] !== "string" || typeof input["type"] !== "string") {
    throw new Error("Invalid IPC request fields");
  }
  const supported = new Set([
    "state.get",
    "workspace.select",
    "workspace.focus",
    "editor.state",
    "context.capture",
    "context.remove",
    "command.execute",
    "settings.update",
    "voice.connect",
    "voice.disconnect",
    "voice.engagement",
    "voice.interrupt",
    "voice.text",
    "voice.mode",
    "editor.context.response",
  ]);
  if (!supported.has(input["type"])) throw new Error(`Unsupported IPC request type: ${input["type"]}`);
  return input as unknown as RequestEnvelope;
}

function isAuthorized(request: Request, token: string): boolean {
  const actual = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${token}`;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export class MamachiIpcServer {
  readonly #token: string;
  readonly #controller: TaskController;
  readonly #store: EventStore;
  readonly #artifacts: ArtifactStore;
  readonly #facts: FactProjector;
  readonly #memories: MemoryStore;
  readonly #editorRequests: EditorContextRequestBroker;
  readonly #hooks: DaemonHooks;
  readonly #clients = new Set<ClientSocket>();
  readonly #server: Server<ClientData>;
  #workspace: string;
  readonly #workspaces = new Set<string>();
  readonly #screenshotDirectory: string | null;

  constructor(options: IpcServerOptions) {
    this.#token = options.token;
    this.#hooks = options.hooks ?? {};
    this.#workspace = realpathSync(options.initialWorkspace ?? process.cwd());
    this.#workspaces.add(this.#workspace);
    const databasePath = options.databasePath ?? ":memory:";
    this.#screenshotDirectory = databasePath === ":memory:"
      ? null
      : join(dirname(resolve(databasePath)), "screenshots");
    this.#store = new EventStore(databasePath, { encryptionKey: options.encryptionKey ?? null });
    this.#artifacts = new ArtifactStore(databasePath, { encryptionKey: options.encryptionKey ?? null });
    this.#facts = new FactProjector(this.#artifacts);
    this.#memories = new MemoryStore(databasePath, options.encryptionKey ?? null);
    this.#editorRequests = new EditorContextRequestBroker(options.editorContextTimeoutMs);
    this.#controller = new TaskController(this.#store, {
      validateEvidence: (taskId, runId, evidenceIds) =>
        this.#artifacts.validateCompletion(taskId, runId, evidenceIds),
    });

    this.#server = Bun.serve<ClientData>({
      hostname: options.hostname ?? "127.0.0.1",
      port: options.port ?? 0,
      fetch: (request, server) => this.#handleUpgrade(request, server),
      websocket: {
        open: (socket) => {
          this.#clients.add(socket);
          this.#send(socket, "server.ready", {
            clientId: socket.data.id,
            workspace: this.#workspace,
            snapshot: this.#controller.snapshot(),
            facts: this.#facts.project(this.#controller.snapshot()),
          });
        },
        message: (socket, message) => {
          if (typeof message !== "string") {
            const pcm = message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message);
            this.#hooks.onAudioInput?.(pcm);
            return;
          }
          void this.#handleMessage(socket, message);
        },
        close: (socket) => {
          this.#clients.delete(socket);
        },
      },
    });
  }

  get port(): number {
    if (this.#server.port === undefined) throw new Error("IPC server has no bound port");
    return this.#server.port;
  }

  get workspace(): string {
    return this.#workspace;
  }

  /** Every repository registered for task submission, canonical realpaths. */
  get workspaces(): string[] {
    return [...this.#workspaces];
  }

  emit(type: string, payload: unknown): void {
    const message = JSON.stringify({ version: 1, type, payload });
    for (const client of this.#clients) client.send(message);
  }

  emitAudio(pcm: Uint8Array): void {
    for (const client of this.#clients) client.send(pcm, true);
  }
  snapshot() {
    return this.#controller.snapshot();
  }
  factSnapshot(): FactSnapshot {
    return this.#facts.project(this.#controller.snapshot());
  }

  taskFacts(taskId: string): TaskFacts | undefined {
    return this.factSnapshot().tasks.find((facts) => facts.taskId === taskId);
  }

  recordObserverInterpretation(input: ObserverInterpretationInput): ObserverInterpretation {
    return this.#artifacts.recordObserverInterpretation(input);
  }

  getArtifacts(ids: readonly string[]): CapturedContext[] {
    return this.#artifacts.get(ids);
  }

  /// Registers a screen capture as an attachable context artifact. Voice
  /// engines call this so a screenshot gets a real attachment ID that
  /// `task.submit` accepts; the file is copied out of /tmp into the state
  /// directory so it survives until the coding agent reads it.
  captureScreenshotContext(sourcePath: string, summary: string): CapturedContext {
    if (!this.#screenshotDirectory) {
      throw new Error("Screenshot attachments require a persistent state directory");
    }
    if (!isAbsolute(sourcePath)) throw new Error("Screenshot path must be absolute");
    const extension = extname(sourcePath).toLowerCase();
    if (extension !== ".png" && extension !== ".jpg" && extension !== ".jpeg") {
      throw new Error("Screenshot attachments support PNG and JPEG only");
    }
    const size = statSync(sourcePath).size;
    if (size <= 0) throw new Error("The captured screenshot is empty");
    mkdirSync(this.#screenshotDirectory, { recursive: true, mode: 0o700 });
    const stablePath = join(this.#screenshotDirectory, `${Bun.randomUUIDv7()}${extension}`);
    copyFileSync(sourcePath, stablePath);
    const artifact = this.#artifacts.capture("screenshot", this.#workspace, summary, {
      path: stablePath,
      mimeType: extension === ".png" ? "image/png" : "image/jpeg",
      byteLength: size,
      note: "Open this image file to view the captured screen.",
    });
    this.emit("context.captured", {
      id: artifact.id,
      kind: artifact.kind,
      workspace: artifact.workspace,
      summary: artifact.summary,
    });
    this.#hooks.onContextCaptured?.(artifact);
    return artifact;
  }

  getTaskArtifact(taskId: string, artifactId: string): EvidenceArtifact | null {
    const artifact = this.#artifacts.getEvidence([artifactId])[0];
    return artifact?.taskId === taskId ? artifact : null;
  }

  rememberFact(scope: MemoryScope, projectId: string | null, fact: string): MemoryFact {
    return this.#memories.remember(scope, projectId, fact);
  }

  forgetFact(memoryId: string): boolean {
    return this.#memories.forget(memoryId, this.#workspace);
  }

  async captureEditorContext(kinds: readonly ContextKind[]): Promise<{
    artifacts: Array<{ id: string; kind: ContextKind; summary: string }>;
    errors: EditorContextError[];
  }> {
    const clients = [...this.#clients];
    const response = await this.#editorRequests.request(
      kinds,
      clients.map((client) => client.data.id),
      (clientId, requestId, requestedKinds) => {
        const client = clients.find((candidate) => candidate.data.id === clientId);
        if (client) {
          this.#send(client, "editor.context.request", {
            requestId,
            kinds: requestedKinds,
            workspace: this.#workspace,
          });
        }
      },
    );
    const artifacts = response.captures.map((capture) =>
      this.#captureContextPayload({
        kind: capture.kind,
        workspace: this.#workspace,
        ...capture.payload,
      }),
    );
    return { artifacts, errors: response.errors };
  }

  async executeCommand(input: unknown): Promise<ActionResult> {
    const command = parseCommand(input);
    if (command.type === "task.submit") {
      let canonicalRepositoryId: string;
      try {
        canonicalRepositoryId = realpathSync(command.payload.repositoryId);
      } catch {
        return {
          status: "rejected",
          code: "workspace_mismatch",
          explanation: "The task repository does not exist or is not accessible",
        };
      }
      if (!this.#workspaces.has(canonicalRepositoryId)) {
        return {
          status: "rejected",
          code: "workspace_mismatch",
          explanation: "The task repository is not a registered workspace",
        };
      }
      // Canonicalize before it reaches the controller: two aliases (a
      // symlink vs. its real path) for the same repository must be treated
      // as the same repositoryId everywhere, or the one-active-task-per-
      // repository mutex in domain.ts could be defeated by submitting
      // through a different alias string.
      const submitCommand = { ...command, payload: { ...command.payload, repositoryId: canonicalRepositoryId } };
      const attachments = this.#artifacts.get(submitCommand.payload.attachmentIds);
      if (
        attachments.length !== submitCommand.payload.attachmentIds.length ||
        attachments.some((artifact) => artifact.workspace !== submitCommand.payload.repositoryId)
      ) {
        return {
          status: "rejected",
          code: "attachment_mismatch",
          explanation: "Every task attachment must exist and belong to the selected workspace",
        };
      }
      const beforeSeq = this.#controller.snapshot().seq;
      const result = this.#controller.handle(submitCommand);
      await this.#publishControllerEvents(beforeSeq);
      return result;
    }
    const beforeSeq = this.#controller.snapshot().seq;
    const result = this.#controller.handle(command);
    await this.#publishControllerEvents(beforeSeq);
    return result;
  }


  async pauseAtSafeBoundary(taskId: string, reason?: string): Promise<ActionResult> {
    const beforeSeq = this.#controller.snapshot().seq;
    const result = this.#controller.pauseAtSafeBoundary(Bun.randomUUIDv7(), taskId, reason);
    await this.#publishControllerEvents(beforeSeq);
    return result;
  }

  async authorizeToolCall(taskId: string, toolName: string, input: unknown): Promise<ActionResult> {
    const beforeSeq = this.#controller.snapshot().seq;
    const result = this.#controller.authorizeToolCall(Bun.randomUUIDv7(), taskId, toolName, input);
    await this.#publishControllerEvents(beforeSeq);
    return result;
  }

  async awaitUserInput(taskId: string, question: string): Promise<ActionResult> {
    const beforeSeq = this.#controller.snapshot().seq;
    const result = this.#controller.awaitUserInput(Bun.randomUUIDv7(), taskId, question);
    await this.#publishControllerEvents(beforeSeq);
    return result;
  }

  async recordCoderSession(
    taskId: string,
    runId: string,
    backend: "omp" | "codex" | "claude",
    sessionId: string,
    sessionFile: string | null,
  ): Promise<ActionResult> {
    const beforeSeq = this.#controller.snapshot().seq;
    const result = this.#controller.recordCoderSession(
      Bun.randomUUIDv7(),
      taskId,
      runId,
      backend,
      sessionId,
      sessionFile,
    );
    await this.#publishControllerEvents(beforeSeq);
    return result;
  }

  async reportWorkspaceConflict(taskId: string, conflict: WorkspaceConflict): Promise<ActionResult> {
    const beforeSeq = this.#controller.snapshot().seq;
    const result = this.#controller.reportWorkspaceConflict(
      Bun.randomUUIDv7(),
      taskId,
      conflict.paths,
      conflict.reason,
    );
    await this.#publishControllerEvents(beforeSeq);
    return result;
  }

  async recordToolEvidence(input: ToolEvidenceInput): Promise<EvidenceArtifact> {
    const artifact = this.#artifacts.recordToolEvidence(input);
    const beforeSeq = this.#controller.snapshot().seq;
    const recorded = this.#controller.recordArtifact(artifact.id, input.taskId, artifact);
    await this.#publishControllerEvents(beforeSeq);
    if (recorded.status !== "accepted") {
      throw new Error(
        recorded.status === "rejected" ? recorded.explanation : "Artifact recording requires unexpected confirmation",
      );
    }
    return artifact;
  }

  async completeTask(taskId: string, summary: string, evidenceIds: string[] = []): Promise<ActionResult> {
    const beforeSeq = this.#controller.snapshot().seq;
    const result = this.#controller.completeTask(Bun.randomUUIDv7(), taskId, summary, evidenceIds);
    await this.#publishControllerEvents(beforeSeq);
    return result;
  }

  async failTask(taskId: string, error: string): Promise<ActionResult> {
    const beforeSeq = this.#controller.snapshot().seq;
    const result = this.#controller.failTask(Bun.randomUUIDv7(), taskId, error);
    await this.#publishControllerEvents(beforeSeq);
    return result;
  }
  async recoverAfterRestart(): Promise<ActionResult> {
    const beforeSeq = this.#controller.snapshot().seq;
    const result = this.#controller.recoverAfterRestart(Bun.randomUUIDv7());
    await this.#publishControllerEvents(beforeSeq);
    return result;
  }


  close(): void {
    this.#editorRequests.cancelAll();
    for (const client of this.#clients) client.close(1001, "Mamachi daemon stopped");
    this.#clients.clear();
    this.#server.stop(true);
    this.#store.close();
    this.#artifacts.close();
    this.#memories.close();
  }

  #handleUpgrade(request: Request, server: Server<ClientData>): Response | undefined {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok", version: 1 });
    }
    if (url.pathname !== "/ws") return new Response("Not found", { status: 404 });
    if (!isAuthorized(request, this.#token)) return new Response("Unauthorized", { status: 401 });

    const upgraded = server.upgrade(request, {
      data: { id: Bun.randomUUIDv7() },
    });
    return upgraded ? undefined : new Response("Upgrade failed", { status: 400 });
  }

  async #handleMessage(socket: ClientSocket, text: string): Promise<void> {
    let requestId: string | undefined;
    try {
      const request = parseRequest(JSON.parse(text));
      requestId = request.id;
      const result = await this.#dispatch(socket, request);
      this.#send(socket, "response", { requestId, ok: true, result });
    } catch (error) {
      this.#send(socket, "response", {
        requestId: requestId ?? null,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #dispatch(socket: ClientSocket, request: RequestEnvelope): Promise<unknown> {
    switch (request.type) {
      case "state.get": {
        if (!isObject(request.payload) || !hasOnlyKeys(request.payload, ["afterSeq"])) {
          throw new Error("state.get payload is invalid");
        }
        const afterSeq = request.payload["afterSeq"];
        if (afterSeq !== undefined && afterSeq !== null && (!Number.isInteger(afterSeq) || (afterSeq as number) < 0)) {
          throw new Error("state.get afterSeq must be a non-negative integer or null");
        }
        const snapshot = this.#controller.snapshot();
        const reset = typeof afterSeq === "number" && afterSeq > snapshot.seq;
        const events = typeof afterSeq === "number" && !reset
          ? this.#controller.eventsAfter(afterSeq).filter((event) => event.seq <= snapshot.seq)
          : [];
        return {
          workspace: this.#workspace,
          snapshot,
          facts: this.#facts.project(snapshot),
          events,
          reset,
        };
      }
      case "workspace.select":
      case "workspace.focus": {
        if (
          !isObject(request.payload) ||
          !hasOnlyKeys(request.payload, ["path"]) ||
          typeof request.payload["path"] !== "string"
        ) {
          throw new Error(`${request.type} requires one path string`);
        }
        const path = realpathSync(request.payload["path"]);
        if (!statSync(path).isDirectory()) throw new Error("Selected workspace is not a directory");
        this.#workspace = path;
        this.#workspaces.add(path);
        this.emit("workspace.changed", {
          path,
          workspaces: [...this.#workspaces],
          source: request.type === "workspace.focus" ? "vscode" : "user",
        });
        return { path, workspaces: [...this.#workspaces] };
      }
      case "editor.state": {
        if (
          !isObject(request.payload) ||
          !hasOnlyKeys(request.payload, ["workspace", "path", "version", "dirty", "open"]) ||
          typeof request.payload["workspace"] !== "string" ||
          typeof request.payload["path"] !== "string" ||
          !Number.isInteger(request.payload["version"]) ||
          typeof request.payload["dirty"] !== "boolean" ||
          typeof request.payload["open"] !== "boolean"
        ) {
          throw new Error("editor.state payload is invalid");
        }
        const requestedWorkspace = resolve(request.payload["workspace"]);
        const workspace = realpathSync(requestedWorkspace);
        if (workspace !== this.#workspace) throw new Error("Editor state does not belong to the selected workspace");
        const requestedPath = resolve(requestedWorkspace, request.payload["path"]);
        const relation = relative(requestedWorkspace, requestedPath);
        if (relation === "" || relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
          throw new Error("Editor state path is outside the selected workspace");
        }
        const state: EditorDocumentState = {
          workspace,
          path: resolve(workspace, relation),
          version: request.payload["version"] as number,
          dirty: request.payload["dirty"],
          open: request.payload["open"],
        };
        this.#hooks.onEditorState?.(state);
        return { accepted: true };
      }
      case "context.capture":
        return this.#captureContextPayload(request.payload);
      case "context.remove": {
        if (
          !isObject(request.payload) ||
          !hasOnlyKeys(request.payload, ["id"]) ||
          typeof request.payload["id"] !== "string" ||
          request.payload["id"].length === 0
        ) {
          throw new Error("context.remove requires one id string");
        }
        const id = request.payload["id"];
        this.#hooks.onContextRemoved?.(id);
        this.emit("context.removed", { ids: [id] });
        return { removed: true };
      }
      case "command.execute": {
        if (!isObject(request.payload) || !hasOnlyKeys(request.payload, ["command"])) {
          throw new Error("command.execute requires one command");
        }
        return this.executeCommand(request.payload["command"]);
      }
      case "settings.update": {
        const settings = parseRuntimeSettings(request.payload);
        this.#hooks.onSettingsUpdate?.(settings);
        this.emit("settings.updated", settings);
        return settings;
      }
      case "voice.connect": {
        if (!isObject(request.payload) || !hasOnlyKeys(request.payload, ["apiKey", "elevenLabsApiKey"])) {
          throw new Error("voice.connect payload is invalid");
        }
        const apiKey = request.payload["apiKey"];
        if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey.length === 0)) {
          throw new Error("voice.connect apiKey must be a non-empty string");
        }
        const elevenLabsApiKey = request.payload["elevenLabsApiKey"];
        if (
          elevenLabsApiKey !== undefined &&
          (typeof elevenLabsApiKey !== "string" || elevenLabsApiKey.length === 0)
        ) {
          throw new Error("voice.connect elevenLabsApiKey must be a non-empty string");
        }
        await this.#hooks.onVoiceConnect?.({
          ...(typeof apiKey === "string" ? { apiKey } : {}),
          ...(typeof elevenLabsApiKey === "string" ? { elevenLabsApiKey } : {}),
        });
        return { connected: true };
      }
      case "voice.mode": {
        if (
          !isObject(request.payload) ||
          !hasOnlyKeys(request.payload, ["mode"]) ||
          !(request.payload["mode"] === "voice" || request.payload["mode"] === "text")
        ) {
          throw new Error("voice.mode requires mode voice or text");
        }
        this.#hooks.onVoiceMode?.(request.payload["mode"]);
        return { mode: request.payload["mode"] };
      }
      case "voice.disconnect":
        this.#assertEmptyPayload(request.payload);
        await this.#hooks.onVoiceDisconnect?.();
        return { connected: false };
      case "voice.engagement": {
        if (
          !isObject(request.payload) ||
          !hasOnlyKeys(request.payload, ["engaged", "playback"]) ||
          typeof request.payload["engaged"] !== "boolean"
        ) {
          throw new Error("voice.engagement payload is invalid");
        }
        const playback = parsePlaybackCursor(request.payload["playback"] ?? null);
        this.#hooks.onVoiceEngagement?.(request.payload["engaged"], playback);
        return { engaged: request.payload["engaged"] };
      }
      case "voice.interrupt": {
        if (!isObject(request.payload) || !hasOnlyKeys(request.payload, ["playback"])) {
          throw new Error("voice.interrupt payload is invalid");
        }
        const playback = parsePlaybackCursor(request.payload["playback"] ?? null);
        this.#hooks.onVoiceInterrupt?.(playback);
        return { interrupted: true };
      }
      case "voice.text": {
        if (
          !isObject(request.payload) ||
          !hasOnlyKeys(request.payload, ["text"]) ||
          typeof request.payload["text"] !== "string"
        ) {
          throw new Error("voice.text requires one text string");
        }
        await this.#hooks.onVoiceText?.(request.payload["text"]);
        return { accepted: true };
      }
      case "editor.context.response": {
        if (
          !isObject(request.payload) ||
          !hasOnlyKeys(request.payload, ["requestId", "captures", "errors"]) ||
          typeof request.payload["requestId"] !== "string" ||
          !Array.isArray(request.payload["captures"]) ||
          !Array.isArray(request.payload["errors"]) ||
          request.payload["captures"].length > editorContextKinds.length ||
          request.payload["errors"].length > editorContextKinds.length
        ) {
          throw new Error("editor.context.response payload is invalid");
        }
        const captures: EditorContextCapture[] = request.payload["captures"].map((candidate) => {
          if (
            !isObject(candidate) ||
            !hasOnlyKeys(candidate, ["kind", "payload"]) ||
            !editorContextKinds.includes(candidate["kind"] as ContextKind) ||
            !isObject(candidate["payload"])
          ) {
            throw new Error("editor.context.response capture is invalid");
          }
          return { kind: candidate["kind"] as ContextKind, payload: candidate["payload"] };
        });
        const errors: EditorContextError[] = request.payload["errors"].map((candidate) => {
          if (
            !isObject(candidate) ||
            !hasOnlyKeys(candidate, ["kind", "error"]) ||
            !editorContextKinds.includes(candidate["kind"] as ContextKind) ||
            typeof candidate["error"] !== "string" ||
            candidate["error"].trim().length === 0
          ) {
            throw new Error("editor.context.response error is invalid");
          }
          return { kind: candidate["kind"] as ContextKind, error: candidate["error"].trim() };
        });
        if (!this.#editorRequests.respond(socket.data.id, request.payload["requestId"], { captures, errors })) {
          throw new Error("Editor context response is stale or does not match the request");
        }
        return { accepted: true };
      }
    }
  }

  #captureContextPayload(payload: unknown): { id: string; kind: ContextKind; summary: string } {
    const allowedKeys = [
      "kind",
      "workspace",
      "path",
      "language",
      "content",
      "selection",
      "range",
      "diagnostics",
      "terminalExcerpt",
    ];
    if (!isObject(payload) || !hasOnlyKeys(payload, allowedKeys)) {
      throw new Error("context.capture payload is invalid");
    }
    const kind = payload["kind"];
    const workspace = payload["workspace"];
    if (typeof kind !== "string" || !editorContextKinds.includes(kind as ContextKind)) {
      throw new Error("context.capture kind is invalid");
    }
    if (typeof workspace !== "string" || realpathSync(workspace) !== this.#workspace) {
      throw new Error("Captured context does not belong to the selected workspace");
    }
    for (const key of ["path", "language", "content", "selection", "terminalExcerpt"]) {
      const value = payload[key];
      if (value !== undefined && typeof value !== "string") throw new Error(`context.capture ${key} must be a string`);
    }
    if (payload["range"] !== undefined && !isObject(payload["range"])) {
      throw new Error("context.capture range must be an object");
    }
    if (payload["diagnostics"] !== undefined && !Array.isArray(payload["diagnostics"])) {
      throw new Error("context.capture diagnostics must be an array");
    }
    const requestedPath = typeof payload["path"] === "string"
      ? resolve(workspace, payload["path"])
      : null;
    const path = requestedPath === null ? null : realpathSync(requestedPath);
    const relativePath = path === null ? null : relative(this.#workspace, path);
    if (
      relativePath !== null &&
      (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))
    ) {
      throw new Error("Captured file is outside the selected workspace");
    }
    const normalizedPayload = { ...payload, workspace: this.#workspace, ...(path ? { path } : {}) };
    const summary =
      kind === "active_file"
        ? `Active file: ${path ?? "unknown"}`
        : kind === "selection"
          ? `Explicit selection: ${path ?? "unknown"}`
          : kind === "diagnostics"
            ? `Diagnostics: ${path ?? "workspace"}`
            : "Explicit terminal excerpt";
    const artifact = this.#artifacts.capture(kind as ContextKind, this.#workspace, summary, normalizedPayload);
    this.emit("context.captured", {
      id: artifact.id,
      kind: artifact.kind,
      workspace: artifact.workspace,
      summary: artifact.summary,
    });
    this.#hooks.onContextCaptured?.(artifact);
    return { id: artifact.id, kind: artifact.kind, summary: artifact.summary };
  }

  async #publishControllerEvents(beforeSeq: number): Promise<void> {
    const events = this.#controller.eventsAfter(beforeSeq);
    for (const event of events) this.emit("domain.event", event);
    if (events.length === 0) return;
    this.emit("state.snapshot", {
      workspace: this.#workspace,
      snapshot: this.#controller.snapshot(),
      facts: this.#facts.project(this.#controller.snapshot()),
    });
    await this.#hooks.onTaskEvents?.(events);
  }

  #assertEmptyPayload(payload: unknown): void {
    if (!isObject(payload) || Object.keys(payload).length !== 0) throw new Error("Request payload must be empty");
  }

  #send(socket: ClientSocket, type: string, payload: unknown): void {
    socket.send(JSON.stringify({ version: 1, type, payload }));
  }
}
