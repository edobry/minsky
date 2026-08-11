/**
 * Ask-state cache (mt#3744) — the impure PRODUCER half of the calibration-review
 * cadence detector's disposition-state lookup. Mirrors `prod-state-cache.ts`
 * (mt#2506) and `short-id-map-cache.ts` (mt#3914): a periodic refresh (driven by
 * `startAskStateRefreshSweeper` in sweepers.ts) does the database read once per
 * cadence tick and writes a small local file; the CONSUMER
 * (`.minsky/hooks/calibration-review-cadence-detector.ts`) reads ONLY that file.
 *
 * ## Why the split
 *
 * ADR-028 D7(5) routes "unbounded-latency network I/O inside a synchronous
 * dispatcher budget" to this cache+sweep precedent. The detector previously
 * called `ensureHookDomainBootstrap()` -> `resolvePersistenceProvider()` from
 * hook context to read each pending ask's state. Measured cold connect from a
 * hook-shaped process is 2.5-5.5s (mt#3879) against this guard's declared
 * `timeoutMs: 10000` — so a single lookup could consume most of the guard's
 * budget, and the dispatcher writes every guard's injections in ONE end-of-loop
 * write (mt#3757), which is what makes one slow guard a whole-turn risk.
 *
 * ## Which asks are cached
 *
 * Exactly the ids the consumer will ask about: the `openAskId` values in
 * `.minsky/calibration-review-watermarks.json`, the same repo-local file the
 * detector reads to decide which logs are review-due. Caching "all open asks"
 * would not work — the detector's whole job is to notice an ask that has become
 * SETTLED, so a settled ask must be present WITH its state, not absent. And
 * caching all 7.8k asks to guarantee that would trade a bounded ~14-entry file
 * for a ~600KB one, re-parsed on every render.
 *
 * An id the producer looked up and did not find is written as `{ found: false }`
 * rather than omitted: omission is reserved for "the producer never asked about
 * this id", which is a different fault the consumer renders differently.
 *
 * @see mt#3744 — this task
 * @see .minsky/hooks/calibration-review-cadence-detector.ts — the consumer
 * @see src/cockpit/prod-state-cache.ts — the sibling pattern this mirrors
 * @see docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md D7(5)
 */
import * as fs from "fs";
import * as path from "path";
import { getStateDir, atomicWriteJSON } from "./lifecycle";
import { log } from "@minsky/shared/logger";

/**
 * Cache filename under the Minsky state dir. The CONSUMER hook hard-codes this
 * same literal plus the same state-dir resolution; it lives in a separate module
 * graph and cannot import this constant. Keep the two in sync.
 */
export const ASK_STATE_CACHE_FILENAME = "ask-state-cache.json";

/** Absolute path to the ask-state cache file. */
export function getAskStateCachePath(): string {
  return path.join(getStateDir(), ASK_STATE_CACHE_FILENAME);
}

/**
 * Repo-relative path of the watermark store the ask ids come from. Same literal
 * the detector uses (`WATERMARK_STORE_PATH` there); duplicated for the same
 * separate-module-graph reason as the cache filename above.
 */
export const WATERMARK_STORE_RELPATH = ".minsky/calibration-review-watermarks.json";

/**
 * Ask states in which the operator genuinely still owes a response. MUST match
 * the consumer's understanding — which is why `open` is precomputed here and
 * written into the record, so the hook needs no policy knowledge of its own and
 * the two cannot drift.
 */
export const OPEN_ASK_STATES: ReadonlySet<string> = new Set(["routed", "suspended"]);

/** One resolved ask, or the record that it was looked up and not found. */
export type AskStateEntry =
  | { found: true; state: string; open: boolean; shortId?: string }
  | { found: false };

/** The on-disk cache record: the resolved entries plus when they were read. */
export interface AskStateCacheRecord {
  /** ISO-8601 timestamp of when these entries were read from the database. */
  checkedAt: string;
  /** Ask UUID -> entry. Every requested id is present; absence means "never asked". */
  asks: Record<string, AskStateEntry>;
}

/** Minimal raw-SQL surface (matches the persistence provider's `getRawSqlConnection()`). */
export interface UnsafeSql {
  unsafe: (query: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
}

/** Canonical UUID shape, used to reject anything that would fail the `::uuid[]` cast. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Collect the distinct `openAskId` values out of a parsed watermark store. Pure
 * over the parsed value so it unit-tests without a filesystem, and tolerant of
 * every malformed shape the file can take — it is hand-edited by the
 * `/calibration-review` skill and gitignored, so it is not schema-guaranteed.
 *
 * Non-UUID ids are dropped rather than passed through: they cannot be a real ask
 * id, and a single bad value would fail the `::uuid[]` cast for the whole batch,
 * turning one malformed entry into a total lookup failure.
 */
export function collectWatermarkAskIds(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const ids = new Set<string>();
  for (const value of Object.values(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const askId = (value as { openAskId?: unknown }).openAskId;
    if (typeof askId !== "string") continue;
    const trimmed = askId.trim();
    if (UUID_PATTERN.test(trimmed)) ids.add(trimmed);
  }
  return [...ids];
}

/**
 * Read the watermark store from `repoRoot` and collect its ask ids. Returns an
 * empty array when the file is absent or unparseable — both mean "no pending
 * dispositions to resolve", which is also the ordinary steady state (the file
 * carries `openAskId` only between a calibration review and its disposition).
 */
export function readWatermarkAskIds(repoRoot: string): string[] {
  const watermarkPath = path.join(repoRoot, WATERMARK_STORE_RELPATH);
  try {
    if (!fs.existsSync(watermarkPath)) return [];
    // `String(...)` around the read: the root tsconfig's fs typings widen every readFileSync
    // overload to `string | Buffer`, which JSON.parse rejects. Same idiom as
    // `mcp-probe-history.ts` and `schema-readiness.ts` in this directory.
    return collectWatermarkAskIds(JSON.parse(String(fs.readFileSync(watermarkPath, "utf-8"))));
  } catch (err) {
    log.warn("ask-state-cache: watermark store unreadable", {
      path: watermarkPath,
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * Resolve each requested ask id into an entry. Pure w.r.t. the injected `sql` —
 * unit tests pass a stub. Returns null when the query fails, so callers leave
 * the last-good snapshot in place rather than blanking it (the same fail-open
 * `refreshProdStateCache` uses).
 *
 * An empty `askIds` returns an EMPTY MAP, not null: "the producer asked about
 * nothing" is a successful refresh, and writing it is what lets the consumer
 * distinguish a covered-but-empty snapshot from a stalled producer.
 */
export async function buildAskStateSnapshot(
  sql: UnsafeSql,
  askIds: string[]
): Promise<Record<string, AskStateEntry> | null> {
  if (askIds.length === 0) return {};
  try {
    const rows = (await sql.unsafe(
      "SELECT id, state, short_id FROM public.asks WHERE id = ANY($1::uuid[])",
      [askIds]
    )) as Array<{ id?: unknown; state?: unknown; short_id?: unknown }>;

    // Seed every requested id as not-found, then overwrite the ones the query
    // returned. This is what makes "looked up and absent from the database"
    // distinguishable from "never looked up" downstream.
    const asks: Record<string, AskStateEntry> = {};
    for (const id of askIds) asks[id] = { found: false };

    for (const row of rows ?? []) {
      const id = row.id;
      const state = row.state;
      if (typeof id !== "string" || typeof state !== "string") continue;
      const shortId = typeof row.short_id === "string" ? row.short_id : undefined;
      asks[id] = {
        found: true,
        state,
        open: OPEN_ASK_STATES.has(state),
        ...(shortId ? { shortId } : {}),
      };
    }
    return asks;
  } catch (err) {
    log.warn("ask-state-cache: ask query failed", {
      askCount: askIds.length,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Write a snapshot to the cache file. `nowIso` is injected (callers stamp it) so
 * this stays deterministic for tests. Returns true on success.
 */
export function writeAskStateCache(
  asks: Record<string, AskStateEntry>,
  nowIso: string,
  cachePath: string = getAskStateCachePath()
): boolean {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const record: AskStateCacheRecord = { checkedAt: nowIso, asks };
    // Atomic temp+rename: a torn file would parse as a plausible snapshot with
    // some asks missing, which the consumer would render as "not in snapshot".
    atomicWriteJSON(cachePath, record);
    return true;
  } catch (err) {
    log.warn("ask-state-cache: failed to write cache", {
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Refresh the ask-state cache from a raw-SQL connection. Fail-open: a null/absent
 * `sql` or a failed query logs and returns false without touching the cache, so a
 * transient DB outage leaves the last-good snapshot (which the consumer will then
 * render as stale) rather than blanking it into "no snapshot exists".
 */
export async function refreshAskStateCache(
  sql: UnsafeSql | null | undefined,
  askIds: string[],
  nowIso: string,
  cachePath?: string
): Promise<boolean> {
  if (!sql) {
    log.warn("ask-state-cache: no raw-SQL connection available; skipping refresh");
    return false;
  }
  const asks = await buildAskStateSnapshot(sql, askIds);
  // buildAskStateSnapshot already logged the specific failure reason.
  if (!asks) return false;
  return writeAskStateCache(asks, nowIso, cachePath);
}
