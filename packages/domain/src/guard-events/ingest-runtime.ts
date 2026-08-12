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
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { inArray } from "drizzle-orm";
import { guardEventsTable, type GuardEventInsert } from "../storage/schemas/guard-events-schema";
import { conversationRunStateTable } from "../storage/schemas/conversation-run-state-schema";
import { GUARD_EVENT_STREAM_SOURCES, type GuardEventStreamSource } from "./stream-sources";
import { HWM_STATE_FILENAME, readHwmState, writeHwmState } from "./hwm-store";
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
 * signal every `location: "repo"` stream source is relative to. Mirrors
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

export function resolveStreamPath(
  source: GuardEventStreamSource,
  roots: { repoRoot: string; stateDir: string }
): string {
  return source.location === "repo"
    ? join(roots.repoRoot, source.relativePath)
    : join(roots.stateDir, source.relativePath);
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

function buildInsertBatch(db: PostgresJsDatabase): (rows: GuardEventInsertRow[]) => Promise<void> {
  return async (rows) => {
    if (rows.length === 0) return;
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
    for (const batch of chunk(inserts, INSERT_CHUNK_SIZE)) {
      await db.insert(guardEventsTable).values(batch).onConflictDoNothing({
        target: guardEventsTable.dedupeKey,
      });
    }
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
