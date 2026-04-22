/**
 * Claude Skills Compile Target
 *
 * Reads .minsky/skills/*\/skill.ts TypeScript definition modules,
 * validates them via skillDefinitionSchema, and emits
 * .claude/skills/<name>/SKILL.md with YAML frontmatter + content body.
 */

import { join, dirname } from "path";
import realFs from "fs/promises";
import matter from "gray-matter";
import { skillDefinitionSchema } from "../../definitions/schemas";
import type { SkillDefinition } from "../../definitions/types";
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
 * Source directory where skills are authored.
 * Pattern: .minsky/skills/<name>/skill.ts
 */
function skillSourceDir(workspacePath: string): string {
  return join(workspacePath, ".minsky", "skills");
}

/**
 * Root output directory for compiled skills.
 * Output: .claude/skills/<name>/SKILL.md
 */
function skillOutputDir(workspacePath: string): string {
  return join(workspacePath, ".claude", "skills");
}

/** Absolute path to the compiled SKILL.md for a given skill name. */
function skillOutputPath(workspacePath: string, skillName: string): string {
  return join(skillOutputDir(workspacePath), skillName, "SKILL.md");
}

/**
 * Build SKILL.md content from a validated SkillDefinition.
 *
 * Emits YAML frontmatter followed by the content body. Format matches
 * the hand-authored files in .claude/skills/*\/SKILL.md.
 */
export function buildSkillMd(skill: SkillDefinition): string {
  const frontmatterData: Record<string, unknown> = {
    name: skill.name,
    description: skill.description,
  };

  if (skill.tags !== undefined && skill.tags.length > 0) {
    frontmatterData["tags"] = skill.tags;
  }

  frontmatterData["user-invocable"] = skill.userInvocable ?? true;

  if (skill.disableModelInvocation === true) {
    frontmatterData["disable-model-invocation"] = true;
  }

  if (skill.allowedTools !== undefined && skill.allowedTools.length > 0) {
    frontmatterData["allowed-tools"] = skill.allowedTools;
  }

  // Ensure a blank line between frontmatter closing delimiter and content body.
  // gray-matter.stringify places content immediately after "---\n" unless the
  // content starts with "\n". Hand-authored SKILL.md files always have this
  // blank line, so we normalise here for stable output.
  const body = skill.content.startsWith("\n") ? skill.content : `\n${skill.content}`;
  return matter.stringify(body, frontmatterData);
}

/**
 * Discover the names of sub-directories under .minsky/skills/ that
 * contain a skill.ts file.
 */
async function discoverSkillDirNames(
  workspacePath: string,
  fs: MinskyCompileFsDeps
): Promise<string[]> {
  const sourceDir = skillSourceDir(workspacePath);
  let entries: string[];
  try {
    entries = await fs.readdir(sourceDir);
  } catch {
    return [];
  }

  const skillDirNames: string[] = [];
  for (const entry of entries) {
    const skillTsPath = join(sourceDir, entry, "skill.ts");
    try {
      await fs.access(skillTsPath);
      skillDirNames.push(entry);
    } catch {
      // No skill.ts here — skip
    }
  }
  return skillDirNames;
}

/**
 * Load and validate a skill definition from an imported module.
 * Accepts both `export default defineSkill(...)` and named `export { skill }`.
 */
function extractSkillDefinition(
  mod: unknown,
  sourcePath: string
): { skill: SkillDefinition } | { error: string } {
  if (typeof mod !== "object" || mod === null) {
    return { error: `Module at ${sourcePath} did not export an object` };
  }

  const candidate =
    (mod as Record<string, unknown>)["default"] ?? (mod as Record<string, unknown>)["skill"];

  if (candidate === undefined) {
    return {
      error: `Module at ${sourcePath} has no default export or named 'skill' export`,
    };
  }

  const parsed = skillDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      error: `Invalid skill definition at ${sourcePath}: ${parsed.error.message}`,
    };
  }

  return { skill: parsed.data as SkillDefinition };
}

/** Build the claude-skills target, injecting a dynamic-import function for tests. */
function makeClaudeSkillsTarget(
  dynamicImport: DynamicImportFn = realDynamicImport
): MinskyCompileTarget {
  return {
    id: "claude-skills",
    displayName: "Claude Skills",

    defaultOutputPath(workspacePath: string): string {
      return skillOutputDir(workspacePath);
    },

    async listOutputFiles(
      _options: MinskyTargetOptions,
      workspacePath: string,
      fsDeps?: MinskyCompileFsDeps
    ): Promise<string[]> {
      const fs = fsDeps ?? (realFs as MinskyCompileFsDeps);
      const dirNames = await discoverSkillDirNames(workspacePath, fs);
      return dirNames.map((name) => skillOutputPath(workspacePath, name));
    },

    async compile(
      options: MinskyTargetOptions,
      workspacePath: string,
      fsDeps?: MinskyCompileFsDeps
    ): Promise<MinskyCompileResult> {
      const fs = fsDeps ?? (realFs as MinskyCompileFsDeps);
      const dirNames = await discoverSkillDirNames(workspacePath, fs);

      const filesWritten: string[] = [];
      const definitionsIncluded: string[] = [];
      const definitionsSkipped: string[] = [];
      const contentsByPath = new Map<string, string>();
      const dryRunParts: string[] = [];

      for (const dirName of dirNames) {
        const sourcePath = join(skillSourceDir(workspacePath), dirName, "skill.ts");

        let mod: unknown;
        try {
          mod = await dynamicImport(sourcePath);
        } catch {
          definitionsSkipped.push(dirName);
          continue;
        }

        const extracted = extractSkillDefinition(mod, sourcePath);
        if ("error" in extracted) {
          definitionsSkipped.push(dirName);
          continue;
        }

        const { skill } = extracted;
        const outputPath = skillOutputPath(workspacePath, skill.name);
        const content = buildSkillMd(skill);

        if (options.dryRun) {
          contentsByPath.set(outputPath, content);
          dryRunParts.push(`// ${outputPath}\n${content}`);
        } else {
          await fs.mkdir(dirname(outputPath), { recursive: true });
          await fs.writeFile(outputPath, content, "utf-8");
        }

        filesWritten.push(outputPath);
        definitionsIncluded.push(skill.name);
      }

      return {
        target: "claude-skills",
        filesWritten,
        definitionsIncluded,
        definitionsSkipped,
        content: options.dryRun ? dryRunParts.join("\n\n") : undefined,
        contentsByPath: options.dryRun ? contentsByPath : undefined,
      };
    },
  };
}

export const claudeSkillsTarget = makeClaudeSkillsTarget();

/** Export factory for test injection */
export { makeClaudeSkillsTarget };
