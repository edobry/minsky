/**
 * Coverage decision function — Surface 1 of the System 3* detector.
 *
 * Per ADR-008 §Router: an action is covered if policy **names the action or
 * its category AND names the authority**. Name-match alone is insufficient.
 *
 * This module operates on raw tool-call actions (not `Ask` objects), which
 * is why it doesn't reuse `src/domain/ask/policy.ts` directly. Both modules
 * share the same coverage semantics (paragraph/list-item statements + dual
 * signal); the difference is the input type.
 *
 * Reference: docs/architecture/adr-008-attention-allocation-subsystem.md §Router
 * Reference: docs/research/mt1035-system3-detector.md §Surface 1
 */

import type { FilterReason } from "./action-filter";
import type { PolicyCorpus, PolicyEntry } from "./corpus-loader";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Evidence pointer for a coverage decision.
 *
 * Identifies the policy source and the matching span (paragraph or list item)
 * that triggered coverage. Used for citation in the `responder = "policy"`
 * Ask close path and for operator audit.
 */
export interface CoverageEvidence {
  /** Source identifier from the policy entry (e.g. "decision-defaults.mdc"). */
  policySource: string;
  /** The text span that matched (paragraph or list item). */
  span: string;
  /** 1-indexed line range within the source. */
  lineRange: [number, number];
  /** Which category keyword matched. */
  matchedCategory: string;
  /** Which authority keyword matched. */
  matchedAuthority: string;
}

/** Result of a coverage decision. */
export type CoverageResult = { covered: true; evidence: CoverageEvidence[] } | { covered: false };

/**
 * Action descriptor used by the coverage function.
 *
 * Constructed from the action-filter's `FilterResult` plus the originating
 * tool-call params. Carries the structured reason (which category to look up)
 * and a free-text detail (which can supply additional action-name keywords).
 */
export interface ActionDescriptor {
  /** Filter reason — names the category to look up. */
  reason: FilterReason;
  /** Free-text detail from the filter result. */
  detail: string;
  /** Optional file path the action targets. */
  filePath?: string;
}

// ---------------------------------------------------------------------------
// Keyword tables
// ---------------------------------------------------------------------------

/**
 * Category keywords for each filter reason.
 *
 * Coverage requires policy to name either the specific action or its category.
 * These keywords are the substring search keys for category-level matching.
 *
 * Per ADR-008 §9: category-match requires explicit enumeration. The category
 * keywords are deliberately broad so that any policy mention of e.g. "default"
 * or "config" qualifies as naming the new-config-key category.
 *
 * All keywords are lower-cased; the matcher lower-cases the policy text.
 */
const CATEGORY_KEYWORDS: Record<FilterReason, readonly string[]> = {
  "new-file": ["new file", "create file", "scaffold", "module", "directory layout"],
  // For new-dependency we cover both the action surface ("dependency"/"package") AND
  // the kinds of things dependencies typically encode in `decision-defaults.mdc`
  // (datastore, queue, cache, persistence). The latter lets a policy entry like
  // "Datastores: Postgres-by-default" cover an action that adds a postgres library.
  "new-dependency": [
    "dependency",
    "dependencies",
    "package",
    "library",
    "vendor",
    "datastore",
    "persistence",
    "queue",
    "cache",
    "store",
  ],
  "new-config-key": ["config", "configuration", "default", "setting", "option", "threshold"],
  "new-user-facing-string": [
    "user-facing",
    "error message",
    "help text",
    "cli help",
    "i18n",
    "translation",
    "naming",
  ],
  "new-top-level-export": [
    "export",
    "abstraction",
    "interface",
    "class",
    "function",
    "naming",
    "convention",
  ],
};

/**
 * Authority keywords — words that mark a policy statement as conferring authority.
 *
 * Coverage requires that BOTH a category keyword AND an authority keyword
 * appear in the same policy statement. This avoids false green-lights from
 * incidental mentions.
 *
 * The set is intentionally broader than `src/domain/ask/policy.ts`'s
 * `AUTHORITY_KEYWORDS` because the policy corpus this detector reads
 * (decision-defaults.mdc, project rules, memories) uses different authority
 * language than ADR-008's pre-authorization patterns. In particular,
 * `decision-defaults.mdc` uses "default", "prefer", "must", "should",
 * "always", "never", "rule" liberally.
 */
const AUTHORITY_KEYWORDS = [
  "auto-approve",
  "auto-approved",
  "authorized",
  "permitted",
  "policy",
  "pre-approved",
  "allow",
  "allowed",
  "default",
  "prefer",
  "preferred",
  "must",
  "should",
  "always",
  "never",
  "rule",
  "decided",
  "convention",
  "override",
  "required",
  "recommend",
] as const;

// ---------------------------------------------------------------------------
// Statement extraction (paragraph / list-item split)
// ---------------------------------------------------------------------------

interface Statement {
  text: string;
  /** 0-indexed start line within the source. */
  startLine: number;
}

/**
 * Extract logical statements from policy lines.
 *
 * A statement is either a paragraph (blank-line-delimited block) or an
 * individual list item. Identical structure to the helper in
 * `src/domain/ask/policy.ts`; kept local here to avoid coupling the action
 * coverage path to the Ask coverage path.
 */
function extractStatements(lines: string[]): Statement[] {
  const out: Statement[] = [];
  let buf: string[] = [];
  let start = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    if (trimmed === "") {
      if (buf.length > 0) {
        out.push({ text: buf.join("\n"), startLine: start });
        buf = [];
      }
      continue;
    }

    if (/^[-*]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
      if (buf.length > 0) {
        out.push({ text: buf.join("\n"), startLine: start });
        buf = [];
      }
      start = i;
      buf.push(line);
      out.push({ text: buf.join("\n"), startLine: start });
      buf = [];
      continue;
    }

    if (buf.length === 0) start = i;
    buf.push(line);
  }

  if (buf.length > 0) out.push({ text: buf.join("\n"), startLine: start });
  return out;
}

function truncateSpan(text: string, max = 240): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 3)}...`;
}

// ---------------------------------------------------------------------------
// Per-entry coverage check
// ---------------------------------------------------------------------------

/**
 * Check a single policy entry for coverage of the action.
 *
 * Splits the entry into statements, then scans each for both signals.
 * Returns the first matching evidence pointer, or `null` if no statement
 * carries both a category and an authority keyword.
 */
function checkEntry(action: ActionDescriptor, entry: PolicyEntry): CoverageEvidence | null {
  const lines = entry.content.split("\n");
  const statements = extractStatements(lines);
  const categoryKeys = CATEGORY_KEYWORDS[action.reason] ?? [];

  for (const stmt of statements) {
    const lower = stmt.text.toLowerCase();

    const matchedCategory = categoryKeys.find((kw) => lower.includes(kw.toLowerCase()));
    if (!matchedCategory) continue;

    const matchedAuthority = AUTHORITY_KEYWORDS.find((kw) => lower.includes(kw));
    if (!matchedAuthority) continue;

    const endLine = stmt.startLine + stmt.text.split("\n").length - 1;
    return {
      policySource: entry.source,
      span: truncateSpan(stmt.text),
      lineRange: [stmt.startLine + 1, endLine + 1],
      matchedCategory,
      matchedAuthority,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decide whether the policy corpus covers the given action.
 *
 * Iterates entries in the order produced by the loader (task spec → CLAUDE.md
 * → rules → memories → policy files). On the first matching entry, returns
 * `{ covered: true, evidence: [...] }`. If no entry matches, returns
 * `{ covered: false }`.
 *
 * Per ADR-008 §Router: an action is covered if policy names the action or
 * its category AND names the authority. Both signals must appear in the
 * same statement (paragraph or list item).
 */
export function decideCoverage(action: ActionDescriptor, corpus: PolicyCorpus): CoverageResult {
  const evidence: CoverageEvidence[] = [];

  for (const entry of corpus.entries) {
    if (entry.category === "unavailable") continue;
    const ev = checkEntry(action, entry);
    if (ev !== null) {
      evidence.push(ev);
      return { covered: true, evidence };
    }
  }

  return { covered: false };
}

/**
 * Internal helpers exported for tests only — do not import from production code.
 */
export const __TEST_ONLY = {
  extractStatements,
  truncateSpan,
  CATEGORY_KEYWORDS,
  AUTHORITY_KEYWORDS,
} as const;
