/**
 * The package-resident product rule corpus (mt#4974 SC3/SC4/SC5).
 *
 * ## What this replaces, and why the replacement is a directory of markdown
 *
 * Until this module, the only rules Minsky shipped into a managed project were
 * six TypeScript string templates (`../init/rule-templates.ts` →
 * `./templates/*.ts`). Measured 2026-09-04: all six were unreachable by Claude
 * Code's automatic channels — they carried neither `alwaysApply: true` nor
 * `globs`, so they landed in neither `CLAUDE.md` nor `.claude/rules` — and three
 * carried confirmed-wrong instructions (a `git approve` command that does not
 * exist, IN-REVIEW set before the PR, DONE set by hand). A fresh `minsky init`
 * produced a 90-byte `CLAUDE.md` and 43 KB of prose nothing would ever read.
 *
 * The rules worth shipping already existed as markdown, in this repository's own
 * `.minsky/rules/*.mdc`. So the corpus is markdown too: a promoted rule is the
 * SAME artifact the compile pipeline already reads, with plane/tier metadata
 * added — not a string re-encoded into TypeScript, which is what made the
 * template set drift from reality without anything noticing.
 *
 * ## Tiering: what ships is not the same question as what is emitted
 *
 * Each rule carries a `tier` (ask#11286): `base` is on and not declinable,
 * `opinionated` is on and declinable, `style` is off and opt-in. **This module
 * emits only `base`** (`selectScaffoldableRules`), because until Phase 2 (mt#573)
 * wires selection there is no mechanism for a user to decline anything — and
 * writing a declinable rule into a project that was never asked is exactly the
 * "never emit more than the user chose" invariant this slice must not break.
 * Opinionated rules are PRESENT here and deliberately unscaffolded; they become
 * emittable when a user can answer for them.
 *
 * ## Resolution
 *
 * `resolveRuleCorpusDir` mirrors `setup/hook-provisioning.ts`'s
 * `resolveHookSourceDir` (itself mirroring `resolveMigrationsFolder`, mt#1767):
 * an ordered candidate list ending in a LOUD failure naming every path tried.
 * A silent "no rules found" would reproduce the invisible-project bug this whole
 * task exists to fix — an empty scaffold is indistinguishable from a working one
 * from the outside, which is how the template set stayed broken for so long.
 */

import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { extractRuleDefinitionFromMdc } from "../compile/rule-sources";
import type { RuleDefinition, RuleTier } from "../definitions/types";
import type { FsLike } from "../interfaces/fs-like";
import { createRealFs } from "../interfaces/real-fs";

/**
 * The filesystem surface the corpus reader needs.
 *
 * Injected rather than importing `fs/promises` directly for two reasons: tests
 * can supply a corpus without touching disk, and `FsLike.readFile` is typed to
 * return `string` where the raw `fs/promises` overload widens to
 * `string | Buffer` under this tsconfig.
 */
export type CorpusFsDeps = Pick<FsLike, "readdir" | "readFile">;

/** Environment override for the corpus location. */
export const RULE_CORPUS_DIR_ENV = "MINSKY_RULE_CORPUS_DIR";

const MDC_EXT = ".mdc";

/**
 * A rule id that must exist in the corpus for a resolved directory to count as
 * the real thing. Picked because it is `base` — a corpus missing it is broken in
 * a way that matters, not merely incomplete.
 */
const CORPUS_SENTINEL = `minsky-session-workflow${MDC_EXT}`;

/** One rule as it ships: its id, its parsed definition, and its raw source. */
export interface CorpusRule {
  /** Rule id — the `<name>.mdc` basename. This is the scaffolded filename. */
  readonly id: string;
  readonly rule: RuleDefinition;
  /**
   * The verbatim source bytes.
   *
   * Scaffolding writes THIS rather than re-serializing `rule`, so a rule lands
   * in a project byte-identical to what shipped. Re-serializing would reformat
   * frontmatter (key order, quoting) and make "did this rule change?" — the
   * question SC7's migration hashes ask — unanswerable.
   */
  readonly raw: string;
}

/**
 * Locate the shipped rule corpus.
 *
 * Candidates, first existing wins:
 *   1. `MINSKY_RULE_CORPUS_DIR` (errors loud if set but missing).
 *   2. `./rules/corpus` beside the compiled module — the bundled layout, where
 *      `import.meta.url` is `dist/minsky.js` and `build:copy-rule-corpus` has
 *      placed the corpus at `dist/rules/corpus`.
 *   3. `./corpus` beside this source file — the dev-checkout layout.
 */
export function resolveRuleCorpusDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[RULE_CORPUS_DIR_ENV];
  if (override) {
    if (!existsSync(override)) {
      throw new Error(
        `${RULE_CORPUS_DIR_ENV}=${override} but that directory does not exist. ` +
          `Point it at a directory of ${MDC_EXT} rule sources, or unset it to use the default.`
      );
    }
    return override;
  }

  const candidates = [
    fileURLToPath(new URL("./rules/corpus", import.meta.url)),
    fileURLToPath(new URL("./corpus", import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, CORPUS_SENTINEL))) return candidate;
  }
  throw new Error(
    `Minsky rule corpus not found. Tried: ${candidates.join(", ")}. ` +
      `This indicates the installed build does not ship the rule corpus — check that ` +
      `\`bun run build:copy-rule-corpus\` ran. ` +
      `Set ${RULE_CORPUS_DIR_ENV} to an absolute path containing ${CORPUS_SENTINEL}.`
  );
}

/**
 * Read and parse every rule in the corpus, sorted by id for deterministic output.
 *
 * Throws on an unparseable rule rather than skipping it. The corpus is OUR
 * artifact, shipped in our own package: a rule that does not parse is a build
 * defect, not user input to be tolerated. (`discoverRuleSources` skip-and-warns
 * because it reads a USER's `.minsky/rules/`, where tolerance is right.)
 */
export async function loadRuleCorpus(
  corpusDir?: string,
  fs: CorpusFsDeps = createRealFs()
): Promise<CorpusRule[]> {
  const dir = corpusDir ?? resolveRuleCorpusDir();
  const entries = await fs.readdir(dir);
  const rules: CorpusRule[] = [];

  for (const entry of entries.filter((e) => e.endsWith(MDC_EXT)).sort()) {
    const full = path.join(dir, entry);
    const raw = await fs.readFile(full, "utf-8");
    const parsed = extractRuleDefinitionFromMdc(raw, full);
    if ("error" in parsed) {
      throw new Error(`Shipped rule corpus contains an unparseable rule: ${parsed.error}`);
    }
    rules.push({ id: entry.slice(0, -MDC_EXT.length), rule: parsed.rule, raw });
  }

  return rules;
}

/**
 * The rules `init` actually writes into a project.
 *
 * Only `base` today — see the module docblock. Phase 2 (mt#573) widens this to
 * `base` plus whatever the project selected, at which point this function grows
 * a selection argument rather than a new caller.
 */
export function selectScaffoldableRules(corpus: readonly CorpusRule[]): CorpusRule[] {
  return corpus.filter((r) => r.rule.tier === "base");
}

/** Group the corpus by tier, for reporting what shipped versus what was withheld. */
export function partitionByTier(
  corpus: readonly CorpusRule[]
): Record<RuleTier | "untiered", CorpusRule[]> {
  const out: Record<RuleTier | "untiered", CorpusRule[]> = {
    base: [],
    opinionated: [],
    style: [],
    untiered: [],
  };
  for (const rule of corpus) out[rule.rule.tier ?? "untiered"].push(rule);
  return out;
}

/**
 * Is this rule reachable by one of Claude Code's two automatic channels, or
 * deliberately not (mt#3107)?
 *
 * `alwaysApply: true` reaches `CLAUDE.md`; a non-empty `globs` reaches
 * `.claude/rules`. An EMPTY `globs` array reaches neither, which is why this
 * checks length rather than presence — `git-safety` ships `globs: []` and would
 * otherwise be scored reachable while landing nowhere.
 */
export function isReachableOrDeliberate(rule: RuleDefinition): boolean {
  if (rule.alwaysApply === true) return true;
  if (rule.onDemand === true) return true;
  const globs = rule.globs;
  if (typeof globs === "string") return globs.length > 0;
  if (Array.isArray(globs)) return globs.length > 0;
  return false;
}
