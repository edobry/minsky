/**
 * Shared rule-loading + legacy-shape adapter for the monolithic/multi-file
 * rule-consuming compile targets (mt#2992: `claude-md.ts`, `agents-md.ts`,
 * `claude-rules.ts`).
 *
 * Reads rule sources via `discoverRuleSources` / `extractRuleDefinitionFromMdc`
 * (`../rule-sources.ts`, the mt#2994 flat-`.mdc` + `<name>/rule.ts` reader —
 * the SAME reader `cursor-rules-ts.ts` consumes), then adapts each
 * `RuleDefinition` into a legacy-`Rule`-shaped object.
 *
 * **Why adapt to the legacy `Rule` shape at all, when the new pipeline is
 * decoupling FROM legacy types (see `../size-budget.ts`)?** The rule-type
 * classification logic (`classifyRuleType`, `packages/domain/src/rules/
 * rule-classifier.ts`) is a general, non-doomed rules-domain utility (it does
 * NOT live under `rules/compile/`, the legacy pipeline slated for deletion in
 * mt#2996) — reusing it here avoids re-implementing always-apply/glob/
 * agent-requested/manual classification a second time. Its signature requires
 * the FULL legacy `Rule` interface (`format`/`path` are non-optional fields,
 * even though the classifier itself never reads them), so this module's
 * adapter fills those with placeholder values (`format: "minsky"`, `path`
 * pointing at the real on-disk source file) purely to satisfy that signature.
 *
 * **Glob normalization (intentionally NOT applied).** `RuleDefinition.globs`
 * is `string | string[] | undefined`; legacy `Rule.globs` is typed
 * `string[] | undefined` but `RuleService.getRule` (`rule-service.ts`)
 * actually assigns the raw frontmatter value unnormalized (`globs:
 * data.globs`), so a scalar-string glob is a latent legacy behavior, not a
 * hypothetical. `classifyRuleType`/`isEligibleForClaudeRules` both gate on
 * `Array.isArray(rule.globs)`, so a scalar-string glob is (silently) treated
 * as "no globs" by legacy today. This adapter passes `def.globs` through
 * UNNORMALIZED (via a type-narrowing cast) to replicate that exact legacy
 * classification behavior — normalizing here would make a scalar-glob rule
 * newly eligible for `.claude/rules/` / auto-attach in the NEW pipeline while
 * legacy still excludes it, breaking the "identical always-apply filtering" /
 * "identical rule-ID membership" parity-harness invariants (spec `##
 * Validation strictness` / `## Source breadth`) the moment such a rule is
 * authored. (No rule in the current 56-rule corpus uses a scalar glob —
 * verified 2026-07-22 — so this is forward-looking correctness, not an
 * observed divergence today.)
 */

import type { Rule } from "../../rules/types";
import { ruleDefinitionSchema } from "../../definitions/schemas";
import type { RuleDefinition } from "../../definitions/types";
import { discoverRuleSources, extractRuleDefinitionFromMdc } from "../rule-sources";
import { log } from "../../utils/logger";
import type { MinskyCompileFsDeps } from "../types";

/** Injectable dynamic import — overridden in tests (mirrors cursor-rules-ts.ts). */
export type DynamicImportFn = (path: string) => Promise<unknown>;

const realDynamicImport: DynamicImportFn = (path: string) => import(path);

/**
 * Injectable skip-warning sink — overridden in tests. A skipped rule (broken
 * import, invalid definition, name mismatch, unparseable/invalid `.mdc`, or
 * an ambiguous `both` source) is NOT swallowed silently (mt#2182 policy,
 * carried forward from `cursor-rules-ts.ts`).
 */
export type SkipLogFn = (message: string) => void;

const defaultSkipLog: SkipLogFn = (message: string) => log.warn(message);

/**
 * Adapt a discovered `RuleDefinition` into a legacy-`Rule`-shaped object.
 * `id` and `content`/`description`/`alwaysApply`/`tags` carry real values;
 * `format`/`path` are filled only to satisfy `Rule`'s required fields for
 * `classifyRuleType` (see module doc) — no target reads them for any other
 * purpose. Exported for direct unit testing.
 */
export function toLegacyRule(id: string, sourcePath: string, def: RuleDefinition): Rule {
  return {
    id,
    name: def.name,
    description: def.description,
    // Intentionally unnormalized — see module doc "Glob normalization".
    globs: def.globs as string[] | undefined,
    alwaysApply: def.alwaysApply,
    tags: def.tags,
    content: def.content,
    format: "minsky",
    path: sourcePath,
  };
}

/**
 * Load and validate a TS rule definition from an imported module. Mirrors
 * `cursor-rules-ts.ts`'s private `extractRuleDefinition` exactly (same
 * default/`rule`-export resolution, same schema validation) — duplicated
 * rather than imported since `cursor-rules-ts.ts` does not export it and
 * per mt#2992's success criterion "existing new-system targets are
 * unaffected", this module must not require changes there.
 */
function extractTsRuleDefinition(
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
 * Discover every rule source under `.minsky/rules/` and load it into a
 * legacy-`Rule`-shaped array, in the SAME sorted-by-name order
 * `discoverRuleSources` already produces (spec `## Ordering` — reuse the
 * existing sort, do not reintroduce readdir order). Ambiguous `both`
 * sources, unreadable/unparseable `.mdc` files, broken `rule.ts` imports,
 * schema-invalid definitions, and a `rule.ts` whose `name` doesn't match its
 * directory are all skipped + warned via `onSkip` (mt#2182 policy) — never
 * silently dropped.
 */
export async function loadAdaptedRules(
  workspacePath: string,
  fs: MinskyCompileFsDeps,
  onSkip: SkipLogFn = defaultSkipLog,
  dynamicImport: DynamicImportFn = realDynamicImport
): Promise<Rule[]> {
  const sources = await discoverRuleSources(workspacePath, fs);
  const rules: Rule[] = [];

  for (const source of sources) {
    if (source.kind === "both") {
      onSkip(
        `[compile:rule-loader] skipping "${source.name}": both ${source.tsPath} and ` +
          `${source.mdcPath} exist — ambiguous canonical source; keep exactly one format`
      );
      continue;
    }

    if (source.kind === "mdc") {
      let raw: string;
      try {
        raw = await fs.readFile(source.path, "utf-8");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        onSkip(
          `[compile:rule-loader] skipping "${source.name}": failed to read ${source.path}: ${reason}`
        );
        continue;
      }
      const extracted = extractRuleDefinitionFromMdc(raw, source.path);
      if ("error" in extracted) {
        onSkip(`[compile:rule-loader] skipping "${source.name}": ${extracted.error}`);
        continue;
      }
      rules.push(toLegacyRule(source.name, source.path, extracted.rule));
      continue;
    }

    // source.kind === "ts"
    const { name: dirName, path: sourcePath } = source;

    let mod: unknown;
    try {
      mod = await dynamicImport(sourcePath);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      onSkip(
        `[compile:rule-loader] skipping "${dirName}": failed to import ${sourcePath}: ${reason}`
      );
      continue;
    }

    const extracted = extractTsRuleDefinition(mod, sourcePath);
    if ("error" in extracted) {
      onSkip(`[compile:rule-loader] skipping "${dirName}": ${extracted.error}`);
      continue;
    }

    const { rule } = extracted;
    // Same invariant cursor-rules-ts.ts enforces: dirName === rule.name, so
    // the source name (used as the rule id everywhere downstream) is stable.
    if (rule.name === undefined || dirName !== rule.name) {
      onSkip(
        `[compile:rule-loader] skipping "${dirName}": rule name ${
          rule.name === undefined ? "is undefined" : `"${rule.name}"`
        } does not match its directory name`
      );
      continue;
    }

    rules.push(toLegacyRule(dirName, sourcePath, rule));
  }

  return rules;
}
