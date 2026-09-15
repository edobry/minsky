/**
 * tasks.pointings.* — standing-pointing commands (mt#5129, Prioritization Phase 1b).
 *
 * A pointing is a saved query over fields that exist today (tags, parent
 * subtrees, explicit ids) plus an autonomy class and a WIP limit. Phase 1
 * ships the definition and ONE read: a capped (≤10), explicitly unordered
 * candidate set with the RFC's four signals as per-item flags. No pull, no
 * queue, no score (RFC 3ae937f0).
 *
 * `declare` and `archive` are principal-facing writes — pointings are the
 * principal's to declare. "Standing pointing" is a placeholder; no user-facing
 * label is introduced here.
 *
 * Tools registered:
 *   tasks_pointings_declare     — declare a pointing (refuses an empty query).
 *   tasks_pointings_list        — list live pointings (archived on request).
 *   tasks_pointings_archive     — archive a pointing (never deleted).
 *   tasks_pointings_candidates  — the capped, unordered candidate set for one pointing.
 */

import { z } from "zod";
import { defineCommand, CommandCategory } from "../../command-registry";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
import { ValidationError, getLoggableErrorSummary } from "@minsky/domain/errors/index";
import { log } from "@minsky/shared/logger";
import { readScopeToProjectScope, resolveReadScope } from "@minsky/domain/project/read-scope";
import { ALL_PROJECTS, type ProjectScope } from "@minsky/domain/project/scope";
import { POINTING_AUTONOMY_CLASSES, CANDIDATE_CAP_MAX } from "@minsky/domain/tasks/pointings";
import {
  archivePointing,
  computeCandidateSet,
  declarePointing,
  getPointing,
  listPointings,
} from "@minsky/domain/tasks/pointings-store";
import {
  resurrectForPointing,
  runRemainderSweep,
} from "@minsky/domain/tasks/remainder-expiry-store";
import { REMAINDER_AGE_DAYS } from "@minsky/domain/tasks/remainder-expiry";

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

async function getDb(getPersistenceProvider: () => unknown) {
  const provider = getPersistenceProvider() as SqlCapablePersistenceProvider | undefined;
  if (!provider?.getDatabaseConnection) {
    throw new ValidationError(
      "Pointings require the SQL persistence provider, which is not available."
    );
  }
  const db = await provider.getDatabaseConnection();
  if (!db) throw new ValidationError("Could not obtain a database connection for pointings.");
  return db;
}

/**
 * Same resolution as tasks.similar: an explicit `workspace` outranks the process cwd
 * (mt#5155); with none, an unresolved cwd identity widens to ALL_PROJECTS.
 */
async function resolveScope(
  db: unknown,
  caller: string,
  workspace: string | undefined
): Promise<ProjectScope> {
  try {
    return readScopeToProjectScope(await resolveReadScope({ workspace }, db, caller));
  } catch (err) {
    log.debug(`[${caller}] Project scope resolution failed; defaulting to ALL_PROJECTS`, {
      error: getLoggableErrorSummary(err),
    });
    return ALL_PROJECTS;
  }
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const pointingIdParam = {
  schema: z.string(),
  description: "Pointing id (uuid) as returned by tasks.pointings.declare / list",
  required: true,
} as const;

// ---------------------------------------------------------------------------
// tasks.pointings.declare
// ---------------------------------------------------------------------------

const declareParams = {
  workspace: {
    schema: z.string().optional(),
    description:
      "Workspace path whose project this applies to; defaults to the process cwd (mt#5155)",
    required: false,
  },
  name: {
    schema: z.string().min(1),
    description: "Short name for the pointing; unique among live pointings in the project",
    required: true,
  },
  tags: {
    schema: z.string().optional(),
    description: "Comma-separated tags; a task matches if it carries ANY of them",
    required: false,
  },
  parentIds: {
    schema: z.string().optional(),
    description:
      'Comma-separated task ids; a task matches if it sits anywhere under any of them (e.g. "mt#3483")',
    required: false,
  },
  taskIds: {
    schema: z.string().optional(),
    description: "Comma-separated explicit task ids to include",
    required: false,
  },
  autonomyClass: {
    schema: z.enum(POINTING_AUTONOMY_CLASSES).optional(),
    description: `The class agents may pull at (Phase 2). One of ${POINTING_AUTONOMY_CLASSES.join(", ")}; default pull-only`,
    required: false,
  },
  wipLimit: {
    schema: z.number().int().min(1).optional(),
    description: "Pull-time WIP bound (Phase 2 admission control); default 1",
    required: false,
  },
} as const;

export function createTasksPointingsDeclareCommand(getPersistenceProvider: () => unknown) {
  return defineCommand({
    id: "tasks.pointings.declare",
    category: CommandCategory.TASKS,
    name: "declare",
    description:
      "Declare a standing pointing: a saved query (tags, parent subtrees, explicit ids — unioned) " +
      "plus an autonomy class and a WIP limit. Pointings are the principal's to declare. " +
      "Refuses an empty query.",
    parameters: declareParams,

    async execute(params) {
      const db = await getDb(getPersistenceProvider);
      const projectScope = await resolveScope(db, "tasks.pointings.declare", params.workspace);
      const outcome = await declarePointing(db, {
        name: params.name,
        query: {
          tags: splitList(params.tags),
          parentIds: splitList(params.parentIds),
          taskIds: splitList(params.taskIds),
        },
        autonomyClass: params.autonomyClass,
        wipLimit: params.wipLimit,
        projectScope,
      });
      if (!outcome.ok) {
        return { success: false, reason: outcome.reason, message: outcome.message };
      }
      // A pointing declared AFTER a park brings its parked tasks back in the
      // same call (mt#5131), not on the next sweep tick. Best-effort: a
      // failure here leaves the pointing declared and is reported, never
      // thrown — the next tick resurrects the same rows.
      let resurrected: string[] = [];
      let resurrectionError: string | undefined;
      try {
        resurrected = await resurrectForPointing(db, outcome.pointing);
      } catch (err) {
        resurrectionError = getLoggableErrorSummary(err);
        log.warn("[tasks.pointings.declare] resurrection after declare failed", {
          pointingId: outcome.pointing.id,
          error: resurrectionError,
        });
      }
      return {
        success: true,
        pointing: outcome.pointing,
        resurrected,
        ...(resurrectionError ? { resurrectionError } : {}),
        message: `Pointing "${outcome.pointing.name}" declared (${outcome.pointing.id}).`,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// tasks.pointings.list
// ---------------------------------------------------------------------------

const listParams = {
  workspace: {
    schema: z.string().optional(),
    description:
      "Workspace path whose project this applies to; defaults to the process cwd (mt#5155)",
    required: false,
  },
  includeArchived: {
    schema: z.boolean().optional(),
    description: "Include archived pointings (hidden by default)",
    required: false,
  },
} as const;

export function createTasksPointingsListCommand(getPersistenceProvider: () => unknown) {
  return defineCommand({
    id: "tasks.pointings.list",
    category: CommandCategory.TASKS,
    name: "list",
    description: "List the project's standing pointings (live by default).",
    parameters: listParams,

    async execute(params) {
      const db = await getDb(getPersistenceProvider);
      const projectScope = await resolveScope(db, "tasks.pointings.list", params.workspace);
      const pointings = await listPointings(db, {
        projectScope,
        includeArchived: params.includeArchived ?? false,
      });
      return { success: true, count: pointings.length, pointings };
    },
  });
}

// ---------------------------------------------------------------------------
// tasks.pointings.archive
// ---------------------------------------------------------------------------

export function createTasksPointingsArchiveCommand(getPersistenceProvider: () => unknown) {
  return defineCommand({
    id: "tasks.pointings.archive",
    category: CommandCategory.TASKS,
    name: "archive",
    description:
      "Archive a standing pointing. The row is kept (never deleted) so its history stays citable.",
    parameters: { id: pointingIdParam } as const,

    async execute(params) {
      const db = await getDb(getPersistenceProvider);
      const outcome = await archivePointing(db, params.id);
      if (!outcome.ok) return { success: false, reason: outcome.reason, message: outcome.message };
      return {
        success: true,
        pointing: outcome.pointing,
        message: `Pointing "${outcome.pointing.name}" archived.`,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// tasks.pointings.candidates
// ---------------------------------------------------------------------------

const candidatesParams = {
  id: pointingIdParam,
  cap: {
    schema: z.number().int().min(1).optional(),
    description: `Maximum items returned; default ${CANDIDATE_CAP_MAX}, and larger values are clamped to ${CANDIDATE_CAP_MAX}`,
    required: false,
  },
} as const;

export function createTasksPointingsCandidatesCommand(getPersistenceProvider: () => unknown) {
  return defineCommand({
    id: "tasks.pointings.candidates",
    category: CommandCategory.TASKS,
    name: "candidates",
    description:
      "The capped, UNORDERED candidate set for a pointing: open tasks its query matches, each " +
      "carrying four flags — readiness, unblockCount, incidentLineage, daysSinceTouched — plus " +
      "its computed autonomyClass (principal-gated / pull-only / contained / unknown; a " +
      "principal-gated candidate is the principal's to pick, never auto-selected). The " +
      'order is a shuffle and means nothing (ordering: "arbitrary"); an empty set is the ' +
      "signal a pointing is done.",
    parameters: candidatesParams,

    async execute(params) {
      const db = await getDb(getPersistenceProvider);
      const pointing = await getPointing(db, params.id);
      if (!pointing) {
        return {
          success: false,
          reason: "not-found",
          message: `No pointing with id ${params.id}.`,
        };
      }
      const set = await computeCandidateSet(db, pointing, { cap: params.cap });
      return { success: true, ...set };
    },
  });
}

// ---------------------------------------------------------------------------
// tasks.expire-remainder (mt#5131)
// ---------------------------------------------------------------------------

const expireRemainderParams = {
  workspace: {
    schema: z.string().optional(),
    description:
      "Workspace path whose project this applies to; defaults to the process cwd (mt#5155)",
    required: false,
  },
  execute: {
    schema: z.boolean().default(false),
    defaultValue: false,
    description:
      "Apply the plan. Default is a dry-run that prints the park and resurrect id lists and " +
      "writes nothing. The first --execute is a bulk shared-state mutation: run it under its " +
      "wrapper task (mt#5138) after comparing the dry-run against the recorded count.",
    required: false,
  },
  cap: {
    schema: z.number().int().min(0).optional(),
    description:
      "Maximum parks this run (resurrection is never capped). Omitted = uncapped; the ops loop " +
      "passes its own cap.",
    required: false,
  },
} as const;

export function createTasksExpireRemainderCommand(getPersistenceProvider: () => unknown) {
  return defineCommand({
    id: "tasks.expire-remainder",
    category: CommandCategory.TASKS,
    name: "expire-remainder",
    description:
      `The backlog remainder's disposition (RFC 3ae937f0 Phase 1, mt#5131): open tasks untouched ` +
      `${REMAINDER_AGE_DAYS}+ days and matching NO live standing pointing are parked — CLOSED, tagged ` +
      "auto-expired, spec annotated — and parked tasks a live pointing now matches are reopened " +
      "(CLOSED -> TODO). Dry-run by default. With zero live pointings nothing is parked: the plan " +
      "reports what WOULD park under parkingSuspended.",
    parameters: expireRemainderParams,

    async execute(params) {
      const db = await getDb(getPersistenceProvider);
      const projectScope = await resolveScope(db, "tasks.expire-remainder", params.workspace);
      const result = await runRemainderSweep(db, {
        projectScope,
        execute: params.execute === true,
        cap: params.cap,
        via: "cli",
      });
      return {
        success: true,
        dryRun: result.dryRun,
        parkingSuspended: result.plan.parkingSuspended,
        pointingIds: result.plan.pointingIds,
        counts: {
          wouldPark: result.plan.wouldPark.length,
          park: result.plan.park.length,
          resurrect: result.plan.resurrect.length,
          parked: result.applied.parked.length,
          resurrected: result.applied.resurrected.length,
        },
        capped: result.plan.capped,
        park: result.plan.park,
        wouldPark: result.plan.wouldPark,
        resurrect: result.plan.resurrect,
        applied: result.applied,
      };
    },
  });
}
