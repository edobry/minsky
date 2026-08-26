/**
 * mt#4544 — spec-scope-execution-check.
 *
 * Acceptance tests, by the spec's own numbering:
 *   AT1 — three enumerated paths, a diff touching two → exactly one finding,
 *         quoting the enumeration line for the untouched path.
 *   AT2 — every enumerated path touched → no finding.
 *   AT3 — an `In scope` section of pure prose → "nothing to compare", recorded
 *         DISTINCTLY from AT2's clean pass.
 *   AT4 — the replay measurement, which is not a unit test; see the PR body.
 *
 * Every seam is injected (`fetchSpec`, transcript lines), so nothing here
 * shells out or reads the repo — `custom/no-real-fs-in-tests`.
 */

import { describe, test, expect } from "bun:test";
import {
  run,
  boundTaskId,
  normalizePath,
  pathIsCovered,
  enumerationLineFor,
  untouchedEnumeratedPaths,
  isQualifiedEntry,
} from "./spec-scope-execution-check";
import { extractInScopeFiles } from "./parallel-work-guard";
import type { TranscriptLine } from "./transcript";
import type { DispatchContext } from "./registry";
import type { ToolHookInput } from "./types";

const TASK_ID = "mt#4544";

// Shared fixture literals (custom/no-magic-string-duplication).
const ALPHA = ".minsky/hooks/alpha.ts";
const BETA = ".minsky/hooks/beta.ts";
const GAMMA = "docs/architecture/gamma.md";
const PRIOR_ART = ".minsky/hooks/unrelated-prior-art.ts";
const OUT_OF_SCOPE_PATH = ".minsky/hooks/never-touched-but-out-of-scope.ts";
const REGISTRY_PATH = "hooks/registry.ts";
const OUTCOME = "outcome";
const REASON = "reason";
const UNTOUCHED = "untouched";
const SKIPPED = "skipped";
const CLEAN = "clean";
const GAMMA_CONDITIONAL = "update if the measurement adds fields";

/** A spec whose in-scope block names three concrete paths, one conditionally. */
const SPEC_THREE_PATHS = `## Summary

Does a thing.

## Scope

**In scope:**

- \`.minsky/hooks/alpha.ts\` — the guard itself.
- \`.minsky/hooks/beta.ts\` — its registration.
- \`docs/architecture/gamma.md\` — row 119 documents the field set; update if the measurement adds fields to it.

**Out of scope:**

- \`.minsky/hooks/never-touched-but-out-of-scope.ts\`

## Context

Prior art lives in \`.minsky/hooks/unrelated-prior-art.ts\`, which this task does not touch.
`;

/** Same shape, but the in-scope block is prose with no paths (AT3). */
const SPEC_PROSE_ONLY = `## Summary

Does a thing.

## Scope

**In scope:**

- The new check and its registration, plus its calibration log.
- Whichever seam the measurement favours.

**Out of scope:**

- Everything else.

## Context

Prior art lives in \`.minsky/hooks/unrelated-prior-art.ts\`.
`;

function editCall(path: string): TranscriptLine {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `toolu_${path.replace(/\W/g, "")}`,
          name: "mcp__minsky__session_write_file",
          input: { path },
        },
      ],
    },
  } as unknown as TranscriptLine;
}

function ctxWith(paths: readonly string[]): DispatchContext {
  return { transcriptLines: paths.map(editCall) } as unknown as DispatchContext;
}

const INPUT: ToolHookInput = {
  session_id: "sess-1",
  tool_name: "mcp__minsky__session_pr_create",
  tool_input: { task: TASK_ID, title: "t", type: "chore" },
} as unknown as ToolHookInput;

describe("mt#4544 — pure helpers", () => {
  test("boundTaskId reads `task`, and returns null when absent", () => {
    expect(boundTaskId({ task: "mt#1" })).toBe("mt#1");
    expect(boundTaskId({ task: "  mt#1  " })).toBe("mt#1");
    expect(boundTaskId({ sessionId: "abc" })).toBeNull();
    expect(boundTaskId({ task: "" })).toBeNull();
  });

  test("normalizePath strips a leading ./ and trailing slashes", () => {
    expect(normalizePath("./a/b.ts")).toBe("a/b.ts");
    expect(normalizePath("  a/b/  ")).toBe("a/b");
  });

  test("pathIsCovered matches exact, absolute-suffix and directory shapes", () => {
    expect(pathIsCovered("a/b.ts", ["a/b.ts"])).toBe(true);
    // An absolute session path against a repo-relative enumeration.
    expect(pathIsCovered("a/b.ts", ["/Users/x/sessions/s1/a/b.ts"])).toBe(true);
    // A directory enumeration, satisfied by an edit beneath it.
    expect(pathIsCovered("a/dir", ["a/dir/inner.ts"])).toBe(true);
    expect(pathIsCovered("a/b.ts", ["a/c.ts"])).toBe(false);
  });

  test("the suffix match is anchored at a separator, so a sibling prefix does not satisfy it", () => {
    // Without the leading `/` anchor, `other-hooks/registry.ts` would satisfy
    // an enumeration of `hooks/registry.ts` — the exact over-match this
    // anchoring exists to prevent.
    expect(pathIsCovered(REGISTRY_PATH, ["other-hooks/registry.ts"])).toBe(false);
    expect(pathIsCovered(REGISTRY_PATH, [".minsky/hooks/registry.ts"])).toBe(true);
  });

  test("enumerationLineFor returns the spec's own line, so a CONDITIONAL is visible", () => {
    const { inScopeBlock } = extractInScopeFiles(SPEC_THREE_PATHS, { strict: true });
    const line = enumerationLineFor(inScopeBlock, GAMMA);
    expect(line).toContain(GAMMA_CONDITIONAL);
  });

  // PR #3340 R1 (BLOCKING + its non-blocking sibling). The earlier form scanned
  // the WHOLE spec and returned the first line containing the path — so for a
  // path the spec also cites earlier, in `## Summary` or `## Context`, it
  // quoted that line instead of the in-scope one. Quoting a non-promise as
  // though it were a promise inverts the finding.
  test("quotes the IN-SCOPE line, not an earlier mention of the same path", () => {
    const spec = `## Summary

Prior art for this lives in \`${GAMMA}\`, which we are NOT changing for that reason.

## Scope

**In scope:**

- \`${GAMMA}\` — ${GAMMA_CONDITIONAL} to it.

**Out of scope:**

- \`${OUT_OF_SCOPE_PATH}\`
`;
    const { inScopeBlock } = extractInScopeFiles(spec, { strict: true });
    const line = enumerationLineFor(inScopeBlock, GAMMA);
    expect(line).toContain(GAMMA_CONDITIONAL);
    expect(line).not.toContain("Prior art");
  });

  test("returns null rather than falling back to a whole-document scan", () => {
    // A missing quote is a smaller failure than a misattributed one.
    expect(enumerationLineFor(undefined, GAMMA)).toBeNull();
  });
});

// --------------------------------------------------------------------------
// mt#4591 — a `path:line` or glob entry can never match a changed file.
//
// AT1 — a line-suffixed entry resolves to its file.
// AT2 — a glob entry resolves against its literal directory prefix.
// AT3 — the replay measurement; not a unit test, see the PR body.
// AT4 — the ENUMERATED side is stripped, the CHANGED side is not.
// --------------------------------------------------------------------------

const TYPES_TS = "packages/domain/src/tasks/types.ts";
const COCKPIT_DIR_GLOB = "src/cockpit/**";
const COCKPIT_FILE = "src/cockpit/web/pages/x.tsx";
const DYNAMIC_ROUTE = "src/cockpit/web/pages/[id].tsx";
const INVENTORY_DOC = "docs/architecture/hook-module-inventory.md";
const INTERCEPTORS_DOC = "docs/architecture/interceptors.md";

describe("mt#4591 — AT1: a line-suffixed entry resolves to its file", () => {
  test("every suffix form measured in the corpus strips to the same path", () => {
    // Verbatim from the flagged specs: PR #3342, #3272, #3265.
    expect(pathIsCovered(`${TYPES_TS}:83`, [TYPES_TS])).toBe(true);
    expect(pathIsCovered("a/b.ts:229-230", ["a/b.ts"])).toBe(true);
    expect(pathIsCovered("a/b.ts:66,326", ["a/b.ts"])).toBe(true);
    expect(pathIsCovered("a/b.ts:2426-2432", ["a/b.ts"])).toBe(true);
    // line:col, the form the pre-existing regex already handled.
    expect(pathIsCovered("a/b.ts:66:12", ["a/b.ts"])).toBe(true);
  });

  test("stripping does not make an UNRELATED file match", () => {
    expect(pathIsCovered(`${TYPES_TS}:83`, ["packages/domain/src/tasks/other.ts"])).toBe(false);
  });

  test("a suffixed entry still resolves through the absolute-path suffix rule", () => {
    expect(pathIsCovered("a/b.ts:83", [`/Users/x/sessions/s1/a/b.ts`])).toBe(true);
  });
});

describe("mt#4591 — AT2: a glob matches by its actual pattern, not a prefix", () => {
  test("a directory glob is covered by any changed file beneath it", () => {
    expect(pathIsCovered(COCKPIT_DIR_GLOB, [COCKPIT_FILE])).toBe(true);
    expect(pathIsCovered(COCKPIT_DIR_GLOB, ["src/mcp/x.ts"])).toBe(false);
  });

  // PR #3351 R1 (BLOCKING) regression. The first implementation reduced a glob
  // to its literal directory prefix, so each `false` below was a `true`: a
  // narrower glob was satisfied by ANY edit under `src/`. That is a silent
  // false PASS — it hides the unkept promise the check exists to surface.
  test("a narrower glob is NOT satisfied by an unrelated file under its prefix", () => {
    expect(pathIsCovered("src/**/x.ts", ["src/a/x.ts"])).toBe(true);
    expect(pathIsCovered("src/**/x.ts", ["src/x.ts"])).toBe(true);
    expect(pathIsCovered("src/**/x.ts", ["src/a/y.ts"])).toBe(false);
    expect(pathIsCovered("src/**/x.ts", ["src/unrelated/deep/z.md"])).toBe(false);
  });

  // PR #3351 R2 asserted that `**/` compiles to at-most-ONE directory and so
  // could not match `src/a/b/x.ts`. Verified false: `.` matches `/` in a JS
  // regex, so `(?:.*/)?` already spans any depth. Pinning the semantics with a
  // test rather than answering the finding with an argument — the claim is
  // reasonable on the face of the fragment, and a test is what makes the next
  // reader's version of it cheap to settle.
  test("`**/` spans zero or MORE directories, at any depth", () => {
    expect(pathIsCovered("src/**/x.ts", ["src/a/b/x.ts"])).toBe(true);
    expect(pathIsCovered("src/**/x.ts", ["src/a/b/c/d/x.ts"])).toBe(true);
    expect(pathIsCovered("a/**/b/**/c.ts", ["a/one/two/b/three/four/c.ts"])).toBe(true);
    expect(pathIsCovered("a/**/b/**/c.ts", ["a/one/two/c.ts"])).toBe(false);
  });

  test("a single-segment star does not cross a directory boundary", () => {
    expect(pathIsCovered("src/*-gen/a.ts", ["src/proto-gen/a.ts"])).toBe(true);
    expect(pathIsCovered("src/*-gen/a.ts", ["src/proto-gen/nested/a.ts"])).toBe(false);
    expect(pathIsCovered("src/*/x.ts", ["src/a/x.ts"])).toBe(true);
    expect(pathIsCovered("src/*/x.ts", ["src/a/b/x.ts"])).toBe(false);
  });

  test("`?` matches exactly one character", () => {
    expect(pathIsCovered("src/a?.ts", ["src/ab.ts"])).toBe(true);
    expect(pathIsCovered("src/a?.ts", ["src/abc.ts"])).toBe(false);
  });

  test("a prefix-less glob is adjudicated by its pattern, not waved through", () => {
    expect(pathIsCovered("**/*.ts", ["a/b.ts"])).toBe(true);
    expect(pathIsCovered("**/*.ts", ["a/b.tsx"])).toBe(false);
  });

  test("a glob still resolves against an ABSOLUTE edit path", () => {
    expect(pathIsCovered(COCKPIT_DIR_GLOB, [`/Users/x/sessions/s1/${COCKPIT_FILE}`])).toBe(true);
  });
});

describe("mt#4591 — PR #3351 R1 hardening", () => {
  test("literal brackets in a filename are NOT treated as a glob", () => {
    // A Next.js-style dynamic route is the ordinary case for this shape.
    expect(pathIsCovered(DYNAMIC_ROUTE, [DYNAMIC_ROUTE])).toBe(true);
    expect(pathIsCovered("docs/Guide [Draft]/index.md", ["docs/Guide [Draft]/index.md"])).toBe(
      true
    );
    // ...and a bracket path does NOT become a glob that swallows a sibling.
    expect(pathIsCovered(DYNAMIC_ROUTE, ["src/cockpit/web/pages/other.tsx"])).toBe(false);
  });

  test("a line suffix with incidental whitespace still strips", () => {
    expect(pathIsCovered("a/b.ts:66, 326", ["a/b.ts"])).toBe(true);
    expect(pathIsCovered("a/b.ts:2426 - 2432", ["a/b.ts"])).toBe(true);
  });

  test("a Windows-style drive letter is not mis-stripped", () => {
    // The pattern requires DIGITS after the colon and is anchored at `$`, so a
    // drive letter cannot be consumed. Asserted rather than asserted-in-prose.
    expect(pathIsCovered("C:\\repo\\a.ts", ["C:\\repo\\a.ts"])).toBe(true);
  });
});

describe("mt#4591 — AT4: the enumerated side is stripped, the changed side is not", () => {
  test("a changed-file path is compared verbatim, so the rule is asymmetric", () => {
    // Enumerated side stripped -> matches.
    expect(pathIsCovered("a/b.ts:83", ["a/b.ts"])).toBe(true);
    // Changed side NOT stripped -> a file genuinely named `a/b.ts:83` does not
    // satisfy an enumeration of `a/b.ts`.
    expect(pathIsCovered("a/b.ts", ["a/b.ts:83"])).toBe(false);
  });
});

describe("mt#4591 — SC5: the founding incident stays flagged", () => {
  test("PR #3310's two surviving entries are plain paths, untouched by this change", () => {
    const { untouched } = untouchedEnumeratedPaths(
      undefined,
      [INVENTORY_DOC, INTERCEPTORS_DOC],
      [".minsky/hooks/wall-of-text-detector.ts"]
    );
    expect(untouched.map((u) => u.path)).toEqual([INVENTORY_DOC, INTERCEPTORS_DOC]);
  });
});

// --------------------------------------------------------------------------
// mt#4582 — an entry the spec itself QUALIFIES is not an unkept promise.
//
// AT1 — three paths, two qualified, none touched -> one finding, qualified: 2.
// AT2 — a qualifier in PROSE does not suppress an unqualified entry.
// AT3 — the replay measurement; not a unit test, see the PR body.
// --------------------------------------------------------------------------

const WRAPPED_SCRIPT = "scripts/replay-thing.ts";
const DELTA = ".minsky/hooks/delta.ts";
const DELTA_NOTE = "the guard itself";

/** alpha READ-ONLY, beta "only insofar as", gamma plain. Prose mentions READ-ONLY. */
const SPEC_QUALIFIED = `## Summary

This prose mentions READ-ONLY deliberately: it must not suppress anything, because
the check reads the in-scope block, not the whole document.

## Scope

**In scope:**

- \`${ALPHA}\` — READ-ONLY: the registry this consults.
- \`${BETA}\` — only insofar as it already spreads the helper.
- \`${GAMMA}\` — row 119 documents the field set.

**Out of scope:**
`;

/** The mt#4109 shape: the qualifier lives on the bullet's CONTINUATION lines. */
const SPEC_WRAPPED_QUALIFIER = `## Scope

**In scope:**

- \`${WRAPPED_SCRIPT}\` — imports the helper, so SC3 changes what its
  \`--accuracy\` pass measures. In scope only to the extent of re-running it and
  recording the shifted numbers; no behavior change to the script is required.
- \`${DELTA}\` — ${DELTA_NOTE}.

**Out of scope:**
`;

describe("mt#4582 — AT1: a qualified entry is suppressed and COUNTED", () => {
  test("two qualified, one plain, none touched -> one finding and qualified: 2", () => {
    const { inScopeBlock } = extractInScopeFiles(SPEC_QUALIFIED, { strict: true });
    const { untouched, qualified } = untouchedEnumeratedPaths(
      inScopeBlock,
      [ALPHA, BETA, GAMMA],
      []
    );
    expect(untouched.map((u) => u.path)).toEqual([GAMMA]);
    expect(qualified).toBe(2);
  });

  test("run() carries `qualified` onto the calibration record", () => {
    // An edit that covers NONE of the enumerated paths: without at least one
    // edit call the guard records `skipped`, which is correct and not what
    // this test is about.
    const outcome = run(INPUT, ctxWith(["src/unrelated/elsewhere.ts"]), {
      fetchSpec: () => SPEC_QUALIFIED,
    });
    const cal = outcome?.calibration as Record<string, unknown> | undefined;
    expect(cal?.[OUTCOME]).toBe("flagged");
    expect(cal?.["qualified"]).toBe(2);
  });
});

describe("mt#4582 — AT2: a qualifier in PROSE suppresses nothing", () => {
  test("GAMMA stays flagged even though the Summary says READ-ONLY", () => {
    const { inScopeBlock } = extractInScopeFiles(SPEC_QUALIFIED, { strict: true });
    const { untouched } = untouchedEnumeratedPaths(inScopeBlock, [GAMMA], []);
    expect(untouched.map((u) => u.path)).toEqual([GAMMA]);
  });
});

describe("mt#4582 — SC7: the qualifier is read from the whole ENTRY, not one line", () => {
  test("a qualifier on a CONTINUATION line still suppresses", () => {
    // Measured: 50% of flagged bullets wrap past line 1, and this shape —
    // mt#4109's, one of this task's three worked examples — carries its
    // qualifier entirely on the continuation. A single-line test misses it.
    const { inScopeBlock } = extractInScopeFiles(SPEC_WRAPPED_QUALIFIER, { strict: true });
    const { untouched, qualified } = untouchedEnumeratedPaths(
      inScopeBlock,
      [WRAPPED_SCRIPT, DELTA],
      []
    );
    expect(untouched.map((u) => u.path)).toEqual([DELTA]);
    expect(qualified).toBe(1);
  });

  test("the recorded entry carries the continuation, so a reader sees the qualifier", () => {
    const { inScopeBlock } = extractInScopeFiles(SPEC_WRAPPED_QUALIFIER, { strict: true });
    const entry = enumerationLineFor(inScopeBlock, DELTA);
    expect(entry).toContain(DELTA_NOTE);
    const wrapped = enumerationLineFor(inScopeBlock, WRAPPED_SCRIPT);
    expect(wrapped).toContain("only to the extent of");
    expect(wrapped).toContain("no behavior change");
  });

  test("joining stops at the next bullet — an entry does not absorb its sibling", () => {
    const { inScopeBlock } = extractInScopeFiles(SPEC_WRAPPED_QUALIFIER, { strict: true });
    expect(enumerationLineFor(inScopeBlock, WRAPPED_SCRIPT)).not.toContain(DELTA_NOTE);
  });
});

describe("mt#4582 — SC5: a CONDITIONAL is not a qualifier and keeps firing", () => {
  test("`update if …` stays flagged — whether the condition fired is unknowable here", () => {
    const { inScopeBlock } = extractInScopeFiles(SPEC_THREE_PATHS, { strict: true });
    const { untouched, qualified } = untouchedEnumeratedPaths(inScopeBlock, [GAMMA], []);
    expect(untouched.map((u) => u.path)).toEqual([GAMMA]);
    expect(qualified).toBe(0);
  });

  test("isQualifiedEntry rejects the conditional forms directly", () => {
    expect(isQualifiedEntry("- `a.ts` — update if the signature changes")).toBe(false);
    expect(isQualifiedEntry("- `a.ts` — If it is wrong today, fix it here or file it")).toBe(false);
    expect(isQualifiedEntry("- `a.ts` — the tool seam, if the mechanism extends it")).toBe(false);
  });

  test("isQualifiedEntry accepts each measured unconditional form", () => {
    expect(isQualifiedEntry("- `a.ts` — READ-ONLY: the registry.")).toBe(true);
    expect(isQualifiedEntry("- `a.ts` — read-only reference")).toBe(true);
    expect(isQualifiedEntry("- `a.ts` — only insofar as it spreads the helper.")).toBe(true);
    expect(isQualifiedEntry("- `a.ts` — in scope only to the extent of re-running it")).toBe(true);
    expect(isQualifiedEntry("- `a.ts` — no behavior change is required")).toBe(true);
  });

  // PR #3360 R1 (non-blocking). An UNHYPHENATED "read only" is ordinary prose,
  // and matching it would suppress a real finding on an incidental mention.
  // Both measured instances are hyphenated, so requiring the hyphen costs
  // nothing. Class check: the other three phrases are distinctive enough that
  // no equivalent prose collision exists for them.
  test("a bare unhyphenated `read only` in prose does NOT qualify", () => {
    expect(isQualifiedEntry("- `a.ts` — we read only the first line of each entry")).toBe(false);
    expect(isQualifiedEntry("- `a.ts` — read only reference data lives here")).toBe(false);
  });
});

describe("mt#4582 — PR #3360 R1: the joiner absorbs only genuine continuations", () => {
  // The indentation requirement is load-bearing: without it the joiner swallowed
  // any non-empty, non-bullet line, so a qualifier in absorbed text could
  // SUPPRESS A REAL FINDING.
  const SPEC_TRAILING_PROSE = `## Scope

**In scope:**

- \`${DELTA}\` — ${DELTA_NOTE}.
Unindented prose that follows, mentioning READ-ONLY in passing.

**Out of scope:**
`;

  test("an UNINDENTED following line is not absorbed, so its qualifier cannot suppress", () => {
    const { inScopeBlock } = extractInScopeFiles(SPEC_TRAILING_PROSE, { strict: true });
    const entry = enumerationLineFor(inScopeBlock, DELTA);
    expect(entry).toContain(DELTA_NOTE);
    expect(entry).not.toContain("READ-ONLY");
    const { untouched, qualified } = untouchedEnumeratedPaths(inScopeBlock, [DELTA], []);
    expect(untouched.map((u) => u.path)).toEqual([DELTA]);
    expect(qualified).toBe(0);
  });

  test("an indented ordered-list item, heading or thematic break stops the join", () => {
    const block = [
      "- `a/one.ts` — the first entry.",
      "  1. an indented ordered item mentioning READ-ONLY",
      "- `a/two.ts` — the second entry.",
      "  ### an indented heading mentioning READ-ONLY",
      "- `a/three.ts` — the third entry.",
      "  --- ",
    ].join("\n");
    expect(enumerationLineFor(block, "a/one.ts")).not.toContain("READ-ONLY");
    expect(enumerationLineFor(block, "a/two.ts")).not.toContain("READ-ONLY");
    expect(enumerationLineFor(block, "a/three.ts")).toBe("- `a/three.ts` — the third entry.");
  });

  test("a genuinely indented continuation is still joined", () => {
    const block = ["- `a/one.ts` — the first entry,", "  continued here.", ""].join("\n");
    expect(enumerationLineFor(block, "a/one.ts")).toBe(
      "- `a/one.ts` — the first entry, continued here."
    );
  });
});

describe("mt#4582 — SC6: a null entry is never suppressed", () => {
  test("no in-scope block means no evidence, not no qualifier", () => {
    expect(isQualifiedEntry(null)).toBe(false);
    const { untouched, qualified } = untouchedEnumeratedPaths(undefined, [ALPHA], []);
    expect(untouched.map((u) => u.path)).toEqual([ALPHA]);
    expect(qualified).toBe(0);
  });
});

describe("mt#4544 — AT1: an enumerated path the PR never touched", () => {
  test("three enumerated, two touched -> exactly one finding, quoting its line", () => {
    const { inScopeBlock } = extractInScopeFiles(SPEC_THREE_PATHS, { strict: true });
    const { untouched } = untouchedEnumeratedPaths(
      inScopeBlock,
      [ALPHA, BETA, GAMMA],
      [ALPHA, BETA]
    );
    expect(untouched).toHaveLength(1);
    expect(untouched[0]?.path).toBe(GAMMA);
    expect(untouched[0]?.line).toContain(GAMMA_CONDITIONAL);
  });

  test("end to end: run() records `flagged` with the untouched path on the record", () => {
    const outcome = run(INPUT, ctxWith([ALPHA, BETA]), {
      fetchSpec: () => SPEC_THREE_PATHS,
    });
    const cal = outcome?.calibration as Record<string, unknown> | undefined;
    expect(cal?.[OUTCOME]).toBe("flagged");
    expect(cal?.["taskId"]).toBe(TASK_ID);
    expect(cal?.["enumeratedCount"]).toBe(3);
    expect(cal?.[UNTOUCHED]).toEqual([
      {
        path: GAMMA,
        line: "- `docs/architecture/gamma.md` — row 119 documents the field set; update if the measurement adds fields to it.",
      },
    ]);
  });

  test("the OUT-of-scope and Context paths are never enumerated — the strict-parse guarantee", () => {
    // This is the whole reason the check parses strictly. Under the shared
    // extractor's fallback chain, `unrelated-prior-art.ts` (Context) and
    // `never-touched-but-out-of-scope.ts` (Out of scope) would both be
    // collected and both reported as unkept promises.
    const outcome = run(INPUT, ctxWith([ALPHA, BETA]), {
      fetchSpec: () => SPEC_THREE_PATHS,
    });
    const cal = outcome?.calibration as Record<string, unknown> | undefined;
    const untouched = cal?.[UNTOUCHED] as Array<{ path: string }>;
    const paths = untouched.map((u) => u.path);
    expect(paths).not.toContain(PRIOR_ART);
    expect(paths).not.toContain(OUT_OF_SCOPE_PATH);
  });
});

describe("mt#4544 — AT2: every enumerated path touched", () => {
  test("run() records `clean` and no untouched list", () => {
    const outcome = run(INPUT, ctxWith([ALPHA, BETA, GAMMA]), {
      fetchSpec: () => SPEC_THREE_PATHS,
    });
    const cal = outcome?.calibration as Record<string, unknown> | undefined;
    expect(cal?.[OUTCOME]).toBe(CLEAN);
    expect(cal?.[UNTOUCHED]).toBeUndefined();
  });
});

describe("mt#4544 — AT3: nothing to compare is NOT a clean pass", () => {
  test("a prose-only In scope section records `skipped`, distinctly from AT2", () => {
    const outcome = run(INPUT, ctxWith([ALPHA]), {
      fetchSpec: () => SPEC_PROSE_ONLY,
    });
    const cal = outcome?.calibration as Record<string, unknown> | undefined;
    // The load-bearing assertion is the INEQUALITY with AT2's outcome: a zero
    // from an unparseable section and a zero from a fully-executed enumeration
    // are different findings, and collapsing them is how a check reports
    // coverage it does not have.
    expect(cal?.[OUTCOME]).toBe(SKIPPED);
    expect(cal?.[OUTCOME]).not.toBe(CLEAN);
    expect(String(cal?.[REASON])).toContain("nothing to compare");
  });

  test("a prose-only spec does NOT fall back to Context paths", () => {
    // `SPEC_PROSE_ONLY`'s Context section names a real path. Under the
    // non-strict extractor that path becomes the "enumeration" and is reported
    // as untouched. Strict mode is what keeps this a `skipped`.
    const outcome = run(INPUT, ctxWith([ALPHA]), {
      fetchSpec: () => SPEC_PROSE_ONLY,
    });
    const cal = outcome?.calibration as Record<string, unknown> | undefined;
    expect(cal?.[OUTCOME]).toBe(SKIPPED);
    expect(cal?.[UNTOUCHED]).toBeUndefined();
  });
});

describe("mt#4544 — not-adjudicable paths record `skipped`, never `clean`", () => {
  test("no transcript lines", () => {
    const outcome = run(INPUT, { transcriptLines: [] } as unknown as DispatchContext, {
      fetchSpec: () => SPEC_THREE_PATHS,
    });
    expect((outcome?.calibration as Record<string, unknown>)?.[OUTCOME]).toBe(SKIPPED);
  });

  test("no `task` parameter on the call", () => {
    const input = {
      ...INPUT,
      tool_input: { title: "t", type: "chore" },
    } as unknown as ToolHookInput;
    const outcome = run(input, ctxWith([ALPHA]), {
      fetchSpec: () => SPEC_THREE_PATHS,
    });
    const cal = outcome?.calibration as Record<string, unknown> | undefined;
    expect(cal?.[OUTCOME]).toBe(SKIPPED);
    expect(String(cal?.[REASON])).toContain("no `task` parameter");
  });

  test("the spec could not be fetched", () => {
    const outcome = run(INPUT, ctxWith([ALPHA]), { fetchSpec: () => null });
    const cal = outcome?.calibration as Record<string, unknown> | undefined;
    expect(cal?.[OUTCOME]).toBe(SKIPPED);
    expect(String(cal?.[REASON])).toContain("could not fetch spec");
  });

  test("no edit calls in the window", () => {
    const outcome = run(INPUT, ctxWith([]), { fetchSpec: () => SPEC_THREE_PATHS });
    const cal = outcome?.calibration as Record<string, unknown> | undefined;
    expect(cal?.[OUTCOME]).toBe(SKIPPED);
  });
});
