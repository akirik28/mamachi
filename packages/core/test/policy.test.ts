import { describe, expect, test } from "bun:test";
import { assessToolCall } from "../src/policy.ts";

const repository = "/tmp/mamachi-policy-workspace";

describe("assessToolCall", () => {
  test("allows routine in-repository work without approval", () => {
    const assessment = assessToolCall("write", { path: "src/app.ts", content: "export {};" }, repository);

    expect(assessment.tier).toBe("automatic");
    expect(assessment.category).toBe("routine");
  });

  test("requires exact approval for external and out-of-repository effects", () => {
    const publication = assessToolCall("bash", { command: "git push origin main" }, repository);
    const outsideWrite = assessToolCall("write", { path: "/tmp/other/file.ts", content: "unsafe" }, repository);
    const outsideEdit = assessToolCall(
      "edit",
      { patch: "*** Begin Patch\n[/tmp/other/file.ts#ABCD]\nSWAP 1.=1:\n+unsafe\n*** End Patch\n" },
      repository,
    );
    const credential = assessToolCall("bash", { command: "printenv OPENAI_API_KEY" }, repository);

    expect(publication).toMatchObject({ tier: "visual_approval", category: "external_publication" });
    expect(outsideWrite).toMatchObject({ tier: "visual_approval", category: "outside_repository" });
    expect(outsideEdit).toMatchObject({ tier: "visual_approval", category: "outside_repository" });
    expect(credential).toMatchObject({ tier: "reject", category: "credential_access" });
    expect(publication.effectFingerprint).not.toBe(outsideWrite.effectFingerprint);
  });

  test("requires approval for gh pr create the same as any other publication command", () => {
    // Defense in depth: the coding agent has no path to gh/git credentials
    // (sensitiveChildEnvironmentKeys strips them before spawn) and its own
    // prompt unconditionally forbids publishing, so this should never
    // actually be reached from a running task -- but if a future escalation
    // ever did let a coding agent run `gh pr create` directly, it must still
    // require the same explicit approval as `git push` or `gh release
    // create`, not fall through to "automatic".
    const assessment = assessToolCall("bash", { command: "gh pr create --title x --body y" }, repository);
    expect(assessment).toMatchObject({ tier: "visual_approval", category: "external_publication" });
  });

  test("rejects commands that enumerate the daemon environment", () => {
    expect(assessToolCall("bash", { command: "env" }, repository))
      .toMatchObject({ tier: "reject", category: "credential_access" });
    expect(assessToolCall("bash", { command: "export -p" }, repository))
      .toMatchObject({ tier: "reject", category: "credential_access" });
    expect(assessToolCall("bash", { command: "echo $MAMACHI_TOKEN" }, repository))
      .toMatchObject({ tier: "reject", category: "credential_access" });
  });

  test("rejects catastrophic computer-wide commands even with approval", () => {
    const assessment = assessToolCall("bash", { command: "rm -rf /" }, repository);

    expect(assessment).toMatchObject({ tier: "reject", category: "unsupported" });
  });

  test("binds effect fingerprints to exact tool arguments", () => {
    const first = assessToolCall("bash", { command: "git push origin main" }, repository);
    const same = assessToolCall("bash", { command: "git push origin main" }, repository);
    const changed = assessToolCall("bash", { command: "git push origin release" }, repository);

    expect(same.effectFingerprint).toBe(first.effectFingerprint);
    expect(changed.effectFingerprint).not.toBe(first.effectFingerprint);
  });
});
