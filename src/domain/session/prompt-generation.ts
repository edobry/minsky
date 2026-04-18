/**
 * Session Prompt Generation
 *
 * Generates complete, correct subagent prompt strings for session work.
 */

export type PromptType = "implementation" | "refactor" | "review" | "cleanup";

export interface GeneratePromptParams {
  sessionDir: string;
  sessionId: string;
  taskId: string;
  type: PromptType;
  instructions: string;
  scope?: string[];
}

export interface GeneratePromptResult {
  prompt: string;
  suggestedSubagentType?: string;
  suggestedModel?: string;
  scopeWarning?: string;
}

const SCOPE_WARNING_THRESHOLD = 40;

function renderCommonHeader(params: GeneratePromptParams): string {
  return `You are working in Minsky session at ${params.sessionDir}. All file paths MUST be absolute paths under this directory.

Task mt#${params.taskId}: ${params.type.charAt(0).toUpperCase() + params.type.slice(1)} work

${params.instructions}`;
}

function renderScopeSection(scope: string[]): string {
  return `
## Scope Constraints

Only modify the following files:
${scope.map((f) => `- ${f}`).join("\n")}`;
}

function renderCommitInstructions(sessionId: string, taskId: string): string {
  return `
## Committing Your Work

When your changes are ready, commit using:
- Tool: \`mcp__minsky__session_commit\`
- Parameters: \`sessionId: "${sessionId}"\`, \`all: true\`

## Creating a Pull Request

After committing, create a PR using:
- Tool: \`mcp__minsky__session_pr_create\`
- Parameters: \`task: "mt#${taskId}"\`

Do NOT merge the PR.`;
}

function renderToolingNote(): string {
  return `
## Important

Do NOT run Bash commands for formatting, linting, type-checking, or tests — the pre-commit hooks handle all of that.`;
}

export function generateSubagentPrompt(params: GeneratePromptParams): GeneratePromptResult {
  const { type, scope, sessionId, taskId } = params;

  const scopeWarning =
    scope && scope.length > SCOPE_WARNING_THRESHOLD
      ? `Scope has ${scope.length} files (exceeds ${SCOPE_WARNING_THRESHOLD}). Consider batching into multiple smaller tasks to stay within subagent capacity limits.`
      : undefined;

  const sections: string[] = [renderCommonHeader(params)];

  if (scope && scope.length > 0) {
    sections.push(renderScopeSection(scope));
  }

  if (type === "review") {
    sections.push(`
## Review Instructions

Report findings as structured output. Do NOT make any changes.`);
    sections.push(renderToolingNote());

    return {
      prompt: sections.join("\n"),
      suggestedModel: "sonnet",
      scopeWarning,
    };
  }

  if (type === "refactor") {
    sections.push(`
## Coherence Verification

After making changes, re-read each modified file end-to-end and verify: no stale comments, no dead exports, no orphan code.`);
  }

  if (type === "cleanup") {
    sections.push(`
## Batching Guidance

For large scopes, commit after each batch of ~10 files rather than all at once.`);
  }

  sections.push(renderCommitInstructions(sessionId, taskId));
  sections.push(renderToolingNote());

  const result: GeneratePromptResult = {
    prompt: sections.join("\n"),
    suggestedModel: "sonnet",
    scopeWarning,
  };

  if (type === "refactor") {
    result.suggestedSubagentType = "refactor";
  }

  return result;
}
