import { describe, expect, test } from "bun:test";

import { cosineSimilarity } from "../knowledge/reconciliation/clustering";
import { clusterBacklogThemes, type ThemeClusterItem } from "./backlog-theme-clusters";
import { renderThemeClustersMarkdown } from "./backlog-theme-clusters-render";

const DAY_MS = 86_400_000;
const NOW_MS = Date.UTC(2026, 8, 13, 8, 0, 0);

/** Tiny seeded generator so the fixture is stable across runs. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface GroupSpec {
  center: number[];
  titles: string[];
  tags?: string[];
  ageDays: number;
}

/** Three well-separated groups in 8 dims, with small noise around each center. */
function buildFixture(perGroup: number): { items: ThemeClusterItem[]; groups: string[][] } {
  const rand = lcg(7);
  const specs: GroupSpec[] = [
    {
      center: [1, 0, 0, 0, 0, 0, 0, 0],
      titles: ["cockpit widget render", "cockpit route overview", "cockpit render nits"],
      ageDays: 5,
    },
    {
      center: [0, 0, 0, 1, 0, 0, 0, 0],
      titles: ["reviewer timeout retry", "reviewer webhook silence", "reviewer check-run"],
      tags: ["engprod-proposal"],
      ageDays: 120,
    },
    {
      center: [0, 0, 0, 0, 0, 0, 1, 0],
      titles: ["embeddings index repair", "embeddings vector normalize", "embeddings backfill"],
      tags: ["search"],
      ageDays: 40,
    },
  ];
  const items: ThemeClusterItem[] = [];
  const groups: string[][] = [];
  specs.forEach((spec, g) => {
    const ids: string[] = [];
    for (let i = 0; i < perGroup; i++) {
      const id = `mt#${g * 100 + i}`;
      ids.push(id);
      items.push({
        id,
        title: spec.titles[i % spec.titles.length] as string,
        tags: spec.tags ?? [],
        updatedAtMs: NOW_MS - spec.ageDays * DAY_MS,
        vector: spec.center.map((c) => c + (rand() - 0.5) * 0.2),
      });
    }
    groups.push(ids);
  });
  return { items, groups };
}

describe("clusterBacklogThemes", () => {
  test("AT1: recovers three known groups from a 36-item fixture via the silhouette sweep", () => {
    const { items, groups } = buildFixture(12);
    const result = clusterBacklogThemes(items, { kRange: [2, 6], seed: 1, nowMs: NOW_MS });

    expect(result.params.k).toBe(3);
    expect(result.clusters).toHaveLength(3);
    expect(result.residue).toEqual([]);
    expect(result.clustered).toBe(36);

    const found = result.clusters.map((c) => [...c.memberIds].sort());
    for (const expected of groups) {
      expect(found).toContainEqual([...expected].sort());
    }
  });

  test("a fixed k is honored and reported without a sweep range", () => {
    const { items } = buildFixture(6);
    const result = clusterBacklogThemes(items, { k: 2, seed: 3, nowMs: NOW_MS });
    expect(result.params.k).toBe(2);
    expect(result.params.kRange).toBeNull();
    expect(result.clusters).toHaveLength(2);
  });

  test("per-cluster facts: age, staleness, tag coverage, proposal count, exemplars", () => {
    const { items } = buildFixture(10);
    const result = clusterBacklogThemes(items, { k: 3, seed: 1, nowMs: NOW_MS, staleDays: 90 });
    const byMember = (id: string) => result.clusters.find((c) => c.memberIds.includes(id));

    const reviewer = byMember("mt#100");
    expect(reviewer).toBeDefined();
    expect(reviewer?.medianDaysSinceTouched).toBe(120);
    expect(reviewer?.untouchedCount).toBe(10);
    expect(reviewer?.untaggedShare).toBe(0);
    expect(reviewer?.proposalCount).toBe(10);
    expect(reviewer?.label).toContain("reviewer");

    const cockpit = byMember("mt#0");
    expect(cockpit?.untouchedCount).toBe(0);
    expect(cockpit?.untaggedShare).toBe(1);
    expect(cockpit?.proposalCount).toBe(0);
    expect(cockpit?.exemplars).toHaveLength(3);
    expect(cockpit?.label).toContain("cockpit");
  });

  test("SC4: an unusable vector lands in the residue, never silently dropped", () => {
    const { items } = buildFixture(5);
    items.push({
      id: "mt#999",
      title: "zero vector",
      tags: [],
      updatedAtMs: NOW_MS,
      vector: [0, 0, 0],
    });
    items.push({
      id: "mt#998",
      title: "nan vector",
      tags: [],
      updatedAtMs: NOW_MS,
      vector: [Number.NaN, 1],
    });
    const result = clusterBacklogThemes(items, { k: 3, seed: 1, nowMs: NOW_MS });
    expect(result.residue.sort()).toEqual(["mt#998", "mt#999"]);
    expect(result.clustered).toBe(15);
  });

  test("clusters are listed by size only; the same seed reproduces the same output", () => {
    const { items } = buildFixture(8);
    // Drop three from the last group so sizes differ.
    const trimmed = items.filter((it) => !["mt#205", "mt#206", "mt#207"].includes(it.id));
    const a = clusterBacklogThemes(trimmed, { k: 3, seed: 11, nowMs: NOW_MS });
    const b = clusterBacklogThemes(trimmed, { k: 3, seed: 11, nowMs: NOW_MS });
    expect(a.clusters.map((c) => c.size)).toEqual([8, 8, 5]);
    expect(a).toEqual(b);
  });

  test("empty input yields no clusters and k=0 params", () => {
    const result = clusterBacklogThemes([], { nowMs: NOW_MS });
    expect(result.clusters).toEqual([]);
    expect(result.params.k).toBe(0);
  });

  test("the silhouette is computed over a seeded sample when the input exceeds the cap", () => {
    const { items, groups } = buildFixture(12);
    const sampled = clusterBacklogThemes(items, {
      kRange: [2, 6],
      seed: 1,
      nowMs: NOW_MS,
      silhouetteSampleSize: 12,
    });
    expect(sampled.params.silhouettePoints).toBe(12);
    expect(sampled.params.k).toBe(3);
    const found = sampled.clusters.map((c) => [...c.memberIds].sort());
    for (const expected of groups) expect(found).toContainEqual([...expected].sort());

    const full = clusterBacklogThemes(items, { kRange: [2, 6], seed: 1, nowMs: NOW_MS });
    expect(full.params.silhouettePoints).toBe(36);
  });

  test("assignment metric equals 2x the knowledge clusterer's cosine distance on unit vectors", () => {
    // The silhouette sweep runs on squared Euclidean over unit vectors; pin the
    // identity to cosine distance so the two never drift apart silently.
    const a = [0.6, 0.8, 0];
    const b = [0, 0.6, 0.8];
    const cosDist = 1 - cosineSimilarity(a, b);
    const sq = a.reduce((s, x, i) => s + (x - (b[i] as number)) ** 2, 0);
    expect(sq).toBeCloseTo(2 * cosDist, 12);
  });

  test("an empty cluster is reseeded rather than left with a stale centroid", () => {
    // k larger than the number of natural groups forces an empty cluster at
    // some iteration; every cluster in the output must be non-empty and the
    // member sets must still partition the input.
    const { items } = buildFixture(4);
    const result = clusterBacklogThemes(items, { k: 6, seed: 5, nowMs: NOW_MS });
    const all = result.clusters.flatMap((c) => c.memberIds).sort();
    expect(all).toEqual(items.map((i) => i.id).sort());
    for (const c of result.clusters) expect(c.size).toBeGreaterThan(0);
  });
});

describe("renderThemeClustersMarkdown", () => {
  test("SC5 + AT3: the header carries the parameters, and no score/rank/priority appears anywhere", () => {
    const { items } = buildFixture(6);
    const result = clusterBacklogThemes(items, { kRange: [2, 4], seed: 1, nowMs: NOW_MS });
    const md = renderThemeClustersMarkdown(result, {
      asOf: "2026-09-13T08:00:00.000Z",
      openTaskCount: 19,
      missingEmbedding: ["mt#777"],
    });

    expect(md).toContain("Parameters: algorithm=kmeans++/cosine k=3 (silhouette sweep over 2..4)");
    expect(md).toContain("seed=1 maxIterations=25 staleDays=90");
    expect(md).toContain("Population: 19 open non-package tasks; 18 clustered; residue 1.");
    expect(md).toContain("- 1 with no embedding row: mt#777");
    // SC2: share is of OPEN tasks (6/19), with the clustered denominator beside it when residue > 0.
    expect(md).toContain("- Size: 6 (31.6% of open tasks; 33.3% of clustered)");
    expect(md).not.toMatch(/\|/); // no pipe tables
    expect(md).not.toMatch(/\b(score|rank|priority)\b/i);
  });

  test("a low silhouette is explained rather than printed bare", () => {
    const { items } = buildFixture(6);
    const result = clusterBacklogThemes(items, { k: 3, seed: 1, nowMs: NOW_MS });
    const weak = { ...result, params: { ...result.params, silhouette: 0.02 } };
    const md = renderThemeClustersMarkdown(weak, {
      asOf: "2026-09-13T08:00:00.000Z",
      openTaskCount: 18,
      missingEmbedding: [],
    });
    expect(md).toContain("Silhouette 0.020 is low");
    const strong = renderThemeClustersMarkdown(result, {
      asOf: "2026-09-13T08:00:00.000Z",
      openTaskCount: 18,
      missingEmbedding: [],
    });
    expect(result.params.silhouette).toBeGreaterThan(0.5);
    expect(strong).not.toContain("is low");
  });

  test("labels exclude identifier-like tokens and function words", () => {
    const { items } = buildFixture(4);
    items[0] = { ...(items[0] as ThemeClusterItem), title: "cockpit 3ae937f0 them never widget" };
    const result = clusterBacklogThemes(items, { k: 3, seed: 1, nowMs: NOW_MS });
    const all = result.clusters.flatMap((c) => c.label);
    expect(all).not.toContain("3ae937f0");
    expect(all).not.toContain("them");
    expect(all).not.toContain("never");
  });

  test("short domain terms on the allowlist survive the length floor", () => {
    const { items } = buildFixture(4);
    for (const it of items.slice(0, 4)) it.title = `${it.title} auth cli`;
    const result = clusterBacklogThemes(items, { k: 3, seed: 1, nowMs: NOW_MS });
    const cockpit = result.clusters.find((c) => c.memberIds.includes("mt#0"));
    expect(cockpit?.label).toContain("auth");
    expect(cockpit?.label).toContain("cli");
  });

  test("clean run says so in the residue section", () => {
    const { items } = buildFixture(4);
    const result = clusterBacklogThemes(items, { k: 3, seed: 1, nowMs: NOW_MS });
    const md = renderThemeClustersMarkdown(result, {
      asOf: "2026-09-13T08:00:00.000Z",
      openTaskCount: 12,
      missingEmbedding: [],
    });
    expect(md).toContain("- none — every open task was clustered");
    // No residue: one denominator, and it is the open-task population.
    expect(md).toContain("- Size: 4 (33.3% of open tasks)");
    expect(md).not.toContain("of clustered");
  });
});
