/**
 * mt#4407 — tests for the dedup-residual classifier.
 *
 * The script's whole value is that a later pass reproduces THIS number rather than deriving a
 * different one from the same logs (AT1), so the classification rules are what need pinning: which
 * records are opportunities, which window pairs them, and what the falsifier concludes.
 *
 * Every bucket carries a DISCRIMINATING control. Without them a suite that only asserted the happy
 * path would pass just as well if a bucket had been deleted — and mis-bucketing is the exact failure
 * this task's history is made of (five causal hypotheses, four dead, several killed by a wrong
 * denominator rather than a wrong mechanism).
 *
 * No filesystem: the classifier takes an injected `PhraseLookup`, and the store's parsing rules are
 * exercised through the pure `parseStorePhrases`. The real store is mutable per-session state, so a
 * test that read it would pass or fail on whatever happened to be on disk.
 */
import { describe, expect, test } from "bun:test";

import {
  classify,
  pairStopFire,
  parseStorePhrases,
  phrasesOf,
  wroteOverlapKeys,
  type ParsedRecord,
  type PhraseLookup,
} from "./measure-deferral-dedup-residual";

const SESSION = "11111111-2222-3333-4444-555555555555";
const OTHER_SESSION = "99999999-8888-7777-6666-555555555555";
const T0 = Date.parse("2026-09-01T12:00:00.000Z");
const MINUTE = 60_000;

/** A lookup standing in for a store that flagged "say the word" in SESSION and nothing elsewhere. */
const lookup: PhraseLookup = (session) =>
  session === SESSION ? ["say the word", "offer-shape:unless"] : undefined;

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
  opts: { overlap?: boolean; reasons?: string[]; session?: string } = {}
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
      lookup
    );
    expect(result?.bucket).toBe("deduped");
  });

  test("suppressed-otherwise: an unrelated suppression is not a dedup outcome either way", () => {
    const [result] = classify(
      [ard(10, { reasons: ["cites-filed-ask"] })],
      indexBySession([stop(0)]),
      30 * MINUTE,
      lookup
    );
    expect(result?.bucket).toBe("suppressed-otherwise");
  });

  test("no-opportunity: an injected fire with no preceding key-writing Stop fire is NOT a miss", () => {
    const [result] = classify([ard(10)], new Map(), 30 * MINUTE, lookup);
    expect(result?.bucket).toBe("no-opportunity");
  });

  test("missed: injected, with a key-writing Stop fire inside the window", () => {
    const [result] = classify([ard(10)], indexBySession([stop(0)]), 30 * MINUTE, lookup);
    expect(result?.bucket).toBe("missed");
    expect(result?.pairedStopAt).toBe(new Date(T0).toISOString());
  });
});

describe("classify — the falsifier verdict on a miss", () => {
  const index = indexBySession([stop(0)]);

  test("key-present-phrase-matches: the flag IS in the store under a different key", () => {
    const [result] = classify([ard(10, { phrases: ["say the word"] })], index, 30 * MINUTE, lookup);
    expect(result?.falsifier).toBe("key-present-phrase-matches");
  });

  test("phrase-absent: the store was read and carries no matching phrase", () => {
    const [result] = classify(
      [ard(10, { phrases: ["offer-shape:or"] })],
      index,
      30 * MINUTE,
      lookup
    );
    expect(result?.falsifier).toBe("phrase-absent");
  });

  test("store-absent is NOT folded into phrase-absent — silence is not evidence", () => {
    // The store is live per-session state; an old session's file may simply be gone. Collapsing the
    // two would report a Stop-side write failure that was never observed.
    const missingStore = indexBySession([stop(0, { session: OTHER_SESSION })]);
    const [result] = classify(
      [ard(10, { session: OTHER_SESSION })],
      missingStore,
      30 * MINUTE,
      lookup
    );
    expect(result?.bucket).toBe("missed");
    expect(result?.falsifier).toBe("store-absent");
  });

  test("an EMPTY store is phrase-absent, not store-absent — read-and-empty is a real observation", () => {
    const emptyLookup: PhraseLookup = () => [];
    const [result] = classify([ard(10)], index, 30 * MINUTE, emptyLookup);
    expect(result?.falsifier).toBe("phrase-absent");
  });
});

describe("parseStorePhrases — reads only the overlap family", () => {
  const raw = JSON.stringify({
    flagged: [
      "someturnkey|stop-injected-overlap|say the word",
      "anotherkey|stop-injected-overlap|offer-shape:unless",
      // A different family in the same store must not be read as an overlap flag.
      "somekey|retro-admission|I was wrong",
      42, // a non-string entry must not throw
    ],
  });

  test("returns the overlap phrases and ignores other families", () => {
    const phrases = parseStorePhrases(raw);
    expect(phrases).toEqual(["say the word", "offer-shape:unless"]);
    expect(phrases).not.toContain("I was wrong");
  });

  test("a store with no flagged array yields none rather than throwing", () => {
    expect(parseStorePhrases(JSON.stringify({}))).toEqual([]);
  });

  test("a phrase containing the delimiter survives — the split takes the FIRST family marker", () => {
    const tricky = JSON.stringify({
      flagged: ["k|stop-injected-overlap|say the word|and then some"],
    });
    expect(parseStorePhrases(tricky)).toEqual(["say the word|and then some"]);
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
