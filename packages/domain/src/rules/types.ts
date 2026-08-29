/**
 * Rules Domain Types
 *
 * Type definitions for the rules domain.
 * Extracted from rules.ts as part of modularization effort.
 */

export interface Rule {
  id: string; // Filename without extension
  name?: string; // From frontmatter
  description?: string; // From frontmatter
  spec?: string; // From frontmatter
  globs?: string[]; // From frontmatter, file patterns that this rule applies to
  alwaysApply?: boolean; // From frontmatter, whether this rule is always applied
  tags?: string[]; // From frontmatter, optional tags for categorization
  content: string; // The rule content (without frontmatter)
  format: RuleFormat; // cursor or generic
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

export type RuleFormat = "cursor" | "generic" | "minsky";

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

export interface RuleOptions {
  format?: RuleFormat;
  tag?: string;
  debug?: boolean;
  file?: string;
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
