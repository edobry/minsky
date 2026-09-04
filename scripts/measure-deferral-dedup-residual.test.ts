/**
 * mt#4407 — tests for the dedup-residual classifier.
 *
 * The script's whole value is that a later pass reproduces THIS number rather than deriving a
 * different one from the same logs (AT1), so the classification rules are what need pinning: which
 * records are opportunities, which window pairs them, and what the falsifier concludes.
 *
 * Every bucket and every verdict carries a DISCRIMINATING control. Without them a suite that only
 * asserted the happy path would pass just as well if a branch had been deleted — and mis-bucketing
 * is the exact failure this task's history is made of (five causal hypotheses, four dead, several
 * killed by a wrong denominator rather than a wrong mechanism).
 *
 * No filesystem: the classifier takes an injected `FlagLookup`, and the key reconstruction is
 * exercised through the pure `reconstructOverlapKey`. The real store is mutable per-session state,
 * so a test that read it would pass or fail on whatever happened to be on disk.
 */
import { describe, expect, test } from "bun:test";

import { overlapTurnKey } from "../.minsky/hooks/turn-end-scan-store";
import { turnKeyForMessage } from "../.minsky/hooks/turn-end-untaken-action-scan";
import {
  classify,
  corpusIsEmpty,
  pairStopFire,
  phrasesOf,
  reconstructOverlapKey,
  resolveWindowMs,
  wroteOverlapKeys,
  type FlagLookup,
  type ParsedRecord,
} from "./measure-deferral-dedup-residual";

const SESSION = "11111111-2222-3333-4444-555555555555";
const OTHER_SESSION = "99999999-8888-7777-6666-555555555555";
const T0 = Date.parse("2026-09-01T12:00:00.000Z");
const MINUTE = 60_000;

/** A tail long enough to reconstruct a key from (the hash window is 400 normalized chars). */
const LONG_TAIL = `${"the agent said something at length. ".repeat(20)}Say the word and I'll do it.`;
/** The key that tail's Stop fire would have written. */
const LONG_TAIL_KEY = overlapTurnKey(LONG_TAIL, turnKeyForMessage);

/** Build an `ask-routing-deferral`-shaped record. */
function ard(
  offsetMinutes: number,
  opts: { phrases?: string[]; reasons?: string[]; session?: string } = {}
): ParsedRecord {
  const at = T0 + offsetMinutes * MINUTE;
  const session = opts.session ?? SESSION;
  return {
    at,
    session,
    timestamp: new Date(at).toISOString(),
    session_id: session,
    matches: (opts.phrases ?? ["say the word"]).map((phrase) => ({
      class: "deferral-menu",
      phrase,
    })),
    suppressionReasons: opts.reasons ?? [],
  };
}

/** Build an `untaken-action`-shaped record. */
function stop(
  offsetMinutes: number,
  opts: { overlap?: boolean; reasons?: string[]; session?: string; tail?: string } = {}
): ParsedRecord {
  const at = T0 + offsetMinutes * MINUTE;
  const session = opts.session ?? SESSION;
  return {
    at,
    session,
    timestamp: new Date(at).toISOString(),
    session_id: session,
    deferralOverlap: opts.overlap ?? true,
    suppressionReasons: opts.reasons ?? [],
    final_message_tail: opts.tail ?? LONG_TAIL,
  };
}

function indexBySession(records: ParsedRecord[]): Map<string, ParsedRecord[]> {
  const m = new Map<string, ParsedRecord[]>();
  for (const r of records.filter(wroteOverlapKeys)) {
    const list = m.get(r.session) ?? [];
    list.push(r);
    m.set(r.session, list);
  }
  return m;
}

/** A lookup whose store holds exactly the given flags for SESSION and nothing for anyone else. */
function lookupWith(flags: Array<{ key: string; phrase: string }>): FlagLookup {
  return (session) => (session === SESSION ? flags : []);
}

const EXACT_LOOKUP = lookupWith([{ key: LONG_TAIL_KEY, phrase: "say the word" }]);

describe("wroteOverlapKeys — only the injecting path writes keys", () => {
  test("an injected overlap record wrote keys", () => {
    expect(wroteOverlapKeys(stop(0))).toBe(true);
  });

  test("a SUPPRESSED overlap record did not — the Stop guard said nothing, so the sibling should", () => {
    expect(wroteOverlapKeys(stop(0, { reasons: ["armed-watcher-evidence"] }))).toBe(false);
  });

  test("a record with no deferral overlap did not", () => {
    expect(wroteOverlapKeys(stop(0, { overlap: false }))).toBe(false);
  });
});

describe("pairStopFire — the window and the session both bound the pairing", () => {
  const index = indexBySession([stop(0), stop(20)]);

  test("picks the LATEST qualifying preceding fire, not the first", () => {
    expect(pairStopFire(ard(25), index, 30 * MINUTE)?.timestamp).toBe(
      new Date(T0 + 20 * MINUTE).toISOString()
    );
  });

  test("a fire outside the window does not pair", () => {
    expect(pairStopFire(ard(25), index, 2 * MINUTE)).toBeUndefined();
  });

  test("a fire AFTER the sibling never pairs — the Stop event precedes the prompt", () => {
    expect(pairStopFire(ard(-5), index, 30 * MINUTE)).toBeUndefined();
  });

  test("a fire in a DIFFERENT session never pairs — the store is per-session", () => {
    const crossSession = indexBySession([stop(0, { session: OTHER_SESSION })]);
    expect(pairStopFire(ard(5), crossSession, 30 * MINUTE)).toBeUndefined();
  });
});

describe("classify — the four buckets, each with its discriminating control", () => {
  test("deduped: the suppression reason is read directly, independent of any pairing", () => {
    // Deliberately NO stop fire in the index. `deduped` must not depend on the window, which is
    // what makes it the one figure stable across every sensitivity run.
    const [result] = classify(
      [ard(10, { reasons: ["deduped-by-untaken-action-stop"] })],
      new Map(),
      30 * MINUTE,
      EXACT_LOOKUP
    );
    expect(result?.bucket).toBe("deduped");
  });

  test("suppressed-otherwise: an unrelated suppression is not a dedup outcome either way", () => {
    const [result] = classify(
      [ard(10, { reasons: ["cites-filed-ask"] })],
      indexBySession([stop(0)]),
      30 * MINUTE,
      EXACT_LOOKUP
    );
    expect(result?.bucket).toBe("suppressed-otherwise");
  });

  test("no-opportunity: an injected fire with no preceding key-writing Stop fire is NOT a miss", () => {
    const [result] = classify([ard(10)], new Map(), 30 * MINUTE, EXACT_LOOKUP);
    expect(result?.bucket).toBe("no-opportunity");
  });

  test("missed: injected, with a key-writing Stop fire inside the window", () => {
    const [result] = classify([ard(10)], indexBySession([stop(0)]), 30 * MINUTE, EXACT_LOOKUP);
    expect(result?.bucket).toBe("missed");
    expect(result?.pairedStopAt).toBe(new Date(T0).toISOString());
  });
});

describe("classify — the falsifier is bounded to the PAIRED TURN (PR #3639 R1 BLOCKING)", () => {
  const index = indexBySession([stop(0)]);

  test("key-present-exact: the flag sits under THIS turn's reconstructed key", () => {
    const [result] = classify([ard(10)], index, 30 * MINUTE, EXACT_LOOKUP);
    expect(result?.falsifier).toBe("key-present-exact");
    expect(result?.reconstructedKey).toBe(LONG_TAIL_KEY);
  });

  test("phrase-present-other-key: the same phrase under a DIFFERENT key is NOT the answer", () => {
    // This is the case the first revision counted as affirmative. A stock phrase like
    // "say the word" recurs across a session's turns, so a session-wide phrase match inflates the
    // yes — which is precisely the BLOCKING finding this separation answers.
    const [result] = classify(
      [ard(10)],
      index,
      30 * MINUTE,
      lookupWith([{ key: "a-different-turns-key", phrase: "say the word" }])
    );
    expect(result?.falsifier).toBe("phrase-present-other-key");
  });

  test("phrase-absent: the store has overlap flags for this session, none matching", () => {
    const [result] = classify(
      [ard(10, { phrases: ["offer-shape:or"] })],
      index,
      30 * MINUTE,
      EXACT_LOOKUP
    );
    expect(result?.falsifier).toBe("phrase-absent");
  });

  test("store-empty-or-absent is NOT folded into phrase-absent — silence is not evidence", () => {
    const [result] = classify([ard(10)], index, 30 * MINUTE, lookupWith([]));
    expect(result?.bucket).toBe("missed");
    expect(result?.falsifier).toBe("store-empty-or-absent");
  });

  test("tail-too-short: an unreconstructable key is reported, never guessed", () => {
    const shortIndex = indexBySession([stop(0, { tail: "too short to fill the hash window" })]);
    const [result] = classify([ard(10)], shortIndex, 30 * MINUTE, EXACT_LOOKUP);
    expect(result?.falsifier).toBe("tail-too-short");
    expect(result?.reconstructedKey).toBeUndefined();
  });

  test("a Stop record with no tail at all is tail-too-short, not a crash", () => {
    const noTail = indexBySession([{ ...stop(0), final_message_tail: undefined }]);
    const [result] = classify([ard(10)], noTail, 30 * MINUTE, EXACT_LOOKUP);
    expect(result?.falsifier).toBe("tail-too-short");
  });
});

describe("reconstructOverlapKey — reproduces the key the Stop fire wrote", () => {
  test("a long-enough tail reproduces overlapTurnKey exactly", () => {
    // The store key is overlapTurnKey(fullMessage), and the tail is the message's last 600 chars.
    // Both slice the last 400 NORMALIZED chars, so the two agree whenever the tail still carries
    // that many — which is what makes the exact match above meaningful rather than coincidental.
    const fullMessage = `a much longer preamble that the tail cannot see. ${LONG_TAIL}`;
    expect(reconstructOverlapKey({ final_message_tail: LONG_TAIL })).toBe(
      overlapTurnKey(fullMessage, turnKeyForMessage)
    );
  });

  test("a tail whose NORMALIZED length is under the window yields undefined", () => {
    // Whitespace collapse can take a long raw tail under the threshold, so the check normalizes
    // before measuring rather than reading the raw length.
    const whitespacey = " ".repeat(2000);
    expect(reconstructOverlapKey({ final_message_tail: whitespacey })).toBeUndefined();
  });
});

describe("corpusIsEmpty — BOTH logs are required (PR #3639 R1 BLOCKING)", () => {
  test("zero Stop-side records is empty even with sibling records present", () => {
    // The case the first revision missed: --since could filter every Stop record away and the run
    // would report a full result in which every fire was `no-opportunity` — indistinguishable from
    // a corpus where the dedup genuinely had nothing to do.
    expect(corpusIsEmpty(56, 0)).toBe(true);
  });

  test("zero sibling records is empty", () => {
    expect(corpusIsEmpty(0, 206)).toBe(true);
  });

  test("both populated is not empty — the discriminating control", () => {
    expect(corpusIsEmpty(56, 206)).toBe(false);
  });
});

describe("resolveWindowMs — absent, valid and unusable are three answers", () => {
  test("absent yields undefined so the caller can apply its default", () => {
    expect(resolveWindowMs(undefined)).toBeUndefined();
  });

  test("minutes convert to ms", () => {
    expect(resolveWindowMs("30")).toBe(30 * MINUTE);
  });

  test("unparseable is null, NOT silently defaulted", () => {
    expect(resolveWindowMs("soon")).toBeNull();
  });

  test("zero and negative are null — a non-positive window silently yields zero misses", () => {
    expect(resolveWindowMs("0")).toBeNull();
    expect(resolveWindowMs("-5")).toBeNull();
  });
});

describe("phrasesOf — deduplicates without losing order", () => {
  test("repeated phrases collapse", () => {
    expect(phrasesOf({ matches: [{ phrase: "a" }, { phrase: "b" }, { phrase: "a" }] })).toEqual([
      "a",
      "b",
    ]);
  });

  test("a record with no matches yields none rather than throwing", () => {
    expect(phrasesOf({})).toEqual([]);
  });
});
