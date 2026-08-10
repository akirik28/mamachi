import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionResult } from "@mamachi/protocol";
import { MamachiIpcServer } from "../src/ipc-server.ts";
import { createVoiceToolkit } from "../src/voice-toolkit.ts";
import type { VoiceToolHost } from "../src/voice-bridge.ts";
import type { PullRequestRequest, PullRequestResult } from "../src/pull-request.ts";

/**
 * End-to-end trace of the exact user journey this feature exists for
 * (case-study brief): two repositories, two concurrent tasks, and a request
 * to open a PR for one *specific* task by name. The daemon must resolve
 * that to the right repository -- never the other task's -- regardless of
 * which one started first or is otherwise "active". Wires the real
 * MamachiIpcServer (proven correct by its own test suite) to the real
 * voice toolkit, so this isn't re-testing either module's internals -- it's
 * proving the seam between them does what the feature promises.
 */
test("opening a PR for a specific task resolves that task's own repository, never a concurrently-active one", async () => {
  // Canonicalized up front (macOS's /tmp is itself a symlink to /private/tmp)
  // so every comparison below matches what the server actually stores --
  // repositoryId is canonicalized server-side precisely so a symlink alias
  // can never be mistaken for a different repository.
  const repoA = realpathSync(mkdtempSync(join(tmpdir(), "mamachi-integration-repo-a-")));
  const repoB = realpathSync(mkdtempSync(join(tmpdir(), "mamachi-integration-repo-b-")));

  const server = new MamachiIpcServer({ token: "integration-token", port: 0, initialWorkspace: repoA });
  const pullRequestCalls: PullRequestRequest[] = [];

  try {
    // Register repoB the way the real app does -- the Swift folder picker
    // sends "workspace.select" over the IPC socket. Exercised here through
    // the real protocol path, the same way ipc-server.test.ts's own
    // "workspace.select registers a second repository" test does.
    const socket = new (await import("ws")).default(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { Authorization: "Bearer integration-token" },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const requestId = Bun.randomUUIDv7();
    const selected = await new Promise<{ ok: boolean }>((resolve) => {
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as {
          type?: string;
          payload?: { requestId?: string; ok?: boolean };
        };
        if (message.type === "response" && message.payload?.requestId === requestId) {
          resolve({ ok: Boolean(message.payload.ok) });
        }
      });
      socket.send(JSON.stringify({ version: 1, id: requestId, type: "workspace.select", payload: { path: repoB } }));
    });
    expect(selected.ok).toBe(true);
    socket.close();

    const host: VoiceToolHost = {
      getWorkspace: () => server.workspace,
      getAvailableWorkspaces: () => server.workspaces,
      getSnapshot: () => server.snapshot(),
      executeCommand: (command: unknown) => server.executeCommand(command),
      openPullRequest: async (request: PullRequestRequest): Promise<PullRequestResult> => {
        pullRequestCalls.push(request);
        return { status: "opened", url: `https://example.test/pr-for-${request.repositoryId}` };
      },
      emit: () => {},
      isEngaged: () => true,
      getResponseMode: () => "voice",
      getCurrentUserInput: () => null,
      sleepMicrophone: () => {},
      attachUserImage: () => {},
    };
    const toolkit = createVoiceToolkit(host);

    // Two concurrent tasks, one per repository -- exactly the user journey:
    // "Fix bug X in repo A" then, while A runs, "Add feature Y to repo B".
    const submitA = (await server.executeCommand({
      id: Bun.randomUUIDv7(),
      type: "task.submit",
      actor: "voice",
      expectedRevision: null,
      payload: {
        repositoryId: repoA,
        objective: "Fix bug X",
        acceptanceCriteria: ["Bug X is fixed"],
        constraints: [],
        attachmentIds: [],
        codingProfileId: null,
      },
    })) as ActionResult & { taskId?: string };
    const submitB = (await server.executeCommand({
      id: Bun.randomUUIDv7(),
      type: "task.submit",
      actor: "voice",
      expectedRevision: null,
      payload: {
        repositoryId: repoB,
        objective: "Add feature Y",
        acceptanceCriteria: ["Feature Y exists"],
        constraints: [],
        attachmentIds: [],
        codingProfileId: null,
      },
    })) as ActionResult & { taskId?: string };
    expect(submitA.status).toBe("accepted");
    expect(submitB.status).toBe("accepted");
    const taskIdA = submitA.taskId!;
    const taskIdB = submitB.taskId!;
    // Both genuinely concurrent -- neither queued behind the other.
    expect(server.snapshot().queue).toEqual([]);

    // "Open a PR for A" -- names task A explicitly, the way a real voice
    // command resolved by the model would (submit_task's result gives the
    // model taskIdA to reference later).
    const parkedForA = (await toolkit.execute("open_pull_request", {
      taskId: taskIdA,
      title: "Fix bug X",
      body: "Fixes the reported bug.",
    })) as { requestId: string };
    const resultForA = await toolkit.execute("resolve_open_pull_request", {
      requestId: parkedForA.requestId,
      decision: "approve",
    });

    expect(resultForA).toEqual({ status: "opened", url: `https://example.test/pr-for-${repoA}` });
    expect(pullRequestCalls).toEqual([{ repositoryId: repoA, title: "Fix bug X", body: "Fixes the reported bug." }]);

    // Task B is completely undisturbed: still active, own repository, no
    // pull request ever attempted against it.
    const snapshotAfter = server.snapshot();
    expect(snapshotAfter.tasks.find((task) => task.id === taskIdB)?.state).toBe("running");
    expect(snapshotAfter.tasks.find((task) => task.id === taskIdB)?.repositoryId).toBe(repoB);
    expect(pullRequestCalls.some((call) => call.repositoryId === repoB)).toBe(false);

    // And the reverse: opening a PR for B resolves B's repository, not A's
    // (not "whichever task is focused" or "the first one" -- the one named).
    const parkedForB = (await toolkit.execute("open_pull_request", {
      taskId: taskIdB,
      title: "Add feature Y",
      body: "",
    })) as { requestId: string };
    await toolkit.execute("resolve_open_pull_request", { requestId: parkedForB.requestId, decision: "approve" });
    expect(pullRequestCalls).toEqual([
      { repositoryId: repoA, title: "Fix bug X", body: "Fixes the reported bug." },
      { repositoryId: repoB, title: "Add feature Y", body: "" },
    ]);

    toolkit.dispose();
  } finally {
    server.close();
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  }
});
