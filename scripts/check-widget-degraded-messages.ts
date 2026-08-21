#!/usr/bin/env bun
/**
 * mt#3825 — fail if a cockpit widget's degraded-catch `reason` still
 * interpolates a raw caught-error message instead of going through
 * `describeWidgetDegradedReason()` (`src/cockpit/db-providers.ts`).
 *
 * Before this task, every DB-backed cockpit widget's top-level catch-all
 * built its degraded reason as `` `${widgetName} error: ${message}` ``,
 * where `message` was the caught error's `.message` verbatim. For a
 * postgres.js connect-level failure that message IS the driver artifact
 * `write CONNECT_TIMEOUT undefined:undefined` — see
 * `describeWidgetDegradedReason`'s docstring for the full mechanism. This
 * script is the mechanical completeness check for that conversion: it finds
 * any widget `reason:` site that still builds its message from a raw
 * template-literal interpolation instead of the shared classifier.
 *
 * Sibling of `scripts/check-sql-capability-messages.ts` (mt#3661), which
 * checks a different but structurally identical hazard (a cause-free
 * "not SQL-capable" message) via the same honored-marker convention rather
 * than a `grep -v` pipeline — the intentional exemptions here (mt#3661
 * Category B: genuine not-found / missing-param widget states that are
 * already cause-carrying) are annotated with a marker comment on the line
 * ABOVE the match, which a flat `grep -v` cannot see.
 *
 *   bun scripts/check-widget-degraded-messages.ts
 *
 * WHERE THIS RUNS (mt#4398): **nowhere — this script has NO caller.** Not CI,
 * not a package script, not a git hook; a full-tree reference search finds it
 * mentioned only by itself. It currently PASSES, which is why nothing has gone
 * wrong yet, and is also why the state is easy to miss: a passing check and an
 * unrun check are indistinguishable from outside.
 *
 * Recorded here rather than only in a task spec, because leaving it in a spec
 * reproduces the exact defect mt#4398 was filed for one file over — its sibling
 * `check-sql-capability-messages.ts` sat exiting 1 with no caller and no
 * pointer, and nobody could tell. Wiring this one is tracked by **mt#4400**,
 * which measured the class: five of nine `scripts/check-*.ts` have no
 * invocation path. If you wire it, replace this paragraph with the invocation
 * point the way the sibling's header now names its own.
 *
 * Exit 0 = every remaining `reason:` template-literal interpolation is
 * either a comment or explicitly marked.
 * Exit 1 = at least one unmarked site — the list is printed.
 *
 * KNOWN BLIND SPOT — this matches SHAPE (a backtick `reason:` template with
 * an interpolation), not semantics. A widget that builds its degraded reason
 * some OTHER way (string concatenation, a helper that itself leaks a raw
 * message) is invisible here, mirroring check-sql-capability-messages.ts's
 * own documented phrase-vs-structure blind spot.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

/** Directory this check scans — cockpit widgets only. */
const WIDGETS_DIR = join("src", "cockpit", "widgets");

/**
 * Opt-out annotation; must appear within MARKER_LOOKBEHIND lines above the
 * match. Mirrors check-sql-capability-messages.ts's own marker convention.
 */
const MARKER = "widget-degraded-message:";
const MARKER_LOOKBEHIND = 10;

/** The classifier every converted catch-all site calls. */
const CLASSIFIER_CALL = "describeWidgetDegradedReason(";

/**
 * A `reason:` field built from a backtick template with an interpolation.
 * `g` is required: the scan below uses `matchAll`, which throws on a non-global
 * regex. The negated class spans newlines, so the match may cover several lines.
 */
const INTERPOLATED_REASON = /reason:\s*`[^`]*\$\{/g;

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*");
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    // Symlinked/inaccessible entries must not abort the whole sweep.
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      yield* walk(full);
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      yield full;
    }
  }
}

function markedAbove(lines: string[], i: number): boolean {
  return lines
    .slice(Math.max(0, i - MARKER_LOOKBEHIND), i)
    .join("\n")
    .includes(MARKER);
}

const violations: string[] = [];

for (const file of walk(WIDGETS_DIR)) {
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");

  // Scanned over the whole SOURCE, not line-by-line: a `reason:` whose template
  // literal wraps before its `${` interpolation is exactly the shape this check
  // exists to catch, and a per-line scan cannot see it (PR #2702 R1). The
  // negated class `[^`]` already spans newlines, so only the iteration had to
  // change. Line numbers are recovered from the match offset for reporting and
  // for the marker lookbehind, which stay line-oriented.
  for (const match of source.matchAll(INTERPOLATED_REASON)) {
    const index = match.index ?? 0;
    const i = source.slice(0, index).split("\n").length - 1;

    // The classifier call can land on a later line than `reason:` for the same
    // reason the interpolation can, so test the whole matched span, not the
    // first line of it.
    if (match[0].includes(CLASSIFIER_CALL)) continue;
    if (isCommentLine(lines[i] ?? "")) continue;
    if (markedAbove(lines, i)) continue;
    violations.push(`${file}:${i + 1}: ${(lines[i] ?? "").trim()}`);
  }
}

if (violations.length > 0) {
  console.error(
    `FAIL: ${violations.length} cockpit widget degraded-reason site(s) still interpolate a raw message:\n`
  );
  for (const v of violations) console.error(`  ${v}`);
  console.error(
    "\nRoute the reason through describeWidgetDegradedReason() (src/cockpit/db-providers.ts), " +
      `or annotate the site with a "// ${MARKER} <reason>" comment above it.`
  );
  process.exit(1);
}

console.log(
  "PASS: every cockpit widget degraded-reason site routes through describeWidgetDegradedReason() (or is explicitly marked)"
);
process.exit(0);
