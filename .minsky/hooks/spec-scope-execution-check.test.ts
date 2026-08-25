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

describe("mt#4544 — AT1: an enumerated path the PR never touched", () => {
  test("three enumerated, two touched -> exactly one finding, quoting its line", () => {
    const { inScopeBlock } = extractInScopeFiles(SPEC_THREE_PATHS, { strict: true });
    const untouched = untouchedEnumeratedPaths(inScopeBlock, [ALPHA, BETA, GAMMA], [ALPHA, BETA]);
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
