// Tests for the mt#3490 / ADR-031 turn-anchor mechanism.
//
// Every test injects a temp store dir rather than patching the store module —
// `readAnchor`/`writeAnchor`/`clearAnchor` and `run` all take `dir`/`storeDir`
// as a parameter for exactly this reason. In-place patching (`spyOn`) of a
// collaborator the code reaches itself is banned outright (ADR-036).

/* eslint-disable custom/no-real-fs-in-tests -- this file exercises the REAL
   turn-anchor-store roundtrip (Stop writes -> prompt-time reads) in an isolated
   mkdtemp dir, mirroring ask-routing-deferral-detector.test.ts's precedent for
   the sibling turn-end-scan-store. A mocked fs would test the mock: the store's
   entire contract IS durable cross-event persistence, including its fail-open
   behaviour on malformed/absent files, which only a real read can exercise. The
   store takes its directory as a PARAMETER, so isolation comes from injection
   rather than from patching `node:fs` — which ADR-036 bans outright. A fixed
   mock dir (what the rule suggests) would reintroduce the cross-test race the
   per-test mkdtemp exists to avoid. */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readAnchor, writeAnchor, clearAnchor } from "./turn-anchor-store";
import { turnKeyFor } from "./turn-end-scan-store";
import { resolveCompletedTurn, resolveCompletedTurnFromAnchor } from "./transcript";
import type { TranscriptLine } from "./transcript";
import { run as recordTurnAnchor } from "./record-turn-anchor";
import { resolveFinalAssistantText, extractFinalAssistantText } from "./wall-of-text-detector";
import type { DispatchContext } from "./registry";

let storeDir: string;

beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), "mt3490-anchor-"));
});

afterEach(() => {
  rmSync(storeDir, { recursive: true, force: true });
});

const SESSION = "mt3490-session";

function prompt(uuid: string, text = "do the thing"): TranscriptLine {
  return {
    type: "user",
    message: { role: "user", content: text },
    uuid,
    timestamp: `2026-08-05T00:00:0${uuid.slice(-1)}.000Z`,
  } as TranscriptLine;
}

function assistant(text: string): TranscriptLine {
  return {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
  } as TranscriptLine;
}

function ctxWith(lines: TranscriptLine[]): DispatchContext {
  return {
    event: "Stop",
    hostCapSec: 60,
    budgets: { overallMs: 60000, fetchMs: 10000, gitMs: 10000 },
    transcriptCandidates: [],
    transcriptLines: lines,
  } as unknown as DispatchContext;
}

// ---------------------------------------------------------------------------
// Store round-trip + fail-open
// ---------------------------------------------------------------------------

describe("turn-anchor-store", () => {
  test("round-trips an anchor", () => {
    writeAnchor(SESSION, { turnKey: "p1", lastAssistantMessage: "done" }, storeDir);
    expect(readAnchor(SESSION, storeDir)).toEqual({
      turnKey: "p1",
      lastAssistantMessage: "done",
    });
  });

  test("returns undefined when nothing was recorded", () => {
    expect(readAnchor("never-written", storeDir)).toBeUndefined();
  });

  test("fails open to undefined on malformed JSON rather than throwing", () => {
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, `${SESSION}.json`), "{not json", "utf8");
    expect(readAnchor(SESSION, storeDir)).toBeUndefined();
  });

  test("fails open to undefined when the record carries no usable key", () => {
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(storeDir, `${SESSION}.json`), JSON.stringify({ turnKey: "" }), "utf8");
    expect(readAnchor(SESSION, storeDir)).toBeUndefined();
  });

  test("one anchor per session — a later write REPLACES, it does not accumulate", () => {
    writeAnchor(SESSION, { turnKey: "p1", lastAssistantMessage: "first" }, storeDir);
    writeAnchor(SESSION, { turnKey: "p2", lastAssistantMessage: "second" }, storeDir);
    // The bounded-growth property the spec requires: a long conversation leaves
    // the same single record a short one does.
    expect(readAnchor(SESSION, storeDir)).toEqual({
      turnKey: "p2",
      lastAssistantMessage: "second",
    });
  });

  test("clearAnchor removes the record", () => {
    writeAnchor(SESSION, { turnKey: "p1", lastAssistantMessage: "x" }, storeDir);
    clearAnchor(SESSION, storeDir);
    expect(readAnchor(SESSION, storeDir)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Key agreement — the anti-divergence pin promised by transcript.ts's
// `anchorKeyOf` doc comment. The writer (`turnKeyFor`) and the matcher
// (`resolveCompletedTurnFromAnchor`) are deliberately not a shared import, so
// this test is what keeps them from drifting apart.
// ---------------------------------------------------------------------------

describe("anchor key agreement between turnKeyFor and the matcher", () => {
  test("a uuid-keyed prompt written by turnKeyFor is found by the matcher", () => {
    const opening = prompt("uuid-A");
    const lines = [opening, assistant("work"), prompt("uuid-B")];

    const key = turnKeyFor(opening);
    expect(key).toBe("uuid-A");

    const resolved = resolveCompletedTurnFromAnchor(lines, key);
    expect(resolved?.openingPromptIndex).toBe(0);
  });

  test("a prompt with no uuid falls back to timestamp on BOTH sides", () => {
    const opening = {
      type: "user",
      message: { role: "user", content: "hi" },
      timestamp: "2026-08-05T09:00:00.000Z",
    } as TranscriptLine;
    const lines = [opening, assistant("work"), prompt("uuid-B")];

    const key = turnKeyFor(opening);
    expect(key).toBe("2026-08-05T09:00:00.000Z");
    expect(resolveCompletedTurnFromAnchor(lines, key)?.openingPromptIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AT1 — with an anchor, the window is the anchor-bounded span, asserted
// DIRECTLY rather than inferred from a detector's fire/no-fire outcome.
// ---------------------------------------------------------------------------

describe("AT1: anchored window", () => {
  test("the window is exactly the span from the anchored prompt to the next prompt", () => {
    const lines = [
      prompt("uuid-1"),
      assistant("turn one"),
      prompt("uuid-2"),
      assistant("turn two"),
      assistant("turn two continued"),
      prompt("uuid-3"), // the firing prompt, already landed
    ];

    const resolved = resolveCompletedTurnFromAnchor(lines, "uuid-2");

    expect(resolved).toBeDefined();
    expect(resolved?.openingPromptIndex).toBe(2);
    expect(resolved?.firingPromptLanded).toBe(true);
    expect(resolved?.turnLines).toEqual([lines[3] as TranscriptLine, lines[4] as TranscriptLine]);
  });

  test("when the firing prompt has NOT landed, the window runs to end-of-transcript", () => {
    const lines = [prompt("uuid-1"), assistant("turn one"), prompt("uuid-2"), assistant("tail")];

    const resolved = resolveCompletedTurnFromAnchor(lines, "uuid-2");

    expect(resolved?.firingPromptLanded).toBe(false);
    expect(resolved?.turnLines).toEqual([lines[3] as TranscriptLine]);
  });

  test("an anchor naming no line in this transcript returns undefined, never a wrong window", () => {
    const lines = [prompt("uuid-1"), assistant("a")];
    expect(resolveCompletedTurnFromAnchor(lines, "uuid-not-here")).toBeUndefined();
  });

  test("the session-start sentinel is refused rather than matched by luck", () => {
    const lines = [prompt("uuid-1"), assistant("a")];
    expect(resolveCompletedTurnFromAnchor(lines, "session-start")).toBeUndefined();
    expect(resolveCompletedTurnFromAnchor(lines, "")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AT2 — with NO anchor, behaviour is byte-identical to resolveCompletedTurn.
// This is ADR-031's degradation claim: absence of an anchor is
// indistinguishable from today, not from broken.
// ---------------------------------------------------------------------------

describe("AT2: fallback equivalence when no anchor is recorded", () => {
  const shapes: Array<{ name: string; lines: TranscriptLine[] }> = [
    {
      name: "firing prompt landed (tail empty after last prompt)",
      lines: [prompt("uuid-1"), assistant("turn one"), prompt("uuid-2")],
    },
    {
      name: "firing prompt not landed (lines after last prompt)",
      lines: [prompt("uuid-1"), assistant("turn one"), prompt("uuid-2"), assistant("turn two")],
    },
    {
      name: "single prompt, first turn of a conversation",
      lines: [prompt("uuid-1"), assistant("only turn")],
    },
    { name: "no real prompt at all", lines: [assistant("orphan")] },
  ];

  for (const { name, lines } of shapes) {
    test(`empty store resolves the same window as resolveCompletedTurn — ${name}`, () => {
      // The store is genuinely empty for this session id.
      const anchor = readAnchor("no-such-session", storeDir);
      expect(anchor).toBeUndefined();

      // The consumer contract: no anchor => resolveCompletedTurn.
      const fallback = resolveCompletedTurn(lines);
      const viaAnchor = anchor ? resolveCompletedTurnFromAnchor(lines, anchor.turnKey) : undefined;

      expect(viaAnchor).toBeUndefined();
      expect(fallback).toEqual(resolveCompletedTurn(lines));
    });
  }
});

// ---------------------------------------------------------------------------
// AT3 — a turn ending on an API error records no anchor (StopFailure runs
// instead of Stop), and the next prompt-time resolution still works.
// ---------------------------------------------------------------------------

describe("AT3: API-error turn records no anchor and the fallback still resolves", () => {
  test("no Stop => no anchor => fallback produces a usable window", () => {
    const lines = [prompt("uuid-1"), assistant("turn one"), prompt("uuid-2"), assistant("two")];

    // The recorder never ran for this session — this is what StopFailure looks
    // like from the store's point of view.
    expect(readAnchor(SESSION, storeDir)).toBeUndefined();

    const fallback = resolveCompletedTurn(lines);
    expect(fallback.turnLines.length).toBeGreaterThan(0);
    expect(fallback.openingPromptIndex).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The recorder guard itself.
// ---------------------------------------------------------------------------

describe("record-turn-anchor (Stop recorder)", () => {
  test("records the final turn's opening prompt key and the final assistant text", async () => {
    const lines = [prompt("uuid-1"), assistant("turn one"), prompt("uuid-2"), assistant("two")];

    const outcome = await recordTurnAnchor(
      { session_id: SESSION, last_assistant_message: "the final text" } as never,
      ctxWith(lines),
      storeDir
    );

    // A recorder contributes no context and makes no decision.
    expect(outcome).toBeNull();
    expect(readAnchor(SESSION, storeDir)).toEqual({
      turnKey: "uuid-2",
      lastAssistantMessage: "the final text",
    });
  });

  test("records an empty string when the Stop event carried no final message", async () => {
    const lines = [prompt("uuid-1"), assistant("only")];

    await recordTurnAnchor({ session_id: SESSION } as never, ctxWith(lines), storeDir);

    // Empty string, not undefined — distinguishable from "no anchor recorded".
    expect(readAnchor(SESSION, storeDir)).toEqual({
      turnKey: "uuid-1",
      lastAssistantMessage: "",
    });
  });

  test("writes nothing when there is no session id", async () => {
    await recordTurnAnchor({} as never, ctxWith([prompt("uuid-1")]), storeDir);
    expect(readAnchor(SESSION, storeDir)).toBeUndefined();
  });

  test("writes nothing when the transcript holds no real prompt to anchor to", async () => {
    await recordTurnAnchor(
      { session_id: SESSION, last_assistant_message: "x" } as never,
      ctxWith([assistant("orphan")]),
      storeDir
    );
    expect(readAnchor(SESSION, storeDir)).toBeUndefined();
  });

  test("the anchor it writes is the one the matcher then resolves (round trip)", async () => {
    const stopLines = [prompt("uuid-1"), assistant("turn one")];

    await recordTurnAnchor(
      { session_id: SESSION, last_assistant_message: "done" } as never,
      ctxWith(stopLines),
      storeDir
    );

    // At the NEXT UserPromptSubmit the firing prompt has landed, so the anchored
    // line is now the second-to-last prompt — the same physical line.
    const promptTimeLines = [...stopLines, prompt("uuid-2")];
    const anchor = readAnchor(SESSION, storeDir);
    const resolved = resolveCompletedTurnFromAnchor(promptTimeLines, anchor?.turnKey ?? "");

    expect(resolved?.openingPromptIndex).toBe(0);
    expect(resolved?.turnLines).toEqual([stopLines[1] as TranscriptLine]);
  });
});

// ---------------------------------------------------------------------------
// SC5 — wall-of-text consumes the recorded final text, with the
// reconstruction retained as the fallback path.
//
// These live here rather than in `wall-of-text-detector.test.ts` deliberately:
// mt#3718 is editing that file concurrently, and `resolveFinalAssistantText` is
// a pure function that needs none of its fixtures.
// ---------------------------------------------------------------------------

describe("SC5: resolveFinalAssistantText", () => {
  const RECONSTRUCTED = "reconstructed from the transcript";
  const RECORDED = "recorded at Stop";
  const turnLines = [assistant(RECONSTRUCTED)];

  test("prefers the recorded last_assistant_message when one was captured", () => {
    expect(resolveFinalAssistantText(turnLines, { lastAssistantMessage: RECORDED })).toBe(RECORDED);
  });

  test("falls back to reconstruction when NO anchor was recorded", () => {
    expect(resolveFinalAssistantText(turnLines, undefined)).toBe(RECONSTRUCTED);
  });

  test("falls back to reconstruction when the recorded message is empty", () => {
    // The recorder stores "" for a Stop event that carried no text; measuring an
    // empty string would suppress the detector rather than measure the turn.
    expect(resolveFinalAssistantText(turnLines, { lastAssistantMessage: "" })).toBe(RECONSTRUCTED);
  });

  test("the fallback is byte-identical to calling extractFinalAssistantText directly", () => {
    expect(resolveFinalAssistantText(turnLines, undefined)).toBe(
      extractFinalAssistantText(turnLines)
    );
  });
});

// ---------------------------------------------------------------------------
// AT4 — the recorder writes nothing a calibration log reads.
// ---------------------------------------------------------------------------

describe("AT4: no calibration surface", () => {
  test("the anchor store writes only its own per-session file", async () => {
    const { readdirSync } = await import("node:fs");

    await recordTurnAnchor(
      { session_id: SESSION, last_assistant_message: "x" } as never,
      ctxWith([prompt("uuid-1"), assistant("a")]),
      storeDir
    );

    // No *-calibration.jsonl, no watermark file — the recorder is not a
    // detector, so `calibration-review-watermarks.json` needs no migration.
    const entries = readdirSync(storeDir);
    expect(entries).toEqual([`${SESSION}.json`]);
  });
});
