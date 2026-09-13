/**
 * Work-package lifecycle sweep (mt#5132; mt#5122 SC1/SC2/SC4; succession RFC
 * `3a0937f0` §Lifecycle "claims self-stale" + Correction 2 "a terminal state
 * is required").
 *
 * Two repairs that keep a package's status honest, in one pass:
 *
 *  1. CLOSE — a READY or IN-PROGRESS package whose every member is terminal
 *     (DONE / CLOSED per `isTerminal`) goes DONE with a `completed` transfer
 *     naming the members. A package with ZERO member rows is reported and
 *     never closed: an empty member set is vacuously "all terminal", and
 *     closing on it would retire a package that was never populated.
 *
 *  2. RELEASE — an IN-PROGRESS package whose claim is older than the
 *     staleness window AND whose claimant has shown no presence inside that
 *     window returns to READY via `releaseWorkPackage`. The claimant's
 *     liveness is read from `presence_claims` (refreshed on every
 *     task-bearing tool call), not from process liveness: the sweep runs on
 *     the ops host, which has no local processes to probe, and a `proc:`
 *     actor id is a one-way hash of the MCP daemon process that cannot be
 *     inverted to a pid. BOTH halves are required — a fresh claim is kept
 *     even with no presence yet (the claimant may not have made a
 *     task-bearing call), and fresh presence keeps a claim of any age.
 *
 * The decision is pure (`planPackageLifecycleSweep`) so the tests pin it
 * without a database; the store below loads three tables and applies the plan
 * through the CAS writes in `work-package-lifecycle.ts` / `work-package-claim.ts`,
 * so a package that moves between plan and apply is refused, never clobbered.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { tasksTable } from "../storage/schemas/task-embeddings";
import { presenceClaimsTable } from "../storage/schemas/presence-claims-schema";
import { workPackageMembersTable } from "../storage/schemas/work-package-schema";
import { isTerminal } from "./workflows";
import { releaseWorkPackage, WORK_PACKAGE_KIND } from "./work-package-claim";
import { completeWorkPackage } from "./work-package-lifecycle";

/**
 * How long a claim may sit without its holder showing presence before the
 * sweep releases it. An active conversation refreshes presence within minutes
 * on every task-bearing call; the longest live gap is an overnight laptop
 * sleep (<14h). A false release costs the holder one re-claim; a missed
 * release leaves a package IN-PROGRESS and invisible to the pointing surface —
 * the RFC accepts the first direction of error.
 */
export const CLAIM_STALE_MS = 24 * 60 * 60 * 1000;

/** The statuses the sweep reads; TODO packages are not yet in the pool. */
export const SWEEPABLE_STATUSES = ["READY", "IN-PROGRESS"] as const;

export interface SweepMember {
  id: string;
  /** `null` when the member row points at a task that no longer exists. */
  status: string | null;
}

export interface SweepPackage {
  id: string;
  status: string;
  claimedBy: string | null;
  claimedAtMs: number | null;
  members: SweepMember[];
  /** Latest `presence_claims.last_refreshed_at` attributable to the claimant; `null` = none. */
  lastPresenceMs: number | null;
}

export type PackageCloseDecision =
  | { action: "close"; memberIds: string[] }
  | { action: "keep"; reason: "zero-members" }
  | { action: "keep"; reason: "open-members"; openMembers: string[] };

/** Criterion 1's predicate: every member terminal, and at least one member. */
export function decidePackageSweep(members: readonly SweepMember[]): PackageCloseDecision {
  if (members.length === 0) return { action: "keep", reason: "zero-members" };
  const open = members.filter((m) => !isTerminal(m.status ?? undefined)).map((m) => m.id);
  if (open.length > 0) return { action: "keep", reason: "open-members", openMembers: open };
  return { action: "close", memberIds: members.map((m) => m.id) };
}

export type ClaimReleaseDecision =
  | { action: "release"; reason: "no-presence" | "stale-presence" }
  | { action: "keep"; reason: "claim-fresh" | "presence-fresh" };

/**
 * Criterion 4's predicate. `claimedAtMs === null` (a legacy claim with no
 * timestamp) cannot be shown fresh, so only the presence half can keep it.
 */
export function decideClaimRelease(args: {
  claimedAtMs: number | null;
  lastPresenceMs: number | null;
  nowMs: number;
  staleMs?: number;
}): ClaimReleaseDecision {
  const staleMs = args.staleMs ?? CLAIM_STALE_MS;
  const cutoff = args.nowMs - staleMs;
  if (args.claimedAtMs !== null && args.claimedAtMs > cutoff) {
    return { action: "keep", reason: "claim-fresh" };
  }
  if (args.lastPresenceMs === null) return { action: "release", reason: "no-presence" };
  if (args.lastPresenceMs > cutoff) return { action: "keep", reason: "presence-fresh" };
  return { action: "release", reason: "stale-presence" };
}

export interface LifecyclePlan {
  close: Array<{ id: string; status: string; memberIds: string[] }>;
  release: Array<{
    id: string;
    claimedBy: string | null;
    claimedAt: string | null;
    lastPresenceAt: string | null;
    reason: "no-presence" | "stale-presence";
  }>;
  keep: Array<{ id: string; status: string; reason: string; detail?: string[] }>;
  zeroMembers: string[];
}

/** The pure plan over loaded rows. Close wins over release: completing clears the claim too. */
export function planPackageLifecycleSweep(
  packages: readonly SweepPackage[],
  options: { nowMs: number; staleMs?: number }
): LifecyclePlan {
  const plan: LifecyclePlan = { close: [], release: [], keep: [], zeroMembers: [] };
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

  for (const pkg of packages) {
    const closeDecision = decidePackageSweep(pkg.members);
    if (closeDecision.action === "close") {
      plan.close.push({ id: pkg.id, status: pkg.status, memberIds: closeDecision.memberIds });
      continue;
    }
    if (closeDecision.reason === "zero-members") plan.zeroMembers.push(pkg.id);

    if (pkg.status === "IN-PROGRESS") {
      const releaseDecision = decideClaimRelease({
        claimedAtMs: pkg.claimedAtMs,
        lastPresenceMs: pkg.lastPresenceMs,
        nowMs: options.nowMs,
        staleMs: options.staleMs,
      });
      if (releaseDecision.action === "release") {
        plan.release.push({
          id: pkg.id,
          claimedBy: pkg.claimedBy,
          claimedAt: iso(pkg.claimedAtMs),
          lastPresenceAt: iso(pkg.lastPresenceMs),
          reason: releaseDecision.reason,
        });
        continue;
      }
      plan.keep.push({
        id: pkg.id,
        status: pkg.status,
        reason: `${closeDecision.reason}; ${releaseDecision.reason}`,
        ...(closeDecision.reason === "open-members" ? { detail: closeDecision.openMembers } : {}),
      });
      continue;
    }

    plan.keep.push({
      id: pkg.id,
      status: pkg.status,
      reason: closeDecision.reason,
      ...(closeDecision.reason === "open-members" ? { detail: closeDecision.openMembers } : {}),
    });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface LifecycleSweepOptions {
  /** Apply the plan; `false` (the default everywhere) reports it. */
  execute?: boolean;
  nowMs?: number;
  staleMs?: number;
  /** Names the caller in transfer notes — `cli` or `ops-loop`. */
  via: string;
}

export interface LifecycleSweepResult {
  dryRun: boolean;
  plan: LifecyclePlan;
  applied: {
    closed: string[];
    released: string[];
    /** CAS refusals — the package moved between plan and apply. */
    refused: Array<{ id: string; op: "close" | "release"; reason: string }>;
  };
}

/** The `:conv:<id>` tail of a conversation-scoped agent id, if the claim carries one. */
export function conversationIdOfClaim(claimedBy: string | null): string | null {
  if (!claimedBy) return null;
  const m = /:conv:([0-9a-fA-F-]{36})$/.exec(claimedBy);
  return m?.[1] ?? null;
}

async function loadPackages(db: PostgresJsDatabase): Promise<SweepPackage[]> {
  const rows = await db
    .select({
      id: tasksTable.id,
      status: tasksTable.status,
      claimedBy: tasksTable.claimedBy,
      claimedAt: tasksTable.claimedAt,
    })
    .from(tasksTable)
    .where(
      and(
        eq(tasksTable.kind, WORK_PACKAGE_KIND),
        inArray(tasksTable.status, [...SWEEPABLE_STATUSES])
      )
    );
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  const memberRows = await db
    .select({
      packageTaskId: workPackageMembersTable.packageTaskId,
      memberTaskId: workPackageMembersTable.memberTaskId,
      status: tasksTable.status,
    })
    .from(workPackageMembersTable)
    .leftJoin(tasksTable, eq(tasksTable.id, workPackageMembersTable.memberTaskId))
    .where(inArray(workPackageMembersTable.packageTaskId, ids));
  const membersByPackage = new Map<string, SweepMember[]>();
  for (const m of memberRows) {
    const list = membersByPackage.get(m.packageTaskId) ?? [];
    list.push({ id: m.memberTaskId, status: m.status === null ? null : String(m.status) });
    membersByPackage.set(m.packageTaskId, list);
  }

  // Presence: one query per identity axis. A `proc:` claim is matched on
  // actor_id alone; a `conv:` claim is also matched on the conversation id the
  // presence writer stamps, since the two can name the same conversation
  // through different ids (mem#952).
  const actorIds = rows.map((r) => r.claimedBy).filter((v): v is string => !!v);
  const convIds = rows
    .map((r) => conversationIdOfClaim(r.claimedBy))
    .filter((v): v is string => !!v);
  const byActor = new Map<string, number>();
  const byConv = new Map<string, number>();
  if (actorIds.length > 0) {
    const presence = await db
      .select({
        actorId: presenceClaimsTable.actorId,
        last: sql<Date | string>`max(${presenceClaimsTable.lastRefreshedAt})`,
      })
      .from(presenceClaimsTable)
      .where(inArray(presenceClaimsTable.actorId, actorIds))
      .groupBy(presenceClaimsTable.actorId);
    for (const p of presence) byActor.set(p.actorId, new Date(p.last).getTime());
  }
  if (convIds.length > 0) {
    const presence = await db
      .select({
        convId: presenceClaimsTable.ccConversationId,
        last: sql<Date | string>`max(${presenceClaimsTable.lastRefreshedAt})`,
      })
      .from(presenceClaimsTable)
      .where(inArray(presenceClaimsTable.ccConversationId, convIds))
      .groupBy(presenceClaimsTable.ccConversationId);
    for (const p of presence) {
      if (p.convId) byConv.set(p.convId, new Date(p.last).getTime());
    }
  }

  return rows.map((r) => {
    const convId = conversationIdOfClaim(r.claimedBy);
    const candidates = [
      r.claimedBy ? byActor.get(r.claimedBy) : undefined,
      convId ? byConv.get(convId) : undefined,
    ].filter((v): v is number => typeof v === "number");
    return {
      id: r.id,
      status: String(r.status ?? ""),
      claimedBy: r.claimedBy,
      claimedAtMs: r.claimedAt ? new Date(r.claimedAt).getTime() : null,
      members: membersByPackage.get(r.id) ?? [],
      lastPresenceMs: candidates.length > 0 ? Math.max(...candidates) : null,
    };
  });
}

/** The sweep: plan over the live rows, apply when asked. */
export async function runWorkPackageLifecycleSweep(
  db: PostgresJsDatabase,
  options: LifecycleSweepOptions
): Promise<LifecycleSweepResult> {
  const nowMs = options.nowMs ?? Date.now();
  const packages = await loadPackages(db);
  const plan = planPackageLifecycleSweep(packages, { nowMs, staleMs: options.staleMs });
  const applied: LifecycleSweepResult["applied"] = { closed: [], released: [], refused: [] };
  if (options.execute !== true) return { dryRun: true, plan, applied };

  const now = new Date(nowMs);
  for (const c of plan.close) {
    const outcome = await completeWorkPackage(
      db,
      {
        taskId: c.id,
        notes:
          `Completed by the package-lifecycle sweep (mt#5132, via ${options.via}): every member ` +
          `terminal — ${c.memberIds.join(", ")}.`,
      },
      now
    );
    if (outcome.ok) applied.closed.push(c.id);
    else applied.refused.push({ id: c.id, op: "close", reason: outcome.reason });
  }
  for (const r of plan.release) {
    const outcome = await releaseWorkPackage(
      db,
      {
        taskId: r.id,
        byConversation: null,
        notes:
          `Released by the package-lifecycle sweep (mt#5132, via ${options.via}): claim by ` +
          `${r.claimedBy ?? "(unrecorded)"} at ${r.claimedAt ?? "(unknown)"} with ${
            r.reason === "no-presence"
              ? "no presence recorded for the claimant"
              : `the claimant's last presence at ${r.lastPresenceAt}`
          }.`,
      },
      now
    );
    if (outcome.ok) applied.released.push(r.id);
    else applied.refused.push({ id: r.id, op: "release", reason: outcome.reason });
  }
  return { dryRun: false, plan, applied };
}
