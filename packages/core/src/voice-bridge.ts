import type { ActionResult, DomainEvent } from "@mamachi/protocol";
import type { ControllerSnapshot, TaskRecord } from "./domain.ts";
import type { CapturedContext, ContextKind, EvidenceArtifact } from "./artifact-store.ts";
import type {
  ComputerCapability,
  ComputerConfirmationMode,
  ComputerControlRequest,
  ComputerControlResult,
} from "./computer-control.ts";
import type { TaskFacts } from "./fact-projector.ts";
import type { PullRequestRequest, PullRequestResult } from "./pull-request.ts";
import type { MemoryScope } from "./memory-store.ts";
import type { VoiceBrief } from "./voice-brief-store.ts";

/// Which voice pipeline serves the session. `realtime` is the existing
/// OpenAI speech-to-speech bridge; `cascade` is STT (ElevenLabs Scribe v2
/// Realtime) → LLM (GPT-5.5, Responses API) → TTS (ElevenLabs Flash v2.5).
export const voiceEngines = ["realtime", "cascade"] as const;
export type VoiceEngine = (typeof voiceEngines)[number];

/// GPT-5.5 renamed GPT-5's "minimal" to "none"; `none` is the low-latency
/// default for the cascade.
export const cascadeReasoningEfforts = ["none", "low", "medium", "high", "xhigh"] as const;
export type CascadeReasoningEffort = (typeof cascadeReasoningEfforts)[number];

export type VoiceResponseMode = "voice" | "text";

/// Position of locally played assistant audio, reported by the app so a
/// bridge can truncate provider/conversation history to exactly what the
/// user heard. Structurally identical to `RealtimePlaybackCursor`.
export interface PlaybackCursor {
  itemId: string;
  contentIndex: number;
  audioEndMs: number;
}

export interface VoiceConnectKeys {
  openaiApiKey?: string;
  elevenLabsApiKey?: string;
}

/// Common surface driven by the daemon for either voice pipeline.
export interface VoiceBridge {
  connect(keys?: VoiceConnectKeys): Promise<void>;
  disconnect(): Promise<void>;
  appendAudio(pcm: Uint8Array): void;
  setEngaged(engaged: boolean, playback?: PlaybackCursor | null): void;
  interrupt(playback?: PlaybackCursor | null): void;
  setResponseMode(mode: VoiceResponseMode): void;
  sendText(text: string): void;
  captureContext(context: CapturedContext): void;
  discardContext(id: string): void;
  handleTaskEvents(events: readonly DomainEvent[]): void;
  noteHarnessEvent(type: string, payload: unknown): void;
  refreshComputerControlConfiguration(): void;
}

/// Controller/daemon callbacks a voice pipeline needs to ground itself and
/// execute tools. Mirrors the callback portion of `RealtimeBridgeOptions` so
/// `daemon.ts` wires both engines from one option set.
export interface VoiceHostCallbacks {
  getWorkspace: () => string;
  getAvailableWorkspaces?: () => readonly string[];
  getCodingProfiles?: () => readonly string[];
  getComputerCapabilities?: () => readonly ComputerCapability[];
  getComputerConfirmationMode?: () => ComputerConfirmationMode;
  getSnapshot: () => ControllerSnapshot;
  getTaskFacts?: (taskId: string) => TaskFacts | undefined;
  getTaskArtifact?: (taskId: string, artifactId: string) => EvidenceArtifact | null;
  executeCommand: (command: unknown) => Promise<ActionResult>;
  captureEditorContext?: (kinds: readonly ContextKind[]) => Promise<{
    artifacts: Array<{ id: string; kind: ContextKind; summary: string }>;
    errors: Array<{ kind: ContextKind; error: string }>;
  }>;
  askCoder?: (taskId: string, question: string) => Promise<boolean>;
  steerCoder?: (taskId: string, clarification: string) => Promise<boolean>;
  followUpCoder?: (taskId: string, addition: string) => Promise<boolean>;
  rememberFact?: (scope: MemoryScope, projectId: string | null, fact: string) => {
    id: string;
    scope: MemoryScope;
    projectId: string | null;
    fact: string;
  };
  forgetFact?: (memoryId: string) => boolean;
  controlComputer?: (request: ComputerControlRequest) => Promise<ComputerControlResult>;
  /// Pushes a task's branch and opens (or finds) a pull request. Host-side
  /// only -- the toolkit never runs git/gh itself, only calls this after an
  /// explicit user confirmation (see `open_pull_request` /
  /// `resolve_open_pull_request` in `voice-toolkit.ts`).
  openPullRequest?: (request: PullRequestRequest) => Promise<PullRequestResult>;
  emit: (type: string, payload: unknown) => void;
  /// Registers a screen capture as an attachable context artifact (returns
  /// the stored artifact) so voice can hand pixels to the coding agent.
  captureScreenContext?: (path: string, summary: string) => Promise<CapturedContext>;
}

/// What the toolkit sees: daemon callbacks plus the little bridge state the
/// tool executor genuinely needs. Implemented by the owning bridge.
export interface VoiceToolHost extends VoiceHostCallbacks {
  isEngaged(): boolean;
  getResponseMode(): VoiceResponseMode;
  /// `mute_mamachi`: disengage the microphone silently.
  sleepMicrophone(): void;
  /// Attach a user-turn image (data URL) plus a guidance note to the live
  /// conversation so the model can inspect pixels this turn. Bridges own
  /// retention: the cascade detaches images after their turn because it
  /// re-sends full history per request.
  attachUserImage(note: string, dataUrl: string): void;
  /// Exact accepted user text for the active turn, or null for autonomous
  /// task updates. Used to prevent models from inventing coder answers.
  getCurrentUserInput(): string | null;
}

/// Function-tool definition in OpenAI Responses API shape. The Realtime API
/// uses the same fields, so one definition serves both engines.
export interface VoiceFunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

/// Stateful, per-bridge tool surface (PRD section 16). Owns the pending
/// captured-context store and the pending computer-control confirmations
/// (including their expiry timers); bridges delegate instead of duplicating.
export interface VoiceToolkit {
  instructions(): string;
  tools(): VoiceFunctionTool[];
  execute(name: string, input: unknown): Promise<unknown>;
  /// Recent harness activity per task, surfaced by the status tools.
  noteHarnessEvent(type: string, payload: unknown): void;
  captureContext(context: CapturedContext): void;
  discardContext(id: string): void;
  pendingContexts(): CapturedContext[];
  clearPendingComputerControls(reason: string): void;
  /// Cancel timers so a disposed bridge leaks nothing.
  dispose(): void;
}

export type VoiceToolkitFactory = (host: VoiceToolHost) => VoiceToolkit;

export interface CascadeBridgeOptions extends VoiceHostCallbacks {
  emitAudio: (pcm: Uint8Array, playback: { itemId: string; contentIndex: number }) => void;
  createToolkit: VoiceToolkitFactory;
  openaiApiKey?: string;
  elevenLabsApiKey?: string;
  /// Defaults: gpt-5.5, reasoning effort none, Rachel, scribe_v2_realtime,
  /// eleven_flash_v2_5.
  llmModel?: string;
  reasoningEffort?: CascadeReasoningEffort;
  voiceId?: string;
  sttModelId?: string;
  ttsModelId?: string;
  /// Test seams; production values are the public OpenAI/ElevenLabs URLs.
  responsesEndpoint?: string;
  sttEndpoint?: string;
  ttsEndpoint?: string;
  initialBriefs?: readonly VoiceBrief[];
  onBriefQueued?: (brief: VoiceBrief) => void;
  onBriefDelivered?: (taskIds: readonly string[]) => void;
  initiallyEngaged?: boolean;
  reconnectDelaysMs?: readonly number[];
}

export const defaultCascadeVoiceId = "21m00Tcm4TlvDq8ikWAM"; // Rachel
export const defaultCascadeLlmModel = "gpt-5.5";
export const defaultCascadeReasoningEffort: CascadeReasoningEffort = "none";
export const defaultSttModelId = "scribe_v2_realtime";
export const defaultTtsModelId = "eleven_flash_v2_5";

export type { TaskRecord };
