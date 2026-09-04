/**
 * Second writer of the prod-state cache, running at MCP server boot (mt#3922) AND on the
 * per-tool-call path (mt#4938).
 *
 * mt#3896 decided that the cockpit daemon keeps its 10-minute prod-state sweep but must not
 * be its SOLE writer. The evidence behind that decision: across four recorded occurrences
 * (mt#3039, mt#3051, mt#3060, mt#3682) the sweep stalled INSIDE a running daemon every time,
 * with a different mechanism each time — a silent domain-level no-op, a wedged interval, a
 * recurrence after DONE, a process-local DNS resolver wedge. In-process recovery cannot clear
 * process-local state; only a process restart does. So the hazard is the writer's LONGEVITY,
 * not its optionality, and the fix is a writer with a different lifetime rather than a fifth
 * in-process recovery mechanism.
 *
 * The MCP server is that writer: it restarts frequently (staleness exits) and is alive exactly
 * when an agent is working, which is the only time the cache is read. Each restart brings a
 * fresh resolver, so the wedge class cannot persist across one.
 *
 * mt#4938 closed the gap the boot-only design named below ("staleness accrued between MCP
 * boots"): a daemon that stays up for hours (surviving a host sleep, say) never reboots, so the
 * boot writer never runs again while the cockpit sweep is frozen. {@link
 * createProdStateTouchRefresher} adds a REQUEST-driven trigger — checked on the existing
 * per-tool-call path in `server.ts`, debounced and single-flight, never a timer — so a
 * long-lived daemon keeps refreshing without reintroducing the periodic in-process sweep the
 * mt#3896 decision deliberately avoided. mt#4938 also fixed a second, independent defect: the
 * boot trigger's own `container.get("persistence")` call raced `container.initialize()`, which
 * is what {@link waitForPersistenceReady} / {@link triggerProdStateBootRefreshWhenReady} exist
 * to close (see their doc comments).
 *
 * ### Covers
 *
 * - A cockpit daemon that is wedged, crashed, absent, or mid-restart while an agent is
 *   working — the cache is refreshed on the next MCP server boot instead of aging until the
 *   daemon recovers.
 * - A cache that was never written at all (fresh machine, cleared state dir).
 * - (mt#4938) A long-lived MCP daemon serving tool calls while the cockpit sweep is frozen,
 *   wedged, or absent for longer than one boot's lifetime.
 * - (mt#4938) A daemon boot where persistence initializes after the boot trigger would
 *   otherwise have fired.
 *
 * ### Does NOT cover
 *
 * - **A daemon that receives no tool calls.** The tool-path trigger runs at tool-call time, not
 *   prompt time — the hook that reads the cache runs at prompt time. A prompt with no tool
 *   calls sees whatever age the cache already has; the next tool call refreshes it. Accepted:
 *   see mt#4938's spec `### Does NOT cover` for why this does not need closing.
 * - **A wedge inside the MCP process itself.** Same class, different process. The mitigation
 *   is the same one that makes this writer useful — the MCP server's own restart cadence.
 * - **A DB that is unreachable from both processes.** Neither writer can refresh; the last-good
 *   snapshot is left in place (never truncated) and the consumer reports its true age.
 * - **Surfacing the outcome on a health endpoint.** `ProdStateSweepTracker` is recorded (via
 *   {@link runProdStateRefreshTick} and `refreshProdStateCache`), but the surfaces that read it
 *   — the cockpit's `/api/health` and `/api/sweeps` — live in the cockpit process, not this one.
 *   In the MCP process the operator-visible signal is the log line, which is the convention its
 *   three sibling boot sweeps already use (`start-command.ts`). Owned by nothing today; file a
 *   task if an MCP-side health surface for boot sweeps is ever wanted.
 *
 * @see mt#3896 — the decision this implements (its `## Outcome` carries the full alternatives set)
 * @see mt#4938 — the tool-path trigger and the persistence-ready ordering fix
 * @see src/cockpit/prod-state-cache.ts — `refreshProdStateCache`, the shared refresh
 * @see .minsky/hooks/inject-prod-state.ts — the consumer; unchanged and unaware of who wrote
 *      it. That is the SOURCE; `.claude/hooks/` holds the generated copy.
 */
import * as fs from "fs";
import { log } from "@minsky/shared/logger";
import type { BasePersistenceProvider } from "@minsky/domain/persistence/types";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";
import {
  runProdStateRefreshTick,
  PROD_STATE_REFRESH_INTERVAL_MS,
  META_WATCHDOG_STALL_MULTIPLIER,
} from "../cockpit/sweepers";
import { getProdStateCachePath, refreshProdStateCache } from "../cockpit/prod-state-cache";
import type { UnsafeSql } from "../cockpit/prod-state-cache";

/**
 * How stale the cache must be before a boot refreshes it.
 *
 * Derived, not chosen (`decision-defaults.mdc §Thresholds`): it is the daemon's own sweep
 * cadence times the multiplier this repo already uses to define "one missed tick" for THIS
 * sweep — `META_WATCHDOG_STALL_MULTIPLIER`, which the meta-watchdog applies as
 * `entry.intervalMs * MULTIPLIER` when deciding a sweep has stalled. Both operands are
 * existing observed cadences, so the threshold moves if either does.
 *
 * The two bounds it has to sit between:
 *
 * - **Above the healthy-daemon maximum age (10m).** The MCP server restarts on the order of
 *   ~100 times a day; refreshing on every boot would turn that into ~100 ledger reads a day
 *   for a datum that changes on a 10-minute cadence. At 20m a boot under a healthy daemon
 *   almost never refreshes.
 * - **Below the consumer's STALE bar (`PROD_STATE_STALENESS_MS`, 30m).** The backstop has to
 *   fire BEFORE the injection hook starts telling every turn the snapshot is stale, otherwise
 *   it only acts after the harm it exists to prevent.
 */
export const PROD_STATE_BOOT_STALENESS_MS =
  PROD_STATE_REFRESH_INTERVAL_MS * META_WATCHDOG_STALL_MULTIPLIER;

/** Why a boot did or did not refresh — the observable this module's decision half returns. */
export type ProdStateBootRefreshReason = "absent" | "unreadable" | "stale" | "fresh";

export interface ProdStateBootRefreshDecision {
  refresh: boolean;
  reason: ProdStateBootRefreshReason;
  /** Age of the existing record in ms, or null when there is no readable `checkedAt`. */
  ageMs: number | null;
}

/**
 * Decide whether this boot should refresh the cache, from the file's raw contents.
 *
 * Takes the raw string rather than a path so the decision is a pure function of its inputs —
 * a test states the cache contents and the clock directly instead of patching `fs`, which
 * ADR-036 bans and `testing-standards.mdc §Testable Design` calls out as design feedback.
 *
 * A malformed or unparseable cache is treated as `unreadable` → refresh. That is deliberate:
 * the consumer hook cannot use a record it cannot parse either, so rewriting it is strictly
 * better than leaving it, and a parse error is exactly the state a fresh write repairs.
 */
export function decideProdStateBootRefresh(
  raw: string | null,
  nowMs: number,
  stalenessMs: number = PROD_STATE_BOOT_STALENESS_MS
): ProdStateBootRefreshDecision {
  if (raw === null) return { refresh: true, reason: "absent", ageMs: null };

  let checkedAtMs: number;
  try {
    const parsed: unknown = JSON.parse(raw);
    const checkedAt =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { checkedAt?: unknown }).checkedAt
        : undefined;
    if (typeof checkedAt !== "string") {
      return { refresh: true, reason: "unreadable", ageMs: null };
    }
    checkedAtMs = Date.parse(checkedAt);
    if (!Number.isFinite(checkedAtMs)) {
      return { refresh: true, reason: "unreadable", ageMs: null };
    }
  } catch {
    // intentional-swallow: an unparseable cache is a known state with a defined
    // response (refresh it), and the caller logs the returned reason — there is
    // nothing a rethrow here would tell an operator that the reason does not.
    return { refresh: true, reason: "unreadable", ageMs: null };
  }

  const ageMs = nowMs - checkedAtMs;
  // A future-dated `checkedAt` (clock skew between the two writers) reads as a negative age.
  // Treat it as fresh rather than stale: refreshing on skew would fire on every boot for as
  // long as the skew lasts, which is the ~100-reads-a-day cost this gate exists to avoid.
  return ageMs > stalenessMs
    ? { refresh: true, reason: "stale", ageMs }
    : { refresh: false, reason: "fresh", ageMs };
}

export interface ProdStateBootRefreshDeps {
  /** Raw cache contents, or null when the file is absent/unreadable. */
  readCache: () => string | null;
  /** Resolve the provider's raw-SQL accessor, or null when it exposes none. */
  resolveRawSql: () => Promise<(() => Promise<unknown>) | null>;
  /** Refresh the cache; returns whether it actually wrote. */
  refresh: (sql: unknown, nowIso: string) => Promise<boolean>;
  now?: () => number;
  stalenessMs?: number;
  /**
   * Sink for the SKIPPED case. Defaults to `log.debug` deliberately: this is the common path
   * — the server boots ~100 times a day and a healthy daemon makes almost all of those skips
   * — so logging it at info would bury the line that matters under ~100 that do not.
   */
  logSkip?: (message: string, meta?: Record<string, unknown>) => void;
  /**
   * Sink for an actual REFRESH. Defaults to `log.info`, not `log.debug` (PR #2805 R1): this is
   * the rare, operator-relevant event — it means the daemon's sweep was not keeping the cache
   * fresh — and criterion 6 asks for it to be visible without raising the log level.
   */
  logInfo?: (message: string, meta?: Record<string, unknown>) => void;
  logWarn?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface ProdStateBootRefreshResult {
  decision: ProdStateBootRefreshDecision;
  /** Whether a write actually landed; null when the staleness gate skipped the refresh. */
  wrote: boolean | null;
}

/**
 * Run the gated boot refresh. Returns the decision and the outcome so a caller — or a test —
 * can assert on both halves without reading a log.
 *
 * The refresh itself delegates to {@link runProdStateRefreshTick}, the same wrapper the
 * cockpit sweeper uses, so the SQL-resolution half is a call site too and the
 * `ProdStateSweepTracker` bookkeeping mt#3684 added is inherited rather than re-derived.
 */
export async function runProdStateBootRefresh(
  deps: ProdStateBootRefreshDeps
): Promise<ProdStateBootRefreshResult> {
  const nowMs = (deps.now ?? (() => Date.now()))();
  const info = deps.logInfo ?? ((message, meta) => log.info(message, meta));
  const skip = deps.logSkip ?? ((message, meta) => log.debug(message, meta));
  const warn = deps.logWarn ?? ((message, meta) => log.warn(message, meta));

  const decision = decideProdStateBootRefresh(deps.readCache(), nowMs, deps.stalenessMs);
  if (!decision.refresh) {
    skip("mcp: prod-state cache is fresh; skipping boot refresh", { ageMs: decision.ageMs });
    return { decision, wrote: null };
  }

  const result = await runProdStateRefreshTick({
    resolveRawSql: deps.resolveRawSql,
    refresh: deps.refresh,
    logWarn: warn,
  });

  if (result.ok) {
    info("mcp: refreshed prod-state cache at boot", {
      reason: decision.reason,
      ageMs: decision.ageMs,
    });
  } else {
    // `runProdStateRefreshTick` already logged the specific cause; this line adds the half it
    // cannot know — that this was the boot writer, and what made it decide to run.
    warn("mcp: prod-state boot refresh did not write; leaving the existing cache in place", {
      reason: decision.reason,
      ageMs: decision.ageMs,
    });
  }
  return { decision, wrote: result.ok };
}

// ---------------------------------------------------------------------------
// Tool-path trigger (mt#4938)
// ---------------------------------------------------------------------------

/**
 * Debounce window for {@link ProdStateTouchRefresher.touch}, mirroring {@link
 * StalenessDetector}'s `CHECK_INTERVAL_MS` (`src/mcp/staleness-detector.ts`) — the sibling
 * per-tool-call check this trigger sits beside in `server.ts`. Keeping the two at the same
 * cadence means neither one's debounce cost dominates a burst of tool calls.
 */
export const PROD_STATE_TOUCH_DEBOUNCE_MS = 60_000;

/** The tool-path trigger `server.ts` holds one long-lived instance of per server. */
export interface ProdStateTouchRefresher {
  /**
   * Called on (approximately) every tool dispatch. Never throws, never awaited by the
   * caller, and does at most one `readFileSync` when the in-memory debounce window has
   * elapsed — never a DB round trip unless that read finds the cache stale.
   */
  touch(nowMs?: number): void;
}

/**
 * Build a request-driven refresh trigger (mt#4938 SC1).
 *
 * Deliberately NOT a `setInterval`: mt#3896/mt#3922's design explicitly rejected a periodic
 * in-process sweep (it would reintroduce the long-lived-writer property the boot writer exists
 * to escape — see this module's doc comment). This closes the same gap a different way — by
 * riding the tool-call traffic that is already happening, rather than scheduling independent
 * work.
 *
 * Each `touch`:
 *
 * 1. Single-flight: a call while a previous refresh is still in flight is a no-op.
 * 2. Debounce: a call within {@link PROD_STATE_TOUCH_DEBOUNCE_MS} of the last DECISION (refresh
 *    or skip) is a no-op — no file read, no ledger read. This is what keeps a burst of tool
 *    calls (the common case) down to one `readFileSync` a minute rather than one per call.
 * 3. Otherwise reads the cache and decides via the same pure {@link decideProdStateBootRefresh}
 *    the boot path uses, then — only when the decision is `stale`/`absent`/`unreadable` —
 *    starts ONE fire-and-forget {@link runProdStateRefreshTick}, the same tick primitive
 *    `runProdStateBootRefresh` composes for the boot path. (A direct call to
 *    `runProdStateBootRefresh` was considered and rejected: its log message text is hardcoded
 *    to say "at boot", and SC3 requires this path's lines say "(tool-path)" instead — see the
 *    vocabulary comment below.)
 *
 * A THROWN `readCache()` (permissions, a torn file, an ENOENT race with the cockpit's atomic
 * rename) is routed through step 3 as `unreadable` — the same response a cache that parses but
 * carries no usable `checkedAt` already gets — rather than being swallowed outright (PR #3615
 * R1 BLOCKING). The debounce clock in step 2 is advanced only once a decision — real or this
 * synthesized one — actually exists; advancing it before the read was attempted let a single
 * throw suppress every touch for a full debounce window with nothing having been decided.
 *
 * Logging (mt#4938 SC3): `info` on a refresh that wrote, `warn` on one that did not (mirroring
 * the boot path's own success/failure split) or on a thrown read (logged, then treated as
 * `unreadable` per the paragraph above), `debug` on a debounced-or-fresh skip. An unexpected
 * rejection from the tick itself (which `runProdStateRefreshTick` is not designed to produce —
 * it catches internally — but this is a hot per-tool-call path, so a defensive net stays in) is
 * also `warn`-logged via {@link getLoggableErrorSummary} and swallowed; nothing on this path may
 * throw into the tool call it rides along on.
 */
export function createProdStateTouchRefresher(
  deps: ProdStateBootRefreshDeps
): ProdStateTouchRefresher {
  let lastDecisionAtMs: number | null = null;
  let inFlight: Promise<void> | null = null;

  const info = deps.logInfo ?? ((message, meta) => log.info(message, meta));
  const skip = deps.logSkip ?? ((message, meta) => log.debug(message, meta));
  const warn = deps.logWarn ?? ((message, meta) => log.warn(message, meta));

  return {
    touch(nowMs: number = Date.now()): void {
      if (inFlight) return;
      if (lastDecisionAtMs !== null && nowMs - lastDecisionAtMs < PROD_STATE_TOUCH_DEBOUNCE_MS) {
        return;
      }

      // PR #3615 R1 BLOCKING: `lastDecisionAtMs` used to be advanced HERE, before the read
      // was even attempted — so a thrown `readCache()` (permissions, a torn file, an ENOENT
      // race with the cockpit's atomic rename) suppressed every touch for a full debounce
      // window without a decision ever having been made, a silent blind spot where a stale
      // cache could not be refreshed. Fixed by routing a thrown read through the SAME
      // decision path `decideProdStateBootRefresh` already uses for a cache it can parse but
      // finds malformed ("unreadable" -> refresh warranted) and only advancing the debounce
      // clock once a decision — real or synthesized — actually exists.
      let decision: ProdStateBootRefreshDecision;
      try {
        decision = decideProdStateBootRefresh(deps.readCache(), nowMs, deps.stalenessMs);
      } catch (err) {
        warn("mcp: prod-state tool-path cache read failed; treating as unreadable", {
          error: getLoggableErrorSummary(err),
        });
        decision = { refresh: true, reason: "unreadable", ageMs: null };
      }
      lastDecisionAtMs = nowMs;

      if (!decision.refresh) {
        skip("mcp: prod-state cache is fresh; skipping tool-path refresh", {
          ageMs: decision.ageMs,
        });
        return;
      }

      inFlight = runProdStateRefreshTick({
        resolveRawSql: deps.resolveRawSql,
        refresh: deps.refresh,
        // Pin the tick's clock to the SAME injected `nowMs` `touch` was called with, rather
        // than letting `runProdStateRefreshTick` default to the real wall clock — otherwise a
        // test (or a caller) that injects `nowMs` would still see the real time land in the
        // written cache's `checkedAt`.
        now: () => new Date(nowMs).toISOString(),
        logWarn: warn,
      })
        .then((result) => {
          if (result.ok) {
            info("mcp: refreshed prod-state cache (tool-path)", {
              reason: decision.reason,
              ageMs: decision.ageMs,
            });
          } else {
            warn(
              "mcp: prod-state tool-path refresh did not write; leaving the existing cache in place",
              { reason: decision.reason, ageMs: decision.ageMs }
            );
          }
        })
        .catch((err) => {
          warn("mcp: prod-state tool-path refresh failed", {
            error: getLoggableErrorSummary(err),
          });
        })
        .finally(() => {
          inFlight = null;
        });
    },
  };
}

/**
 * Read the cache file, returning null for both "absent" and "unreadable".
 *
 * Collapsing the two is safe here because {@link decideProdStateBootRefresh} treats them
 * identically — both mean "no usable record, write one."
 */
function readProdStateCacheFile(cachePath: string): string | null {
  try {
    // `.toString()` rather than an encoding argument: under the root tsconfig's typings
    // `readFileSync` widens to `string | Buffer` even when given `{ encoding: "utf8" }`.
    return fs.readFileSync(cachePath).toString();
  } catch {
    // intentional-swallow: ENOENT is the ordinary first-boot case and any other read error
    // has the same response (refresh). The decision function's `absent` reason is what
    // reaches the log.
    return null;
  }
}

/**
 * Real-wired entry point: the boot refresh bound to the process's actual persistence provider
 * and cache path. This is what `start-command.ts` calls; everything above it is injectable.
 *
 * Never throws — a failure here must not delay or fail MCP boot (mt#3922 criterion 5). The
 * cache is an optimization for a hook that already fails open when it is missing or stale.
 */
export async function triggerProdStateBootRefresh(
  provider: BasePersistenceProvider,
  cachePath: string = getProdStateCachePath()
): Promise<ProdStateBootRefreshResult | null> {
  try {
    return await runProdStateBootRefresh({
      readCache: () => readProdStateCacheFile(cachePath),
      resolveRawSql: async () => {
        const getRawSql = (provider as { getRawSqlConnection?: () => Promise<unknown> })
          .getRawSqlConnection;
        return typeof getRawSql === "function" ? getRawSql.bind(provider) : null;
      },
      refresh: (sql, nowIso) =>
        refreshProdStateCache(sql as UnsafeSql | null | undefined, nowIso, cachePath),
    });
  } catch (err) {
    log.warn("mcp: prod-state boot refresh failed (best-effort)", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Real-wired entry point for the tool-path trigger (mt#4938): builds a {@link
 * ProdStateTouchRefresher} bound to the process's actual persistence provider and cache path,
 * mirroring {@link triggerProdStateBootRefresh}'s wiring for the boot path (same
 * `getRawSqlConnection` probe, same `refreshProdStateCache` call). `server.ts` constructs ONE
 * instance per server — this holds `lastDecisionAtMs`/in-flight state across calls, so a fresh
 * instance per tool call would silently defeat the debounce and single-flight guards — and
 * calls `.touch()` from the per-tool-call dispatch path.
 */
export function createProdStateTouchRefresherForProvider(
  provider: BasePersistenceProvider,
  cachePath: string = getProdStateCachePath()
): ProdStateTouchRefresher {
  return createProdStateTouchRefresher({
    readCache: () => readProdStateCacheFile(cachePath),
    resolveRawSql: async () => {
      const getRawSql = (provider as { getRawSqlConnection?: () => Promise<unknown> })
        .getRawSqlConnection;
      return typeof getRawSql === "function" ? getRawSql.bind(provider) : null;
    },
    refresh: (sql, nowIso) =>
      refreshProdStateCache(sql as UnsafeSql | null | undefined, nowIso, cachePath),
  });
}

// ---------------------------------------------------------------------------
// Persistence-ready ordering (mt#4938 SC2)
// ---------------------------------------------------------------------------

/**
 * The one piece of `AppContainerInterface` this module depends on. Kept as a narrow structural
 * type — like {@link ProdStateBootRefreshDeps} above — rather than importing the full DI
 * container interface, so a test can hand in a plain object instead of a real container.
 */
export interface PersistenceAwareContainer {
  has(key: "persistence"): boolean;
  get(key: "persistence"): BasePersistenceProvider;
}

/** Cadence for {@link waitForPersistenceReady}'s poll of `container.has("persistence")`. */
const PERSISTENCE_READY_POLL_INTERVAL_MS = 200;

/**
 * Upper bound on how long {@link waitForPersistenceReady} waits before giving up.
 *
 * Grounded in the slowest observed cold DB connect in this codebase (mt#3744/mt#3879: measured
 * 4.3-5.5s), with margin for a boot where several OTHER fire-and-forget sweeps are registered
 * ahead of this one in `start-command.ts` and each gets a turn on the event loop first, rather
 * than a round number.
 */
const PERSISTENCE_READY_WAIT_TIMEOUT_MS = 15_000;

/**
 * Wait until `container.has("persistence")` is true, bounded by {@link
 * PERSISTENCE_READY_WAIT_TIMEOUT_MS} (mt#4938 SC2).
 *
 * Deliberately does NOT call `container.initialize()` itself — `TsyringeContainer.initialize()`
 * walks its full registration order on every call, and a second concurrent call (this one,
 * racing the ALREADY-in-flight call that boot made) could re-run a factory that the first call
 * is still mid-construction on. Polling `has()`, a plain map lookup, has no such hazard: it
 * only ever OBSERVES the registration another call is performing.
 *
 * Returns `false` on timeout — "persistence never became available in this window" — rather
 * than throwing, so a caller can treat it as one more best-effort outcome among the several
 * this module already returns (`absent`/`unreadable`/`wrote: null`/…).
 *
 * Two hardenings added in mt#4938 PR #3615 R2 (CI round), neither of which was the cause of
 * that round's actual failure (see the R2 note on the `ProdStateTouchRefresher` type import in
 * `server.ts` for what was) but both worth having regardless, since this wait genuinely can run
 * for real seconds on the STDIO boot path, where `container.initialize()` runs in the
 * background rather than being awaited before this call site runs:
 *
 * - The default `sleep`'s timer is `unref()`'d, so a pending poll can never by itself hold the
 *   process open — an un-unref'd timer keeps Node/Bun's event loop alive, which is exactly the
 *   property a BEST-EFFORT background sweep must not have.
 * - An optional `signal` lets a caller abort the wait early (e.g. on SIGTERM/SIGINT), so a
 *   graceful-shutdown path is not made to wait out the full timeout for a sweep it no longer
 *   cares about the result of.
 */
export async function waitForPersistenceReady(
  container: Pick<PersistenceAwareContainer, "has">,
  opts: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
  } = {}
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? PERSISTENCE_READY_WAIT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? PERSISTENCE_READY_POLL_INTERVAL_MS;
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        // `unref` is absent from this project's narrowed ambient `Timeout` type in some
        // tsconfig scopes even though it exists at runtime on both Node's and Bun's timer
        // handle — optional-call rather than a cast, so an environment that genuinely lacks
        // it (a browser-shaped `number` handle, never actually reachable here) degrades to
        // "still works, just holds the loop" instead of throwing.
        t.unref?.();
      }));

  const deadlineMs = Date.now() + timeoutMs;
  while (!container.has("persistence")) {
    if (opts.signal?.aborted) return false;
    if (Date.now() >= deadlineMs) return false;
    await sleep(pollIntervalMs);
  }
  return true;
}

/**
 * Boot-time entry point wired at the `start-command.ts` fire-and-forget call site (mt#4938
 * SC2). Wraps {@link triggerProdStateBootRefresh} with {@link waitForPersistenceReady} so a
 * boot that races `container.initialize()` refreshes once persistence becomes available,
 * instead of `container.get("persistence")` throwing `Service "persistence" is not available`
 * — the baseline recorded in this module's doc comment: 8 failures of that exact shape against
 * 8 successes across the current daemon log.
 *
 * Never throws (same contract as {@link triggerProdStateBootRefresh}): a timed-out wait
 * resolves to `null`, logged at `debug` — the daemon starting up but persistence never becoming
 * available in the window is itself covered by every OTHER readiness signal in this process
 * (health checks, tool-call failures), so this best-effort sweep does not need to escalate it
 * again.
 */
export async function triggerProdStateBootRefreshWhenReady(
  container: PersistenceAwareContainer,
  cachePath?: string,
  waitOpts?: Parameters<typeof waitForPersistenceReady>[1]
): Promise<ProdStateBootRefreshResult | null> {
  const ready = await waitForPersistenceReady(container, waitOpts);
  if (!ready) {
    log.debug(
      "mcp: prod-state boot refresh skipped — persistence did not become available in time"
    );
    return null;
  }
  return triggerProdStateBootRefresh(container.get("persistence"), cachePath);
}
