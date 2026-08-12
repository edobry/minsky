// Tests for the fire-log known-guard-name oracle — mt#3756.
//
// These cover the pure resolution/classification logic, which is the half that
// can be checked in CI. The live-log audit itself (`scripts/audit-fire-log.ts`)
// runs against operator-local state that does not exist in CI, so its
// end-to-end behavior is exercised by the acceptance tests in the task spec
// rather than here.

import { describe, expect, test } from "bun:test";
import {
  FIXTURE_GUARD_NAMES,
  PRECOMMIT_STEP_NAMES,
  RETIRED_GUARD_NAMES,
  STANDALONE_GUARD_NAMES,
  findUnknownGuardNames,
  hasActionableUnknowns,
  resolveKnownGuardNames,
  type GuardNameBearingEntry,
} from "./known-guard-names";

function entry(guardName: string, timestamp: string): GuardNameBearingEntry {
  return { guardName, timestamp };
}

describe("resolveKnownGuardNames", () => {
  test("merges registry, pre-commit, and standalone names", () => {
    const known = resolveKnownGuardNames({ registryNames: ["check-guessed-session-path"] });

    expect(known.has("check-guessed-session-path")).toBe(true);
    expect(known.has("eslint-validation")).toBe(true);
    expect(known.has("require-review-before-merge")).toBe(true);
  });

  test("prefers a caller-supplied pre-commit set over the hand-maintained snapshot", () => {
    const known = resolveKnownGuardNames({
      registryNames: [],
      precommitNames: ["freshly-derived-step"],
    });

    expect(known.has("freshly-derived-step")).toBe(true);
    // The snapshot must NOT be unioned in when a derived set was supplied —
    // otherwise a step deleted from pre-commit.ts would stay "known" forever.
    expect(known.has("eslint-validation")).toBe(false);
  });

  test("excludes retired and fixture names, so they are classified rather than silently accepted", () => {
    const known = resolveKnownGuardNames({ registryNames: [] });

    expect(known.has("unit-tests")).toBe(false);
    expect(known.has("denier")).toBe(false);
  });
});

describe("findUnknownGuardNames", () => {
  test("returns nothing when every name resolves", () => {
    const known = resolveKnownGuardNames({ registryNames: ["policy-coverage"] });
    const unknowns = findUnknownGuardNames(
      [entry("policy-coverage", "2026-08-01T00:00:00.000Z")],
      known
    );

    expect(unknowns).toEqual([]);
  });

  test("aggregates count and time span for an unresolved name", () => {
    const known = new Set<string>();
    const unknowns = findUnknownGuardNames(
      [
        entry("zzz-not-a-guard", "2026-08-03T10:00:00.000Z"),
        entry("zzz-not-a-guard", "2026-08-01T10:00:00.000Z"),
        entry("zzz-not-a-guard", "2026-08-02T10:00:00.000Z"),
      ],
      known
    );

    expect(unknowns).toHaveLength(1);
    expect(unknowns[0]).toMatchObject({
      guardName: "zzz-not-a-guard",
      count: 3,
      firstSeen: "2026-08-01T10:00:00.000Z",
      lastSeen: "2026-08-03T10:00:00.000Z",
    });
  });

  test("sorts by descending count so the biggest anomaly reads first", () => {
    const unknowns = findUnknownGuardNames(
      [
        entry("rare", "2026-08-01T00:00:00.000Z"),
        entry("common", "2026-08-01T00:00:00.000Z"),
        entry("common", "2026-08-01T00:00:01.000Z"),
      ],
      new Set()
    );

    expect(unknowns.map((u) => u.guardName)).toEqual(["common", "rare"]);
  });

  test("flags a declared fixture name as a known incident, not a fresh unknown", () => {
    const unknowns = findUnknownGuardNames(
      [entry("denier", "2026-08-03T22:44:09.305Z")],
      resolveKnownGuardNames({ registryNames: [] })
    );

    expect(unknowns[0]).toMatchObject({ knownFixture: true, retiredButRecent: false });
  });

  test("does not flag a retired name firing inside its recorded window", () => {
    // `unit-tests` is recorded as last seen 2026-07-20. A record from that same
    // day is history, not a resumption — this is the date-prefix comparison the
    // implementation calls out, and a naive string compare gets it wrong
    // because a full ISO instant sorts after a bare date.
    const unknowns = findUnknownGuardNames(
      [entry("unit-tests", "2026-07-20T23:59:59.000Z")],
      resolveKnownGuardNames({ registryNames: [] })
    );

    expect(unknowns[0]).toMatchObject({ retiredButRecent: false });
  });

  test("flags a retired name that resumed firing after its recorded window", () => {
    const unknowns = findUnknownGuardNames(
      [entry("unit-tests", "2026-08-04T00:00:00.000Z")],
      resolveKnownGuardNames({ registryNames: [] })
    );

    expect(unknowns[0]).toMatchObject({ retiredButRecent: true });
  });
});

describe("hasActionableUnknowns", () => {
  test("a genuinely unrecognized name is actionable", () => {
    const unknowns = findUnknownGuardNames(
      [entry("zzz-not-a-guard", "2026-08-05T00:00:00.000Z")],
      new Set()
    );

    expect(hasActionableUnknowns(unknowns)).toBe(true);
  });

  test("declared fixture names alone are not actionable", () => {
    const known = resolveKnownGuardNames({ registryNames: [] });
    const unknowns = findUnknownGuardNames(
      [...FIXTURE_GUARD_NAMES.keys()].map((n) => entry(n, "2026-08-03T21:00:00.000Z")),
      known
    );

    expect(unknowns).toHaveLength(FIXTURE_GUARD_NAMES.size);
    expect(hasActionableUnknowns(unknowns)).toBe(false);
  });

  test("a retired name inside its window is not actionable", () => {
    const known = resolveKnownGuardNames({ registryNames: [] });
    const unknowns = findUnknownGuardNames(
      [entry("unit-tests", "2026-07-19T00:00:00.000Z")],
      known
    );

    expect(hasActionableUnknowns(unknowns)).toBe(false);
  });

  test("a retired name that resumed IS actionable", () => {
    const known = resolveKnownGuardNames({ registryNames: [] });
    const unknowns = findUnknownGuardNames(
      [entry("unit-tests", "2026-08-04T00:00:00.000Z")],
      known
    );

    expect(hasActionableUnknowns(unknowns)).toBe(true);
  });
});

describe("snapshot integrity", () => {
  test("no name appears in more than one classification", () => {
    const buckets: Array<[string, readonly string[]]> = [
      ["precommit", PRECOMMIT_STEP_NAMES],
      ["standalone", STANDALONE_GUARD_NAMES],
      ["retired", [...RETIRED_GUARD_NAMES.keys()]],
      ["fixture", [...FIXTURE_GUARD_NAMES.keys()]],
    ];

    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const [bucket, names] of buckets) {
      for (const name of names) {
        const prior = seen.get(name);
        if (prior) collisions.push(`${name} in both ${prior} and ${bucket}`);
        else seen.set(name, bucket);
      }
    }

    expect(collisions).toEqual([]);
  });

  test("each snapshot list is sorted, so a hand edit lands where a reader expects", () => {
    expect([...PRECOMMIT_STEP_NAMES]).toEqual([...PRECOMMIT_STEP_NAMES].sort());
    expect([...STANDALONE_GUARD_NAMES]).toEqual([...STANDALONE_GUARD_NAMES].sort());
  });
});
