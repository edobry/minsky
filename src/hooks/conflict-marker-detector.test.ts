/**
 * Tests for the staged-file conflict-marker check (mt#4307).
 *
 * Note how every fixture below is assembled from `OPEN` / `SEP` / `CLOSE` and
 * `join("\n")` rather than written as a template literal. That is not stylistic:
 * a template literal containing a real marker would put one at column 0 of THIS
 * file, and the check would then block the commit that adds it. The same
 * constraint is why the detector does not ship an on-disk fixture.
 */

import { describe, test, expect } from "bun:test";
import {
  detectConflictMarkerViolations,
  evaluateFile,
  classifyMarkerLine,
  isMarkdownPath,
  CONFLICT_MARKER_CHECK_OVERRIDE_ENV,
} from "./conflict-marker-detector";

/** Git's three markers, built rather than written, per the header. */
const OPEN = `${"<".repeat(7)} HEAD`;
const SEP = "=".repeat(7);
const CLOSE = `${">".repeat(7)} origin/main`;

function lines(...ls: string[]): string {
  return ls.join("\n");
}

/** A complete conflict block, as git actually writes one. */
function conflicted(ours = "ours", theirs = "theirs"): string {
  return lines("before", OPEN, ours, SEP, theirs, CLOSE, "after");
}

function scan(path: string, content: string) {
  return detectConflictMarkerViolations(new Map([[path, content]]));
}

/** An ordinary source path — not generated, not a fixture, not markdown. */
const SOURCE_PATH = "src/session/thing.ts";

describe("classifyMarkerLine", () => {
  test("recognizes each of git's three markers", () => {
    expect(classifyMarkerLine(OPEN)).toBe("open");
    expect(classifyMarkerLine(SEP)).toBe("separator");
    expect(classifyMarkerLine(CLOSE)).toBe("close");
  });

  test("requires exactly seven characters followed by a space or end-of-line", () => {
    // Eight is not a marker — and this is what keeps a long setext underline out.
    expect(classifyMarkerLine("=".repeat(8))).toBeNull();
    expect(classifyMarkerLine("<".repeat(6))).toBeNull();
    // Indented, or mid-line, is not a marker either.
    expect(classifyMarkerLine(`  ${OPEN}`)).toBeNull();
    expect(classifyMarkerLine(`the marker is ${OPEN}`)).toBeNull();
  });
});

describe("isMarkdownPath", () => {
  test("covers the markdown family this repo actually uses, including .mdc", () => {
    expect(isMarkdownPath("docs/x.md")).toBe(true);
    expect(isMarkdownPath(".minsky/rules/hook-observers.mdc")).toBe(true);
    expect(isMarkdownPath("src/x.ts")).toBe(false);
    expect(isMarkdownPath("src/generated/catalog.json")).toBe(false);
  });
});

describe("AT3 — a staged file carrying a conflict marker is blocked, by name", () => {
  test("a lone opening marker is enough", () => {
    const violations = scan(SOURCE_PATH, lines("const a = 1;", OPEN, "const b = 2;"));

    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe(SOURCE_PATH);
    expect(violations[0]?.lines).toContain(2);
  });

  test("a complete block reports every marker line", () => {
    const violations = scan(SOURCE_PATH, conflicted());

    expect(violations).toHaveLength(1);
    // Lines 2, 4 and 6 of the fixture: open, separator, close.
    expect(violations[0]?.lines).toEqual([2, 4, 6]);
  });

  test("a lone closing marker is enough too", () => {
    expect(scan("src/x.ts", lines("a", CLOSE))).toHaveLength(1);
  });
});

describe("AT4 / SC5 — legitimate content does NOT fire", () => {
  /**
   * The exact fixture the spec names: a setext underline of seven `=`, plus a
   * fenced block quoting an opening marker.
   */
  const DOC = lines(
    "A heading",
    SEP,
    "",
    "When a pop conflicts you will see this at the top of the file:",
    "",
    "```",
    OPEN,
    "```",
    "",
    "Resolve it and carry on."
  );

  test("a setext underline plus a fenced marker quote is clean", () => {
    expect(scan("docs/conflicts.md", DOC)).toHaveLength(0);
  });

  test("a setext underline on its own is clean", () => {
    expect(scan("docs/x.md", lines("Title", SEP, "", "body"))).toHaveLength(0);
  });

  test("prose quoting a marker inline is clean", () => {
    expect(scan("docs/x.md", lines(`git writes ${OPEN} at the top`))).toHaveLength(0);
  });

  test("DISCRIMINATION: the same content OUTSIDE a fence does fire", () => {
    // Without this, the three tests above would be satisfied by a check that
    // never fires at all. What excuses the marker in `DOC` is the fence, so
    // removing the fence must change the verdict — otherwise the exemption is
    // not the thing doing the work (mem#704).
    const unfenced = DOC.split("\n")
      .filter((l) => l !== "```")
      .join("\n");

    expect(scan("docs/conflicts.md", unfenced)).toHaveLength(1);
  });

  test("a fence exemption does NOT extend to a complete conflict block", () => {
    // A real conflict inside a `.mdc` rule file is the originating incident, and
    // a conflict can itself unbalance the fences around it. A whole block is a
    // conflict wherever a fence scan thinks it sits.
    const fenced = lines("# Rule", "", "```", ...conflicted().split("\n"), "```");

    const violations = scan(".minsky/rules/hook-observers.mdc", fenced);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toBe("complete-block");
  });

  test("a non-markdown file has no fence concept — a marker fires regardless", () => {
    const fenced = lines("```", OPEN, "```");
    expect(scan("src/x.ts", fenced)).toHaveLength(1);
  });
});

describe("AT5 — the generated file the originating incident hid in", () => {
  test("a conflict in src/generated/** is caught at commit time", () => {
    // The replay: a marker at the head of this file made
    // `src/cockpit/health-contract.test.ts` fail with
    // `JSON Parse error: Unrecognized token '<'` — twenty files away from the
    // change, and only after a full pre-push suite had run.
    const corrupted = lines(OPEN, '{ "ours": true }', SEP, '{ "theirs": true }', CLOSE);

    const violations = scan("src/generated/interceptor-catalog.json", corrupted);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe("src/generated/interceptor-catalog.json");
  });

  test("generated paths are NOT allowlisted — that is the whole point", () => {
    // Several sibling pre-commit checks skip generated output. This one must not:
    // it is where the corruption was invisible.
    expect(scan("src/generated/completion-manifest.json", conflicted())).toHaveLength(1);
  });
});

describe("detectConflictMarkerViolations", () => {
  test("skips binary and fixture paths, and reports each violating file once", () => {
    const staged = new Map<string, string>([
      ["src/a.ts", conflicted()],
      ["src/b.ts", "clean file\n"],
      ["src/c.ts", conflicted()],
      // Allowlisted: a fixture may carry pathological content on purpose.
      ["tests/fixtures/conflicted-sample.txt", conflicted()],
      ["assets/logo.png", conflicted()],
    ]);

    const violations = detectConflictMarkerViolations(staged);

    expect(violations.map((v) => v.path).sort()).toEqual(["src/a.ts", "src/c.ts"]);
  });

  test("an empty staged set yields nothing", () => {
    expect(detectConflictMarkerViolations(new Map())).toHaveLength(0);
  });
});

describe("evaluateFile", () => {
  test("a clean file returns null", () => {
    expect(evaluateFile("nothing to see\n", "src/x.ts")).toBeNull();
  });
});

describe("override env var", () => {
  test("is the registered name the rule and the mirror list both carry", () => {
    expect(CONFLICT_MARKER_CHECK_OVERRIDE_ENV).toBe("MINSKY_SKIP_CONFLICT_MARKER_CHECK");
  });
});
