import { describe, expect, test } from "bun:test";
import { isNonBlocking, parseRosterLabels, reconcile } from "./audit-observer-roster";

const ROSTER = `---
name: Hook Observers
alwaysApply: false
---
# Hook Observers

Preamble prose that is not an entry.

- **Wall-of-text** — turn-end report shape violation. \`MINSKY_SKIP_WALL_OF_TEXT\`.
- **Injection (per-turn)** — current-time/git-state. \`MINSKY_SKIP_*_INJECTION\`.
`;

const entry = (guardName: string, types: string[] = ["inject"]) => ({
  guardName,
  interventions: types.map((type) => ({ type })),
});

describe("parseRosterLabels", () => {
  test("reads the prose label of each entry and ignores preamble", () => {
    expect(parseRosterLabels(ROSTER)).toEqual(["Wall-of-text", "Injection (per-turn)"]);
  });
});

describe("isNonBlocking", () => {
  test("an interceptor that can deny is BLOCKING — it belongs to hook-files, not the roster", () => {
    expect(isNonBlocking(entry("some-gate", ["deny"]))).toBe(false);
    expect(isNonBlocking(entry("some-gate", ["inject", "deny"]))).toBe(false);
  });

  test("inject/record/mutate-only interceptors are non-blocking", () => {
    expect(isNonBlocking(entry("injector", ["inject"]))).toBe(true);
    expect(isNonBlocking(entry("recorder", ["record"]))).toBe(true);
    expect(isNonBlocking(entry("no-interventions"))).toBe(true);
  });
});

describe("reconcile", () => {
  // The map is the real one, so these assert against the shipped join rather than a fixture.
  test("a BLOCKING catalog entry absent from the roster is not reported — it is not the roster's population", () => {
    const result = reconcile(ROSTER, [entry("a-merge-gate", ["deny"])]);
    expect(result.missingFromRoster).toEqual([]);
    expect(result.nonBlockingCount).toBe(0);
  });

  test("AT2 — a NON-BLOCKING catalog entry with no roster entry and no exemption is reported", () => {
    const result = reconcile(ROSTER, [entry("brand-new-detector", ["record"])]);
    expect(result.missingFromRoster).toEqual(["brand-new-detector"]);
  });

  test("an exempted entry is not reported", () => {
    // `denier` is a dispatcher test fixture and carries an exemption reason.
    const result = reconcile(ROSTER, [entry("denier", ["deny"]), entry("denier2", ["inject"])]);
    expect(result.missingFromRoster).toEqual(["denier2"]);
  });

  test("a roster label the map does not carry is reported", () => {
    const withUnknown = `${ROSTER}- **Some Brand New Observer** — a new entry.\n`;
    expect(reconcile(withUnknown, []).unmappedLabels).toEqual(["Some Brand New Observer"]);
  });

  test("a map entry naming a guardName the catalog lacks is reported", () => {
    // The real map names ~70 real guards; against an EMPTY catalog every one is unknown.
    expect(reconcile(ROSTER, []).unknownGuardNames.length).toBeGreaterThan(0);
  });

  test("a label mapped to an EMPTY guard list is its own finding, not a silent pass", () => {
    // Without this class, mapping a label to [] satisfies unmappedLabels and the check
    // passes for exactly the case it exists to catch.
    // `Consumer-account` is a real roster entry the map carries with an empty guard list,
    // so it must appear in the rule text for the class to see it.
    const withEmptyMapped = `${ROSTER}- **Consumer-account** — a real entry with no catalog peer.\n`;
    const result = reconcile(withEmptyMapped, []);
    expect(result.labelsWithNoCatalogEntry).toContain("Consumer-account");
    expect(result.unmappedLabels).not.toContain("Consumer-account");
  });
});
