/**
 * Policy source loading and coverage decisions for the Ask router.
 *
 * The router consults policy before routing uncovered asks to external transports.
 * Coverage requires TWO signals per ADR-008 §Router:
 *   1. The action name (or its category) is named in the policy text.
 *   2. An authority keyword is named — indicating who or what approves/resolves it.
 *
 * Name-match alone is insufficient (prevents false green-lights from incidental
 * mentions). Both signals must be present in the same policy statement.
 *
 * Policy source ordering (ADR-008 §Router):
 *   1. CLAUDE.md rules
 *   2. Project rules (.claude/rules/*.md, .cursor/rules/*.mdc)
 *   3. Task spec constraints
 *   4. Long-lived memories (v1 placeholder — not loaded)
 *   5. .minsky/policy/* (future, not yet loaded)
 *
 * Reference: docs/architecture/adr-008-attention-allocation-subsystem.md §Router
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { glob } from "glob";

import type { Ask } from "./types";
import { safeTruncate } from "@minsky/shared/safe-truncate";

// ---------------------------------------------------------------------------
// Policy text types
// ---------------------------------------------------------------------------

/** A policy text fragment from a named source. */
export interface PolicyText {
  /** Human-readable name for citation (e.g., "CLAUDE.md", "rules/ci-policy.md"). */
  source: string;
  /** The full content of the policy document. */
  content: string;
}

// ---------------------------------------------------------------------------
// Coverage decision
// ---------------------------------------------------------------------------

/** A specific citation from a policy source. */
export interface PolicyCitation {
  /** Which source document was cited (e.g., "CLAUDE.md", "rules/ci-policy.md"). */
  source: string;
  /** Approximate line range of the matching statement, when detectable. */
  lineRange?: [number, number];
  /** The text that triggered the coverage match. */
  quote: string;
}

/** Result of a coverage decision. */
export interface CoverageResult {
  covered: boolean;
  citation?: PolicyCitation;
}

/**
 * Authority keywords per ADR-008 §Router (strict starting position).
 *
 * A policy statement covers an action only if it names an authority — not just
 * an action. These keywords mark statements that explicitly grant or pre-authorize
 * a class of actions.
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
] as const;

/**
 * Kinds eligible for phase-1 policy short-circuit (mt#2666 layer 2).
 *
 * The AUTHORITY_KEYWORDS vocabulary (auto-approve / authorized / permitted /
 * pre-approved / allow) is authorization vocabulary: the short-circuit's
 * intent is "policy pre-authorizes this action, no human needed." Kinds whose
 * answer is a decision, a review verdict, information, or coordination are
 * not pre-answerable by an authority citation and always proceed to phase-2
 * kind routing.
 *
 * Originating incident (c26eca0a, 2026-07-08): the previous kind-verb match
 * closed EVERY quality.review Ask against this repo's CLAUDE.md — the word
 * "review" co-occurs with "allow"/"policy" in dozens of paragraphs — silently
 * destroying an operator-bound disposition Ask at creation.
 */
const POLICY_ELIGIBLE_KINDS: ReadonlySet<Ask["kind"]> = new Set([
  "authorization.approve",
] as Ask["kind"][]);

/**
 * Generic tokens excluded from title-derived action names (mt#2666 layer 3).
 * Two groups: kind-taxonomy words (which would reintroduce the category-match
 * failure mode via titles like "Commit authorization: ..."), and English glue
 * common in ask titles. Tokens under 4 characters are excluded structurally.
 */
const TITLE_TOKEN_STOPWORDS: ReadonlySet<string> = new Set([
  // kind-taxonomy words
  "authorization",
  "authorize",
  "approve",
  "approval",
  "review",
  "decide",
  "decision",
  "request",
  "escalate",
  "notify",
  "retrieve",
  "unblock",
  // English glue
  "this",
  "that",
  "with",
  "from",
  "into",
  "before",
  "after",
  "should",
  "would",
  "could",
  "about",
  "please",
  "needs",
  "your",
  "call",
  "action",
]);

/**
 * Extract the explicit action-name tokens from an Ask's title (mt#2666
 * layer 3). ADR-008 §9 requires an "explicit action-name" — the action being
 * authorized is named by the ask itself, not by its kind taxonomy (the
 * previous kind-verb derivation was category-matching, which §9 calls
 * insufficient). Tokens are lowercase, >=4 chars, stopword-filtered,
 * deduplicated.
 */
export function extractActionTokens(ask: Ask): string[] {
  const tokens = ask.title.toLowerCase().match(/[a-z0-9_./-]{4,}/g) ?? [];
  return [...new Set(tokens.filter((t) => !TITLE_TOKEN_STOPWORDS.has(t)))];
}

/**
 * Determine whether a single policy text covers the given Ask.
 *
 * Coverage requires two signals per ADR-008 §9 ("explicit action-name AND
 * authority-citation required ... Name-match alone insufficient"):
 *   1. At least one of the Ask's title-derived action tokens appears in a
 *      statement (case-insensitive substring match).
 *   2. An authority keyword appears in the same statement (case-insensitive).
 *
 * "Statement" is defined as a paragraph (blank-line-delimited block) or a
 * list item (line starting with `-`, `*`, or a number followed by `.`).
 * This remains intentionally simple — ADR-008 notes the semantics are
 * candidates for refinement (the deeper semantic-relevance matcher shares a
 * family with mt#1698).
 */
function checkSingleSource(ask: Ask, source: PolicyText): CoverageResult {
  const actionTokens = extractActionTokens(ask);
  if (actionTokens.length === 0) {
    // No explicit action name available — per ADR-008 §9 there is nothing to
    // match explicitly, so policy cannot cover the ask.
    return { covered: false };
  }
  const lines = source.content.split("\n");

  // Split into "statements": paragraphs and list items.
  const statements = extractStatements(lines);

  for (const { text, startLine } of statements) {
    const lowerText = text.toLowerCase();

    // Signal 1: an explicit action token from the ask's title appears.
    if (!actionTokens.some((t) => lowerText.includes(t))) {
      continue;
    }

    // Signal 2: an authority keyword appears in the same statement.
    const authorityMatch = AUTHORITY_KEYWORDS.find((kw) => lowerText.includes(kw));
    if (!authorityMatch) {
      continue;
    }

    // Both signals present — covered.
    const endLine = startLine + text.split("\n").length - 1;
    const quote = truncateQuote(text);
    return {
      covered: true,
      citation: {
        source: source.source,
        lineRange: [startLine + 1, endLine + 1], // 1-indexed for human display
        quote,
      },
    };
  }

  return { covered: false };
}

/** A parsed statement block with its start line (0-indexed). */
interface Statement {
  text: string;
  startLine: number;
}

/**
 * Extract logical statements from lines for coverage matching.
 *
 * A statement is either a paragraph (blank-line-delimited block) or
 * an individual list item. Headings are kept as part of their following
 * paragraph to give context.
 */
function extractStatements(lines: string[]): Statement[] {
  const statements: Statement[] = [];
  let currentLines: string[] = [];
  let currentStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    // A blank line flushes the current block.
    if (trimmed === "") {
      if (currentLines.length > 0) {
        statements.push({ text: currentLines.join("\n"), startLine: currentStart });
        currentLines = [];
      }
      continue;
    }

    // A list item is emitted as its own statement (plus any trailing continuation).
    if (/^[-*]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) {
      if (currentLines.length > 0 && !isListContinuation(currentLines)) {
        // Flush prior non-list block.
        statements.push({ text: currentLines.join("\n"), startLine: currentStart });
        currentLines = [];
      }
      if (currentLines.length === 0) {
        currentStart = i;
      }
      currentLines.push(line);
      // Emit the list item immediately so it stands alone.
      statements.push({ text: currentLines.join("\n"), startLine: currentStart });
      currentLines = [];
      continue;
    }

    // Normal text line — accumulate.
    if (currentLines.length === 0) {
      currentStart = i;
    }
    currentLines.push(line);
  }

  // Flush any remaining block.
  if (currentLines.length > 0) {
    statements.push({ text: currentLines.join("\n"), startLine: currentStart });
  }

  return statements;
}

/** Returns true if `lines` is already in the middle of a list block. */
function isListContinuation(lines: string[]): boolean {
  const last = lines[lines.length - 1]?.trim() ?? "";
  return /^[-*]\s/.test(last) || /^\d+\.\s/.test(last);
}

/** Truncate a long quote for the citation; preserves the matching line. */
function truncateQuote(text: string, maxLength = 200): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${safeTruncate(trimmed, maxLength - 3, "head")}...`;
}

// ---------------------------------------------------------------------------
// Coverage decision — public API
// ---------------------------------------------------------------------------

/**
 * Determine whether any of the given policy sources covers the Ask.
 *
 * Two structural gates run before any text matching (mt#2666):
 *   1. Options escape — an Ask carrying `options` is a decision menu; a
 *      policy citation cannot answer "which option" (ADR-008 §Packaging:
 *      options are present when the kind is decision-like).
 *   2. Kind restriction — only POLICY_ELIGIBLE_KINDS (authorization
 *      semantics) can be pre-answered by an authority citation.
 *
 * Sources are then evaluated in order (ADR-008 §Router priority: CLAUDE.md
 * first, then project rules, then task spec, then memories). Returns on the
 * first match; the caller need not inspect all sources if one covers.
 */
export function isCovered(ask: Ask, sources: PolicyText[]): CoverageResult {
  if (ask.options && ask.options.length > 0) {
    return { covered: false };
  }
  if (!POLICY_ELIGIBLE_KINDS.has(ask.kind)) {
    return { covered: false };
  }
  for (const source of sources) {
    const result = checkSingleSource(ask, source);
    if (result.covered) {
      return result;
    }
  }
  return { covered: false };
}

// ---------------------------------------------------------------------------
// Policy source loaders
// ---------------------------------------------------------------------------

/**
 * Load CLAUDE.md from the given workspace root.
 *
 * Returns an empty array if the file does not exist (non-fatal; the workspace
 * may not have a CLAUDE.md).
 */
export async function loadClaudeMd(workspaceRoot: string): Promise<PolicyText[]> {
  const filePath = join(workspaceRoot, "CLAUDE.md");
  try {
    const raw = await readFile(filePath, "utf-8");
    const content = String(raw);
    return [{ source: "CLAUDE.md", content }];
  } catch {
    return [];
  }
}

/**
 * Load project rules from `.claude/rules/*.md` and `.cursor/rules/*.mdc`.
 *
 * Returns an empty array if no rule files are found.
 */
export async function loadProjectRules(workspaceRoot: string): Promise<PolicyText[]> {
  const patterns = [
    join(workspaceRoot, ".claude", "rules", "*.md"),
    join(workspaceRoot, ".cursor", "rules", "*.mdc"),
  ];

  const results: PolicyText[] = [];

  for (const pattern of patterns) {
    let files: string[];
    try {
      files = await glob(pattern, { nodir: true });
    } catch {
      files = [];
    }

    for (const filePath of files) {
      try {
        const raw = await readFile(filePath, "utf-8");
        const content = String(raw);
        // Use a relative path from workspace root for readable citations.
        const relativePath = filePath.startsWith(workspaceRoot)
          ? filePath.slice(workspaceRoot.length + 1)
          : filePath;
        results.push({ source: relativePath, content });
      } catch {
        // Skip unreadable files.
      }
    }
  }

  return results;
}

/**
 * Load a task spec as a policy source.
 *
 * Returns an empty array if `specContent` is null/undefined (the ask may not
 * have a parent task, or the spec may not exist).
 */
export function loadTaskSpec(specContent: string | null | undefined): PolicyText[] {
  if (!specContent) return [];
  return [{ source: "task-spec", content: specContent }];
}

/**
 * Placeholder for long-lived memory policy sources.
 *
 * v1: memories are not loaded — this is a future extension point.
 * Returns an empty array.
 */
export function loadMemories(): PolicyText[] {
  // v1 placeholder: long-lived memories are not consulted at router time.
  // When the memory provider (mt#1034 future) is available, this loader
  // will query the memory store for entries tagged with the Ask's kind.
  return [];
}

// ---------------------------------------------------------------------------
// Composite loader
// ---------------------------------------------------------------------------

/**
 * Load all policy sources in ADR-008 priority order:
 *   1. CLAUDE.md
 *   2. Project rules (.claude/rules/*.md, .cursor/rules/*.mdc)
 *   3. Task spec (caller provides the content)
 *   4. Memories (v1 placeholder — always empty)
 *
 * The `workspaceRoot` is the project root on disk. `specContent` is the
 * optional task spec text; pass `null` to skip.
 */
export async function loadAllPolicySources(
  workspaceRoot: string,
  specContent?: string | null
): Promise<PolicyText[]> {
  const [claudeMd, projectRules] = await Promise.all([
    loadClaudeMd(workspaceRoot),
    loadProjectRules(workspaceRoot),
  ]);

  const taskSpec = loadTaskSpec(specContent);
  const memories = loadMemories();

  return [...claudeMd, ...projectRules, ...taskSpec, ...memories];
}
