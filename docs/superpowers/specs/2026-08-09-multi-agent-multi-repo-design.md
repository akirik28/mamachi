# Multi-agent + multi-repo (with PR opening) — design

Status: approved (owner decided; see "Process note" below). Author: Claude, case-study submission.

## 1. Scope

Two features, shipped as two PRs:

1. **Multi-agent** — run N concurrent coding tasks instead of one. One voice
   conversation; N background tasks the user can create, switch between, and
   steer by name.
2. **Multi-repo + PR opening** — each concurrent task can target a different
   repository, and a task can push its branch and open a pull request through
   an explicit, approved action.

Out of scope (declined, not attempted): a Windows/Linux port, Grok speech-to-speech
integration. Rationale in §7.

## 2. Process note — this conflicts with the product's own non-goals

`docs/product-requirements.md` §6.1 lists **"One active coding task and a
global queue"** as an explicit goal, and §6.2 lists **"Multiple simultaneous
mutating coding jobs"** and **"Automatic branches, commits, pull requests, or
worktree merging"** as explicit non-goals. `CONTRIBUTING.md` also says any
change to the state machine, policy ladder, or voice tool surface "should
start as an issue so we can agree on the shape first," not go straight to a
PR.

This design deliberately does what the PRD says not to. That's the case-study
assignment, not a misreading of the repo. Two things keep this defensible
rather than reckless:

- **"Automatic" is the word being violated on purpose, not "possible."** Every
  new capability here (a second concurrent task, a pull request) requires an
  explicit user action — a voice command that names a new task, or a tap on an
  approval card. Nothing runs unattended. The non-goal is about unattended
  action; this design doesn't add any.
- **Ground rule "the voice model never codes... no shell, filesystem, git,
  edit, or generic MCP tools"** (`CONTRIBUTING.md`) is honored, not bent: the
  new `open_pull_request` voice tool takes a title/body/task id, nothing else.
  It cannot run arbitrary git. The mechanics live entirely on the host side.

The PR descriptions call this out explicitly rather than pretending the
conflict doesn't exist.

## 3. Multi-agent: concurrency via multiple runner instances, not rewritten runners

### The finding that shapes this

The single-task invariant is enforced at exactly four layers:
`domain.ts` (`activeTaskId: string | null`, hard-throw on a second
`task.started`), `controller.ts` (14 call sites asserting `=== activeTaskId`),
and inside **each** backend runner (`OmpRunner#session`/`#taskId`,
`ExternalCliRunner#process`/`#taskId`) as private scalar fields.

The naive fix — turn every `#session`/`#process`/`#taskId` field inside
`OmpRunner` and `ExternalCliRunner` into a `Map<taskId, …>` — touches two
~700–1100 line classes full of `#field` state and would risk exactly the kind
of subtle cross-task bleed a security-conscious app can't afford.

**Decision: don't touch the runners' internals at all.** Each backend runner
class already correctly assumes "I manage exactly one task." Keep that
assumption true by giving each *concurrent* task its own runner **instance**,
instead of making one instance juggle many tasks.

- `domain.ts`: `activeTaskId: string | null` → `activeTaskIds: readonly string[]`
  (cap `MAX_CONCURRENT_TASKS = 4`, reject the 5th with a typed error the same
  way the 2nd is rejected today). Additional invariant: **at most one active
  task per `repositoryId`** — two agents must never write the same working
  tree concurrently (this is the one thing the existing "no simultaneous
  mutating jobs" non-goal is actually protecting against, and it's still a
  real hazard once multi-repo is added, so it stays enforced, just keyed by
  repo instead of globally).
- `controller.ts`: the 14 `!== activeTaskId` guards become
  `!activeTaskIds.includes(...)`.
- `coding-runner.ts`: `CodingRunner` already builds its three backend runners
  eagerly into `#runners: Record<CodingBackend, CodingBackendRunner>`. Change
  this to `#runners: Map<taskId, CodingBackendRunner>`, constructed on demand
  in the `task.started`/`task.resumed` handler and disposed on the task's
  terminal event. Each map entry is a fresh `OmpRunner`/`ExternalCliRunner`
  instance — internally unchanged, still single-task-safe by construction.

Net effect: the diff is concentrated in the two files that own the invariant
(`domain.ts`, `controller.ts`) plus the dispatcher (`coding-runner.ts`). The
two heaviest files in the coding-backend layer are untouched, so their
existing test suites (`external-cli-runner.test.ts`,
`omp-runner` tests) keep validating single-task correctness unmodified, and
new tests only need to prove instance isolation, not re-prove runner
internals.

### UI (Swift) — smaller than it looks

`TaskDrawerView` already renders `tasks: [TaskViewState]` as a list and
`queue: [String]` as an ordered "up next" list, and `AppModel.confirmations`
already renders as a list (`pendingConfirmations.prefix(3)`, multiple cards
at once). The only genuinely singular concept is `activeTaskId` — "which task
is focused in the compact pill and gets voice." That stays singular by
design (§1: one voice channel), but the list views need one change: tapping a
non-terminal task row in `TaskDrawerView`/history sets it as the new
`activeTaskId` (today `focusTask` is `activeTask ?? tasks.last`, effectively
read-only). Pill/menu-bar text changes from one status string to "N running"
with the focused task's headline.

No new panel, no new window, no new tab. This is the smallest change that
makes N concurrently-running tasks legible.

## 4. Multi-repo: a set of open workspaces, not one

`MamachiIpcServer#workspace: string` is a single slot; `task.submit` rejects
any `repositoryId` that doesn't match it (`workspace_mismatch`). The Swift
side already has the exact UX affordance needed — `AppModel` opens an
`NSOpenPanel` and sends `workspace.select` — it just replaces the slot instead
of adding to a set.

- `#workspace: string` → `#workspaces: Set<string>` (realpath-normalized).
  `workspace.select` **adds** (new IPC intent name: keep `workspace.select`
  behavior additive rather than introduce a new request type, since
  `CONTRIBUTING.md` flags new IPC request types as a 3-edit, easy-to-get-wrong
  change — reuse instead of add where the semantics allow it).
  `workspace.focus` (VS Code) keeps replacing a separate `#focusedWorkspace`
  used only for the editor-context path, since that one *is* inherently
  single-root per VS Code window.
- `task.submit` validates `repositoryId ∈ #workspaces` instead of
  `=== #workspace`.
- `getAvailableWorkspaces()` (`daemon.ts:207`, fed to the voice model) returns
  the full set instead of a 1-element array — this is what actually lets the
  voice model say "start a task in the billing repo" and mean something.
- Swift: `RepositoryChip` (single) becomes a small menu over the open-workspace
  set; folder-picker flow unchanged.

Combined with §3's per-repo mutex, this gives real concurrent multi-repo work:
N tasks, each pinned to a distinct repository, running at once.

## 5. Pull request opening

### Where it does *not* run

Not inside the sandboxed coding-agent child process. Two independent reasons,
both found in the existing code, not assumed:

- `sensitiveChildEnvironmentKeys` (`external-cli-runner.ts`) deliberately
  strips `GITHUB_TOKEN` from the child's environment before spawn. Restoring
  it just for this feature weakens a boundary the codebase treats as
  load-bearing ("external agent boundaries", commit `ebcb3a4`).
- Even in the one existing escalation path that permits git writes
  (`taskAllowsGitMetadataWrite`), the task prompt still says *"Do not switch
  branches, publish, deploy, or access credentials"* — unconditionally. There
  is no existing configuration that lets the child publish anything.

### Where it does run

Host-side, in the daemon process — the same trust level `workspace-guard.ts`
already uses for `git ls-files`/`git status`. New module
`packages/core/src/pull-request.ts`:

```ts
openPullRequest(repositoryId: string, title: string, body: string): Promise<{url: string}>
```

Runs `git push -u origin <current-branch>` then `gh pr create --title --body
--head` with `cwd: repositoryId`, using whatever `gh`/git credentials already
exist in the daemon's own (unscrubbed) environment — the same credentials the
user would use running `gh pr create` themselves. No new credential storage.

### How it's invoked and gated

New voice tool `open_pull_request(taskId, title, body)` in `voice-toolkit.ts`
— three string arguments, nothing that resembles a shell command, matching
the "structured, narrow" shape of every other voice tool. `execute()` does
**not** call `openPullRequest` directly; it raises the same kind of
confirmation record the existing `computer.confirmation_required` /
`ConfirmationViewState` path uses (`AppModel.swift` already renders N pending
approval cards today). The card reads "Push branch `<branch>` and open a pull
request to `<repo>`: `<title>`." Only on approval
(`resolveConfirmation(decision: "approve")`) does the host run
`openPullRequest`. Denial or dismissal is a no-op — the local commits are
untouched either way.

`policy.ts`'s `publicationPattern` gets one addition,
`\bgh\s+pr\s+create\b`, so that if a *coding agent* ever tries to run this
command directly under a future/misconfigured escalation, it still hits
`visual_approval` instead of running silently. Defense in depth, not the
primary gate (the primary gate is that the agent has no path to `gh` credentials
at all, per above).

### Exact confirmation wiring

The precise call site that turns a `policy.ts` `visual_approval` tier into a
`ConfirmationViewState` the Swift app renders is confirmed during
implementation planning, not guessed here — the design constraint is "reuse
that exact path," not "build a second one."

## 6. Testing

- `domain.test.ts` / `controller.test.ts`: N concurrent tasks across distinct
  repos succeed; a 2nd task on the *same* `repositoryId` while one is active
  is rejected; the `MAX_CONCURRENT_TASKS + 1`'th task is rejected/queued;
  existing single-task tests keep passing unmodified (they're a subset of the
  new behavior with N=1).
- `coding-runner.test.ts`: two tasks on different backends (or the same
  backend) produce two independent runner instances; disposing one doesn't
  touch the other.
- `ipc-server.test.ts`: `workspace.select` is additive; `task.submit` accepts
  any `repositoryId` in the open set and rejects one outside it.
- `pull-request.test.ts`: the host function shells the right two commands with
  the right cwd (using the existing `ProcessRunner` test seam, no real
  network); confirmation-required and confirmation-denied paths never call it.
- `policy.test.ts`: `gh pr create` now asserts `visual_approval`.
- Swift: `TaskDrawerView` tap-to-focus on a non-terminal row; pill text with
  N running tasks; existing single-task snapshot tests unchanged.

Everything above runs with no OpenAI key (confirmed: `bun run check` has no
provider dependency; the map found no test reads `OPENAI_API_KEY`). A live
voice smoke test is noted as pending the key in the PR description rather than
claimed.

## 7. Declined bonuses

- **Windows/Linux port**: PRD non-goal, no access to a Windows environment,
  and the app is SwiftUI/AppKit + Keychain end to end — "lightweight" isn't a
  real option here, it's a rewrite of the entire `apps/macos` surface in a
  different toolkit. Skipped.
- **Grok speech-to-speech**: the extension lane genuinely is cheap
  (`voice-bridge.ts` is a clean 12-member contract, `CONTRIBUTING.md` §"Extension
  lane 2" documents the exact steps). Skipped anyway because it can't be
  verified — no xAI key, and shipping an unverified realtime-transport
  integration contradicts "make sure it works" more than skipping it does.

## 8. PR split

- **PR 1 (multi-agent)**: §3 only, against `mamachi`. Self-contained and
  provable with N=2 tasks against two directories under the existing test
  fixtures — multi-repo's IPC/workspace-set change (§4) isn't required to
  demonstrate concurrency, only to make the *second* directory reachable from
  the running app instead of just from a test harness.
- **PR 2 (multi-repo + PR opening)**: §4 + §5, branches from PR 1. Bundled
  together because the case-study brief bundles them ("aynı anda birkaç
  repo... ve pull request açabilme" is one bullet), and because §5 has no
  purpose without §4.
