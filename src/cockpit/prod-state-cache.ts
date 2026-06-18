/**
 * Prod-state cache (mt#2506) — the refresh/producer side of the hybrid
 * cached-injection mechanism for the R10 "no-tool-boundary status claim" seam.
 *
 * Tier-1 of mt#2485's reframe (mt#2488) gates consequential TOOL CALLS at the tool
 * boundary. R10 (family tracker `b0b294ab`, 2026-06-16) surfaced a sibling surface with
 * NO tool boundary: an objectively-verifiable factual claim about shared/PROD state, made
 * in a status report to the principal, that gates no tool call — e.g. "nothing has touched
 * prod" asserted without reading the prod migration ledger (it was false; migrations had
 * auto-applied).
 *
 * Per memory `08606f7c` ("Structural injection beats retrieval discipline"), the structural
 * fix for an action-time trigger that lives inside the agent's reasoning is to INJECT the
 * ground truth into every turn, not to instruct the agent to fetch it. BUT `08606f7c` also
 * bars churny/expensive per-turn injection (≤50ms): a per-turn query against the prod DB is
 * a network round-trip and fails that bar. So this is a HYBRID — mirroring `inject-git-state`
 * (mt#2275)'s "last-fetched" tradeoff:
 *
 *   - PRODUCER (this module): a periodic refresh (driven by the cockpit cadence sweep,
 *     `startProdStateRefreshSweeper` in server.ts) queries the prod migration ledger and
 *     writes a small local cache file.
 *   - CONSUMER (`.claude/hooks/inject-prod-state.ts`): a UserPromptSubmit hook reads ONLY
 *     the local cache (cheap, no network) and injects the snapshot — labelled with its
 *     last-checked age, and explicitly flagged when stale or absent.
 *
 * The write-side prod-mutation surfaces are already covered (tier-1 evidence gate mt#2488 +
 * unmerged-migration guard mt#2277); this closes the read-assertion side.
 *
 * @see mt#2506 — this task
 * @see .claude/hooks/inject-prod-state.ts — the consumer hook
 * @see memory 08606f7c — structural-injection rule; mt#2275 inject-git-state — sibling pattern
 */
import * as fs from "fs";
import * as path from "path";
import { getStateDir, atomicWriteJSON } from "./lifecycle";
import { log } from "@minsky/shared/logger";

/**
 * Cache filename under the Minsky state dir. The CONSUMER hook
 * (`.claude/hooks/inject-prod-state.ts`) hard-codes this same literal + the same state-dir
 * resolution (MINSKY_STATE_DIR / XDG_STATE_HOME/minsky / ~/.local/state/minsky); the hook
 * lives in a separate module graph and cannot import this constant. Keep the two in sync.
 */
export const PROD_STATE_CACHE_FILENAME = "prod-state-cache.json";

/** Absolute path to the prod-state cache file. */
export function getProdStateCachePath(): string {
  return path.join(getStateDir(), PROD_STATE_CACHE_FILENAME);
}

/**
 * The cached prod-state snapshot. Deliberately minimal — just enough to falsify a
 * "nothing has touched prod" claim: the count of applied migrations and the timestamp of
 * the most-recently-applied one.
 */
export interface ProdStateSnapshot {
  /** Total rows in `drizzle.__drizzle_migrations` (count of applied migrations). */
  ledgerRows: number;
  /** Epoch-ms of the most-recently-applied migration (`max(created_at)`), or null if empty/unknown. */
  latestAppliedAtMs: number | null;
}

/** The on-disk cache record: a snapshot plus when it was checked. */
export interface ProdStateCacheRecord extends ProdStateSnapshot {
  /** ISO-8601 timestamp of when this snapshot was read from the prod DB. */
  checkedAt: string;
}

/** Minimal raw-SQL surface needed to read the ledger (matches the persistence provider's `getRawSqlConnection()`). */
export interface UnsafeSql {
  unsafe: (query: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
}

/**
 * Read the prod migration ledger into a snapshot. Pure w.r.t. the injected `sql` — unit
 * tests pass a stub. Returns null when the ledger is unreadable (table absent, permission,
 * transient) so callers fail-open rather than writing a bogus cache.
 */
export async function buildProdStateSnapshot(sql: UnsafeSql): Promise<ProdStateSnapshot | null> {
  try {
    const rows = (await sql.unsafe(
      `SELECT count(*)::int AS total, max(created_at)::bigint AS latest_at
       FROM drizzle.__drizzle_migrations`
    )) as Array<{ total: number; latest_at: string | number | null }>;
    const row = rows?.[0];
    if (!row) return null;
    const ledgerRows = Number(row.total ?? 0);
    const latestRaw = row.latest_at;
    const latestAppliedAtMs =
      latestRaw === null || latestRaw === undefined ? null : Number(latestRaw);
    return {
      ledgerRows: Number.isFinite(ledgerRows) ? ledgerRows : 0,
      latestAppliedAtMs:
        latestAppliedAtMs !== null && Number.isFinite(latestAppliedAtMs) ? latestAppliedAtMs : null,
    };
  } catch {
    return null;
  }
}

/**
 * Write a snapshot to the cache file. `nowIso` is injected (callers stamp it) so this stays
 * deterministic for tests. Creates the state dir if needed. Returns true on success.
 */
export function writeProdStateCache(
  snapshot: ProdStateSnapshot,
  nowIso: string,
  cachePath: string = getProdStateCachePath()
): boolean {
  try {
    const dir = path.dirname(cachePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const record: ProdStateCacheRecord = { ...snapshot, checkedAt: nowIso };
    // Atomic temp+rename (handles crash mid-write + Windows rename semantics) via the
    // shared helper — a partial/corrupt cache would otherwise read back as UNKNOWN.
    atomicWriteJSON(cachePath, record);
    return true;
  } catch (err) {
    log.warn("prod-state-cache: failed to write cache", {
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Refresh the prod-state cache from a raw-SQL connection. Fail-open: a null/absent sql or an
 * unreadable ledger logs and returns false without touching the cache (so a transient DB
 * outage leaves the last-good snapshot in place rather than blanking it). `nowIso` is
 * injected for determinism.
 */
export async function refreshProdStateCache(
  sql: UnsafeSql | null | undefined,
  nowIso: string,
  cachePath?: string
): Promise<boolean> {
  if (!sql) {
    log.debug("prod-state-cache: no raw-SQL connection available; skipping refresh");
    return false;
  }
  const snapshot = await buildProdStateSnapshot(sql);
  if (!snapshot) {
    log.debug("prod-state-cache: ledger unreadable; leaving last-good cache in place");
    return false;
  }
  return writeProdStateCache(snapshot, nowIso, cachePath);
}
