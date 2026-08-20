/**
 * Detector for git conflict markers in staged files (mt#4307).
 *
 * A NUL byte and a conflict marker are the same class of "this file was never
 * meant to be committed in this state", and until this task only one of them was
 * checked. The originating incident: a failed `git stash pop` wrote markers into
 * four rule files plus `src/generated/interceptor-catalog.json`, the commit path
 * carried on, and the pre-push gated suite then failed with
 * `SyntaxError: JSON Parse error: Unrecognized token '<'` across twenty
 * `src/cockpit/**` tests that had nothing to do with the change. The corruption
 * was invisible precisely where it mattered most — `src/generated/**`, which
 * nobody reads by hand.
 *
 * ## What counts as a marker
 *
 * Git writes three line-anchored markers: seven `<` then a label, seven `=`
 * alone, seven `>` then a label. (With `merge.conflictStyle=diff3` it also emits
 * seven `|`; that needs no rule of its own, because such a block still carries
 * the open and close markers below.)
 *
 * ## Why the open/close markers are enough on their own, and the separator is not
 *
 * Measured across this repo before shipping: ZERO files contain any of the three
 * at line start. So an open or close marker fires on sight — nothing legitimate
 * starts a line with exactly seven `<` or `>` followed by a space or end-of-line.
 *
 * The bare separator is different, and it is the one case a naive line-regex gets
 * wrong: a Markdown setext heading underline of exactly seven `=` is
 * indistinguishable from a conflict separator by the line alone. So a separator
 * only counts when the same file carries corroborating evidence — an open or
 * close marker — which is what a real conflict block always has.
 *
 * ## Fenced code blocks in Markdown
 *
 * A document that DOCUMENTS conflict markers will legitimately show one inside a
 * fenced block, and this repo's own rules and specs do exactly that. For
 * Markdown-family files the scan therefore tracks fence state and does not fire
 * on an isolated marker inside a fence.
 *
 * That exemption is deliberately narrow: a COMPLETE conflict block — open, then
 * separator, then close, in order — fires even inside a fence, because unbalanced
 * fences are one of the things a real conflict produces, and a corrupted `.mdc`
 * rule file is the exact case that started this. Documenting a whole conflict
 * block verbatim in a fence is the one shape that trips a false positive; indent
 * it by a space, or use the override.
 */

import { isPathAllowlisted, isOverrideTruthy } from "./nul-byte-detector";

/**
 * Env var that, when truthy (`1`, `true`, `yes`), skips the conflict-marker
 * check. Follows the override-with-audit pattern of `MINSKY_SKIP_NUL_CHECK` and
 * its siblings; registered in `HOOK_ONLY_ENV_VAR_CATEGORIES` as an
 * `operator-override`, with the mirror entry in `known-override-env-vars.ts`.
 */
export const CONFLICT_MARKER_CHECK_OVERRIDE_ENV = "MINSKY_SKIP_CONFLICT_MARKER_CHECK";

/** Re-exported so the pre-commit step reads one import for this check. */
export { isOverrideTruthy };

/** Which of git's three markers a line is. */
export type ConflictMarkerKind = "open" | "separator" | "close";

const OPEN_RE = /^<{7}( |$)/;
const SEPARATOR_RE = /^={7}( |$)/;
const CLOSE_RE = /^>{7}( |$)/;

/** Opens or closes a fenced code block (CommonMark allows up to 3 leading spaces). */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Files where a fenced code block is a real construct rather than incidental text. */
const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set([".md", ".mdc", ".markdown"]);

export function isMarkdownPath(path: string): boolean {
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) return false;
  return MARKDOWN_EXTENSIONS.has(path.slice(lastDot).toLowerCase());
}

/** Classify a single line, or null when it carries no marker. */
export function classifyMarkerLine(line: string): ConflictMarkerKind | null {
  if (OPEN_RE.test(line)) return "open";
  if (SEPARATOR_RE.test(line)) return "separator";
  if (CLOSE_RE.test(line)) return "close";
  return null;
}

interface MarkerHit {
  /** 1-indexed line number. */
  line: number;
  kind: ConflictMarkerKind;
  inFence: boolean;
}

/**
 * Every marker line in `content`, with the fence state it was found in.
 *
 * Fence tracking runs only for Markdown-family paths; elsewhere `inFence` is
 * always false, because a fence is not a construct those files have.
 */
export function findMarkerHits(content: string, path: string): MarkerHit[] {
  const trackFences = isMarkdownPath(path);
  const hits: MarkerHit[] = [];
  let fenceMarker: string | null = null;

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (trackFences) {
      const fence = FENCE_RE.exec(line);
      if (fence) {
        const run = fence[1] ?? "";
        if (fenceMarker === null) {
          fenceMarker = run;
        } else if (run[0] === fenceMarker[0] && run.length >= fenceMarker.length) {
          // A closing fence carries no info text; anything else opens nothing and
          // is just content inside the block.
          if ((fence[2] ?? "").trim() === "") fenceMarker = null;
        }
        continue;
      }
    }

    const kind = classifyMarkerLine(line);
    if (kind) hits.push({ line: i + 1, kind, inFence: fenceMarker !== null });
  }
  return hits;
}

/**
 * True when the hits contain a COMPLETE conflict block: an open, then a
 * separator, then a close, in that order. Fence state is ignored — this shape is
 * what a real conflict looks like, wherever a naive fence scan thinks it sits.
 */
function hasCompleteBlock(hits: readonly MarkerHit[]): boolean {
  let seenOpen = false;
  let seenSeparator = false;
  for (const hit of hits) {
    if (hit.kind === "open") {
      seenOpen = true;
      seenSeparator = false;
    } else if (hit.kind === "separator" && seenOpen) {
      seenSeparator = true;
    } else if (hit.kind === "close" && seenOpen && seenSeparator) {
      return true;
    }
  }
  return false;
}

export interface ConflictMarkerViolation {
  path: string;
  /** 1-indexed line numbers of the marker lines that fired. */
  lines: number[];
  /** Why it fired, for the operator-facing message. */
  reason: "marker" | "complete-block";
}

/** Decide whether one file's marker hits constitute a violation. */
export function evaluateFile(content: string, path: string): ConflictMarkerViolation | null {
  const hits = findMarkerHits(content, path);
  if (hits.length === 0) return null;

  const outsideFence = hits.filter((h) => !h.inFence);
  const anchorsOutside = outsideFence.filter((h) => h.kind !== "separator");

  // An open or close marker outside a fence: unambiguous on its own.
  if (anchorsOutside.length > 0) {
    // A separator only joins the report when the file is genuinely conflicted,
    // which the anchors above establish.
    const reported = outsideFence.map((h) => h.line);
    return { path, lines: reported, reason: "marker" };
  }

  // No anchors outside a fence. The only remaining way to fire is a complete
  // block, which a documented example in a fence does not normally form.
  if (hasCompleteBlock(hits)) {
    return { path, lines: hits.map((h) => h.line), reason: "complete-block" };
  }

  // What is left is an isolated marker inside a fence, or a bare `=======` with
  // nothing to corroborate it — a Markdown setext underline, most likely.
  return null;
}

/**
 * Scan a map of `path -> staged text` for conflict markers.
 *
 * Pure function — content comes in by parameter so tests construct synthetic
 * files without touching the filesystem, matching `detectNulByteViolations`.
 *
 * Allowlisting is shared with the NUL-byte check (`isPathAllowlisted`): both
 * want to skip binary formats, and both want `tests/fixtures/` to be able to
 * carry pathological content on purpose. Note this check deliberately does NOT
 * skip `src/generated/**` — that is precisely where the originating corruption
 * hid.
 */
export function detectConflictMarkerViolations(
  stagedContent: ReadonlyMap<string, string>
): ConflictMarkerViolation[] {
  const violations: ConflictMarkerViolation[] = [];
  for (const [path, content] of stagedContent) {
    if (isPathAllowlisted(path)) continue;
    const violation = evaluateFile(content, path);
    if (violation) violations.push(violation);
  }
  return violations;
}
