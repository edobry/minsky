/**
 * Task Prompt Generation
 *
 * Generates context-rich prompts for AI-assisted task operations.
 * Follows the session/prompt-generation.ts pattern: gather context,
 * pair it with intent, return a prompt that works whether executed
 * by an agent harness or Minsky's own agent loop.
 */

export type TaskPromptType = "decompose" | "estimate" | "analyze";

export interface TaskContext {
  taskId: string;
  title: string;
  status: string;
  spec?: string;
  children: Array<{ id: string; title: string; status: string }>;
  dependencies: string[];
  dependents: string[];
  parent?: string;
  similarTasks: Array<{ id: string; title: string; status: string; score: number }>;
}

export interface TaskPromptResult {
  context: TaskContext;
  prompt: string;
  suggestedModel: string;
  promptType: TaskPromptType;
}

export const TASK_PROMPT_WATERMARK = "<!-- minsky:task-prompt:v1 -->";

function renderContext(ctx: TaskContext): string {
  const sections: string[] = [];

  sections.push(`## Task: ${ctx.taskId}`);
  sections.push(`**Title:** ${ctx.title}`);
  sections.push(`**Status:** ${ctx.status}`);
  if (ctx.parent) {
    sections.push(`**Parent:** ${ctx.parent}`);
  }

  if (ctx.spec) {
    sections.push("");
    sections.push("### Specification");
    sections.push(ctx.spec);
  } else {
    sections.push("");
    sections.push("### Specification");
    sections.push("*(No spec content available)*");
  }

  if (ctx.children.length > 0) {
    sections.push("");
    sections.push("### Existing Subtasks");
    for (const child of ctx.children) {
      sections.push(`- ${child.id}: ${child.title} [${child.status}]`);
    }
  }

  if (ctx.dependencies.length > 0) {
    sections.push("");
    sections.push(`### Dependencies (${ctx.taskId} depends on)`);
    sections.push(ctx.dependencies.map((d) => `- ${d}`).join("\n"));
  }

  if (ctx.dependents.length > 0) {
    sections.push("");
    sections.push(`### Dependents (depend on ${ctx.taskId})`);
    sections.push(ctx.dependents.map((d) => `- ${d}`).join("\n"));
  }

  if (ctx.similarTasks.length > 0) {
    sections.push("");
    sections.push("### Similar Tasks (for reference)");
    for (const sim of ctx.similarTasks) {
      sections.push(`- ${sim.id}: ${sim.title} [${sim.status}]`);
    }
  }

  return sections.join("\n");
}

export function generateDecomposePrompt(ctx: TaskContext): TaskPromptResult {
  const contextText = renderContext(ctx);

  const prompt = `# Task Decomposition

${contextText}

## Intent

Decompose this task into subtasks. Each subtask should be:
- A concrete, independently implementable piece of work
- Small enough for one session/PR (aim for 2-4 hours each)
- Clearly scoped with its own success criteria

${ctx.children.length > 0 ? `This task already has ${ctx.children.length} subtask(s). Review them and determine if additional decomposition is needed, or if existing subtasks need refinement.` : "This task has no subtasks yet."}

## How to Create Subtasks

For each subtask, use:
\`\`\`
mcp__minsky__tasks_create(
  title: "<subtask title>",
  parent: "${ctx.taskId}",
  spec: "<brief spec with success criteria>"
)
\`\`\`

After creating subtasks, add dependency edges between them if ordering matters:
\`\`\`
mcp__minsky__tasks_deps_add(task: "<later-task>", dependsOn: "<earlier-task>")
\`\`\`

## Guidelines

- Name subtasks by deliverable, not by activity ("Add parent-child edges" not "Work on graph")
- Each subtask should be testable — include success criteria in the spec
- Consider: what can be parallelized? What must be sequential?
- If the task spec is vague, note what needs clarification before decomposing
- For reference, find similar completed tasks: \`mcp__minsky__tasks_similar(taskId: "${ctx.taskId}")\`

${TASK_PROMPT_WATERMARK}`;

  return {
    context: ctx,
    prompt,
    suggestedModel: "opus",
    promptType: "decompose",
  };
}

export function generateEstimatePrompt(ctx: TaskContext): TaskPromptResult {
  const contextText = renderContext(ctx);

  const prompt = `# Task Estimation

${contextText}

## Intent

Estimate the complexity and effort for this task.

## Framework

Rate on this scale:
- **XS** (< 1 hour): Single-file change, mechanical fix
- **S** (1-2 hours): Small feature, 2-3 files, clear approach
- **M** (2-4 hours): Multi-file change, some design decisions
- **L** (4-8 hours): Significant feature, needs decomposition if not already done
- **XL** (8+ hours): Major effort, should definitely be decomposed into subtasks

## Consider

- How many files will be touched?
- Are there design decisions to make, or is the approach clear?
- Are there dependencies that need to be resolved first?
- How similar is this to the reference tasks listed above?
${ctx.children.length > 0 ? `- This task has ${ctx.children.length} subtask(s) — estimate the remaining work, not the total.` : ""}

Provide your estimate with a brief rationale.

${TASK_PROMPT_WATERMARK}`;

  return {
    context: ctx,
    prompt,
    suggestedModel: "sonnet",
    promptType: "estimate",
  };
}

export function generateAnalyzePrompt(ctx: TaskContext): TaskPromptResult {
  const contextText = renderContext(ctx);

  const hasSpec = !!ctx.spec;
  const specLength = ctx.spec?.length ?? 0;
  const hasSuccessCriteria = ctx.spec?.includes("Success Criteria") ?? false;
  const hasAcceptanceTests = ctx.spec?.includes("Acceptance Test") ?? false;
  const hasScope = ctx.spec?.includes("Scope") ?? false;

  const prompt = `# Task Analysis

${contextText}

## Intent

Analyze this task for completeness, readiness, and potential issues.

## Spec Quality Check

| Section | Present |
|---|---|
| Spec content | ${hasSpec ? `Yes (${specLength} chars)` : "**MISSING**"} |
| Success Criteria | ${hasSuccessCriteria ? "Yes" : "**MISSING**"} |
| Acceptance Tests | ${hasAcceptanceTests ? "Yes" : "**MISSING**"} |
| Scope | ${hasScope ? "Yes" : "**MISSING**"} |

## Analyze For

1. **Completeness** — Is the spec detailed enough to implement without ambiguity?
2. **Staleness** — Does the spec reference files, APIs, or patterns that no longer exist?
3. **Readiness** — Are all dependencies met? Are there unstated prerequisites?
4. **Scope** — Is the task appropriately sized? Should it be decomposed?
5. **Risk** — What could go wrong? Are there edge cases the spec doesn't address?

Provide your analysis with specific findings and recommendations.

${TASK_PROMPT_WATERMARK}`;

  return {
    context: ctx,
    prompt,
    suggestedModel: "sonnet",
    promptType: "analyze",
  };
}
