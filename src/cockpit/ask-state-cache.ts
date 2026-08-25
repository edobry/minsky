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
 * Exactly the ids the consumers will ask about, from TWO bounded sources
 * (mt#3564 added the second; see `collectAllTrackedAskIds`):
 *
 *   1. The `openAskId` values in `.minsky/calibration-review-watermarks.json` —
 *      the same repo-local file the calibration detector reads to decide which
 *      logs are review-due.
 *   2. The ask ids in the conversation-attribution map written by
 *      `.minsky/hooks/stamp-ask-conversation.ts`, which the answered-ask
 *      injection hook joins against.
 *
 * Caching "all open asks" would not work for EITHER consumer — both exist to
 * notice an ask that has become SETTLED, so a settled ask must be present WITH
 * its state, not absent. And caching all 7.8k asks to guarantee that would trade
 * a bounded file for a ~600KB one, re-parsed on every render. Both sources stay
 * bounded at their own origin: the watermark file carries an `openAskId` only
 * between a review and its disposition (~14 entries), and the attribution map
 * prunes itself to 7 days / 200 entries on every write.
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
import { safeTruncate } from "@minsky/shared/safe-truncate";
// mt#4014: type-only, erased at build — see OPEN_ASK_STATES below.
import type { AskState } from "@minsky/domain/ask/types";

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
// mt#4014: typed against `AskState` so a typo is a compile error. The MEMBERSHIP
// is deliberately narrower than "non-terminal" and is NOT widened here — per the
// docstring above, `detected`/`classified` are pre-routing (nobody owes anything
// yet) and `responded` means the answer already arrived. Binding the type and
// choosing the membership are independent decisions; only the first was missing.
//
// `import type` is erased at compile time, so this does NOT reintroduce the
// runtime module-graph coupling the value-duplication comments above avoid.
// Constructed as `Set<AskState>` so the members are checked; exposed as
// `ReadonlySet<string>` so callers can look up a raw DB value without a cast.
export const OPEN_ASK_STATES: ReadonlySet<string> = new Set<AskState>(["routed", "suspended"]);

/**
 * One resolved ask, or the record that it was looked up and not found.
 *
 * mt#3564 added `title`, `respondedAt` and `chosen` to the found variant. They are
 * OPTIONAL and additive: the original consumer
 * (`calibration-review-cadence-detector.ts`) reads only `state`/`open`/`shortId` and is
 * unaffected, while `inject-ask-responses.ts` needs enough to render a notice without a
 * second lookup — the whole point of the cache is that the hook does no IO of its own.
 */
export type AskStateEntry =
  | {
      found: true;
      state: string;
      open: boolean;
      shortId?: string;
      /** Ask title, for rendering the notice (mt#3564). */
      title?: string;
      /** ISO-8601 `responded_at`, absent while the ask is still open (mt#3564). */
      respondedAt?: string;
      /**
       * The operator's chosen option, rendered to a short string (mt#3564).
       *
       * Read off `response.payload`, which is `unknown` in the schema and in practice
       * holds either the option `value` string or a small object. Anything that is not
       * already a string is JSON-stringified and truncated — this field is display
       * text, never something a consumer should parse back.
       */
      chosen?: string;
      /**
       * ISO-8601 timestamp at which this ask's answer was already delivered to its
       * filing conversation through the TOOL-CALL seam (mt#4476) — the `drained_at`
       * of its CONVERSATION-keyed `wake_pending` row. Absent when no wake was written
       * (the ask predates mt#4476, or was filed with no resolvable conversation
       * identity) or when one was written but not yet drained.
       *
       * Two mt#4517 narrowings, both load-bearing for the consumer:
       * SESSION-keyed rows are excluded — they were delivered to a workspace session,
       * a different addressee, and reading them here suppressed the prompt seam for
       * an answer no conversation ever saw. And `drained_at` now marks only payloads
       * that were actually RENDERED into a block, not merely claimed, so this
       * timestamp means "an agent saw it" rather than "a row was touched".
       *
       * This is the cross-seam dedupe, and it has to travel through this cache
       * because the two seams cannot share a watermark directly: mt#3564's hook
       * deliberately touches no DB (mem#672 — DB-writing hooks die silently at
       * bootstrap), while the tool-call drain happens inside the MCP server process,
       * which under ADR-038 may be a shared daemon and under an HTTP deployment is
       * not co-located with the hook at all. The cockpit sweep is the one component
       * holding both a DB connection and a line to the hook's cache file, so the
       * watermark crosses here.
       */
      wakeDeliveredAt?: string;
    }
  | { found: false };

/**
 * Cap on the rendered `chosen` string. The consumer injects into a per-turn context
 * budget (`MERGED_CONTEXT_BUDGET_CHARS`), so an unbounded operator response would let
 * one answer crowd out every other injection — including, at the limit, this notice
 * itself. Truncation happens HERE rather than in the hook so the cache file is bounded
 * on disk too.
 */
export const MAX_CHOSEN_CHARS = 100;

/**
 * Render `response.payload` into short display text. Exported for direct unit testing:
 * the payload column is `unknown`, so this is the one place that decides what an
 * arbitrary operator response looks like in a notice.
 */
export function renderChosen(payload: unknown): string | undefined {
  if (payload === null || payload === undefined) return undefined;
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  if (typeof text !== "string" || text.length === 0) return undefined;
  // safeTruncate, not slice: an operator's answer is free-form prose and routinely
  // carries emoji and non-BMP punctuation, so a raw slice can split a surrogate pair
  // and emit a lone half — which lands in an agent's context as a replacement char.
  // "head" is explicit and load-bearing: safeTruncate DEFAULTS to "tail", which keeps
  // the END of the string — the opposite of what a preview needs.
  return text.length > MAX_CHOSEN_CHARS ? `${safeTruncate(text, MAX_CHOSEN_CHARS, "head")}…` : text;
}

/**
 * Normalize a timestamp column to ISO-8601, or undefined when it is null/unparseable.
 * `postgres-js` returns a `Date` for `timestamptz`; the stub in the unit tests returns
 * a string. Both are accepted so the tests exercise the same code path production does.
 */
export function toIsoOrUndefined(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value !== "string" || value.length === 0) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Second id source: conversation-attributed asks (mt#3564)
// ---------------------------------------------------------------------------

/**
 * Filename of the ask -> conversation attribution map written by
 * `.minsky/hooks/stamp-ask-conversation.ts`.
 *
 * DUPLICATED, deliberately, exactly as `ASK_STATE_CACHE_FILENAME` above is duplicated
 * into its consumer hook: the hooks tree is a separate module graph from `src/`, so the
 * constant cannot be imported in either direction. Keep the two in sync.
 */
export const ASK_CONVERSATION_MAP_FILENAME = "ask-conversation-map.json";

/** Absolute path to the attribution map. */
export function getAskConversationMapPath(): string {
  return path.join(getStateDir(), ASK_CONVERSATION_MAP_FILENAME);
}

/**
 * Collect the ask ids the attribution map knows about — the SECOND id source this
 * producer resolves, alongside the calibration watermarks.
 *
 * Why the producer needs them: the injection consumer's whole job is to notice an ask
 * that has become ANSWERED, so a settled ask must appear in the snapshot WITH its state
 * rather than be absent. That is the same requirement the watermark ids already impose,
 * which is why this extends the existing pipeline instead of adding a second one.
 *
 * The set stays bounded at the SOURCE: the map prunes to 7 days / 200 entries when it
 * is written, so this cannot reintroduce the "cache all 7.8k asks" cost this module's
 * header rejects.
 */
export function collectAttributedAskIds(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const entries = (parsed as { entries?: unknown }).entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return [];
  const ids = new Set<string>();
  for (const askId of Object.keys(entries as Record<string, unknown>)) {
    const trimmed = askId.trim();
    if (UUID_PATTERN.test(trimmed)) ids.add(trimmed);
  }
  return [...ids];
}

/**
 * Read the attribution map and collect its ask ids. Empty on an absent or unparseable
 * file — both mean "nothing attributed yet", which is the steady state before the first
 * ask is filed on a machine.
 */
export function readAttributedAskIds(mapPath: string = getAskConversationMapPath()): string[] {
  try {
    if (!fs.existsSync(mapPath)) return [];
    return collectAttributedAskIds(JSON.parse(String(fs.readFileSync(mapPath, "utf-8"))));
  } catch (err) {
    log.warn("ask-state-cache: ask-conversation map unreadable", {
      path: mapPath,
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * The producer's full id set: calibration watermarks UNION conversation attributions,
 * de-duplicated. Both consumers read the one snapshot, so a single ask appearing in
 * both sources is looked up once.
 */
export function collectAllTrackedAskIds(repoRoot: string, mapPath?: string): string[] {
  return [...new Set([...readWatermarkAskIds(repoRoot), ...readAttributedAskIds(mapPath)])];
}

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
    // The correlated subquery carries the cross-seam dedupe (mt#4476). It is a
    // subquery rather than a second round-trip because this runs per sweep over the
    // whole tracked id-set — a per-ask lookup would be the N+1 shape
    // `efficient-database-queries.mdc` exists to prevent.
    const rows = (await sql.unsafe(
      "SELECT a.id, a.state, a.short_id, a.title, a.responded_at, a.response, " +
        // Scoped to CONVERSATION-keyed rows (mt#4517 SC4). The consumer of this field is
        // the prompt-seam hook, which runs inside a conversation, so only a wake that
        // reached a conversation is evidence that seam's notice would be a duplicate. A
        // drained SESSION-keyed row was delivered to a workspace session — a different
        // addressee — and suppressing on it hid the answer at both seams at once.
        "(SELECT max(w.drained_at) FROM public.wake_pending w " +
        // `a.id::text`, not a bare `=`. `asks.id` is `uuid` and
        // `wake_pending.ask_id` is `text` (that table takes plain text refs by
        // design — see its schema docblock), and Postgres has no implicit
        // text=uuid operator, so an uncast comparison raises
        // `operator does not exist: text = uuid` and takes THIS WHOLE QUERY down
        // with it — not just the new column, but every field the ask-state cache
        // produces. Cast direction matches the existing precedent in
        // `embeddings-api.ts`, which casts the uuid side to text for the same reason.
        " WHERE w.ask_id = a.id::text AND w.drained_at IS NOT NULL " +
        "AND w.agent_id IS NOT NULL) AS wake_delivered_at " +
        "FROM public.asks a WHERE a.id = ANY($1::uuid[])",
      [askIds]
    )) as Array<{
      id?: unknown;
      state?: unknown;
      short_id?: unknown;
      title?: unknown;
      responded_at?: unknown;
      response?: unknown;
      wake_delivered_at?: unknown;
    }>;

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
      const title = typeof row.title === "string" ? row.title : undefined;
      // `responded_at` arrives as a Date from postgres-js and as a string from the
      // stub tests use; normalize both to ISO-8601 rather than letting the shape of
      // the driver leak into the cache file.
      const respondedAt = toIsoOrUndefined(row.responded_at);
      const chosen = renderChosen(
        row.response && typeof row.response === "object"
          ? (row.response as { payload?: unknown }).payload
          : undefined
      );
      const wakeDeliveredAt = toIsoOrUndefined(row.wake_delivered_at);
      asks[id] = {
        found: true,
        state,
        open: OPEN_ASK_STATES.has(state),
        ...(shortId ? { shortId } : {}),
        ...(title ? { title } : {}),
        ...(respondedAt ? { respondedAt } : {}),
        ...(chosen ? { chosen } : {}),
        ...(wakeDeliveredAt ? { wakeDeliveredAt } : {}),
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
