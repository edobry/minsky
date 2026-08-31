/**
 * Real (non-test) IO/DB wiring for the guard/calibration exhaust ingest
 * (mt#4035, mt#3334 phase 3). Everything here is impure — filesystem, DB,
 * repo-root/state-dir resolution — kept OUT of `ingest-service.ts` so that
 * module stays testable with injected fakes.
 *
 * @see ingest-service.ts — the pure orchestration this feeds
 */
import { existsSync, statSync, openSync, readSync, closeSync, mkdirSync } from "node:fs";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { inArray } from "drizzle-orm";
import { guardEventsTable, type GuardEventInsert } from "../storage/schemas/guard-events-schema";
import { conversationRunStateTable } from "../storage/schemas/conversation-run-state-schema";
import { GUARD_EVENT_STREAM_SOURCES, type GuardEventStreamSource } from "./stream-sources";
import { HWM_STATE_FILENAME, readHwmState, writeHwmState } from "./hwm-store";
import { foldFireLogRowsIntoRollup } from "./fire-log-rollup";
import type { GuardEventsIngestDeps, GuardEventInsertRow } from "./ingest-service";

/** Batched inserts are chunked so one sweep tick never issues a single
 * multi-thousand-row INSERT statement (bounded statement size, not a
 * correctness requirement — ON CONFLICT DO NOTHING is safe at any batch size). */
const INSERT_CHUNK_SIZE = 500;

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.MINSKY_STATE_DIR;
  return dir && dir.trim().length > 0 ? dir : join(homedir(), ".local", "state", "minsky");
}

/**
 * Ascend from `startDir` looking for a `.minsky` directory — the repo-root
 * signal. Since mt#4816 no stream is relative to it (the `location: "repo"`
 * kind is retired); it survives because `projectStateKey` hashes it, so it is
 * what separates one managed project's calibration records from another's.
 * Mirrors
 * `findRepoRoot` (`src/cockpit/web-dist.ts`) in shape, but keyed on `.minsky`
 * rather than `src/cockpit/web` since `packages/domain` must not depend on
 * `src/` (layering: domain has no adapter-layer imports). Falls back to
 * `startDir` itself if no ancestor has `.minsky` (matches the cockpit
 * sweep's `findRepoRoot([process.cwd()]) ?? process.cwd()` fallback shape).
 */
export function resolveRepoRoot(startDir: string = process.cwd()): string {
  const MAX_ASCEND = 12;
  let dir = startDir;
  for (let i = 0; i < MAX_ASCEND; i++) {
    if (existsSync(join(dir, ".minsky"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

/**
 * Derive a stable, filesystem-safe key for a repo root so calibration/
 * evaluation streams from DIFFERENT Minsky-managed projects never collide in
 * the shared, machine-local state dir (mt#4748 SC1). Deterministic sha256
 * over the resolved absolute path — the same shape VS Code's
 * `workspaceStorage` keying uses, for the same reason.
 *
 * Duplicated (not imported) in `.minsky/hooks/dispatcher.ts` — the actual
 * WRITE side, which must derive the identical key from the identical
 * `repoRoot` input for the sweep below to ever find what the hook wrote.
 * Each module tree stays free of a dependency on the other by convention
 * (mirrors why `fire-log.ts` and `guard-health.ts` each carry their own
 * `getXStateDir`, rather than sharing one); this function's whole contract
 * is "same input -> same output", which a 3-line pure function duplicated
 * twice satisfies exactly as well as a shared import would.
 */
export function projectStateKey(repoRoot: string): string {
  return createHash("sha256").update(repoRoot).digest("hex").slice(0, 16);
}

export function resolveStreamPath(
  source: GuardEventStreamSource,
  roots: { repoRoot: string; stateDir: string }
): string {
  // mt#4816: the `location === "repo"` branch that stood here is GONE, together with the
  // `"repo"` member of `GuardEventStreamLocation` — `subagent-model-mismatch` was the last row
  // declaring it, and re-introducing one is now a type error rather than a grep's problem.
  // `roots.repoRoot` is still load-bearing below: it is the project key's input.
  //
  // mt#4748: calibration/evaluation streams are project-keyed within the
  // shared state dir (see `projectStateKey` above). Every OTHER state-dir
  // family (fire-log, guard-health-log, two-strikes, …) stays flat/global —
  // those are deliberately cross-project observability streams, not a repo-
  // scoped buffer, and project-scoping them is explicitly out of this task's
  // scope (mt#4748 spec's `project_id` schema-work carve-out).
  if (source.family === "calibration" || source.family === "evaluation") {
    return join(roots.stateDir, "projects", projectStateKey(roots.repoRoot), source.relativePath);
  }
  return join(roots.stateDir, source.relativePath);
}

function realReadTail(path: string, fromByte: number): { size: number; content: string } | null {
  if (!existsSync(path)) return null;
  const size = statSync(path).size;
  const start = fromByte > size ? 0 : fromByte;
  const length = size - start;
  if (length <= 0) return { size, content: "" };
  const fd = openSync(path, "r");
  try {
    // Uint8Array + TextDecoder rather than the `Buffer` global — this file is
    // typechecked under more than one project, and only one of them provides
    // full Node Buffer typings.
    const bytes = new Uint8Array(length);
    readSync(fd, bytes, 0, length, start);
    return { size, content: new TextDecoder("utf-8").decode(bytes) };
  } finally {
    closeSync(fd);
  }
}

function realReadWhole(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8").toString();
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Returns the count of rows ACTUALLY inserted (mt#4035 R1 — SC2
 * observability: distinguishing `read` candidates from rows that survived
 * ON CONFLICT DO NOTHING, so "swept and found nothing new" is visible as
 * `inserted: 0` rather than collapsing into the same shape as "never ran").
 * `.returning({ id })` is the same technique `memory-service.ts` /
 * `drizzle-session-repository.ts` already use to detect an
 * onConflictDoNothing no-op — a conflicting row is silently excluded from
 * the returned set, so `rows.length` after `.returning()` IS the real
 * insert count.
 */
/**
 * Exported for the mt#4294 integration test, which must exercise THIS function
 * rather than a re-implementation of it: the property under test is that the
 * append and the rollup fold share a transaction and that re-ingest folds
 * nothing, and a mirror of the insert in the test would be free to get both
 * right while this one got them wrong.
 */
export function buildInsertBatch(
  db: PostgresJsDatabase
): (rows: GuardEventInsertRow[]) => Promise<number> {
  return async (rows) => {
    if (rows.length === 0) return 0;
    const inserts: GuardEventInsert[] = rows.map((r) => ({
      stream: r.stream,
      family: r.family,
      guardName: r.guardName,
      sessionId: r.sessionId,
      projectId: r.projectId,
      occurredAt: r.occurredAt,
      decision: r.decision,
      event: r.event,
      durationMs: r.durationMs,
      payload: r.payload,
      dedupeKey: r.dedupeKey,
      sourcePath: r.sourcePath,
    }));
    let insertedCount = 0;
    for (const batch of chunk(inserts, INSERT_CHUNK_SIZE)) {
      // The append and the rollup fold share ONE transaction, and that is
      // load-bearing rather than tidiness (mt#4294).
      //
      // `ON CONFLICT (dedupe_key) DO NOTHING` makes the insert idempotent, so
      // the obvious "insert, then fold" shape looks safe and is not: if the
      // insert commits and the fold then throws, the rows exist in
      // `guard_events` but were never counted, and the RETRY re-inserts
      // nothing and therefore folds nothing. Those fires would be missing from
      // the rollup permanently, with no error left behind to notice — the
      // idempotency that protects the append is exactly what makes the gap
      // unrecoverable. Sharing a transaction means a failed fold rolls the
      // append back, so the retry genuinely re-does both.
      const returned = await db.transaction(async (tx) => {
        // RETURNING carries the three columns the rollup folds on, not just
        // `id` — the returned set is exactly the rows the insert actually
        // appended, which is what makes the rollup exact under re-ingest
        // rather than approximately-right.
        const rows = await tx
          .insert(guardEventsTable)
          .values(batch)
          .onConflictDoNothing({ target: guardEventsTable.dedupeKey })
          .returning({
            id: guardEventsTable.id,
            stream: guardEventsTable.stream,
            guardName: guardEventsTable.guardName,
            occurredAt: guardEventsTable.occurredAt,
          });
        await foldFireLogRowsIntoRollup(tx, rows);
        return rows;
      });
      insertedCount += returned.length;
    }
    return insertedCount;
  };
}

/**
 * Batch-resolve project ids for a set of distinct session ids by joining
 * `conversation_run_state` — the mt#3161 mechanism that already stamps
 * `project_id` per conversation from its observed `cwd`
 * (`resolveRunStateProjectId` precedent, `conversation-run-state/repository.ts`).
 * Reusing its OUTPUT here (one batched `IN (...)` query) avoids re-deriving
 * project identity from `cwd` a second time — guard/calibration records don't
 * carry `cwd` themselves, only `sessionId`, so this join IS "the record's
 * cwd/session project" the constraint asks for. ONE query for the whole
 * batch, never per-row (efficient-database-queries).
 */
function buildResolveProjectIds(
  db: PostgresJsDatabase
): (sessionIds: string[]) => Promise<Map<string, string | null>> {
  return async (sessionIds) => {
    const map = new Map<string, string | null>();
    if (sessionIds.length === 0) return map;
    const rows = await db
      .select({
        conversationId: conversationRunStateTable.conversationId,
        projectId: conversationRunStateTable.projectId,
      })
      .from(conversationRunStateTable)
      .where(inArray(conversationRunStateTable.conversationId, sessionIds));
    for (const row of rows) map.set(row.conversationId, row.projectId);
    return map;
  };
}

export interface GuardEventsIngestRuntimeOptions {
  env?: NodeJS.ProcessEnv;
  /** Override for tests/callers that already resolved a repo root. */
  repoRoot?: string;
  maxRecordsPerStreamPerTick?: number;
}

/**
 * Assemble the real (non-test) {@link GuardEventsIngestDeps} for a live DB
 * connection. Used by both invocation paths — the `guard-events.ingest`
 * CLI/MCP command and the cockpit daemon sweeper — so THE SAME sweep logic
 * runs from the SessionEnd hook (latency optimization) and the periodic
 * sweep (the correctness layer, per ADR-017/mt#2313).
 */
export function buildGuardEventsIngestDeps(
  db: PostgresJsDatabase,
  options: GuardEventsIngestRuntimeOptions = {}
): GuardEventsIngestDeps {
  const env = options.env ?? process.env;
  const stateDir = resolveStateDir(env);
  const repoRoot = options.repoRoot ?? resolveRepoRoot();
  const hwmPath = join(stateDir, HWM_STATE_FILENAME);

  const fsDeps = {
    existsSync,
    readFileSync: (p: string) => readFileSync(p, "utf-8").toString(),
    writeFileSync: (p: string, content: string) => writeFileSync(p, content, "utf-8"),
    mkdirSync: (p: string) => mkdirSync(p, { recursive: true }),
  };

  return {
    streams: GUARD_EVENT_STREAM_SOURCES,
    resolvePath: (source) => resolveStreamPath(source, { repoRoot, stateDir }),
    readTail: realReadTail,
    readWhole: realReadWhole,
    readHwm: () => readHwmState(hwmPath, fsDeps),
    writeHwm: (state) => writeHwmState(hwmPath, state, fsDeps),
    insertBatch: buildInsertBatch(db),
    resolveProjectIds: buildResolveProjectIds(db),
    maxRecordsPerStreamPerTick: options.maxRecordsPerStreamPerTick,
  };
}
