// Tests for the chain cap (mt#3860) and the advisory render's directive.
//
// `advisoryIsChainCapped` is the PURE half of the fix deliberately: the decision
// is "should this continuation's advisory be suppressed", and it is taken over a
// list of prior records. Splitting it from the filesystem read means these tests
// need no log file, no temp dir, and no spy on `readFileSync` — the collaborator
// is a value the function is handed, per `testing-standards.mdc §Testable Design`.
//
// The scanner itself is covered by bare-entity-ref-scan.test.ts; this file covers
// only what mt#3860 adds.

import { describe, expect, it } from "bun:test";
import {
  advisoryIsChainCapped,
  formatBareRefAdvisory,
  type PriorFireRecord,
} from "./turn-end-bare-ref-scan";
import type { ScanFinding } from "./bare-entity-ref-scan";

const SESSION = "session-under-test";

/** An ordinary (non-continuation) fire that emitted its advisory. */
const ordinaryFire: PriorFireRecord = {
  session_id: SESSION,
  stop_hook_active: false,
  advisory_emitted: true,
};

/** A continuation fire that emitted its advisory — the first follow-up. */
const continuationFire: PriorFireRecord = {
  session_id: SESSION,
  stop_hook_active: true,
  advisory_emitted: true,
};

/** A continuation fire that was itself capped, so it emitted nothing. */
const cappedFire: PriorFireRecord = {
  session_id: SESSION,
  stop_hook_active: true,
  advisory_emitted: false,
};

describe("advisoryIsChainCapped (mt#3860)", () => {
  it("does not cap the FIRST continuation after an ordinary fire", () => {
    // AT3's chosen behavior, asserted explicitly: a remedy message that names a
    // ref while explaining still fires exactly once. 26 of 63 measured
    // continuations named refs the previous message had not, so silencing this
    // one would suppress real misses (Success Criterion 2).
    expect(advisoryIsChainCapped([ordinaryFire], SESSION)).toBe(false);
  });

  it("caps the SECOND consecutive continuation", () => {
    // Success Criterion 3: a ref-set gets at most one follow-up.
    expect(advisoryIsChainCapped([ordinaryFire, continuationFire], SESSION)).toBe(true);
  });

  it("replays the originating five-turn sequence and bounds it to one follow-up", () => {
    // AT1. The 2026-08-08 chain: five consecutive turns, each remedy naming a
    // ref the next turn then flagged. Walked through the cap, turn 3 onward is
    // silent, so the chain is 2 fires rather than 5.
    const log: PriorFireRecord[] = [];
    const emitted: boolean[] = [];

    for (let turn = 1; turn <= 5; turn += 1) {
      const isContinuation = turn > 1;
      const capped = isContinuation && advisoryIsChainCapped(log, SESSION);
      emitted.push(!capped);
      log.push({
        session_id: SESSION,
        stop_hook_active: isContinuation,
        advisory_emitted: !capped,
      });
    }

    expect(emitted).toEqual([true, true, false, false, false]);
    expect(emitted.filter(Boolean)).toHaveLength(2);
  });

  it("stays capped after a fire that was itself suppressed", () => {
    // The regression the replay test above caught. An earlier draft keyed the
    // cap on `advisory_emitted`, so a SUPPRESSED turn read as "no follow-up has
    // happened yet" and the next turn fired again — emit/emit/silent/emit/silent,
    // which halves a chain instead of bounding it. Once in continuation
    // territory the chain stays capped.
    expect(advisoryIsChainCapped([ordinaryFire, continuationFire, cappedFire], SESSION)).toBe(true);
  });

  it("an ordinary fire between continuations breaks the chain", () => {
    // A chain is consecutive by definition: the operator spoke, the agent did
    // real work, and the next continuation is a new chain.
    expect(advisoryIsChainCapped([continuationFire, ordinaryFire], SESSION)).toBe(false);
  });

  it("ignores fires from other sessions", () => {
    const otherSession: PriorFireRecord = {
      session_id: "a-different-conversation",
      stop_hook_active: true,
      advisory_emitted: true,
    };

    expect(advisoryIsChainCapped([ordinaryFire, otherSession], SESSION)).toBe(false);
  });

  it("never caps when the session id is missing", () => {
    // Fail OPEN: without an id the guard cannot tell chains apart, and an extra
    // advisory is cheaper than a silenced one for an advisory-only guard.
    expect(advisoryIsChainCapped([continuationFire], undefined)).toBe(false);
  });

  it("never caps on an empty log", () => {
    expect(advisoryIsChainCapped([], SESSION)).toBe(false);
  });
});

describe("formatBareRefAdvisory directive (mt#3860)", () => {
  const finding = (ref: string): ScanFinding =>
    ({
      ref,
      reason: "no minsky:// link for this task in this message",
      kind: "bare-ref",
    }) as ScanFinding;

  it("asks for the refs named while linking, not only the flagged ones", () => {
    // The half that feeds the loop: a remedy names a ref in order to say which
    // ones it is linking. Asking for both in one pass is what collapses the
    // chain at the source rather than after the fact.
    const rendered = formatBareRefAdvisory([finding("mt#1234")]);

    expect(rendered).toContain("any ref you name while doing so");
  });

  it("still names the flagged refs and stays within the declared budget", () => {
    const rendered = formatBareRefAdvisory([finding("mt#1234"), finding("PR #5678")]);

    expect(rendered).toContain("mt#1234");
    // The render is greedily bounded in code against the registry's declared
    // ceiling, so a longer directive costs listed findings rather than breaching
    // the budget (mem#865: trim the text, never raise the annotation).
    expect(rendered.length).toBeLessThanOrEqual(700);
  });
});

describe("pre-cap disclosure (mt#3937)", () => {
  const finding = (ref: string): ScanFinding =>
    ({
      ref,
      reason: "no minsky:// link for this ref in this message",
      kind: "bare-short-id",
    }) as ScanFinding;

  it("stays out of the advisory when no cap is imminent", () => {
    const rendered = formatBareRefAdvisory([finding("ask#7415")]);

    expect(rendered).not.toContain("goes silent");
  });

  it("warns that the next continuation will be silent", () => {
    const rendered = formatBareRefAdvisory([finding("ask#7415")], { warnNextIsCapped: true });

    expect(rendered).toContain("goes silent");
    // It must say what to do about it, not merely announce the silence.
    expect(rendered).toContain("clear every ref now");
  });

  it("still names the findings and stays within the declared budget when warning", () => {
    // The render is greedily bounded against the registry ceiling, so the extra
    // line costs listed findings rather than breaching the budget. Posed with
    // BOTH axes saturated at once — a long finding list AND the notice present
    // (mem#865: a canary posed on one axis hides the real worst case).
    const many = Array.from({ length: 12 }, (_, i) => finding(`ask#${7000 + i}`));
    const rendered = formatBareRefAdvisory(many, { warnNextIsCapped: true });

    expect(rendered).toContain("ask#7000");
    expect(rendered).toContain("goes silent");
    expect(rendered.length).toBeLessThanOrEqual(700);
  });

  it("replays a three-turn chain: warn on turn two, silent on turn three", () => {
    // AT3. Walks the same state the guard walks: turn 1 ordinary, turns 2 and 3
    // consecutive continuations. `warnNextIsCapped` mirrors run()'s wiring —
    // this fire is a continuation AND was not itself capped.
    const log: PriorFireRecord[] = [];
    const emitted: boolean[] = [];
    const warned: boolean[] = [];

    for (let turn = 1; turn <= 3; turn += 1) {
      const isContinuation = turn > 1;
      const capped = isContinuation && advisoryIsChainCapped(log, "chain-session");
      emitted.push(!capped);
      warned.push(isContinuation && !capped);
      log.push({
        session_id: "chain-session",
        stop_hook_active: isContinuation,
        advisory_emitted: !capped,
      });
    }

    expect(emitted).toEqual([true, true, false]);
    // Turn 2 is the last one that renders, so it is the only place the notice
    // can reach the reader before turn 3's silence.
    expect(warned).toEqual([false, true, false]);
  });
});
