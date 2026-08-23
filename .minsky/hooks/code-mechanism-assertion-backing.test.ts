// Backing-axis tests for code-mechanism-assertion (mt#4084).
//
// Split from `code-mechanism-assertion-detector.test.ts` rather than appended to
// it: that file sits at the 1500-line `max-lines` ceiling, and mt#3876 set the
// precedent of giving a distinct axis its own file. This one covers ONE
// question — what the verification corpus admits as backing — while the sibling
// covers claim EXTRACTION.
import { describe, test, expect } from "bun:test";
import {
  detectCodeMechanismAssertion,
  buildVerificationCorpus,
} from "./code-mechanism-assertion-detector";
import type { TranscriptLine } from "./transcript";

/** MCP-prefixed spellings, as production records them. */
const REFS_STATUS = "mcp__minsky__refs_status";
const TASKS_GET = "mcp__minsky__tasks_get";
const SESSION_COMMIT = "mcp__minsky__session_commit";

/** One assistant tool_use block, in the nested shape production records. */
function callTurn(name: string, input: Record<string, unknown>): TranscriptLine[] {
  return [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name, id: "toolu_mt4084", input }],
      },
    } as TranscriptLine,
  ];
}

const symbolsFor = (text: string, turn: TranscriptLine[]): string[] =>
  detectCodeMechanismAssertion(text, buildVerificationCorpus(turn), "").claims.map((c) => c.symbol);

const symbolsBefore = (text: string, turn: TranscriptLine[]): string[] =>
  detectCodeMechanismAssertion(
    text,
    buildVerificationCorpus(turn, { includeCallRecord: false }),
    ""
  ).claims.map((c) => c.symbol);

describe("mt#4084 — the same-turn tool CALL RECORD backs claims about the call", () => {
  describe("AT1 — the originating false positive", () => {
    // Verbatim from the 2026-08-12T21:01:36.298Z calibration record.
    const CLAIM = "Merged (verified-1a: `refs_status` this turn returns DONE/merged)";
    const turn = (): TranscriptLine[] => callTurn(REFS_STATUS, { refs: ["mt#4084"] });

    test("fires against the pre-mt#4084 corpus", () => {
      expect(symbolsBefore(CLAIM, turn())).toContain("refs_status");
    });

    test("is backed once the call record is admitted", () => {
      expect(symbolsFor(CLAIM, turn())).not.toContain("refs_status");
    });

    test("the MCP prefix resolves with no stripping layer — backing is a substring test", () => {
      // SC2 needs no code: the prefixed name CONTAINS the bare one. Pinned so
      // nobody adds an alias table believing it was required.
      const corpus = buildVerificationCorpus(callTurn(REFS_STATUS, {}));
      expect(corpus).toContain(REFS_STATUS);
      expect(corpus.toLowerCase()).toContain("refs_status");
    });
  });

  test("AT2 — the volunteered-mechanism control still fires, on BOTH its claims", () => {
    // The 2026-08-13T12:07:14.009Z record carries TWO claims; the spec named only
    // `AppleScript`. A control that watches one of two is half a control.
    const text =
      "The daemon captures window grouping via AppleScript, which returns empty when iTerm " +
      "is wedged, so iterm_window_id returns nothing for that pane.";
    const symbols = symbolsFor(text, callTurn(TASKS_GET, { taskId: "mt#1" }));
    expect(symbols).toContain("AppleScript");
    expect(symbols).toContain("iterm_window_id");
  });

  test("AT3 — a claim about a tool the turn actually called does not fire", () => {
    expect(
      symbolsFor(
        "`tasks_get` returns DONE for that id.",
        callTurn(TASKS_GET, { taskId: "mt#4084" })
      )
    ).not.toContain("tasks_get");
  });

  test("AT4 — the same claim with NO tool call still fires", () => {
    // The discriminating half of AT3: without this, AT3 would pass on a detector
    // that had simply stopped extracting the symbol.
    expect(symbolsFor("`tasks_get` returns DONE for that id.", [])).toContain("tasks_get");
  });

  describe("AT5 — a declared parameter KEY of a called tool backs a claim about it", () => {
    // Verbatim from the 2026-08-13T18:26:28.691Z record, not paraphrased: a
    // fixture is an input drawn from the matcher's domain, and rewording moves it
    // out (mem#1020). An earlier draft invented a sentence whose predicate the
    // detector does not recognize — so it asserted the absence of a claim that was
    // never extracted, and passed identically with the change reverted. The
    // negative-control run caught it; the before-assertion is what keeps it caught.
    const CLAIM =
      "I passed a 9-char short hash as `expectedHeadSha`; if the tool compares full 40-char " +
      "shas that would never match and the wait would never return.";
    const turn = (): TranscriptLine[] =>
      callTurn("mcp__minsky__session_pr_wait-for-review", {
        task: "mt#4084",
        expectedHeadSha: "abc123",
      });

    test("fires against the pre-mt#4084 corpus", () => {
      expect(symbolsBefore(CLAIM, turn())).toContain("expectedHeadSha");
    });

    test("is backed once the parameter key is admitted", () => {
      expect(symbolsFor(CLAIM, turn())).not.toContain("expectedHeadSha");
    });
  });

  describe("PR #3046 R1 — only DISTINCTIVE parameter keys are admitted", () => {
    // `message`, `content`, `task`, `path`, `input` and `limit` are all extracted
    // as symbols (verified by running isPlausibleSymbol — they are not on
    // ADR-034's generic-word list), and `message` is a `session_commit`
    // parameter. Admitting every key would silently back a claim about it from
    // an unrelated commit in the same turn.
    test.each(["message", "content", "task", "path", "input", "limit"])(
      "a generic key does not back a claim: %s",
      (key) => {
        const turn = callTurn(SESSION_COMMIT, { [key]: "some value" });
        expect(symbolsFor(`\`${key}\` returns null when unset.`, turn)).toContain(key);
      }
    );

    test.each(["expectedHeadSha", "overrideReason", "notBefore", "head_sha"])(
      "a distinctive key does back a claim: %s",
      (key) => {
        const turn = callTurn(SESSION_COMMIT, { [key]: "v" });
        expect(symbolsFor(`\`${key}\` returns null when unset.`, turn)).not.toContain(key);
      }
    );
  });

  describe("AT6 — parameter VALUES are NOT admitted beyond today's read-class behavior", () => {
    const CLAIM = "`resolveNominationDeps` returns null when unconfigured.";

    test("a symbol appearing only as a NON-read-class tool's input value still fires", () => {
      // The agent CHOOSES a value, so admitting it is the write-echo inversion
      // mt#3489 split out of this corpus. Pinned so a later widening to values is
      // a decision that breaks a test rather than drift.
      const turn = callTurn(SESSION_COMMIT, {
        message: "touching resolveNominationDeps",
      });
      expect(symbolsFor(CLAIM, turn)).toContain("resolveNominationDeps");
    });

    test("a read-class tool's input value still backs, as it did before", () => {
      const turn = callTurn("Read", { file_path: "src/resolveNominationDeps.ts" });
      expect(symbolsFor(CLAIM, turn)).not.toContain("resolveNominationDeps");
    });
  });
});
