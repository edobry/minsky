/**
 * Worklist URL round-trip tests (mt#4767).
 *
 * The navigate side and the "am I active" side are two functions reading one
 * mapping. If they disagree, a worklist either never highlights or — worse —
 * highlights while the table shows something else, which is a wrong answer
 * that looks like a right one. These assert they agree, and pin the two
 * mappings that are easy to get subtly wrong.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  applyWorklist,
  isWorklistActive,
  activeWorklist,
  readMemFilter,
  readView,
  type WorklistId,
} from "./memories-url";

/** The one filter key that interacts with a worklist rather than being one. */
const EXCLUDE_SUPERSEDED = "excludeSuperseded";

/** The worklists that render THROUGH `MemoriesList` — i.e. as a table filter. */
const FILTER_WORKLISTS: WorklistId[] = ["untagged", "neverRead", "cold", "superseded"];

/** Every worklist, including `duplicates`, which swaps the page view instead. */
const ALL_WORKLISTS: WorklistId[] = [...FILTER_WORKLISTS, "duplicates"];

function setUrl(url: string) {
  (window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(url);
}

beforeEach(() => {
  setUrl("http://localhost/memories");
});

describe("applyWorklist / isWorklistActive round-trip", () => {
  test.each(ALL_WORKLISTS)("%s is active immediately after applying it", (id) => {
    applyWorklist(id);
    expect(isWorklistActive(window.location.search, id)).toBe(true);
  });

  test.each(ALL_WORKLISTS)("%s is the ONLY active worklist after applying it", (id) => {
    applyWorklist(id);
    const others = ALL_WORKLISTS.filter((o) => o !== id);
    for (const other of others) {
      expect(isWorklistActive(window.location.search, other)).toBe(false);
    }
    expect(activeWorklist(window.location.search)).toBe(id);
  });

  test("no worklist is active on a bare /memories", () => {
    expect(activeWorklist(window.location.search)).toBeNull();
  });
});

describe("the never-read mapping", () => {
  test("neverRead writes `neverAccessed`, NEVER `stale`", () => {
    // This is the whole reason mt#4767 added a domain filter instead of
    // reusing the existing one. `stale` is `last_accessed_at IS NULL OR older
    // than N` — a union that also matches read-but-old records. Pointing this
    // worklist at it would silently merge two populations the page presents
    // as separate; measured 2026-08-31 they differ by exactly one row at the
    // 90-day default, so the bug would be invisible in the counts too.
    applyWorklist("neverRead");
    expect(readMemFilter(window.location.search, "neverAccessed")).toBe("true");
    expect(readMemFilter(window.location.search, "stale")).toBe("");
  });

  test("cold writes `cold`, NEVER `stale`", () => {
    applyWorklist("cold");
    expect(readMemFilter(window.location.search, "cold")).toBe("true");
    expect(readMemFilter(window.location.search, "stale")).toBe("");
  });

  test("cold carries its threshold so the label and the filter agree", () => {
    applyWorklist("cold", 30);
    expect(readMemFilter(window.location.search, "coldDays")).toBe("30");
  });
});

describe("the superseded worklist and excludeSuperseded agree", () => {
  test("applying it sets excludeSuperseded=false", () => {
    // The toolbar checkbox renders from URL state, not from the request. Drop
    // this and the page shows "Hide superseded" TICKED above a table of
    // nothing but superseded records — the control contradicting the content.
    applyWorklist("superseded");
    expect(readMemFilter(window.location.search, EXCLUDE_SUPERSEDED)).toBe("false");
  });

  test("switching away from it restores the default", () => {
    // Left behind, the "false" would silently widen the NEXT worklist to
    // include superseded records, so its table would disagree with the tile
    // count that was just clicked.
    applyWorklist("superseded");
    applyWorklist("untagged");
    expect(readMemFilter(window.location.search, EXCLUDE_SUPERSEDED)).toBe("");
  });

  test("no other worklist touches it", () => {
    for (const id of ["untagged", "neverRead", "cold"] as const) {
      setUrl("http://localhost/memories");
      applyWorklist(id);
      expect(readMemFilter(window.location.search, EXCLUDE_SUPERSEDED)).toBe("");
    }
  });
});

describe("duplicates is a view, not a filter", () => {
  test("applying it swaps the page view and sets no row filter", () => {
    applyWorklist("duplicates");
    expect(readView(window.location.search)).toBe("duplicates");
    for (const key of ["untagged", "neverAccessed", "cold", "onlySuperseded"]) {
      expect(readMemFilter(window.location.search, key)).toBe("");
    }
  });

  test("a filter-shaped worklist clears the duplicates view", () => {
    applyWorklist("duplicates");
    applyWorklist("untagged");
    expect(readView(window.location.search)).toBe("");
  });
});

describe("switching worklists does not accumulate filters", () => {
  test("the previous worklist's filter is cleared, not ANDed", () => {
    // Without this, "Untagged" then "Superseded" would silently mean "untagged
    // AND superseded" — a list smaller than the count on the tile that was
    // just clicked, with nothing on screen explaining why.
    applyWorklist("untagged");
    applyWorklist("superseded");
    expect(readMemFilter(window.location.search, "untagged")).toBe("");
    expect(readMemFilter(window.location.search, "onlySuperseded")).toBe("true");
  });

  test("a cohort filter left over from mt#4763 is cleared too", () => {
    setUrl("http://localhost/memories?mem_f_tags=handoff&mem_f_since=2026-08-01");
    applyWorklist("untagged");
    expect(readMemFilter(window.location.search, "tags")).toBe("");
    expect(readMemFilter(window.location.search, "since")).toBe("");
    expect(readMemFilter(window.location.search, "untagged")).toBe("true");
  });

  test("a stale coldDays does not survive into a non-cold worklist", () => {
    applyWorklist("cold", 30);
    applyWorklist("untagged");
    expect(readMemFilter(window.location.search, "coldDays")).toBe("");
  });
});

describe("search mode and worklists cannot both be showing (PR #3508 R1)", () => {
  // `MemoriesList` switches to SEARCH MODE whenever `q` is non-empty, and
  // search mode queries `memories-search`, which accepts none of the `mem_f_*`
  // filters. So a worklist that stayed "active" alongside a search would
  // highlight a tile while the table showed results its predicate never
  // touched.

  test("applying a worklist clears an active search", () => {
    setUrl("http://localhost/memories?mem_f_q=cockpit");
    applyWorklist("untagged");
    expect(readMemFilter(window.location.search, "q")).toBe("");
    expect(isWorklistActive(window.location.search, "untagged")).toBe(true);
  });

  test.each(FILTER_WORKLISTS)(
    "%s is NOT active on a hand-assembled URL carrying both its filter and a search",
    (id) => {
      // applyWorklist clears `q`, so this state is only reachable via a shared
      // link or an edited address bar — which is exactly why the derivation,
      // not just the click path, has to know about it.
      applyWorklist(id);
      const withSearch = `${window.location.search}&mem_f_q=cockpit`;
      expect(isWorklistActive(withSearch, id)).toBe(false);
      expect(activeWorklist(withSearch)).toBeNull();
    }
  );

  test("duplicates STAYS active with a search present — it replaces the table", () => {
    // The suppression is specific to worklists that render THROUGH
    // MemoriesList. The duplicates view swaps the table out entirely, so no
    // search box is driving what is on screen and the tile is telling the
    // truth. Suppressing it here would be the same wrong-highlight bug in
    // reverse: a view that IS showing, reported as not.
    applyWorklist("duplicates");
    const withSearch = `${window.location.search}&mem_f_q=cockpit`;
    expect(isWorklistActive(withSearch, "duplicates")).toBe(true);
  });

  test("a whitespace-only search does not suppress the worklist", () => {
    // MemoriesList itself trims before deciding, so treating "   " as a search
    // here would disagree with the table in the opposite direction.
    applyWorklist("untagged");
    const withBlank = `${window.location.search}&mem_f_q=%20%20`;
    expect(isWorklistActive(withBlank, "untagged")).toBe(true);
  });
});

describe("pagination resets on a worklist click", () => {
  test("mem_page is dropped", () => {
    // Landing on page 4 of a list you just switched to shows an empty table
    // whenever the new population is shorter — an empty state that is not a
    // real empty state.
    setUrl("http://localhost/memories?mem_page=4");
    applyWorklist("untagged");
    expect(new URLSearchParams(window.location.search).get("mem_page")).toBeNull();
  });
});
