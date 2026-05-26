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
 * Determine whether a single policy text covers the given Ask.
 *
 * Coverage requires two signals:
 *   1. The action name appears in a statement (case-insensitive substring match).
 *   2. An authority keyword appears in the same statement (case-insensitive).
 *
 * "Statement" is defined as a paragraph (blank-line-delimited block) or a
 * list item (line starting with `-`, `*`, or a number followed by `.`).
 * This is intentionally simple — ADR-008 notes the semantics are candidates
 * for refinement after false-positive data is collected.
 */
function checkSingleSource(ask: Ask, source: PolicyText): CoverageResult {
  const actionName = deriveActionName(ask);
  const lines = source.content.split("\n");

  // Split into "statements": paragraphs and list items.
  const statements = extractStatements(lines);

  for (const { text, startLine } of statements) {
    const lowerText = text.toLowerCase();

    // Signal 1: action name appears in the statement.
    if (!lowerText.includes(actionName.toLowerCase())) {
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

/**
 * Derive the action name to search for from an Ask.
 *
 * Uses the Ask `kind` domain part (e.g., "authorization.approve" → "approve"),
 * the full kind label, and any action name embedded in the Ask title/question
 * as supplementary search tokens. The primary match key is the full kind string
 * plus the verb component.
 */
function deriveActionName(ask: Ask): string {
  // The kind itself is the primary action name for routing purposes.
  // "authorization.approve" → we search for "approve" (the action verb).
  // Callers may also embed action context in the title; this is a v1 heuristic.
  const kindParts = ask.kind.split(".");
  return kindParts[kindParts.length - 1] ?? ask.kind;
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
 * Sources are evaluated in order (ADR-008 §Router priority: CLAUDE.md first,
 * then project rules, then task spec, then memories). Returns on the first
 * match; the caller need not inspect all sources if one covers.
 */
export function isCovered(ask: Ask, sources: PolicyText[]): CoverageResult {
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
