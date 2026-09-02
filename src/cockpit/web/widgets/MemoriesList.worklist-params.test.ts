/**
 * `buildListParams` — curation-worklist request shaping (mt#4767).
 *
 * The interesting assertions here are about what does NOT get sent. Two of the
 * rules fail silently if broken: a worklist whose param is omitted renders the
 * unfiltered table under a worklist heading, and the superseded worklist
 * renders an EMPTY table if the default `excludeSuperseded` survives. Both are
 * plausible-looking outputs with no error anywhere, which is why they are
 * pinned here rather than left to a render test to notice.
 */
import { describe, test, expect } from "bun:test";
import { buildListParams, DEFAULT_FILTERS } from "./MemoriesList";

/**
 * `Record<string, string>` rather than `Partial<typeof DEFAULT_FILTERS>`:
 * `MemoriesFilters` carries a `string` index signature, and a Partial makes
 * every value `string | undefined`, which the spread then fails to satisfy.
 */
function params(overrides: Record<string, string> = {}) {
  return buildListParams(
    {
      page: 1,
      pageSize: 50,
      sortKey: "created",
      sortDir: "desc",
      filters: { ...DEFAULT_FILTERS, ...overrides },
    },
    undefined
  );
}

describe("buildListParams — the untouched view is unchanged (mt#4767 regression floor)", () => {
  test("sends no curation params when no worklist is active", () => {
    const p = params();
    for (const key of ["untagged", "neverAccessed", "cold", "coldDays", "onlySuperseded"]) {
      expect(p[key]).toBeUndefined();
    }
  });

  test("still sends the pre-existing excludeSuperseded default", () => {
    expect(params().excludeSuperseded).toBe("true");
  });
});

describe("buildListParams — each worklist sends its own filter", () => {
  test("untagged", () => {
    expect(params({ untagged: "true" }).untagged).toBe("true");
  });

  test("neverAccessed", () => {
    expect(params({ neverAccessed: "true" }).neverAccessed).toBe("true");
  });

  test("cold", () => {
    expect(params({ cold: "true" }).cold).toBe("true");
  });

  test("onlySuperseded", () => {
    expect(params({ onlySuperseded: "true" }).onlySuperseded).toBe("true");
  });
});

describe("buildListParams — coldDays rides only with cold", () => {
  test("is sent when cold is active", () => {
    expect(params({ cold: "true", coldDays: "30" }).coldDays).toBe("30");
  });

  test("is NOT sent on its own", () => {
    // A threshold for a filter that isn't running is noise at best; at worst a
    // future reader takes its presence as evidence the filter is on.
    expect(params({ coldDays: "30" }).coldDays).toBeUndefined();
  });

  test("is omitted when empty, so the server applies its own default", () => {
    // The domain default (14) is derived from the measured read distribution.
    // Sending "" would either be rejected or coerced, and either way the
    // frontend would be deciding a threshold it has no basis for.
    expect(params({ cold: "true", coldDays: "" }).coldDays).toBeUndefined();
  });
});

describe("buildListParams — the superseded worklist must be able to see superseded rows", () => {
  test("onlySuperseded DELETES the default excludeSuperseded", () => {
    // DEFAULT_FILTERS.excludeSuperseded is "true", and the two filters are
    // contradictory: `superseded_by IS NOT NULL AND superseded_by IS NULL`
    // matches nothing. Leaving both on would make this worklist render an
    // empty table every single time — a plausible zero, not an error, on a
    // tile that just said there were 12.
    const p = params({ onlySuperseded: "true" });
    expect(p.onlySuperseded).toBe("true");
    expect(p.excludeSuperseded).toBeUndefined();
  });

  test("an explicit excludeSuperseded=false is also fine to drop", () => {
    const p = params({ onlySuperseded: "true", excludeSuperseded: "false" });
    expect(p.excludeSuperseded).toBeUndefined();
  });

  test("no OTHER worklist drops excludeSuperseded", () => {
    // The deletion is specific to the contradiction above. Dropping it more
    // widely would silently widen every other worklist to include superseded
    // records, inflating counts the tiles report as scoped.
    for (const key of ["untagged", "neverAccessed", "cold"] as const) {
      expect(params({ [key]: "true" }).excludeSuperseded).toBe("true");
    }
  });
});
