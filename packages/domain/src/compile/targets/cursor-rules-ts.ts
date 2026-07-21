/**
 * Cursor Rules Compile Target (unified — mt#2995)
 *
 * The SINGLE writer of `.cursor/rules/<name>.mdc`. Reads rule sources under
 * `.minsky/rules/` in EITHER form via the shared reader (`../rule-sources`):
 *   - a flat `<name>.mdc` markdown file, OR
 *   - a `<name>/rule.ts` TypeScript definition module.
 * Validates each via `ruleDefinitionSchema` and emits `.cursor/rules/<name>.mdc`
 * with YAML frontmatter + content body.
 *
 * Phase 3 of the compile-pipeline convergence (mt#2293 / ADR-016): this target
 * replaces the legacy `cursor-rules` writer (`packages/domain/src/rules/compile/
 * targets/cursor-rules.ts`), which is unregistered as of this change. To keep the
 * 54 flat-rule outputs byte-identical across the switchover, `buildRuleMdc`
 * reproduces the legacy `serializeRuleToMdc` serialization exactly (same
 * `jsYaml.dump` options, same key order, same banner-as-line-2, same tail).
 */

import { join } from "path";
import realFs from "fs/promises";
import * as jsYaml from "js-yaml";
import { ruleDefinitionSchema } from "../../definitions/schemas";
import type { RuleDefinition } from "../../definitions/types";
import { discoverRuleSources, extractRuleDefinitionFromMdc } from "../rule-sources";
import { log } from "../../utils/logger";
import type {
  MinskyCompileTarget,
  MinskyCompileResult,
  MinskyTargetOptions,
  MinskyCompileFsDeps,
} from "../types";
// Single-source-of-truth banner constant; the same import is used by
// `.claude/hooks/check-generated-file-edit.ts`'s detection patterns.
import { GENERATED_BANNER } from "../../rules/compile/banner-constants";

/** Injectable dynamic import — overridden in tests. */
export type DynamicImportFn = (path: string) => Promise<unknown>;

const realDynamicImport: DynamicImportFn = (path: string) => import(path);

/**
 * Injectable skip-warning sink — overridden in tests. Production default logs
 * via the shared logger; a skipped rule (broken import, invalid definition,
 * name mismatch, unparseable/invalid `.mdc`, or an ambiguous `both` source) is
 * NOT swallowed silently (mt#2182). Injected rather than spying on `log` to
 * sidestep cross-package module-identity issues with the singleton logger.
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
 * Build `<name>.mdc` content from a validated RuleDefinition.
 *
 * **Byte-parity contract (mt#2995):** this reproduces the legacy
 * `serializeRuleToMdc` output exactly so the 54 flat-rule `.cursor/rules/`
 * outputs do not change when the writer switches over — same `jsYaml.dump`
 * options, same frontmatter key order (name → description → globs → alwaysApply
 * → tags), the generated-file banner (mt#1798) as line 2, and the content body
 * appended directly after the closing `---\n`. `globs` and `tags` are emitted
 * as-is (not normalized) to match the legacy serializer. The
 * `cursor-rules-ts.parity` test asserts equality against `serializeRuleToMdc`.
 */
export function buildRuleMdc(rule: RuleDefinition): string {
  const frontmatter: Record<string, unknown> = {};

  if (rule.name) frontmatter["name"] = rule.name;
  if (rule.description) frontmatter["description"] = rule.description;
  if (rule.globs) frontmatter["globs"] = rule.globs;
  if (rule.alwaysApply !== undefined) frontmatter["alwaysApply"] = rule.alwaysApply;
  if (rule.tags) frontmatter["tags"] = rule.tags;

  const yamlStr = jsYaml.dump(frontmatter, {
    lineWidth: -1,
    noCompatMode: true,
    quotingType: '"',
    forceQuotes: false,
  });

  return `---\n${GENERATED_BANNER}\n${yamlStr}---\n${rule.content}`;
}

/**
 * Load and validate a rule definition from an imported TS module.
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
    displayName: "Cursor Rules (.cursor/rules/)",
    // `.cursor/rules/` may also contain hand-authored `.mdc` files that have no
    // `.minsky/rules/` source; skip orphan detection so `--check` does not flag
    // those as stale. (Every source-backed rule IS emitted by this target.)
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
      // Every non-ambiguous source (TS or flat `.mdc`) produces one output file,
      // named for the discovered source name. Ambiguous `both` sources are
      // skipped (see compile()) and never produce an output.
      return sources
        .filter((s) => s.kind !== "both")
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

      const emit = async (name: string, rule: RuleDefinition): Promise<void> => {
        const outputPath = ruleOutputPath(workspacePath, name);
        const content = buildRuleMdc(rule);
        if (options.dryRun) {
          contentsByPath.set(outputPath, content);
          dryRunParts.push(`// ${outputPath}\n${content}`);
        } else {
          await fs.mkdir(ruleOutputDir(workspacePath), { recursive: true });
          await fs.writeFile(outputPath, content, "utf-8");
        }
        filesWritten.push(outputPath);
        definitionsIncluded.push(name);
      };

      for (const source of sources) {
        // Ambiguous `both` source (a `<name>/rule.ts` AND a flat `<name>.mdc`
        // for the same name): skip + warn rather than silently preferring one
        // format (the mt#2279-consistent policy).
        if (source.kind === "both") {
          onSkip(
            `[compile:cursor-rules-ts] skipping "${source.name}": both ${source.tsPath} and ${source.mdcPath} exist — ambiguous canonical source; keep exactly one format`
          );
          definitionsSkipped.push(source.name);
          continue;
        }

        if (source.kind === "mdc") {
          let raw: string;
          try {
            raw = await fs.readFile(source.path, "utf-8");
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            onSkip(
              `[compile:cursor-rules-ts] skipping "${source.name}": failed to read ${source.path}: ${reason}`
            );
            definitionsSkipped.push(source.name);
            continue;
          }
          const extracted = extractRuleDefinitionFromMdc(raw, source.path);
          if ("error" in extracted) {
            onSkip(`[compile:cursor-rules-ts] skipping "${source.name}": ${extracted.error}`);
            definitionsSkipped.push(source.name);
            continue;
          }
          // The output filename is the discovered source name (the `.mdc`
          // basename), NOT the optional frontmatter `name` — matching the legacy
          // writer, which keyed `.cursor/rules/<id>.mdc` off the source id.
          await emit(source.name, extracted.rule);
          continue;
        }

        // source.kind === "ts"
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
        // For a TS source, enforce dirName === rule.name so the output path
        // (`<name>.mdc`) that `listOutputFiles` predicts from the dir name and
        // the one `compile` writes stay in lockstep — otherwise `--check` would
        // always flag the target stale.
        if (rule.name === undefined || dirName !== rule.name) {
          onSkip(
            `[compile:cursor-rules-ts] skipping "${dirName}": rule name ${
              rule.name === undefined ? "is undefined" : `"${rule.name}"`
            } does not match its directory name`
          );
          definitionsSkipped.push(dirName);
          continue;
        }

        await emit(dirName, rule);
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
