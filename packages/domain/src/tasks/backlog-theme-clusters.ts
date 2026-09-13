/**
 * Backlog theme clustering (mt#5128 — Prioritization Phase 1a).
 *
 * One-shot, read-only clustering of open-task embeddings into themes, rendered
 * as "the backlog's mass by theme" so the principal can declare standing
 * pointings against what is actually there rather than what is salient in
 * recent memory (RFC 3ae937f0, §Roadmap Phase 1).
 *
 * Deliberately NOT a ranking: clusters are listed by size only, items inside a
 * cluster are exemplars nearest the centroid, and no score, rank, or priority
 * is rendered anywhere. The RFC's measured tie (504 of 634 TODO tasks at
 * readiness 1.0) is the reason — sorting on nulls produces an arbitrary order
 * wearing the costume of a judgment.
 *
 * Algorithm: k-means++ over L2-normalized vectors (so squared Euclidean
 * distance is monotone in cosine distance), k chosen by a silhouette sweep
 * over a small range, seeded PRNG for reproducibility. Reuses
 * `cosineSimilarity` from the knowledge near-duplicate clusterer rather than
 * that module's single-linkage clusterer, whose 0.92 threshold is built for
 * duplicates and is far too tight for themes. No external dependency.
 */

import { cosineSimilarity } from "../knowledge/reconciliation/clustering";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface ThemeClusterItem {
  id: string;
  title: string;
  vector: number[];
  tags: string[];
  /** Milliseconds since epoch of the task's last touch (`updated_at`). */
  updatedAtMs: number;
}

export interface ThemeClusterOptions {
  /** Fix k instead of sweeping. */
  k?: number;
  /** Inclusive sweep range when `k` is not fixed. Default [6, 16]. */
  kRange?: [number, number];
  /** PRNG seed for k-means++ initialization. Default 42. */
  seed?: number;
  /** Lloyd iterations per k. Default 25. */
  maxIterations?: number;
  /** Exemplars listed per cluster. Default 3. */
  exemplarsPerCluster?: number;
  /** Label terms per cluster. Default 5. */
  termsPerCluster?: number;
  /** "Now" for age arithmetic; injected so tests anchor to a fixed clock. */
  nowMs?: number;
  /** Tag that marks an EngProd miner proposal. Default "engprod-proposal". */
  proposalTag?: string;
  /** Days after which a task counts as untouched. Default 90. */
  staleDays?: number;
}

export interface ThemeCluster {
  /** Top title terms, most distinctive first. */
  label: string[];
  /** Members nearest the centroid, nearest first. */
  exemplars: Array<{ id: string; title: string }>;
  memberIds: string[];
  size: number;
  /** size / total clustered, in [0, 1]. */
  share: number;
  medianDaysSinceTouched: number;
  untouchedCount: number;
  untaggedShare: number;
  proposalCount: number;
}

export interface ThemeClusterParams {
  algorithm: "kmeans++/cosine";
  k: number;
  kRange: [number, number] | null;
  silhouette: number | null;
  seed: number;
  maxIterations: number;
  staleDays: number;
}

export interface ThemeClusterResult {
  /** Listed by size, largest first — the ONLY sort applied. */
  clusters: ThemeCluster[];
  /** Ids given to the clusterer that landed in no cluster (empty vector, NaN). */
  residue: string[];
  clustered: number;
  params: ThemeClusterParams;
}

// ─── Deterministic PRNG ───────────────────────────────────────────────────────

/** mulberry32 — small, seedable, good enough for centroid seeding. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Vector helpers ───────────────────────────────────────────────────────────

function normalize(v: number[]): number[] | null {
  let sum = 0;
  for (const x of v) {
    if (!Number.isFinite(x)) return null;
    sum += x * x;
  }
  if (sum === 0) return null;
  const inv = 1 / Math.sqrt(sum);
  return v.map((x) => x * inv);
}

/** Squared Euclidean distance between unit vectors = 2 − 2·cos. */
function sqDist(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    s += d * d;
  }
  return s;
}

function meanVector(vectors: number[][], dims: number): number[] {
  const out = new Array<number>(dims).fill(0);
  for (const v of vectors) for (let i = 0; i < dims; i++) out[i] = (out[i] ?? 0) + (v[i] ?? 0);
  const n = vectors.length || 1;
  return out.map((x) => x / n);
}

// ─── k-means++ ────────────────────────────────────────────────────────────────

function kmeans(
  points: number[][],
  k: number,
  seed: number,
  maxIterations: number
): { assignments: number[]; centroids: number[][] } {
  const n = points.length;
  const dims = points[0]?.length ?? 0;
  const rand = mulberry32(seed);

  // k-means++ seeding
  const centroids: number[][] = [];
  const first = points[Math.floor(rand() * n)];
  if (!first) return { assignments: [], centroids: [] };
  centroids.push([...first]);
  const minDist = points.map((p) => sqDist(p, first));
  while (centroids.length < k) {
    const total = minDist.reduce((s, d) => s + d, 0);
    let pick = n - 1;
    if (total > 0) {
      let r = rand() * total;
      for (let i = 0; i < n; i++) {
        r -= minDist[i] ?? 0;
        if (r <= 0) {
          pick = i;
          break;
        }
      }
    } else {
      pick = Math.floor(rand() * n);
    }
    const chosen = points[pick];
    if (!chosen) break;
    centroids.push([...chosen]);
    for (let i = 0; i < n; i++) {
      const d = sqDist(points[i] as number[], chosen);
      if (d < (minDist[i] ?? Infinity)) minDist[i] = d;
    }
  }

  // Lloyd iterations
  let assignments = new Array<number>(n).fill(0);
  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;
    const next = points.map((p, i) => {
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = sqDist(p, centroids[c] as number[]);
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (best !== assignments[i]) changed = true;
      return best;
    });
    assignments = next;
    for (let c = 0; c < centroids.length; c++) {
      const members = points.filter((_, i) => assignments[i] === c);
      if (members.length > 0) centroids[c] = meanVector(members, dims);
    }
    if (!changed) break;
  }
  return { assignments, centroids };
}

/** Mean silhouette over all points, using the precomputed distance matrix. */
function silhouette(dist: Float64Array, n: number, assignments: number[], k: number): number {
  if (k < 2 || n < 2) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const own = assignments[i] as number;
    const sums = new Array<number>(k).fill(0);
    const counts = new Array<number>(k).fill(0);
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const c = assignments[j] as number;
      sums[c] = (sums[c] ?? 0) + (dist[i * n + j] ?? 0);
      counts[c] = (counts[c] ?? 0) + 1;
    }
    const ownCount = counts[own] ?? 0;
    if (ownCount === 0) continue; // singleton: silhouette defined as 0
    const a = (sums[own] ?? 0) / ownCount;
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === own || (counts[c] ?? 0) === 0) continue;
      b = Math.min(b, (sums[c] ?? 0) / (counts[c] as number));
    }
    if (!Number.isFinite(b)) continue;
    total += (b - a) / Math.max(a, b);
  }
  return total / n;
}

// ─── Labelling ────────────────────────────────────────────────────────────────

const STOPWORDS = new Set(
  (
    "a an and are as at be by for from in into is it its of on or that the this to via with " +
    "when where which while who will not no does do did has have had than then so if but " +
    "after before every each one two all any some only over under out up down off can cannot " +
    "should would could may might must new add adds added make makes made use uses used using " +
    "set sets get gets fix fixes fixed run runs ran task tasks mt pr minsky " +
    "them they their there these those them than then still now into own same just more less " +
    "without within your yours you we our ours how what why was were been being also both such " +
    "very here first last next once again already never ever always because between against " +
    "about above below across along around through during until while itself themselves"
  ).split(" ")
);

/** Hex-ish identifiers (Notion page ids, shas) and digit-heavy tokens are never theme words. */
function isIdentifierLike(token: string): boolean {
  if (/^[0-9a-f]{8,}$/.test(token)) return true;
  const digits = token.replace(/[^0-9]/g, "").length;
  return digits > 2 || /^\d+$/.test(token);
}

function tokenize(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/mt#\d+|pr\s*#\d+|#\d+/g, " ")
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t) && !isIdentifierLike(t));
}

function labelClusters(groups: ThemeClusterItem[][], termsPerCluster: number): string[][] {
  const clusterTf = groups.map((g) => {
    const tf = new Map<string, number>();
    for (const item of g)
      for (const t of new Set(tokenize(item.title))) tf.set(t, (tf.get(t) ?? 0) + 1);
    return tf;
  });
  const df = new Map<string, number>();
  for (const tf of clusterTf) for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const k = groups.length;
  return clusterTf.map((tf, i) => {
    const size = groups[i]?.length ?? 1;
    return [...tf.entries()]
      .map(([t, n]) => ({ t, score: (n / size) * Math.log((k + 1) / ((df.get(t) ?? 0) + 0.5)) }))
      .sort((a, b) => b.score - a.score || a.t.localeCompare(b.t))
      .slice(0, termsPerCluster)
      .map((x) => x.t);
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Cluster open tasks into themes. Pure: no IO, deterministic for a given seed.
 */
export function clusterBacklogThemes(
  items: ThemeClusterItem[],
  options: ThemeClusterOptions = {}
): ThemeClusterResult {
  const seed = options.seed ?? 42;
  const maxIterations = options.maxIterations ?? 25;
  const exemplarsPerCluster = options.exemplarsPerCluster ?? 3;
  const termsPerCluster = options.termsPerCluster ?? 5;
  const nowMs = options.nowMs ?? Date.now();
  const proposalTag = options.proposalTag ?? "engprod-proposal";
  const staleDays = options.staleDays ?? 90;

  const residue: string[] = [];
  const usable: Array<{ item: ThemeClusterItem; unit: number[] }> = [];
  for (const item of items) {
    const unit = normalize(item.vector);
    if (unit) usable.push({ item, unit });
    else residue.push(item.id);
  }
  const n = usable.length;
  const emptyParams = (k: number): ThemeClusterParams => ({
    algorithm: "kmeans++/cosine",
    k,
    kRange: options.k === undefined ? (options.kRange ?? [6, 16]) : null,
    silhouette: null,
    seed,
    maxIterations,
    staleDays,
  });
  if (n === 0) return { clusters: [], residue, clustered: 0, params: emptyParams(0) };

  const points = usable.map((u) => u.unit);

  // Pairwise distance matrix (cosine distance on unit vectors), for silhouette.
  const dist = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = 1 - cosineSimilarity(points[i] as number[], points[j] as number[]);
      dist[i * n + j] = d;
      dist[j * n + i] = d;
    }
  }

  let bestK: number;
  let bestAssign: number[] = [];
  let bestCentroids: number[][] = [];
  let bestSil: number | null = null;
  if (options.k !== undefined) {
    bestK = Math.max(1, Math.min(options.k, n));
    const r = kmeans(points, bestK, seed, maxIterations);
    bestAssign = r.assignments;
    bestCentroids = r.centroids;
    if (bestK >= 2) bestSil = silhouette(dist, n, bestAssign, bestK);
  } else {
    const [lo, hi] = options.kRange ?? [6, 16];
    const kMin = Math.max(2, Math.min(lo, n));
    const kMax = Math.max(kMin, Math.min(hi, n));
    bestK = kMin;
    let best = -Infinity;
    for (let k = kMin; k <= kMax; k++) {
      const r = kmeans(points, k, seed, maxIterations);
      const s = silhouette(dist, n, r.assignments, k);
      if (s > best) {
        best = s;
        bestK = k;
        bestAssign = r.assignments;
        bestCentroids = r.centroids;
      }
    }
    bestSil = Number.isFinite(best) ? best : null;
  }

  const groups: Array<Array<{ item: ThemeClusterItem; unit: number[] }>> = Array.from(
    { length: bestCentroids.length },
    () => []
  );
  bestAssign.forEach((c, i) => {
    const u = usable[i];
    if (u) groups[c]?.push(u);
  });
  const nonEmpty = groups.filter((g) => g.length > 0);
  const labels = labelClusters(
    nonEmpty.map((g) => g.map((u) => u.item)),
    termsPerCluster
  );

  const clusters: ThemeCluster[] = nonEmpty.map((g, idx) => {
    const centroid = meanVector(
      g.map((u) => u.unit),
      points[0]?.length ?? 0
    );
    const exemplars = [...g]
      .sort((a, b) => sqDist(a.unit, centroid) - sqDist(b.unit, centroid))
      .slice(0, exemplarsPerCluster)
      .map((u) => ({ id: u.item.id, title: u.item.title }));
    const ages = g.map((u) => Math.max(0, (nowMs - u.item.updatedAtMs) / MS_PER_DAY));
    const untagged = g.filter((u) => u.item.tags.length === 0).length;
    return {
      label: labels[idx] ?? [],
      exemplars,
      memberIds: g.map((u) => u.item.id),
      size: g.length,
      share: g.length / n,
      medianDaysSinceTouched: Math.round(median(ages)),
      untouchedCount: ages.filter((d) => d >= staleDays).length,
      untaggedShare: untagged / g.length,
      proposalCount: g.filter((u) => u.item.tags.includes(proposalTag)).length,
    };
  });
  clusters.sort((a, b) => b.size - a.size || a.label.join(" ").localeCompare(b.label.join(" ")));

  return {
    clusters,
    residue,
    clustered: n,
    params: { ...emptyParams(bestK), silhouette: bestSil },
  };
}
