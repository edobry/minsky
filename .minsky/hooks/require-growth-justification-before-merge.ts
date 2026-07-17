#!/usr/bin/env bun
// PreToolUse hook (mt#2874): block session_pr_merge when a PR touches
// `.minsky/rules/**` AND grows the committed CLAUDE.md by more than a
// threshold, without a `Size-budget justification:` marker in the PR body.
//
// Why: the mt#2802 aggregate size-budget check (rules compile --check) makes
// CLAUDE.md's total regrowth visible, but it puts the COST of a 140K
// warn/fail on whichever agent happens to merge at that threshold — not on
// the author whose PR actually caused the growth. Pricing growth at the
// SOURCE (the PR that adds it) fixes the incentive mismatch: a PR that grows
// always-loaded context by more than a couple thousand chars must justify
// why the content needs to be always-loaded, and which cheaper channels
// (path-scoped `.claude/rules`, a skill, memory, docs) were rejected first.
//
// Modeled on require-execution-evidence-before-merge.ts: reuses the shared
// PR-data fetch layer (./pr-context, mt#2617) and the mt#2648 marker-
// acceptance forms (a plain "Label:" line, or a Markdown heading of any
// level with an optional trailing colon, case-insensitive).
//
// Escape hatch: MINSKY_SKIP_SIZE_JUSTIFICATION=1 — operator override,
// audit-logged (registered in HOOK_ONLY_ENV_VARS).
//
// @see mt#2874 — this hook
// @see mt#2802 — the aggregate size-budget check this gate complements (the
//   "cost at merge time" mechanism this gate fixes the incentive for)
// @see mt#2648 — marker-acceptance forms shared with the execution-evidence
//   and deploy-verification gates
// @see mt#2617 — shared PR-data fetch layer (./pr-context)

import { readInput, writeOutput } from "./types";
import type { ToolHookInput } from "./types";
import {
  deriveRepoFromGit,
  fetchPrContext,
  fetchMergeBaseSha,
  fetchFileSizeAtRef,
  formatContextFailureWarnings,
} from "./pr-context";
import type { PrFile } from "./pr-context";

// ---------------------------------------------------------------------------
// Override env var (single source of truth — also registered in HOOK_ONLY_ENV_VARS)
// ---------------------------------------------------------------------------

/** Operator override: skip the growth-justification gate. Audit-logged when set. */
export const OVERRIDE_ENV_VAR = "MINSKY_SKIP_SIZE_JUSTIFICATION";

/** True when the override env var is set to a truthy value (1/true/yes). */
export function isOverrideSet(): boolean {
  const v = process.env[OVERRIDE_ENV_VAR];
  return v === "1" || v === "true" || v === "yes";
}

// ---------------------------------------------------------------------------
// Trigger constants
// ---------------------------------------------------------------------------

/** Path prefix identifying a rules-directory file (the "diff touches .minsky/rules/**" trigger half). */
export const RULES_DIR_PREFIX = ".minsky/rules/";

/**
 * Growth threshold (chars) above which a rules-touching PR must carry a
 * `Size-budget justification:` marker. Calibrated per the mt#2874 spec's
 * §Thresholds grounding: ~the smallest deliberate rule addition observed
 * (mt#2801 added ~3.3K; incidental same-day growths ran 2.7-3K) — a
 * one-line factual edit stays comfortably under it. Reductions (delta <= 0)
 * never trigger regardless of magnitude. Exposed as a named export (not
 * inlined) so the value is tunable from one place and directly assertable
 * in tests.
 */
export const GROWTH_THRESHOLD_CHARS = 2000;

/** The file whose growth this gate prices. */
export const TARGET_FILE = "CLAUDE.md";

// ---------------------------------------------------------------------------
// File-path matching
// ---------------------------------------------------------------------------

/** True when `filename` lives under `.minsky/rules/`. Null/undefined-safe. */
export function isRulesDirFile(filename: string | null | undefined): boolean {
  if (typeof filename !== "string") return false;
  return filename.startsWith(RULES_DIR_PREFIX);
}

/**
 * Filter a PR's changed files to those touching `.minsky/rules/**`. Mirrors
 * `findDeploySurfaceFiles`'s two-check shape (deploy-surface-detector.ts):
 * checks BOTH `filename` (covers added/modified/removed) and
 * `previous_filename` (covers a rename INTO or OUT OF the rules dir) so a
 * rename away from `.minsky/rules/` still counts as a rules-dir change.
 */
export function findRulesDirFiles(files: PrFile[]): string[] {
  return files
    .filter((f) => isRulesDirFile(f.filename) || isRulesDirFile(f.previous_filename))
    .map((f) => f.filename);
}

// ---------------------------------------------------------------------------
// PR body marker parsing (mt#2648 accepted forms)
// ---------------------------------------------------------------------------

/**
 * Marker for the size-budget justification (mt#2648 — same accepted-forms
 * class as `hasExecutionEvidence` / `hasDeployVerification`). Accepts,
 * case-insensitive:
 *   A. A Markdown heading (any level 1-6) + "size-budget justification"
 *      with an OPTIONAL trailing colon.
 *   B. A plain label line — "size-budget justification:" with a REQUIRED
 *      colon (no heading marker) — keeps the colon required here so bare
 *      prose mentions don't false-positive.
 * Up to 3 leading spaces before a heading marker, per CommonMark.
 */
const SIZE_BUDGET_JUSTIFICATION_MARKER =
  /^(?: {0,3}(#{1,6})\s+size-budget justification\s*:?|size-budget justification\s*:)\s*(.*)$/im;

/**
 * True when the PR body contains a `Size-budget justification:` block with
 * non-empty content following the marker. Mirrors `hasExecutionEvidence`'s
 * discipline: HTML comments stripped first; a "No Size-budget
 * justification:" negation does NOT qualify; content must follow the
 * marker (inline or on subsequent lines before the next heading).
 */
export function hasSizeBudgetJustification(prBody: string): boolean {
  const stripped = prBody.replace(/<!--[\s\S]*?-->/g, "");
  const lines = stripped.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = line.match(SIZE_BUDGET_JUSTIFICATION_MARKER);
    if (!match) continue;

    // Negation guard: "No Size-budget justification:" / "## No Size-budget justification:".
    const beforeMarker = line.slice(0, line.toLowerCase().indexOf("size-budget")).toLowerCase();
    if (/\bno\b/.test(beforeMarker)) continue;

    const parts: string[] = [];
    const inlineContent = (match[2] ?? "").trim();
    if (inlineContent.length > 0) parts.push(inlineContent);
    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j];
      if (nextLine === undefined) break;
      if (/^ {0,3}#{1,6}\s/.test(nextLine)) break; // next heading — stop
      if (nextLine.trim().length > 0) parts.push(nextLine.trim());
    }
    if (parts.join(" ").trim().length === 0) continue; // empty section — keep looking

    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Core check logic (pure / injectable)
// ---------------------------------------------------------------------------

export interface GrowthJustificationCheckResult {
  /** Whether merge should be blocked. */
  blocked: boolean;
  /** Human-readable reason if blocked; undefined if allowed. */
  reason?: string;
  /** Rules-directory files found in the PR diff (empty when the gate is silent). */
  rulesFiles: string[];
  /**
   * `headSizeChars - baseSizeChars` for the target file. `null` only when
   * the gate never reached the size comparison (no rules files touched).
   */
  deltaChars: number | null;
  /** Whether the justification marker was found (only meaningful when growth exceeded the threshold). */
  justificationFound: boolean;
  /** Any non-fatal warnings to surface. */
  warnings: string[];
}

/**
 * Evaluate the growth-justification check given the PR's changed files, its
 * body, and the target file's measured size at head and at the PR's
 * merge-base. Pure core of the hook — injectable for unit tests (no `gh`
 * calls happen in here; the top-level entrypoint below resolves the two
 * sizes and passes them in).
 */
export function checkGrowthJustification(
  files: PrFile[],
  prBody: string,
  headSizeChars: number,
  baseSizeChars: number
): GrowthJustificationCheckResult {
  const warnings: string[] = [];
  const rulesFiles = findRulesDirFiles(files);

  // Diff doesn't touch .minsky/rules/** → hook is silent, regardless of size delta.
  if (rulesFiles.length === 0) {
    return {
      blocked: false,
      rulesFiles: [],
      deltaChars: null,
      justificationFound: false,
      warnings,
    };
  }

  const deltaChars = headSizeChars - baseSizeChars;

  // Reductions (delta <= 0) and sub-threshold growth never trigger — a plain
  // "<=" comparison, not "<", so a delta exactly AT the threshold does not
  // yet trigger (parity with the acceptance test's "growth 1.5K -> allowed"
  // case and the general "exceeds" framing in the spec: the gate fires once
  // growth is STRICTLY greater than the threshold).
  if (deltaChars <= GROWTH_THRESHOLD_CHARS) {
    return {
      blocked: false,
      rulesFiles,
      deltaChars,
      justificationFound: false,
      warnings,
    };
  }

  if (hasSizeBudgetJustification(prBody)) {
    return {
      blocked: false,
      rulesFiles,
      deltaChars,
      justificationFound: true,
      warnings,
    };
  }

  const reason = buildDenyMessage(deltaChars, rulesFiles);
  return {
    blocked: true,
    reason,
    rulesFiles,
    deltaChars,
    justificationFound: false,
    warnings,
  };
}

/**
 * Build the deny message. Per the mt#2874 spec: states the measured delta,
 * reproduces the rule-admission ladder (kept byte-consistent with the
 * key-architecture.mdc bullet and the create-rule skill — see mt#2874 PR
 * body for the cross-check), and names the marker form.
 */
function buildDenyMessage(deltaChars: number, rulesFiles: string[]): string {
  const fileList = rulesFiles.map((f) => `  - ${f}`).join("\n");
  return (
    `Merge blocked: this PR touches .minsky/rules/** and grows ${TARGET_FILE} by ` +
    `${deltaChars} chars (threshold: ${GROWTH_THRESHOLD_CHARS} chars) with no ` +
    `\`Size-budget justification:\` marker in the PR body.\n\n` +
    `Rule-admission ladder — new guidance content defaults DOWN:\n` +
    `  1. path-scoped \`.claude/rules\` — file-shaped guidance\n` +
    `  2. skill — task-shaped guidance\n` +
    `  3. memory — incident-shaped guidance\n` +
    `  4. docs — reference-shaped guidance\n` +
    `  5. \`alwaysApply: true\` — LAST, reserved for genuinely per-turn discipline ` +
    `(mt#1876 criterion: "would removal cause an agent to skip a check it runs every turn?")\n\n` +
    `Rules files touched:\n${fileList}\n\n` +
    `To unblock, choose one of:\n` +
    `  1. Add a \`Size-budget justification:\` section (plain label with colon, or a Markdown ` +
    `heading of any level with an optional trailing colon) to the PR body naming why this ` +
    `content must be always-loaded and which cheaper channels above were rejected ` +
    `(use mcp__minsky__session_pr_edit to update the body).\n` +
    `  2. Move the content down the ladder instead of \`alwaysApply: true\`.\n` +
    `  3. Operator override: set \`${OVERRIDE_ENV_VAR}=1\` (audit-logged).`
  );
}

// ---------------------------------------------------------------------------
// Top-level hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const input = await readInput<ToolHookInput>();

  // Operator override: skip with an audit line on stdout (non-JSON — Claude
  // Code's hook-output parser logs it as "Ignoring non-JSON line"), matching
  // the sibling override-audit convention. Never echoes the env value.
  if (isOverrideSet()) {
    process.stdout.write(
      `[growth-justification] override active: ${OVERRIDE_ENV_VAR} set at ` +
        `${new Date().toISOString()} — growth-justification gate skipped (value not echoed)\n`
    );
    process.exit(0);
  }

  const task = (input.tool_input.task as string | undefined) ?? "";
  if (!task) process.exit(0);

  const repo = deriveRepoFromGit(input.cwd);
  if (!repo) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          "⚠️ [growth-justification] Could not derive owner/repo from git remote — check skipped.",
      },
    });
    process.exit(0);
  }

  const context = fetchPrContext(repo, { task, cwd: input.cwd, include: { files: true } });

  if (!context.ok) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: formatContextFailureWarnings(context)
          .map((w) => `⚠️ ${w}`)
          .join("\n"),
      },
    });
    process.exit(0);
  }

  const { headSha, baseBranch, body: prBody, files: prFiles, warnings: topLevelWarnings } = context;

  // Cheap short-circuit BEFORE the size-comparison `gh` calls: a PR that
  // doesn't touch .minsky/rules/** never needs the merge-base/head size
  // fetch — saves 2 `gh` round-trips on the common case (most PRs don't
  // touch rules at all).
  const rulesFiles = findRulesDirFiles(prFiles);
  if (rulesFiles.length === 0) {
    if (topLevelWarnings.length > 0) {
      writeOutput({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: topLevelWarnings.map((w) => `⚠️ ${w}`).join("\n"),
        },
      });
    }
    process.exit(0);
  }

  const mergeBaseSha = fetchMergeBaseSha(repo, baseBranch, headSha, { cwd: input.cwd });
  if (!mergeBaseSha) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          `⚠️ [growth-justification] Could not resolve merge-base commit for ${baseBranch}...` +
          `${headSha} — size-justification check skipped.`,
      },
    });
    process.exit(0);
  }

  const headSizeChars = fetchFileSizeAtRef(repo, TARGET_FILE, headSha, { cwd: input.cwd });
  const baseSizeChars = fetchFileSizeAtRef(repo, TARGET_FILE, mergeBaseSha, { cwd: input.cwd });

  if (headSizeChars === null || baseSizeChars === null) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          `⚠️ [growth-justification] Could not fetch ${TARGET_FILE} size at head or merge-base ` +
          `— size-justification check skipped.`,
      },
    });
    process.exit(0);
  }

  const result = checkGrowthJustification(prFiles, prBody, headSizeChars, baseSizeChars);
  const allWarnings = [...topLevelWarnings, ...result.warnings];

  if (result.blocked) {
    const warningContext =
      allWarnings.length > 0 ? `${allWarnings.map((w) => `⚠️ ${w}`).join("\n")}\n\n` : "";
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${warningContext}${result.reason}`,
      },
    });
  } else if (allWarnings.length > 0) {
    writeOutput({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: allWarnings.map((w) => `⚠️ ${w}`).join("\n"),
      },
    });
  }
}
