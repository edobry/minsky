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
 * 53 flat-rule outputs byte-identical across the switchover, `buildRuleMdc`
 * reproduced the legacy `serializeRuleToMdc` serialization exactly (same
 * `jsYaml.dump` options, same key order, same banner-as-line-2, same tail) —
 * with one deliberate exception since mt#1288: the output is newline-terminated
 * where the legacy serializer left it unterminated. See `buildRuleMdc`.
 */

import { basename, join } from "path";
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
import { createSkipRecorder } from "./skip-recorder";

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
 * **Byte-parity contract (mt#2995), with one deliberate exception (mt#1288):**
 * this reproduces the legacy `serializeRuleToMdc` output so the flat-rule
 * `.cursor/rules/` outputs did not change when the writer switched over — same
 * `jsYaml.dump` options, same frontmatter key order (name → description → globs
 * → alwaysApply → tags), the generated-file banner (mt#1798) as line 2, and the
 * content body appended directly after the closing `---\n`. `globs` and `tags`
 * are emitted as-is (not normalized) to match the legacy serializer.
 *
 * **The exception: output is newline-terminated (mt#1288).** The legacy
 * serializer emitted no trailing newline, so every one of the 53 compiled
 * `.cursor/rules/*.mdc` files ended mid-line — showing up as
 * `\ No newline at end of file` in every diff that touched them. Byte-parity
 * existed to make the mt#2995 writer SWAP a zero-output-change migration; that
 * migration is complete, so the defect it was preserving is now fixed rather
 * than inherited. A generated artifact is terminated unconditionally, which is
 * why this does NOT mirror the source's own newline state: 26 of the 53
 * `.minsky/rules/*.mdc` sources have no trailing newline themselves, and
 * mirroring would leave those outputs still ragged.
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

  const mdc = `---\n${GENERATED_BANNER}\n${yamlStr}---\n${rule.content}`;

  // Terminate without doubling. `rule.content` arrives trimmed from the shared
  // reader, so in practice this always appends; the guard keeps it correct if
  // that reader ever stops trimming. Deliberately NOT collapsing a multi-newline
  // tail down to one: that would silently rewrite a body's own trailing blank
  // lines, which is a different concern from terminating the file.
  return mdc.endsWith("\n") ? mdc : `${mdc}\n`;
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

/**
 * Delete `.cursor/rules/*.mdc` outputs this run did NOT write (mt#573 SC4).
 *
 * Without this, deselecting a rule leaves its `.mdc` sitting in
 * `.cursor/rules/` forever: Cursor goes on reading a rule the project turned
 * off, and the only way to remove it is by hand. `claude-rules.ts` has had the
 * same removal since mt#2992 — this is the missing half, and it is why SC2's
 * filter alone would not have made deselection work under Cursor.
 *
 * **Banner-gated, and that is load-bearing rather than cautious.** This target
 * declares `sharedOutputDirectory: true` precisely because `.cursor/rules/` may
 * also hold hand-authored `.mdc` files with no `.minsky/rules/` source — Cursor
 * documents `/create-rule` writing straight into that directory
 * (`cursor.com/docs/context/rules`, read 2026-09-05), so those files are
 * expected, not anomalous. A basename-set orphan check would delete them.
 * Only a file carrying `GENERATED_BANNER` — which this target itself emits on
 * line 2 of every file it writes — is a candidate.
 *
 * A file we cannot READ is left alone rather than deleted: an unreadable file
 * is one we cannot prove is ours, and the failure directions are not
 * symmetrical. Leaving a stale output costs a stale rule; deleting a user's
 * file costs their work.
 */
async function removeOrphanedRuleOutputs(
  workspacePath: string,
  fs: MinskyCompileFsDeps,
  filesWritten: string[]
): Promise<string[]> {
  const outputDir = ruleOutputDir(workspacePath);
  const expected = new Set(filesWritten.map((p) => basename(p)));
  const removed: string[] = [];

  let entries: string[];
  try {
    entries = await fs.readdir(outputDir);
  } catch {
    // intentional-swallow: the directory does not exist yet (a fresh compile
    // with no Cursor outputs), so there is nothing stale in it.
    return removed;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".mdc")) continue;
    if (expected.has(entry)) continue;
    const entryPath = join(outputDir, entry);
    let existing: string;
    try {
      existing = await fs.readFile(entryPath, "utf-8");
    } catch {
      continue; // Unreadable — skip rather than risk deleting blind.
    }
    if (!existing.includes(GENERATED_BANNER)) continue;
    await fs.unlink?.(entryPath);
    removed.push(entryPath);
  }

  return removed;
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
    //
    // mt#573 SC4 added banner-gated stale-file REMOVAL to `compile()`, which is
    // a different question from this flag and does not contradict it — the same
    // split `claude-rules.ts` has carried since mt#2992, which also declares
    // `sharedOutputDirectory: true`. This flag governs what `--check` may call
    // STALE (nothing it did not write); the removal governs what `compile` may
    // DELETE (only a file carrying our own banner). A hand-authored file is
    // outside both.
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
      // mt#3119: tee every skip message into the result; `onSkip` still fires unchanged.
      const { record: recordSkip, reasons: skipReasons } = createSkipRecorder(onSkip);
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
          recordSkip(
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
            recordSkip(
              `[compile:cursor-rules-ts] skipping "${source.name}": failed to read ${source.path}: ${reason}`
            );
            definitionsSkipped.push(source.name);
            continue;
          }
          const extracted = extractRuleDefinitionFromMdc(raw, source.path);
          if ("error" in extracted) {
            recordSkip(`[compile:cursor-rules-ts] skipping "${source.name}": ${extracted.error}`);
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
          recordSkip(
            `[compile:cursor-rules-ts] skipping "${dirName}": failed to import ${sourcePath}: ${reason}`
          );
          definitionsSkipped.push(dirName);
          continue;
        }

        const extracted = extractRuleDefinition(mod, sourcePath);
        if ("error" in extracted) {
          recordSkip(`[compile:cursor-rules-ts] skipping "${dirName}": ${extracted.error}`);
          definitionsSkipped.push(dirName);
          continue;
        }

        const { rule } = extracted;
        // For a TS source, enforce dirName === rule.name so the output path
        // (`<name>.mdc`) that `listOutputFiles` predicts from the dir name and
        // the one `compile` writes stay in lockstep — otherwise `--check` would
        // always flag the target stale.
        if (rule.name === undefined || dirName !== rule.name) {
          recordSkip(
            `[compile:cursor-rules-ts] skipping "${dirName}": rule name ${
              rule.name === undefined ? "is undefined" : `"${rule.name}"`
            } does not match its directory name`
          );
          definitionsSkipped.push(dirName);
          continue;
        }

        await emit(dirName, rule);
      }

      // Stale-file removal (SC4). Not reported on the result, matching
      // `claude-rules.ts` — the shared `MinskyCompileResult` has no field for
      // it, and widening that contract for one target is not this task's.
      if (!options.dryRun) await removeOrphanedRuleOutputs(workspacePath, fs, filesWritten);

      return {
        target: "cursor-rules-ts",
        filesWritten,
        definitionsIncluded,
        definitionsSkipped,
        skipReasons,
        content: options.dryRun ? dryRunParts.join("\n\n") : undefined,
        contentsByPath: options.dryRun ? contentsByPath : undefined,
      };
    },
  };
}

export const cursorRulesTsTarget = makeCursorRulesTsTarget();

/** Export factory for test injection */
export { makeCursorRulesTsTarget };
