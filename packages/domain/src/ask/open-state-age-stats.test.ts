/**
 * Tests for `openStateAgeStats` — the age dimension mt#4361 adds to the ask
 * state-counts signal.
 *
 * Why this exists: `countByState` reports how MANY asks are in each state and
 * is silent on how long they have been there. `routed: 5` is byte-identical
 * five minutes and five weeks after those asks routed — and `routed` is the one
 * state where persistence IS the defect, because ADR-008 defines it as
 * transient ("target selected; transport dispatch pending") while no transport
 * exists for subagent / mesh / retriever. Five asks sat there 9–16 days and
 * were found by a manual probe (mt#3353), with the count-by-state signal
 * available the whole time.
 *
 * These run against `FakeAskRepository`. Its `openStateAgeStats` and the Drizzle
 * one implement the same semantics twice — see the `stateEntryIso` docblock in
 * `repository.ts`, which is the invariant these tests pin on the fake side.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { FakeAskRepository, emptyOpenStateAgeStats } from "./repository";
import { OPEN_ASK_STATES, TERMINAL_ASK_STATES } from "./state-machine";
import type { Ask, AskState } from "./types";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Fixed clock, so nothing here depends on wall time. */
const NOW_MS = Date.parse("2026-08-22T00:00:00.000Z");

/** The 5-day stall threshold `getAskStateCounts` passes in production. */
const THRESHOLD_MS = 5 * DAY_MS;

let seq = 0;

/**
 * A minimal Ask at a given state, with its state-entry stamp set `ageMs` before
 * {@link NOW_MS}.
 *
 * The stamp goes on the column the state actually reads — `routedAt` for
 * `routed`, `suspendedAt` for `suspended` — and `createdAt` is deliberately set
 * much older, so a test that accidentally measures from creation instead of
 * from state entry produces a visibly wrong number rather than a coincidentally
 * right one.
 */
function askAged(state: AskState, ageMs: number): Ask {
  const entryIso = new Date(NOW_MS - ageMs).toISOString();
  const createdIso = new Date(NOW_MS - ageMs - 30 * DAY_MS).toISOString();
  return {
    id: `fake-ask-${++seq}`,
    shortId: `ask#${seq}`,
    kind: "capability.escalate",
    classifierVersion: "v1.0.0",
    state,
    requestor: "test",
    title: `aged ${ageMs}ms in ${state}`,
    question: "?",
    createdAt: state === "detected" || state === "classified" ? entryIso : createdIso,
    routedAt: state === "routed" ? entryIso : undefined,
    suspendedAt: state === "suspended" ? entryIso : undefined,
    respondedAt: state === "responded" ? entryIso : undefined,
    windowMissedCount: 0,
    forceImmediate: false,
    metadata: {},
  } as Ask;
}

describe("openStateAgeStats (mt#4361)", () => {
  let repo: FakeAskRepository;

  beforeEach(() => {
    repo = new FakeAskRepository();
    seq = 0;
  });

  test("AT1: reports the oldest dwell time and the past-threshold count per state", async () => {
    repo.seed(askAged("routed", HOUR_MS));
    repo.seed(askAged("routed", 4 * DAY_MS));
    repo.seed(askAged("routed", 9 * DAY_MS));

    const stats = await repo.openStateAgeStats({
      nowMs: NOW_MS,
      stallThresholdMs: THRESHOLD_MS,
    });

    expect(stats.routed.oldestAgeMs).toBe(9 * DAY_MS);
    expect(stats.routed.stalledCount).toBe(1);
  });

  test("AT1 negative control: with only a fresh ask, nothing is stalled", async () => {
    repo.seed(askAged("routed", HOUR_MS));

    const stats = await repo.openStateAgeStats({
      nowMs: NOW_MS,
      stallThresholdMs: THRESHOLD_MS,
    });

    expect(stats.routed.oldestAgeMs).toBe(HOUR_MS);
    expect(stats.routed.stalledCount).toBe(0);
  });

  test("AT2: computing the signal transitions nothing — this reports, it does not sweep", async () => {
    // The fixture mt#4361's decision turns on: an ask well past the threshold
    // whose parent task is terminal. A sweep keyed on parent-terminal would
    // close it (the mt#3353 counter-example); this mechanism must not.
    const stranded = askAged("routed", 30 * DAY_MS);
    stranded.parentTaskId = "mt#9999";
    repo.seed(stranded);

    await repo.openStateAgeStats({ nowMs: NOW_MS, stallThresholdMs: THRESHOLD_MS });

    const after = await repo.getById(stranded.id);
    expect(after?.state).toBe("routed");
    expect(after?.closedAt).toBeUndefined();
    expect(after?.response).toBeUndefined();
    expect(after?.metadata?.cancellation).toBeUndefined();
  });

  test("AT4: `classified` is covered by the same fields, with no separate mechanism", async () => {
    repo.seed(askAged("classified", 8 * DAY_MS));

    const stats = await repo.openStateAgeStats({
      nowMs: NOW_MS,
      stallThresholdMs: THRESHOLD_MS,
    });

    expect(stats.classified.oldestAgeMs).toBe(8 * DAY_MS);
    expect(stats.classified.stalledCount).toBe(1);
  });

  test("an empty state reports null, not zero — no ask is not a zero-age ask", async () => {
    const stats = await repo.openStateAgeStats({
      nowMs: NOW_MS,
      stallThresholdMs: THRESHOLD_MS,
    });

    expect(stats).toEqual(emptyOpenStateAgeStats());
    expect(stats.routed.oldestAgeMs).toBeNull();
    // The discriminator: a genuinely zero-age ask reports 0, which must not
    // look like an empty state.
    repo.seed(askAged("routed", 0));
    const withFresh = await repo.openStateAgeStats({
      nowMs: NOW_MS,
      stallThresholdMs: THRESHOLD_MS,
    });
    expect(withFresh.routed.oldestAgeMs).toBe(0);
  });

  test("age is measured from state entry, not from creation", async () => {
    // askAged backdates createdAt by a further 30 days for non-`detected`
    // states, so a from-creation implementation would report 32 days here.
    repo.seed(askAged("suspended", 2 * DAY_MS));

    const stats = await repo.openStateAgeStats({
      nowMs: NOW_MS,
      stallThresholdMs: THRESHOLD_MS,
    });

    expect(stats.suspended.oldestAgeMs).toBe(2 * DAY_MS);
    expect(stats.suspended.stalledCount).toBe(0);
  });

  test("terminal states are absent from the result, not zero-filled", async () => {
    repo.seed(askAged("routed", DAY_MS));

    const stats = await repo.openStateAgeStats({
      nowMs: NOW_MS,
      stallThresholdMs: THRESHOLD_MS,
    });

    for (const state of OPEN_ASK_STATES) {
      expect(Object.hasOwn(stats, state)).toBe(true);
    }
    for (const state of TERMINAL_ASK_STATES) {
      // Not `toBeUndefined()`: that also passes for a key present with an
      // undefined value, which is the shape this assertion is about.
      expect(Object.hasOwn(stats, state)).toBe(false);
    }
  });
});
