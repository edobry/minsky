/**
 * Claude Agents Compile Target
 *
 * Reads `.minsky/agents/<name>/agent.ts` TypeScript definition modules,
 * validates them via `agentDefinitionSchema`, and emits
 * `.claude/agents/<name>.md` with YAML frontmatter + prompt body.
 *
 * Discovery, import and validation live in `./agent-target` (mt#3854), shared
 * with the `codex-agents` target — the two differ only in serialization format.
 * This module owns the Markdown serializer and the Claude construction;
 * behaviour is unchanged from the original.
 */

import matter from "gray-matter";
import { makeAgentTarget, realDynamicImport } from "./agent-target";
import type { DynamicImportFn } from "./agent-target";
import type { AgentDefinition } from "../../definitions/types";
import type { MinskyCompileTarget } from "../types";

// Re-exported so this module's public surface is unchanged by the mt#3854
// extraction — external callers and tests import these by name.
export type { DynamicImportFn };

/**
 * Build `<name>.md` content from a validated AgentDefinition.
 *
 * Emits YAML frontmatter followed by the prompt body. Format matches
 * the hand-authored files in `.claude/agents/*.md`.
 *
 * The `tools` field is emitted as a comma-separated string (matching the
 * hand-authored format Claude Code uses), not as a YAML array.
 */
export function buildAgentMd(agent: AgentDefinition): string {
  const frontmatterData: Record<string, unknown> = {
    name: agent.name,
    description: agent.description,
  };

  if (agent.tools !== undefined && agent.tools.length > 0) {
    // Claude Code reads tools as a comma-separated string, not a YAML array.
    frontmatterData["tools"] = agent.tools.join(", ");
  }

  if (agent.model !== undefined && agent.model !== "inherit") {
    frontmatterData["model"] = agent.model;
  }

  if (agent.permissionMode !== undefined && agent.permissionMode !== "default") {
    frontmatterData["permission-mode"] = agent.permissionMode;
  }

  if (agent.maxTurns !== undefined) {
    frontmatterData["max-turns"] = agent.maxTurns;
  }

  if (agent.skills !== undefined && agent.skills.length > 0) {
    frontmatterData["skills"] = agent.skills;
  }

  if (agent.disallowedTools !== undefined && agent.disallowedTools.length > 0) {
    frontmatterData["disallowed-tools"] = agent.disallowedTools.join(", ");
  }

  // Ensure a blank line between frontmatter closing delimiter and prompt body.
  // gray-matter.stringify places content immediately after "---\n" unless the
  // content starts with "\n". Hand-authored .md files always have this blank
  // line, so we normalise here for stable output.
  const body = agent.prompt.startsWith("\n") ? agent.prompt : `\n${agent.prompt}`;
  return matter.stringify(body, frontmatterData);
}

/** Build the claude-agents target, injecting a dynamic-import function for tests. */
function makeClaudeAgentsTarget(
  dynamicImport: DynamicImportFn = realDynamicImport
): MinskyCompileTarget {
  return makeAgentTarget(
    {
      id: "claude-agents",
      displayName: "Claude Agents",
      outputDirSegments: [".claude", "agents"],
      outputExtension: ".md",
      // .claude/agents/ contains both compiled and hand-authored *.md files
      // (the hand-authored ones are the existing Claude Code agents in this repo).
      // Skip orphan detection so --check doesn't flag them as stale.
      sharedOutputDirectory: true,
      buildContent: buildAgentMd,
    },
    dynamicImport
  );
}

export const claudeAgentsTarget = makeClaudeAgentsTarget();

/** Export factory for test injection */
export { makeClaudeAgentsTarget };
