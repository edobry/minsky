import { describe, test, expect } from "bun:test";
import {
  detectMigrationJournalViolations,
  extractMigrationNumber,
  isMigrationCollisionOverrideTruthy,
  MIGRATION_COLLISION_CHECK_OVERRIDE_ENV,
  VIOLATION_KIND,
} from "./migration-collision-detector";
import type { JournalEntry } from "./migration-journal-check";

const entry = (idx: number, tag: string, when: number): JournalEntry => ({ idx, tag, when });

describe("extractMigrationNumber", () => {
  test("parses the leading NNNN prefix", () => {
    expect(extractMigrationNumber("0061_redundant_blue_blade")).toBe("0061");
  });

  test("returns null when there is no leading digit run", () => {
    expect(extractMigrationNumber("meta")).toBeNull();
  });
});

describe("isMigrationCollisionOverrideTruthy", () => {
  test("true for 1/true/yes (case-insensitive)", () => {
    expect(isMigrationCollisionOverrideTruthy("1")).toBe(true);
    expect(isMigrationCollisionOverrideTruthy("TRUE")).toBe(true);
    expect(isMigrationCollisionOverrideTruthy("yes")).toBe(true);
  });

  test("false for unset/empty/other", () => {
    expect(isMigrationCollisionOverrideTruthy(undefined)).toBe(false);
    expect(isMigrationCollisionOverrideTruthy("")).toBe(false);
    expect(isMigrationCollisionOverrideTruthy("0")).toBe(false);
  });

  test("override env-var name is stable", () => {
    expect(MIGRATION_COLLISION_CHECK_OVERRIDE_ENV).toBe("MINSKY_SKIP_MIGRATION_COLLISION_CHECK");
  });
});

describe("detectMigrationJournalViolations", () => {
  test("clean: new entry with a unique number and a strictly-greater when", () => {
    const base = [entry(0, "0060_a", 100), entry(1, "0061_b", 200)];
    const head = [...base, entry(2, "0062_c", 300)];
    expect(detectMigrationJournalViolations(base, head)).toEqual([]);
  });

  test("when-mutation: an already-shipped tag's when changed (the 2026-07-19 case)", () => {
    const base = [entry(0, "0061_x", 100), entry(1, "0062_y", 200)];
    const head = [entry(0, "0061_x", 999), entry(1, "0062_y", 200)];
    const v = detectMigrationJournalViolations(base, head);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe(VIOLATION_KIND.whenMutation);
    expect(v[0]?.tag).toBe("0061_x");
    expect(v[0]?.detail).toContain("100");
    expect(v[0]?.detail).toContain("999");
  });

  test("number-collision: a new entry reuses a migration number already on origin/main", () => {
    const base = [entry(0, "0060_slow_kang", 100)];
    const head = [...base, entry(1, "0060_other_thing", 300)];
    const v = detectMigrationJournalViolations(base, head);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe(VIOLATION_KIND.numberCollision);
    expect(v[0]?.tag).toBe("0060_other_thing");
    expect(v[0]?.detail).toContain("0060_slow_kang");
  });

  test("non-monotonic: a new entry's when is <= the max on origin/main", () => {
    const base = [entry(0, "0060_a", 100), entry(1, "0061_b", 500)];
    const head = [...base, entry(2, "0062_c", 400)];
    const v = detectMigrationJournalViolations(base, head);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe(VIOLATION_KIND.nonMonotonic);
    expect(v[0]?.tag).toBe("0062_c");
  });

  test("empty base (no origin/main baseline) yields no violations", () => {
    const head = [entry(0, "0000_init", 100)];
    expect(detectMigrationJournalViolations([], head)).toEqual([]);
  });

  test("number-collision takes precedence over non-monotonic for the same entry", () => {
    const base = [entry(0, "0060_a", 500)];
    // Reuses number 0060 AND has when (300) <= maxBaseWhen (500).
    const head = [...base, entry(1, "0060_b", 300)];
    const v = detectMigrationJournalViolations(base, head);
    expect(v).toHaveLength(1);
    expect(v[0]?.kind).toBe(VIOLATION_KIND.numberCollision);
  });

  test("multiple independent violations are all reported", () => {
    const base = [entry(0, "0060_a", 100), entry(1, "0061_b", 200)];
    const head = [
      entry(0, "0060_a", 100),
      entry(1, "0061_b", 999), // when-mutation on shipped 0061_b
      entry(2, "0060_dup", 300), // number-collision on 0060
    ];
    const v = detectMigrationJournalViolations(base, head);
    expect(v).toHaveLength(2);
    expect(v.map((x) => x.kind).sort()).toEqual(
      [VIOLATION_KIND.numberCollision, VIOLATION_KIND.whenMutation].sort()
    );
  });
});
