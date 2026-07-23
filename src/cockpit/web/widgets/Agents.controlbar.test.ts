/**
 * Control-bar visibility under the mt#3118 activity bound.
 *
 * The bar carries the ONLY affordance for toggling the bound, so a render
 * condition that strands the operator in any state is a trap: they cannot
 * recover without editing the URL. Both empty-case directions are covered.
 *
 * Regression origin: PR #2235 review (non-blocking) — the first version
 * omitted the `includeInactive` disjunct, so turning the filter ON when
 * nothing existed to show made the bar (and the way back) disappear.
 */
import { describe, test, expect } from "bun:test";
import { shouldShowControlBar } from "./Agents";

describe("shouldShowControlBar — mt#3118 activity bound", () => {
  test("shows for the ordinary case: rows present", () => {
    expect(
      shouldShowControlBar({ totalCount: 12, hiddenInactiveCount: 0, includeInactive: false })
    ).toBe(true);
  });

  test("shows when the bound is hiding EVERY row, so the operator can get them back", () => {
    expect(
      shouldShowControlBar({ totalCount: 0, hiddenInactiveCount: 214, includeInactive: false })
    ).toBe(true);
  });

  test("shows when the filter is off and nothing exists, so the operator can turn it back on", () => {
    // includeInactive always reports 0 hidden by construction, so BOTH counts
    // are 0 here — the case the first implementation stranded.
    expect(
      shouldShowControlBar({ totalCount: 0, hiddenInactiveCount: 0, includeInactive: true })
    ).toBe(true);
  });

  test("hides only when there is genuinely nothing to control", () => {
    expect(
      shouldShowControlBar({ totalCount: 0, hiddenInactiveCount: 0, includeInactive: false })
    ).toBe(false);
  });

  test("no reachable state leaves the operator without the toggle", () => {
    // Exhaustive over the boolean shape of the three inputs: the only hidden
    // state is all-empty-and-filter-off, which has nothing to toggle.
    for (const totalCount of [0, 5]) {
      for (const hiddenInactiveCount of [0, 7]) {
        for (const includeInactive of [false, true]) {
          const shown = shouldShowControlBar({
            totalCount,
            hiddenInactiveCount,
            includeInactive,
          });
          const strandable = includeInactive && !shown;
          expect(strandable).toBe(false);
        }
      }
    }
  });
});
