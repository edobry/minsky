#!/usr/bin/env bun
/**
 * One-time backfill: close stale suspended/routed asks whose parent task is
 * terminal (mt#2760 — continuation of mt#2593's emit-site auto-close wiring).
 *
 * mt#2593 wired auto-close at the commit-success and PR-merge emit sites, but
 * pre-existing debris — `authorization.approve` / `quality.review` asks emitted
 * before that wiring, or into unscoped project state — remains `suspended`. Most
 * of it is UNSCOPED (`projectId = null`) and points at `mt#` tasks in the one
 * minsky task backend. This script closes the asks whose triggering task has
 * since reached a terminal state (DONE / CLOSED / COMPLETED), via the mt#2593
 * `closeAskAsResolved` primitive.
 *
 * Usage:
 *   bun scripts/backfill-close-stale-asks.ts --all-projects              # dry-run (default)
 *   bun scripts/backfill-close-stale-asks.ts --all-projects --execute    # apply
 *
 * Safety (CLAUDE.md §Operational Safety: Dry-Run First):
 *   - Dry-run by default; `--execute` required to mutate.
 *   - `--all-projects` is REQUIRED — this backfill operates across ALL project
 *     scopes (its target is the unscoped debris; the current project was already
 *     swept manually via mt#2747). Running without it is a no-op with guidance.
 *   - Only `authorization.approve` + `quality.review` kinds are considered;
 *     `direction.decide` and every other kind are NEVER closed (they may be live
 *     principal decisions).
 *   - Only asks whose parent task is VERIFIABLY terminal are closed. Asks with a
 *     non-terminal parent, a non-minsky (`gh#`) parent, an unknown/deleted parent,
 *     or no parent are REPORTED for manual triage, never closed.
 *   - Idempotent: already-terminal asks are no-ops (`closeAskAsResolved`).
 *
 * Output: human-readable summary + a JSON result block on stdout.
 *
 * @see mt#2760, mt#2593 (closeAskAsResolved), mt#2747 (current-project manual precedent)
 */

import "reflect-metadata";

import type { AskRepository } from "@minsky/domain/ask/repository";
import type { Ask, AskState } from "@minsky/domain/ask/types";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";

/** Ask kinds this backfill is allowed to close. Everything else is untouched. */
const TARGET_KINDS = new Set<string>(["authorization.approve", "quality.review"]);
/** Non-terminal states a stale ask may occupy (terminal states are already done). */
const OPEN_STATES: AskState[] = ["suspended", "routed"];
/** Task statuses that mean the ask's triggering event has resolved. */
const TERMINAL_TASK_STATUSES = new Set<string>(["DONE", "CLOSED", "COMPLETED"]);
/** Responder recorded on asks this backfill closes (audit trail). */
const RESPONDER = "system:backfill-parent-terminal";

interface Deps {
  askRepo: AskRepository;
  taskService: TaskServiceInterface;
}

async function bootstrap(): Promise<Deps> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
  const { DrizzleAskRepository } = await import("@minsky/domain/ask/repository");
  const { createConfiguredTaskService } = await import("@minsky/domain/tasks/taskService");

  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (!persistence || !(persistence instanceof PersistenceProvider)) {
    throw new Error("Backfill requires a SQL-capable persistence provider (Postgres).");
  }
  if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
    throw new Error("Backfill requires a SQL-capable persistence provider (Postgres).");
  }
  const connection = await persistence.getDatabaseConnection();
  if (!connection) {
    throw new Error("Backfill requires an initialized Postgres database connection.");
  }

  const askRepo = new DrizzleAskRepository(connection);
  const taskService = await createConfiguredTaskService({
    workspacePath: process.cwd(),
    persistenceProvider: persistence,
  });
  return { askRepo, taskService };
}

/** Disposition of a single candidate ask after classification. */
type Disposition =
  | "close" // parent task is terminal → close
  | "parent-active" // parent task is non-terminal → leave
  | "parent-unknown" // parent id not found among known tasks → leave (manual triage)
  | "non-minsky-parent" // gh#/other-backend parent, not resolved here → leave
  | "no-parent"; // ask carries no parentTaskId → leave

function classify(ask: Ask, statusById: Map<string, string>): Disposition {
  const tid = ask.parentTaskId;
  if (!tid) return "no-parent";
  if (!tid.startsWith("mt#")) return "non-minsky-parent";
  const status = statusById.get(tid);
  if (status === undefined) return "parent-unknown";
  return TERMINAL_TASK_STATUSES.has(status) ? "close" : "parent-active";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const execute = argv.includes("--execute");
  const allProjects = argv.includes("--all-projects");

  if (!allProjects) {
    console.log(
      "backfill-close-stale-asks: pass --all-projects to run.\n" +
        "  This backfill operates across ALL project scopes (its target is the unscoped\n" +
        "  debris; the current project was already swept via mt#2747). Add --execute to apply."
    );
    process.exit(0);
  }

  const { askRepo, taskService } = await bootstrap();

  // Build the task-status map once (all tasks incl. terminal) — the minsky backend
  // holds every mt# task the asks reference, so a single listTasks resolves them.
  const tasks = await taskService.listTasks({ all: true });
  const statusById = new Map<string, string>(tasks.map((t) => [t.id, t.status]));

  // Gather stale candidate asks: open states, target kinds, across all scopes
  // (listByState with no projectScope returns cross-project rows — ADR-021).
  const asksByState = await Promise.all(OPEN_STATES.map((s) => askRepo.listByState(s)));
  const candidates = asksByState.flat().filter((a) => TARGET_KINDS.has(a.kind));

  // Classify
  const buckets: Record<Disposition, Ask[]> = {
    close: [],
    "parent-active": [],
    "parent-unknown": [],
    "non-minsky-parent": [],
    "no-parent": [],
  };
  for (const a of candidates) buckets[classify(a, statusById)].push(a);

  const toClose = buckets.close;
  const closeByKind = new Map<string, number>();
  for (const a of toClose) closeByKind.set(a.kind, (closeByKind.get(a.kind) ?? 0) + 1);

  console.log(`backfill-close-stale-asks ${execute ? "(EXECUTE)" : "(dry-run)"} --all-projects`);
  console.log(`  candidate asks (suspended+routed, authz+review): ${candidates.length}`);
  console.log(`  → close (parent task terminal):     ${toClose.length}`);
  for (const [kind, n] of closeByKind) console.log(`      ${kind}: ${n}`);
  console.log(`  → leave, parent still active:       ${buckets["parent-active"].length}`);
  console.log(`  → leave, parent unknown/deleted:    ${buckets["parent-unknown"].length}`);
  console.log(`  → leave, non-minsky (gh#) parent:   ${buckets["non-minsky-parent"].length}`);
  console.log(`  → leave, no parent task:            ${buckets["no-parent"].length}`);

  let closed = 0;
  let skipped = 0;
  const errors: Array<{ askId: string; message: string }> = [];

  if (execute) {
    const { closeAskAsResolved } = await import("@minsky/domain/ask");
    for (const a of toClose) {
      const status = statusById.get(a.parentTaskId as string);
      try {
        const outcome = await closeAskAsResolved(askRepo, a.id, {
          responder: RESPONDER,
          payload: { parentTaskId: a.parentTaskId, taskStatus: status },
        });
        if (outcome.kind === "closed" || outcome.kind === "cancelled") closed += 1;
        else skipped += 1; // already-terminal / not-found / skipped (idempotent)
      } catch (err) {
        errors.push({ askId: a.id, message: err instanceof Error ? err.message : String(err) });
      }
    }
    console.log(
      `  closed=${closed} skipped=${skipped} errors=${errors.length} of ${toClose.length}`
    );
    for (const e of errors.slice(0, 10)) console.log(`    error ${e.askId}: ${e.message}`);
  } else {
    console.log(
      `  (dry-run — re-run with --execute to close the ${toClose.length} terminal-parent asks)`
    );
  }

  const result = {
    mode: execute ? "execute" : "dry-run",
    allProjects,
    candidates: candidates.length,
    wouldClose: toClose.length,
    closeByKind: Object.fromEntries(closeByKind),
    leaveParentActive: buckets["parent-active"].length,
    leaveParentUnknown: buckets["parent-unknown"].length,
    leaveNonMinskyParent: buckets["non-minsky-parent"].length,
    leaveNoParent: buckets["no-parent"].length,
    closed,
    skipped,
    errorCount: errors.length,
  };
  console.log(JSON.stringify(result));

  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(
    `backfill-close-stale-asks failed: ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
});
