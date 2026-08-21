/**
 * Cockpit-wide lazy-cached persistence getters (mt#2615 — extracted from
 * server.ts).
 *
 * server.ts previously duplicated ~150-180 lines across six near-identical
 * lazy-cached getters (lines 149/183/623/647/689/802 of the pre-split file),
 * each repeating the same `getSharedPersistenceService -> getProvider ->
 * probe capability -> cache` shape. This module centralizes the two REAL
 * shared shapes:
 *
 *   - `getCachedPersistenceProvider()` — the common `getSharedPersistenceService()`
 *     bootstrap step (3 duplicated lines), used by getServerTaskService,
 *     getServerTaskDetailDeps, and getServerSessionProvider — none of which
 *     need a raw db handle, just the provider itself.
 *   - `createCachedSqlDbGetter()` — a factory for the `getDatabaseConnection`
 *     probe-and-cache shape, used by getContextInspectorDb and (indirectly)
 *     getServerAskRepository / getServerTaskDetailDeps.
 *
 * NOT all six getters collapse into calling the exact same function:
 * getServerSseBroker (routes/events.ts) needs `getListenCapableSqlConnection`
 * — a different capability entirely — so it is NOT built on
 * `createCachedSqlDbGetter` and lives in its own module.
 *
 * Cache-negative behavior is preserved EXACTLY per callsite (a real,
 * pre-existing behavioral difference, not an oversight):
 *   - `getContextInspectorDb` permanently caches a `null` after the FIRST
 *     failed probe (`cacheNegative: true`).
 *   - `getServerAskRepository` / `getServerTaskDetailDeps` retry the probe
 *     on EVERY call until the first success (`cacheNegative: false`).
 */
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { AskRepository } from "@minsky/domain/ask/repository";
import type { TaskServiceInterface } from "@minsky/domain/tasks/taskService";
import type { TaskGraphService } from "@minsky/domain/tasks/task-graph-service";
import type { SessionProviderInterface } from "@minsky/domain/session/types";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
// Static (not dynamic) per `no-dynamic-imports`: this module is types + a pure
// string builder, so it carries none of the weight that keeps PersistenceService
// behind the dynamic import in getCachedPersistenceProvider below.
import {
  describePersistenceUnavailability,
  PersistenceUnavailableError,
} from "@minsky/domain/persistence/unconfigured-provider";
import type { ChangesetService } from "@minsky/domain/changeset/changeset-service";
import type { ChecksResult } from "@minsky/domain/repository/github-pr-checks";
import type { TokenProvider } from "@minsky/domain/auth";
import { log } from "@minsky/shared/logger";
// Static import is safe here (shared-persistence pulls in only types + the
// logger); the heavyweight PersistenceService itself stays behind the dynamic
// import in getCachedPersistenceProvider below.
import {
  getPersistenceEpoch,
  getDbStatus,
  PersistenceInitTimeoutError,
  type DbStatus,
} from "./shared-persistence";

// ---------------------------------------------------------------------------
// getCachedPersistenceProvider — shared bootstrap step
// ---------------------------------------------------------------------------

/**
 * Fetch the cockpit-wide PersistenceProvider.
 *
 * `getSharedPersistenceService()` (shared-persistence.ts) is ALREADY a
 * module-level singleton (it caches its own `_instance`), so this adds no
 * additional caching of its own — it only removes the 3-line
 * `getSharedPersistenceService -> getProvider` bootstrap that was duplicated
 * across getServerTaskService / getServerTaskDetailDeps / getServerSessionProvider.
 */
export async function getCachedPersistenceProvider() {
  const { getSharedPersistenceService } = await import("./shared-persistence");
  const svc = await getSharedPersistenceService();
  return svc.getProvider();
}

/**
 * Describe WHY a DB-backed cockpit route cannot serve this request (mt#3661).
 *
 * Every such route already fails LOUDLY — a 503, never a plausible-looking empty
 * result — so this is message quality, not correctness. What the bare
 * "provider does not support SQL" text costs is the OPERATOR'S NEXT MOVE:
 * ADR-035 rule 3 requires "configured but failing" to stay distinguishable from
 * "not configured", because the first is an outage to wait out and the second is
 * a config to fix. Both produce identical capability flags, so a route that
 * reports only the flag has erased the distinction the provider still holds.
 *
 * Lives here rather than at each route because `getCachedPersistenceProvider`
 * is already the cockpit's single provider access point — the alternative was
 * repeating a provider-fetch + describe + fallback dance at ~10 call sites.
 *
 * NEVER throws: a diagnosis step that fails must not replace the failure it was
 * called to describe (the same contract `requireAskRepository` states in
 * `src/adapters/shared/commands/asks.ts`).
 *
 * The catch below is NOT merely defensive — on the cockpit it is the LIVE PATH,
 * which the mt#3661 acceptance test caught. Unlike `createDomainContainer`, which
 * converts a failed init into an `UnconfiguredPersistenceProvider` VALUE (so the
 * MCP/CLI adapters find the cause sitting on the provider),
 * `getSharedPersistenceService` PROPAGATES the failure — it rejects with the init
 * error, or `PersistenceInitTimeoutError`. So in a degraded cockpit there is no
 * provider to interrogate and the boot error arrives HERE, as a throw. That error
 * IS the cause; returning the generic "not SQL-capable" sentence instead would
 * discard the one detail this task exists to surface.
 */
export async function describeServerPersistenceUnavailability(): Promise<string> {
  try {
    return describePersistenceUnavailability(await getCachedPersistenceProvider());
  } catch (err: unknown) {
    log.warn("cockpit: persistence unavailable", {
      error: err instanceof Error ? err.message : String(err),
    });
    return describeFailedPersistenceInit(err);
  }
}

// ---------------------------------------------------------------------------
// Driver-level connection-error classification (mt#3825)
// ---------------------------------------------------------------------------

/**
 * Human-readable phrases for the postgres.js / Node socket connection-error
 * codes that produce the `undefined:undefined` artifact (mt#3825).
 *
 * `node_modules/postgres/src/errors.js`'s `connection()` builder always
 * writes `write ${code} ${host}:${port}` (`function connection(x, options,
 * socket) { const { host, port } = socket || options; ... }`), and a
 * pre-connection `net.Socket` has neither `host` nor `port` — so EVERY
 * connect-level failure renders `write CONNECT_TIMEOUT undefined:undefined`
 * regardless of how the connection is configured. The fragment reads as "a
 * config value is missing," which is exactly backwards, while carrying zero
 * actual diagnostic signal. Keyed on `err.code` (the field this same
 * `connection()` builder assigns), never on matching the message text, so
 * the raw artifact is never re-embedded even by this classification itself.
 */
const DRIVER_CONNECTION_ERROR_PHRASES: Record<string, string> = {
  CONNECT_TIMEOUT: "timed out connecting to the database",
  ETIMEDOUT: "timed out connecting to the database",
  ECONNREFUSED: "the database refused the connection",
  ENOTFOUND: "the database host could not be resolved",
  EHOSTUNREACH: "the database host is unreachable",
  ECONNRESET: "the database connection was reset",
  EPIPE: "the database connection was broken",
};

/**
 * Classify a caught error as a driver-level connection failure, returning a
 * clean human-readable phrase — or `undefined` when it isn't one.
 *
 * Exported so a caller that already has a raw driver error (rather than a
 * widget's generic catch-all) can reuse the same phrase table instead of
 * re-deriving it.
 */
export function classifyDriverConnectionError(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string") return undefined;
  return DRIVER_CONNECTION_ERROR_PHRASES[code];
}

/**
 * Render the cause when the cockpit's persistence bootstrap REJECTED (mt#3661).
 *
 * Split out as a pure function so the live path above is testable without
 * patching the module-level `getCachedPersistenceProvider` import — the
 * functional-core / imperative-shell split `testing-standards.mdc §Testable
 * Design` asks for. This is the branch that actually runs on a degraded cockpit,
 * so it is the one that most needs a test.
 *
 * Mirrors the wording `describePersistenceUnavailability` uses for the
 * configured-but-failed case, because it describes the SAME state — the two
 * differ only in whether the bootstrap handed back a placeholder or threw.
 */
export function describeFailedPersistenceInit(err: unknown): string {
  const reason =
    classifyDriverConnectionError(err) ?? (err instanceof Error ? err.message : String(err));
  // mt#4383: kept in lockstep with `describePersistenceUnavailability`, per the
  // mt#3661 test that asserts the two share wording — an operator must not get
  // different advice from the cockpit than from the MCP adapters. mt#4379
  // corrected a THIRD renderer of this same state (the task-backend message)
  // and did not reach either of these two; aligning all three is the point of
  // mt#4383.
  //
  // Two clauses are gone and neither depended on tense:
  //
  //  - "`minsky persistence check` reports the same failure" asserted a parity
  //    nothing verified. It is not merely unverified but backwards: that
  //    command probes the LIVE connection while this reports one failed
  //    attempt, so they are EXPECTED to disagree once the outage clears —
  //    which is precisely how two agent sessions lost their first diagnostic
  //    minutes to a database that was already healthy.
  //  - "restart once the database is reachable" is no longer the remedy;
  //    mt#4379 made the container re-register dependents on recovery.
  //
  // This path DOES keep the present tense its sibling drops, and the asymmetry
  // is deliberate rather than an oversight: `getSharedPersistenceService`
  // PROPAGATES a failed init instead of substituting a provider, so the error
  // arrives here as a live throw from the attempt just made (see
  // `describeServerPersistenceUnavailability` above). There is no stored
  // boot-time record being replayed, which is the thing that made the sibling's
  // present tense a lie.
  return (
    `Postgres IS configured, but persistence failed to initialize: ${reason}. ` +
    "This is a degraded provider, not a missing configuration. Note `minsky " +
    "persistence check` may well PASS while this fails: it probes the live " +
    "connection, whereas this reports the initialization attempt that just failed."
  );
}

// ---------------------------------------------------------------------------
// describeWidgetDegradedReason — widget catch-all classifier (mt#3825)
// ---------------------------------------------------------------------------

/**
 * Classify a caught error from a cockpit widget's top-level catch-all into an
 * operator-meaningful, cause-carrying reason (mt#3825).
 *
 * Replaces the bare `${widgetName} error: ${message}` template that every
 * DB-backed widget used to interpolate a caught error's `.message` verbatim —
 * which, for a connect-level driver failure, IS the `write CONNECT_TIMEOUT
 * undefined:undefined` artifact (see {@link DRIVER_CONNECTION_ERROR_PHRASES}).
 * That fragment carries no diagnostic signal while looking like it carries
 * the most: it reads as "a config value is missing," which is what the
 * originating incident's principal first suspected — and is not.
 *
 * Distinguishes three states, extending ADR-035 rule 3's two ("configured but
 * failing" MUST be distinguishable from "not configured") with the third
 * class ADR-035's own scope (the initializer) does not name:
 *
 *   A. **Not configured** — mt#2349's boot-tolerant `UnconfiguredProvider`
 *      placeholder threw on use (`PersistenceUnavailableError`). Its own
 *      message already names the missing config keys, so it is passed
 *      through rather than re-derived.
 *   B. **Configured but unavailable at boot** — the shared
 *      `PersistenceService` itself failed to (re-)initialize
 *      (`PersistenceInitTimeoutError`, or a raw driver connect failure
 *      thrown by `getSharedPersistenceService()` — which PROPAGATES rather
 *      than converting the failure into a value; see
 *      {@link describeServerPersistenceUnavailability}'s own docstring for
 *      why that asymmetry matters here too). Delegates to
 *      {@link describeFailedPersistenceInit}, the mt#3661 helper for exactly
 *      this state, rather than duplicating its wording.
 *   C. **Connectivity/driver failure on an ALREADY-INITIALIZED provider** —
 *      what the originating incident actually was: the shared service had
 *      already initialized successfully in this process, and a LATER query
 *      hit a driver-level connection error. `getDbStatus()` only leaves
 *      `"ok"` via the init/reachability/recycle paths in
 *      `shared-persistence.ts` — none of which an ordinary per-query failure
 *      touches — so `getDbStatus() === "ok"` at the moment of this catch is
 *      exactly the signal that distinguishes this state from B without
 *      needing any new tracking state.
 *
 * An error that matches none of the above (an unrelated widget bug, not a
 * persistence signal) is passed through unclassified — reclassifying every
 * possible widget error as a database problem would be its own defect.
 *
 * @param options.getDbStatus Test seam: override the DB-status read.
 *   Defaults to {@link getDbStatus}. Production callers never set this.
 */
export function describeWidgetDegradedReason(
  widgetName: string,
  err: unknown,
  options?: { getDbStatus?: () => DbStatus }
): string {
  const readDbStatus = options?.getDbStatus ?? getDbStatus;
  const message = err instanceof Error ? err.message : String(err);

  // Case A — see docstring above.
  if (err instanceof PersistenceUnavailableError) {
    return `${widgetName}: ${message}`;
  }

  const driverPhrase = classifyDriverConnectionError(err);
  if (driverPhrase !== undefined || err instanceof PersistenceInitTimeoutError) {
    // Case C — see docstring above.
    if (readDbStatus() === "ok") {
      return (
        `${widgetName}: the database connection ${driverPhrase ?? "failed"} mid-request. ` +
        "The connection was already established for this process — this is a " +
        "live connectivity/driver failure, not a missing or invalid " +
        "configuration. It should clear automatically once the network path " +
        "to Postgres is reachable again; `minsky persistence check` reports " +
        "the same failure."
      );
    }
    // Case B — see docstring above.
    return `${widgetName}: ${describeFailedPersistenceInit(err)}`;
  }

  // Not a recognized persistence signal.
  return `${widgetName}: ${message}`;
}

// ---------------------------------------------------------------------------
// createCachedSqlDbGetter — shared lazy-cached SQL-db-handle factory
// ---------------------------------------------------------------------------

/** A lazy-cached SQL-db getter, plus a test-only reset of its private cache. */
export interface CachedSqlDbGetter {
  (): Promise<PostgresJsDatabase | null>;
  /**
   * @internal Test-only. Clears this getter's private `cachedDb` /
   * `probedAndFailed` state so the NEXT call re-probes from scratch, instead
   * of returning whatever this getter resolved to earlier in the process
   * (mt#3016). Production code must never call this — it would force a
   * redundant re-probe on the very next request.
   */
  __resetForTests(): void;
}

/**
 * Guard for the test-only reset surface: `bun test` sets NODE_ENV to "test",
 * so any other environment reaching a reset API is production misuse — throw
 * instead of silently corrupting the live singleton caches. (Reviewer-bot
 * non-blocking finding, PR #2159.)
 */
function assertTestEnvironment(api: string): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error(
      `${api} is test-only (NODE_ENV must be "test"; got ${JSON.stringify(process.env.NODE_ENV)})`
    );
  }
}

/** @internal Test-only registry of every getter this factory has produced, so `__resetDbProvidersForTests()` (below) can reset all of them without needing to name each one individually. */
const _allCachedSqlDbGetters: CachedSqlDbGetter[] = [];

// ---------------------------------------------------------------------------
// Test-process live-database guard (mt#3254)
// ---------------------------------------------------------------------------

/**
 * Thrown when a test process resolves a live database through the PRODUCTION
 * provider path.
 *
 * A distinct class rather than a bare Error because `createCachedSqlDbGetter`
 * converts every thrown probe failure into `null`. This one must survive that
 * catch: degrading it to "no database available" would make the guard silent,
 * which is the failure mode it exists to prevent.
 */
export class TestEnvironmentDbAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestEnvironmentDbAccessError";
  }
}

/** Env var that opts a test into using a real (local) database. */
export const ALLOW_TEST_DB_ENV_VAR = "MINSKY_ALLOW_TEST_DB";

/**
 * Decide whether a resolved database must be refused.
 *
 * Extracted as a pure function so the decision is unit-testable without a live
 * connection, mirroring how `assertTestEnvironment` above keeps its own
 * NODE_ENV check in one readable place.
 *
 * `isProductionResolution` is the load-bearing input: a getter built WITHOUT
 * the `getProvider` seam resolves through `getCachedPersistenceProvider`, i.e.
 * the real configured database. A getter given an explicit provider is being
 * handed a deliberate fake and is none of this guard's business — guarding it
 * would break every legitimate injected-provider test.
 */
export function shouldRefuseTestEnvironmentDb(input: {
  isProductionResolution: boolean;
  nodeEnv: string | undefined;
  optIn: string | undefined;
}): boolean {
  if (!input.isProductionResolution) return false;
  if (input.nodeEnv !== "test") return false;
  // An exported-but-empty `MINSKY_ALLOW_TEST_DB=` is not consent. Requiring a
  // non-empty value keeps a stray export from disabling the guard silently.
  return !(input.optIn !== undefined && input.optIn.length > 0);
}

/**
 * Build a lazy-cached SQL-capable-provider database getter.
 *
 * @param options.cacheNegative When `true`, permanently cache a `null`
 *   result after the FIRST failed probe — later calls never re-check the
 *   provider (matches `getContextInspectorDb`'s exact pre-split behavior).
 *   When `false`, a failed probe is NOT cached — every call retries until
 *   the first success (matches the other callers' exact pre-split behavior).
 *   This is a real, intentional difference between the callers today; this
 *   option preserves it exactly rather than silently unifying it.
 * @param options.getProvider Test seam: override the provider-fetching step.
 *   Defaults to {@link getCachedPersistenceProvider}. Production callers never
 *   set this — it exists so unit tests can exercise the caching behavior
 *   above against a fake/failing provider without a real DB.
 * @param options.getEpoch Test seam: override the persistence-epoch read
 *   (mt#3638). Defaults to {@link getPersistenceEpoch}. A cache entry is only
 *   served while the epoch it was created under is still current; a recycle
 *   or degraded-reset bumps the epoch and forces a re-resolve, so no getter
 *   can pin a torn-down pool.
 */
export function createCachedSqlDbGetter(options: {
  cacheNegative: boolean;
  getProvider?: () => Promise<unknown>;
  getEpoch?: () => number;
}): CachedSqlDbGetter {
  // A getter built without `getProvider` resolves the REAL configured
  // database; that is what the mt#3254 guard keys on.
  const isProductionResolution = options.getProvider === undefined;
  const getProvider = options.getProvider ?? getCachedPersistenceProvider;
  const getEpoch = options.getEpoch ?? getPersistenceEpoch;
  let cachedDb: PostgresJsDatabase | null = null;
  let probedAndFailed = false;
  let cachedAtEpoch = -1;

  const getCachedSqlDb = async function getCachedSqlDb(): Promise<PostgresJsDatabase | null> {
    // FIRST statement, before the caches and before any provider work (PR #2342
    // R1): connecting is itself the hazard. The real provider may run
    // connect-time side effects — migrations, session initialization — so a
    // guard that fires after `getDatabaseConnection()` resolves has already let
    // them happen. Deciding purely from `isProductionResolution` + the
    // environment needs no connection at all, so nothing is attempted.
    //
    // Keying off the resolution SHAPE rather than the resolved value also means
    // a provider that returns null, or throws, cannot silently downgrade the
    // guard into the "probe failed -> null" path below.
    if (
      shouldRefuseTestEnvironmentDb({
        isProductionResolution,
        nodeEnv: process.env.NODE_ENV,
        optIn: process.env[ALLOW_TEST_DB_ENV_VAR],
      })
    ) {
      throw new TestEnvironmentDbAccessError(
        "Refusing to resolve a live database in a test process. This getter uses the real " +
          "configured provider, which under `bun test` is whatever the environment points at — " +
          "prod, in this repo. Inject a fake via the `getProvider` seam, or set " +
          `${ALLOW_TEST_DB_ENV_VAR}=1 if this test genuinely needs a real LOCAL database. ` +
          "(mt#3254 — test runs previously wrote 31 rows into production tables.)"
      );
    }
    // mt#3638: a recycle/degraded-reset bumps the epoch; anything cached under
    // an older epoch is derived from a torn-down pool and must be dropped —
    // INCLUDING a cached negative, since the recycle may have fixed exactly
    // what made the probe fail.
    if (cachedAtEpoch !== getEpoch()) {
      cachedDb = null;
      probedAndFailed = false;
    }
    // Stamp BEFORE resolving: if the epoch moves while this call is in flight,
    // the stale stamp forces the NEXT call to re-resolve — conservative in the
    // right direction.
    cachedAtEpoch = getEpoch();
    if (cachedDb) return cachedDb;
    if (options.cacheNegative && probedAndFailed) return null;
    try {
      const provider = await getProvider();
      if (
        typeof provider !== "object" ||
        provider === null ||
        !("getDatabaseConnection" in provider) ||
        typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection !==
          "function"
      ) {
        probedAndFailed = true;
        return null;
      }
      const sqlProvider = provider as {
        getDatabaseConnection: () => Promise<PostgresJsDatabase | null>;
      };
      const db = await sqlProvider.getDatabaseConnection();
      if (!db) {
        probedAndFailed = true;
        return null;
      }
      cachedDb = db;
      return cachedDb;
    } catch (err) {
      // Defensive: the guard now throws before this try block, so it cannot
      // reach here. Kept so a future refactor that moves the check back inside
      // cannot silently re-degrade it into the "probe failed -> null" path — a
      // null is indistinguishable from "no database configured", which is the
      // silence this guard exists to break.
      if (err instanceof TestEnvironmentDbAccessError) throw err;
      probedAndFailed = true;
      return null;
    }
  } as CachedSqlDbGetter;

  getCachedSqlDb.__resetForTests = () => {
    assertTestEnvironment("__resetForTests");
    cachedDb = null;
    probedAndFailed = false;
    cachedAtEpoch = -1;
  };

  _allCachedSqlDbGetters.push(getCachedSqlDb);
  return getCachedSqlDb;
}

// ---------------------------------------------------------------------------
// Context-inspector SQL connection — lazy-cached singleton (mt#2023).
// Uses the cockpit-wide PersistenceService singleton (shared-persistence.ts).
// Returns null when the provider is non-SQL (the endpoint returns 503).
// cacheNegative: true — a failed probe is cached PERMANENTLY (exact
// pre-split behavior of `_cachedContextInspectorDbProbed`).
// ---------------------------------------------------------------------------

export const getContextInspectorDb = createCachedSqlDbGetter({ cacheNegative: true });

// ---------------------------------------------------------------------------
// AskRepository lazy init — uses cockpit-wide PersistenceService singleton.
// cacheNegative: false — a failed probe retries on every call (exact
// pre-split behavior: `_cachedServerAskRepo` only ever caches a SUCCESSFUL
// repository instance).
// ---------------------------------------------------------------------------

const getAskDb = createCachedSqlDbGetter({ cacheNegative: false });
let _cachedServerAskRepo: AskRepository | null = null;

/**
 * Epoch the module-level SERVICE caches below were built under (mt#3638).
 *
 * The `createCachedSqlDbGetter` instances handle their own epoch checks, but
 * the service singletons (`_cachedServerAskRepo`, `_cachedTaskService`, …)
 * wrap a db handle captured at construction — a bumped epoch means that
 * handle belongs to a torn-down pool, so every service cache drops together.
 * (`_cachedChangesetReadDeps` is deliberately exempt: it caches GitHub
 * repo/token resolution, which does not touch the DB pool.)
 */
let _serviceCachesEpoch = -1;

function dropServiceCachesOnEpochChange(): void {
  const epoch = getPersistenceEpoch();
  if (epoch === _serviceCachesEpoch) return;
  _serviceCachesEpoch = epoch;
  _cachedServerAskRepo = null;
  _cachedFollowUpService = null;
  _cachedTaskService = null;
  _cachedTaskDetailDeps = null;
  _cachedServerSessionProvider = null;
}

export async function getServerAskRepository(): Promise<AskRepository | null> {
  dropServiceCachesOnEpochChange();
  if (_cachedServerAskRepo) return _cachedServerAskRepo;
  try {
    const db = await getAskDb();
    if (!db) return null;
    const { DrizzleAskRepository } = await import("@minsky/domain/ask/repository");
    _cachedServerAskRepo = new DrizzleAskRepository(db);
    return _cachedServerAskRepo;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// FollowUpService lazy init (mt#2322) — uses cockpit-wide PersistenceService
// singleton. cacheNegative: false, same rationale as getServerAskRepository:
// a failed probe retries on every call; only a SUCCESSFUL service instance
// is cached.
// ---------------------------------------------------------------------------

const getFollowUpDb = createCachedSqlDbGetter({ cacheNegative: false });
let _cachedFollowUpService:
  | import("@minsky/domain/scheduler/follow-up-service").FollowUpService
  | null = null;

// ---------------------------------------------------------------------------
// EngProd proposal-digest raw db handle (mt#3331) — uses cockpit-wide
// PersistenceService singleton. cacheNegative: false, same rationale as
// getServerAskRepository/getFollowUpDb: a failed probe retries on every
// call. The raw handle (not a wrapped service) is needed here because the
// accept/reject mutation writes BOTH `tasksTable` and
// `engprodProposalLedgerTable` inside a single `db.transaction()` — the
// atomicity the task/ledger writes need per spec SC2 ("if the two writes
// diverge, the gate's memory is broken") is not expressible through the
// abstracted TaskServiceInterface, which has no cross-table transaction
// seam. See ./routes/engprod-proposals.ts.
// ---------------------------------------------------------------------------

export const getServerEngprodDb = createCachedSqlDbGetter({ cacheNegative: false });

export async function getServerFollowUpService(): Promise<
  import("@minsky/domain/scheduler/follow-up-service").FollowUpService | null
> {
  dropServiceCachesOnEpochChange();
  if (_cachedFollowUpService) return _cachedFollowUpService;
  try {
    const db = await getFollowUpDb();
    if (!db) return null;
    const { FollowUpService } = await import("@minsky/domain/scheduler/follow-up-service");
    _cachedFollowUpService = new FollowUpService(db);
    return _cachedFollowUpService;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Task service lazy init — uses cockpit-wide PersistenceService singleton.
// ---------------------------------------------------------------------------

interface TaskDetailDeps {
  taskService: TaskServiceInterface;
  taskGraphService: TaskGraphService;
}

let _cachedTaskService: TaskServiceInterface | null = null;
let _cachedTaskDetailDeps: TaskDetailDeps | null = null;

export async function getServerTaskService(): Promise<TaskServiceInterface | null> {
  dropServiceCachesOnEpochChange();
  if (_cachedTaskService) return _cachedTaskService;
  try {
    const { createConfiguredTaskService } = await import("@minsky/domain/tasks/taskService");
    const provider = await getCachedPersistenceProvider();
    const taskService = await createConfiguredTaskService({
      workspacePath: process.cwd(),
      persistenceProvider: provider,
    });
    _cachedTaskService = taskService;
    return _cachedTaskService;
  } catch {
    return null;
  }
}

/**
 * Lazy-cached task detail deps (TaskService + TaskGraphService).
 * Uses cockpit-wide PersistenceService singleton. Retries on every call
 * until first success (cacheNegative: false semantics, same as
 * getServerAskRepository) — `_cachedTaskDetailDeps` only ever caches a
 * SUCCESSFUL result.
 */
export async function getServerTaskDetailDeps(): Promise<TaskDetailDeps | null> {
  dropServiceCachesOnEpochChange();
  if (_cachedTaskDetailDeps) return _cachedTaskDetailDeps;
  try {
    const { createConfiguredTaskService } = await import("@minsky/domain/tasks/taskService");
    const { TaskGraphService } = await import("@minsky/domain/tasks/task-graph-service");

    const provider = await getCachedPersistenceProvider();

    const taskService = await createConfiguredTaskService({
      workspacePath: process.cwd(),
      persistenceProvider: provider,
    });

    const sqlProvider = provider as SqlCapablePersistenceProvider;
    const db = await sqlProvider.getDatabaseConnection?.();
    if (!db) return null;

    const taskGraphService = new TaskGraphService(
      db as import("drizzle-orm/postgres-js").PostgresJsDatabase
    );

    _cachedTaskDetailDeps = { taskService, taskGraphService };
    return _cachedTaskDetailDeps;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session provider lazy init — uses cockpit-wide PersistenceService singleton
// (mt#1919). Mirrors the agents-widget defaultProviderFactory; kept separate
// so the endpoint and the widget caches stay independently invalidatable
// (mt#2362 touches the widget's cache).
// ---------------------------------------------------------------------------

let _cachedServerSessionProvider: SessionProviderInterface | null = null;

export async function getServerSessionProvider(): Promise<SessionProviderInterface | null> {
  dropServiceCachesOnEpochChange();
  if (_cachedServerSessionProvider) return _cachedServerSessionProvider;
  try {
    const { createSessionProvider } = await import(
      "@minsky/domain/session/drizzle-session-repository"
    );
    const persistenceProvider = await getCachedPersistenceProvider();
    const provider = await createSessionProvider(undefined, {
      persistenceService: {
        isInitialized: () => true,
        getProvider: () => persistenceProvider,
      },
    });
    _cachedServerSessionProvider = provider;
    return provider;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Changeset service lazy init (mt#3096) — the LIVE-PR data path used by
// `GET /api/changeset/:id`.
//
// Why this exists: that endpoint used to build its entire view from the cached
// `pullRequest` snapshot on the session record, whose `title` is almost always
// null — so the detail page rendered the literal "(no title)" for PRs that
// plainly have one. Reading the live PR removes that whole class of staleness.
//
// CREDENTIAL PATH: `ChangesetService` previously had no way to receive one —
// `getAdapter()` called `factory.createAdapter(repositoryUrl)` with no config,
// so the GitHub adapter fell back to `GITHUB_TOKEN` / `GH_TOKEN` env vars only.
// The cockpit daemon keeps its GitHub credential in Minsky config, not the
// environment, so that path yielded an adapter failing `isAvailable()`. mt#3096
// added the `adapterConfig` parameter threaded through here; token + repo
// resolution mirrors `deploy-smoke-sweep.ts`'s `buildRealDeps()`, the existing
// in-cockpit precedent for config-driven GitHub access.
//
// A FRESH service is built per call while the deps below stay cached: the
// adapter memoizes its Octokit on first use, so caching the service would pin a
// GitHub App installation token past its ~1h expiry and silently start 401ing.
// `tokenProvider` does its own caching, so rebuilding costs no extra round-trip
// in the common case.
//
// Returns null (never throws) when GitHub isn't configured or credential
// resolution fails — the caller degrades to the session-snapshot rendering.
// ---------------------------------------------------------------------------

interface ChangesetReadDeps {
  repoUrl: string;
  tokenProvider: TokenProvider;
}

let _cachedChangesetReadDeps: ChangesetReadDeps | null = null;

async function getChangesetReadDeps(): Promise<ChangesetReadDeps | null> {
  if (_cachedChangesetReadDeps) return _cachedChangesetReadDeps;

  const { getRepositoryBackendFromConfig } = await import(
    "@minsky/domain/session/repository-backend-detection"
  );
  const { repoUrl, github } = await getRepositoryBackendFromConfig();

  // `getRepositoryBackendFromConfig` has TWO return shapes, and this resolution
  // must survive both:
  //   1. Project-config path — `repository.url` plus an OPTIONAL
  //      `repository.github` sub-object ({owner, repo}). This project sets both.
  //   2. Auto-detection fallback — taken when `getConfiguration()` throws
  //      (notably "Configuration not initialized", i.e. any process that hasn't
  //      bootstrapped config). It returns `repoUrl` only, with NO `github`.
  // So neither field alone is safe to gate on: prefer `repoUrl`, and compose one
  // from `github` when only that is present.
  const resolvedUrl =
    repoUrl || (github ? `https://github.com/${github.owner}/${github.repo}.git` : "");

  // Mirrors GitHubChangesetAdapterFactory.canHandle — a non-GitHub remote has
  // no adapter to build.
  if (!resolvedUrl.includes("github.com")) return null;

  const { getConfiguration } = await import("@minsky/domain/configuration/index");
  const { createTokenProvider } = await import("@minsky/domain/auth");
  const cfg = getConfiguration();

  _cachedChangesetReadDeps = {
    repoUrl: resolvedUrl,
    tokenProvider: createTokenProvider(cfg.github ?? {}, cfg.github?.token ?? ""),
  };
  return _cachedChangesetReadDeps;
}

/**
 * Build a changeset service for the project's configured repository, or null
 * when GitHub isn't configured / the credential can't be resolved.
 *
 * Only the READ surface (`get`) is exercised by the cockpit — that path uses
 * Octokit directly and needs no `sessionProvider`. (Mutation methods and
 * `getDetails` would additionally require one; the cockpit does not call them.)
 */
export async function getServerChangesetService(): Promise<ChangesetService | null> {
  try {
    const deps = await getChangesetReadDeps();
    if (!deps) {
      log.debug("[cockpit] changeset service unavailable — no GitHub repository configured");
      return null;
    }
    const { createChangesetService } = await import("@minsky/domain/changeset/index");
    return await createChangesetService(deps.repoUrl, undefined, {
      repositoryUrl: deps.repoUrl,
      auth: { token: await deps.tokenProvider.getServiceToken() },
    });
  } catch (err) {
    // Never swallow silently: a dead credential path is indistinguishable from
    // "no live data" at the endpoint, which is exactly how a degraded page
    // looks healthy. Log the real reason.
    log.debug(
      `[cockpit] changeset service construction failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}

/**
 * Build a check-runs fetcher for the project's configured repository, or null
 * when GitHub isn't configured / the credential can't be resolved (mt#3097).
 *
 * Reuses the same cached repo + token resolution as the changeset service.
 * `getCheckRunsForRef` already fails CLOSED when both its underlying fetches
 * reject (it throws rather than reporting a misleading zero-checks result), so
 * the caller can distinguish "CI genuinely has no checks" from "we could not
 * find out" — which is what keeps the UI from rendering an unearned green.
 */
export async function getServerChecksReader(): Promise<
  ((headSha: string) => Promise<ChecksResult>) | null
> {
  try {
    const deps = await getChangesetReadDeps();
    if (!deps) {
      log.debug("[cockpit] checks reader unavailable — no GitHub repository configured");
      return null;
    }
    const { extractGitHubInfoFromUrl } = await import(
      "@minsky/domain/session/repository-backend-detection"
    );
    const gh = extractGitHubInfoFromUrl(deps.repoUrl);
    if (!gh) {
      log.debug(`[cockpit] checks reader unavailable — unparseable repo URL`);
      return null;
    }
    const { createOctokit } = await import("@minsky/domain/repository/github-pr-operations");
    const { getCheckRunsForRef } = await import("@minsky/domain/repository/github-pr-checks");
    const octokit = createOctokit(await deps.tokenProvider.getServiceToken());
    return (headSha: string) =>
      getCheckRunsForRef({ owner: gh.owner, repo: gh.repo }, headSha, octokit);
  } catch (err) {
    log.debug(
      `[cockpit] checks reader construction failed: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test-only reset (mt#3016) — mirrors shared-persistence.ts's
// __resetSharedPersistenceForTests(), same rationale: this module's caches
// are all module-level state, and bun shares module state across every test
// file that runs in one process. Confirmed empirically (mt#3016): running
// packages/domain/src/session-auto-task-creation.test.ts (whose beforeEach
// calls @minsky/domain/configuration's own equally global, equally un-reset
// initializeConfiguration()) before a cockpit widget/route test in the same
// process let getContextInspectorDb() resolve a REAL, non-null connection
// where the consuming test expected null — breaking a "no live db"
// assumption none of these getters had any way to guard against.
//
// This alone is NOT sufficient to fix that specific bug (a genuinely FRESH
// call to getContextInspectorDb() also resolves non-null once configuration
// has been initialized anywhere in-process — the actual mt#3016 fix is the
// getDb/getProjectScopeDb DI seams threaded through task-list.ts, agents.ts,
// routes/conversation-search.ts, and routes/conversations.ts). This reset
// is still exported as general test hygiene for this module's OWN cache
// state, matching the established shared-persistence.ts precedent, for any
// future test that needs a guaranteed-fresh probe.
// ---------------------------------------------------------------------------

/**
 * Reset every cached SQL-db getter this module has produced (via
 * `createCachedSqlDbGetter`, including `getContextInspectorDb` and the
 * private `getAskDb`/`getFollowUpDb` instances) plus every module-level
 * singleton cache below it, so each starts fresh on its next call.
 *
 * @internal Test-only. Production code must never call this.
 */
export function __resetDbProvidersForTests(): void {
  assertTestEnvironment("__resetDbProvidersForTests");
  for (const getter of _allCachedSqlDbGetters) {
    getter.__resetForTests();
  }
  _cachedServerAskRepo = null;
  _cachedFollowUpService = null;
  _cachedTaskService = null;
  _cachedTaskDetailDeps = null;
  _cachedServerSessionProvider = null;
  _cachedChangesetReadDeps = null;
  _serviceCachesEpoch = -1;
}
