/**
 * Claude Agents Compile Target
 *
 * Reads .minsky/agents/<name>/agent.ts TypeScript definition modules,
 * validates them via agentDefinitionSchema, and emits
 * .claude/agents/<name>.md with YAML frontmatter + prompt body.
 */

import { join } from "path";
import realFs from "fs/promises";
import matter from "gray-matter";
import { agentDefinitionSchema } from "../../definitions/schemas";
import type { AgentDefinition } from "../../definitions/types";
import type {
  MinskyCompileTarget,
  MinskyCompileResult,
  MinskyTargetOptions,
  MinskyCompileFsDeps,
} from "../types";

/** Injectable dynamic import — overridden in tests. */
export type DynamicImportFn = (path: string) => Promise<unknown>;

const realDynamicImport: DynamicImportFn = (path: string) => import(path);

/**
 * Source directory where agents are authored.
 * Pattern: .minsky/agents/<name>/agent.ts
 */
function agentSourceDir(workspacePath: string): string {
  return join(workspacePath, ".minsky", "agents");
}

/**
 * Root output directory for compiled agents.
 * Output: .claude/agents/<name>.md
 */
function agentOutputDir(workspacePath: string): string {
  return join(workspacePath, ".claude", "agents");
}

/** Absolute path to the compiled <name>.md for a given agent name. */
function agentOutputPath(workspacePath: string, agentName: string): string {
  return join(agentOutputDir(workspacePath), `${agentName}.md`);
}

/**
 * Build <name>.md content from a validated AgentDefinition.
 *
 * Emits YAML frontmatter followed by the prompt body. Format matches
 * the hand-authored files in .claude/agents/*.md.
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

/**
 * Discover the names of sub-directories under .minsky/agents/ that
 * contain an agent.ts file.
 */
async function discoverAgentDirNames(
  workspacePath: string,
  fs: MinskyCompileFsDeps
): Promise<string[]> {
  const sourceDir = agentSourceDir(workspacePath);
  let entries: string[];
  try {
    entries = await fs.readdir(sourceDir);
  } catch {
    return [];
  }

  const agentDirNames: string[] = [];
  for (const entry of entries) {
    const agentTsPath = join(sourceDir, entry, "agent.ts");
    try {
      await fs.access(agentTsPath);
      agentDirNames.push(entry);
    } catch {
      // No agent.ts here — skip
    }
  }
  return agentDirNames;
}

/**
 * Load and validate an agent definition from an imported module.
 * Accepts both `export default defineAgent(...)` and named `export { agent }`.
 */
function extractAgentDefinition(
  mod: unknown,
  sourcePath: string
): { agent: AgentDefinition } | { error: string } {
  if (typeof mod !== "object" || mod === null) {
    return { error: `Module at ${sourcePath} did not export an object` };
  }

  const candidate =
    (mod as Record<string, unknown>)["default"] ?? (mod as Record<string, unknown>)["agent"];

  if (candidate === undefined) {
    return {
      error: `Module at ${sourcePath} has no default export or named 'agent' export`,
    };
  }

  const parsed = agentDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      error: `Invalid agent definition at ${sourcePath}: ${parsed.error.message}`,
    };
  }

  return { agent: parsed.data as AgentDefinition };
}

/** Build the claude-agents target, injecting a dynamic-import function for tests. */
function makeClaudeAgentsTarget(
  dynamicImport: DynamicImportFn = realDynamicImport
): MinskyCompileTarget {
  return {
    id: "claude-agents",
    displayName: "Claude Agents",
    // .claude/agents/ contains both compiled and hand-authored *.md files
    // (the hand-authored ones are the existing Claude Code agents in this repo).
    // Skip orphan detection so --check doesn't flag them as stale.
    sharedOutputDirectory: true,

    defaultOutputPath(workspacePath: string): string {
      return agentOutputDir(workspacePath);
    },

    async listOutputFiles(
      _options: MinskyTargetOptions,
      workspacePath: string,
      fsDeps?: MinskyCompileFsDeps
    ): Promise<string[]> {
      const fs = fsDeps ?? (realFs as MinskyCompileFsDeps);
      const dirNames = await discoverAgentDirNames(workspacePath, fs);
      return dirNames.map((name) => agentOutputPath(workspacePath, name));
    },

    async compile(
      options: MinskyTargetOptions,
      workspacePath: string,
      fsDeps?: MinskyCompileFsDeps
    ): Promise<MinskyCompileResult> {
      const fs = fsDeps ?? (realFs as MinskyCompileFsDeps);
      const dirNames = await discoverAgentDirNames(workspacePath, fs);

      const filesWritten: string[] = [];
      const definitionsIncluded: string[] = [];
      const definitionsSkipped: string[] = [];
      const contentsByPath = new Map<string, string>();
      const dryRunParts: string[] = [];

      for (const dirName of dirNames) {
        const sourcePath = join(agentSourceDir(workspacePath), dirName, "agent.ts");

        let mod: unknown;
        try {
          mod = await dynamicImport(sourcePath);
        } catch {
          definitionsSkipped.push(dirName);
          continue;
        }

        const extracted = extractAgentDefinition(mod, sourcePath);
        if ("error" in extracted) {
          definitionsSkipped.push(dirName);
          continue;
        }

        const { agent } = extracted;
        // Enforce dirName === agent.name. Without this invariant, compile output
        // would live at `.claude/agents/<agent.name>.md` but `listOutputFiles`
        // (which only sees dirNames) would expect `.claude/agents/<dirName>.md`,
        // causing `--check` to always flag the target as stale. Keeping them in
        // lockstep is simpler than making listOutputFiles load every definition
        // just to discover the real name.
        if (dirName !== agent.name) {
          definitionsSkipped.push(dirName);
          continue;
        }
        const outputPath = agentOutputPath(workspacePath, agent.name);
        const content = buildAgentMd(agent);

        if (options.dryRun) {
          contentsByPath.set(outputPath, content);
          dryRunParts.push(`// ${outputPath}\n${content}`);
        } else {
          await fs.mkdir(agentOutputDir(workspacePath), { recursive: true });
          await fs.writeFile(outputPath, content, "utf-8");
        }

        filesWritten.push(outputPath);
        definitionsIncluded.push(agent.name);
      }

      return {
        target: "claude-agents",
        filesWritten,
        definitionsIncluded,
        definitionsSkipped,
        content: options.dryRun ? dryRunParts.join("\n\n") : undefined,
        contentsByPath: options.dryRun ? contentsByPath : undefined,
      };
    },
  };
}

export const claudeAgentsTarget = makeClaudeAgentsTarget();

/** Export factory for test injection */
export { makeClaudeAgentsTarget };
