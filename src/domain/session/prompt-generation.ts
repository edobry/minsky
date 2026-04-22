/**
 * Session Prompt Generation
 *
 * Generates complete, correct subagent prompt strings for session work.
 */

export type PromptType = "implementation" | "refactor" | "review" | "cleanup" | "audit";

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
  batches?: GeneratePromptResult[]; // populated when scope > SCOPE_WARNING_THRESHOLD
  batchIndex?: number; // 1-based index of this batch
  totalBatches?: number; // total number of batches
}

const SCOPE_WARNING_THRESHOLD = 40;
const BATCH_SIZE = 30;
export const PROMPT_WATERMARK = "<!-- minsky:prompt:v1 -->";

const SKILL_REFERENCES: Record<PromptType, string[]> = {
  implementation: ["implement-task", "prepare-pr", "testing-guide", "error-handling"],
  refactor: ["code-organization", "testing-guide"],
  review: ["review-pr"],
  cleanup: ["code-organization", "fix-skipped-tests"],
  audit: [],
};

function renderSkillReferences(type: PromptType): string {
  const skills = SKILL_REFERENCES[type];
  if (skills.length === 0) return "";
  return `
## Recommended Skills

The following Claude Code skills are available and relevant to this work. Use \`/skill-name\` to invoke:
${skills.map((s) => `- \`/${s}\``).join("\n")}`;
}

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

function renderSessionExecNote(taskId: string): string {
  return `
## Running commands in the session

Use \`mcp__minsky__session_exec(task: "mt#${taskId}", command: "<cmd>")\` to run shell commands inside the session workspace (e.g., \`bun test\`, \`bun run format:check\`, \`git status\`). The session directory is resolved automatically — never use \`git -C <path>\` or shell \`cd\` workarounds.`;
}

function generateSinglePrompt(
  params: GeneratePromptParams,
  batchScope?: string[],
  batchIndex?: number,
  totalBatches?: number
): string {
  const { type, scope, sessionId, taskId } = params;
  const effectiveScope = batchScope ?? scope;

  const sections: string[] = [];

  const header = renderCommonHeader(params);
  if (batchIndex !== undefined && totalBatches !== undefined) {
    sections.push(`${header}\n\n**Batch ${batchIndex} of ${totalBatches}**`);
  } else {
    sections.push(header);
  }

  const skillRefs = renderSkillReferences(type);
  if (skillRefs) {
    sections.push(skillRefs);
  }

  if (effectiveScope && effectiveScope.length > 0) {
    sections.push(renderScopeSection(effectiveScope));
  }

  if (type === "review") {
    sections.push(`
## Review Instructions

Report findings as structured output. Do NOT make any changes.`);
    sections.push(renderToolingNote());
    sections.push(`\n${PROMPT_WATERMARK}`);
    return sections.join("\n");
  }

  if (type === "audit") {
    sections.push(`
## Audit Instructions

Verify the merged changes against the task spec. For each success criterion, check whether the code actually delivers it. Report structured findings as:
- **Met** — criterion satisfied, with file:line evidence
- **Not met** — criterion not delivered
- **Not applicable** — criterion stale or already satisfied`);
    sections.push(renderToolingNote());
    sections.push(`\n${PROMPT_WATERMARK}`);
    return sections.join("\n");
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

  if (batchIndex !== undefined && totalBatches !== undefined && batchIndex < totalBatches) {
    sections.push(`
## Intermediate Commit

Commit this batch before proceeding to the next.
- Tool: \`mcp__minsky__session_commit\`
- Parameters: \`sessionId: "${sessionId}"\`, \`all: true\``);
  } else {
    sections.push(renderSessionExecNote(taskId));
    sections.push(renderCommitInstructions(sessionId, taskId));
  }

  sections.push(renderToolingNote());
  sections.push(`\n${PROMPT_WATERMARK}`);

  return sections.join("\n");
}

export function generateSubagentPrompt(params: GeneratePromptParams): GeneratePromptResult {
  const { type, scope } = params;

  const needsBatching = scope && scope.length > SCOPE_WARNING_THRESHOLD;

  if (needsBatching) {
    const scopeWarning = `Scope has ${scope.length} files (exceeds ${SCOPE_WARNING_THRESHOLD}). Using batching into chunks of ${BATCH_SIZE} files for subagent capacity.`;

    // Split scope into chunks of BATCH_SIZE
    const chunks: string[][] = [];
    for (let i = 0; i < scope.length; i += BATCH_SIZE) {
      chunks.push(scope.slice(i, i + BATCH_SIZE));
    }
    const totalBatches = chunks.length;

    let firstBatchPrompt = "";

    const batches: GeneratePromptResult[] = chunks.map((chunk, idx) => {
      const batchIndex = idx + 1;
      const prompt = generateSinglePrompt(params, chunk, batchIndex, totalBatches);
      if (batchIndex === 1) {
        firstBatchPrompt = prompt;
      }
      const batchResult: GeneratePromptResult = {
        prompt,
        suggestedModel: "sonnet",
        batchIndex,
        totalBatches,
        scopeWarning,
      };
      if (type === "refactor") {
        batchResult.suggestedSubagentType = "refactor";
      }
      return batchResult;
    });

    const result: GeneratePromptResult = {
      prompt: firstBatchPrompt,
      suggestedModel: "sonnet",
      scopeWarning,
      batches,
    };

    if (type === "refactor") {
      result.suggestedSubagentType = "refactor";
    }

    return result;
  }

  const prompt = generateSinglePrompt(params);

  if (type === "review") {
    return {
      prompt,
      suggestedModel: "sonnet",
    };
  }

  if (type === "audit") {
    return {
      prompt,
      suggestedModel: "sonnet",
      suggestedSubagentType: "verify-completion",
    };
  }

  const result: GeneratePromptResult = {
    prompt,
    suggestedModel: "sonnet",
  };

  if (type === "refactor") {
    result.suggestedSubagentType = "refactor";
  }

  return result;
}
