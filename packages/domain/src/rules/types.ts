/**
 * Rules Domain Types
 *
 * Type definitions for the rules domain.
 * Extracted from rules.ts as part of modularization effort.
 */

import type { RulePlane, RuleRung, RuleTier } from "../definitions/types";

export interface Rule {
  id: string; // Filename without extension
  name?: string; // From frontmatter
  description?: string; // From frontmatter
  spec?: string; // From frontmatter
  globs?: string[]; // From frontmatter, file patterns that this rule applies to
  alwaysApply?: boolean; // From frontmatter, whether this rule is always applied
  tags?: string[]; // From frontmatter, optional tags for categorization
  /**
   * Plane / tier / rung, carried through from frontmatter (mt#573 SC2).
   *
   * `RuleService` mapped a five-key allow-list until this task, while the
   * compile pipeline's reader (`compile/rule-sources.ts`) was widened to carry
   * these by mt#4974. That asymmetry is why the second reader could not honour
   * selection: `listRules` had no way to see a rule's tier, so it could not
   * compute the tier defaults the active set starts from.
   *
   * Additive and optional — absence means unclassified, exactly as on
   * `RuleDefinition`, and no existing consumer of `Rule` has to change.
   */
  plane?: RulePlane;
  tier?: RuleTier;
  minimumRung?: RuleRung;
  content: string; // The rule content (without frontmatter)
  format: RuleFormat; // see RuleFormat for the accepted values
  path: string; // Full path to the rule file
  formatNote?: string; // Optional format conversion notice
}

export interface RuleMeta {
  name?: string;
  description?: string;
  spec?: string;
  globs?: string[];
  alwaysApply?: boolean;
  tags?: string[];
  [key: string]: unknown; // Allow for additional custom fields from frontmatter
}

/**
 * Every accepted rule format, in the order help text presents them. **This is
 * the single source of truth for the value set** (mt#4741); {@link RuleFormat}
 * is derived from it, not declared alongside it.
 *
 * A `readonly` tuple rather than `Object.keys(RULE_FORMAT_OUTPUT_DIR)` so that
 * neither the ORDER nor the ELEMENT TYPE is implicit: key order is a runtime
 * property of the object literal that is not type-encoded, and a
 * `Object.keys(...) as RuleFormat[]` assertion would keep type-checking if the
 * mapping were ever refactored away from a `Record<RuleFormat, string>`. Here
 * the order is declared and the type needs no assertion (PR #3469 review).
 *
 * Adding a format is still gated: it goes here, and {@link RULE_FORMAT_OUTPUT_DIR}
 * then fails to compile until its directory is decided. The help strings pick it
 * up with no further edit.
 *
 * The bug this exists to prevent: `minsky` was added on 2026-04-01 (mt#588) and
 * every `--rule-format` help string went on saying "cursor or generic" for five
 * months, because a hand-written description is coupled to nothing and so
 * nothing fails when it goes stale. Do not restate this set in a literal —
 * derive from here.
 */
export const RULE_FORMAT_VALUES = ["cursor", "generic", "minsky"] as const;

export type RuleFormat = (typeof RULE_FORMAT_VALUES)[number];

/**
 * The rules directory each {@link RuleFormat} writes to, relative to the
 * project root. **This is the single source of truth for that mapping**
 * (mt#4714).
 *
 * It is a `Record<RuleFormat, string>` rather than a function or a chain of
 * ternaries so that adding a member to `RuleFormat` is a COMPILE ERROR here
 * until its directory is decided. The bug this constant exists to prevent was
 * the opposite shape: `minsky init` restated the mapping as a two-way ternary
 * (`ruleFormat === "cursor" ? .cursor/rules : .ai/rules`) and passed the result
 * as an explicit `outputDir`, which overrode `RuleTemplateService`'s own
 * three-way mapping. `minsky` therefore scaffolded into `.ai/rules` — the
 * `generic` location — while every other consumer resolved it to
 * `.minsky/rules`. Two mappings, silently disagreeing on one member.
 *
 * `.minsky/rules` is not an arbitrary third choice: it is the canonical rule
 * SOURCE directory the compile pipeline reads (ADR-016 — both the legacy and
 * the current compile system read flat `.minsky/rules/*.mdc`).
 */
export const RULE_FORMAT_OUTPUT_DIR: Record<RuleFormat, string> = {
  cursor: ".cursor/rules",
  generic: ".ai/rules",
  minsky: ".minsky/rules",
};

/**
 * The ONE directory rule sources are authored and scaffolded into, for every
 * `RuleFormat` (mt#573 SC3).
 *
 * `RULE_FORMAT_OUTPUT_DIR` above still maps a format to where its COMPILED
 * output goes, and `RuleService` still READS all three directories so a project
 * that predates this change keeps working. What changed is that `init` no
 * longer WRITES sources anywhere but here.
 *
 * **Why this had to move.** Under `--rule-format cursor` — which is also what a
 * project with no harness signal gets, since `resolveInitClient` falls back to
 * `cursor` — `init` wrote its sources straight into `.cursor/rules/`. That
 * directory is a compile OUTPUT, so there was nothing upstream of it for a
 * filter to read: a Cursor project's rule selection was a one-shot decision
 * taken at `init` and never revisable, because deselecting a rule has nothing
 * to deselect it FROM. This is the expert-review finding folded into RFC
 * `3ce937f0` as Phase 2, and it is why SC2's filter and SC3's directory move
 * are one task — landing the filter alone would ship a selection mechanism that
 * silently does nothing for exactly the projects that fall back to `cursor`.
 *
 * `.minsky/rules` is also what the compile pipeline reads (ADR-016), so this
 * completes that ADR's `.minsky/`-canonical direction for the one format still
 * outside it.
 */
export const RULE_SOURCE_DIR = ".minsky/rules";

export interface RuleOptions {
  format?: RuleFormat;
  tag?: string;
  debug?: boolean;
  file?: string;
  /**
   * Return rules the project has DESELECTED as well (mt#573 SC2).
   *
   * `listRules` honours the project's selection by default, because its
   * consumers — the agent context assembler, the rules embeddings index and
   * `rules list` — are all asking "what is active here?".
   *
   * Two callers are asking a different question and must set this:
   * `getRulesConfig`, which reports `activeRuleCount` out of `totalRuleCount`
   * and would otherwise report them as equal, and `knownRuleIds`, which
   * validates the id passed to `rules enable|disable` and would otherwise make
   * a disabled rule un-re-enableable — the config's own surface locking the
   * user out of the config.
   */
  includeDeselected?: boolean;
}

export interface CreateRuleOptions {
  format?: RuleFormat;
  overwrite?: boolean;
}

export interface UpdateRuleOptions {
  content?: string;
  meta?: Partial<RuleMeta>;
}

export interface SearchRuleOptions {
  format?: RuleFormat;
  tag?: string;
  query?: string;
}
