/**
 * The operator's surface onto the unattended task supervisor (mt#4571).
 *
 * Three commands, one each for the three things a person needs:
 *
 *  - `tasks.supervise` — the ONE action mt#4571 SC1 is about: start supervising
 *    an umbrella and walk away.
 *  - `tasks.supervision-status` — SC8's read surface and AT5's query: what is
 *    dispatched, what is it waiting on, has it stalled.
 *  - `tasks.supervise-stop` — stop dispatching further children.
 *
 * The tick itself runs in the cockpit daemon
 * (`src/cockpit/task-supervision-sweep.ts`); these commands only write and read
 * the supervision record. That split is deliberate: a command runs in whatever
 * process invoked it and exits, so it cannot be the thing that outlives the
 * operator's tab — which is the whole capability being added.
 *
 * @see packages/domain/src/supervision/supervision-store.ts
 * @see packages/domain/src/supervision/supervision-tick.ts
 */
import { z } from "zod";
import {
  DEFAULT_SUPERVISION_STATUS_FILTER,
  DEFAULT_SUPERVISION_WIP_LIMIT,
  DrizzleSupervisionStore,
} from "@minsky/domain/supervision/supervision-store";
import {
  SUPERVISION_STALL_THRESHOLD_MS,
  isSupervisionStalled,
} from "@minsky/domain/supervision/supervision-tick";
import type { DispatchView, SupervisionView } from "@minsky/domain/supervision/types";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { type CommandParameterMap, type InferParams } from "../../command-registry";

/** Resolve a supervision store from the persistence provider, or throw a readable error. */
async function getStore(getPersistenceProvider: () => unknown): Promise<DrizzleSupervisionStore> {
  const provider = getPersistenceProvider() as SqlCapablePersistenceProvider | null;
  const db = await provider?.getDatabaseConnection?.();
  if (!db) {
    throw new Error(
      "Task supervision requires a PostgreSQL backend with Drizzle ORM; no SQL-capable connection is available."
    );
  }
  return new DrizzleSupervisionStore(db as PostgresJsDatabase<Record<string, unknown>>);
}

const superviseParams = {
  taskId: {
    schema: z.string(),
    description: "Umbrella task ID to supervise (e.g. mt#4553)",
    required: true,
  },
  status: {
    schema: z.string().optional(),
    description:
      "Child statuses the supervisor treats as dispatchable (comma-separated). Default: " +
      `${DEFAULT_SUPERVISION_STATUS_FILTER.join(",")}. Stated explicitly rather than inherited ` +
      "from tasks_orchestrate's TODO-only default, which would silently skip every already-planned child.",
    required: false,
  },
  wipLimit: {
    schema: z.number().int().positive().optional(),
    description:
      `Maximum concurrently-dispatched children. Default ${DEFAULT_SUPERVISION_WIP_LIMIT}, which is the ` +
      "observed maximum per-umbrella concurrency over the 60 days to 2026-08-25 (median 1, p90 1, p95 2, max 4).",
    required: false,
  },
  model: {
    schema: z.string().optional(),
    description:
      "Dispatch model alias for the children (e.g. sonnet). Omitted -> the claude binary's own default.",
    required: false,
  },
} satisfies CommandParameterMap;

const supervisionTargetParams = {
  taskId: {
    schema: z.string(),
    description: "Umbrella task ID",
    required: true,
  },
} satisfies CommandParameterMap;

/** Shape returned by `tasks.supervision-status`, and by `tasks.supervise` for its new record. */
export interface SupervisionStatusReport {
  umbrellaTaskId: string;
  supervisionId: string;
  status: SupervisionView["status"];
  statusFilter: string[];
  wipLimit: number;
  model: string | null;
  lastTickAt: string | null;
  lastAdvanceAt: string | null;
  /** Why the last tick dispatched nothing — what it is waiting on (AT5). */
  waitingOn: string | null;
  /**
   * True when the tick is healthy but nothing has advanced past the threshold
   * (SC9). Distinct from a dead tick, which `/api/sweeps` already reports.
   */
  stalled: boolean;
  stallThresholdHours: number;
  inFlight: Array<{ taskId: string; drivenSessionLocalId: string | null; dispatchedAt: string }>;
  /** Every dispatch this supervision made, newest first — SC10's visible record. */
  dispatches: Array<{
    taskId: string;
    status: DispatchView["status"];
    drivenSessionLocalId: string | null;
    minskySessionId: string | null;
    dispatchedAt: string;
  }>;
}

function toReport(
  supervision: SupervisionView,
  dispatches: DispatchView[],
  now: Date
): SupervisionStatusReport {
  return {
    umbrellaTaskId: supervision.umbrellaTaskId,
    supervisionId: supervision.id,
    status: supervision.status,
    statusFilter: supervision.statusFilter,
    wipLimit: supervision.wipLimit,
    model: supervision.model,
    lastTickAt: supervision.lastTickAt?.toISOString() ?? null,
    lastAdvanceAt: supervision.lastAdvanceAt?.toISOString() ?? null,
    waitingOn: supervision.lastHoldReason,
    stalled: supervision.status === "active" && isSupervisionStalled(supervision, now),
    stallThresholdHours: SUPERVISION_STALL_THRESHOLD_MS / (60 * 60 * 1000),
    inFlight: dispatches
      .filter((d) => d.status === "dispatched")
      .map((d) => ({
        taskId: d.taskId,
        drivenSessionLocalId: d.drivenSessionLocalId,
        dispatchedAt: d.dispatchedAt.toISOString(),
      })),
    dispatches: dispatches.map((d) => ({
      taskId: d.taskId,
      status: d.status,
      drivenSessionLocalId: d.drivenSessionLocalId,
      minskySessionId: d.minskySessionId,
      dispatchedAt: d.dispatchedAt.toISOString(),
    })),
  };
}

/** Human-readable rendering. Pure — report in, string out, no IO. */
export function formatSupervisionStatus(report: SupervisionStatusReport): string {
  const lines: string[] = [];
  lines.push(`${report.umbrellaTaskId}: supervision ${report.status}`);
  lines.push(
    `  dispatchable statuses: ${report.statusFilter.join(", ")}   WIP limit: ${report.wipLimit}${
      report.model ? `   model: ${report.model}` : ""
    }`
  );
  lines.push(
    `  last tick: ${report.lastTickAt ?? "never"}   last advance: ${report.lastAdvanceAt ?? "never"}`
  );
  if (report.waitingOn) lines.push(`  waiting on: ${report.waitingOn}`);
  if (report.stalled) {
    // Deliberately loud, and deliberately NOT the same statement as a dead
    // tick: the tick is running fine and has moved nothing.
    lines.push(
      `  STALLED — the tick is alive but nothing has advanced in over ${report.stallThresholdHours}h`
    );
  }

  lines.push("");
  if (report.inFlight.length === 0) {
    lines.push("  In flight: none");
  } else {
    lines.push(`  In flight (${report.inFlight.length}):`);
    for (const d of report.inFlight) {
      lines.push(
        `    ${d.taskId}  since ${d.dispatchedAt}  session ${d.drivenSessionLocalId ?? "-"}`
      );
    }
  }

  const settled = report.dispatches.filter((d) => d.status !== "dispatched");
  if (settled.length > 0) {
    lines.push("");
    lines.push(`  Settled (${settled.length}):`);
    for (const d of settled) {
      lines.push(`    ${d.taskId}  ${d.status}  session ${d.drivenSessionLocalId ?? "-"}`);
    }
  }

  return lines.join("\n");
}

export function createTasksSuperviseCommand(getPersistenceProvider: () => unknown) {
  return {
    id: "tasks.supervise",
    name: "supervise",
    description:
      "Start walking an umbrella's task DAG unattended: the cockpit daemon dispatches each child " +
      "as its dependencies clear, up to a WIP limit, with no further operator input. The " +
      "supervisor dispatches only — it never merges, answers asks, or changes scope.",
    parameters: superviseParams,
    execute: async (params: InferParams<typeof superviseParams>) => {
      const store = await getStore(getPersistenceProvider);
      const umbrellaTaskId = params.taskId as string;

      const statusFilter = params.status
        ? (params.status as string)
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
        : [...DEFAULT_SUPERVISION_STATUS_FILTER];

      const { supervision, created } = await store.createSupervision({
        umbrellaTaskId,
        statusFilter,
        wipLimit: (params.wipLimit as number | undefined) ?? DEFAULT_SUPERVISION_WIP_LIMIT,
        model: (params.model as string | undefined) ?? null,
      });

      const dispatches = await store.listDispatches(supervision.id);
      const report = toReport(supervision, dispatches, new Date());

      return {
        success: true,
        created,
        ...report,
        output: created
          ? `${umbrellaTaskId}: supervision started. The cockpit daemon will dispatch children as they unblock.\n\n${formatSupervisionStatus(report)}`
          : // Not an error: the partial unique index makes at-most-one-active a
            // database guarantee, so a second call is a no-op with a report.
            `${umbrellaTaskId}: already under supervision.\n\n${formatSupervisionStatus(report)}`,
      };
    },
  };
}

export function createTasksSupervisionStatusCommand(getPersistenceProvider: () => unknown) {
  return {
    id: "tasks.supervision-status",
    name: "supervision-status",
    description:
      "Report an umbrella's supervision: what is dispatched right now, what the supervisor is " +
      "waiting on, every child it has started and how each finished, and whether it has stalled.",
    parameters: supervisionTargetParams,
    execute: async (params: InferParams<typeof supervisionTargetParams>) => {
      const store = await getStore(getPersistenceProvider);
      const umbrellaTaskId = params.taskId as string;

      const supervision = await store.getLatestSupervision(umbrellaTaskId);
      if (!supervision) {
        return {
          success: true,
          umbrellaTaskId,
          supervised: false,
          output: `${umbrellaTaskId}: not supervised. Start one with tasks_supervise.`,
        };
      }

      const dispatches = await store.listDispatches(supervision.id);
      const report = toReport(supervision, dispatches, new Date());
      return {
        success: true,
        supervised: true,
        ...report,
        output: formatSupervisionStatus(report),
      };
    },
  };
}

export function createTasksSuperviseStopCommand(getPersistenceProvider: () => unknown) {
  return {
    id: "tasks.supervise-stop",
    name: "supervise-stop",
    description:
      "Stop supervising an umbrella. Children already dispatched keep running — they are " +
      "ordinary driven sessions doing real work, and killing them would discard uncommitted " +
      "output. Stopping means the supervisor dispatches nothing further.",
    parameters: supervisionTargetParams,
    execute: async (params: InferParams<typeof supervisionTargetParams>) => {
      const store = await getStore(getPersistenceProvider);
      const umbrellaTaskId = params.taskId as string;

      const stopped = await store.stopSupervision(umbrellaTaskId);
      if (!stopped) {
        return {
          success: true,
          umbrellaTaskId,
          stopped: false,
          output: `${umbrellaTaskId}: no active supervision to stop.`,
        };
      }

      const dispatches = await store.listDispatches(stopped.id);
      const stillRunning = dispatches.filter((d) => d.status === "dispatched");
      return {
        success: true,
        umbrellaTaskId,
        stopped: true,
        stillRunning: stillRunning.map((d) => d.taskId),
        output: `${umbrellaTaskId}: supervision stopped.${
          stillRunning.length > 0
            ? ` ${stillRunning.length} already-dispatched child(ren) keep running: ${stillRunning
                .map((d) => d.taskId)
                .join(", ")}`
            : ""
        }`,
      };
    },
  };
}
