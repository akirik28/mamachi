import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { MamachiIpcServer } from "../src/ipc-server.ts";
import type { EditorDocumentState } from "../src/workspace-guard.ts";

interface IpcResponse {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

function request(socket: WebSocket, type: string, payload: Record<string, unknown>): Promise<IpcResponse> {
  const id = Bun.randomUUIDv7();
  const { promise, resolve, reject } = Promise.withResolvers<IpcResponse>();
  const onMessage = (data: WebSocket.RawData): void => {
    const message = JSON.parse(data.toString()) as { type?: unknown; payload?: unknown };
    if (message.type !== "response" || typeof message.payload !== "object" || message.payload === null) return;
    const response = message.payload as IpcResponse;
    if (response.requestId !== id) return;
    socket.off("message", onMessage);
    resolve(response);
  };
  socket.on("message", onMessage);
  socket.once("error", reject);
  socket.send(JSON.stringify({ version: 1, id, type, payload }));
  return promise;
}

test("IPC forwards strict editor state without document content", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mamachi-ipc-editor-"));
  const path = join(workspace, "feature.ts");
  const canonicalWorkspace = realpathSync(workspace);
  const canonicalPath = join(canonicalWorkspace, "feature.ts");
  writeFileSync(path, "export {};\n");
  const editorStates: EditorDocumentState[] = [];
  const server = new MamachiIpcServer({
    token: "editor-test-token",
    port: 0,
    initialWorkspace: workspace,
    hooks: { onEditorState: (state) => editorStates.push(state) },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    headers: { Authorization: "Bearer editor-test-token" },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    const accepted = await request(socket, "editor.state", {
      workspace,
      path,
      version: 7,
      dirty: true,
      open: true,
    });
    expect(accepted).toMatchObject({ ok: true, result: { accepted: true } });
    expect(editorStates).toEqual([
      { workspace: canonicalWorkspace, path: canonicalPath, version: 7, dirty: true, open: true },
    ]);

    const rejected = await request(socket, "editor.state", {
      workspace,
      path,
      version: 8,
      dirty: false,
      open: true,
      content: "must never cross this boundary",
    });
    expect(rejected).toMatchObject({ ok: false, error: "editor.state payload is invalid" });
    expect(editorStates).toHaveLength(1);
  } finally {
    socket.close();
    server.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("IPC removes captured context through the hook and broadcasts context.removed", async () => {
  const removed: string[] = [];
  const server = new MamachiIpcServer({
    token: "context-remove-token",
    port: 0,
    hooks: { onContextRemoved: (id) => removed.push(id) },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    headers: { Authorization: "Bearer context-remove-token" },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const broadcasts: unknown[] = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { type?: unknown; payload?: unknown };
      if (message.type === "context.removed") broadcasts.push(message.payload);
    });

    const accepted = await request(socket, "context.remove", { id: "ctx_1" });
    expect(accepted).toMatchObject({ ok: true, result: { removed: true } });
    expect(removed).toEqual(["ctx_1"]);
    expect(broadcasts).toEqual([{ ids: ["ctx_1"] }]);

    const missingId = await request(socket, "context.remove", {});
    expect(missingId).toMatchObject({ ok: false, error: "context.remove requires one id string" });
    const wrongType = await request(socket, "context.remove", { id: 7 });
    expect(wrongType.ok).toBe(false);
    const extraKey = await request(socket, "context.remove", { id: "ctx_2", purge: true });
    expect(extraKey.ok).toBe(false);
    expect(removed).toEqual(["ctx_1"]);
    expect(broadcasts).toEqual([{ ids: ["ctx_1"] }]);
  } finally {
    socket.close();
    server.close();
  }
});

test("IPC validates voice engagement and forwards the playback cursor", async () => {
  const engagements: Array<{ engaged: boolean; playback: unknown }> = [];
  const server = new MamachiIpcServer({
    token: "engagement-token",
    port: 0,
    hooks: { onVoiceEngagement: (engaged, playback) => engagements.push({ engaged, playback }) },
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    headers: { Authorization: "Bearer engagement-token" },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    const engagedOnly = await request(socket, "voice.engagement", { engaged: true });
    expect(engagedOnly).toMatchObject({ ok: true, result: { engaged: true } });
    const withPlayback = await request(socket, "voice.engagement", {
      engaged: false,
      playback: { itemId: "item_9", contentIndex: 0, audioEndMs: 1200 },
    });
    expect(withPlayback).toMatchObject({ ok: true, result: { engaged: false } });
    expect(engagements).toEqual([
      { engaged: true, playback: null },
      { engaged: false, playback: { itemId: "item_9", contentIndex: 0, audioEndMs: 1200 } },
    ]);

    const missing = await request(socket, "voice.engagement", {});
    expect(missing).toMatchObject({ ok: false, error: "voice.engagement payload is invalid" });
    const wrongType = await request(socket, "voice.engagement", { engaged: "yes" });
    expect(wrongType.ok).toBe(false);
    const badCursor = await request(socket, "voice.engagement", { engaged: true, playback: { itemId: "" } });
    expect(badCursor).toMatchObject({ ok: false, error: "Playback cursor is invalid" });
    const extraKey = await request(socket, "voice.engagement", { engaged: true, mode: "voice" });
    expect(extraKey.ok).toBe(false);
    expect(engagements).toHaveLength(2);
  } finally {
    socket.close();
    server.close();
  }
});

test("IPC rejects task attachments that are missing from the selected workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mamachi-ipc-attachment-"));
  const server = new MamachiIpcServer({
    token: "attachment-test-token",
    port: 0,
    initialWorkspace: workspace,
  });
  try {
    const result = await server.executeCommand({
      id: Bun.randomUUIDv7(),
      type: "task.submit",
      actor: "voice",
      expectedRevision: null,
      payload: {
        repositoryId: realpathSync(workspace),
        objective: "Use the captured editor selection",
        acceptanceCriteria: ["The selected behavior is implemented"],
        constraints: [],
        attachmentIds: [Bun.randomUUIDv7()],
        codingProfileId: null,
      },
    });
    expect(result).toMatchObject({
      status: "rejected",
      code: "attachment_mismatch",
    });
    expect(server.snapshot().tasks).toEqual([]);
  } finally {
    server.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("IPC correlates explicit editor capture requests and reports timeout without silent capture", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mamachi-ipc-voice-capture-"));
  const path = join(workspace, "feature.ts");
  writeFileSync(path, "export const value = 1;\n");
  const server = new MamachiIpcServer({
    token: "voice-capture-token",
    port: 0,
    initialWorkspace: workspace,
    editorContextTimeoutMs: 20,
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    headers: { Authorization: "Bearer voice-capture-token" },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const responseSent = Promise.withResolvers<void>();
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { type?: unknown; payload?: unknown };
      if (message.type !== "editor.context.request" || typeof message.payload !== "object" || message.payload === null) return;
      const payload = message.payload as { requestId: string };
      void request(socket, "editor.context.response", {
        requestId: payload.requestId,
        captures: [{ kind: "selection", payload: { path, language: "typescript", selection: "value = 1" } }],
        errors: [],
      }).then(() => responseSent.resolve());
    });
    const captured = await server.captureEditorContext(["selection"]);
    await responseSent.promise;
    expect(captured.errors).toEqual([]);
    expect(captured.artifacts).toHaveLength(1);
    expect(server.getArtifacts([captured.artifacts[0]!.id])[0]?.payload["selection"]).toBe("value = 1");

    const stale = await request(socket, "editor.context.response", {
      requestId: "stale-request",
      captures: [],
      errors: [],
    });
    expect(stale).toMatchObject({ ok: false, error: "Editor context response is stale or does not match the request" });
  } finally {
    socket.close();
    server.close();
    rmSync(workspace, { recursive: true, force: true });
  }

  const timeoutWorkspace = mkdtempSync(join(tmpdir(), "mamachi-ipc-voice-timeout-"));
  const timeoutServer = new MamachiIpcServer({
    token: "voice-timeout-token",
    port: 0,
    initialWorkspace: timeoutWorkspace,
    editorContextTimeoutMs: 5,
  });
  try {
    await expect(timeoutServer.captureEditorContext(["diagnostics"])).rejects.toThrow(
      "No connected VS Code client can capture editor context",
    );
  } finally {
    timeoutServer.close();
    rmSync(timeoutWorkspace, { recursive: true, force: true });
  }
});

test("IPC artifact getters enforce task ownership", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mamachi-ipc-artifact-owner-"));
  const server = new MamachiIpcServer({
    token: "artifact-owner-token",
    port: 0,
    initialWorkspace: workspace,
  });
  try {
    const submitted = await server.executeCommand({
      id: Bun.randomUUIDv7(),
      type: "task.submit",
      actor: "voice",
      expectedRevision: null,
      payload: {
        repositoryId: realpathSync(workspace),
        objective: "Change a file",
        acceptanceCriteria: ["The change is verified"],
        constraints: [],
        attachmentIds: [],
        codingProfileId: null,
      },
    });
    if (submitted.status !== "accepted" || !submitted.taskId) throw new Error("Task submission failed");
    const task = server.snapshot().tasks.find((candidate) => candidate.id === submitted.taskId);
    if (!task?.activeRunId) throw new Error("Task did not start");
    const artifact = await server.recordToolEvidence({
      taskId: task.id,
      runId: task.activeRunId,
      repository: workspace,
      toolCallId: "tool-1",
      toolName: "bash",
      input: { command: "bun test focused" },
      result: "passed",
      isError: false,
    });
    expect(server.getTaskArtifact(task.id, artifact.id)?.id).toBe(artifact.id);
    expect(server.getTaskArtifact("different-task", artifact.id)).toBeNull();
    expect(server.getTaskArtifact(task.id, "missing-artifact")).toBeNull();
  } finally {
    server.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("IPC rejects a task submitted against a repository that was never registered", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mamachi-ipc-workspace-registry-"));
  const otherRepo = mkdtempSync(join(tmpdir(), "mamachi-ipc-workspace-unregistered-"));
  const server = new MamachiIpcServer({
    token: "workspace-registry-token",
    port: 0,
    initialWorkspace: workspace,
  });
  try {
    const result = await server.executeCommand({
      id: Bun.randomUUIDv7(),
      type: "task.submit",
      actor: "voice",
      expectedRevision: null,
      payload: {
        repositoryId: realpathSync(otherRepo),
        objective: "Fix a bug in a repo nobody registered",
        acceptanceCriteria: ["It compiles"],
        constraints: [],
        attachmentIds: [],
        codingProfileId: null,
      },
    });
    expect(result).toMatchObject({ status: "rejected", code: "workspace_mismatch" });
    expect(server.snapshot().tasks).toEqual([]);
  } finally {
    server.close();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(otherRepo, { recursive: true, force: true });
  }
});

test("workspace.select registers a second repository without displacing the first", async () => {
  const firstWorkspace = mkdtempSync(join(tmpdir(), "mamachi-ipc-workspace-first-"));
  const secondWorkspace = mkdtempSync(join(tmpdir(), "mamachi-ipc-workspace-second-"));
  const server = new MamachiIpcServer({
    token: "workspace-multi-token",
    port: 0,
    initialWorkspace: firstWorkspace,
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    headers: { Authorization: "Bearer workspace-multi-token" },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    const selected = await request(socket, "workspace.select", { path: secondWorkspace });
    expect(selected.ok).toBe(true);

    // The first task, submitted before the second workspace was ever
    // selected, must still be accepted -- registering a new repository is
    // additive, not a replacement of the one the daemon started with.
    const first = await server.executeCommand({
      id: Bun.randomUUIDv7(),
      type: "task.submit",
      actor: "voice",
      expectedRevision: null,
      payload: {
        repositoryId: realpathSync(firstWorkspace),
        objective: "Work in the original repository",
        acceptanceCriteria: ["It works"],
        constraints: [],
        attachmentIds: [],
        codingProfileId: null,
      },
    });
    expect(first.status).toBe("accepted");

    const second = await server.executeCommand({
      id: Bun.randomUUIDv7(),
      type: "task.submit",
      actor: "voice",
      expectedRevision: null,
      payload: {
        repositoryId: realpathSync(secondWorkspace),
        objective: "Work in the newly selected repository",
        acceptanceCriteria: ["It also works"],
        constraints: [],
        attachmentIds: [],
        codingProfileId: null,
      },
    });
    expect(second.status).toBe("accepted");

    const repositoryIds = server.snapshot().tasks.map((task) => task.repositoryId).sort();
    expect(repositoryIds).toEqual([realpathSync(firstWorkspace), realpathSync(secondWorkspace)].sort());
  } finally {
    socket.close();
    server.close();
    rmSync(firstWorkspace, { recursive: true, force: true });
    rmSync(secondWorkspace, { recursive: true, force: true });
  }
});

test("a symlink alias to a registered repository is accepted, not treated as a different workspace", async () => {
  const realWorkspace = mkdtempSync(join(tmpdir(), "mamachi-ipc-workspace-real-"));
  const aliasPath = join(tmpdir(), `mamachi-ipc-workspace-alias-${Bun.randomUUIDv7()}`);
  const { symlinkSync, unlinkSync } = await import("node:fs");
  symlinkSync(realWorkspace, aliasPath);
  const server = new MamachiIpcServer({
    token: "workspace-alias-token",
    port: 0,
    initialWorkspace: realWorkspace,
  });
  try {
    // Submit through the alias path, never the canonical one directly.
    const result = await server.executeCommand({
      id: Bun.randomUUIDv7(),
      type: "task.submit",
      actor: "voice",
      expectedRevision: null,
      payload: {
        repositoryId: aliasPath,
        objective: "Submitted through a symlink alias",
        acceptanceCriteria: ["It resolves to the same repository"],
        constraints: [],
        attachmentIds: [],
        codingProfileId: null,
      },
    });
    expect(result.status).toBe("accepted");
    // Stored identity is the canonical path, not the alias -- otherwise the
    // per-repository concurrency mutex could be defeated by two tasks
    // referencing the same real directory through different alias strings.
    expect(server.snapshot().tasks[0]?.repositoryId).toBe(realpathSync(realWorkspace));
  } finally {
    server.close();
    unlinkSync(aliasPath);
    rmSync(realWorkspace, { recursive: true, force: true });
  }
});

test("workspace.select rejects a path that does not exist, without corrupting the registry", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mamachi-ipc-workspace-badpath-"));
  const server = new MamachiIpcServer({
    token: "workspace-badpath-token",
    port: 0,
    initialWorkspace: workspace,
  });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    headers: { Authorization: "Bearer workspace-badpath-token" },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });

    const rejected = await request(socket, "workspace.select", {
      path: join(workspace, "does-not-exist"),
    });
    expect(rejected.ok).toBe(false);

    // The original workspace must still be the only registered one.
    const stillWorks = await server.executeCommand({
      id: Bun.randomUUIDv7(),
      type: "task.submit",
      actor: "voice",
      expectedRevision: null,
      payload: {
        repositoryId: realpathSync(workspace),
        objective: "The original workspace survives a bad selection attempt",
        acceptanceCriteria: ["It still works"],
        constraints: [],
        attachmentIds: [],
        codingProfileId: null,
      },
    });
    expect(stillWorks.status).toBe("accepted");
  } finally {
    socket.close();
    server.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
