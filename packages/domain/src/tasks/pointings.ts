/**
 * Standing pointings — pure core (mt#5129, Prioritization Phase 1b).
 *
 * A pointing is a saved query (tags ∪ parent subtrees ∪ explicit ids) plus an
 * autonomy class and a WIP limit. Given the open backlog, this module answers
 * two questions with no IO: which tasks a query matches, and what a capped,
 * UNORDERED candidate set over those matches looks like with the RFC's four
 * signals rendered as per-item flags — readiness, unblock-count, incident
 * lineage, days since touched.
 *
 * Nothing here scores or ranks (RFC 3ae937f0 §"Candidate sets are capped and
 * unordered, never scored"): the returned order is a seeded shuffle and is
 * labelled `ordering: "arbitrary"` so no consumer can lean on it.
 *
 * The DB shell that loads inputs and persists definitions is
 * `pointings-store.ts`; this file is what the unit tests exercise.
 */

import type { TaskAutonomyClass } from "./autonomy-class";
import { isTerminal } from "./workflows";
import type { PointingQuery } from "../storage/schemas/pointings-schema";

export type { PointingQuery } from "../storage/schemas/pointings-schema";
export {
  POINTING_AUTONOMY_CLASSES,
  type PointingAutonomyClass,
} from "../storage/schemas/pointings-schema";

// ─── Query normalization ──────────────────────────────────────────────────────

function cleanList(values: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const v of values ?? []) {
    const t = v.trim();
    if (t) out.add(t);
  }
  return [...out];
}

/** Trim, dedupe, and drop empty entries; the stored form of a query. */
export function normalizePointingQuery(query: PointingQuery): PointingQuery {
  const tags = cleanList(query.tags);
  const parentIds = cleanList(query.parentIds);
  const taskIds = cleanList(query.taskIds);
  const out: PointingQuery = {};
  if (tags.length) out.tags = tags;
  if (parentIds.length) out.parentIds = parentIds;
  if (taskIds.length) out.taskIds = taskIds;
  return out;
}

/** A query with no field is refused at declare time — it would match everything or nothing. */
export function isEmptyPointingQuery(query: PointingQuery): boolean {
  const n = normalizePointingQuery(query);
  return !n.tags && !n.parentIds && !n.taskIds;
}

// ─── Task rows and matching ───────────────────────────────────────────────────

/** The slice of a task the matcher and the flag computation need. */
export interface PointingTaskRow {
  id: string;
  title: string;
  status: string;
  kind: string;
  tags: string[];
  /** The task's parent id via a `parent` relationship, when it has one. */
  parentId: string | null;
  updatedAtMs: number;
  /** The spec's `Origin:` line, when present — the incident-lineage source besides the tag. */
  originLine: string | null;
}

/** Excluded from every candidate set: terminal, blocked, or a work package (ADR-046). */
export function isPointingCandidateRow(row: Pick<PointingTaskRow, "status" | "kind">): boolean {
  if (isTerminal(row.status)) return false;
  if (row.status === "BLOCKED") return false;
  if (row.kind === "work-package") return false;
  return true;
}

/**
 * Build the ancestor chain lookup from parent edges, so "under parent P"
 * means anywhere in P's subtree, not only a direct child.
 */
export function buildAncestorLookup(
  parentOf: ReadonlyMap<string, string>
): (taskId: string) => string[] {
  return (taskId) => {
    const chain: string[] = [];
    const seen = new Set<string>([taskId]);
    let cur = parentOf.get(taskId);
    while (cur !== undefined && !seen.has(cur)) {
      chain.push(cur);
      seen.add(cur);
      cur = parentOf.get(cur);
    }
    return chain;
  };
}

/** Union semantics: any tag, any ancestor, or an explicit id. */
export function taskMatchesPointingQuery(
  row: Pick<PointingTaskRow, "id" | "tags">,
  query: PointingQuery,
  ancestorsOf: (taskId: string) => string[]
): boolean {
  const q = normalizePointingQuery(query);
  if (q.taskIds?.includes(row.id)) return true;
  if (q.tags && row.tags.some((t) => q.tags?.includes(t))) return true;
  if (q.parentIds) {
    const ancestors = ancestorsOf(row.id);
    if (ancestors.some((a) => q.parentIds?.includes(a))) return true;
  }
  return false;
}

// ─── Candidate set ────────────────────────────────────────────────────────────

export interface CandidateSignals {
  /** task id → ids it depends on (all of them, terminal or not). */
  dependsOn: ReadonlyMap<string, readonly string[]>;
  /** status by id for every dependency referenced above. */
  statusOf: ReadonlyMap<string, string>;
  /** task id → number of OPEN tasks that depend on it. */
  openDependents: ReadonlyMap<string, number>;
}

export interface CandidateItem {
  id: string;
  title: string;
  status: string;
  /** Same formula as `tasks_available`: terminal deps / all deps, 1.0 with none. */
  readiness: number;
  unblockCount: number;
  incidentLineage: boolean;
  daysSinceTouched: number;
  /**
   * Computed autonomy class (mt#5130), when the caller supplied a classifier.
   * Annotation only — membership in a pointing never overrides the class, and
   * a `principal-gated` candidate is the principal's to pick, not an agent's.
   */
  autonomyClass?: TaskAutonomyClass;
}

export interface CandidateSet {
  /** Always "arbitrary" — the order is a seeded shuffle and carries no meaning. */
  ordering: "arbitrary";
  /** How many open tasks the query matched before the cap. */
  matched: number;
  truncated: boolean;
  cap: number;
  items: CandidateItem[];
}

export const CANDIDATE_CAP_MAX = 10;
const INCIDENT_TAG = "incident";
const MS_PER_DAY = 86_400_000;

/** mulberry32 — small, seedable; the shuffle is meant to be reproducible under test only. */
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

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** Same readiness formula as TaskRoutingService.findAvailableTasks. */
export function readinessOf(
  taskId: string,
  dependsOn: ReadonlyMap<string, readonly string[]>,
  statusOf: ReadonlyMap<string, string>
): number {
  const deps = dependsOn.get(taskId) ?? [];
  if (deps.length === 0) return 1;
  const terminal = deps.filter((d) => {
    const s = statusOf.get(d);
    return s !== undefined && isTerminal(s);
  }).length;
  return terminal / deps.length;
}

export function hasIncidentLineage(row: Pick<PointingTaskRow, "tags" | "originLine">): boolean {
  if (row.tags.includes(INCIDENT_TAG)) return true;
  return row.originLine !== null && /incident/i.test(row.originLine);
}

/**
 * Select the capped, unordered candidate set from the rows the query matched.
 * `seed` defaults to the clock so two calls differ in order; tests pass one.
 */
export function selectCandidates(
  matched: readonly PointingTaskRow[],
  signals: CandidateSignals,
  options: {
    cap?: number;
    seed?: number;
    nowMs?: number;
    /** Class per task id (mt#5130); items get `autonomyClass` only when supplied. */
    classOf?: (taskId: string) => TaskAutonomyClass | undefined;
  } = {}
): CandidateSet {
  const cap = Math.max(1, Math.min(options.cap ?? CANDIDATE_CAP_MAX, CANDIDATE_CAP_MAX));
  const nowMs = options.nowMs ?? Date.now();
  const seed = options.seed ?? Date.now();
  const picked = seededShuffle(matched, seed).slice(0, cap);
  const items: CandidateItem[] = picked.map((row) => {
    const item: CandidateItem = {
      id: row.id,
      title: row.title,
      status: row.status,
      readiness: readinessOf(row.id, signals.dependsOn, signals.statusOf),
      unblockCount: signals.openDependents.get(row.id) ?? 0,
      incidentLineage: hasIncidentLineage(row),
      daysSinceTouched: Math.max(0, Math.floor((nowMs - row.updatedAtMs) / MS_PER_DAY)),
    };
    const cls = options.classOf?.(row.id);
    if (cls) item.autonomyClass = cls;
    return item;
  });
  return {
    ordering: "arbitrary",
    matched: matched.length,
    truncated: matched.length > cap,
    cap,
    items,
  };
}
