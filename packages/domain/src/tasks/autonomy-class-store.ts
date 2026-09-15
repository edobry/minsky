/**
 * Bulk loader for the autonomy classifier's spec-derived inputs (mt#5130).
 *
 * `listTasks` returns no spec text and the classifier needs two sections per
 * candidate. `tasks_available` runs over the whole default population (868
 * tasks on 2026-09-13), so a per-candidate `getTaskSpecContent` would be ~870
 * queries per call and the full `content` column would be 6.3 MB. This loads
 * the `## Scope` and `## Summary` bodies (and the `Origin:` line) for a set of
 * ids in ONE query, section-exact via a Postgres ARE `substring(... from
 * pattern)` — measured at 418 KB + 779 KB across that same population before
 * the Summary cap.
 */

import { inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { taskSpecsTable } from "../storage/schemas/task-embeddings";
import {
  SPEC_ORIGIN_PATTERN,
  computeAutonomyClass,
  humanOriginFromChannel,
  specSectionPattern,
  type AutonomyClassResult,
  type AutonomySpecSignals,
} from "./autonomy-class";
import type { TaskOrigin } from "../provenance/types";

/** What a consumer needs from the DB to classify: spec sections by task id. */
export interface AutonomySignalSource {
  /** Ids absent from the result have no spec row — the classifier reads that as `unknown`. */
  loadSpecSignals(taskIds: readonly string[]): Promise<ReadonlyMap<string, AutonomySpecSignals>>;
}

/** Summary text beyond this is never needed for a marker match. */
export const SUMMARY_CAP_CHARS = 2000;

// The same pattern strings the TS extractor compiles — Postgres AREs accept
// this dialect (lookahead included), so one definition serves both paths.
const SCOPE_PATTERN = specSectionPattern("Scope");
const SUMMARY_PATTERN = specSectionPattern("Summary");
const ORIGIN_PATTERN = SPEC_ORIGIN_PATTERN;

/** Ids per IN-list; the default population fits in one, this keeps a pathological one bounded. */
const CHUNK = 2000;

export async function loadAutonomySpecSignals(
  db: PostgresJsDatabase,
  taskIds: readonly string[]
): Promise<Map<string, AutonomySpecSignals>> {
  const out = new Map<string, AutonomySpecSignals>();
  for (let i = 0; i < taskIds.length; i += CHUNK) {
    const ids = taskIds.slice(i, i + CHUNK);
    if (ids.length === 0) continue;
    const rows = await db
      .select({
        taskId: taskSpecsTable.taskId,
        scope: sql<string | null>`substring(${taskSpecsTable.content} from ${SCOPE_PATTERN})`,
        summary: sql<
          string | null
        >`substring(substring(${taskSpecsTable.content} from ${SUMMARY_PATTERN}) from 1 for ${SUMMARY_CAP_CHARS})`,
        origin: sql<string | null>`substring(${taskSpecsTable.content} from ${ORIGIN_PATTERN})`,
      })
      .from(taskSpecsTable)
      .where(inArray(taskSpecsTable.taskId, [...ids]));
    for (const r of rows) {
      out.set(r.taskId, {
        scope: r.scope ?? null,
        summary: r.summary ?? null,
        origin: r.origin ?? null,
      });
    }
  }
  return out;
}

export function createDbAutonomySignalSource(db: PostgresJsDatabase): AutonomySignalSource {
  return { loadSpecSignals: (ids) => loadAutonomySpecSignals(db, ids) };
}

/** The row fields the classifier reads — the subset of `Task` every consumer already has. */
export interface ClassifiableTask {
  id: string;
  kind?: string | null;
  status: string;
  tags?: readonly string[];
  title?: string;
  origin?: TaskOrigin | null;
}

/**
 * Classify a batch of task rows with ONE bulk signal load — the shape every
 * auto-selecting consumer runs (mt#5137).
 *
 * Extracted from `TaskRoutingService`'s private `classify` so the unattended
 * supervisor is not a third hand-rolled copy of "load the sections, then call
 * `computeAutonomyClass` with `humanOriginFromChannel`" — a consumer that
 * classified differently from `tasks_available` would dispatch what the other
 * withholds, which is the drift `umbrella-frontier.ts` names as the failure
 * this family exists to prevent. Without a `signalSource` every candidate not
 * gated by its row alone resolves `unknown` and is excluded: the RFC's
 * default-deny, applied to the signal itself.
 */
export async function classifyTasks(
  tasks: readonly ClassifiableTask[],
  signalSource: AutonomySignalSource | undefined
): Promise<Map<string, AutonomyClassResult>> {
  const signals = signalSource
    ? await signalSource.loadSpecSignals(tasks.map((t) => t.id))
    : undefined;
  const out = new Map<string, AutonomyClassResult>();
  for (const task of tasks) {
    out.set(
      task.id,
      computeAutonomyClass({
        id: task.id,
        kind: task.kind,
        status: task.status,
        tags: task.tags ?? [],
        title: task.title ?? "",
        spec: signals?.get(task.id),
        humanOrigin: humanOriginFromChannel(task.origin),
      })
    );
  }
  return out;
}
