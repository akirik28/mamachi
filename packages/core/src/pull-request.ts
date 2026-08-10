import type { ProcessResult, ProcessRunner, ProcessRunOptions } from "./computer-control.ts";

export interface PullRequestRequest {
  /** Canonical (realpath'd) repository directory -- used as the process cwd. */
  repositoryId: string;
  title: string;
  body: string;
}

export type PullRequestResult =
  | { status: "opened"; url: string }
  | { status: "existing"; url: string }
  | { status: "error"; code: string; explanation: string };

export interface PullRequestOptions {
  run?: ProcessRunner;
}

async function defaultProcessRunner(
  argv: readonly string[],
  options: ProcessRunOptions = {},
): Promise<ProcessResult> {
  const child = Bun.spawn([...argv], {
    stdout: "pipe",
    stderr: "pipe",
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.timeoutMs ?? 30_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timeout);
  }
}

function error(code: string, explanation: string): PullRequestResult {
  return { status: "error", code, explanation };
}

/** Parses `owner/repo` out of a GitHub remote URL, HTTPS or SSH form. Returns null for anything else. */
function parseGitHubOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const trimmed = remoteUrl.trim();
  const patterns = [
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) return { owner: match[1]!, repo: match[2]! };
  }
  return null;
}

/**
 * Pushes the current branch and opens (or finds) a pull request. Host-side
 * only -- never runs inside the sandboxed coding-agent process, which has no
 * `gh`/git credentials by design (see `sensitiveChildEnvironmentKeys` in
 * `external-cli-runner.ts`). Every git/gh invocation passes argv as a real
 * array to `run` (default: `Bun.spawn`, never a shell string), so no piece of
 * `title`, `body`, or a branch name can be interpreted as a flag or shell
 * syntax regardless of its content.
 */
export async function openPullRequest(
  request: PullRequestRequest,
  options: PullRequestOptions = {},
): Promise<PullRequestResult> {
  const run = options.run ?? defaultProcessRunner;
  const cwd = request.repositoryId;

  const auth = await run(["gh", "auth", "status"], { cwd });
  if (auth.exitCode !== 0) {
    return error(
      "github_auth_required",
      "GitHub CLI is not authenticated. Run `gh auth login` and try again.",
    );
  }

  const branchResult = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd });
  const currentBranch = branchResult.stdout.trim();
  if (branchResult.exitCode !== 0 || !currentBranch) {
    return error("no_branch", "Could not determine the current git branch.");
  }
  if (currentBranch === "HEAD") {
    return error("detached_head", "Cannot open a pull request from a detached HEAD. Check out a branch first.");
  }

  const statusResult = await run(["git", "status", "--porcelain"], { cwd });
  if (statusResult.stdout.trim() !== "") {
    return error(
      "uncommitted_changes",
      "There are uncommitted changes in the working tree. Commit them before opening a pull request.",
    );
  }

  const remoteResult = await run(["git", "remote", "get-url", "origin"], { cwd });
  const parsedRemote = remoteResult.exitCode === 0 ? parseGitHubOwnerRepo(remoteResult.stdout) : null;
  if (!parsedRemote) {
    return error("unsupported_remote", "The repository's origin remote is not a recognized GitHub URL.");
  }
  const { owner, repo } = parsedRemote;
  const upstreamRepo = `${owner}/${repo}`;

  const defaultBranchResult = await run(["gh", "api", `repos/${upstreamRepo}`, "--jq", ".default_branch"], { cwd });
  const defaultBranch = defaultBranchResult.stdout.trim();
  if (defaultBranchResult.exitCode !== 0 || !defaultBranch) {
    return error("repository_unreachable", `Could not read repository details for ${upstreamRepo}.`);
  }
  if (currentBranch === defaultBranch) {
    return error(
      "on_default_branch",
      `Cannot open a pull request from ${upstreamRepo}'s own default branch (${defaultBranch}). Create a feature branch first.`,
    );
  }

  const permissionResult = await run(["gh", "api", `repos/${upstreamRepo}`, "--jq", ".permissions.push"], { cwd });
  const hasPushAccess = permissionResult.stdout.trim() === "true";

  let pushRemote = "origin";
  let headOwner = owner;
  if (!hasPushAccess) {
    const loginResult = await run(["gh", "api", "user", "--jq", ".login"], { cwd });
    const login = loginResult.stdout.trim();
    if (loginResult.exitCode !== 0 || !login) {
      return error("github_user_unknown", "Could not determine the authenticated GitHub user.");
    }
    headOwner = login;
    pushRemote = "fork";
    const existingForkRemote = await run(["git", "remote", "get-url", "fork"], { cwd });
    if (existingForkRemote.exitCode !== 0) {
      const forkResult = await run(
        ["gh", "repo", "fork", upstreamRepo, "--remote", "--remote-name=fork"],
        { cwd },
      );
      if (forkResult.exitCode !== 0) {
        return error(
          "fork_failed",
          `Could not fork ${upstreamRepo} (no push access and no fork could be created): ${forkResult.stderr.trim() || forkResult.stdout.trim()}`,
        );
      }
    }
  }

  const pushResult = await run(["git", "push", pushRemote, `${currentBranch}:${currentBranch}`], { cwd });
  if (pushResult.exitCode !== 0) {
    return error("push_failed", `git push to ${pushRemote} failed: ${pushResult.stderr.trim() || pushResult.stdout.trim()}`);
  }

  const headSpec = hasPushAccess ? currentBranch : `${headOwner}:${currentBranch}`;

  const existingPrResult = await run(
    ["gh", "pr", "list", "--repo", upstreamRepo, "--head", headSpec, "--json", "url,number"],
    { cwd },
  );
  if (existingPrResult.exitCode === 0) {
    try {
      const existing = JSON.parse(existingPrResult.stdout) as Array<{ url: string; number: number }>;
      if (existing.length > 0 && existing[0]?.url) {
        return { status: "existing", url: existing[0].url };
      }
    } catch {
      // Malformed JSON from `gh` falls through to attempting creation --
      // `gh pr create` will itself report an existing PR if one exists.
    }
  }

  const createResult = await run(
    [
      "gh",
      "pr",
      "create",
      "--repo",
      upstreamRepo,
      "--base",
      defaultBranch,
      "--head",
      headSpec,
      "--title",
      request.title,
      "--body",
      request.body,
    ],
    { cwd },
  );
  if (createResult.exitCode !== 0) {
    const combined = `${createResult.stdout}\n${createResult.stderr}`;
    // `gh pr create` reports an already-existing PR as a failure with the
    // PR's URL in the message rather than a machine-readable status --
    // recover the URL instead of reporting a spurious error for a PR that
    // already exists (the idempotent-retry case: an earlier attempt pushed
    // and created the PR, but this invocation never saw that response).
    const existingUrlMatch = combined.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/);
    if (existingUrlMatch) {
      return { status: "existing", url: existingUrlMatch[0] };
    }
    return error("pr_create_failed", `gh pr create failed: ${createResult.stderr.trim() || createResult.stdout.trim()}`);
  }

  const url = createResult.stdout.trim().split("\n").filter(Boolean).pop();
  if (!url) {
    return error("pr_create_failed", "gh pr create succeeded but did not report a URL.");
  }
  return { status: "opened", url };
}
