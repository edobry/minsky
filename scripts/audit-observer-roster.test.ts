/* eslint-disable custom/no-real-fs-in-tests -- the baseline block at the bottom of this
 * file exists to reconcile the SHIPPED roster against the SHIPPED catalog; a fixture would
 * assert nothing about the artifacts that actually drift. Same precedent and same reason as
 * `.minsky/hooks/hook-module-inventory.test.ts`. The unit tests above use fixtures. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

/**
 * A real roster label the map carries with an EMPTY guard list. Shared by the unit test for
 * that class and by the SC3 baseline, which must name the same label for the two to agree.
 */
const CONSUMER_ACCOUNT = "Consumer-account";

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
    // passes for exactly the case it exists to catch. Exercised against a FIXTURE map: the
    // shipped map has no undeclared empty mapping left, so the shipped map cannot reach it.
    const withEmptyMapped = `${ROSTER}- **${CONSUMER_ACCOUNT}** — an entry with no catalog peer.\n`;
    const result = reconcile(withEmptyMapped, [], {
      toGuards: { [CONSUMER_ACCOUNT]: [] },
      exempt: {},
      noCatalogPeer: {},
    });
    expect(result.labelsWithNoCatalogEntry).toContain(CONSUMER_ACCOUNT);
    expect(result.unmappedLabels).not.toContain(CONSUMER_ACCOUNT);
  });

  test("declaring a label peer-less suppresses the finding — and only when it really is", () => {
    const withEmptyMapped = `${ROSTER}- **${CONSUMER_ACCOUNT}** — an entry with no catalog peer.\n`;
    const declared = reconcile(withEmptyMapped, [], {
      toGuards: { [CONSUMER_ACCOUNT]: [] },
      exempt: {},
      noCatalogPeer: { [CONSUMER_ACCOUNT]: "rides another gate" },
    });
    expect(declared.labelsWithNoCatalogEntry).toEqual([]);
    expect(declared.contradictoryNoPeer).toEqual([]);

    // A declaration that contradicts the map — the label DOES have a peer — is a finding,
    // so the suppression cannot quietly outlive the reason for it.
    const contradictory = reconcile(withEmptyMapped, [entry("some-guard")], {
      toGuards: { [CONSUMER_ACCOUNT]: ["some-guard"] },
      exempt: {},
      noCatalogPeer: { [CONSUMER_ACCOUNT]: "stale claim" },
    });
    expect(contradictory.contradictoryNoPeer).toEqual([CONSUMER_ACCOUNT]);
  });

  test("a map label the roster no longer contains is reported", () => {
    // mt#4978 retired `stop-at-decision`; its roster entry outlived it by hours. This is
    // the class that catches a RETIREMENT, where nothing new is added and a row goes stale.
    const withoutWallOfText = ROSTER.replace(/^- \*\*Wall-of-text\*\*.*\n/m, "");
    expect(reconcile(withoutWallOfText, []).staleMapLabels).toContain("Wall-of-text");
    expect(reconcile(ROSTER, []).staleMapLabels).not.toContain("Wall-of-text");
  });

  test("a roster entry pointing at a BLOCKING interceptor is reported — it belongs in hook-files", () => {
    // `wall-of-text-detector` is mapped from the roster. Present it as a denier and the
    // roster is documenting a merge gate, which is the other rule's population.
    const result = reconcile(ROSTER, [entry("wall-of-text-detector", ["deny"])]);
    expect(result.blockingInRoster).toContain("Wall-of-text -> wall-of-text-detector");
    expect(result.missingFromRoster).toEqual([]);
  });
});

describe("parseRosterLabels frontmatter handling", () => {
  test("a horizontal rule in the body does not truncate the entry list", () => {
    const withRule = `---\nname: x\n---\n- **Alpha** — first.\n\n---\n\n- **Beta** — after a rule.\n`;
    expect(parseRosterLabels(withRule)).toEqual(["Alpha", "Beta"]);
  });

  test("a file with no frontmatter still yields its entries", () => {
    expect(parseRosterLabels("- **Alpha** — no frontmatter here.\n")).toEqual(["Alpha"]);
  });
});

/**
 * mt#4393 SC3 — the mechanical check that stops the two artifacts silently re-diverging.
 *
 * Every class must be EMPTY. There is no baseline and no allowance: an earlier revision
 * pinned the 20 + 2 known gaps so the check could ship without turning main red, but the
 * gaps are now closed — 14 new roster entries, four many-to-one map corrections, and one
 * exemption — so the honest assertion is the strict one. A check with a grandfathered set
 * is one nobody can gate on; this one exits 0 and is wired into CI.
 */
describe("SC3 — the shipped roster reconciles against the shipped catalog", () => {
  const REPO_ROOT = join(import.meta.dir, "..");
  const real = () =>
    reconcile(
      readFileSync(join(REPO_ROOT, ".minsky/rules/hook-observers.mdc"), "utf8"),
      (
        JSON.parse(
          readFileSync(join(REPO_ROOT, "src/generated/interceptor-catalog.json"), "utf8")
        ) as { entries: Parameters<typeof isNonBlocking>[0][] }
      ).entries
    );

  test("every non-blocking interceptor has a roster entry or a reasoned exemption", () => {
    expect(real().missingFromRoster).toEqual([]);
  });

  test("every roster label is mapped, and none is stale", () => {
    const r = real();
    expect(r.unmappedLabels).toEqual([]);
    expect(r.staleMapLabels).toEqual([]);
  });

  test("no map or exemption entry names a guardName the catalog lacks", () => {
    expect(real().unknownGuardNames).toEqual([]);
  });

  test("no roster entry documents a BLOCKING interceptor — that is hook-files' population", () => {
    expect(real().blockingInRoster).toEqual([]);
  });

  test("a roster entry with no catalog peer is declared, not merely absent", () => {
    const r = real();
    expect(r.labelsWithNoCatalogEntry).toEqual([]);
    // ...and a declaration that contradicts the map is itself a finding.
    expect(r.contradictoryNoPeer).toEqual([]);
  });
});
