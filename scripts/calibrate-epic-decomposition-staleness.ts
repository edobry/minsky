#!/usr/bin/env bun
/**
 * Calibration script for the mt#1710 Shape C detector.
 *
 * Runs `detectEpicDecompositionStaleness` against a live Postgres-backed
 * Minsky DB for one or more epic IDs. Two modes:
 *
 *   - Live mode (default): treats TODO/PLANNING as candidate statuses. This
 *     is the production-facing behavior — surfaces tasks currently stalled.
 *   - Retrospective mode (--retrospective): also treats CLOSED as a candidate
 *     status. This is the historical/audit-replay mode that lets you verify
 *     the detector against tasks that have already been closed (e.g., the
 *     mt#1552 cluster the bridge memory describes — those 7 tasks are now
 *     CLOSED, and the live mode by definition cannot re-surface them).
 *
 * The mt#1552 cluster from the bridge memory is the calibration baseline.
 * Importantly: some "deliveries" cited in the memory (mt#1083 under mt#1073,
 * mt#1395 under mt#1335) are CROSS-EPIC and therefore out-of-scope for the
 * v0.1 within-epic detector. The detector still surfaces the cluster
 * retrospectively because there are WITHIN-EPIC deliveries (mt#1511,
 * mt#1372, mt#1310, mt#1309) whose scope overlaps the 7 superseded tasks.
 *
 * Usage:
 *   MINSKY_POSTGRES_URL=postgres://... bun scripts/calibrate-epic-decomposition-staleness.ts
 *   MINSKY_POSTGRES_URL=... bun scripts/calibrate-epic-decomposition-staleness.ts --retrospective
 *   MINSKY_POSTGRES_URL=... bun scripts/calibrate-epic-decomposition-staleness.ts mt#1552 mt#1110
 *
 * Env-gated: skips with exit 0 if MINSKY_POSTGRES_URL is not set, matching
 * the existing scripts/cleanup-tasks-embeddings-uuid-orphans.ts convention.
 *
 * Output: structured JSON summarizing candidates per epic + acceptance-test
 * verdicts (acceptance tests 1-3 from the mt#1710 spec).
 */

import postgres from "postgres";
import {
  detectEpicDecompositionStaleness,
  type EpicChildSnapshot,
  type EpicStalenessCandidate,
} from "../src/domain/detectors/epic-decomposition-staleness";

const DEFAULT_EPICS = ["mt#1552", "mt#1110", "mt#1335"];

/**
 * The 7 confirmed cluster instances from the 2026-05-11 bulk audit (bridge
 * memory id 4bc8ee1f-1eee-4561-a865-73c067e48d2e). These were filed pre- or
 * near-Sprint-A delivery under mt#1552 and CLOSED-superseded after the audit.
 */
const MT_1552_CONFIRMED_INSTANCES = [
  "mt#1600",
  "mt#1512",
  "mt#1080",
  "mt#1321",
  "mt#1301",
  "mt#1043",
  "mt#1349",
];

interface ChildRow {
  id: string;
  title: string | null;
  status: string | null;
  spec: string | null;
  created_at: Date | null;
  updated_at: Date | null;
}

async function fetchEpicChildren(sql: postgres.Sql, epicId: string): Promise<EpicChildSnapshot[]> {
  const rows = await sql<ChildRow[]>`
    SELECT t.id,
           t.title,
           t.status::text AS status,
           ts.content      AS spec,
           t.created_at,
           t.updated_at
      FROM task_relationships tr
      JOIN tasks t           ON t.id = tr.from_task_id
      LEFT JOIN task_specs ts ON ts.task_id = t.id
     WHERE tr.to_task_id = ${epicId}
       AND tr.type       = 'parent'
  `;

  return rows.map((r) => ({
    id: r.id,
    title: r.title ?? "",
    status: r.status ?? "TODO",
    spec: r.spec ?? "",
    createdAt: r.created_at ?? undefined,
    updatedAt: r.updated_at ?? undefined,
  }));
}

interface EpicAuditOutput {
  epicId: string;
  totalChildren: number;
  childrenByStatus: Record<string, number>;
  uniqueFlaggedChildren: number;
  candidatePairCount: number;
  flaggedChildIds: string[];
  topCandidates: Array<{
    todoChildId: string;
    todoChildTitle: string;
    todoChildStatus: string;
    deliveringSiblingId: string;
    deliveringSiblingTitle: string;
    overlap: {
      signalTypeCount: number;
      filePaths: string[];
      identifiers: string[];
      keywords: string[];
    };
  }>;
}

function summarizeCandidates(
  candidates: EpicStalenessCandidate[]
): EpicAuditOutput["topCandidates"] {
  // Sort by overlap strength descending so the operator's first 25 candidates
  // are the strongest matches (signal-type-count desc, then total-token-count
  // desc). The detector's own sort is by todoChildId asc (deterministic
  // grouping); calibration output benefits from strength-first ordering.
  // PR #1033 R1 nit (3): comment used to claim this sort but the code only
  // sliced the detector's output.
  const ranked = [...candidates].sort((a, b) => {
    if (a.overlap.signalTypeCount !== b.overlap.signalTypeCount) {
      return b.overlap.signalTypeCount - a.overlap.signalTypeCount;
    }
    if (a.overlap.totalTokenCount !== b.overlap.totalTokenCount) {
      return b.overlap.totalTokenCount - a.overlap.totalTokenCount;
    }
    return a.todoChildId.localeCompare(b.todoChildId);
  });
  return ranked.slice(0, 25).map((c) => ({
    todoChildId: c.todoChildId,
    todoChildTitle: c.todoChildTitle,
    todoChildStatus: c.todoChildStatus,
    deliveringSiblingId: c.deliveringSiblingId,
    deliveringSiblingTitle: c.deliveringSiblingTitle,
    overlap: {
      signalTypeCount: c.overlap.signalTypeCount,
      filePaths: c.overlap.filePaths,
      identifiers: c.overlap.identifiers,
      keywords: c.overlap.keywords,
    },
  }));
}

async function auditEpic(
  sql: postgres.Sql,
  epicId: string,
  retrospective: boolean
): Promise<EpicAuditOutput> {
  const children = await fetchEpicChildren(sql, epicId);
  const todoStatuses = retrospective
    ? (["TODO", "PLANNING", "CLOSED"] as const)
    : (["TODO", "PLANNING"] as const);
  // Live mode uses the detector's production default (30 days). Retrospective
  // mode widens to 60 days because the bridge-memory's Sprint-A deliveries
  // shipped 2026-04-23 — outside the 30-day default for late audits run
  // 2026-05-11 or later. PR #1033 R1 blocking finding 1.
  const recencyWindowDays = retrospective ? 60 : undefined;
  const candidates = detectEpicDecompositionStaleness(children, {
    ...(recencyWindowDays !== undefined ? { recencyWindowDays } : {}),
    todoStatuses,
    minOverlapSignals: 1,
  });

  const childrenByStatus: Record<string, number> = {};
  for (const c of children) {
    childrenByStatus[c.status] = (childrenByStatus[c.status] ?? 0) + 1;
  }

  const flagged = new Set(candidates.map((c) => c.todoChildId));

  return {
    epicId,
    totalChildren: children.length,
    childrenByStatus,
    uniqueFlaggedChildren: flagged.size,
    candidatePairCount: candidates.length,
    flaggedChildIds: Array.from(flagged).sort(),
    topCandidates: summarizeCandidates(candidates),
  };
}

async function main(): Promise<void> {
  const url = process.env.MINSKY_POSTGRES_URL;
  if (!url) {
    console.log(JSON.stringify({ skipped: true, reason: "MINSKY_POSTGRES_URL not set" }, null, 2));
    process.exit(0);
  }

  const args = process.argv.slice(2);
  const retrospective = args.includes("--retrospective");
  const epicArgs = args.filter((a) => !a.startsWith("--"));
  const epics = epicArgs.length > 0 ? epicArgs : DEFAULT_EPICS;

  const sql = postgres(url, { ssl: "prefer", max: 1 });
  const ranAt = new Date().toISOString();

  try {
    const auditResults: EpicAuditOutput[] = [];
    for (const epicId of epics) {
      const result = await auditEpic(sql, epicId, retrospective);
      auditResults.push(result);
    }

    // Acceptance test 1: in retrospective mode, mt#1552 must surface ≥6/7
    // confirmed instances. (Live mode by definition won't — they're CLOSED.)
    const mt1552 = auditResults.find((r) => r.epicId === "mt#1552");
    const mt1552Flagged = new Set(mt1552?.flaggedChildIds ?? []);
    const mt1552Hits = MT_1552_CONFIRMED_INSTANCES.filter((id) => mt1552Flagged.has(id));
    const mt1552Misses = MT_1552_CONFIRMED_INSTANCES.filter((id) => !mt1552Flagged.has(id));
    // False-positive count (within mt#1552 sweep) = flagged children that
    // are NOT in the confirmed corpus. Spec target is ≤2.
    const mt1552FalsePositives = (mt1552?.flaggedChildIds ?? []).filter(
      (id) => !MT_1552_CONFIRMED_INSTANCES.includes(id)
    );

    console.log(
      JSON.stringify(
        {
          ranAt,
          mode: retrospective ? "retrospective" : "live",
          epicsAudited: epics,
          notes: {
            withinEpicScope:
              "v0.1 detects deliveries WITHIN the same epic as the candidate. Cross-epic supersessions (e.g., mt#1083 under mt#1073, mt#1395 under mt#1335) are out of scope; the bridge memory's cluster is detectable because within-epic siblings (mt#1511, mt#1372, mt#1310, mt#1309) also overlap the same scope.",
            recencyWindow: retrospective
              ? "Retrospective mode: 60-day window so the bridge-memory's Sprint-A deliveries (shipped 2026-04-23) qualify against audits run weeks later."
              : "Live mode: 30-day window (the detector's production default). Run with --retrospective to widen to 60 days for historical audits.",
          },
          auditResults,
          acceptanceTest1: {
            description:
              "Retrospective mt#1552 sweep surfaces ≥6/7 confirmed cluster instances (correctness baseline)",
            applicable: retrospective && Boolean(mt1552),
            mt1552ConfirmedInstances: MT_1552_CONFIRMED_INSTANCES,
            mt1552Hits,
            mt1552Misses,
            passed: retrospective ? mt1552Hits.length >= 6 : null,
          },
          acceptanceTest2: {
            description:
              "mt#1110 / mt#1335 sweep runs cleanly (no error; flagged set available for operator review)",
            mt1110FlaggedCount:
              auditResults.find((r) => r.epicId === "mt#1110")?.uniqueFlaggedChildren ?? null,
            mt1335FlaggedCount:
              auditResults.find((r) => r.epicId === "mt#1335")?.uniqueFlaggedChildren ?? null,
            passed: true,
          },
          acceptanceTest3: {
            description:
              "Precision target: ≤2 false-positive flagged children per mt#1552 retrospective sweep",
            applicable: retrospective && Boolean(mt1552),
            mt1552FalsePositives,
            passed: retrospective ? mt1552FalsePositives.length <= 2 : null,
          },
        },
        null,
        2
      )
    );

    if (retrospective && mt1552 && mt1552Hits.length < 6) {
      console.error("Acceptance test 1 FAILED: fewer than 6/7 confirmed instances surfaced.");
      process.exit(1);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ error: String(err) }));
  process.exit(1);
});
