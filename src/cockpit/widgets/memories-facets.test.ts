import { describe, test, expect } from "bun:test";
import { createMemoriesFacetsWidget, groupFacetRows, type TagFacet } from "./memories-facets";

describe("groupFacetRows (mt#4763)", () => {
  test("buckets non-namespaced tags into `flat`, sorted by count desc", () => {
    const rows: TagFacet[] = [
      { tag: "handoff", count: 353 },
      { tag: "retrospective", count: 65 },
      { tag: "calibration", count: 81 },
    ];
    const result = groupFacetRows(rows);
    expect(result.flat.map((r) => r.tag)).toEqual(["handoff", "calibration", "retrospective"]);
    expect(result.namespaces).toEqual([]);
  });

  test("groups `<namespace>:<value>` tags under their namespace, totalCount summed", () => {
    const rows: TagFacet[] = [
      { tag: "family:assertion-without-verification", count: 66 },
      { tag: "family:scope-creep", count: 12 },
      { tag: "imported-from:notion", count: 300 },
      { tag: "content-hash:abc", count: 1 },
      { tag: "handoff", count: 353 },
    ];
    const result = groupFacetRows(rows);

    expect(result.flat.map((r) => r.tag)).toEqual(["handoff"]);

    const familyGroup = result.namespaces.find((n) => n.namespace === "family");
    expect(familyGroup).toBeDefined();
    expect(familyGroup?.tags.map((t) => t.tag)).toEqual([
      "family:assertion-without-verification",
      "family:scope-creep",
    ]);
    expect(familyGroup?.totalCount).toBe(78);

    const importedFromGroup = result.namespaces.find((n) => n.namespace === "imported-from");
    expect(importedFromGroup?.totalCount).toBe(300);

    const contentHashGroup = result.namespaces.find((n) => n.namespace === "content-hash");
    expect(contentHashGroup?.totalCount).toBe(1);

    // Namespaces sorted by totalCount desc: imported-from (300) > family (78) > content-hash (1).
    expect(result.namespaces.map((n) => n.namespace)).toEqual([
      "imported-from",
      "family",
      "content-hash",
    ]);
  });

  test("namespace match is case-insensitive on the prefix", () => {
    const rows: TagFacet[] = [{ tag: "Family:Foo", count: 3 }];
    const result = groupFacetRows(rows);
    expect(result.namespaces).toHaveLength(1);
    expect(result.namespaces[0]?.namespace).toBe("family");
    // The tag itself is preserved verbatim, only the grouping key is lowercased.
    expect(result.namespaces[0]?.tags[0]?.tag).toBe("Family:Foo");
  });

  test("empty input returns empty flat and namespaces", () => {
    expect(groupFacetRows([])).toEqual({ flat: [], namespaces: [] });
  });

  test("ties within a namespace break alphabetically by tag", () => {
    const rows: TagFacet[] = [
      { tag: "theme:b", count: 5 },
      { tag: "theme:a", count: 5 },
    ];
    const result = groupFacetRows(rows);
    expect(result.namespaces[0]?.tags.map((t) => t.tag)).toEqual(["theme:a", "theme:b"]);
  });
});

describe("createMemoriesFacetsWidget — degraded states (mt#4763)", () => {
  test("returns degraded when the db getter resolves null", async () => {
    const widget = createMemoriesFacetsWidget(async () => null);
    const result = await widget.fetch({ id: "memories-facets", query: {} });
    expect(result.state).toBe("degraded");
  });

  test("returns degraded (not a throw) when the db getter itself rejects", async () => {
    const widget = createMemoriesFacetsWidget(async () => {
      throw new Error("connection refused");
    });
    const result = await widget.fetch({ id: "memories-facets", query: {} });
    expect(result.state).toBe("degraded");
    if (result.state === "degraded") {
      expect(result.reason).toContain("memories facets");
    }
  });

  test("widget id and title are stable", () => {
    const widget = createMemoriesFacetsWidget(async () => null);
    expect(widget.id).toBe("memories-facets");
    expect(widget.title).toBe("Memories — Tag Facets");
  });
});
