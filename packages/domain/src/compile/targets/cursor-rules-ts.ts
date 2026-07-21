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

import { join } from "path";
import realFs from "fs/promises";
import matter from "gray-matter";
import { ruleDefinitionSchema } from "../../definitions/schemas";
import type { RuleDefinition } from "../../definitions/types";
import { discoverRuleSources } from "../rule-sources";
import { log } from "../../utils/logger";
import type {
  MinskyCompileTarget,
  MinskyCompileResult,
  MinskyTargetOptions,
  MinskyCompileFsDeps,
} from "../types";
// Single-source-of-truth banner constant; the same import is used by the
// legacy writer (`src/domain/rules/compile/targets/cursor-rules.ts`) and by
// `.claude/hooks/check-generated-file-edit.ts`'s detection patterns.
import { GENERATED_BANNER } from "../../rules/compile/banner-constants";

/** Injectable dynamic import — overridden in tests. */
export type DynamicImportFn = (path: string) => Promise<unknown>;

const realDynamicImport: DynamicImportFn = (path: string) => import(path);

/**
 * Injectable skip-warning sink — overridden in tests. Production default logs
 * via the shared logger; a skipped rule (broken import, invalid definition,
 * name mismatch, or an ambiguous `both` source) is NOT swallowed silently
 * (mt#2182). Injected rather than spying on `log` to sidestep cross-package
 * module-identity issues with the singleton logger.
 */
export type SkipLogFn = (message: string) => void;

const defaultSkipLog: SkipLogFn = (message: string) => log.warn(message);

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
 * what the legacy cursor-rules target produces. A generated-file banner
 * (mt#1798) is injected as a YAML comment immediately after the opening
 * `---` delimiter so the file remains a valid Cursor `.mdc` while the
 * `check-generated-file-edit` hook can detect it as a compiled output.
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
  const raw = matter.stringify(body, frontmatterData);
  // Inject the generated-file banner as the first frontmatter line. The
  // opener is `---\n` (or `---\r\n` on a hypothetical CRLF-emitting build of
  // gray-matter); the regex is tolerant of both. The injected newline matches
  // the original opener's line-ending so the file stays internally consistent.
  return raw.replace(/^---(\r?\n)/, `---$1${GENERATED_BANNER}$1`);
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
  dynamicImport: DynamicImportFn = realDynamicImport,
  onSkip: SkipLogFn = defaultSkipLog
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
      const sources = await discoverRuleSources(workspacePath, fs);
      // Phase 2 (mt#2994): cursor-rules-ts still emits ONLY TS-sourced rules.
      // Flat `.mdc` rules are discovered via the shared reader, but their
      // emission — and byte-parity with the legacy writer — is Phase 3 (mt#2995).
      return sources
        .filter((s) => s.kind === "ts")
        .map((s) => ruleOutputPath(workspacePath, s.name));
    },

    async compile(
      options: MinskyTargetOptions,
      workspacePath: string,
      fsDeps?: MinskyCompileFsDeps
    ): Promise<MinskyCompileResult> {
      const fs = fsDeps ?? (realFs as MinskyCompileFsDeps);
      const sources = await discoverRuleSources(workspacePath, fs);

      const filesWritten: string[] = [];
      const definitionsIncluded: string[] = [];
      const definitionsSkipped: string[] = [];
      const contentsByPath = new Map<string, string>();
      const dryRunParts: string[] = [];

      for (const source of sources) {
        // Phase 2 (mt#2994): this target emits ONLY TS-sourced rules. Flat
        // `.mdc` rules are discovered via the shared reader, but their emission
        // is Phase 3 (mt#2995) — an `mdc` source is not this target's output yet.
        if (source.kind === "mdc") {
          continue;
        }
        // Ambiguous `both` source (a `<name>/rule.ts` AND a flat `<name>.mdc`
        // for the same name): skip + warn rather than silently preferring one
        // format (the mt#2279-consistent policy). NOTE: this is the ONE semantic
        // change vs. the pre-mt#2994 target, which was blind to flat `.mdc`
        // files and would have emitted the TS side. No such collision exists
        // today (0 `rule.ts` sources), so the change is latent until a rule is
        // authored in both formats.
        if (source.kind === "both") {
          onSkip(
            `[compile:cursor-rules-ts] skipping "${source.name}": both ${source.tsPath} and ${source.mdcPath} exist — ambiguous canonical source; keep exactly one format`
          );
          definitionsSkipped.push(source.name);
          continue;
        }

        const { name: dirName, path: sourcePath } = source;

        let mod: unknown;
        try {
          mod = await dynamicImport(sourcePath);
        } catch (error) {
          // Do NOT swallow silently (mt#2182): a broken import is surfaced.
          const reason = error instanceof Error ? error.message : String(error);
          onSkip(
            `[compile:cursor-rules-ts] skipping "${dirName}": failed to import ${sourcePath}: ${reason}`
          );
          definitionsSkipped.push(dirName);
          continue;
        }

        const extracted = extractRuleDefinition(mod, sourcePath);
        if ("error" in extracted) {
          onSkip(`[compile:cursor-rules-ts] skipping "${dirName}": ${extracted.error}`);
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
          onSkip(
            `[compile:cursor-rules-ts] skipping "${dirName}": rule name ${
              rule.name === undefined ? "is undefined" : `"${rule.name}"`
            } does not match its directory name`
          );
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
