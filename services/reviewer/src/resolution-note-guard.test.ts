import { describe, expect, test } from "bun:test";
import {
  classifyResolutionArgument,
  evaluateSubmitFindingCall,
  isResolutionNoteText,
  markUntrackedDeferral,
  UNTRACKED_DEFERRAL_MARKER,
} from "./resolution-note-guard";
import { composeReviewBody } from "./compose-review";
import type { ReviewToolCall, SubmitFindingArgs } from "./output-tools";

function finding(overrides: Partial<SubmitFindingArgs> = {}): ReviewToolCall {
  return {
    name: "submit_finding",
    args: {
      severity: "BLOCKING",
      file: "src/foo.ts",
      line: 10,
      summary: "s",
      details: "d",
      ...overrides,
    },
  };
}

function approveConclusion(): ReviewToolCall {
  return {
    name: "conclude_review",
    args: { event: "APPROVE", summary: "No new critical defects; approving this chunk." },
  };
}

// The live PR #1957 R2 incident finding text (chunked re-verification 2/2).
const PR1957_SUMMARY = "Follow-up to the R1 block on the sanitizer wiring";
const PR1957_DETAILS =
  "No action required — the original block is resolved in the current diff. " +
  "Marking this thread for visibility.";

describe("isResolutionNoteText", () => {
  const positives: Array<[string, string]> = [
    [PR1957_SUMMARY, PR1957_DETAILS],
    ["Prior block", "no action required now that the guard was added"],
    ["Follow-up", "the original issue has been resolved in the current diff"],
    ["R1 concern", "this no longer applies after the refactor"],
    ["Retry logic", "fix verified against the reproduction"],
    ["Prior finding", "already addressed by the fix commit"],
    ["Cleanup", "nothing further to do here"],
  ];
  for (const [summary, details] of positives) {
    test(`matches resolution disposition: "${details}"`, () => {
      expect(isResolutionNoteText(summary, details)).toBe(true);
    });
  }

  const negatives: Array<[string, string]> = [
    // Imperative "must be resolved" is a genuine open defect, not a resolution note.
    ["Race condition", "this must be resolved before merge or data will be lost"],
    ["Unhandled case", "unresolved null dereference when config is missing"],
    ["Missing await", "the handler resolves the promise without awaiting it, dropping errors"],
    ["Validation gap", "requires action: the input is never bounds-checked"],
    ["Naming", "this identifier should be fixed to match the convention"],
    ["Generic defect", "off-by-one in the loop bound causes the last row to be skipped"],
    // Adversarial substrings that must NOT match thanks to word boundaries (\b).
    ["Prefix trap", "the prefix verified in this parser is computed incorrectly"],
    ["Substring trap", "the transaction is unresolved across the retry window"],
    ["Compound trap", "the manhandled buffer is addressedByOffset without validation"],
  ];
  for (const [summary, details] of negatives) {
    test(`does NOT match genuine defect: "${details}"`, () => {
      expect(isResolutionNoteText(summary, details)).toBe(false);
    });
  }
});

describe("evaluateSubmitFindingCall", () => {
  test("accepts a NON-BLOCKING finding even with resolution-note text", () => {
    const result = evaluateSubmitFindingCall({
      args: {
        severity: "NON-BLOCKING",
        file: "a.ts",
        line: 1,
        summary: PR1957_SUMMARY,
        details: PR1957_DETAILS,
      },
    });
    expect(result.decision).toBe("accept");
  });

  test("accepts a PRE-EXISTING finding even with resolution-note text", () => {
    const result = evaluateSubmitFindingCall({
      args: {
        severity: "PRE-EXISTING",
        file: "a.ts",
        line: 1,
        summary: "x",
        details: "already resolved",
      },
    });
    expect(result.decision).toBe("accept");
  });

  test("accepts a genuine BLOCKING defect unchanged (SC4)", () => {
    const result = evaluateSubmitFindingCall({
      args: {
        severity: "BLOCKING",
        file: "a.ts",
        line: 1,
        summary: "Data loss",
        details: "off-by-one in the loop bound causes the last row to be skipped",
      },
    });
    expect(result.decision).toBe("accept");
  });

  test("reclassifies a BLOCKING resolution-note finding to NON-BLOCKING", () => {
    const result = evaluateSubmitFindingCall({
      args: {
        severity: "BLOCKING",
        file: "a.ts",
        line: 1,
        summary: PR1957_SUMMARY,
        details: PR1957_DETAILS,
      },
    });
    expect(result.decision).toBe("reclassify");
    if (result.decision === "reclassify") {
      expect(result.newSeverity).toBe("NON-BLOCKING");
      expect(result.reason).toContain("mt#2863");
    }
  });

  test("is stateless — repeated calls on distinct findings do not interfere", () => {
    // Regression for the PR #2100 R1 finding: an earlier draft carried a per-review
    // rejection counter that bled across findings. The stateless guard treats each
    // call independently.
    const noteArgs: SubmitFindingArgs = {
      severity: "BLOCKING",
      file: "a.ts",
      line: 1,
      summary: PR1957_SUMMARY,
      details: PR1957_DETAILS,
    };
    const genuineArgs: SubmitFindingArgs = {
      severity: "BLOCKING",
      file: "b.ts",
      line: 2,
      summary: "Real defect",
      details: "null dereference on the empty-config path",
    };
    expect(evaluateSubmitFindingCall({ args: noteArgs }).decision).toBe("reclassify");
    expect(evaluateSubmitFindingCall({ args: genuineArgs }).decision).toBe("accept");
    expect(evaluateSubmitFindingCall({ args: noteArgs }).decision).toBe("reclassify");
  });
});

describe("classifyResolutionArgument (mt#3300 SC#2/SC#4)", () => {
  test("classifies an explicit code-fix claim (mt#2863's original case)", () => {
    expect(classifyResolutionArgument(PR1957_DETAILS)).toBe("code-fix");
    expect(classifyResolutionArgument("already addressed by the fix commit")).toBe("code-fix");
    expect(classifyResolutionArgument("fix verified against the reproduction")).toBe("code-fix");
  });

  test("classifies a spec-amendment argument", () => {
    expect(
      classifyResolutionArgument("no action needed — the spec was amended to drop this requirement")
    ).toBe("spec-amendment");
  });

  test("classifies a pre-existence argument", () => {
    expect(
      classifyResolutionArgument("no action required — this is pre-existing and predates this PR")
    ).toBe("pre-existence");
  });

  test("classifies a tracked deferral (deferral language + task id)", () => {
    expect(
      classifyResolutionArgument("no action required — deferred, tracked as mt#4200 for follow-up")
    ).toBe("tracked-deferral");
  });

  test("classifies an untracked deferral (deferral language, no task id)", () => {
    expect(
      classifyResolutionArgument("no action required — this is deferred to a follow-up task")
    ).toBe("untracked-deferral");
  });

  test("classifies unnamed resolution text as none", () => {
    expect(classifyResolutionArgument("no action required, nothing further to do here")).toBe(
      "none"
    );
  });
});

describe("evaluateSubmitFindingCall — argument-naming requirement (mt#3300 SC#2/SC#4)", () => {
  function blockingArgs(details: string): SubmitFindingArgs {
    return { severity: "BLOCKING", file: "a.ts", line: 1, summary: "Follow-up", details };
  }

  test("reclassifies a tracked-deferral resolution note (task id present)", () => {
    const result = evaluateSubmitFindingCall({
      args: blockingArgs("no action required — deferred, tracked as mt#4200"),
    });
    expect(result.decision).toBe("reclassify");
    if (result.decision === "reclassify") {
      expect(result.argumentKind).toBe("tracked-deferral");
    }
  });

  test("rejects an untracked-deferral resolution note (no task id) — SC#4", () => {
    const result = evaluateSubmitFindingCall({
      args: blockingArgs("no action required — this is deferred to a follow-up task"),
    });
    expect(result.decision).toBe("reject");
    if (result.decision === "reject") {
      expect(result.argumentKind).toBe("untracked-deferral");
    }
  });

  test("rejects a resolution note naming no recognized argument — SC#2", () => {
    const result = evaluateSubmitFindingCall({
      args: blockingArgs("no action required, nothing further to do here"),
    });
    expect(result.decision).toBe("reject");
    if (result.decision === "reject") {
      expect(result.argumentKind).toBe("none");
    }
  });

  test("reclassifies a spec-amendment resolution note", () => {
    const result = evaluateSubmitFindingCall({
      args: blockingArgs("no action needed — the spec was amended to drop this requirement"),
    });
    expect(result.decision).toBe("reclassify");
    if (result.decision === "reclassify") {
      expect(result.argumentKind).toBe("spec-amendment");
    }
  });

  test("reclassifies a pre-existence resolution note", () => {
    const result = evaluateSubmitFindingCall({
      args: blockingArgs("no action required — this predates this change"),
    });
    expect(result.decision).toBe("reclassify");
    if (result.decision === "reclassify") {
      expect(result.argumentKind).toBe("pre-existence");
    }
  });
});

describe("markUntrackedDeferral (mt#3300 R1 non-blocking — idempotent prepend)", () => {
  test("prepends the marker to unmarked text", () => {
    expect(markUntrackedDeferral("deferred to a follow-up")).toBe(
      `${UNTRACKED_DEFERRAL_MARKER} deferred to a follow-up`
    );
  });

  test("does not duplicate the marker when it is already present", () => {
    const already = `${UNTRACKED_DEFERRAL_MARKER} deferred to a follow-up`;
    expect(markUntrackedDeferral(already)).toBe(already);
  });

  test("is stable across repeated application (idempotent)", () => {
    const once = markUntrackedDeferral("deferred to a follow-up");
    const twice = markUntrackedDeferral(once);
    expect(twice).toBe(once);
  });
});

describe("PR #1957 R2 replay (SC3): guard + compose pipeline", () => {
  function effectiveSeverity(args: SubmitFindingArgs): SubmitFindingArgs["severity"] {
    const decision = evaluateSubmitFindingCall({ args });
    return decision.decision === "reclassify" ? decision.newSeverity : args.severity;
  }

  test("BEFORE fix: BLOCKING resolution-note + APPROVE reconciles to REQUEST_CHANGES (the bug)", () => {
    const toolCalls: ReviewToolCall[] = [
      finding({ severity: "BLOCKING", summary: PR1957_SUMMARY, details: PR1957_DETAILS }),
      approveConclusion(),
    ];
    const result = composeReviewBody(toolCalls);
    expect(result.event).toBe("REQUEST_CHANGES");
    expect(result.reconciled).toBe(true);
  });

  test("AFTER fix: guard reclassifies the resolution note → APPROVE, 0 blocking", () => {
    const recorded: SubmitFindingArgs = {
      severity: "BLOCKING",
      file: "src/foo.ts",
      line: 10,
      summary: PR1957_SUMMARY,
      details: PR1957_DETAILS,
    };
    const toolCalls: ReviewToolCall[] = [
      finding({
        severity: effectiveSeverity(recorded),
        summary: PR1957_SUMMARY,
        details: PR1957_DETAILS,
      }),
      approveConclusion(),
    ];
    const result = composeReviewBody(toolCalls);
    expect(result.event).toBe("APPROVE");
    expect(result.reconciled).toBe(false);
  });

  test("a genuine new BLOCKING re-verification finding still produces REQUEST_CHANGES", () => {
    const recorded: SubmitFindingArgs = {
      severity: "BLOCKING",
      file: "a.ts",
      line: 1,
      summary: "New defect introduced by the fix commit",
      details: "the retry loop now double-counts and drops the final item",
    };
    const toolCalls: ReviewToolCall[] = [
      finding({
        severity: effectiveSeverity(recorded),
        file: recorded.file,
        line: recorded.line,
        summary: recorded.summary,
        details: recorded.details,
      }),
      approveConclusion(),
    ];
    const result = composeReviewBody(toolCalls);
    expect(result.event).toBe("REQUEST_CHANGES");
    expect(result.reconciled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mt#4977 — the severity token used as the NOUN
// ---------------------------------------------------------------------------

describe("bare BLOCKING as the noun (mt#4977)", () => {
  // Verbatim from review 4807695646 on PR #2392 (commit 8f49da10f), the
  // occurrence that produced this task. The finding concluded CHANGES_REQUESTED
  // on a PR the same reviewer APPROVED three minutes earlier and again ten
  // minutes later; cost was 3 extra rounds, 2 manual dismissals and a retrigger.
  const REAL_SUMMARY =
    "`spawnSync` args-array without options is now flagged — prior BLOCKING addressed";
  const REAL_DETAILS =
    'Verification: the R2 BLOCKING issue stated the rule skipped `spawnSync("git", ["status"])` ' +
    'by treating an ArrayExpression as `"unknown"` and early-returning. In this commit, ' +
    '`classifyOptionProperty` classifies ArrayExpression as `"absent"`. This fixes the skip and ' +
    "is pinned by the new test. This finding records that the prior BLOCKING is resolved.";

  test("matches the verbatim PR #2392 R4 finding that escaped the shipped pattern", () => {
    expect(isResolutionNoteText(REAL_SUMMARY, REAL_DETAILS)).toBe(true);
  });

  test("matches the bare severity token used as a noun, on its own", () => {
    // The mechanism, isolated from the incident text: `block` is a different
    // word under `\b` and `blocking finding` needs the following word, so
    // neither reached "the prior BLOCKING is resolved".
    expect(isResolutionNoteText("", "the prior BLOCKING is resolved")).toBe(true);
    expect(isResolutionNoteText("", "the original blocking has been addressed")).toBe(true);
    expect(isResolutionNoteText("", "the R2 blocking issue is now resolved")).toBe(true);
  });

  test("longest-first ordering keeps the pre-existing multi-word nouns matching", () => {
    // Regression guard on the alternation ORDER: a bare `blocking` placed
    // before `blocking finding` would consume the qualifier and strand the
    // following word, silently narrowing a case that used to match.
    expect(isResolutionNoteText("", "the prior blocking finding is resolved")).toBe(true);
    expect(isResolutionNoteText("", "the previous finding was addressed")).toBe(true);
    expect(isResolutionNoteText("", "the original concern has now been handled")).toBe(true);
  });

  test("the verbless past-participle form stays UNMATCHED — deliberately", () => {
    // This is the widening NOT taken. Making the linking verb optional would
    // match this, and would also match the three defect phrasings pinned in the
    // next test. Recorded as a pin so a later pass cannot quietly take it
    // without confronting those three.
    expect(isResolutionNoteText("", "prior blocking finding addressed")).toBe(false);
  });

  test("genuine defect prose the verb-optional variant would have downgraded", () => {
    // Measured 2026-09-04: dropping the linking-verb requirement matched all
    // three of these. Each is ordinary reviewer prose describing a real defect,
    // and a match would silently reclassify it BLOCKING → NON-BLOCKING.
    expect(
      isResolutionNoteText("", "this finding addressed a different concern than the one filed")
    ).toBe(false);
    expect(isResolutionNoteText("", "the issue resolved nothing about the underlying race")).toBe(
      false
    );
    expect(isResolutionNoteText("", "the concern addressed by this helper is out of scope")).toBe(
      false
    );
  });

  test("the widened noun does not match `blocking` used as an adjective", () => {
    expect(isResolutionNoteText("", "this is blocking on the missing migration")).toBe(false);
    expect(isResolutionNoteText("", "a blocking call inside the loop is the defect")).toBe(false);
  });
});
