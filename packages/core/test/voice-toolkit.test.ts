import { describe, expect, setSystemTime, test } from "bun:test";
import type { ActionResult } from "@mamachi/protocol";
import type { ControllerSnapshot, TaskRecord } from "../src/domain.ts";
import type { CapturedContext } from "../src/artifact-store.ts";
import type { ComputerControlResult } from "../src/computer-control.ts";
import type { TaskFacts } from "../src/fact-projector.ts";
import type { VoiceToolHost } from "../src/voice-bridge.ts";
import { createVoiceToolkit } from "../src/voice-toolkit.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected an object result");
  return value;
}

function stringField(value: unknown, key: string): string {
  const field = asRecord(value)[key];
  if (typeof field !== "string") throw new Error(`expected string field ${key}`);
  return field;
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    repositoryId: "/repo",
    state: "running",
    spec: {
      repositoryId: "/repo",
      objective: "Fix the flaky login test",
      acceptanceCriteria: ["Login test passes ten times in a row"],
      constraints: ["No production config changes"],
      attachmentIds: [],
      codingProfileId: null,
    },
    revision: 3,
    activeRunId: null,
    runIds: [],
    evidenceIds: [],
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    terminalSummary: null,
    workspaceConflict: null,
    pendingQuestion: null,
    specHistory: [],
    ...overrides,
  };
}

function makeSnapshot(tasks: TaskRecord[] = [makeTask()]): ControllerSnapshot {
  return {
    seq: 1,
    activeTaskId: tasks[0]?.id ?? null,
    queue: tasks.map((task) => task.id),
    tasks,
    runs: [],
    confirmations: [],
    questions: [],
  };
}

function makeFacts(taskId: string): TaskFacts {
  return {
    taskId,
    phase: "implementation",
    progress: 0.5,
    currentStep: "Editing auth.ts",
    implementationState: "changed",
    verificationState: "pending",
    changedFiles: ["src/auth.ts"],
    verificationSummaries: [],
    recentActivity: [],
    evidenceIds: [],
    observerInterpretation: null,
    groundedAt: "2026-07-23T00:00:00.000Z",
    groundedAtSeq: 1,
  };
}

interface HostHarness {
  host: VoiceToolHost;
  emitted: Array<{ type: string; payload: unknown }>;
  commands: Array<Record<string, unknown>>;
  sleepCalls: { count: number };
  attachedImages: Array<{ note: string; dataUrl: string }>;
}

function makeHost(overrides: Partial<VoiceToolHost> = {}): HostHarness {
  const emitted: Array<{ type: string; payload: unknown }> = [];
  const commands: Array<Record<string, unknown>> = [];
  const sleepCalls = { count: 0 };
  const attachedImages: Array<{ note: string; dataUrl: string }> = [];
  const host: VoiceToolHost = {
    getWorkspace: () => "/repo",
    getSnapshot: () => makeSnapshot(),
    executeCommand: async (command) => {
      commands.push(asRecord(command));
      return { status: "accepted", eventId: Bun.randomUUIDv7() } satisfies ActionResult;
    },
    emit: (type, payload) => {
      emitted.push({ type, payload });
    },
    isEngaged: () => true,
    getResponseMode: () => "voice",
    getCurrentUserInput: () => null,
    sleepMicrophone: () => {
      sleepCalls.count += 1;
    },
    attachUserImage: (note, dataUrl) => {
      attachedImages.push({ note, dataUrl });
    },
    ...overrides,
  };
  return { host, emitted, commands, sleepCalls, attachedImages };
}

function makeContext(id: string): CapturedContext {
  return {
    id,
    kind: "selection",
    workspace: "/repo",
    summary: "selected auth handler",
    payload: { text: "function login() {}" },
    createdAt: "2026-07-23T00:00:00.000Z",
  };
}

describe("createVoiceToolkit", () => {
  test("exposes the full PRD-16 tool surface and grounded instructions", () => {
    const { host } = makeHost({
      getComputerCapabilities: () => ["applications", "shell"],
      getComputerConfirmationMode: () => "always",
    });
    const toolkit = createVoiceToolkit(host);
    expect(toolkit.tools().map((tool) => tool.name)).toEqual([
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
    expect(toolkit.tools().every((tool) => tool.type === "function" && tool.parameters["type"] === "object")).toBe(true);
    const instructions = toolkit.instructions();
    expect(instructions).toContain("Active: /repo");
    expect(instructions).toContain("Available for submit_task's repositoryId: /repo");
    expect(instructions).toContain("Enabled capability categories: applications, shell.");
    expect(instructions).toContain("Confirmation policy: always.");
    toolkit.dispose();
  });

  test("lists every registered repository in the instructions, not just the active one", () => {
    const { host } = makeHost({
      getAvailableWorkspaces: () => ["/repo", "/repo-two", "/repo-three"],
    });
    const toolkit = createVoiceToolkit(host);
    const instructions = toolkit.instructions();
    expect(instructions).toContain("Active: /repo");
    expect(instructions).toContain("Available for submit_task's repositoryId: /repo, /repo-two, /repo-three");
    toolkit.dispose();
  });

  test("forwards coder answers only from exact current-turn user text", async () => {
    let currentUserInput: string | null = null;
    const snapshot: ControllerSnapshot = {
      ...makeSnapshot(),
      questions: [{
        id: "question-1",
        taskId: "task-1",
        taskRevision: 3,
        runId: "run-1",
        question: "Which API version should I use?",
        state: "open",
        resolution: null,
        answer: null,
        askedAt: new Date(0).toISOString(),
        resolvedAt: null,
      }],
    };
    const { host, commands } = makeHost({
      getSnapshot: () => snapshot,
      getCurrentUserInput: () => currentUserInput,
    });
    const toolkit = createVoiceToolkit(host);
    expect(await toolkit.execute("answer_task_question", {
      requestId: "question-1",
      answer: "Use v2",
    })).toMatchObject({ status: "rejected", code: "user_answer_required" });
    currentUserInput = "Use v2";
    expect(await toolkit.execute("answer_task_question", {
      requestId: "question-1",
      answer: "Use version 2",
    })).toMatchObject({ status: "rejected", code: "answer_not_verbatim" });
    expect(await toolkit.execute("answer_task_question", {
      requestId: "question-1",
      answer: "Use v2",
    })).toMatchObject({ status: "accepted" });
    expect(commands.at(-1)).toMatchObject({
      type: "task.answerQuestion",
      payload: { taskId: "task-1", questionId: "question-1", answer: "Use v2" },
    });
    toolkit.dispose();
  });

  test("answers task status views from the snapshot, facts, and noted harness activity", async () => {
    const { host } = makeHost({ getTaskFacts: makeFacts });
    const toolkit = createVoiceToolkit(host);
    toolkit.noteHarnessEvent("coder.tool", { taskId: "task-1", toolName: "bash" });

    expect(await toolkit.execute("get_task_status", { taskId: "task-1", view: "brief" })).toEqual({
      id: "task-1",
      state: "running",
      revision: 3,
      objective: "Fix the flaky login test",
      repositoryId: "/repo",
      summary: null,
      queuePosition: 0,
    });

    // taskId null resolves the active task, as in the realtime executor.
    const step = asRecord(await toolkit.execute("get_task_status", { taskId: null, view: "current_step" }));
    expect(step["currentStep"]).toBe("Editing auth.ts");
    expect(stringField(step["recentActivity"], "summary")).toBe("coder.tool: bash");

    expect(await toolkit.execute("get_task_status", { taskId: "missing", view: "brief" })).toEqual({
      status: "idle",
      queue: ["task-1"],
    });
    toolkit.dispose();
  });

  test("get_task_status with no taskId resolves to the snapshot's reported active task, not any client-side focus", async () => {
    // With two tasks concurrently active (multi-repo concurrency), the toolkit has no
    // notion of the Swift app's client-local tap-to-focus choice -- see
    // AppModel.focusTask's doc comment in apps/macos. It only ever reads
    // `snapshot.activeTaskId`, which is the daemon's derived "oldest started" active
    // task (domain.ts snapshotState: `activeTaskIds[0]`). This test pins that exact
    // fallback so a change to #resolveTask's null-taskId behavior is caught here
    // rather than discovered as a live UX bug.
    const taskA = makeTask({ id: "task-a", state: "running" });
    const taskB = makeTask({ id: "task-b", state: "running" });
    const snapshot: ControllerSnapshot = {
      seq: 1,
      activeTaskId: "task-a",
      activeTaskIds: ["task-a", "task-b"],
      queue: [],
      tasks: [taskA, taskB],
      runs: [],
      confirmations: [],
      questions: [],
    };
    const { host } = makeHost({ getSnapshot: () => snapshot });
    const toolkit = createVoiceToolkit(host);
    const resolved = asRecord(await toolkit.execute("get_task_status", { taskId: null, view: "brief" }));
    expect(resolved["id"]).toBe("task-a");
    toolkit.dispose();

    // Prove this actually tracks `activeTaskId` and isn't coincidentally "the first
    // or last task in the array": swap which one the snapshot calls active.
    const swappedSnapshot: ControllerSnapshot = { ...snapshot, activeTaskId: "task-b" };
    const { host: swappedHost } = makeHost({ getSnapshot: () => swappedSnapshot });
    const swappedToolkit = createVoiceToolkit(swappedHost);
    const resolvedAfterSwap = asRecord(await swappedToolkit.execute("get_task_status", { taskId: null, view: "brief" }));
    expect(resolvedAfterSwap["id"]).toBe("task-b");
    swappedToolkit.dispose();
  });

  test("get_workspace reports every registered repository, deduplicated, not just the active one", async () => {
    const { host } = makeHost({
      getAvailableWorkspaces: () => ["/repo", "/repo-two", "/repo", "/repo-two"],
    });
    const toolkit = createVoiceToolkit(host);
    expect(await toolkit.execute("get_workspace", { view: "active" })).toEqual({
      repositoryId: "/repo",
      path: "/repo",
    });
    expect(await toolkit.execute("get_workspace", { view: "available" })).toEqual({
      repositories: ["/repo", "/repo-two"],
    });
    toolkit.dispose();
  });

  test("enforces the exact realtime validation error messages", async () => {
    const toolkit = createVoiceToolkit(makeHost().host);
    await expect(toolkit.execute("get_task_status", "brief")).rejects.toThrow("get_task_status arguments must be an object");
    await expect(toolkit.execute("wait_for_user", { stray: 1 })).rejects.toThrow("wait_for_user does not accept stray");
    await expect(toolkit.execute("get_workspace", { view: "all" })).rejects.toThrow("view must be active or available");
    await expect(toolkit.execute("ask_coder", { taskId: "", question: "q" })).rejects.toThrow(
      "taskId must be a non-empty string",
    );
    await expect(
      toolkit.execute("submit_task", {
        repositoryId: "/repo",
        objective: "x",
        acceptanceCriteria: [],
        constraints: [],
        attachmentIds: [],
        codingProfileId: null,
      }),
    ).rejects.toThrow("acceptanceCriteria must contain at least one item");
    await expect(
      toolkit.execute("submit_task", {
        repositoryId: "/repo",
        objective: "x",
        acceptanceCriteria: [1],
        constraints: [],
        attachmentIds: [],
        codingProfileId: null,
      }),
    ).rejects.toThrow("acceptanceCriteria must be an array of non-empty strings");
    await expect(toolkit.execute("get_task_status", { taskId: 42, view: "brief" })).rejects.toThrow(
      "taskId must be a task ID or null",
    );
    await expect(toolkit.execute("get_task_status", { taskId: null, view: "bogus" })).rejects.toThrow(
      "get_task_status view is invalid",
    );
    await expect(toolkit.execute("resolve_computer_control", { requestId: "r", decision: "maybe" })).rejects.toThrow(
      "decision must be approve or reject",
    );
    await expect(toolkit.execute("manage_queue", { taskId: "task-1", operation: "shuffle", anchorTaskId: null })).rejects.toThrow(
      "manage_queue operation is invalid",
    );
    await expect(toolkit.execute("control_computer", { action: "levitate" })).rejects.toThrow(
      "control_computer action is invalid",
    );
    await expect(toolkit.execute("bogus_tool", {})).rejects.toThrow("Unknown voice tool: bogus_tool");
    toolkit.dispose();
  });

  test("wait_for_user returns a silent waiting result for the bridge", async () => {
    const toolkit = createVoiceToolkit(makeHost().host);
    expect(await toolkit.execute("wait_for_user", {})).toEqual({ status: "waiting" });
    toolkit.dispose();
  });

  test("requires confirmation for sensitive computer actions and runs on approval", async () => {
    const controlled: string[] = [];
    const { host, emitted } = makeHost({
      getComputerConfirmationMode: () => "sensitive",
      controlComputer: async (request) => {
        controlled.push(request.action);
        return { status: "ok", action: request.action, target: "Safari" } satisfies ComputerControlResult;
      },
    });
    const toolkit = createVoiceToolkit(host);

    // Non-sensitive action under "sensitive" mode runs immediately.
    const direct = asRecord(await toolkit.execute("control_computer", { action: "open_application", application: "Safari" }));
    expect(direct["status"]).toBe("ok");
    expect(controlled).toEqual(["open_application"]);
    expect(emitted.filter((event) => event.type === "computer.control")).toHaveLength(1);

    // Sensitive action parks a pending confirmation instead of running.
    const pending = asRecord(await toolkit.execute("control_computer", { action: "quit_application", application: "Safari" }));
    expect(pending["status"]).toBe("confirmation_required");
    expect(pending["summary"]).toBe("quit_application on Safari");
    const requestId = stringField(pending, "requestId");
    expect(requestId.length).toBeGreaterThan(0);
    expect(emitted.find((event) => event.type === "computer.confirmation_required")?.payload).toEqual(pending);
    expect(controlled).toEqual(["open_application"]);

    // Unknown request id resolves as expired.
    expect(await toolkit.execute("resolve_computer_control", { requestId: "nope", decision: "approve" })).toEqual({
      status: "rejected",
      code: "computer_confirmation_expired",
      explanation: "That computer-control request is no longer pending",
    });

    // Approval runs the parked request exactly once.
    expect(await toolkit.execute("resolve_computer_control", { requestId, decision: "approve" })).toEqual({
      status: "ok",
      action: "quit_application",
      target: "Safari",
    });
    expect(controlled).toEqual(["open_application", "quit_application"]);
    expect(emitted.find((event) => event.type === "computer.confirmation_resolved")?.payload).toEqual({
      requestId,
      action: "quit_application",
      decision: "approve",
    });

    // A second resolve of the same id is no longer pending.
    expect(await toolkit.execute("resolve_computer_control", { requestId, decision: "approve" })).toMatchObject({
      status: "rejected",
      code: "computer_confirmation_expired",
    });
    toolkit.dispose();
  });

  test("rejects a parked computer action on user rejection without running it", async () => {
    const controlled: string[] = [];
    const { host, emitted } = makeHost({
      getComputerConfirmationMode: () => "always",
      controlComputer: async (request) => {
        controlled.push(request.action);
        return { status: "ok", action: request.action, target: "this Mac" } satisfies ComputerControlResult;
      },
    });
    const toolkit = createVoiceToolkit(host);
    const requestId = stringField(await toolkit.execute("control_computer", { action: "show_desktop" }), "requestId");
    expect(await toolkit.execute("resolve_computer_control", { requestId, decision: "reject" })).toEqual({
      status: "rejected",
      action: "show_desktop",
      code: "user_rejected",
      explanation: "The user rejected the computer action",
    });
    expect(controlled).toEqual([]);
    expect(emitted.find((event) => event.type === "computer.confirmation_resolved")?.payload).toEqual({
      requestId,
      action: "show_desktop",
      decision: "reject",
    });
    toolkit.dispose();
  });

  test("open_pull_request always requires confirmation and runs the host callback only on approval", async () => {
    const opened: Array<{ repositoryId: string; title: string; body: string }> = [];
    const { host, emitted } = makeHost({
      openPullRequest: async (request) => {
        opened.push(request);
        return { status: "opened", url: "https://github.com/acme/widgets/pull/1" };
      },
    });
    const toolkit = createVoiceToolkit(host);

    const pending = asRecord(
      await toolkit.execute("open_pull_request", { taskId: "task-1", title: "Fix the bug", body: "Details" }),
    );
    expect(pending["status"]).toBe("confirmation_required");
    expect(pending["taskId"]).toBe("task-1");
    expect(pending["summary"]).toBe('Push the current branch and open a pull request: "Fix the bug"');
    const requestId = stringField(pending, "requestId");
    expect(emitted.find((event) => event.type === "pull_request.confirmation_required")?.payload).toEqual(pending);
    // Nothing runs until the user decides.
    expect(opened).toEqual([]);

    const result = await toolkit.execute("resolve_open_pull_request", { requestId, decision: "approve" });
    expect(result).toEqual({ status: "opened", url: "https://github.com/acme/widgets/pull/1" });
    // The repositoryId comes from resolving the taskId against the snapshot, not from the model.
    expect(opened).toEqual([{ repositoryId: "/repo", title: "Fix the bug", body: "Details" }]);
    expect(emitted.find((event) => event.type === "pull_request.confirmation_resolved")?.payload).toEqual({
      requestId,
      taskId: "task-1",
      decision: "approve",
    });
    toolkit.dispose();
  });

  test("rejects a parked pull-request confirmation without ever pushing or opening anything", async () => {
    const opened: unknown[] = [];
    const { host } = makeHost({
      openPullRequest: async (request) => {
        opened.push(request);
        return { status: "opened", url: "unused" };
      },
    });
    const toolkit = createVoiceToolkit(host);
    const requestId = stringField(
      await toolkit.execute("open_pull_request", { taskId: "task-1", title: "Fix the bug", body: "" }),
      "requestId",
    );
    expect(await toolkit.execute("resolve_open_pull_request", { requestId, decision: "reject" })).toEqual({
      status: "rejected",
      code: "user_rejected",
      explanation: "The user rejected opening the pull request",
    });
    expect(opened).toEqual([]);

    // Already resolved -- a second decision finds nothing pending.
    expect(await toolkit.execute("resolve_open_pull_request", { requestId, decision: "approve" })).toEqual({
      status: "rejected",
      code: "pull_request_confirmation_expired",
      explanation: "That pull-request request is no longer pending",
    });
    toolkit.dispose();
  });

  test("open_pull_request rejects an unknown taskId before ever parking a confirmation", async () => {
    const { host, emitted } = makeHost({
      openPullRequest: async () => ({ status: "opened", url: "unused" }),
    });
    const toolkit = createVoiceToolkit(host);
    expect(
      await toolkit.execute("open_pull_request", { taskId: "no-such-task", title: "x", body: "" }),
    ).toEqual({ status: "rejected", code: "task_not_found", explanation: "Task no-such-task does not exist" });
    expect(emitted.some((event) => event.type === "pull_request.confirmation_required")).toBe(false);
    toolkit.dispose();
  });

  test("open_pull_request reports unavailable when the host has no openPullRequest callback", async () => {
    const toolkit = createVoiceToolkit(makeHost().host);
    expect(
      await toolkit.execute("open_pull_request", { taskId: "task-1", title: "x", body: "" }),
    ).toEqual({
      status: "rejected",
      code: "pull_request_unavailable",
      explanation: "Opening pull requests is unavailable in this Mamachi runtime",
    });
    toolkit.dispose();
  });

  test("resolve_open_pull_request on an unknown request id reports expired, not a crash", async () => {
    const toolkit = createVoiceToolkit(makeHost().host);
    expect(await toolkit.execute("resolve_open_pull_request", { requestId: "nope", decision: "approve" })).toEqual({
      status: "rejected",
      code: "pull_request_confirmation_expired",
      explanation: "That pull-request request is no longer pending",
    });
    toolkit.dispose();
  });

  test("expires a parked pull-request confirmation after 120 seconds of fake time", async () => {
    const { host } = makeHost({
      openPullRequest: async () => ({ status: "opened", url: "unused" }),
    });
    const toolkit = createVoiceToolkit(host);
    try {
      const requestId = stringField(
        await toolkit.execute("open_pull_request", { taskId: "task-1", title: "x", body: "" }),
        "requestId",
      );
      setSystemTime(new Date(Date.now() + 121_000));
      expect(await toolkit.execute("resolve_open_pull_request", { requestId, decision: "approve" })).toEqual({
        status: "rejected",
        code: "pull_request_confirmation_expired",
        explanation: "That pull-request request is no longer pending",
      });
    } finally {
      setSystemTime();
      toolkit.dispose();
    }
  });

  test("expires a parked confirmation after 120 seconds of fake time", async () => {
    const { host } = makeHost({
      getComputerConfirmationMode: () => "always",
      controlComputer: async (request) => ({ status: "ok", action: request.action, target: "this Mac" }),
    });
    const toolkit = createVoiceToolkit(host);
    try {
      const requestId = stringField(await toolkit.execute("control_computer", { action: "show_desktop" }), "requestId");
      setSystemTime(new Date(Date.now() + 121_000));
      expect(await toolkit.execute("resolve_computer_control", { requestId, decision: "approve" })).toEqual({
        status: "rejected",
        code: "computer_confirmation_expired",
        explanation: "That computer-control request is no longer pending",
      });
    } finally {
      setSystemTime();
      toolkit.dispose();
    }
  });

  test("clears pending confirmations on settings changes and supersession", async () => {
    const { host, emitted } = makeHost({
      getComputerConfirmationMode: () => "always",
      controlComputer: async (request) => ({ status: "ok", action: request.action, target: "this Mac" }),
    });
    const toolkit = createVoiceToolkit(host);
    const firstId = stringField(await toolkit.execute("control_computer", { action: "show_desktop" }), "requestId");

    // A newer sensitive request supersedes the parked one.
    const secondId = stringField(await toolkit.execute("control_computer", { action: "mission_control" }), "requestId");
    expect(emitted.find((event) => event.type === "computer.confirmation_cleared")?.payload).toEqual({
      reason: "superseded",
    });
    expect(await toolkit.execute("resolve_computer_control", { requestId: firstId, decision: "approve" })).toMatchObject({
      status: "rejected",
      code: "computer_confirmation_expired",
    });

    // Settings changes clear whatever is pending.
    toolkit.clearPendingComputerControls("settings_changed");
    expect(emitted.filter((event) => event.type === "computer.confirmation_cleared").at(-1)?.payload).toEqual({
      reason: "settings_changed",
    });
    expect(await toolkit.execute("resolve_computer_control", { requestId: secondId, decision: "approve" })).toMatchObject({
      status: "rejected",
      code: "computer_confirmation_expired",
    });

    // Clearing an empty store emits nothing further.
    const clearedCount = emitted.filter((event) => event.type === "computer.confirmation_cleared").length;
    toolkit.clearPendingComputerControls("settings_changed");
    expect(emitted.filter((event) => event.type === "computer.confirmation_cleared")).toHaveLength(clearedCount);
    toolkit.dispose();
  });

  test("dispose cancels pending confirmation timers silently", async () => {
    const { host, emitted } = makeHost({
      getComputerConfirmationMode: () => "always",
      controlComputer: async (request) => ({ status: "ok", action: request.action, target: "this Mac" }),
    });
    const toolkit = createVoiceToolkit(host);
    const requestId = stringField(await toolkit.execute("control_computer", { action: "show_desktop" }), "requestId");
    toolkit.dispose();
    expect(emitted.some((event) => event.type === "computer.confirmation_cleared")).toBe(false);
    expect(await toolkit.execute("resolve_computer_control", { requestId, decision: "approve" })).toMatchObject({
      status: "rejected",
      code: "computer_confirmation_expired",
    });
  });

  test("reports computer control unavailable without a host controller", async () => {
    const toolkit = createVoiceToolkit(makeHost().host);
    expect(await toolkit.execute("control_computer", { action: "open_application", application: "Safari" })).toEqual({
      status: "rejected",
      action: "open_application",
      code: "computer_control_unavailable",
      explanation: "Computer control is unavailable in this Mamachi runtime",
    });
    toolkit.dispose();
  });

  test("consumes captured contexts on accepted submit_task and emits context.consumed", async () => {
    const commands: Array<Record<string, unknown>> = [];
    const { host, emitted } = makeHost({
      executeCommand: async (command) => {
        commands.push(asRecord(command));
        return { status: "accepted", eventId: Bun.randomUUIDv7(), taskId: "task-9" };
      },
    });
    const toolkit = createVoiceToolkit(host);
    toolkit.captureContext(makeContext("ctx-1"));
    toolkit.captureContext(makeContext("ctx-2"));
    expect(toolkit.pendingContexts().map((context) => context.id)).toEqual(["ctx-1", "ctx-2"]);

    toolkit.discardContext("ctx-2");
    expect(toolkit.pendingContexts().map((context) => context.id)).toEqual(["ctx-1"]);

    const result = asRecord(await toolkit.execute("submit_task", {
      repositoryId: "/repo",
      objective: "Wire the new login flow",
      acceptanceCriteria: ["Login works"],
      constraints: [],
      attachmentIds: ["ctx-1"],
      codingProfileId: null,
    }));
    expect(result["status"]).toBe("accepted");
    expect(commands[0]).toMatchObject({ type: "task.submit", actor: "voice" });
    expect(emitted.find((event) => event.type === "context.consumed")?.payload).toEqual({
      ids: ["ctx-1"],
      taskId: "task-9",
    });
    expect(toolkit.pendingContexts()).toEqual([]);
    toolkit.dispose();
  });

  test("remember_fact and forget_fact enforce scope and availability", async () => {
    const remembered: Array<{ scope: string; projectId: string | null; fact: string }> = [];
    const { host } = makeHost({
      rememberFact: (scope, projectId, fact) => {
        remembered.push({ scope, projectId, fact });
        return { id: "mem-1", scope, projectId, fact };
      },
      forgetFact: (memoryId) => memoryId === "mem-1",
    });
    const toolkit = createVoiceToolkit(host);

    expect(await toolkit.execute("remember_fact", { scope: "global", projectId: "/repo", fact: "prefers tabs" })).toEqual({
      status: "rejected",
      code: "memory_scope_mismatch",
      explanation: "Global facts require projectId null; project facts require the active repository ID",
    });
    expect(await toolkit.execute("remember_fact", { scope: "project", projectId: "/repo", fact: "prefers tabs" })).toEqual({
      status: "accepted",
      eventId: "mem-1",
      memoryId: "mem-1",
      scope: "project",
      projectId: "/repo",
    });
    expect(remembered).toEqual([{ scope: "project", projectId: "/repo", fact: "prefers tabs" }]);

    expect(await toolkit.execute("forget_fact", { memoryId: "mem-1" })).toMatchObject({
      status: "accepted",
      memoryId: "mem-1",
    });
    expect(await toolkit.execute("forget_fact", { memoryId: "mem-2" })).toEqual({
      status: "rejected",
      code: "memory_not_found",
      explanation: "The memory does not exist or is outside the active project scope",
    });

    const bare = createVoiceToolkit(makeHost().host);
    expect(await bare.execute("remember_fact", { scope: "global", projectId: null, fact: "x" })).toMatchObject({
      status: "rejected",
      code: "memory_unavailable",
    });
    expect(await bare.execute("forget_fact", { memoryId: "mem-1" })).toMatchObject({
      status: "rejected",
      code: "memory_unavailable",
    });
    bare.dispose();
    toolkit.dispose();
  });

  test("mute_mamachi puts the microphone to sleep through the host", async () => {
    const { host, sleepCalls } = makeHost();
    const toolkit = createVoiceToolkit(host);
    expect(await toolkit.execute("mute_mamachi", {})).toEqual({ status: "ok", muted: true });
    expect(sleepCalls.count).toBe(1);
    toolkit.dispose();
  });
  test("look_at_screen attaches validated pixels through the host", async () => {
    const pngPath = `/tmp/mamachi-test-screen-${Bun.randomUUIDv7()}.png`;
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    await Bun.write(pngPath, Buffer.from(pngBase64, "base64"));
    const { host, attachedImages } = makeHost({
      controlComputer: async (request) => ({
        status: "ok",
        action: request.action,
        target: pngPath,
      } as ComputerControlResult),
    });
    const toolkit = createVoiceToolkit(host);

    const result = asRecord(await toolkit.execute("look_at_screen", {}));
    expect(result["visualInputAttached"]).toBe(true);
    expect(typeof result["visualInputInstruction"]).toBe("string");
    expect(attachedImages).toHaveLength(1);
    expect(attachedImages[0]?.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(attachedImages[0]?.note).toContain("untrusted content");
    toolkit.dispose();
  });

  test("look_at_screen reports a missing screenshot instead of attaching", async () => {
    const { host, attachedImages } = makeHost({
      controlComputer: async (request) => ({
        status: "ok",
        action: request.action,
        target: `/tmp/mamachi-test-missing-${Bun.randomUUIDv7()}.png`,
      } as ComputerControlResult),
    });
    const toolkit = createVoiceToolkit(host);

    const result = asRecord(await toolkit.execute("look_at_screen", {}));
    expect(result["visualInputAttached"]).toBe(false);
    expect(result["visualInputError"]).toBe("The captured screenshot file does not exist");
    expect(attachedImages).toHaveLength(0);
    toolkit.dispose();
  });

  test("screenshots reach the model only through look_at_screen", () => {
    const { host } = makeHost();
    const toolkit = createVoiceToolkit(host);
    const names = toolkit.tools().map((tool) => tool.name);
    expect(names).toContain("look_at_screen");
    expect(names).toContain("capture_screen_context");
    const controlComputer = toolkit.tools().find((tool) => tool.name === "control_computer");
    const actions = asRecord(asRecord(asRecord(controlComputer?.parameters)["properties"])["action"]);
    expect(actions["enum"]).not.toContain("take_screenshot");
    toolkit.dispose();
  });

  test("capture_screen_context returns a real attachment id", async () => {
    const pngPath = `/tmp/mamachi-test-attach-${Bun.randomUUIDv7()}.png`;
    await Bun.write(pngPath, Buffer.from([137, 80, 78, 71]));
    const capturedSummaries: string[] = [];
    const { host } = makeHost({
      controlComputer: async (request) => ({
        status: "ok",
        action: request.action,
        target: pngPath,
      } as ComputerControlResult),
      captureScreenContext: async (path, summary) => {
        capturedSummaries.push(summary);
        return {
          id: "ctx_screen_1",
          kind: "screenshot",
          workspace: "/repo",
          summary,
          payload: { path },
          createdAt: new Date(0).toISOString(),
        };
      },
    });
    const toolkit = createVoiceToolkit(host);

    const result = asRecord(await toolkit.execute("capture_screen_context", {}));
    expect(result["status"]).toBe("accepted");
    expect(result["artifactIds"]).toEqual(["ctx_screen_1"]);
    expect(result["kind"]).toBe("screenshot");
    expect(capturedSummaries).toHaveLength(1);
    toolkit.dispose();
  });

  test("capture_screen_context degrades without the daemon callback", async () => {
    const harness = makeHost();
    // Simulates a host wired without persistent state (":memory:" daemon).
    const host = { ...harness.host };
    delete (host as Partial<VoiceToolHost>).captureScreenContext;
    const toolkit = createVoiceToolkit(host as VoiceToolHost);

    const result = asRecord(await toolkit.execute("capture_screen_context", {}));
    expect(result["status"]).toBe("rejected");
    expect(result["code"]).toBe("screenshot_attachment_unavailable");
    toolkit.dispose();
  });
});
