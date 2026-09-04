/* eslint-disable custom/no-real-fs-in-tests -- this check's entire subject is the REAL source
   tree: it asserts that no live-corpus replay script resolves a calibration log against the repo
   root. A mocked filesystem would assert that a fixture I wrote contains what I put in it, which
   is the can't-fail probe (mem#704) rather than the check. Same reasoning, and the same
   file-scoped exemption, as `repo-rooted-telemetry-paths.test.ts` — whose pure/IO split this
   file mirrors: `findRepoRootedCalibrationLiterals` takes source STRINGS and touches no fs, and
   the fs is confined to `sourceOf`. */
/**
 * mt#4971 — the calibration-log readers must not resolve a pre-mt#4748 repo path.
 *
 * ## Why a source scan rather than a behavioural assertion
 *
 * Each script's default is a module-level `const` that is not exported, and importing a script
 * executes its `main()`. So the property has to be checked in the source. This inherits a text
 * scan's bound: it sees literals, not computed paths. It is a floor under a class that had no
 * check at all, not a proof of absence.
 *
 * ## Why these files are listed explicitly
 *
 * `scripts/lib/repo-rooted-telemetry-paths.ts` deliberately excludes `scripts/` from its own
 * scan, with a stated reason: *"a one-shot script that reads or consolidates the OLD location is
 * doing its job"* — `consolidate-evaluation-stream-logs.ts` and the `migrate-*` scripts are
 * exactly that, and a blanket `scripts/` rule would fail them correctly-but-unhelpfully. So this
 * test names the LIVE-CORPUS readers instead, which is the population that exclusion's reason
 * does not cover.
 *
 * A new replay/measure script over a live calibration log belongs in this list. One that
 * intentionally reads the pre-migration location does not.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * Scripts whose default log path must resolve through the writer's own resolver.
 *
 * Verified live 2026-09-04: every one ran clean after the change, and the primary script
 * recovered the real corpus end-to-end via the `CLAUDE_PROJECT_DIR` tier with no `--log`.
 */
export const LIVE_CORPUS_READERS = [
  "scripts/replay-retrospective-trigger-calibration.ts",
  "scripts/measure-ka-rung2-nomination.ts",
  "scripts/replay-bare-entity-ref-suppression.ts",
  "scripts/replay-code-mechanism-calibration.ts",
  "scripts/measure-cma-fp-attribution.ts",
  "scripts/replay-code-mechanism-backing.ts",
  "scripts/replay-offer-shape.ts",
  "scripts/replay-wall-of-text-window.ts",
  "scripts/diagnose-pre-narration-window.ts",
  "scripts/replay-operator-deferral-calibration.ts",
] as const;

/**
 * A repo-rooted calibration-log literal, in BOTH forms the codebase writes them.
 *
 * The decomposed form is not a stylistic variant — it is what made this class undercount during
 * implementation. A first pass grepped only the slash form and reported eight files; the
 * decomposed form hid two more, one of them in a file already being edited for its help text.
 */
const REPO_ROOTED_PATTERNS: readonly RegExp[] = [
  // "…/.minsky/<name>-calibration.jsonl" — the slash form.
  /["'`][^"'`]*\.minsky\/[a-z0-9-]+-calibration\.jsonl["'`]/,
  // join/resolve(…, ".minsky", "<name>-calibration.jsonl") — the decomposed form.
  /["'`]\.minsky["'`]\s*,\s*["'`][a-z0-9-]+-calibration\.jsonl["'`]/,
];

/**
 * Comments are stripped first: several of these files legitimately DISCUSS the old path in a
 * docblock explaining the migration, and flagging that prose would make the fix and its own
 * explanation mutually exclusive.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Pure: every repo-rooted calibration literal in one source string. No fs. */
export function findRepoRootedCalibrationLiterals(source: string): string[] {
  const code = stripComments(source);
  return REPO_ROOTED_PATTERNS.flatMap((p) => {
    const hit = code.match(p);
    return hit ? [hit[0]] : [];
  });
}

function sourceOf(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

describe("mt#4971 — calibration-log readers resolve through the writer's resolver", () => {
  test("every live-corpus reader calls calibrationLogPath", () => {
    const missing = LIVE_CORPUS_READERS.filter((p) => !sourceOf(p).includes("calibrationLogPath("));
    expect(missing).toEqual([]);
  });

  test("no live-corpus reader carries a repo-rooted calibration literal", () => {
    const violations = LIVE_CORPUS_READERS.flatMap((p) =>
      findRepoRootedCalibrationLiterals(sourceOf(p)).map((literal) => `${p}: ${literal}`)
    );
    expect(violations).toEqual([]);
  });

  test("the patterns match the shapes they are meant to catch", () => {
    // Guards the guard: patterns that matched nothing would let both assertions above pass
    // vacuously, which is the failure mode a source scan is most prone to.
    expect(
      findRepoRootedCalibrationLiterals('const L = ".minsky/wall-of-text-calibration.jsonl";')
    ).toEqual(['".minsky/wall-of-text-calibration.jsonl"']);
    expect(
      findRepoRootedCalibrationLiterals(
        'resolve(dir, "..", ".minsky", "pre-narration-calibration.jsonl");'
      )
    ).toEqual(['".minsky", "pre-narration-calibration.jsonl"']);
  });

  test("the patterns do not fire on the post-fix shape", () => {
    expect(
      findRepoRootedCalibrationLiterals(
        'calibrationLogPath("wall-of-text", { fallbackCwd: REPO_ROOT });'
      )
    ).toEqual([]);
  });

  test("a migration script reading the OLD location is not in scope", () => {
    // The exclusion this list depends on, asserted rather than assumed: these scripts DO carry
    // repo-rooted literals, correctly, and are deliberately absent from LIVE_CORPUS_READERS.
    const migrationScripts = ["scripts/consolidate-evaluation-stream-logs.ts"];
    for (const p of migrationScripts) {
      expect(LIVE_CORPUS_READERS).not.toContain(p);
    }
  });
});
