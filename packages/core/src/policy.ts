import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { extractToolPaths } from "./workspace-guard.ts";

export type PolicyTier = "automatic" | "visual_approval" | "reject";
export type PolicyCategory =
  | "routine"
  | "destructive_git"
  | "destructive_filesystem"
  | "credential_access"
  | "external_publication"
  | "deployment"
  | "purchase"
  | "outside_repository"
  | "unsupported";

export interface ToolPolicyAssessment {
  tier: PolicyTier;
  category: PolicyCategory;
  summary: string;
  effectFingerprint: string;
  toolName: string;
}

const catastrophicCommandPatterns = [
  /(?:^|[;&|]\s*)rm\s+(?:-[^\s]*[rf][^\s]*\s+)+\/(?:\s|$)/i,
  /(?:^|[;&|]\s*)(?:mkfs(?:\.[^\s]+)?|diskutil\s+eraseDisk)\b/i,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/,
];

const destructiveGitPattern = /\bgit\s+(?:reset\s+--hard|clean\b|restore\b|checkout\s+--|switch\b|branch\s+-D\b|rebase\b|commit\b|push\b|tag\s+-d\b)/i;
const destructiveFilesystemPattern = /(?:^|[;&|]\s*)(?:rm|rmdir|shred|truncate|dd|chmod\s+-R|chown\s+-R)\b|(?:^|[^>])>{1,2}\s*[^&]/i;
const credentialPattern = /(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|MAMACHI_(?:TOKEN|ENCRYPTION_KEY)|AWS_(?:ACCESS|SECRET)|GITHUB_TOKEN|\.env(?:\b|\/)|\.ssh\/|id_(?:rsa|ed25519)|security\s+find-(?:generic|internet)-password|(?:^|[;&|]\s*)(?:printenv|env|set|export)(?:\s|$))/i;
const publicationPattern = /\b(?:npm|bun|cargo|gem|pypi|twine)\s+publish\b|\bgh\s+(?:release\s+(?:create|upload)|pr\s+create)\b|\bgit\s+push\b/i;
const deploymentPattern = /\b(?:vercel|netlify|fly|railway|firebase)\s+(?:deploy|up)\b|\bkubectl\s+(?:apply|delete|replace)\b|\bterraform\s+(?:apply|destroy)\b|\baws\s+.*\bdeploy\b/i;
const purchasePattern = /\b(?:purchase|buy|checkout|place[- ]order|stripe\s+payment|confirmPayment)\b/i;
const outsideReadPattern = /(?:^|[;&|]\s*)(?:cat|less|more|head|tail|cp|mv)\s+([^;&|]+)/i;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function fingerprintToolEffect(toolName: string, input: unknown): string {
  return createHash("sha256").update(toolName).update("\0").update(canonicalJson(input)).digest("hex");
}


function isOutsideRepository(path: string, repository: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return false;
  const absolute = isAbsolute(path) ? resolve(path) : resolve(repository, path);
  const relation = relative(resolve(repository), absolute);
  return relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relation);
}


function assessment(
  tier: PolicyTier,
  category: PolicyCategory,
  summary: string,
  toolName: string,
  input: unknown,
): ToolPolicyAssessment {
  return { tier, category, summary, effectFingerprint: fingerprintToolEffect(toolName, input), toolName };
}

export function assessToolCall(toolName: string, input: unknown, repository: string): ToolPolicyAssessment {
  const details =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const command = typeof details["command"] === "string" ? details["command"] : "";

  if (catastrophicCommandPatterns.some((pattern) => pattern.test(command))) {
    return assessment(
      "reject",
      "unsupported",
      "Mamachi rejected a command that could irreversibly damage the computer",
      toolName,
      input,
    );
  }

  if (credentialPattern.test(command)) {
    return assessment(
      "reject",
      "credential_access",
      "Mamachi rejected a command that could expose credentials",
      toolName,
      input,
    );
  }
  if (purchasePattern.test(command)) {
    return assessment("visual_approval", "purchase", "Allow one action that may create a purchase or charge", toolName, input);
  }
  if (publicationPattern.test(command)) {
    return assessment(
      "visual_approval",
      "external_publication",
      "Allow one action that publishes repository content outside this computer",
      toolName,
      input,
    );
  }
  if (deploymentPattern.test(command)) {
    return assessment(
      "visual_approval",
      "deployment",
      "Allow one action that changes an external deployment or cloud environment",
      toolName,
      input,
    );
  }
  if (destructiveGitPattern.test(command)) {
    return assessment(
      "visual_approval",
      "destructive_git",
      "Allow one Git history or working-tree mutation outside Mamachi's normal edit flow",
      toolName,
      input,
    );
  }
  if (destructiveFilesystemPattern.test(command)) {
    return assessment(
      "visual_approval",
      "destructive_filesystem",
      "Allow one potentially destructive filesystem command",
      toolName,
      input,
    );
  }

  const cwd = details["cwd"];
  if (typeof cwd === "string" && isOutsideRepository(cwd, repository)) {
    return assessment(
      "visual_approval",
      "outside_repository",
      `Allow ${toolName} to execute outside the selected repository`,
      toolName,
      input,
    );
  }

  const outsidePath = extractToolPaths(input).find((path) => isOutsideRepository(path, repository));
  if (outsidePath) {
    return assessment(
      "visual_approval",
      "outside_repository",
      `Allow ${toolName} to access a path outside the selected repository: ${outsidePath}`,
      toolName,
      input,
    );
  }

  const outsideRead = command.match(outsideReadPattern)?.[1]?.trim().split(/\s+/)[0];
  if (outsideRead && (outsideRead.startsWith("/") || outsideRead.startsWith("~")) && isOutsideRepository(outsideRead, repository)) {
    return assessment(
      "visual_approval",
      "outside_repository",
      "Allow one shell command to access a path outside the selected repository",
      toolName,
      input,
    );
  }

  if (toolName === "browser") {
    const action = details["action"];
    const code = typeof details["code"] === "string" ? details["code"] : "";
    if (action === "run" && /\.(?:click|type|fill|uploadFile|select)\s*\(/.test(code)) {
      return assessment(
        "visual_approval",
        "external_publication",
        "Allow one interactive browser action with an external side effect",
        toolName,
        input,
      );
    }
  }

  return assessment("automatic", "routine", `Allow ${toolName} inside the selected repository`, toolName, input);
}
