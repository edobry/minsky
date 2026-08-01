/**
 * engprod-proposals.ts — EngProd proposal-digest fetch + pure grouping
 * (mt#3331).
 *
 * The operator-facing half of the toil-miner curation gate (RFC Notion
 * 3ac937f0-3cb4-816e-8af7-e5380f10a24b, Phase 1): groups each mining run's
 * filed `engprod-proposal` tasks with their evidence, and exposes the
 * accept/reject mutations that update the task's status AND the ledger
 * verdict atomically (server-side transaction — see
 * ../../routes/engprod-proposals.ts).
 *
 * Mirrors `lib/digest.ts`'s split: this file is fetch + types + PURE
 * derivation (grouping/ranking), fully unit-testable without a server;
 * `pages/ProposalsPage.tsx` is fetch-wiring + render only.
 *
 * ## Why grouping happens here, client-side, from raw rows
 *
 * `engprod_proposal_ledger` rows are NOT linked to `engprod_miner_runs` by a
 * foreign key (out of scope for this task to add — that's the miner/ledger's
 * own schema, a sibling task's territory). Each ledger row's `createdAt`
 * (its FIRST-insert timestamp, stable across later overwrites — see
 * `ledger-service.ts`'s `getByFiledTaskIds` doc comment for why the ledger's
 * OWN `verdict`/`evidenceSnapshot.capturedAt` are not trustworthy for this)
 * is matched against each run's `[startedAt, finishedAt]` window to recover
 * "which run produced this proposal" without a schema change. A proposal
 * whose `createdAt` falls inside no run's window (observed live 2026-07-31
 * for mt#3419 — filed by an untracked, presumably-crashed tick with no
 * surviving `engprod_miner_runs` row) is bucketed into the UNASSIGNED group
 * rather than silently misattributed to the nearest run.
 */

// ---------------------------------------------------------------------------
// Wire types — what GET /api/engprod/proposals returns
// ---------------------------------------------------------------------------

export interface EngprodRunSummary {
  id: string;
  startedAt: string; // ISO
  finishedAt: string | null; // ISO, null while a run is (unusually) still in flight
  turnsScanned: number;
  clustersFound: number;
  clustersSentToLlm: number;
  proposalsGenerated: number;
  suppressedByDedupe: number;
  suppressedByBudget: number;
  suppressedByMaximalCollapse: number;
  suppressedByLowDistinctiveness: number;
  llmErrors: number;
  errored: boolean;
}

/** One filed `engprod-proposal` task, with its evidence block joined in. */
export interface EngprodProposalRow {
  taskId: string;
  title: string;
  /** The task's CURRENT status — ground truth for disposition, not the ledger's `verdict` column (see module doc comment). */
  status: string;
  clusterSignature: string;
  toolSequence: string[];
  evidenceFrequency: number;
  evidenceSessions: number;
  evidenceChainLength: number;
  /** Rank score at time of capture (frequency * sessionCount * chainLength, spec SC1). */
  score: number;
  rejectionReason: string | null;
  /** Ledger row's original (first-insert) createdAt — used to assign a run bucket. */
  createdAt: string;
}

export interface EngprodProposalsResponse {
  runs: EngprodRunSummary[];
  proposals: EngprodProposalRow[];
}

export async function fetchEngprodProposals(): Promise<EngprodProposalsResponse> {
  const res = await fetch("/api/engprod/proposals");
  if (!res.ok) {
    // Surface the server's actual error detail (e.g. "EngProd ledger
    // unavailable — SQL persistence provider not ready") rather than just
    // the status code — a bare "GET ... failed: 503" gives an operator no
    // way to tell a transient outage from a real bug (reviewer finding, PR
    // #2507 R1). Matches postDecision's existing error-propagation shape
    // below.
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `GET /api/engprod/proposals failed: ${res.status}`);
  }
  return (await res.json()) as EngprodProposalsResponse;
}

export interface EngprodDecisionResult {
  ok: true;
  taskId: string;
  status: string;
}

async function postDecision(
  taskId: string,
  action: "accept" | "reject",
  body?: { reason: string }
): Promise<EngprodDecisionResult> {
  const res = await fetch(`/api/engprod/proposals/${encodeURIComponent(taskId)}/${action}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `POST .../${action} failed: ${res.status}`);
  }
  return (await res.json()) as EngprodDecisionResult;
}

/** Accept a proposal: unblocks its task (BLOCKED -> TODO) into the normal lifecycle. */
export function acceptProposal(taskId: string): Promise<EngprodDecisionResult> {
  return postDecision(taskId, "accept");
}

/** Reject a proposal: closes its task and records the reason in the ledger. */
export function rejectProposal(taskId: string, reason: string): Promise<EngprodDecisionResult> {
  return postDecision(taskId, "reject", { reason });
}

// ---------------------------------------------------------------------------
// Pure derivation — disposition + run grouping + rank
// ---------------------------------------------------------------------------

export type ProposalDisposition = "pending" | "accepted" | "rejected";

/**
 * Derive accept/reject/pending disposition from the task's CURRENT status —
 * mirrors `decideReconciliation` in `packages/domain/src/engprod/ledger-service.ts`
 * exactly (BLOCKED -> pending/no-change, CLOSED -> rejected, anything else ->
 * accepted), computed independently here so the digest's rendering is correct
 * even when the ledger's own `verdict` column has drifted (see module doc).
 */
export function deriveDisposition(status: string): ProposalDisposition {
  if (status === "BLOCKED") return "pending";
  if (status === "CLOSED") return "rejected";
  return "accepted";
}

/** Sentinel run key for proposals whose createdAt matches no recorded run window. */
export const UNASSIGNED_RUN_KEY = "unassigned";

export interface EngprodRunGroup {
  /** null for the "no matching run record" bucket. */
  run: EngprodRunSummary | null;
  /** Proposals assigned to this run, ranked by score descending (spec: "its rank within the run"). */
  proposals: EngprodProposalRow[];
}

/**
 * Find the run whose `[startedAt, finishedAt]` window contains `createdAt`.
 * A still-in-flight run's `finishedAt` is null, treated as +Infinity — a
 * proposal filed by a run so long-running its own history insert hasn't
 * landed yet still assigns correctly, rather than falling to unassigned.
 * When multiple runs' windows overlap and both contain the timestamp (should
 * not happen in practice — the ops loop is single-flight per mt#3330's own
 * design — but guarded rather than assumed), the run with the LATEST
 * `startedAt` wins.
 */
export function assignRun(
  createdAt: string,
  runs: readonly EngprodRunSummary[]
): EngprodRunSummary | null {
  const createdAtMs = new Date(createdAt).getTime();
  let best: EngprodRunSummary | null = null;
  let bestStartMs = -Infinity;
  for (const run of runs) {
    const startMs = new Date(run.startedAt).getTime();
    const endMs = run.finishedAt ? new Date(run.finishedAt).getTime() : Number.POSITIVE_INFINITY;
    if (createdAtMs >= startMs && createdAtMs <= endMs && startMs > bestStartMs) {
      best = run;
      bestStartMs = startMs;
    }
  }
  return best;
}

/**
 * Group proposals by their assigned run (most recent run first), always
 * including EVERY run — even ones with zero assigned proposals — so a
 * healthy quiet run and a silently dead miner render distinctly (spec SC3 /
 * AT2). Proposals matching no run window land in a trailing UNASSIGNED
 * bucket (`run: null`) rather than being dropped or misattributed.
 */
export function groupProposalsByRun(
  runs: readonly EngprodRunSummary[],
  proposals: readonly EngprodProposalRow[]
): EngprodRunGroup[] {
  const sortedRuns = [...runs].sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  const byRunId = new Map<string, EngprodProposalRow[]>();
  const unassigned: EngprodProposalRow[] = [];

  for (const p of proposals) {
    const run = assignRun(p.createdAt, runs);
    if (!run) {
      unassigned.push(p);
      continue;
    }
    const list = byRunId.get(run.id) ?? [];
    list.push(p);
    byRunId.set(run.id, list);
  }

  const byScoreDesc = (a: EngprodProposalRow, b: EngprodProposalRow) => b.score - a.score;

  const groups: EngprodRunGroup[] = sortedRuns.map((run) => ({
    run,
    proposals: (byRunId.get(run.id) ?? []).sort(byScoreDesc),
  }));

  if (unassigned.length > 0) {
    groups.push({ run: null, proposals: unassigned.sort(byScoreDesc) });
  }

  return groups;
}

/**
 * AT2: distinguish "healthy, nothing found" from "the miner errored" for a
 * run with zero proposals — the acceptance-test-level distinction this
 * surface exists to make visible. Returns null for a run that DID produce
 * proposals (no empty-state framing needed).
 */
export function runEmptyState(run: EngprodRunSummary): "healthy-empty" | "errored" | null {
  if (run.proposalsGenerated > 0) return null;
  return run.errored || run.llmErrors > 0 ? "errored" : "healthy-empty";
}
