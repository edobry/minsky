/**
 * Proposal filing (mt#3330) — the second dedupe stage plus containment.
 *
 * Dedupe order per spec SC5: ledger (exact signature, `ledger-service.ts`)
 * runs FIRST, before the LLM stage. THIS module runs the SECOND stage —
 * task-similarity embeddings — AFTER the LLM stage, scoped to non-proposal
 * (human-authored) live tasks: `tasks_similar`/`searchByText` include
 * terminal tasks post-mt#3305 by design (it answers "does this already
 * exist?"), so the scoping this module needs is a TAG filter
 * (`engprod-proposal`), not a status filter — applied here by re-fetching
 * each similarity hit and checking its tags, since `TaskSimilarityService`
 * has no tag-filter parameter.
 *
 * Containment (spec SC3): every filed task is tagged `engprod-proposal` and
 * created in BLOCKED status, which `TaskRoutingService.findAvailableTasks`
 * (backing `tasks_available`) excludes by its `["TODO", "IN-PROGRESS"]`
 * default filter — verified against the live service, not assumed.
 */

import { log } from "@minsky/shared/logger";
import { getLoggableErrorSummary } from "../errors/index";
import type { TaskServiceInterface } from "../tasks/taskService";
import type { TaskSimilarityService } from "../tasks/task-similarity-service";
import type { ProposalLedgerService } from "./ledger-service";
import { ENGPROD_PROPOSAL_TAG, type ClusterAnalysis, type MinedCluster } from "./types";

/** Cosine-distance threshold (lower = closer) for the similarity dedupe match. */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.2;

/** Similar-task candidates considered per cluster before giving up on a match. */
const SIMILARITY_CANDIDATES = 5;

export function buildProposalTitle(cluster: MinedCluster): string {
  const seq = cluster.toolSequence.join(" -> ");
  return `EngProd proposal: ${seq} (${cluster.frequency}x/${cluster.sessionCount} sessions)`;
}

export function buildProposalSpec(cluster: MinedCluster, analysis: ClusterAnalysis): string {
  const refs = cluster.sampleRefs.map((r) => `${r.sessionId}#${r.turnIndex}`).join(", ") || "none";
  return [
    "## Summary",
    "",
    "Recurring tool-call pattern mined from agent transcripts by the EngProd",
    "toil miner (mt#3330). This task was filed automatically and is BLOCKED",
    "pending principal triage — it is not routable via `tasks_available`",
    "or `tasks_route` while BLOCKED.",
    "",
    "## Proposed primitive",
    "",
    analysis.proposedPrimitive,
    "",
    "## Existing tool coverage",
    "",
    analysis.existingToolCoverage,
    "",
    "## Evidence",
    "",
    `- **Tool sequence**: ${cluster.toolSequence.join(" -> ")}`,
    `- **Frequency**: ${cluster.frequency} occurrences`,
    `- **Sessions affected**: ${cluster.sessionCount}`,
    `- **Chain length**: ${cluster.chainLength}`,
    `- **Cluster signature**: \`${cluster.signature}\``,
    `- **Sample refs (session#turn)**: ${refs}`,
    "",
    "## Disposition",
    "",
    "Unblocking this task = accepting the proposal. Closing it without",
    "unblocking = rejecting the proposal; the same cluster will not",
    "re-surface unless its observed frequency at least doubles.",
    "",
    "## Cross-references",
    "",
    "- Mined by: mt#3330 (EngProd toil miner)",
    "- RFC: Notion 3ac937f0-3cb4-816e-8af7-e5380f10a24b",
  ].join("\n");
}

export interface ProposalFilingDeps {
  taskService: TaskServiceInterface;
  taskSimilarityService: TaskSimilarityService;
  ledgerService: ProposalLedgerService;
  similarityThreshold?: number;
}

export interface FileProposalResult {
  filed: boolean;
  taskId?: string;
  matchedTaskId?: string;
}

/**
 * Run the second dedupe stage (task-similarity, non-proposal tasks only)
 * and, if no match is found, file the BLOCKED proposal task. Always records
 * a ledger verdict either way (superseded or proposed) — the curation gate
 * never silently drops a survivor.
 */
export async function fileProposal(
  deps: ProposalFilingDeps,
  cluster: MinedCluster,
  analysis: ClusterAnalysis
): Promise<FileProposalResult> {
  const threshold = deps.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const query = `${buildProposalTitle(cluster)}\n${analysis.proposedPrimitive}`;

  let matchedTaskId: string | undefined;
  try {
    const response = await deps.taskSimilarityService.searchByText(
      query,
      SIMILARITY_CANDIDATES,
      threshold
    );
    for (const result of response.results) {
      const task = await deps.taskService.getTask(result.id);
      if (!task) continue;
      if ((task.tags ?? []).includes(ENGPROD_PROPOSAL_TAG)) continue; // scope to non-proposal (human-authored) tasks
      matchedTaskId = result.id;
      break;
    }
  } catch (err) {
    log.warn("engprod proposal-filing: similarity dedupe check failed; proceeding without it", {
      signature: cluster.signature,
      error: getLoggableErrorSummary(err),
    });
  }

  if (matchedTaskId) {
    await deps.ledgerService.recordSuperseded(cluster, matchedTaskId);
    return { filed: false, matchedTaskId };
  }

  const title = buildProposalTitle(cluster);
  const spec = buildProposalSpec(cluster, analysis);
  const newTask = await deps.taskService.createTaskFromTitleAndSpec(title, spec, {
    status: "BLOCKED",
    tags: [ENGPROD_PROPOSAL_TAG],
  });
  await deps.ledgerService.recordProposed(cluster, newTask.id);
  return { filed: true, taskId: newTask.id };
}
