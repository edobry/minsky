/**
 * The synthetic-retry sentinel has exactly ONE declaration (mt#4237).
 *
 * Three modules each declared `"<synthetic>"` with nothing checking they
 * agreed. The failure mode that made this worth fixing is silent and
 * asymmetric: if the harness ever changes the spelling, a module still holding
 * the old literal does not throw — it simply stops recognizing retry turns, so
 * `modelTierLabel` hands a harness retry a model tier and the cockpit renders
 * it as though a model spoke. Nothing errors anywhere.
 *
 * A type checker cannot catch that (every copy is a valid string), and no
 * behavioural test can either (each module is individually correct against its
 * own copy). The invariant is structural, so the test is structural: scan the
 * source and assert the literal is ASSIGNED in exactly one place.
 *
 * Deliberately matches an ASSIGNMENT (`= "<synthetic>"`), not a mere
 * occurrence: several docblocks name the sentinel in prose
 * (`transcripts/conversation-elements.ts`, `context/types.ts`) and those are
 * documentation, not declarations. Test files are excluded because a fixture
 * may legitimately spell the literal — the spec's first acceptance test says so.
 */
/* eslint-disable custom/no-real-fs-in-tests -- the assertion is ABOUT the real
   source tree (that the literal is declared in exactly one file). A fake
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

/** `dist` holds BUILT copies of the web bundle — not declaration sites. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

const ASSIGNMENT = /=\s*"<synthetic>"/;

function sourceFilesUnder(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // a root that does not exist here is not a failure of this test
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
  test("the literal is declared in exactly one module", () => {
    const sites: string[] = [];
    for (const root of ROOTS) {
      for (const file of sourceFilesUnder(join(REPO_ROOT, root))) {
        const text = readFileSync(file, "utf8");
        for (const line of text.split("\n")) {
          if (ASSIGNMENT.test(line)) {
            sites.push(relative(REPO_ROOT, file));
            break;
          }
        }
      }
    }

    // Asserted as the full list rather than a count, so a failure NAMES the
    // file that re-introduced a copy instead of reporting "expected 1, got 2".
    expect(sites.sort()).toEqual(["packages/domain/src/ai/dispatch-models.ts"]);
  });

  test("the scan can actually find an assignment — it is not vacuously passing", () => {
    // Without this, a broken ROOTS path or a regex typo would yield an empty
    // scan and the test above would fail loudly — but a scan that finds the
    // right count for the wrong reason would not. Pin that the matcher and the
    // traversal both work by checking the declaring file is reachable and its
    // line matches.
    const declaring = join(REPO_ROOT, "packages/domain/src/ai/dispatch-models.ts");
    const lines = readFileSync(declaring, "utf8").split("\n");
    expect(lines.some((l) => ASSIGNMENT.test(l))).toBe(true);
    expect(ASSIGNMENT.test('const X = "<not-the-sentinel>";')).toBe(false);
  });
});
