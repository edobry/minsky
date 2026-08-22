/**
 * The synthetic-retry sentinel appears in exactly ONE source file (mt#4237).
 *
 * Three modules each spelled `"<synthetic>"` with nothing checking they agreed.
 * The failure mode that made this worth fixing is silent and asymmetric: if the
 * harness ever changes the spelling, a module still holding the old literal does
 * not throw — it simply stops recognizing retry turns, so `modelTierLabel` hands
 * a harness retry a model tier and the cockpit renders it as though a model
 * spoke. Nothing errors anywhere.
 *
 * A type checker cannot catch that (every copy is a valid string), and no
 * behavioural test can either (each module is individually correct against its
 * own copy). The invariant is structural, so the test is structural.
 *
 * ## What counts as an occurrence, and why it is not "a declaration"
 *
 * This test first matched an ASSIGNMENT (`= "<synthetic>"`) on the theory that
 * only declarations matter. PR #3232 R1 caught that as BLOCKING: `===` ends in
 * `=`, so `turn.model === "<synthetic>"` matches an assignment pattern and would
 * have been reported as a declaration site.
 *
 * The fix is not a cleverer assignment regex — it is that "declaration" was the
 * wrong invariant. An inline `=== "<synthetic>"` is a hand-copy of the literal
 * with exactly the drift exposure this task removes; it deserves to fail, and
 * calling it a "declaration" in the failure message is what was wrong. So the
 * rule is now the honest one: **the literal may appear in CODE in one file
 * only.**
 *
 * Comments are exempt, because several docblocks legitimately name the sentinel
 * in prose (`transcripts/conversation-elements.ts`, `context/types.ts`) and
 * documentation is not a copy. A line is treated as a comment when its trimmed
 * form opens with `//`, `/*` or `*` — which is every prose mention in this
 * corpus. **Stated bound:** a trailing comment on a code line would still count.
 * That is deliberate rather than a gap: flagging it costs one moved comment, and
 * the alternative — parsing comments out of the source — risks a stripper bug
 * silently HIDING a real occurrence, which is the failure direction that matters
 * here.
 *
 * Test files are excluded: the spec's first acceptance test says a fixture may
 * legitimately spell the literal.
 */
/* eslint-disable custom/no-real-fs-in-tests -- the assertion is ABOUT the real
   source tree (that the literal appears in code in exactly one file). A fake
   filesystem would assert a fixture and prove nothing about the repo, which is
   the only thing this test exists to check. Same basis as the file-level
   disable in `src/cockpit/web/lib/tool-effect.browser.test.ts`. */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Repo root, from this file at packages/domain/src/ai/. */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

/** Trees that may consume the sentinel. */
const ROOTS = ["packages/domain/src", "packages/shared/src", "src/cockpit/web"];

/** `dist` holds BUILT copies of the web bundle — not source. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

const SENTINEL = '"<synthetic>"';

/** Is this line prose rather than code? See the docblock for the stated bound. */
export function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
}

/** Does this source text spell the sentinel anywhere outside a comment line? */
export function spellsSentinelInCode(source: string): boolean {
  return source.split("\n").some((line) => !isCommentLine(line) && line.includes(SENTINEL));
}

function sourceFilesUnder(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFilesUnder(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

describe("synthetic-model sentinel (mt#4237)", () => {
  test("the literal appears in code in exactly one file", () => {
    const sites: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFilesUnder(join(REPO_ROOT, root))) {
        if (spellsSentinelInCode(readFileSync(file, "utf8"))) {
          sites.push(relative(REPO_ROOT, file));
        }
      }
    }

    // Asserted as the full list rather than a count, so a failure NAMES the
    // file that re-introduced a copy instead of reporting "expected 1, got 2".
    expect(sites.sort()).toEqual(["packages/domain/src/ai/dispatch-models.ts"]);
  });

  test("the matcher counts a comparison, not just a declaration (PR #3232 R1)", () => {
    // The finding this test exists for: `===` ends in `=`, so an assignment-
    // shaped regex reported `turn.model === "<synthetic>"` as a declaration.
    // Both forms are hand-copies and both must fail — what changed is that the
    // rule no longer claims they are the same KIND of thing.
    expect(spellsSentinelInCode('const X = "<synthetic>";')).toBe(true);
    expect(spellsSentinelInCode('if (turn.model === "<synthetic>") return false;')).toBe(true);
    expect(spellsSentinelInCode('const m = { model: "<synthetic>" };')).toBe(true);
  });

  test("prose naming the sentinel is not a copy", () => {
    // Two real docblocks in the corpus do this; they must not fail the scan.
    expect(
      spellsSentinelInCode(' * The assistant message\'s model. `"<synthetic>"` marks a retry.')
    ).toBe(false);
    expect(spellsSentinelInCode('// model "<synthetic>" (94 of 1003 local transcripts)')).toBe(
      false
    );
    expect(spellsSentinelInCode('/* "<synthetic>" is the harness sentinel */')).toBe(false);
  });

  test("the scan is not vacuously passing", () => {
    // A broken ROOTS path or matcher typo would make the scan find nothing.
    // Pin that the traversal reaches the declaring file and that the matcher
    // discriminates — a near-miss literal must NOT match.
    const declaring = join(REPO_ROOT, "packages/domain/src/ai/dispatch-models.ts");
    expect(spellsSentinelInCode(readFileSync(declaring, "utf8"))).toBe(true);
    expect(spellsSentinelInCode('const X = "<not-the-sentinel>";')).toBe(false);
  });
});
