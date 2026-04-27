/**
 * Session Prompt Generation
 *
 * Generates complete, correct subagent prompt strings for session work.
 *
 * Dual-path dispatch (mt#915):
 *   - Native harness (Claude Code): emits a lean prompt. The agent definition's
 *     `skills:` frontmatter is what loads skill content; we don't repeat it inline.
 *   - Standalone harness: reads the compiled agent definition at
 *     `.claude/agents/<agentType>.md`, follows its `skills` list, reads each
 *     `.claude/skills/<name>/SKILL.md`, and embeds the bodies inline so the
 *     downstream LLM has everything in one prompt.
 *   - Backward-compat fallback: when no agent definition is found on disk, emit
 *     the legacy `## Recommended Skills` section (slash-command references) so
 *     existing setups without compiled agents keep working.
 */

import { join } from "path";
import matter from "gray-matter";
import { readTextFileSync } from "../../utils/fs";
import { detectAgentHarness, type AgentHarness } from "../runtime/harness-detection";

export type PromptType = "implementation" | "refactor" | "review" | "cleanup" | "audit";

/**
 * 1:1 mapping from prompt type to compiled agent name (file at
 * `.claude/agents/<name>.md`). Drives both `agentType` emission and the
 * standalone-path skill lookup.
 */
export const PROMPT_TYPE_TO_AGENT_TYPE: Record<PromptType, string> = {
  implementation: "implementer",
  refactor: "refactorer",
  review: "reviewer",
  cleanup: "cleaner",
  audit: "auditor",
};

/**
 * Pluggable agent + skill loader. The default implementation reads from disk
 * (`.claude/agents/<name>.md` + `.claude/skills/<name>/SKILL.md`). Tests inject
 * an in-memory loader to keep them hermetic.
 */
export interface SkillLoader {
  /**
   * Returns the skill names declared in the agent definition's frontmatter.
   * Returns `null` if the agent definition cannot be located — the caller falls
   * back to the legacy `## Recommended Skills` references.
   */
  loadAgentSkillNames(agentType: string, workspacePath: string): string[] | null;
  /**
   * Returns the markdown body of the named skill (frontmatter stripped).
   * Returns `null` if the skill body cannot be located — the caller skips it.
   */
  loadSkillBody(skillName: string, workspacePath: string): string | null;
}

export interface GeneratePromptParams {
  sessionDir: string;
  sessionId: string;
  taskId: string;
  type: PromptType;
  instructions: string;
  scope?: string[];
  omitOperatingEnvelope?: boolean;
  /**
   * Override harness detection. When omitted, `detectAgentHarness()` is called.
   * Useful for tests and for callers that already know the target environment.
   */
  harness?: AgentHarness;
  /**
   * Workspace root used to resolve `.claude/agents/<type>.md` and
   * `.claude/skills/<name>/SKILL.md` on the standalone path. Defaults to
   * `process.cwd()`.
   */
  workspacePath?: string;
  /**
   * Inject a custom skill loader (test seam). Defaults to the filesystem-backed
   * loader, which reads from `<workspacePath>/.claude/agents` and
   * `<workspacePath>/.claude/skills`.
   */
  skillLoader?: SkillLoader;
}

export interface GeneratePromptResult {
  prompt: string;
  /** Harness the prompt was generated for. Always set. */
  harness: AgentHarness;
  /** Compiled-agent name (subagent_type for native dispatch). */
  agentType?: string;
  /** Skill names whose bodies were embedded inline. Empty on the lean path. */
  skillsEmbedded: string[];
  suggestedModel?: string;
  scopeWarning?: string;
  batches?: GeneratePromptResult[]; // populated when scope > SCOPE_WARNING_THRESHOLD
  batchIndex?: number; // 1-based index of this batch
  totalBatches?: number; // total number of batches
}

const SCOPE_WARNING_THRESHOLD = 40;
const BATCH_SIZE = 30;
export const PROMPT_WATERMARK = "<!-- minsky:prompt:v1 -->";
export const ENVELOPE_HEADER = "## Operating Envelope";
/** Section header for the lean-path fallback that lists `/skill-name` references. */
export const RECOMMENDED_SKILLS_HEADER = "## Recommended Skills";
/** Section header for the standalone-path inline skill embedding. */
export const EMBEDDED_SKILLS_HEADER = "## Embedded Skills";

/**
 * Backward-compat skill references used when no compiled agent definition is
 * found on disk. Keep in sync with the `skills:` frontmatter in
 * `.minsky/agents/<name>/agent.ts` for parity with the standalone path.
 */
const SKILL_REFERENCES: Record<PromptType, string[]> = {
  implementation: ["implement-task", "prepare-pr", "testing-guide", "error-handling"],
  refactor: ["code-organization", "testing-guide"],
  review: ["review-pr"],
  cleanup: ["code-organization", "fix-skipped-tests"],
  audit: [],
};

interface LoadedSkill {
  name: string;
  body: string;
}

/**
 * Default filesystem-backed loader. Reads compiled outputs from
 * `<workspacePath>/.claude/agents` and `<workspacePath>/.claude/skills`.
 * Both methods return `null` on missing-file (not throw) so callers can
 * apply their own fallback logic.
 */
const defaultSkillLoader: SkillLoader = {
  loadAgentSkillNames(agentType, workspacePath) {
    const agentPath = join(workspacePath, ".claude", "agents", `${agentType}.md`);
    let raw: string;
    try {
      raw = readTextFileSync(agentPath);
    } catch {
      return null;
    }
    const parsed = matter(raw);
    const declaredRaw = parsed.data["skills"];
    return Array.isArray(declaredRaw)
      ? declaredRaw.filter((s: unknown): s is string => typeof s === "string")
      : [];
  },
  loadSkillBody(skillName, workspacePath) {
    const skillPath = join(workspacePath, ".claude", "skills", skillName, "SKILL.md");
    try {
      const raw = readTextFileSync(skillPath);
      return matter(raw).content.trim();
    } catch {
      return null;
    }
  },
};

/**
 * Resolve the agent definition for `agentType` and load each referenced skill
 * body via the supplied loader. Returns `null` if the agent definition itself
 * cannot be located (caller falls back to legacy references). Skills declared
 * by the agent but missing on disk are silently skipped — they are additive
 * content, not invariants.
 */
function loadAgentSkills(
  agentType: string,
  workspacePath: string,
  loader: SkillLoader
): LoadedSkill[] | null {
  const declared = loader.loadAgentSkillNames(agentType, workspacePath);
  if (declared === null) return null;

  const loaded: LoadedSkill[] = [];
  for (const skillName of declared) {
    const body = loader.loadSkillBody(skillName, workspacePath);
    if (body !== null) {
      loaded.push({ name: skillName, body });
    }
  }
  return loaded;
}

function renderSkillReferences(skills: string[]): string {
  if (skills.length === 0) return "";
  return `
${RECOMMENDED_SKILLS_HEADER}

The following Claude Code skills are available and relevant to this work. Use \`/skill-name\` to invoke:
${skills.map((s) => `- \`/${s}\``).join("\n")}`;
}

function renderEmbeddedSkills(loaded: LoadedSkill[]): string {
  if (loaded.length === 0) return "";
  const sections = loaded.map((s) => `### Skill: ${s.name}\n\n${s.body}`).join("\n\n");
  return `
${EMBEDDED_SKILLS_HEADER}

The following skills are embedded inline. Apply them as if they were preloaded into context.

${sections}`;
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

function renderSubagentOperatingEnvelope(
  sessionId: string,
  taskId: string,
  readOnly: boolean
): string {
  if (readOnly) {
    return `
${ENVELOPE_HEADER}

You have a bounded tool-call budget per dispatch. Recent dispatches have cut off between 24 and 65 tool uses — typically with substantial investigation done but nothing handed off. To land softly:

**Budget awareness.** Hand off *before* you run out, not after. Don't save the summary for the end.

**Graceful exit.** When you sense pressure (output feels constrained, compaction warnings, budget near exhaustion), stop investigating new areas:
1. Write a handoff note to \`.minsky/sessions/${sessionId}/handoff.md\` with four fields:
   - **Done:** findings produced this dispatch
   - **In progress:** partial investigation, with file paths and line ranges
   - **Remaining:** what still needs reviewing
   - **Known issues:** concerns or blockers encountered
2. Exit early with a brief summary citing the handoff path

**Handoff path convention.** The canonical handoff location is \`.minsky/sessions/${sessionId}/handoff.md\`. Main-agent recovery reads this first — leaving it unwritten forces expensive re-investigation.`;
  }

  return `
${ENVELOPE_HEADER}

You have a bounded tool-call budget per dispatch. Recent dispatches have cut off between 24 and 65 tool uses — typically with substantial work done but uncommitted. To land softly:

**Budget awareness.** Commit or hand off *before* you run out, not after. Don't save the checkpoint for the end.

**Checkpoint cadence.** Commit after each new file ≥150 lines OR after 3 substantive edits. Use \`wip(mt#${taskId}): <what's done>\` for intermediate commits — the \`wip\` prefix signals in-progress state.

**Graceful exit.** When you sense pressure (output feels constrained, compaction warnings, budget near exhaustion), stop starting new work:
1. If code is modified, commit with \`wip(mt#${taskId}): <status>\` via \`mcp__minsky__session_commit\`
2. Write a handoff note to \`.minsky/sessions/${sessionId}/handoff.md\` with four fields:
   - **Done:** what shipped this dispatch
   - **In progress:** partial work, with file paths and line ranges
   - **Remaining:** what still needs doing
   - **Known issues:** bugs/blockers encountered
3. Exit early with a brief summary citing the handoff path

**Handoff path convention.** The canonical handoff location is \`.minsky/sessions/${sessionId}/handoff.md\`. Main-agent recovery reads this first — leaving it unwritten forces expensive state reconstruction from \`git diff\`.`;
}

function renderSessionExecNote(taskId: string): string {
  return `
## Running commands in the session

Use \`mcp__minsky__session_exec(task: "mt#${taskId}", command: "<cmd>")\` to run shell commands inside the session workspace (e.g., \`bun test\`, \`bun run format:check\`, \`git status\`). The session directory is resolved automatically — never use \`git -C <path>\` or shell \`cd\` workarounds.`;
}

interface SkillSectionPlan {
  /** Skill names embedded in the prompt body (empty on the lean path). */
  skillsEmbedded: string[];
  /** Pre-rendered section text inserted between header and scope (may be empty). */
  rendered: string;
}

/**
 * Decide what skill content (if any) to inject into the prompt for this
 * harness, and produce both the rendered string and the metadata list.
 *
 * - native harness → no inline skill section; harness preloads via agent def
 * - standalone harness with agent def found → embed skill bodies inline
 * - standalone harness without agent def → fall back to legacy `/skill-name`
 *   references (also empty `skillsEmbedded` since nothing is actually embedded)
 */
function planSkillSection(
  type: PromptType,
  harness: AgentHarness,
  workspacePath: string,
  loader: SkillLoader
): SkillSectionPlan {
  if (harness === "claude-code") {
    return { skillsEmbedded: [], rendered: "" };
  }

  const agentType = PROMPT_TYPE_TO_AGENT_TYPE[type];
  const loaded = loadAgentSkills(agentType, workspacePath, loader);

  if (loaded !== null && loaded.length > 0) {
    return {
      skillsEmbedded: loaded.map((s) => s.name),
      rendered: renderEmbeddedSkills(loaded),
    };
  }

  // Fallback: legacy references. Either no agent def on disk, or the agent
  // declared no skills — either way, point the standalone agent at the
  // available `/skill-name` shortcuts as a soft hint.
  return {
    skillsEmbedded: [],
    rendered: renderSkillReferences(SKILL_REFERENCES[type]),
  };
}

function generateSinglePrompt(
  params: GeneratePromptParams,
  skillSection: string,
  batchScope?: string[],
  batchIndex?: number,
  totalBatches?: number
): string {
  const { type, scope, sessionId, taskId, omitOperatingEnvelope } = params;
  const effectiveScope = batchScope ?? scope;

  const sections: string[] = [];

  const header = renderCommonHeader(params);
  if (batchIndex !== undefined && totalBatches !== undefined) {
    sections.push(`${header}\n\n**Batch ${batchIndex} of ${totalBatches}**`);
  } else {
    sections.push(header);
  }

  if (skillSection) {
    sections.push(skillSection);
  }

  if (effectiveScope && effectiveScope.length > 0) {
    sections.push(renderScopeSection(effectiveScope));
  }

  if (type === "review") {
    sections.push(`
## Review Instructions

Report findings as structured output. Do NOT make any changes.`);
    if (!omitOperatingEnvelope) {
      sections.push(renderSubagentOperatingEnvelope(sessionId, taskId, /* readOnly */ true));
    }
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
    if (!omitOperatingEnvelope) {
      sections.push(renderSubagentOperatingEnvelope(sessionId, taskId, /* readOnly */ true));
    }
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

  if (!omitOperatingEnvelope) {
    sections.push(renderSubagentOperatingEnvelope(sessionId, taskId, /* readOnly */ false));
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
  const harness = params.harness ?? detectAgentHarness();
  const workspacePath = params.workspacePath ?? process.cwd();
  const skillLoader = params.skillLoader ?? defaultSkillLoader;
  const agentType = PROMPT_TYPE_TO_AGENT_TYPE[type];

  const skillPlan = planSkillSection(type, harness, workspacePath, skillLoader);

  const needsBatching = scope && scope.length > SCOPE_WARNING_THRESHOLD;

  if (needsBatching) {
    const scopeWarning = `Scope has ${scope.length} files (exceeds ${SCOPE_WARNING_THRESHOLD}). Using batching into chunks of ${BATCH_SIZE} files for subagent capacity.`;

    const chunks: string[][] = [];
    for (let i = 0; i < scope.length; i += BATCH_SIZE) {
      chunks.push(scope.slice(i, i + BATCH_SIZE));
    }
    const totalBatches = chunks.length;

    let firstBatchPrompt = "";

    const batches: GeneratePromptResult[] = chunks.map((chunk, idx) => {
      const batchIndex = idx + 1;
      const prompt = generateSinglePrompt(
        params,
        skillPlan.rendered,
        chunk,
        batchIndex,
        totalBatches
      );
      if (batchIndex === 1) {
        firstBatchPrompt = prompt;
      }
      return {
        prompt,
        harness,
        agentType,
        skillsEmbedded: skillPlan.skillsEmbedded,
        suggestedModel: "sonnet",
        batchIndex,
        totalBatches,
        scopeWarning,
      };
    });

    return {
      prompt: firstBatchPrompt,
      harness,
      agentType,
      skillsEmbedded: skillPlan.skillsEmbedded,
      suggestedModel: "sonnet",
      scopeWarning,
      batches,
    };
  }

  const prompt = generateSinglePrompt(params, skillPlan.rendered);

  return {
    prompt,
    harness,
    agentType,
    skillsEmbedded: skillPlan.skillsEmbedded,
    suggestedModel: "sonnet",
  };
}
