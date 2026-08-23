/**
 * mt#4190 — the tune, asserted against REAL fires rather than invented prose.
 *
 * Two directions, and the recall one is listed first on purpose. Every assertion
 * in the precision direction says "this must STOP firing", and a discriminator
 * that silences the true positives too satisfies all of them while switching the
 * guard off. The recall controls are what makes that failure visible.
 *
 * LIVENESS BEFORE SUPPRESSION (mem#1020). A negative assertion passes vacuously
 * on a fixture that reaches no matcher, and it survives its own negative control,
 * because "nothing matched" is stable whether or not the code under test is
 * disabled. So each precision case asserts FIRST that the fixture still carries
 * the raw signals — verb, file token, no denial — and only then that the
 * discriminator is what silences it. A fixture that fails the liveness line is
 * broken, not passing.
 */
import { describe, test, expect } from "bun:test";
import {
  claimsFileCollision,
  isAuditRecordParagraph,
  paragraphsWithCollisionSignals,
  prNumbersInParagraph,
  run,
} from "./claim-provenance-scan";
import { prNumbersFromCommandFileListRead } from "./evidence-provenance-table";
import type { DispatchContext } from "./registry";
import type { ToolHookInput } from "./types";
import type { TranscriptLine } from "./transcript";
import {
  CITATION_IDIOM_MT4231,
  DEFENSIBLE_COLLISION_MT4188,
  DEFENSIBLE_COLLISION_MT4234,
  GATE_VERDICT_BLOCK_MT4275,
  GATE_VERDICT_TABLE_MT4281,
  HYPHENATED_DENIAL_MT4064,
  INLINE_PREMISE_AUDIT_MT4291,
} from "./claim-provenance-corpus-fixtures";

let nextId = 0;

function toolCallLine(name: string, input: Record<string, unknown> = {}): TranscriptLine {
  nextId += 1;
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: `toolu_${nextId}`, name, input }],
    },
  } as unknown as TranscriptLine;
}

function ctxWith(lines: TranscriptLine[]): DispatchContext {
  return { transcriptLines: lines } as unknown as DispatchContext;
}

function patchInput(content: string): ToolHookInput {
  return {
    session_id: "sess-mt4190",
    tool_name: "mcp__minsky__tasks_spec_patch",
    tool_input: { taskId: "mt#4190", content },
  } as unknown as ToolHookInput;
}

const NOISE = [toolCallLine("Read", { file_path: "a.ts" })];

const PR_READ_TOOL = "mcp__github__pull_request_read";

const prFilesCall = (pullNumber: number): TranscriptLine =>
  toolCallLine(PR_READ_TOOL, { method: "get_files", pullNumber });

// ---------------------------------------------------------------------------
// Recall controls — these MUST keep firing
// ---------------------------------------------------------------------------

describe("recall controls: the fires that should survive the tune", () => {
  test("a real file-level collision against a named PR still fires", () => {
    expect(claimsFileCollision(DEFENSIBLE_COLLISION_MT4234)).toBe(true);
  });

  test("a file-level co-location claim about a sibling task still fires", () => {
    expect(claimsFileCollision(DEFENSIBLE_COLLISION_MT4188)).toBe(true);
  });

  test("the filenames both controls depend on live inside backticks", () => {
    // The hazard this pins: the obvious reading of ADR-024's Rung 1 is "elide
    // markdown non-prose and match the residual", and that pass blanks inline
    // code spans — where this corpus keeps its paths. If a future change adopts
    // it wholesale, these two stop firing and the fire rate reads as a triumph.
    expect(DEFENSIBLE_COLLISION_MT4234).toContain("`registry-prompt-scan-guards.ts`");
    expect(DEFENSIBLE_COLLISION_MT4188).toContain(
      "`packages/domain/src/transcripts/event-schema.ts`"
    );
  });
});

// ---------------------------------------------------------------------------
// Precision — each case is live first, silenced second
// ---------------------------------------------------------------------------

describe("the audit-record discriminator", () => {
  test("a gate-verdict block reaches the matcher and is then recognized as a record", () => {
    expect(paragraphsWithCollisionSignals(GATE_VERDICT_BLOCK_MT4275).length).toBeGreaterThan(0);
    expect(claimsFileCollision(GATE_VERDICT_BLOCK_MT4275)).toBe(false);
  });

  test("a markdown gate table reaches the matcher and is then recognized as a record", () => {
    expect(paragraphsWithCollisionSignals(GATE_VERDICT_TABLE_MT4281).length).toBeGreaterThan(0);
    expect(claimsFileCollision(GATE_VERDICT_TABLE_MT4281)).toBe(false);
  });

  test("MAJORITY, not any-line: one gate letter in prose does not silence a claim", () => {
    // The over-reach this bounds. If `isAuditRecordParagraph` fired on a single
    // marker anywhere, a real collision claim that happens to cite gate (g)
    // would go unflagged — trading the dominant false class for a false
    // negative in the direction that matters.
    const prose = `Per gate (g) this collides with PR #3088 on \`registry-prompt-scan-guards.ts\`,
so the two cannot land together.`;
    expect(isAuditRecordParagraph(prose)).toBe(false);
    expect(claimsFileCollision(prose)).toBe(true);
  });

  test("a single record-shaped line is not a record paragraph", () => {
    expect(isAuditRecordParagraph("- **(g)** No parallel work.")).toBe(false);
  });

  test("an INLINE enumeration is a record too — same content, different typography", () => {
    expect(paragraphsWithCollisionSignals(INLINE_PREMISE_AUDIT_MT4291).length).toBeGreaterThan(0);
    expect(claimsFileCollision(INLINE_PREMISE_AUDIT_MT4291)).toBe(false);
  });

  test("THREE DISTINCT inline markers, so a prose citation is not an enumeration", () => {
    const oneMarker = "Per gate (g) this collides with PR #3088 on `src/thing.ts`.";
    const repeated =
      "Gate (g) says so; (g) again; and (g) once more — collides on `src/thing.ts` with PR #1.";
    expect(isAuditRecordParagraph(oneMarker)).toBe(false);
    expect(isAuditRecordParagraph(repeated)).toBe(false);
    expect(claimsFileCollision(oneMarker)).toBe(true);
  });
});

describe("the citation-parenthetical discriminator", () => {
  test("a citation idiom reaches the matcher and is then silenced", () => {
    expect(paragraphsWithCollisionSignals(CITATION_IDIOM_MT4231).length).toBeGreaterThan(0);
    expect(claimsFileCollision(CITATION_IDIOM_MT4231)).toBe(false);
  });

  test("only the parenthetical form is silenced — the bare verb still claims", () => {
    // Both halves carry a file token deliberately. An earlier draft of `cited`
    // named only `mapAttachmentTypeToBlockType`, which has no extension, so the
    // paragraph never reached the matcher and the assertion passed on an inert
    // input — mem#1020's silent direction, reproduced inside the very test file
    // written to guard against it. The negative control is what surfaced it:
    // this case did NOT fail with the discriminators disabled.
    const cited = "See `mapAttachmentTypeToBlockType` in `src/thing.ts` (same file, line 43).";
    const claimed = "mt#4188 is the sibling fix in the same file, `src/thing.ts`.";
    expect(paragraphsWithCollisionSignals(cited).length).toBeGreaterThan(0);
    expect(claimsFileCollision(cited)).toBe(false);
    expect(claimsFileCollision(claimed)).toBe(true);
  });

  test("a paragraph carrying BOTH keeps the real verb", () => {
    const both = `See \`mapAttachmentTypeToBlockType\` (same file, line 43); this also collides
with PR #3088 on \`src/thing.ts\`.`;
    expect(claimsFileCollision(both)).toBe(true);
  });

  test("REJECTED counterparty rule: a descriptively-named counterparty still claims", () => {
    // Pinned as a regression, not as behaviour under test. Requiring an
    // identifier (`PR #N` / `mt#N` / a branch) looks like the structural rule
    // here and silences the entire merge-shaped class, which names its
    // counterparty in prose. `sessionReadMergeHistory` exists for exactly that
    // class, so the guard would have contradicted its own discharge table.
    const merged = "This conflicts with a merge that landed on `src/thing.ts` yesterday.";
    expect(claimsFileCollision(merged)).toBe(true);
  });
});

describe("the overlap-denial repair", () => {
  test("a hyphenated compound before the overlap noun no longer defeats the denial", () => {
    // `\w` excludes `-`, so "no generated-file overlap" read as a negator plus
    // two non-matching tokens and the denial went unseen.
    expect(claimsFileCollision(HYPHENATED_DENIAL_MT4064)).toBe(false);
  });

  test("the repair does not swallow an assertion that merely contains a negation", () => {
    const asserted = "This is not optional: it collides with PR #3088 on `src/thing.ts`.";
    expect(claimsFileCollision(asserted)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The join, per paragraph
// ---------------------------------------------------------------------------

describe("per-paragraph discharge", () => {
  const twoClaims = `This collides with PR #774 on \`review-worker.test.ts\`.

Separately, this overlaps with PR #703 on \`services/reviewer/README.md\`.
`;

  test("reading one paragraph's PR does not discharge the other's", () => {
    const out = run(patchInput(twoClaims), ctxWith([...NOISE, prFilesCall(774)]));
    expect(out?.calibration?.["outcome"]).toBe("matched");
  });

  test("reading BOTH paragraphs' PRs discharges the spec", () => {
    const out = run(patchInput(twoClaims), ctxWith([...NOISE, prFilesCall(774), prFilesCall(703)]));
    expect(out?.calibration?.["outcome"]).toBe("clean");
  });

  test("prNumbersInParagraph is scoped to the span it is handed", () => {
    expect(prNumbersInParagraph("collides with PR #774 here")).toEqual([774]);
    expect(prNumbersInParagraph("no PR named, only mt#4190")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The discharge widening
// ---------------------------------------------------------------------------

describe("shell-performed file-list reads discharge", () => {
  const claim = "This collides with PR #3098 on `src/thing.ts`.";

  test("gh api .../pulls/<N>/files discharges the claim about THAT PR", () => {
    const out = run(
      patchInput(claim),
      ctxWith([
        toolCallLine("Bash", {
          command: 'gh api "repos/edobry/minsky/pulls/3098/files?per_page=100" --jq .[].filename',
        }),
      ])
    );
    expect(out?.calibration?.["outcome"]).toBe("clean");
  });

  test("a shell read of a DIFFERENT PR does not discharge it", () => {
    // The join stays PR-specific. Counting any file read at all would rebuild
    // mem#892 one step up.
    const out = run(
      patchInput(claim),
      ctxWith([toolCallLine("Bash", { command: "gh api repos/edobry/minsky/pulls/3128/files" })])
    );
    expect(out?.calibration?.["outcome"]).toBe("matched");
  });

  test("gh pr diff <N> --name-only discharges too", () => {
    const out = run(
      patchInput(claim),
      ctxWith([toolCallLine("Bash", { command: "gh pr diff 3098 --name-only" })])
    );
    expect(out?.calibration?.["outcome"]).toBe("clean");
  });

  test("a branch-range file diff discharges a claim that names NO PR", () => {
    const mergeShaped = "A recent merge touches the same file, `src/thing.ts`, as task/mt-4190.";
    const out = run(
      patchInput(mergeShaped),
      ctxWith([
        toolCallLine("Bash", {
          command: "git diff --name-only origin/main...origin/task/mt-4193",
        }),
      ])
    );
    expect(out?.calibration?.["outcome"]).toBe("clean");
  });

  test("repeated calls are stable, and a command naming two PRs yields both (PR #3139 R1)", () => {
    // The recognizer's patterns used to be module-level `g`-flagged literals,
    // i.e. shared mutable `lastIndex`. `matchAll` clones rather than stepping
    // the original, so the reported skip did not reproduce — but the safety was
    // a property of which METHOD the call site used, and one later `.test()`
    // would have started it stepping silently, in a recognizer whose failure
    // direction is firing at an author who did the work. They are compiled per
    // call now; this pins both halves of that.
    const twoPrs = {
      toolName: "Bash",
      input: {
        command:
          "gh api repos/edobry/minsky/pulls/3098/files && gh api repos/edobry/minsky/pulls/3128/files",
      },
      resultText: "",
    } as unknown as Parameters<typeof prNumbersFromCommandFileListRead>[0];

    const first = prNumbersFromCommandFileListRead(twoPrs);
    expect(first).toEqual([3098, 3128]);
    for (let i = 0; i < 3; i += 1) {
      expect(prNumbersFromCommandFileListRead(twoPrs)).toEqual(first);
    }
  });

  test("a plain git diff is not a changed-file enumeration", () => {
    const mergeShaped = "A recent merge touches the same file, `src/thing.ts`, as task/mt-4190.";
    const out = run(
      patchInput(mergeShaped),
      ctxWith([toolCallLine("Bash", { command: "git diff origin/main" })])
    );
    expect(out?.calibration?.["outcome"]).toBe("matched");
  });
});
