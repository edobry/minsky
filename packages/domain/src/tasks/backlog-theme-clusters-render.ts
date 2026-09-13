/**
 * Markdown rendering for the backlog theme-clustering artifact (mt#5128).
 *
 * Headings and `-` bullet lists only — no pipe tables (they wrap unpredictably
 * in a terminal, `/handoff §Why no tables`), and no score, rank, or priority
 * anywhere: the artifact carries facts per cluster, never an ordering claim.
 */

import type { ThemeClusterResult } from "./backlog-theme-clusters";

/**
 * Below this mean silhouette the clusters are a partition of a continuum rather
 * than separated groups; the artifact says so instead of letting the number
 * read as a defect. 0.1 is a conventional "weak structure" floor.
 */
export const LOW_SILHOUETTE = 0.1;

export interface RenderMeta {
  /** ISO timestamp the input was read at. */
  asOf: string;
  /** Open tasks in the population before residue was removed. */
  openTaskCount: number;
  /** Ids in the population with no embedding row (counted into the residue line). */
  missingEmbedding: string[];
}

function parameterLine(result: ThemeClusterResult): string {
  const p = result.params;
  const sweep = p.kRange ? ` (silhouette sweep over ${p.kRange[0]}..${p.kRange[1]})` : " (fixed)";
  const sampled =
    p.silhouettePoints > 0 && p.silhouettePoints < result.clustered
      ? ` (over a ${p.silhouettePoints}-point sample)`
      : "";
  const sil = p.silhouette !== null ? ` silhouette=${p.silhouette.toFixed(3)}${sampled}` : "";
  return (
    `Parameters: algorithm=${p.algorithm} k=${p.k}${sweep}${sil} ` +
    `seed=${p.seed} maxIterations=${p.maxIterations} staleDays=${p.staleDays}`
  );
}

/**
 * Render the artifact.
 */
export function renderThemeClustersMarkdown(result: ThemeClusterResult, meta: RenderMeta): string {
  const p = result.params;
  const residueAll = [...meta.missingEmbedding, ...result.residue];
  const lines: string[] = [];
  lines.push(`# Backlog mass by theme — as of ${meta.asOf}`);
  lines.push("");
  lines.push(parameterLine(result));
  lines.push(
    `Population: ${meta.openTaskCount} open non-package tasks; ${result.clustered} clustered; ` +
      `residue ${residueAll.length}.`
  );
  lines.push(
    "Clusters are listed by size only. Exemplars are the members nearest each cluster's centroid. " +
      "Nothing here is ordered by importance."
  );
  if (p.silhouette !== null && p.silhouette < LOW_SILHOUETTE) {
    lines.push(
      `Silhouette ${p.silhouette.toFixed(3)} is low: text embeddings form a continuum, so these ` +
        "clusters are a legibility aid over the mass, not sharply separated groups. Read the " +
        "exemplars, not the boundaries."
    );
  }
  lines.push("");
  result.clusters.forEach((c, i) => {
    lines.push(`## ${i + 1}. ${c.label.join(" · ") || "(no distinctive terms)"}`);
    lines.push("");
    const ofOpen = meta.openTaskCount > 0 ? (c.size / meta.openTaskCount) * 100 : 0;
    const ofClustered =
      residueAll.length > 0 ? `; ${(c.shareOfClustered * 100).toFixed(1)}% of clustered` : "";
    lines.push(`- Size: ${c.size} (${ofOpen.toFixed(1)}% of open tasks${ofClustered})`);
    lines.push(
      `- Age: median ${c.medianDaysSinceTouched} days since touched; ` +
        `${c.untouchedCount} untouched ${p.staleDays}+ days`
    );
    lines.push(`- Tags: ${(c.untaggedShare * 100).toFixed(0)}% untagged`);
    lines.push(`- Miner proposals: ${c.proposalCount}`);
    lines.push("- Exemplars:");
    for (const e of c.exemplars) lines.push(`  - ${e.id} — ${e.title}`);
    lines.push("");
  });
  lines.push("## Residue");
  lines.push("");
  if (residueAll.length === 0) {
    lines.push("- none — every open task was clustered");
  } else {
    const missing = meta.missingEmbedding.join(", ") || "—";
    const unusable = result.residue.join(", ") || "—";
    lines.push(`- ${meta.missingEmbedding.length} with no embedding row: ${missing}`);
    lines.push(`- ${result.residue.length} with an unusable vector: ${unusable}`);
  }
  lines.push("");
  return lines.join("\n");
}
