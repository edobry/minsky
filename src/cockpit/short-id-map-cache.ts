/**
 * Short-id -> UUID map cache (mt#3914) — the impure PRODUCER half of the display
 * linkifier's short-id resolution. Mirrors `prod-state-cache.ts` (mt#2506) and
 * `topology-cache.ts` (mt#2602): a periodic refresh (driven by
 * `startShortIdMapSweeper` in sweepers.ts) does the expensive read once per
 * cadence tick and writes a small local file; the CONSUMER
 * (`.minsky/hooks/linkify-message-display.ts`) reads ONLY that file.
 *
 * ## Why the split is mandatory here, not merely preferable
 *
 * ADR-028 D7(5) routes "unbounded-latency network I/O inside a synchronous
 * dispatcher budget" to this cache+sweep precedent. For the MessageDisplay hook
 * the constraint is harder than latency: `domain-bootstrap.ts` caps a hook
 * process's Postgres connect at 2s while a measured cold connect from a
 * hook-shaped process is 4.3-5.5s (mt#3744 / mt#3879), so a DB read from hook
 * context does not resolve slowly — it resolves to null every time. And this is
 * the hottest event in the harness (once per batch of streamed lines, not once
 * per turn), so even a working connect would be the wrong shape.
 *
 * ## Why this cache has no staleness rendering, unlike prod-state
 *
 * A short id's binding to its UUID is immutable once minted. An out-of-date map
 * is therefore never WRONG, only incomplete — a ref minted since the last sweep
 * is absent and stays bare, which is the pre-mt#3914 behavior for every short
 * id. `inject-prod-state` has to render its snapshot's age because prod state
 * genuinely changes underneath it; nothing here does.
 *
 * @see mt#3914 — this task; mt#2565 — the linkifier this feeds
 * @see .minsky/hooks/linkify-message-display.ts — the consumer
 * @see src/cockpit/prod-state-cache.ts — the sibling pattern this mirrors
 * @see docs/architecture/adr-029-numeric-short-ids-foundation.md — UUID is the sole target
 */
import * as fs from "fs";
import * as path from "path";
import { getStateDir, atomicWriteJSON } from "./lifecycle";
import { describeSourceFailure } from "./source-failure-log";
import { log } from "@minsky/shared/logger";

/**
 * Cache filename under the Minsky state dir. The CONSUMER hook hard-codes this
 * same literal plus the same state-dir resolution; it lives in a separate module
 * graph and cannot import this constant. Keep the two in sync.
 */
export const SHORT_ID_MAP_CACHE_FILENAME = "short-id-map.json";

/** Absolute path to the short-id map cache file. */
export function getShortIdMapCachePath(): string {
  return path.join(getStateDir(), SHORT_ID_MAP_CACHE_FILENAME);
}

/**
 * The three uuid-keyed entity families that carry short ids (ADR-029), each
 * paired with the `minsky://` URI type its deeplink uses and the column holding
 * its UUID. Workspaces are read from the `sessions` table and emitted under the
 * `session` URI type — the deliberate ADR-022-stage-1 divergence recorded in
 * `cockpit-deeplinks.mdc`.
 *
 * Two things here are load-bearing and were both found by the live check
 * (`scripts/verify-short-id-map.ts`), not by the stub-injected unit tests:
 *
 *   - **`sessions` has no `id` column.** Its UUID is `session`, so the column is
 *     declared per family rather than assumed uniform. A `SELECT id` there fails
 *     the whole family query, which fails OPEN — `ws#N` would simply never link,
 *     with the empty result indistinguishable from "nothing to map".
 *   - **The schema qualifier is required.** Unqualified `sessions` also matches
 *     Supabase's `auth.sessions`, which DOES have an `id` — so an unqualified
 *     query can silently read the wrong table instead of erroring.
 */
const SHORT_ID_SOURCES = [
  { table: "public.asks", idColumn: "id", uriType: "ask" },
  { table: "public.memories", idColumn: "id", uriType: "memory" },
  { table: "public.sessions", idColumn: "session", uriType: "session" },
] as const;

export type ShortIdUriType = (typeof SHORT_ID_SOURCES)[number]["uriType"];

/** Numeric-part -> UUID, per URI type. `{ ask: { "7415": "<uuid>" } }`. */
export type ShortIdEntries = Partial<Record<ShortIdUriType, Record<string, string>>>;

/** The on-disk record: the map plus when it was built. */
export interface ShortIdMapRecord {
  /** Epoch-ms of the refresh that produced these entries. */
  refreshedAt: number;
  entries: ShortIdEntries;
}

/** Minimal raw-SQL surface (matches the persistence provider's `getRawSqlConnection()`). */
export interface UnsafeSql {
  unsafe: (query: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
}

/**
 * Strip the `<prefix>#` from a stored short id, returning the numeric part the
 * map is keyed by. Returns null for anything that is not `<letters>#<digits>` —
 * a malformed row is skipped rather than poisoning the map with a key the
 * consumer's `\b(ask|mem|ws)#(\d+)\b` pattern could never produce anyway.
 */
export function shortIdNumericPart(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const match = /^[a-z]+#(\d+)$/i.exec(raw.trim());
  return match ? (match[1] ?? null) : null;
}

/**
 * Read every (short_id, id) pair into a map. Pure w.r.t. the injected `sql`.
 * Returns null when the read fails, so callers leave the last-good map in place
 * rather than blanking it — the same fail-open `refreshProdStateCache` uses.
 *
 * One query per family rather than a UNION: the three tables are independent and
 * a failure in one should not cost the other two. A family that yields no usable
 * rows is simply absent from `entries`, which the consumer treats as "resolve
 * nothing for this type".
 */
export async function buildShortIdEntries(sql: UnsafeSql): Promise<ShortIdEntries | null> {
  const entries: ShortIdEntries = {};
  let anySucceeded = false;

  for (const source of SHORT_ID_SOURCES) {
    try {
      // Table and column names come from the const tuple above, never from input.
      const rows = (await sql.unsafe(
        `SELECT short_id, ${source.idColumn} AS uuid FROM ${source.table} WHERE short_id IS NOT NULL`
      )) as Array<{ short_id?: unknown; uuid?: unknown }>;
      const family: Record<string, string> = {};
      for (const row of rows ?? []) {
        const key = shortIdNumericPart(row.short_id);
        const uuid = row.uuid;
        if (key === null || typeof uuid !== "string" || uuid === "") continue;
        family[key] = uuid;
      }
      entries[source.uriType] = family;
      anySucceeded = true;
    } catch (err) {
      log.warn("short-id-map-cache: family query failed", {
        table: source.table,
        message: describeSourceFailure(err),
      });
    }
  }

  return anySucceeded ? entries : null;
}

/**
 * Write a map record to the cache file. `nowMs` is injected so this stays
 * deterministic for tests. Returns true on success.
 */
export function writeShortIdMapCache(
  entries: ShortIdEntries,
  nowMs: number,
  cachePath: string = getShortIdMapCachePath()
): boolean {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const record: ShortIdMapRecord = { refreshedAt: nowMs, entries };
    // Atomic temp+rename: the consumer reads this file inside the display path,
    // so a torn read would cost a message's linkification.
    atomicWriteJSON(cachePath, record);
    return true;
  } catch (err) {
    log.warn("short-id-map-cache: failed to write cache", {
      message: describeSourceFailure(err),
    });
    return false;
  }
}

/**
 * Refresh the short-id map from a raw-SQL connection. Fail-open: a null/absent
 * `sql` or a fully-failed read logs and returns false without touching the
 * cache, leaving the last-good map in place.
 */
export async function refreshShortIdMapCache(
  sql: UnsafeSql | null | undefined,
  nowMs: number,
  cachePath?: string
): Promise<boolean> {
  if (!sql) {
    log.warn("short-id-map-cache: no raw-SQL connection available; skipping refresh");
    return false;
  }
  const entries = await buildShortIdEntries(sql);
  if (!entries) return false;
  return writeShortIdMapCache(entries, nowMs, cachePath);
}
