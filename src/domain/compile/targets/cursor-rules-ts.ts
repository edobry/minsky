/**
 * Cursor Rules TS Compile Target
 *
 * Reads .minsky/rules/<name>/rule.ts TypeScript definition modules,
 * validates them via ruleDefinitionSchema, and emits
 * .cursor/rules/<name>.mdc with YAML frontmatter + content body.
 *
 * This target coexists with the legacy cursor-rules target in
 * src/domain/rules/compile/targets/cursor-rules.ts which reads flat
 * .minsky/rules/*.mdc files. Both may write to .cursor/rules/ but to
 * different files (legacy: from .mdc sources; this: from .ts sources).
 */

import { join, basename } from "path";
import realFs from "fs/promises";
import matter from "gray-matter";
import { ruleDefinitionSchema } from "../../definitions/schemas";
import type { RuleDefinition } from "../../definitions/types";
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
 * Source directory where rules are authored.
 * Pattern: .minsky/rules/<name>/rule.ts
 */
function ruleSourceDir(workspacePath: string): string {
  return join(workspacePath, ".minsky", "rules");
}

/**
 * Root output directory for compiled cursor rules.
 * Output: .cursor/rules/<name>.mdc
 */
function ruleOutputDir(workspacePath: string): string {
  return join(workspacePath, ".cursor", "rules");
}

/** Absolute path to the compiled <name>.mdc for a given rule name. */
function ruleOutputPath(workspacePath: string, ruleName: string): string {
  return join(ruleOutputDir(workspacePath), `${ruleName}.mdc`);
}

/**
 * Build <name>.mdc content from a validated RuleDefinition.
 *
 * Emits YAML frontmatter (description, globs, alwaysApply, tags, name if
 * present) followed by the content body. Uses gray-matter's matter.stringify
 * for consistency with the other TS targets. Output canonicalization matches
 * what the legacy cursor-rules target produces.
 */
export function buildRuleMdc(rule: RuleDefinition): string {
  const frontmatterData: Record<string, unknown> = {};

  if (rule.description) {
    frontmatterData["description"] = rule.description;
  }

  if (rule.globs !== undefined) {
    // Normalize to array for block-style YAML output (matching legacy target).
    frontmatterData["globs"] = Array.isArray(rule.globs) ? rule.globs : [rule.globs];
  }

  if (rule.alwaysApply !== undefined) {
    frontmatterData["alwaysApply"] = rule.alwaysApply;
  }

  if (rule.tags !== undefined && rule.tags.length > 0) {
    frontmatterData["tags"] = rule.tags;
  }

  if (rule.name !== undefined) {
    frontmatterData["name"] = rule.name;
  }

  // Ensure a blank line between frontmatter closing delimiter and content body.
  // gray-matter.stringify places content immediately after "---\n" unless the
  // content starts with "\n". This matches the format of existing .mdc files.
  const body = rule.content.startsWith("\n") ? rule.content : `\n${rule.content}`;
  return matter.stringify(body, frontmatterData);
}

/**
 * Discover the names of sub-directories under .minsky/rules/ that
 * contain a rule.ts file. Skips any .mdc files in the parent directory.
 */
async function discoverRuleDirNames(
  workspacePath: string,
  fs: MinskyCompileFsDeps
): Promise<string[]> {
  const sourceDir = ruleSourceDir(workspacePath);
  let entries: string[];
  try {
    entries = await fs.readdir(sourceDir);
  } catch {
    return [];
  }

  const ruleDirNames: string[] = [];
  for (const entry of entries) {
    // Skip .mdc files and other non-directory entries at the parent level.
    if (entry.endsWith(".mdc")) {
      continue;
    }
    const ruleTsPath = join(sourceDir, entry, "rule.ts");
    try {
      await fs.access(ruleTsPath);
      ruleDirNames.push(basename(entry));
    } catch {
      // No rule.ts here — skip (may be a subdir without a rule.ts, or a file)
    }
  }
  return ruleDirNames;
}

/**
 * Load and validate a rule definition from an imported module.
 * Accepts both `export default defineRule(...)` and named `export { rule }`.
 */
function extractRuleDefinition(
  mod: unknown,
  sourcePath: string
): { rule: RuleDefinition } | { error: string } {
  if (typeof mod !== "object" || mod === null) {
    return { error: `Module at ${sourcePath} did not export an object` };
  }

  const candidate =
    (mod as Record<string, unknown>)["default"] ?? (mod as Record<string, unknown>)["rule"];

  if (candidate === undefined) {
    return {
      error: `Module at ${sourcePath} has no default export or named 'rule' export`,
    };
  }

  const parsed = ruleDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      error: `Invalid rule definition at ${sourcePath}: ${parsed.error.message}`,
    };
  }

  return { rule: parsed.data as RuleDefinition };
}

/** Build the cursor-rules-ts target, injecting a dynamic-import function for tests. */
function makeCursorRulesTsTarget(
  dynamicImport: DynamicImportFn = realDynamicImport
): MinskyCompileTarget {
  return {
    id: "cursor-rules-ts",
    displayName: "Cursor Rules TS (.cursor/rules/)",
    // .cursor/rules/ contains outputs from BOTH the legacy cursor-rules target
    // (which reads .minsky/rules/*.mdc) and this target (which reads
    // .minsky/rules/<name>/rule.ts). Skip orphan detection so --check doesn't
    // falsely flag legacy-produced .mdc files as stale.
    sharedOutputDirectory: true,

    defaultOutputPath(workspacePath: string): string {
      return ruleOutputDir(workspacePath);
    },

    async listOutputFiles(
      _options: MinskyTargetOptions,
      workspacePath: string,
      fsDeps?: MinskyCompileFsDeps
    ): Promise<string[]> {
      const fs = fsDeps ?? (realFs as MinskyCompileFsDeps);
      const dirNames = await discoverRuleDirNames(workspacePath, fs);
      return dirNames.map((name) => ruleOutputPath(workspacePath, name));
    },

    async compile(
      options: MinskyTargetOptions,
      workspacePath: string,
      fsDeps?: MinskyCompileFsDeps
    ): Promise<MinskyCompileResult> {
      const fs = fsDeps ?? (realFs as MinskyCompileFsDeps);
      const dirNames = await discoverRuleDirNames(workspacePath, fs);

      const filesWritten: string[] = [];
      const definitionsIncluded: string[] = [];
      const definitionsSkipped: string[] = [];
      const contentsByPath = new Map<string, string>();
      const dryRunParts: string[] = [];

      for (const dirName of dirNames) {
        const sourcePath = join(ruleSourceDir(workspacePath), dirName, "rule.ts");

        let mod: unknown;
        try {
          mod = await dynamicImport(sourcePath);
        } catch {
          definitionsSkipped.push(dirName);
          continue;
        }

        const extracted = extractRuleDefinition(mod, sourcePath);
        if ("error" in extracted) {
          definitionsSkipped.push(dirName);
          continue;
        }

        const { rule } = extracted;
        // Enforce dirName === rule.name. Without this invariant, compile output
        // would live at `.cursor/rules/<rule.name>.mdc` but `listOutputFiles`
        // (which only sees dirNames) would expect `.cursor/rules/<dirName>.mdc`,
        // causing `--check` to always flag the target as stale. Keeping them in
        // lockstep is simpler than making listOutputFiles load every definition
        // just to discover the real name.
        if (rule.name === undefined || dirName !== rule.name) {
          definitionsSkipped.push(dirName);
          continue;
        }

        const outputPath = ruleOutputPath(workspacePath, rule.name);
        const content = buildRuleMdc(rule);

        if (options.dryRun) {
          contentsByPath.set(outputPath, content);
          dryRunParts.push(`// ${outputPath}\n${content}`);
        } else {
          await fs.mkdir(ruleOutputDir(workspacePath), { recursive: true });
          await fs.writeFile(outputPath, content, "utf-8");
        }

        filesWritten.push(outputPath);
        definitionsIncluded.push(rule.name);
      }

      return {
        target: "cursor-rules-ts",
        filesWritten,
        definitionsIncluded,
        definitionsSkipped,
        content: options.dryRun ? dryRunParts.join("\n\n") : undefined,
        contentsByPath: options.dryRun ? contentsByPath : undefined,
      };
    },
  };
}

export const cursorRulesTsTarget = makeCursorRulesTsTarget();

/** Export factory for test injection */
export { makeCursorRulesTsTarget };
