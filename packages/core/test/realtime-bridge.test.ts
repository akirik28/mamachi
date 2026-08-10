import { afterEach, describe, expect, test } from "bun:test";
import type { Server, ServerWebSocket } from "bun";
import type { ActionResult, DomainEvent } from "@mamachi/protocol";
import { RealtimeBridge } from "../src/realtime-bridge.ts";
import type { ControllerSnapshot, TaskRecord } from "../src/domain.ts";
import type { ComputerConfirmationMode } from "../src/computer-control.ts";

interface MockClientData {
  authenticated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


describe("RealtimeBridge", () => {
  let server: Server<MockClientData> | undefined;

  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  test("configures duplex audio and executes strict task tools", async () => {
    const incoming: Record<string, unknown>[] = [];
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const audio: Uint8Array[] = [];
    const commands: unknown[] = [];
    let client: ServerWebSocket<MockClientData> | undefined;
    let sawAuthorization = false;
    const contextReceived = Promise.withResolvers<void>();
    const textReceived = Promise.withResolvers<void>();
    const commandExecuted = Promise.withResolvers<void>();
    const functionOutputReceived = Promise.withResolvers<void>();
    const audioForwarded = Promise.withResolvers<void>();
    const transcriptReceived = Promise.withResolvers<void>();
    const manualResponseReceived = Promise.withResolvers<void>();
    let awaitingManualResponse = false;

    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        sawAuthorization = request.headers.get("authorization") === "Bearer test-realtime-key";
        const upgraded = bunServer.upgrade(request, { data: { authenticated: sawAuthorization } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open(socket) {
          client = socket;
        },
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          incoming.push(event);
          if (event["type"] === "session.update") {
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_test" } }));
          }
          const serialized = JSON.stringify(event);
          if (serialized.includes("explicitly captured editor context")) contextReceived.resolve();
          if (serialized.includes("Update the selected function")) textReceived.resolve();
          if (serialized.includes("call_submit_1") && serialized.includes("function_call_output")) {
            functionOutputReceived.resolve();
          }
          if (awaitingManualResponse && event["type"] === "response.create") manualResponseReceived.resolve();
        },
      },
    });

    const snapshot: ControllerSnapshot = {
      seq: 0,
      activeTaskId: null,
      queue: [],
      tasks: [],
      runs: [],
      confirmations: [],
    };
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => snapshot,
      executeCommand: async (command): Promise<ActionResult> => {
        commands.push(command);
        commandExecuted.resolve();
        return {
          status: "accepted",
          eventId: Bun.randomUUIDv7(),
          taskId: Bun.randomUUIDv7(),
        };
      },
      emit: (type, payload) => {
        emitted.push({ type, payload });
        if (type === "voice.transcript.assistant") transcriptReceived.resolve();
      },
      emitAudio: (pcm) => {
        audio.push(pcm);
        audioForwarded.resolve();
      },
    });

    bridge.captureContext({
      id: Bun.randomUUIDv7(),
      kind: "selection",
      workspace: "/tmp/mamachi-workspace",
      summary: "Explicit selection: math.ts",
      payload: { path: "math.ts", selection: "return 1" },
      createdAt: new Date().toISOString(),
    });
    await bridge.connect();
    await contextReceived.promise;

    expect(sawAuthorization).toBe(true);
    const update = incoming.find((event) => event["type"] === "session.update");
    expect(update).toBeDefined();
    const session = update?.["session"];
    if (!isRecord(session)) throw new Error("session.update did not include a session object");
    expect(session["output_modalities"]).toEqual(["audio"]);
    expect(session["parallel_tool_calls"]).toBe(false);
    expect(session["audio"]).toMatchObject({
      input: {
        format: { type: "audio/pcm", rate: 24_000 },
        turn_detection: { type: "server_vad", create_response: false, interrupt_response: true },
      },
      output: { format: { type: "audio/pcm", rate: 24_000 }, voice: "marin" },
    });
    expect(session["instructions"]).toContain("Do not speak before any tool call.");
    expect(session["instructions"]).toContain("inspect its accessibility UI");
    expect(session["instructions"]).toContain("chain the smallest necessary actions");
    const tools = session["tools"];
    const toolList = Array.isArray(tools) ? tools.filter(isRecord) : [];
    expect(toolList.map((tool) => tool["name"])).toEqual([
      "wait_for_user",
      "get_workspace",
      "list_coding_profiles",
      "capture_editor_context",
      "submit_task",
      "get_task_status",
      "get_task_artifact",
      "answer_task_question",
      "ask_coder",
      "propose_task_change",
      "control_task",
      "manage_queue",
      "resolve_confirmation",
      "remember_fact",
      "forget_fact",
      "inspect_workspace",
      "research_web",
      "set_overlay",
      "look_at_screen",
      "capture_screen_context",
      "control_computer",
      "resolve_computer_control",
      "open_pull_request",
      "resolve_open_pull_request",
      "mute_mamachi",
    ]);
    const computerTool = toolList.find((tool) => tool["name"] === "control_computer");
    if (!computerTool || !isRecord(computerTool["parameters"])) {
      throw new Error("control_computer did not include parameters");
    }
    const computerProperties = computerTool["parameters"]["properties"];
    if (!isRecord(computerProperties) || !isRecord(computerProperties["action"])) {
      throw new Error("control_computer did not include an action schema");
    }
    expect(computerProperties["action"]["enum"]).toEqual(expect.arrayContaining([
      "open_application",
      "inspect_ui",
      "click_ui_element",
      "set_ui_value",
      "select_menu_item",
    ]));
    expect(Object.keys(computerProperties)).toEqual(expect.arrayContaining([
      "application",
      "label",
      "role",
      "value",
      "menu",
      "menuItem",
    ]));
    expect(
      toolList.every((tool) => isRecord(tool["parameters"]) && tool["parameters"]["additionalProperties"] === false),
    ).toBe(true);
    expect(
      incoming.some(
        (event) =>
          event["type"] === "conversation.item.create" &&
          JSON.stringify(event).includes("explicitly captured editor context"),
      ),
    ).toBe(true);

    bridge.sendText("Update the selected function");
    await textReceived.promise;
    expect(
      incoming.some(
        (event) => event["type"] === "conversation.item.create" && JSON.stringify(event).includes("Update the selected function"),
      ),
    ).toBe(true);

    const callId = "call_submit_1";
    client?.send(
      JSON.stringify({
        type: "response.done",
        response: {
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: callId,
              name: "submit_task",
              arguments: JSON.stringify({
                repositoryId: "/tmp/mamachi-workspace",
                objective: "Update the selected function",
                acceptanceCriteria: ["The function returns two"],
                constraints: ["Change only the selected file"],
                attachmentIds: [],
                codingProfileId: null,
              }),
            },
          ],
        },
      }),
    );
    await commandExecuted.promise;
    const submitted = commands[0] as { type: string; payload: { attachmentIds: string[] } };
    expect(submitted.type).toBe("task.submit");
    expect(submitted.payload.attachmentIds).toHaveLength(0);
    await functionOutputReceived.promise;

    client?.send(
      JSON.stringify({
        type: "response.output_audio.delta",
        item_id: "assistant_item_task_started",
        content_index: 0,
        delta: Buffer.from([1, 2, 3, 4]).toString("base64"),
      }),
    );
    client?.send(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "Task started." }));
    await audioForwarded.promise;
    await transcriptReceived.promise;
    expect([...audio[0]!]).toEqual([1, 2, 3, 4]);
    expect(emitted).toContainEqual({ type: "voice.transcript.assistant", payload: { text: "Task started." } });

    client?.send(JSON.stringify({ type: "response.done", response: { status: "completed", output: [] } }));
    awaitingManualResponse = true;
    client?.send(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    await manualResponseReceived.promise;

    await bridge.disconnect();
    expect(emitted.at(-1)).toEqual({ type: "voice.state", payload: { state: "disconnected" } });
  });

  test("reconnects after the provider closes and accepts the next turn", async () => {
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const connectionIds = new Map<ServerWebSocket<MockClientData>, number>();
    const reconnected = Promise.withResolvers<void>();
    const turnAfterReconnect = Promise.withResolvers<void>();
    let firstClient: ServerWebSocket<MockClientData> | undefined;
    let connectionCount = 0;
    let connectedCount = 0;

    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const upgraded = bunServer.upgrade(request, { data: { authenticated: true } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open(socket) {
          connectionCount += 1;
          connectionIds.set(socket, connectionCount);
          if (connectionCount === 1) firstClient = socket;
        },
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          const connectionId = connectionIds.get(socket);
          if (event["type"] === "session.update") {
            socket.send(JSON.stringify({
              type: "session.updated",
              session: { id: `session_reconnect_${connectionId}` },
            }));
          } else if (
            connectionId === 2 &&
            event["type"] === "conversation.item.create" &&
            JSON.stringify(event).includes("Still listening after reconnect")
          ) {
            turnAfterReconnect.resolve();
          }
        },
        close(socket) {
          connectionIds.delete(socket);
        },
      },
    });

    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      reconnectDelaysMs: [5],
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({
        seq: 0,
        activeTaskId: null,
        queue: [],
        tasks: [],
        runs: [],
        confirmations: [],
      }),
      executeCommand: async () => ({ status: "accepted", eventId: Bun.randomUUIDv7() }),
      emit: (type, payload) => {
        emitted.push({ type, payload });
        if (type === "voice.state" && isRecord(payload) && payload["state"] === "connected") {
          connectedCount += 1;
          if (connectedCount === 2) reconnected.resolve();
        }
      },
      emitAudio: () => {},
    });

    await bridge.connect();
    try {
      firstClient?.close(1012, "Provider session rotated");
      await reconnected.promise;
      bridge.sendText("Still listening after reconnect");
      await turnAfterReconnect.promise;

      expect(connectionCount).toBe(2);
      expect(emitted).toContainEqual({
        type: "voice.state",
        payload: { state: "disconnected", reason: "provider_connection_closed" },
      });
      expect(connectedCount).toBe(2);
    } finally {
      await bridge.disconnect();
    }
    await Bun.sleep(20);
    expect(connectionCount).toBe(2);
  });

  test("reconnects automatically when a provider response stalls", async () => {
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const reconnected = Promise.withResolvers<void>();
    let connectionCount = 0;
    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const upgraded = bunServer.upgrade(request, { data: { authenticated: true } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open() {
          connectionCount += 1;
          if (connectionCount === 2) reconnected.resolve();
        },
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          if (event["type"] === "session.update") {
            socket.send(JSON.stringify({
              type: "session.updated",
              session: { id: `session_watchdog_${connectionCount}` },
            }));
          }
          // Deliberately leave response.create unanswered on the first socket.
        },
      },
    });
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      reconnectDelaysMs: [1],
      responseTimeoutMs: 10,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({
        seq: 0,
        activeTaskId: null,
        queue: [],
        tasks: [],
        runs: [],
        confirmations: [],
        questions: [],
      }),
      executeCommand: async () => ({ status: "accepted", eventId: Bun.randomUUIDv7() }),
      emit: (type, payload) => emitted.push({ type, payload }),
      emitAudio: () => {},
    });

    await bridge.connect();
    await Bun.sleep(20);
    bridge.sendText("This response will stall");
    await reconnected.promise;
    await Bun.sleep(20);
    expect(
      emitted.some((event) =>
        event.type === "voice.error" &&
        isRecord(event.payload) &&
        String(event.payload["error"]).includes("stopped responding")
      ),
    ).toBe(true);
    await bridge.disconnect();
  });

  test("wait_for_user ends the response chain", async () => {
    let client: ServerWebSocket<MockClientData> | undefined;
    const idle = Promise.withResolvers<void>();
    const functionOutput = Promise.withResolvers<void>();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const upgraded = bunServer.upgrade(request, { data: { authenticated: true } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open(socket) {
          client = socket;
        },
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          if (event["type"] === "session.update") {
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_wait" } }));
          }
          if (
            event["type"] === "conversation.item.create" &&
            JSON.stringify(event).includes("call_wait")
          ) {
            functionOutput.resolve();
          }
        },
      },
    });
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({ seq: 0, activeTaskId: null, queue: [], tasks: [], runs: [], confirmations: [] }),
      executeCommand: async () => {
        throw new Error("wait_for_user must not execute a coding command");
      },
      emit: (type, payload) => {
        emitted.push({ type, payload });
        if (type === "voice.state" && isRecord(payload) && payload["state"] === "idle") idle.resolve();
      },
      emitAudio: () => {},
    });

    await bridge.connect();
    bridge.sendText("Hello");
    client?.send(JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "background television speech",
    }));
    client?.send(
      JSON.stringify({
        type: "response.done",
        response: {
          status: "completed",
          output: [
            {
              type: "function_call",
              call_id: "call_wait",
              name: "wait_for_user",
              arguments: "{}",
            },
          ],
        },
      }),
    );

    await Promise.all([functionOutput.promise, idle.promise]);
    expect(emitted).toContainEqual({
      type: "voice.transcript.user_pending",
      payload: { text: "background television speech" },
    });
    expect(emitted).toContainEqual({ type: "voice.transcript.user_discarded", payload: {} });
    expect(emitted).not.toContainEqual({
      type: "voice.transcript.user",
      payload: { text: "background television speech" },
    });
    await bridge.disconnect();
  });

  test("stops a runaway voice tool chain after four rounds", async () => {
    let responseRounds = 0;
    const guardError = Promise.withResolvers<string>();
    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const upgraded = bunServer.upgrade(request, { data: { authenticated: true } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open() {},
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          if (event["type"] === "session.update") {
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_guard" } }));
          } else if (event["type"] === "response.create" && responseRounds < 4) {
            responseRounds += 1;
            socket.send(
              JSON.stringify({
                type: "response.done",
                response: {
                  status: "completed",
                  output: [
                    {
                      type: "function_call",
                      call_id: `call_status_${responseRounds}`,
                      name: "get_workspace",
                      arguments: "{}",
                    },
                  ],
                },
              }),
            );
          }
        },
      },
    });
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({ seq: 0, activeTaskId: null, queue: [], tasks: [], runs: [], confirmations: [] }),
      executeCommand: async () => {
        throw new Error("get_workspace must not execute a coding command");
      },
      emit: (type, payload) => {
        if (type === "voice.error" && isRecord(payload) && typeof payload["error"] === "string") {
          guardError.resolve(payload["error"]);
        }
      },
      emitAudio: () => {},
    });

    await bridge.connect();
    bridge.sendText("Loop forever");

    await expect(guardError.promise).resolves.toContain("four consecutive tool rounds");
    expect(responseRounds).toBe(4);
    await bridge.disconnect();
  });

  test("starts a fresh response after the user barges in", async () => {
    let client: ServerWebSocket<MockClientData> | undefined;
    let responseCreates = 0;
    const initialResponse = Promise.withResolvers<void>();
    const resumedResponse = Promise.withResolvers<void>();
    const audioForwarded = Promise.withResolvers<void>();
    const truncated = Promise.withResolvers<Record<string, unknown>>();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const audio: Uint8Array[] = [];
    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const upgraded = bunServer.upgrade(request, { data: { authenticated: true } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open(socket) {
          client = socket;
        },
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          if (event["type"] === "session.update") {
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_barge" } }));
          } else if (event["type"] === "response.create") {
            responseCreates += 1;
            if (responseCreates === 1) initialResponse.resolve();
            if (responseCreates === 2) resumedResponse.resolve();
          } else if (event["type"] === "conversation.item.truncate") {
            truncated.resolve(event);
          }
        },
      },
    });
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({ seq: 0, activeTaskId: null, queue: [], tasks: [], runs: [], confirmations: [] }),
      executeCommand: async () => {
        throw new Error("barge-in must not execute a coding command");
      },
      emit: (type, payload) => emitted.push({ type, payload }),
      emitAudio: (pcm) => {
        audio.push(pcm);
        audioForwarded.resolve();
      },
    });

    await bridge.connect();
    bridge.sendText("Start a long answer");
    await initialResponse.promise;
    client?.send(
      JSON.stringify({
        type: "response.output_audio.delta",
        item_id: "assistant_item_barge",
        content_index: 0,
        delta: Buffer.from([1, 2]).toString("base64"),
      }),
    );
    await audioForwarded.promise;
    bridge.interrupt({
      itemId: "assistant_item_barge",
      contentIndex: 0,
      audioEndMs: 735,
    });
    await expect(truncated.promise).resolves.toEqual({
      type: "conversation.item.truncate",
      item_id: "assistant_item_barge",
      content_index: 0,
      audio_end_ms: 735,
    });
    client?.send(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
    client?.send(
      JSON.stringify({
        type: "response.output_audio.delta",
        item_id: "assistant_item_barge",
        content_index: 0,
        delta: Buffer.from([3, 4]).toString("base64"),
      }),
    );
    client?.send(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    client?.send(JSON.stringify({ type: "response.done", response: { status: "cancelled", output: [] } }));

    await resumedResponse.promise;
    expect(responseCreates).toBe(2);
    expect(audio.map((pcm) => [...pcm])).toEqual([[1, 2]]);
    expect(emitted).toContainEqual({ type: "voice.interrupt", payload: {} });
    await bridge.disconnect();
  });

  test("ignores a raced cancel error and continues the interrupted turn", async () => {
    let client: ServerWebSocket<MockClientData> | undefined;
    let responseCreates = 0;
    const firstResponse = Promise.withResolvers<void>();
    const cancelReceived = Promise.withResolvers<void>();
    const resumedResponse = Promise.withResolvers<void>();
    const errors: string[] = [];
    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const upgraded = bunServer.upgrade(request, { data: { authenticated: true } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open(socket) {
          client = socket;
        },
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          if (event["type"] === "session.update") {
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_cancel_race" } }));
          } else if (event["type"] === "response.create") {
            responseCreates += 1;
            if (responseCreates === 1) firstResponse.resolve();
            if (responseCreates === 2) resumedResponse.resolve();
          } else if (event["type"] === "response.cancel") {
            cancelReceived.resolve();
          }
        },
      },
    });
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({ seq: 0, activeTaskId: null, queue: [], tasks: [], runs: [], confirmations: [] }),
      executeCommand: async () => {
        throw new Error("cancel race must not execute a coding command");
      },
      emit: (type, payload) => {
        if (type === "voice.error" && isRecord(payload) && typeof payload["error"] === "string") {
          errors.push(payload["error"]);
        }
      },
      emitAudio: () => {},
    });

    await bridge.connect();
    bridge.sendText("Start answering");
    await firstResponse.promise;
    bridge.interrupt();
    await cancelReceived.promise;
    client?.send(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    client?.send(
      JSON.stringify({
        type: "error",
        error: { message: "Cancellation failed: no active response found" },
      }),
    );

    await resumedResponse.promise;
    expect(responseCreates).toBe(2);
    expect(errors).toEqual([]);
    await bridge.disconnect();
  });

  test("switches future responses to silent text without cutting the active response", async () => {
    let client: ServerWebSocket<MockClientData> | undefined;
    const updates: Record<string, unknown>[] = [];
    let responseCreates = 0;
    const firstResponse = Promise.withResolvers<void>();
    const modeUpdated = Promise.withResolvers<void>();
    const textReceived = Promise.withResolvers<void>();
    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const upgraded = bunServer.upgrade(request, { data: { authenticated: true } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open(socket) {
          client = socket;
        },
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          if (event["type"] === "session.update") {
            updates.push(event);
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_text" } }));
            if (updates.length === 2) modeUpdated.resolve();
          } else if (event["type"] === "response.create") {
            responseCreates += 1;
            if (responseCreates === 1) {
              firstResponse.resolve();
            } else {
              socket.send(JSON.stringify({ type: "response.output_text.delta", delta: "Silent " }));
              socket.send(JSON.stringify({ type: "response.output_text.done", text: "Silent response" }));
              socket.send(JSON.stringify({ type: "response.done", response: { status: "completed", output: [] } }));
            }
          }
        },
      },
    });
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const audio: Uint8Array[] = [];
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({ seq: 0, activeTaskId: null, queue: [], tasks: [], runs: [], confirmations: [] }),
      executeCommand: async () => {
        throw new Error("text chat must not execute a coding command");
      },
      emit: (type, payload) => {
        emitted.push({ type, payload });
        if (type === "voice.transcript.assistant") textReceived.resolve();
      },
      emitAudio: (pcm) => audio.push(pcm),
    });

    await bridge.connect();
    bridge.sendText("Start a voice response");
    await firstResponse.promise;
    expect(updates).toHaveLength(1);
    bridge.setResponseMode("text");
    expect(updates).toHaveLength(1);
    client?.send(JSON.stringify({ type: "response.done", response: { status: "completed", output: [] } }));
    await modeUpdated.promise;
    bridge.sendText("Reply silently");
    await textReceived.promise;

    const latestSession = updates.at(-1)?.["session"];
    expect(isRecord(latestSession) ? latestSession["output_modalities"] : null).toEqual(["text"]);
    expect(emitted).toContainEqual({ type: "voice.transcript.assistant", payload: { text: "Silent response" } });
    expect(audio).toEqual([]);
    await bridge.disconnect();
    expect(client).toBeDefined();
  });

  test("delegates current web research to a fast coding task", async () => {
    const commands: unknown[] = [];
    let responseCreates = 0;
    const delegated = Promise.withResolvers<void>();
    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const upgraded = bunServer.upgrade(request, { data: { authenticated: true } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open() {},
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          if (event["type"] === "session.update") {
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_research" } }));
          } else if (event["type"] === "response.create") {
            responseCreates += 1;
            if (responseCreates === 1) {
              socket.send(
                JSON.stringify({
                  type: "response.done",
                  response: {
                    status: "completed",
                    output: [{
                      type: "function_call",
                      call_id: "research_call",
                      name: "research_web",
                      arguments: JSON.stringify({
                        query: "confirmed upcoming fixtures",
                        deliverable: "Return a concise fixture list",
                      }),
                    }],
                  },
                }),
              );
            } else {
              delegated.resolve();
            }
          }
        },
      },
    });
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({ seq: 0, activeTaskId: null, queue: [], tasks: [], runs: [], confirmations: [] }),
      executeCommand: async (command) => {
        commands.push(command);
        return { status: "accepted", eventId: Bun.randomUUIDv7(), taskId: Bun.randomUUIDv7() };
      },
      emit: () => {},
      emitAudio: () => {},
    });

    await bridge.connect();
    bridge.sendText("Find the upcoming fixtures");
    await delegated.promise;

    const command = commands[0];
    expect(isRecord(command) ? command["type"] : null).toBe("task.submit");
    const payload = isRecord(command) ? command["payload"] : null;
    expect(isRecord(payload) ? payload["codingProfileId"] : null).toBe("fast");
    expect(isRecord(payload) ? payload["constraints"] : null).toContain("Research only; do not modify workspace files.");
    await bridge.disconnect();
  });


  test("reuses an equivalent in-flight web search instead of clogging the queue", async () => {
    const repositoryId = "/tmp/mamachi-workspace";
    const taskId = Bun.randomUUIDv7();
    const duplicateTask: TaskRecord = {
      id: taskId,
      repositoryId,
      state: "queued",
      spec: {
        repositoryId,
        objective: "Research the web for: confirmed upcoming fixtures",
        acceptanceCriteria: ["Return a concise fixture list"],
        constraints: ["Research only; do not modify workspace files."],
        attachmentIds: [],
        codingProfileId: "fast",
      },
      revision: 1,
      activeRunId: null,
      runIds: [],
      evidenceIds: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      terminalSummary: null,
      workspaceConflict: null,
      codingSession: null,
      pendingQuestion: null,
      specHistory: [{
        revision: 1,
        objective: "Research the web for: confirmed upcoming fixtures",
        revisedAt: new Date(0).toISOString(),
      }],
    };
    const functionOutput = Promise.withResolvers<Record<string, unknown>>();
    let responseCreates = 0;
    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const upgraded = bunServer.upgrade(request, { data: { authenticated: true } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open() {},
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          if (event["type"] === "session.update") {
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_research_dedupe" } }));
          } else if (event["type"] === "response.create" && responseCreates++ === 0) {
            socket.send(JSON.stringify({
              type: "response.done",
              response: {
                status: "completed",
                output: [{
                  type: "function_call",
                  call_id: "research_duplicate",
                  name: "research_web",
                  arguments: JSON.stringify({
                    query: "confirmed upcoming fixtures",
                    deliverable: "Return a concise fixture list",
                  }),
                }],
              },
            }));
          } else if (
            event["type"] === "conversation.item.create" &&
            JSON.stringify(event).includes("research_duplicate")
          ) {
            const item = event["item"];
            if (isRecord(item) && typeof item["output"] === "string") {
              functionOutput.resolve(JSON.parse(item["output"]) as Record<string, unknown>);
            }
          }
        },
      },
    });
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => repositoryId,
      getSnapshot: () => ({
        seq: 1,
        activeTaskId: null,
        queue: [taskId],
        tasks: [duplicateTask],
        runs: [],
        confirmations: [],
      }),
      executeCommand: async () => {
        throw new Error("Equivalent research must not submit another queued task");
      },
      emit: () => {},
      emitAudio: () => {},
    });

    await bridge.connect();
    bridge.sendText("Find the upcoming fixtures");
    expect(await functionOutput.promise).toMatchObject({
      status: "accepted",
      taskId,
      state: "queued",
      deduplicated: true,
    });
    await bridge.disconnect();
  });
  test("delegates repository questions to a read-only fast coding task", async () => {
    const commands: unknown[] = [];
    let responseCreates = 0;
    const delegated = Promise.withResolvers<void>();
    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const upgraded = bunServer.upgrade(request, { data: { authenticated: true } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open() {},
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          if (event["type"] === "session.update") {
            const session = event["session"];
            expect(isRecord(session) ? session["instructions"] : null).toContain(
              "Any request whose answer depends on current workspace state",
            );
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_inspect" } }));
          } else if (event["type"] === "response.create") {
            responseCreates += 1;
            if (responseCreates === 1) {
              socket.send(
                JSON.stringify({
                  type: "response.done",
                  response: {
                    status: "completed",
                    output: [{
                      type: "function_call",
                      call_id: "inspect_call",
                      name: "inspect_workspace",
                      arguments: JSON.stringify({
                        question: "What are the latest commits?",
                        deliverable: "Return the five newest commits with hashes and subjects.",
                      }),
                    }],
                  },
                }),
              );
            } else {
              delegated.resolve();
            }
          }
        },
      },
    });
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({ seq: 0, activeTaskId: null, queue: [], tasks: [], runs: [], confirmations: [] }),
      executeCommand: async (command) => {
        commands.push(command);
        return { status: "accepted", eventId: Bun.randomUUIDv7(), taskId: Bun.randomUUIDv7() };
      },
      emit: () => {},
      emitAudio: () => {},
    });

    await bridge.connect();
    bridge.sendText("What are the latest commits?");
    await delegated.promise;

    const command = commands[0];
    expect(isRecord(command) ? command["type"] : null).toBe("task.submit");
    const payload = isRecord(command) ? command["payload"] : null;
    expect(isRecord(payload) ? payload["codingProfileId"] : null).toBe("fast");
    expect(isRecord(payload) ? payload["objective"] : null).toContain("What are the latest commits?");
    expect(isRecord(payload) ? payload["constraints"] : null).toContain(
      "Read-only inspection; do not modify workspace files.",
    );
    await bridge.disconnect();
  });

  test("sleeps without provider responses and delivers one queued grounded brief after resume", async () => {
    let client: ServerWebSocket<MockClientData> | undefined;
    let responseCreates = 0;
    const incoming: Record<string, unknown>[] = [];
    const audio: Uint8Array[] = [];
    const queued = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    const resumedResponse = Promise.withResolvers<void>();
    const audioForwarded = Promise.withResolvers<void>();
    const sleepingAudioProcessed = Promise.withResolvers<void>();
    let sleepingBarrierArmed = false;
    const emitted: Array<{ type: string; payload: unknown }> = [];
    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const upgraded = bunServer.upgrade(request, { data: { authenticated: true } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open(socket) {
          client = socket;
        },
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          incoming.push(event);
          if (event["type"] === "session.update") {
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_sleep" } }));
          } else if (event["type"] === "response.create") {
            responseCreates += 1;
            resumedResponse.resolve();
          }
        },
      },
    });
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      initiallyEngaged: false,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({ seq: 8, activeTaskId: null, queue: [], tasks: [], runs: [], confirmations: [] }),
      executeCommand: async () => {
        throw new Error("sleep brief must not execute another command");
      },
      emit: (type, payload) => {
        emitted.push({ type, payload });
        if (type === "brief.queued") queued.resolve();
        if (type === "brief.delivered") delivered.resolve();
        if (sleepingBarrierArmed && type === "voice.state") sleepingAudioProcessed.resolve();
      },
      emitAudio: (pcm) => {
        audio.push(pcm);
        audioForwarded.resolve();
      },
    });

    await bridge.connect();
    const eventId = Bun.randomUUIDv7();
    const taskId = Bun.randomUUIDv7();
    bridge.handleTaskEvents([{
      version: 1,
      id: eventId,
      seq: 8,
      at: new Date().toISOString(),
      type: "task.completed",
      actor: "controller",
      taskId,
      runId: Bun.randomUUIDv7(),
      correlationId: eventId,
      payload: {
        runId: Bun.randomUUIDv7(),
        summary: "Finished the requested change with targeted verification.",
        evidenceIds: [],
      },
    } as DomainEvent<"task.completed">]);
    await queued.promise;
    sleepingBarrierArmed = true;
    client?.send(JSON.stringify({
      type: "response.output_audio.delta",
      item_id: "sleep_race_item",
      content_index: 0,
      delta: Buffer.from([9, 9]).toString("base64"),
    }));
    client?.send(JSON.stringify({ type: "session.updated", session: { id: "sleep_barrier" } }));
    await sleepingAudioProcessed.promise;

    expect(responseCreates).toBe(0);
    expect(audio).toEqual([]);
    expect(emitted.some((event) => event.type === "voice.notification")).toBe(true);
    expect(incoming.some((event) => event["type"] === "conversation.item.create")).toBe(false);

    bridge.setEngaged(true);
    await Promise.all([resumedResponse.promise, delivered.promise]);
    expect(responseCreates).toBe(1);
    expect(
      incoming.filter((event) =>
        event["type"] === "conversation.item.create" &&
        JSON.stringify(event).includes("Mamachi resumed after sleeping")
      ),
    ).toHaveLength(1);
    client?.send(JSON.stringify({
      type: "response.output_audio.delta",
      item_id: "resumed_brief_item",
      content_index: 0,
      delta: Buffer.from([1, 2]).toString("base64"),
    }));
    await audioForwarded.promise;
    expect(audio.map((pcm) => [...pcm])).toEqual([[1, 2]]);
    await bridge.disconnect();
  });

  test("queues a proactive completion announcement behind an active response", async () => {
    let client: ServerWebSocket<MockClientData> | undefined;
    let responseCreates = 0;
    const injectedItems: Record<string, unknown>[] = [];
    const firstResponse = Promise.withResolvers<void>();
    const proactiveResponse = Promise.withResolvers<void>();
    const announcementSpoken = Promise.withResolvers<void>();
    const completionContextReceived = Promise.withResolvers<void>();
    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const upgraded = bunServer.upgrade(request, { data: { authenticated: true } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open(socket) {
          client = socket;
        },
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          if (event["type"] === "session.update") {
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_completion" } }));
          } else if (event["type"] === "conversation.item.create") {
            injectedItems.push(event);
            if (JSON.stringify(event).includes("Proactively tell the user now")) completionContextReceived.resolve();
          } else if (event["type"] === "response.create") {
            responseCreates += 1;
            if (responseCreates === 1) {
              firstResponse.resolve();
            } else {
              proactiveResponse.resolve();
              socket.send(
                JSON.stringify({
                  type: "response.output_audio_transcript.done",
                  transcript: "The coding task finished and all checks passed.",
                }),
              );
              socket.send(JSON.stringify({ type: "response.done", response: { status: "completed", output: [] } }));
            }
          }
        },
      },
    });
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({ seq: 7, activeTaskId: null, queue: [], tasks: [], runs: [], confirmations: [] }),
      executeCommand: async () => {
        throw new Error("completion announcements must not execute another command");
      },
      emit: (type, payload) => {
        if (type === "voice.transcript.assistant" && isRecord(payload)) announcementSpoken.resolve();
      },
      emitAudio: () => {},
    });

    await bridge.connect();
    bridge.sendText("Tell me something while coding finishes");
    await firstResponse.promise;
    const taskId = Bun.randomUUIDv7();
    const runId = Bun.randomUUIDv7();
    const eventId = Bun.randomUUIDv7();
    const completion: DomainEvent<"task.completed"> = {
      version: 1,
      id: eventId,
      seq: 7,
      at: new Date().toISOString(),
      type: "task.completed",
      actor: "controller",
      taskId,
      runId,
      correlationId: eventId,
      payload: {
        runId,
        summary: "Implemented the requested change; all checks passed.",
        evidenceIds: [],
      },
    };

    bridge.handleTaskEvents([completion]);
    await completionContextReceived.promise;
    expect(responseCreates).toBe(1);
    expect(injectedItems.some((item) => JSON.stringify(item).includes("Proactively tell the user now"))).toBe(true);
    expect(injectedItems.some((item) => JSON.stringify(item).includes("all checks passed"))).toBe(true);
    client?.send(JSON.stringify({ type: "response.done", response: { status: "completed", output: [] } }));
    await proactiveResponse.promise;
    await announcementSpoken.promise;
    expect(responseCreates).toBe(2);
    await bridge.disconnect();
  });

  test("proactively announces an explicit coder question", async () => {
    const questionInjected = Promise.withResolvers<void>();
    const responseRequested = Promise.withResolvers<void>();
    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const upgraded = bunServer.upgrade(request, { data: { authenticated: true } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open() {},
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          if (event["type"] === "session.update") {
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_question" } }));
          } else if (
            event["type"] === "conversation.item.create" &&
            JSON.stringify(event).includes("Which deployment target should I use?")
          ) {
            questionInjected.resolve();
          } else if (event["type"] === "response.create") {
            responseRequested.resolve();
          }
        },
      },
    });
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({ seq: 0, activeTaskId: null, queue: [], tasks: [], runs: [], confirmations: [] }),
      executeCommand: async () => {
        throw new Error("question announcements must not execute a command");
      },
      emit: () => {},
      emitAudio: () => {},
    });

    await bridge.connect();
    const taskId = Bun.randomUUIDv7();
    const runId = Bun.randomUUIDv7();
    const eventId = Bun.randomUUIDv7();
    bridge.handleTaskEvents([{
      version: 1,
      id: eventId,
      seq: 1,
      at: new Date().toISOString(),
      type: "task.questionAsked",
      actor: "coder",
      taskId,
      runId,
      correlationId: eventId,
      payload: {
        questionId: Bun.randomUUIDv7(),
        runId,
        revision: 1,
        question: "Which deployment target should I use?",
      },
    }]);

    await Promise.all([questionInjected.promise, responseRequested.promise]);
    await bridge.disconnect();
  });

  test("announces an already-open coder question when voice reconnects", async () => {
    const questionInjected = Promise.withResolvers<void>();
    const responseRequested = Promise.withResolvers<void>();
    const taskId = Bun.randomUUIDv7();
    const runId = Bun.randomUUIDv7();
    const questionId = Bun.randomUUIDv7();
    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const upgraded = bunServer.upgrade(request, { data: { authenticated: true } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open() {},
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          if (event["type"] === "session.update") {
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_open_question" } }));
          } else if (
            event["type"] === "conversation.item.create" &&
            JSON.stringify(event).includes("Can I overwrite the generated fixture?")
          ) {
            questionInjected.resolve();
          } else if (event["type"] === "response.create") {
            responseRequested.resolve();
          }
        },
      },
    });
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({
        seq: 1,
        activeTaskId: taskId,
        queue: [],
        tasks: [],
        runs: [],
        confirmations: [],
        questions: [{
          id: questionId,
          taskId,
          taskRevision: 1,
          runId,
          question: "Can I overwrite the generated fixture?",
          state: "open",
          resolution: null,
          answer: null,
          askedAt: new Date(0).toISOString(),
          resolvedAt: null,
        }],
      }),
      executeCommand: async () => {
        throw new Error("reconnecting an open question must not execute a command");
      },
      emit: () => {},
      emitAudio: () => {},
    });

    await bridge.connect();
    await Promise.all([questionInjected.promise, responseRequested.promise]);
    await bridge.disconnect();
  });

  test("expands the orb through a silent realtime tool", async () => {
    let responseCreates = 0;
    const expanded = Promise.withResolvers<void>();
    const followUpRequested = Promise.withResolvers<void>();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const upgraded = bunServer.upgrade(request, { data: { authenticated: true } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open() {},
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          if (event["type"] === "session.update") {
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_overlay" } }));
          } else if (event["type"] === "response.create") {
            responseCreates += 1;
            if (responseCreates === 1) {
              socket.send(
                JSON.stringify({
                  type: "response.done",
                  response: {
                    status: "completed",
                    output: [{
                      type: "function_call",
                      call_id: "overlay_call",
                      name: "set_overlay",
                      arguments: JSON.stringify({ action: "expand" }),
                    }],
                  },
                }),
              );
            } else {
              followUpRequested.resolve();
            }
          }
        },
      },
    });
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({ seq: 0, activeTaskId: null, queue: [], tasks: [], runs: [], confirmations: [] }),
      executeCommand: async () => {
        throw new Error("overlay controls must not execute a coding command");
      },
      emit: (type, payload) => {
        emitted.push({ type, payload });
        if (type === "ui.overlay") expanded.resolve();
      },
      emitAudio: () => {},
    });

    await bridge.connect();
    bridge.sendText("Expand");
    await expanded.promise;
    await followUpRequested.promise;

    expect(emitted).toContainEqual({ type: "ui.overlay", payload: { expanded: true } });
    expect(responseCreates).toBe(2);
    await bridge.disconnect();
  });

  test("runs an allowlisted computer action and then mutes without a spoken follow-up", async () => {
    let responseCreates = 0;
    let controlledAction = "";
    const computerControlled = Promise.withResolvers<void>();
    const muted = Promise.withResolvers<void>();
    const idle = Promise.withResolvers<void>();
    const emitted: Array<{ type: string; payload: unknown }> = [];
    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const upgraded = bunServer.upgrade(request, { data: { authenticated: true } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open() {},
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          if (event["type"] === "session.update") {
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_controls" } }));
          } else if (event["type"] === "response.create") {
            responseCreates += 1;
            if (responseCreates === 1) {
              socket.send(
                JSON.stringify({
                  type: "response.done",
                  response: {
                    status: "completed",
                    output: [{
                      type: "function_call",
                      call_id: "computer_call",
                      name: "control_computer",
                      arguments: JSON.stringify({ action: "open_system_settings" }),
                    }],
                  },
                }),
              );
            } else if (responseCreates === 2) {
              socket.send(
                JSON.stringify({
                  type: "response.done",
                  response: {
                    status: "completed",
                    output: [{
                      type: "function_call",
                      call_id: "mute_call",
                      name: "mute_mamachi",
                      arguments: "{}",
                    }],
                  },
                }),
              );
            }
          }
        },
      },
    });
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({ seq: 0, activeTaskId: null, queue: [], tasks: [], runs: [], confirmations: [] }),
      executeCommand: async () => {
        throw new Error("computer and app controls must not execute a coding command");
      },
      controlComputer: async (request) => {
        controlledAction = request.action;
        return { status: "ok", action: request.action, target: "System Settings" };
      },
      emit: (type, payload) => {
        emitted.push({ type, payload });
        if (type === "computer.control") computerControlled.resolve();
        if (type === "ui.mute") muted.resolve();
        if (type === "voice.state" && isRecord(payload) && payload["state"] === "idle") idle.resolve();
      },
      emitAudio: () => {},
    });

    await bridge.connect();
    bridge.sendText("Open System Settings, then mute.");
    await computerControlled.promise;
    await muted.promise;
    await idle.promise;
    await Bun.sleep(10);

    expect(controlledAction).toBe("open_system_settings");
    expect(emitted).toContainEqual({
      type: "computer.control",
      payload: { status: "ok", action: "open_system_settings", target: "System Settings" },
    });
    expect(emitted).toContainEqual({ type: "ui.mute", payload: {} });
    expect(responseCreates).toBe(2);
    await bridge.disconnect();
  });

  test("queues briefs while disengaged in voice mode and flushes them exactly once on re-engage", async () => {
    let responseCreates = 0;
    const injectedItems: Record<string, unknown>[] = [];
    const emitted: Array<{ type: string; payload: unknown }> = [];
    const flushRequested = Promise.withResolvers<void>();
    const barriers = new Map<string, () => void>();
    server = Bun.serve<MockClientData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, bunServer) {
        const upgraded = bunServer.upgrade(request, { data: { authenticated: true } });
        return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
      },
      websocket: {
        open() {},
        message(socket, message) {
          if (typeof message !== "string") return;
          const event = JSON.parse(message) as Record<string, unknown>;
          if (event["type"] === "session.update") {
            socket.send(JSON.stringify({ type: "session.updated", session: { id: "session_briefs" } }));
          } else if (event["type"] === "conversation.item.create") {
            injectedItems.push(event);
            const serialized = JSON.stringify(event);
            for (const [marker, release] of barriers) {
              if (serialized.includes(marker)) {
                barriers.delete(marker);
                release();
              }
            }
          } else if (event["type"] === "response.create") {
            responseCreates += 1;
            flushRequested.resolve();
          }
        },
      },
    });
    const bridge = new RealtimeBridge({
      apiKey: "test-realtime-key",
      endpoint: `ws://127.0.0.1:${server.port}/realtime`,
      getWorkspace: () => "/tmp/mamachi-workspace",
      getSnapshot: () => ({ seq: 0, activeTaskId: null, queue: [], tasks: [], runs: [], confirmations: [] }),
      executeCommand: async () => {
        throw new Error("queued briefs must not execute a coding command");
      },
      emit: (type, payload) => {
        emitted.push({ type, payload });
      },
      emitAudio: () => {},
      initiallyEngaged: false,
    });

    await bridge.connect();

    // A captured-context injection is a wire barrier: once its item arrives,
    // every frame the bridge sent before it has arrived too.
    const barrier = async (marker: string): Promise<void> => {
      const { promise, resolve } = Promise.withResolvers<void>();
      barriers.set(marker, resolve);
      bridge.captureContext({
        id: marker,
        kind: "selection",
        workspace: "/tmp/mamachi-workspace",
        summary: `barrier ${marker}`,
        payload: { marker },
        createdAt: new Date().toISOString(),
      });
      await promise;
    };
    const flushItems = () =>
      injectedItems.filter((item) => JSON.stringify(item).includes("resumed after sleeping"));

    const taskA = Bun.randomUUIDv7();
    const taskB = Bun.randomUUIDv7();
    const makeEvent = <T extends DomainEvent["type"]>(
      type: T,
      taskId: string,
      payload: unknown,
    ): DomainEvent => {
      const id = Bun.randomUUIDv7();
      return {
        version: 1,
        id,
        seq: 1,
        at: new Date().toISOString(),
        type,
        actor: "controller",
        taskId,
        runId: Bun.randomUUIDv7(),
        correlationId: id,
        payload,
      } as DomainEvent;
    };

    bridge.handleTaskEvents([
      makeEvent("task.completed", taskA, { runId: Bun.randomUUIDv7(), summary: "First task done.", evidenceIds: [] }),
    ]);
    bridge.handleTaskEvents([
      makeEvent("task.failed", taskB, { runId: Bun.randomUUIDv7(), error: "Second task hit a build failure." }),
      makeEvent("task.awaitingUser", taskA, { runId: Bun.randomUUIDv7(), question: "Which branch should I target?" }),
    ]);
    await barrier("barrier_disengaged");

    expect(responseCreates).toBe(0);
    expect(flushItems()).toHaveLength(0);
    const queued = emitted.filter((entry) => entry.type === "brief.queued");
    expect(queued.map((entry) => entry.payload)).toEqual([
      { taskId: taskA, kind: "completed", summary: "First task done.", pending: 1 },
      { taskId: taskB, kind: "failed", summary: "Second task hit a build failure.", pending: 2 },
      { taskId: taskA, kind: "awaiting_user", summary: "Which branch should I target?", pending: 2 },
    ]);

    bridge.setEngaged(true);
    await flushRequested.promise;

    expect(responseCreates).toBe(1);
    expect(flushItems()).toHaveLength(1);
    const flushed = JSON.stringify(flushItems()[0]);
    expect(flushed).toContain("resumed after sleeping");
    expect(flushed).toContain("Which branch should I target?");
    expect(flushed).toContain("Second task hit a build failure.");
    expect(flushed).not.toContain("First task done.");
    expect(emitted).toContainEqual({ type: "brief.delivered", payload: { count: 2 } });

    bridge.setEngaged(false);
    bridge.setEngaged(true);
    await barrier("barrier_reengaged");
    expect(responseCreates).toBe(1);
    expect(flushItems()).toHaveLength(1);
    await bridge.disconnect();
  });
});

test("section 16 handlers enforce correlation, ownership, revisions, queue commands, memory, and availability", async () => {
  const commands: Array<Record<string, unknown>> = [];
  const pendingCalls = new Map<string, (value: Record<string, unknown>) => void>();
  let client: ServerWebSocket<MockClientData> | undefined;
  let suppressAutomaticResponse = false;
  const connected = Promise.withResolvers<void>();
  const handlerServer = Bun.serve<MockClientData>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, bunServer) {
      const upgraded = bunServer.upgrade(request, { data: { authenticated: true } });
      return upgraded ? undefined : new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      open(socket) {
        client = socket;
        connected.resolve();
      },
      message(socket, message) {
        if (typeof message !== "string") return;
        const event = JSON.parse(message) as Record<string, unknown>;
        if (event["type"] === "session.update") {
          socket.send(JSON.stringify({ type: "session.updated", session: { id: "section-16" } }));
        } else if (event["type"] === "conversation.item.create") {
          const item = event["item"];
          if (isRecord(item) && item["type"] === "function_call_output" && typeof item["call_id"] === "string") {
            const output = typeof item["output"] === "string" ? JSON.parse(item["output"]) as Record<string, unknown> : {};
            pendingCalls.get(item["call_id"])?.(output);
            pendingCalls.delete(item["call_id"]);
          }
        } else if (event["type"] === "response.create" && !suppressAutomaticResponse) {
          queueMicrotask(() => socket.send(JSON.stringify({
            type: "response.done",
            response: { status: "completed", output: [] },
          })));
        }
      },
    },
  });

  const task: TaskRecord = {
    id: "task-1",
    repositoryId: "/tmp/mamachi-workspace",
    state: "paused",
    spec: {
      repositoryId: "/tmp/mamachi-workspace",
      objective: "Implement the original behavior",
      acceptanceCriteria: ["Original behavior works"],
      constraints: ["Keep compatibility"],
      attachmentIds: [],
      codingProfileId: null,
    },
    revision: 1,
    activeRunId: "run-1",
    runIds: ["run-1"],
    evidenceIds: ["artifact-1"],
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    terminalSummary: null,
    workspaceConflict: null,
    pendingQuestion: "Which API?",
    specHistory: [],
  };
  const snapshot: ControllerSnapshot = {
    seq: 1,
    activeTaskId: task.id,
    queue: ["queued-1", task.id],
    tasks: [task],
    runs: [],
    confirmations: [{
      id: "confirmation-1",
      taskId: task.id,
      taskRevision: 1,
      category: "external_side_effect",
      summary: "Publish",
      effectFingerprint: "fingerprint",
      toolName: "bash",
      state: "pending",
      createdAt: "2026-07-23T00:00:00.000Z",
      resolvedAt: null,
      consumedAt: null,
    }],
    questions: [{
      id: "question-1",
      taskId: task.id,
      taskRevision: 1,
      runId: "run-1",
      question: "Which API?",
      state: "open",
      resolution: null,
      answer: null,
      askedAt: "2026-07-23T00:00:00.000Z",
      resolvedAt: null,
    }],
  };
  let coderAvailable = true;
  const computerCalls: string[] = [];
  let computerConfirmationMode: ComputerConfirmationMode = "sensitive";
  const memories = new Set<string>();
  const bridge = new RealtimeBridge({
    apiKey: "section-16-key",
    endpoint: `ws://127.0.0.1:${handlerServer.port}/realtime`,
    getWorkspace: () => "/tmp/mamachi-workspace",
    getAvailableWorkspaces: () => ["/tmp/mamachi-workspace", "/tmp/other"],
    getCodingProfiles: () => ["auto", "fast"],
    getComputerCapabilities: () => ["shell"],
    getComputerConfirmationMode: () => computerConfirmationMode,
    getSnapshot: () => snapshot,
    getTaskFacts: () => ({
      taskId: task.id,
      phase: "paused",
      progress: 0.5,
      currentStep: "Reviewing changes",
      implementationState: "changed",
      verificationState: "passed",
      changedFiles: ["src/a.ts"],
      verificationSummaries: ["focused tests passed"],
      recentActivity: [],
      evidenceIds: ["artifact-1"],
      observerInterpretation: null,
      groundedAt: "2026-07-23T00:00:00.000Z",
      groundedAtSeq: 1,
    }),
    getTaskArtifact: (taskId, artifactId) => taskId === task.id && artifactId === "artifact-1" ? {
      id: artifactId,
      ordinal: 1,
      taskId,
      runId: "run-1",
      toolCallId: "tool-1",
      toolName: "bash",
      kind: "verification",
      summary: "focused verification",
      successful: true,
      payload: { resultExcerpt: "x".repeat(7_000), rawArguments: "must not escape", changedFiles: ["src/a.ts"] },
      createdAt: "2026-07-23T00:00:00.000Z",
    } : null,
    executeCommand: async (command): Promise<ActionResult> => {
      const record = command as Record<string, unknown>;
      commands.push(record);
      if (record["type"] === "task.revise") {
        const payload = record["payload"] as { spec: TaskRecord["spec"] };
        task.spec = payload.spec;
        task.revision += 1;
      }
      return { status: "accepted", eventId: `event-${commands.length}`, taskId: task.id };
    },
    captureEditorContext: async () => ({
      artifacts: [{ id: "context-1", kind: "selection", summary: "Explicit selection" }],
      errors: [{ kind: "diagnostics", error: "No diagnostics are available" }],
    }),
    askCoder: async () => coderAvailable,
    rememberFact: (scope, projectId, fact) => {
      const id = `memory-${memories.size + 1}`;
      memories.add(id);
      return { id, scope, projectId, fact };
    },
    forgetFact: (memoryId) => memories.delete(memoryId),
    controlComputer: async (request) => {
      computerCalls.push(request.command ?? request.action);
      return { status: "ok", action: request.action, target: "shell", output: "approved" };
    },
    emit: () => {},
    emitAudio: () => {},
  });
  await bridge.connect();
  await connected.promise;

  let callOrdinal = 0;
  async function invoke(name: string, argumentsValue: Record<string, unknown>): Promise<Record<string, unknown>> {
    const callId = `section-call-${++callOrdinal}`;
    const result = new Promise<Record<string, unknown>>((resolve) => pendingCalls.set(callId, resolve));
    client?.send(JSON.stringify({
      type: "response.done",
      response: {
        status: "completed",
        output: [{ type: "function_call", call_id: callId, name, arguments: JSON.stringify(argumentsValue) }],
      },
    }));
    const output = await result;
    return output;
  }

  expect(await invoke("get_workspace", { view: "available" })).toEqual({
    repositories: ["/tmp/mamachi-workspace", "/tmp/other"],
  });
  expect(await invoke("list_coding_profiles", {})).toEqual({ profiles: ["auto", "fast"] });
  expect(await invoke("list_coding_profiles", { extra: true })).toMatchObject({ status: "rejected" });
  expect(await invoke("capture_editor_context", { kinds: ["selection", "diagnostics"] })).toMatchObject({
    status: "accepted",
    artifactIds: ["context-1"],
    errors: [{ kind: "diagnostics", error: "No diagnostics are available" }],
  });
  expect(await invoke("get_task_status", { taskId: task.id, view: "verification" })).toMatchObject({
    verificationState: "passed",
    verificationSummaries: ["focused tests passed"],
  });
  const excerpt = await invoke("get_task_artifact", {
    taskId: task.id,
    artifactId: "artifact-1",
    view: "bounded_excerpt",
  });
  expect((excerpt["excerpt"] as string).length).toBe(6_000);
  expect(excerpt["rawArguments"]).toBeUndefined();
  expect(await invoke("get_task_artifact", {
    taskId: "other-task",
    artifactId: "artifact-1",
    view: "summary",
  })).toMatchObject({ status: "rejected", code: "artifact_not_found" });
  suppressAutomaticResponse = true;
  expect(await invoke("answer_task_question", { requestId: "question-1", answer: "Use v2" })).toMatchObject({
    status: "rejected",
    code: "user_answer_required",
  });
  bridge.sendText("Use v2");
  expect(await invoke("answer_task_question", { requestId: "stale-question", answer: "Use v2" })).toMatchObject({
    status: "rejected",
    code: "question_not_open",
  });
  expect(await invoke("answer_task_question", { requestId: "question-1", answer: "Use version 2" })).toMatchObject({
    status: "rejected",
    code: "answer_not_verbatim",
  });
  await invoke("answer_task_question", { requestId: "question-1", answer: "Use v2" });
  expect(commands.at(-1)).toMatchObject({
    type: "task.answerQuestion",
    expectedRevision: 1,
    payload: { taskId: task.id, questionId: "question-1", answer: "Use v2" },
  });
  expect(await invoke("ask_coder", { taskId: task.id, question: "What changed?" })).toMatchObject({
    status: "accepted",
    taskId: task.id,
  });
  coderAvailable = false;
  expect(await invoke("ask_coder", { taskId: task.id, question: "Are you there?" })).toMatchObject({
    status: "rejected",
    code: "coder_unavailable",
  });
  await invoke("propose_task_change", {
    taskId: task.id,
    change: "Also support JSON",
    desiredOutcome: "JSON inputs pass",
    addedConstraints: ["Do not add dependencies"],
  });
  expect(commands.slice(-2).map((command) => command["type"])).toEqual(["task.revise", "task.resume"]);
  expect(task.spec.acceptanceCriteria).toContain("JSON inputs pass");
  expect(task.spec.constraints).toContain("Requested change: Also support JSON");
  expect(task.spec.constraints).toContain("Do not add dependencies");
  await invoke("control_task", { taskId: task.id, action: "cancel" });
  expect(commands.at(-1)).toMatchObject({ type: "task.cancel", expectedRevision: 2 });
  await invoke("manage_queue", { taskId: "queued-1", operation: "move_first", anchorTaskId: null });
  expect(commands.at(-1)).toMatchObject({
    type: "queue.move",
    expectedRevision: null,
    payload: { taskId: "queued-1", operation: "move_first", anchorTaskId: null },
  });
  await invoke("resolve_confirmation", { confirmationId: "confirmation-1", decision: "approve" });
  expect(commands.at(-1)).toMatchObject({ type: "approval.resolve", expectedRevision: 2 });
  const remembered = await invoke("remember_fact", {
    scope: "project",
    projectId: "/tmp/mamachi-workspace",
    fact: "Use Bun tests",
  });
  expect(remembered).toMatchObject({ status: "accepted", memoryId: "memory-1" });
  expect(await invoke("forget_fact", { memoryId: "memory-1" })).toMatchObject({ status: "accepted" });
  expect(await invoke("forget_fact", { memoryId: "memory-1" })).toMatchObject({
    status: "rejected",
    code: "memory_not_found",
  });
  const pendingComputerAction = await invoke("control_computer", {
    action: "run_shell_command",
    command: "printf approved",
  });
  expect(pendingComputerAction).toMatchObject({
    status: "confirmation_required",
    action: "run_shell_command",
  });
  expect(computerCalls).toEqual([]);
  expect(await invoke("resolve_computer_control", {
    requestId: pendingComputerAction["requestId"],
    decision: "approve",
  })).toMatchObject({
    status: "ok",
    action: "run_shell_command",
    output: "approved",
  });
  expect(computerCalls).toEqual(["printf approved"]);
  computerConfirmationMode = "never";
  expect(await invoke("control_computer", {
    action: "run_shell_command",
    command: "printf direct",
  })).toMatchObject({
    status: "ok",
    action: "run_shell_command",
  });
  expect(computerCalls).toEqual(["printf approved", "printf direct"]);
  await bridge.disconnect();
  handlerServer.stop(true);
});
