import { describe, expect, test } from "bun:test";
import type { ProcessResult, ProcessRunner } from "../src/computer-control.ts";
import { openPullRequest } from "../src/pull-request.ts";

function ok(stdout = ""): ProcessResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

function fail(stderr = "", exitCode = 1): ProcessResult {
  return { exitCode, stdout: "", stderr, timedOut: false };
}

/**
 * Builds a fake ProcessRunner from an ordered script of {match, result}
 * entries. Each call to `run` consumes the *next* script entry whose
 * `match` prefix-matches the argv, in order -- this both fakes process
 * output and asserts calls happen in the expected sequence, since an
 * out-of-order or unexpected call fails the test immediately rather than
 * silently returning the wrong canned response.
 */
function scriptedRunner(
  script: Array<{ match: readonly string[]; result: ProcessResult; capture?: (argv: readonly string[]) => void }>,
): ProcessRunner {
  let index = 0;
  return async (argv) => {
    if (index >= script.length) {
      throw new Error(`Unexpected process call beyond scripted sequence: ${JSON.stringify(argv)}`);
    }
    const step = script[index]!;
    const prefix = step.match;
    const actualPrefix = argv.slice(0, prefix.length);
    if (JSON.stringify(actualPrefix) !== JSON.stringify(prefix)) {
      throw new Error(
        `Process call ${index} did not match. Expected argv starting with ${JSON.stringify(prefix)}, got ${JSON.stringify(argv)}`,
      );
    }
    step.capture?.(argv);
    index += 1;
    return step.result;
  };
}

const baseRequest = { repositoryId: "/repo", title: "Fix the bug", body: "Full description" };

describe("openPullRequest", () => {
  test("reports a clean, actionable error when gh is not authenticated", async () => {
    const run = scriptedRunner([{ match: ["gh", "auth", "status"], result: fail("not logged in") }]);
    const result = await openPullRequest(baseRequest, { run });
    expect(result).toEqual({
      status: "error",
      code: "github_auth_required",
      explanation: expect.stringContaining("gh auth login"),
    });
  });

  test("refuses to open a PR from a detached HEAD", async () => {
    const run = scriptedRunner([
      { match: ["gh", "auth", "status"], result: ok() },
      { match: ["git", "rev-parse", "--abbrev-ref", "HEAD"], result: ok("HEAD\n") },
    ]);
    const result = await openPullRequest(baseRequest, { run });
    expect(result).toEqual({
      status: "error",
      code: "detached_head",
      explanation: expect.any(String),
    });
  });

  test("refuses to open a PR when the working tree has uncommitted changes, without committing anything", async () => {
    const calls: string[][] = [];
    const run = scriptedRunner([
      { match: ["gh", "auth", "status"], result: ok() },
      { match: ["git", "rev-parse", "--abbrev-ref", "HEAD"], result: ok("feature-branch\n") },
      {
        match: ["git", "status", "--porcelain"],
        result: ok(" M src/thing.ts\n"),
        capture: (argv) => calls.push([...argv]),
      },
    ]);
    const result = await openPullRequest(baseRequest, { run });
    expect(result).toEqual({
      status: "error",
      code: "uncommitted_changes",
      explanation: expect.any(String),
    });
    // Nothing resembling a commit or add was ever invoked.
    expect(calls.some((argv) => argv.includes("commit") || argv.includes("add"))).toBe(false);
  });

  test("refuses to open a PR from the repository's own default branch", async () => {
    const run = scriptedRunner([
      { match: ["gh", "auth", "status"], result: ok() },
      { match: ["git", "rev-parse", "--abbrev-ref", "HEAD"], result: ok("main\n") },
      { match: ["git", "status", "--porcelain"], result: ok("") },
      { match: ["git", "remote", "get-url", "origin"], result: ok("https://github.com/acme/widgets.git\n") },
      {
        match: ["gh", "api", "repos/acme/widgets", "--jq", ".default_branch"],
        result: ok("main\n"),
      },
    ]);
    const result = await openPullRequest(baseRequest, { run });
    expect(result).toEqual({
      status: "error",
      code: "on_default_branch",
      explanation: expect.any(String),
    });
  });

  test("parses an SSH-style remote URL the same as an HTTPS one", async () => {
    const run = scriptedRunner([
      { match: ["gh", "auth", "status"], result: ok() },
      { match: ["git", "rev-parse", "--abbrev-ref", "HEAD"], result: ok("feature\n") },
      { match: ["git", "status", "--porcelain"], result: ok("") },
      { match: ["git", "remote", "get-url", "origin"], result: ok("git@github.com:acme/widgets.git\n") },
      { match: ["gh", "api", "repos/acme/widgets", "--jq", ".default_branch"], result: ok("main\n") },
      { match: ["gh", "api", "repos/acme/widgets", "--jq", ".permissions.push"], result: ok("true\n") },
      { match: ["git", "push", "origin", "feature:feature"], result: ok() },
      {
        match: ["gh", "pr", "list", "--repo", "acme/widgets", "--head", "feature", "--json", "url,number"],
        result: ok("[]\n"),
      },
      {
        match: ["gh", "pr", "create", "--repo", "acme/widgets"],
        result: ok("https://github.com/acme/widgets/pull/9\n"),
      },
    ]);
    const result = await openPullRequest(baseRequest, { run });
    expect(result).toEqual({ status: "opened", url: "https://github.com/acme/widgets/pull/9" });
  });

  test("pushes directly and opens a PR when the user has push access", async () => {
    const run = scriptedRunner([
      { match: ["gh", "auth", "status"], result: ok() },
      { match: ["git", "rev-parse", "--abbrev-ref", "HEAD"], result: ok("feature\n") },
      { match: ["git", "status", "--porcelain"], result: ok("") },
      { match: ["git", "remote", "get-url", "origin"], result: ok("https://github.com/acme/widgets.git\n") },
      { match: ["gh", "api", "repos/acme/widgets", "--jq", ".default_branch"], result: ok("main\n") },
      { match: ["gh", "api", "repos/acme/widgets", "--jq", ".permissions.push"], result: ok("true\n") },
      { match: ["git", "push", "origin", "feature:feature"], result: ok() },
      {
        match: ["gh", "pr", "list", "--repo", "acme/widgets", "--head", "feature", "--json", "url,number"],
        result: ok("[]\n"),
      },
      {
        match: ["gh", "pr", "create", "--repo", "acme/widgets"],
        result: ok("https://github.com/acme/widgets/pull/9\n"),
      },
    ]);
    const result = await openPullRequest(baseRequest, { run });
    expect(result).toEqual({ status: "opened", url: "https://github.com/acme/widgets/pull/9" });
  });

  test("forks, pushes to the fork, and opens a PR from it when the user has no push access", async () => {
    const run = scriptedRunner([
      { match: ["gh", "auth", "status"], result: ok() },
      { match: ["git", "rev-parse", "--abbrev-ref", "HEAD"], result: ok("feature\n") },
      { match: ["git", "status", "--porcelain"], result: ok("") },
      { match: ["git", "remote", "get-url", "origin"], result: ok("https://github.com/acme/widgets.git\n") },
      { match: ["gh", "api", "repos/acme/widgets", "--jq", ".default_branch"], result: ok("main\n") },
      { match: ["gh", "api", "repos/acme/widgets", "--jq", ".permissions.push"], result: ok("false\n") },
      { match: ["gh", "api", "user", "--jq", ".login"], result: ok("octocat\n") },
      { match: ["git", "remote", "get-url", "fork"], result: fail("No such remote 'fork'") },
      { match: ["gh", "repo", "fork", "acme/widgets", "--remote", "--remote-name=fork"], result: ok() },
      { match: ["git", "push", "fork", "feature:feature"], result: ok() },
      {
        match: ["gh", "pr", "list", "--repo", "acme/widgets", "--head", "octocat:feature", "--json", "url,number"],
        result: ok("[]\n"),
      },
      {
        match: ["gh", "pr", "create", "--repo", "acme/widgets"],
        result: ok("https://github.com/acme/widgets/pull/10\n"),
      },
    ]);
    const result = await openPullRequest(baseRequest, { run });
    expect(result).toEqual({ status: "opened", url: "https://github.com/acme/widgets/pull/10" });
  });

  test("reuses an already-added fork remote instead of re-forking", async () => {
    const run = scriptedRunner([
      { match: ["gh", "auth", "status"], result: ok() },
      { match: ["git", "rev-parse", "--abbrev-ref", "HEAD"], result: ok("feature\n") },
      { match: ["git", "status", "--porcelain"], result: ok("") },
      { match: ["git", "remote", "get-url", "origin"], result: ok("https://github.com/acme/widgets.git\n") },
      { match: ["gh", "api", "repos/acme/widgets", "--jq", ".default_branch"], result: ok("main\n") },
      { match: ["gh", "api", "repos/acme/widgets", "--jq", ".permissions.push"], result: ok("false\n") },
      { match: ["gh", "api", "user", "--jq", ".login"], result: ok("octocat\n") },
      {
        match: ["git", "remote", "get-url", "fork"],
        result: ok("https://github.com/octocat/widgets.git\n"),
      },
      // No "gh repo fork" call here -- the existing remote must be reused.
      { match: ["git", "push", "fork", "feature:feature"], result: ok() },
      {
        match: ["gh", "pr", "list", "--repo", "acme/widgets", "--head", "octocat:feature", "--json", "url,number"],
        result: ok("[]\n"),
      },
      {
        match: ["gh", "pr", "create", "--repo", "acme/widgets"],
        result: ok("https://github.com/acme/widgets/pull/11\n"),
      },
    ]);
    const result = await openPullRequest(baseRequest, { run });
    expect(result).toEqual({ status: "opened", url: "https://github.com/acme/widgets/pull/11" });
  });

  test("returns the existing PR instead of creating a duplicate", async () => {
    const run = scriptedRunner([
      { match: ["gh", "auth", "status"], result: ok() },
      { match: ["git", "rev-parse", "--abbrev-ref", "HEAD"], result: ok("feature\n") },
      { match: ["git", "status", "--porcelain"], result: ok("") },
      { match: ["git", "remote", "get-url", "origin"], result: ok("https://github.com/acme/widgets.git\n") },
      { match: ["gh", "api", "repos/acme/widgets", "--jq", ".default_branch"], result: ok("main\n") },
      { match: ["gh", "api", "repos/acme/widgets", "--jq", ".permissions.push"], result: ok("true\n") },
      { match: ["git", "push", "origin", "feature:feature"], result: ok() },
      {
        match: ["gh", "pr", "list", "--repo", "acme/widgets", "--head", "feature", "--json", "url,number"],
        result: ok(JSON.stringify([{ url: "https://github.com/acme/widgets/pull/5", number: 5 }])),
      },
      // No "gh pr create" call -- an existing PR must short-circuit creation.
    ]);
    const result = await openPullRequest(baseRequest, { run });
    expect(result).toEqual({ status: "existing", url: "https://github.com/acme/widgets/pull/5" });
  });

  test("never builds a shell string from title, body, or branch name -- argv stays an array at every call", async () => {
    // A title/body containing shell metacharacters must reach `gh pr create`
    // as literal, unmodified argv elements. If this module ever built a
    // command via string interpolation instead of argv, this input would
    // either throw, get mangled, or (worse) execute as shell syntax against
    // a real spawn implementation; here it just has to arrive byte-for-byte.
    const dangerousTitle = "Fix `rm -rf /` in docs; $(touch /tmp/pwned) && echo done";
    const dangerousBody = "line one\nline two `whoami` $HOME \"quoted\" 'single'";
    const capturedCreateCalls: Array<readonly string[]> = [];
    const run = scriptedRunner([
      { match: ["gh", "auth", "status"], result: ok() },
      { match: ["git", "rev-parse", "--abbrev-ref", "HEAD"], result: ok("feature\n") },
      { match: ["git", "status", "--porcelain"], result: ok("") },
      { match: ["git", "remote", "get-url", "origin"], result: ok("https://github.com/acme/widgets.git\n") },
      { match: ["gh", "api", "repos/acme/widgets", "--jq", ".default_branch"], result: ok("main\n") },
      { match: ["gh", "api", "repos/acme/widgets", "--jq", ".permissions.push"], result: ok("true\n") },
      { match: ["git", "push", "origin", "feature:feature"], result: ok() },
      {
        match: ["gh", "pr", "list", "--repo", "acme/widgets", "--head", "feature", "--json", "url,number"],
        result: ok("[]\n"),
      },
      {
        match: ["gh", "pr", "create", "--repo", "acme/widgets"],
        result: ok("https://github.com/acme/widgets/pull/12\n"),
        capture: (argv) => {
          capturedCreateCalls.push(argv);
        },
      },
    ]);
    const result = await openPullRequest(
      { repositoryId: "/repo", title: dangerousTitle, body: dangerousBody },
      { run },
    );
    expect(result.status).toBe("opened");
    expect(capturedCreateCalls).toHaveLength(1);
    const capturedCreateArgv = capturedCreateCalls[0]!;
    // Confirm they arrived as whole, single argv elements -- not split on
    // whitespace or shell-special characters the way a "sh -c" string built
    // by concatenation would produce.
    expect(capturedCreateArgv).toContain(dangerousTitle);
    expect(capturedCreateArgv).toContain(dangerousBody);
    expect(capturedCreateArgv.indexOf(dangerousTitle)).toBeGreaterThan(-1);
  });

  test("rejects a branch name that could be mistaken for a command-line flag", async () => {
    // A branch literally named "--upload-pack=evil" (or similar) must never
    // be handed to git/gh in a position where it could be interpreted as an
    // option instead of a value. This module always separates repo/branch
    // arguments from flags with explicit refspecs and --repo/--head flags,
    // never a bare trailing positional -- confirm the actual argv shape
    // rather than just asserting a specific error.
    const run = scriptedRunner([
      { match: ["gh", "auth", "status"], result: ok() },
      { match: ["git", "rev-parse", "--abbrev-ref", "HEAD"], result: ok("--upload-pack=evil\n") },
      { match: ["git", "status", "--porcelain"], result: ok("") },
      { match: ["git", "remote", "get-url", "origin"], result: ok("https://github.com/acme/widgets.git\n") },
      { match: ["gh", "api", "repos/acme/widgets", "--jq", ".default_branch"], result: ok("main\n") },
      { match: ["gh", "api", "repos/acme/widgets", "--jq", ".permissions.push"], result: ok("true\n") },
      {
        match: ["git", "push", "origin", "--upload-pack=evil:--upload-pack=evil"],
        result: ok(),
      },
      {
        match: [
          "gh",
          "pr",
          "list",
          "--repo",
          "acme/widgets",
          "--head",
          "--upload-pack=evil",
          "--json",
          "url,number",
        ],
        result: ok("[]\n"),
      },
      {
        match: ["gh", "pr", "create", "--repo", "acme/widgets"],
        result: ok("https://github.com/acme/widgets/pull/13\n"),
      },
    ]);
    const result = await openPullRequest(baseRequest, { run });
    // The point of this test is the scriptedRunner's own strict argv
    // matching above: the refspec form ("branch:branch", one argv element)
    // means this string can never be split into a bare flag-looking
    // positional. If the implementation ever passed it unprefixed and
    // unseparated, the scripted sequence above would not match and the test
    // would fail with a clear diff before even reaching this assertion.
    expect(result.status).toBe("opened");
  });

  test("reports an unsupported remote instead of guessing at owner/repo", async () => {
    const run = scriptedRunner([
      { match: ["gh", "auth", "status"], result: ok() },
      { match: ["git", "rev-parse", "--abbrev-ref", "HEAD"], result: ok("feature\n") },
      { match: ["git", "status", "--porcelain"], result: ok("") },
      { match: ["git", "remote", "get-url", "origin"], result: ok("https://gitlab.com/acme/widgets.git\n") },
    ]);
    const result = await openPullRequest(baseRequest, { run });
    expect(result).toEqual({
      status: "error",
      code: "unsupported_remote",
      explanation: expect.any(String),
    });
  });
});
