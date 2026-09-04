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
    // passes for exactly the case it exists to catch.
    // `Consumer-account` is a real roster entry the map carries with an empty guard list,
    // so it must appear in the rule text for the class to see it.
    const withEmptyMapped = `${ROSTER}- **${CONSUMER_ACCOUNT}** — a real entry with no catalog peer.\n`;
    const result = reconcile(withEmptyMapped, []);
    expect(result.labelsWithNoCatalogEntry).toContain(CONSUMER_ACCOUNT);
    expect(result.unmappedLabels).not.toContain(CONSUMER_ACCOUNT);
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
 * The four INTEGRITY classes must be empty at all times: each is a defect in the join
 * itself and is fixable in the same edit that causes it. The two COVERAGE classes carry a
 * pinned baseline, because closing them is a per-entry judgment tracked at mt#4991 — but
 * the baseline is a ceiling, not an allowance: a NEW gap fails, and a gap that has been
 * closed must be removed from the baseline, so it can only shrink.
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

  /** Known coverage gaps as of 2026-09-04. Owned by mt#4991; remove as they are closed. */
  const BASELINE_MISSING_FROM_ROSTER = [
    "auto-session-title",
    "bridge-memory-retirement",
    "cross-turn-hedge-detector",
    "deploy-verification-after-merge",
    "inject-success-criteria",
    "mcp-daemon-staleness-detector",
    "memory-search",
    "operator-deferral-artifact-surface-pr",
    "operator-deferral-artifact-surface-spec",
    "operator-deferral-ask-surface",
    "post-merge-unasked-direction-scan",
    "pre-narration-detector",
    "record-agent-dispatch",
    "record-conversation-run-state",
    "record-turn-anchor",
    "standalone-duplicate-matcher",
    "turn-end-retro-scan",
    "two-strikes-record",
    "typecheck-on-edit",
    "warn-main-workspace-mutation",
  ];
  const BASELINE_NO_CATALOG_ENTRY = [CONSUMER_ACCOUNT, "SubagentStop recording"];

  test("the four join-integrity classes are empty", () => {
    const r = real();
    expect(r.unmappedLabels).toEqual([]);
    expect(r.staleMapLabels).toEqual([]);
    expect(r.unknownGuardNames).toEqual([]);
    expect(r.blockingInRoster).toEqual([]);
  });

  test("no NEW interceptor has appeared without a roster entry or an exemption", () => {
    const added = real().missingFromRoster.filter((g) => !BASELINE_MISSING_FROM_ROSTER.includes(g));
    expect(added).toEqual([]);
  });

  test("no NEW roster entry documents something the catalog does not enumerate", () => {
    const added = real().labelsWithNoCatalogEntry.filter(
      (l) => !BASELINE_NO_CATALOG_ENTRY.includes(l)
    );
    expect(added).toEqual([]);
  });

  test("the baseline has no entry that is already closed — it may only shrink", () => {
    const r = real();
    expect(BASELINE_MISSING_FROM_ROSTER.filter((g) => !r.missingFromRoster.includes(g))).toEqual(
      []
    );
    expect(
      BASELINE_NO_CATALOG_ENTRY.filter((l) => !r.labelsWithNoCatalogEntry.includes(l))
    ).toEqual([]);
  });
});
