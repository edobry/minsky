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
import type { ChangesetAdapter } from "@minsky/domain/changeset/adapter-interface";
import type { TokenProvider } from "@minsky/domain/auth";
import { log } from "@minsky/shared/logger";

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
 */
export function createCachedSqlDbGetter(options: {
  cacheNegative: boolean;
  getProvider?: () => Promise<unknown>;
}): CachedSqlDbGetter {
  const getProvider = options.getProvider ?? getCachedPersistenceProvider;
  let cachedDb: PostgresJsDatabase | null = null;
  let probedAndFailed = false;

  const getCachedSqlDb = async function getCachedSqlDb(): Promise<PostgresJsDatabase | null> {
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
    } catch {
      probedAndFailed = true;
      return null;
    }
  } as CachedSqlDbGetter;

  getCachedSqlDb.__resetForTests = () => {
    assertTestEnvironment("__resetForTests");
    cachedDb = null;
    probedAndFailed = false;
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

export async function getServerAskRepository(): Promise<AskRepository | null> {
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

export async function getServerFollowUpService(): Promise<
  import("@minsky/domain/scheduler/follow-up-service").FollowUpService | null
> {
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
// Changeset reader lazy init (mt#3096) — the LIVE-PR data path used by
// `GET /api/changeset/:id`.
//
// Why this exists: that endpoint used to build its entire view from the cached
// `pullRequest` snapshot on the session record, whose `title` is almost always
// null — so the detail page rendered the literal "(no title)" for PRs that
// plainly have one. Reading the live PR removes that whole class of staleness.
//
// Why the adapter is constructed DIRECTLY instead of via
// `createChangesetService()`: that path cannot carry a credential.
// `ChangesetService.getAdapter()` calls `factory.createAdapter(repositoryUrl)`
// with no config, and `GitHubChangesetAdapter`'s own fallback resolves only
// `config.token` / `GITHUB_TOKEN` / `GH_TOKEN` — all empty for the cockpit
// daemon, which keeps its GitHub credential in Minsky config, not the
// environment. Passing an explicit `tokenProvider` is the only way to
// authenticate this read path. Token/repo resolution mirrors
// `deploy-smoke-sweep.ts`'s `buildRealDeps()`, the existing in-cockpit
// precedent for config-driven GitHub access.
//
// A FRESH adapter is built per call while the deps below stay cached: the
// adapter memoizes its Octokit on first use, so caching the adapter itself
// would pin a GitHub App installation token past its ~1h expiry and silently
// start 401ing. `tokenProvider` does its own caching, so rebuilding costs no
// extra round-trip in the common case.
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
  const { repoUrl } = await getRepositoryBackendFromConfig();

  // Key off `repoUrl`, NOT the optional `github` sub-object: that sub-object is
  // populated only when `repository.github` is explicitly set in project config
  // (see getRepositoryBackendFromConfig), which this project does not set — it
  // configures `repository.backend` + `repository.url` only. Gating on `github`
  // made the reader permanently null, i.e. an inert live path that degraded
  // silently forever. `repoUrl` is always populated, and the adapter derives
  // owner/repo from it via extractGitHubInfoFromUrl.
  //
  // The github.com check mirrors GitHubChangesetAdapterFactory.canHandle —
  // a non-GitHub remote has no adapter to build.
  if (!repoUrl || !repoUrl.includes("github.com")) return null;

  const { getConfiguration } = await import("@minsky/domain/configuration/index");
  const { createTokenProvider } = await import("@minsky/domain/auth");
  const cfg = getConfiguration();

  _cachedChangesetReadDeps = {
    repoUrl,
    tokenProvider: createTokenProvider(cfg.github ?? {}, cfg.github?.token ?? ""),
  };
  return _cachedChangesetReadDeps;
}

/**
 * Build a read-capable GitHub changeset adapter for the project's configured
 * repository, or null when GitHub isn't configured / the credential can't be
 * resolved.
 *
 * Only the READ surface (`get`) is exercised by the cockpit — that path uses
 * Octokit directly and needs no `sessionProvider`. (Mutation methods and
 * `getDetails` would additionally require one; the cockpit does not call them.)
 */
export async function getServerChangesetService(): Promise<ChangesetAdapter | null> {
  try {
    const deps = await getChangesetReadDeps();
    if (!deps) {
      log.debug("[cockpit] changeset reader unavailable — no GitHub repository backend configured");
      return null;
    }
    const { GitHubChangesetAdapter } = await import("@minsky/domain/changeset/index");
    return new GitHubChangesetAdapter(deps.repoUrl, undefined, {
      tokenProvider: deps.tokenProvider,
    });
  } catch (err) {
    // Never swallow silently: a dead credential path is indistinguishable from
    // "no live data" at the endpoint, which is exactly how a degraded page
    // looks healthy. Log the real reason.
    log.debug(
      `[cockpit] changeset reader construction failed: ${
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
}
