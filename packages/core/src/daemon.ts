import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MamachiIpcServer } from "./ipc-server.ts";
import { CodingRunner } from "./coding-runner.ts";
import { RealtimeBridge } from "./realtime-bridge.ts";
import { CascadeBridge } from "./cascade-bridge.ts";
import { createVoiceToolkit } from "./voice-toolkit.ts";
import type { ContextKind } from "./artifact-store.ts";
import type { ComputerControlRequest } from "./computer-control.ts";
import type { MemoryScope } from "./memory-store.ts";
import {
  codingBackends,
  defaultRuntimeSettings,
  type CodingBackend,
  type RuntimeSettings,
} from "./model-router.ts";
import { MacComputerController } from "./computer-control.ts";
import { OmpObserverBackend, PassiveObserver } from "./observer.ts";
import { VoiceBriefStore } from "./voice-brief-store.ts";
import { resolveEncryptionKey } from "./encryption-key.ts";

const token = process.env["MAMACHI_TOKEN"] ?? Bun.randomUUIDv7();
const port = Number.parseInt(process.env["MAMACHI_PORT"] ?? "47821", 10);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error("MAMACHI_PORT must be a valid TCP port");
}

const databasePath = resolve(process.env["MAMACHI_STATE_PATH"] ?? ".mamachi/demo.sqlite");
mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
const connectionPath = process.env["MAMACHI_CONNECTION_PATH"]
  ? resolve(process.env["MAMACHI_CONNECTION_PATH"])
  : null;

const encryptionKey = resolveEncryptionKey({
  configuredKey: process.env["MAMACHI_ENCRYPTION_KEY"],
  databasePath,
  keyPath: process.env["MAMACHI_ENCRYPTION_KEY_PATH"],
  allowPlaintext: process.env["MAMACHI_ALLOW_PLAINTEXT"] === "1",
});
const codingProviderKeys = {
  anthropic: process.env["ANTHROPIC_API_KEY"],
  openai: process.env["OPENAI_API_KEY"],
  google: process.env["GEMINI_API_KEY"],
};
const realtimeDevelopmentApiKey = codingProviderKeys.openai;
const elevenLabsDevelopmentApiKey = process.env["MAMACHI_ELEVENLABS_API_KEY"] ?? null;
const authStorage = await discoverAuthStorage();
for (const [provider, apiKey] of Object.entries(codingProviderKeys)) {
  if (apiKey) authStorage.setRuntimeApiKey(provider, apiKey);
}
delete process.env["MAMACHI_ENCRYPTION_KEY"];
delete process.env["MAMACHI_ENCRYPTION_KEY_PATH"];
delete process.env["MAMACHI_ALLOW_PLAINTEXT"];
delete process.env["MAMACHI_TOKEN"];
delete process.env["ANTHROPIC_API_KEY"];
delete process.env["OPENAI_API_KEY"];
delete process.env["GEMINI_API_KEY"];
delete process.env["MAMACHI_ELEVENLABS_API_KEY"];
const briefStore = new VoiceBriefStore(databasePath, encryptionKey);

let runner: CodingRunner | null = null;
let realtime: RealtimeBridge | null = null;
let cascade: CascadeBridge | null = null;
let observer: PassiveObserver | null = null;
let observerBackend: OmpObserverBackend | null = null;
const requestedCodingBackend = process.env["MAMACHI_CODING_BACKEND"];
const initialCodingBackend = codingBackends.includes(requestedCodingBackend as CodingBackend)
  ? requestedCodingBackend as CodingBackend
  : defaultRuntimeSettings.codingBackend;
const initialRuntimeSettings: RuntimeSettings = {
  ...defaultRuntimeSettings,
  codingBackend: initialCodingBackend,
  primaryModel: process.env["MAMACHI_CODING_MODEL"] ?? defaultRuntimeSettings.primaryModel,
};
let runtimeSettings = initialRuntimeSettings;
const computerController = new MacComputerController({
  capabilities: initialRuntimeSettings.computerCapabilities,
});
// Engine dispatch: `settings.update` selects which bridge serves the voice
// hooks. Both bridges exist for the whole daemon lifetime; only the active
// one holds provider sockets.
function activeVoice(): RealtimeBridge | CascadeBridge | null {
  return runtimeSettings.voiceEngine === "cascade" ? cascade : realtime;
}

// Daemon stderr is invisible in the bundled app but captured when running
// through a wrapper; these one-liners are the only visibility into the
// voice path. Never log audio or transcript content.
function voiceLog(at: string, detail: Record<string, unknown> = {}): void {
  console.error(`[mamachi.voice] ${JSON.stringify({ at, engine: runtimeSettings.voiceEngine, ...detail })}`);
}

let audioChunksForwarded = 0;

async function activeVoiceConnect(keys: { apiKey?: string; elevenLabsApiKey?: string }): Promise<void> {
  voiceLog("connect", { hasOpenAiKey: !!keys.apiKey, hasElevenLabsKey: !!keys.elevenLabsApiKey });
  try {
    if (runtimeSettings.voiceEngine === "cascade") {
      await cascade?.connect({
        ...(keys.apiKey ? { openaiApiKey: keys.apiKey } : {}),
        ...(keys.elevenLabsApiKey ? { elevenLabsApiKey: keys.elevenLabsApiKey } : {}),
      });
      return;
    }
    await realtime?.connect(keys.apiKey ? { openaiApiKey: keys.apiKey } : {});
  } catch (error) {
    voiceLog("connect.failed", { error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
const daemon = new MamachiIpcServer({
  token,
  port,
  databasePath,
  initialWorkspace: process.env["MAMACHI_WORKSPACE"] ?? process.cwd(),
  encryptionKey,
  hooks: {
    onAudioInput: (pcm) => {
      audioChunksForwarded += 1;
      if (audioChunksForwarded === 1 || audioChunksForwarded % 500 === 0) {
        voiceLog("audio.forwarded", { chunks: audioChunksForwarded, bytes: pcm.byteLength });
      }
      activeVoice()?.appendAudio(pcm);
    },
    onContextCaptured: (context) => activeVoice()?.captureContext(context),
    onContextRemoved: (id) => activeVoice()?.discardContext(id),
    onEditorState: (state) => runner?.updateEditorState(state),
    onTaskEvents: async (events) => {
      activeVoice()?.handleTaskEvents(events);
      await runner?.handleEvents(events);
      const taskIds = [
        ...new Set(
          events.flatMap((event) => {
            if (!event.taskId) return [];
            if (
              event.type === "task.completed" ||
              event.type === "task.failed" ||
              event.type === "task.awaitingUser" ||
              event.type === "task.questionAsked" ||
              (event.type === "artifact.created" &&
                (event.payload.kind === "file_change" || event.payload.kind === "verification"))
            ) {
              return [event.taskId];
            }
            return [];
          }),
        ),
      ];
      for (const taskId of taskIds) {
        const task = daemon.snapshot().tasks.find((candidate) => candidate.id === taskId);
        const facts = daemon.taskFacts(taskId);
        const runId = task?.activeRunId ?? task?.runIds.at(-1);
        if (!task || !facts || !runId) continue;
        observer?.observe({
          taskId,
          runId,
          repository: task.repositoryId,
          objective: task.spec.objective,
          taskState: task.state,
          terminalSummary: task.terminalSummary,
          facts,
        });
      }
    },
    onSettingsUpdate: (settings) => {
      if (settings.voiceEngine !== runtimeSettings.voiceEngine) {
        voiceLog("engine.switch", { to: settings.voiceEngine });
      }
      const previous = runtimeSettings;
      runtimeSettings = settings;
      runner?.configure(settings);
      observerBackend?.configure(process.env["MAMACHI_OBSERVER_MODEL"] ?? settings.fastModel);
      computerController.configure(settings.computerCapabilities);
      if (previous.voiceEngine !== settings.voiceEngine) {
        // Retire the outgoing engine's provider session; conversation state
        // stays in-process so switching back resumes cleanly.
        const retiring = previous.voiceEngine === "cascade" ? cascade : realtime;
        void retiring?.disconnect();
      }
      if (
        previous.cascadeReasoningEffort !== settings.cascadeReasoningEffort ||
        previous.cascadeVoiceId !== settings.cascadeVoiceId
      ) {
        // Cascade parameters are constructor-bound; rebuild with fresh state.
        const retired = cascade;
        if (retired) void retired.disconnect().finally(() => retired.dispose());
        cascade = buildCascade();
      }
      activeVoice()?.refreshComputerControlConfiguration();
    },
    onVoiceConnect: (keys) => activeVoiceConnect(keys),
    onVoiceDisconnect: () => activeVoice()?.disconnect(),
    onVoiceEngagement: (engaged, playback) => {
      audioChunksForwarded = 0;
      voiceLog("engagement", { engaged, hasPlaybackCursor: playback !== null });
      activeVoice()?.setEngaged(engaged, playback);
    },
    onVoiceInterrupt: (playback) => activeVoice()?.interrupt(playback),
    onVoiceText: (text) => activeVoice()?.sendText(text),
    onVoiceMode: (mode) => activeVoice()?.setResponseMode(mode),
  },
});

const voiceCallbacks = {
  getWorkspace: () => daemon.workspace,
  getAvailableWorkspaces: () => daemon.workspaces,
  getCodingProfiles: () => ["auto", "primary", "fast"],
  getComputerCapabilities: () => runtimeSettings.computerCapabilities,
  getComputerConfirmationMode: () => runtimeSettings.computerConfirmationMode,
  getSnapshot: () => daemon.snapshot(),
  getTaskFacts: (taskId: string) => daemon.taskFacts(taskId),
  getTaskArtifact: (taskId: string, artifactId: string) => daemon.getTaskArtifact(taskId, artifactId),
  executeCommand: (command: unknown) => daemon.executeCommand(command),
  captureEditorContext: (kinds: readonly ContextKind[]) => daemon.captureEditorContext(kinds),
  askCoder: async (taskId: string, question: string) => (runner ? runner.askCoder(taskId, question) : false),
  steerCoder: async (taskId: string, clarification: string) => (runner ? runner.steer(taskId, clarification) : false),
  followUpCoder: async (taskId: string, addition: string) => (runner ? runner.followUp(taskId, addition) : false),
  rememberFact: (scope: MemoryScope, projectId: string | null, fact: string) =>
    daemon.rememberFact(scope, projectId, fact),
  forgetFact: (memoryId: string) => daemon.forgetFact(memoryId),
  controlComputer: (request: ComputerControlRequest) => computerController.control(request),
  emit: (type: string, payload: unknown) => daemon.emit(type, payload),
  captureScreenContext: async (path: string, summary: string) =>
    daemon.captureScreenshotContext(path, summary),
};

realtime = new RealtimeBridge({
  ...(realtimeDevelopmentApiKey ? { apiKey: realtimeDevelopmentApiKey } : {}),
  ...voiceCallbacks,
  initialBriefs: briefStore.pending(),
  onBriefQueued: (brief) => briefStore.save(brief),
  onBriefDelivered: (taskIds) => briefStore.markDelivered(taskIds),
  emitAudio: (pcm) => daemon.emitAudio(pcm),
  initiallyEngaged: false,
});

function buildCascade(): CascadeBridge {
  return new CascadeBridge({
    ...voiceCallbacks,
    ...(realtimeDevelopmentApiKey ? { openaiApiKey: realtimeDevelopmentApiKey } : {}),
    ...(elevenLabsDevelopmentApiKey ? { elevenLabsApiKey: elevenLabsDevelopmentApiKey } : {}),
    reasoningEffort: runtimeSettings.cascadeReasoningEffort,
    ...(runtimeSettings.cascadeVoiceId ? { voiceId: runtimeSettings.cascadeVoiceId } : {}),
    createToolkit: createVoiceToolkit,
    initialBriefs: briefStore.pending(),
    onBriefQueued: (brief) => briefStore.save(brief),
    onBriefDelivered: (taskIds) => briefStore.markDelivered(taskIds),
    emitAudio: (pcm) => daemon.emitAudio(pcm),
    initiallyEngaged: false,
  });
}
cascade = buildCascade();

observerBackend = new OmpObserverBackend(
  process.env["MAMACHI_OBSERVER_MODEL"] ?? initialRuntimeSettings.fastModel,
  authStorage,
);
observer = new PassiveObserver({
  backend: observerBackend,
  persist: (input) => daemon.recordObserverInterpretation(input),
  emit: (type, payload) => daemon.emit(type, payload),
});

runner = new CodingRunner({
  authStorage,
  getTask: (taskId) => daemon.snapshot().tasks.find((task) => task.id === taskId),
  getArtifacts: (ids) => daemon.getArtifacts(ids),
  emit: (type, payload) => {
    realtime?.noteHarnessEvent(type, payload);
    daemon.emit(type, payload);
  },
  onSafePause: (taskId, reason) => daemon.pauseAtSafeBoundary(taskId, reason),
  onAuthorizeTool: (taskId, toolName, input) => daemon.authorizeToolCall(taskId, toolName, input),
  onWorkspaceConflict: (taskId, conflict) => daemon.reportWorkspaceConflict(taskId, conflict),
  onRecordEvidence: (input) => daemon.recordToolEvidence(input),
  onComplete: (taskId, summary, evidenceIds) => daemon.completeTask(taskId, summary, evidenceIds),
  onFail: (taskId, error) => daemon.failTask(taskId, error),
  onNeedInput: (taskId, question) => daemon.awaitUserInput(taskId, question),
  onSessionBound: (taskId, runId, backend, sessionId, sessionFile) =>
    daemon.recordCoderSession(taskId, runId, backend, sessionId, sessionFile),
  runtimeSettings: initialRuntimeSettings,
});
await daemon.recoverAfterRestart();
if (connectionPath) {
  mkdirSync(dirname(connectionPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(connectionPath), 0o700);
  const temporaryPath = `${connectionPath}.${process.pid}.tmp`;
  writeFileSync(
    temporaryPath,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      port: daemon.port,
      token,
      workspace: daemon.workspace,
    }),
    { mode: 0o600 },
  );
  renameSync(temporaryPath, connectionPath);
}


console.log(
  JSON.stringify({
    type: "mamachi.ready",
    port: daemon.port,
    token,
    workspace: daemon.workspace,
    databasePath,
  }),
);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await realtime?.disconnect();
  await cascade?.disconnect();
  cascade?.dispose();
  await runner?.dispose();
  await observer?.dispose();
  daemon.close();
  briefStore.close();
  authStorage.close();
  if (connectionPath) {
    try {
      const descriptor = JSON.parse(readFileSync(connectionPath, "utf8")) as { token?: unknown };
      if (descriptor.token === token) rmSync(connectionPath);
    } catch {
      // A missing or replaced descriptor does not prevent daemon shutdown.
    }
  }
  process.exit(0);
}

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
