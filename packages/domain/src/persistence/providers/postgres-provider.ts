/**
 * PostgreSQL Persistence Provider
 *
 * Full-featured persistence provider with SQL, transactions, JSONB, and vector support.
 */

import { existsSync, statSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import {
  PersistenceProvider,
  VectorCapablePersistenceProvider,
  SqlCapablePersistenceProvider,
  PersistenceCapabilities,
  PersistenceConfig,
} from "../types";
import type { VectorStorage } from "../../storage/vector/types";
import { log } from "@minsky/shared/logger";
import { logPostgresNotice } from "../postgres-notice-handler";
import { guardRawSqlAgainstPoolerWedge, type GuardedRawSql } from "../raw-sql-pooler-guard";
import { PostgresVectorStorage } from "../../storage/vector/postgres-vector-storage";
import { withPgPoolRetry } from "../postgres-retry";
import { profileCheckpoint } from "@minsky/shared/cold-start-profile";
import {
  EMBEDDINGS_CONFIGS,
  type VectorDomain,
} from "../../storage/schemas/embeddings-schema-factory";

// Per-process pool size, DERIVED from a measured budget rather than picked
// (mt#4308). Minsky shares a single Supabase/Supavisor transaction-mode pooler
// (port 6543) across the whole fleet — every Claude Code conversation runs its
// own MCP process, plus the hosted Railway MCP, the reviewer, the cockpit, and
// ephemeral probes. What that pooler rations is CLIENT connections, and the
// budget is an order of magnitude smaller than this comment used to claim.
//
// WHAT THE PRIOR COMMENT GOT WRONG. It said the transaction-pooler swap
// (2026-04-24, memory 63fbc195) left a "practical ceiling in the thousands", so
// the value "no longer rations a scarce global budget" and could be sized purely
// for per-process fan-out. That ceiling was never measured — it came from an
// agent-authored memory, not from the vendor.
//
// MEASURED 2026-08-19: this project reports `max_connections = 60`, which
// Supabase's published compute table maps to the Nano/Micro tier, whose pooler
// ceiling is 200 CLIENT connections (both tiers are 200, so the tier ambiguity
// does not change the number). At the old default of 15, FOURTEEN processes
// saturate the pooler; the fleet was measured at 70-84 processes on 2026-08-18
// and 33-40 on 2026-08-19. The budget was being oversubscribed several times
// over.
//
// WHY DERIVED. mt#2224 set 15 correctly for the fleet IT measured, and nothing
// re-examined it when the fleet grew by an order of magnitude, because the
// assumption lived in prose rather than in code. Naming the three inputs makes
// the assumption checkable: if any of them changes, the default follows, and a
// reader can see WHICH one to re-measure.
const POOLER_CLIENT_BUDGET = 200;
// Share of that budget this fleet's long-lived local pools may claim. The rest
// is left for the hosted services (Railway MCP, reviewer, cockpit), ephemeral
// probes, and burst headroom — all of which contend for the same 200.
const POOL_BUDGET_FRACTION = 0.5;
// How many processes are assumed to hold an OPEN pool at once. Grounded in
// measurement, not process count: on 2026-08-18, 31 established connections came
// from 8 distinct pids (~4 each) while 70-84 `bun` processes were alive — pools
// open lazily, so holders are far fewer than processes. 12 carries ~50% headroom
// over that observation. THIS is the number to re-measure when the fleet changes.
const ASSUMED_CONCURRENT_POOL_HOLDERS = 12;
// Floor: below this, a widget that fans out queues on itself. mt#2224 raised the
// old value of 3 because it "starved widgets that fan out, e.g. the 4-parallel-
// query path in mt#2183" — so the fan-out latency mt#2224 bought is preserved
// only while the derived value stays at or above that width.
const MIN_DERIVED_POOL_SIZE = 4;
const DEFAULT_POSTGRES_MAX_CONNECTIONS = Math.max(
  MIN_DERIVED_POOL_SIZE,
  Math.floor((POOLER_CLIENT_BUDGET * POOL_BUDGET_FRACTION) / ASSUMED_CONCURRENT_POOL_HOLDERS)
);
// Override via persistence.postgres.maxConnections in config or the
// MINSKY_POSTGRES_MAX_CONNECTIONS env var.
// Note: the transaction-mode pooler is the primary connection used for all
// normal queries. For LISTEN/NOTIFY, a separate session-mode connection is
// maintained via `getListenCapableSqlConnection()` (mt#1852).

// Upper bound matching the config schema's .max(100). The env-var path
// (MINSKY_POSTGRES_MAX_CONNECTIONS) bypasses Zod validation, so this clamp is
// the only thing bounding it. NOTE (mt#4308): this ceiling is NOT safe to use
// fleet-wide — at 100 per process, THREE processes exceed the 200-client pooler
// budget. It bounds a deliberate single-process override (a migration runner, a
// one-off backfill), and the mt#2224-era claim that "the transaction pooler is
// no longer easy to saturate" that previously justified it is false. Kept at 100
// to stay consistent with the schema's .max(100) rather than because 100 is safe.
const MAX_POSTGRES_MAX_CONNECTIONS = 100;

/**
 * mt#1763 (PR #1065 R1 BLOCKING #3) — pure-function predicate for the
 * auto-migration decision. Extracted so tests can exercise the decision
 * logic without needing a real DB connection.
 *
 * Default OFF (mt#2560). Returns true ONLY when both:
 *   - the caller did NOT inject any `deps` (sqlClient or postgresFactory), AND
 *   - `MINSKY_AUTO_MIGRATE` is explicitly opted in ("true"/"1"/"yes"/"on", case-insensitive).
 *
 * Rationale: auto-migrate-on-boot is a shared-prod hazard — every binary
 * (hosted MCP, reviewer, cockpit daemon, stdio MCP servers, CLI) points at the
 * one shared Postgres. Prod migrations are applied by the deploy-keyed single
 * runner (mt#2505, .github/workflows/deploy-minsky-mcp.yml), so no binary needs
 * to migrate on boot. The opt-in is the "I solely own this non-shared/local DB"
 * assertion (runtime owner-detection is mt#2430).
 *
 * The `env` parameter is injectable so tests can override the env-var lookup
 * without mutating `process.env` (which leaks across tests).
 */
export function shouldAutoMigrate(
  deps?: { sqlClient?: unknown; postgresFactory?: unknown },
  env: NodeJS.ProcessEnv = process.env
): boolean {
  // Opt-in truthy set matches the repo convention (services/reviewer
  // review-worker.ts REVIEWER_MONOTONICITY_RECOVERY_ENABLED, PR #922):
  // true/1/yes/on, case-insensitive.
  const optedIn = /^(true|1|yes|on)$/i.test((env.MINSKY_AUTO_MIGRATE ?? "").trim());
  if (!optedIn) return false;
  const callerOwnsClient = deps?.sqlClient !== undefined || deps?.postgresFactory !== undefined;
  return !callerOwnsClient;
}

/**
 * mt#1767 — bundle-aware migrations folder resolution. Replaces mt#1763's
 * single-candidate path that worked in dev (Bun running `src/`) but failed
 * in the production bundle (Bun running `/app/dist/minsky.js`) because the
 * `import.meta.url`-relative `../../storage/migrations/pg` landed at
 * `/storage/migrations/pg`, outside `/app`.
 *
 * Resolution order (first existing wins):
 *   1. `MINSKY_MIGRATIONS_FOLDER` env override (errors loud if set + missing).
 *   2. `./storage/migrations/pg` relative to this module — production bundle
 *      path: bundle is at `/app/dist/minsky.js`, Dockerfile copies migrations
 *      to `/app/dist/storage/migrations/pg/`.
 *   3. `../../storage/migrations/pg` relative to this module — dev path:
 *      this file is at `src/domain/persistence/providers/postgres-provider.ts`,
 *      migrations are at `packages/domain/src/storage/migrations/pg/`.
 *
 * If none exist, throws with the candidates listed so the operator sees
 * exactly where the lookup looked. The mt#1787 bundle-boot-smoke CI gate
 * exercises this path on every PR — any regression in the Dockerfile copy
 * step or path-resolution logic surfaces at PR time.
 */
export function resolveMigrationsFolder(): string {
  const override = process.env.MINSKY_MIGRATIONS_FOLDER;
  if (override) {
    // PR #1094 R1 BLOCKING: validate the override is a directory, not just any
    // existing path. Without `isDirectory()`, a regular-file path would pass
    // this gate and then fail downstream inside drizzle's migrator with a less
    // actionable error. The error message below promises a directory check, so
    // honor that contract here.
    if (!existsSync(override) || !statSync(override).isDirectory()) {
      throw new Error(
        `MINSKY_MIGRATIONS_FOLDER=${override} but the directory does not exist or is not a directory. ` +
          `Set MINSKY_MIGRATIONS_FOLDER to a directory containing Drizzle migrations or unset to use the default.`
      );
    }
    return override;
  }
  const candidates = [
    fileURLToPath(new URL("./storage/migrations/pg", import.meta.url)),
    fileURLToPath(new URL("../../storage/migrations/pg", import.meta.url)),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Auto-migration directory not found. Tried: ${candidates.join(", ")}. ` +
      `This indicates the build artifact does not include the migrations folder. ` +
      `Either copy packages/domain/src/storage/migrations/pg/ next to the compiled module, ` +
      `or set MINSKY_MIGRATIONS_FOLDER to an absolute path, ` +
      `or unset MINSKY_AUTO_MIGRATE (auto-migrate is off by default) and apply migrations out-of-band.`
  );
}

function resolveMaxConnections(configured: number | undefined): number {
  const pick = (n: number): number => {
    if (n > MAX_POSTGRES_MAX_CONNECTIONS) {
      log.warn(
        `maxConnections (${n}) exceeds upper bound (${MAX_POSTGRES_MAX_CONNECTIONS}); clamping to prevent pooler saturation`
      );
      return MAX_POSTGRES_MAX_CONNECTIONS;
    }
    return n;
  };
  if (typeof configured === "number" && configured > 0) return pick(configured);
  const envRaw = process.env.MINSKY_POSTGRES_MAX_CONNECTIONS;
  if (envRaw) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed > 0) return pick(parsed);
  }
  return DEFAULT_POSTGRES_MAX_CONNECTIONS;
}

/** Fallback socket inactivity bound (seconds) when `idleTimeout` is unset or disabled. */
const DEFAULT_SOCKET_TIMEOUT_SECONDS = 60;

/** Floor on how often the inactivity check samples a socket's byte counters. */
const MIN_ACTIVITY_CHECK_MS = 250;

/**
 * A connection string that turns TLS on. postgres-js maps a `sslmode` query
 * parameter onto its `ssl` option (`index.js:443`), treating the literal
 * `disable` as off — this mirrors that reading, and only that one.
 */
const SSLMODE_ENABLED_PATTERN = /[?&]sslmode=(?!disable(?:&|$))/i;

/**
 * How long a connection's socket may sit with NO traffic before it is destroyed.
 *
 * Derived from `idle_timeout` rather than getting its own config key, so the two
 * cannot drift into contradicting each other. `socket.setTimeout` measures
 * INACTIVITY, and a healthy idle pooled connection is inactive by definition —
 * so any value below `idle_timeout` would destroy healthy connections earlier
 * than the idle policy already does, adding reconnect churn against the pooler
 * (~200-350ms per TLS handshake) for no benefit. Matching it costs nothing on
 * healthy connections and bounds the pathological case.
 *
 * `idle_timeout: 0` means "never idle out" in postgres-js and `setTimeout(0)`
 * means "no timeout" in Node — composing them would silently restore the
 * unbounded hang this exists to prevent, so a non-positive value is floored.
 */
export function resolveSocketTimeoutMs(idleTimeoutSeconds: number | undefined): number {
  const seconds =
    typeof idleTimeoutSeconds === "number" && idleTimeoutSeconds > 0
      ? idleTimeoutSeconds
      : DEFAULT_SOCKET_TIMEOUT_SECONDS;
  return seconds * 1000;
}

/** The subset of postgres-js's options object this factory reads. */
export interface SocketConnectOptions {
  host?: unknown;
  port?: unknown;
  path?: unknown;
}

/**
 * Build a CONNECTED socket that cannot sit half-open forever (mt#3592, after the
 * mt#3092 attempt that returned an unconnected one and took production down).
 *
 * THE PROBLEM. A connection dropped at the network level without the client
 * being notified — a half-open connection — leaves postgres-js's query promise
 * never settled: no error, no rejection, nothing to catch. The connection stays
 * checked out of the pool permanently, and after `max` of them the pool is dead
 * and every route hangs. Known upstream behaviour:
 * https://github.com/porsager/postgres/issues/1089. `keep_alive` does NOT detect
 * it — #1089 says so explicitly, and it is the obvious-looking fix.
 *
 * THE CONTRACT THIS MUST HONOUR. postgres-js `connection.js`, in `connect()`:
 *
 *     if (options.socket)
 *       return ssl ? secure() : connected()
 *
 * Supplying a `socket` factory makes postgres-js SKIP its own `socket.connect()`
 * entirely — it assumes what it gets back is already connecting/connected. The
 * first mt#3092 attempt returned `new net.Socket()` and every write hit a closed
 * socket (`Socket is closed`), across every Minsky process that talks to
 * Postgres. **This factory therefore connects the socket itself.** That matches
 * upstream #1089's own snippet, which calls `s.connect(...)` inline.
 *
 * IT MUST NOT AWAIT THE CONNECTION, and that is load-bearing rather than
 * stylistic. `connection.js`:
 *
 *     socket || (socket = await createSocket())   // the factory is awaited HERE
 *     if (!socket) return
 *     connectTimer.start()                        // the connect timer starts AFTER
 *
 * A factory that awaited its own `socket.connect()` would perform the whole TCP
 * connect before postgres-js arms `connect_timeout` — leaving a hanging connect
 * bounded by nothing, which is the same unbounded-wait class this exists to
 * remove. Returning mid-connect is also what upstream #1089 does, and both Node
 * and Bun buffer writes issued on a connecting socket, so the `StartupMessage`
 * postgres-js writes immediately after this returns is safe. It attaches its own
 * `error`/`close` handlers at the same point.
 *
 * WHY DESTROYING THE SOCKET REPAIRS THE POOL. postgres-js already errors an
 * in-flight query when its socket closes (the `closed()` handler:
 * `!hadError && (query || sent.length) && error(...CONNECTION_CLOSED...)`). The
 * queries hang precisely because the socket never closes; forcing a close turns
 * "never settles" into a rejection, which releases the pool slot and gives the
 * layers above a real error to classify and report.
 *
 * KNOWN LIMITATION 1 — multi-host. postgres-js rotates `hostIndex` across
 * `options.host` for multi-host failover, but that rotation lives in the branch
 * this factory replaces — so the first host/port pair is used. Minsky points at
 * a single Supabase pooler host, so this is not currently a behaviour change; it
 * would matter if a multi-host connection string were ever introduced.
 *
 * HOW INACTIVITY IS MEASURED, AND WHY NOT `socket.setTimeout`. By sampling the
 * socket's byte counters on an interval. `socket.setTimeout` looks like the
 * obvious mechanism — it is what upstream #1089 uses — but its meaning is
 * runtime-specific: Node refreshes that timer on socket activity, and Bun
 * 1.2.21 does not. Measured 2026-08-03 on this runtime: a socket receiving data
 * every 40ms, armed with `setTimeout(200, …)`, fired its timeout at 202ms.
 * Building on it here would sever every healthy pooled connection one
 * `idle_timeout` after it opened — and mid-query, since a query in flight moves
 * no bytes while it waits for its result. Counters are checked instead because
 * they mean the same thing in both runtimes.
 *
 * CONSEQUENCE WORTH KNOWING. At the socket layer a legitimate slow query is
 * indistinguishable from a hung one — both sit with no bytes moving — so a query
 * that runs longer than the bound WILL be severed. The bound derives from
 * `idle_timeout` (60s by default), well above anything this codebase issues on
 * the pooled client; a long DDL migration is the case to watch, since migrations
 * run on this same client.
 *
 * KNOWN LIMITATION 2 — there is no bound under TLS (mt#3603). When `sslmode` is
 * enabled, `buildPostgresClient` does not install this factory at all, and warns
 * that it did not. Two reasons. First, postgres-js's `secure()` calls
 * `socket.removeAllListeners()` before wrapping the socket in `tls.connect()`
 * (`connection.js:290`). Second — and this is why the path is skipped rather
 * than merely documented — it is UNVERIFIED whether the byte counters sampled
 * below still move once traffic runs through the wrapping TLS socket; if they do
 * not, the check would read a busy connection as idle and sever it, which is
 * worse than having no bound. Minsky does not take this path: no `ssl` option is
 * passed and no `sslmode` appears in the connection string, so `ssl` is
 * postgres-js's `false` default (`index.js:450`). mt#3603 owns bounding TLS.
 */
export function createBoundedSocket(timeoutMs: number, options: SocketConnectOptions): net.Socket {
  const socket = new net.Socket();

  let lastBytesRead = 0;
  let lastBytesWritten = 0;
  let lastActivityAt = performance.now();
  // The connect phase is postgres-js's `connect_timeout` to bound, not this
  // one's — start the inactivity clock when the connection is actually up.
  socket.once("connect", () => {
    lastActivityAt = performance.now();
  });

  // Detection lands in [timeoutMs, timeoutMs + checkMs]. A quarter of the bound
  // keeps that overshoot proportional without polling hot on a small bound.
  const checkMs = Math.max(MIN_ACTIVITY_CHECK_MS, Math.floor(timeoutMs / 4));
  const activityCheck = setInterval(() => {
    if (socket.destroyed) {
      clearInterval(activityCheck);
      return;
    }
    const { bytesRead, bytesWritten } = socket;
    if (bytesRead !== lastBytesRead || bytesWritten !== lastBytesWritten) {
      lastBytesRead = bytesRead;
      lastBytesWritten = bytesWritten;
      lastActivityAt = performance.now();
      return;
    }
    if (performance.now() - lastActivityAt < timeoutMs) return;

    clearInterval(activityCheck);
    // resetAndDestroy sends a TCP RST, which is what #1089 recommends — it tells
    // the peer the connection is gone rather than leaving it to time out. Guarded
    // for availability; `destroy()` is sufficient, since what the pool needs is
    // the 'close' that makes postgres-js settle the pending query, and both
    // produce it.
    if (typeof socket.resetAndDestroy === "function") {
      socket.resetAndDestroy();
    } else {
      socket.destroy();
    }
  }, checkMs);
  // A pooled socket outlives most CLI invocations; the check must never be the
  // reason a process cannot exit.
  activityCheck.unref();
  socket.on("close", () => clearInterval(activityCheck));

  // postgres-js skips its own connect for a custom socket — see the contract
  // above. It also skips its own `options.path` branch, so the unix-socket case
  // has to be handled here too.
  const path = options.path;
  if (typeof path === "string" && path.length > 0) {
    socket.connect(path);
    return socket;
  }

  // `host` and `port` are ARRAYS on the options object postgres-js builds
  // (`index.js`: `Array.isArray(host) ? host : host.split(',')...`), because of
  // multi-host support — reading them as scalars yields undefined.
  const host = Array.isArray(options.host) ? options.host[0] : options.host;
  const port = Array.isArray(options.port) ? options.port[0] : options.port;
  socket.connect(Number(port), String(host));
  return socket;
}

/**
 * Build the production postgres-js client for a config's `postgres` block.
 *
 * Single source of truth for the connection options (mt#2973) so the factory's
 * capability-probe connection and the provider's runtime connection are the
 * SAME shape of client — which lets the factory hand its already-open,
 * SELECT-1-validated client to the provider for reuse instead of each opening a
 * separate remote TLS handshake to the pooler.
 */
/** Injectable warn sink for buildPostgresClient (mt#3628). */
export interface BuildPostgresClientLogSink {
  warn: (message: string) => void;
}

const defaultBuildPostgresClientLogSink: BuildPostgresClientLogSink = { warn: log.warn };

export function buildPostgresClient(
  pgConfig: NonNullable<PersistenceConfig["postgres"]>,
  factory: typeof postgres = postgres,
  /**
   * Injectable warn sink (mt#3628); defaults to the real shared logger.
   * Lets the mt#3603 TLS-bound-limitation wiring test observe the emission
   * via a plain injected function instead of `spyOn(log, "warn")`.
   */
  logSink: BuildPostgresClientLogSink = defaultBuildPostgresClientLogSink
): ReturnType<typeof postgres> {
  const options = {
    max: resolveMaxConnections(pgConfig.maxConnections),
    connect_timeout: pgConfig.connectTimeout || 10,
    idle_timeout: pgConfig.idleTimeout || 60,
    prepare: pgConfig.prepareStatements ?? false,
    onnotice: logPostgresNotice,
  };
  if (SSLMODE_ENABLED_PATTERN.test(pgConfig.connectionString)) {
    // The bound is not installed on the TLS path — KNOWN LIMITATION 2 on
    // createBoundedSocket has the reasoning. Warn rather than fail: an
    // unbounded connection is how this worked before mt#3592, so TLS is not a
    // regression, but it must not look protected when it is not (mt#3603).
    logSink.warn(
      "postgres connection string enables sslmode; the socket inactivity bound is NOT installed on the TLS path (mt#3603) — half-open connections can still wedge the pool"
    );
  } else {
    const socketTimeoutMs = resolveSocketTimeoutMs(pgConfig.idleTimeout);
    // Assigned rather than declared inline: `socket` is honoured at runtime and
    // documented in the README, but is absent from postgres@3.4.8's shipped types.
    // Scoping the cast to this one key keeps full checking on every option above.
    (options as Record<string, unknown>).socket = (opts: SocketConnectOptions) =>
      createBoundedSocket(socketTimeoutMs, opts);
  }
  return factory(pgConfig.connectionString, options);
}

/**
 * Derive a session-mode-pooler URL from a Supavisor transaction-pooler URL by
 * swapping the URL's port from 6543 → 5432. Returns the input unchanged if the
 * URL is not on port 6543 (so non-Supavisor hosts pass through — the URL is
 * assumed to already be session-mode-capable).
 *
 * Supavisor exposes the same logical pooler on two ports with different semantics:
 *   - :6543 — transaction mode (pool connections between transactions; LISTEN-incompatible)
 *   - :5432 — session mode (one backend connection per client; LISTEN-compatible)
 *
 * Uses URL parsing (handles IPv6 literals, credentials, query strings correctly)
 * with a regex fallback for non-URL-shaped strings (e.g. libpq key=value format
 * — rare but supported by postgres-js). PR #1135 R1 NON-BLOCKING refinement.
 */
export function swapSupavisorPort(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.port === "6543") {
      url.port = "5432";
      return url.toString();
    }
    return connectionString;
  } catch {
    // Not URL-shaped (e.g. libpq key=value DSN). Fall back to a bounded regex
    // that only touches the authority's port segment between `@` and `/`.
    return connectionString.replace(/(@[^/?]*):6543(?=\/|$|\?)/, "$1:5432");
  }
}

/**
 * Base PostgreSQL persistence provider (without vector storage)
 */
export class PostgresPersistenceProvider
  extends PersistenceProvider
  implements SqlCapablePersistenceProvider
{
  protected db: PostgresJsDatabase | null = null;
  protected sql: ReturnType<typeof postgres> | null = null;
  /** Lazily-built pooler-guarded view of `sql` handed out by getRawSqlConnection (mt#2773). */
  protected guardedSql: GuardedRawSql | null = null;
  /** Dedicated session-mode connection for LISTEN/NOTIFY (mt#1852). Created lazily. */
  protected listenSql: ReturnType<typeof postgres> | null = null;
  protected config: PersistenceConfig;
  protected isInitialized = false;
  /**
   * mt#2973: a factory-probed, already-SELECT-1-validated client handed in for
   * REUSE. When set, initialize() adopts this client and skips its own connect
   * + SELECT 1 (the redundant second cold-boot handshake). Null on the
   * standalone path (the provider opens its own client). The provider OWNS this
   * client's lifecycle once adopted (close() ends it).
   */
  protected preValidatedSql: ReturnType<typeof postgres> | null = null;
  /**
   * mt#2973: whether the factory already verified pgvector on the pre-validated
   * client. When true, the vector provider skips its redundant re-probe.
   */
  protected pgvectorVerified = false;

  /**
   * Base PostgreSQL capabilities (no vector storage)
   */
  readonly capabilities: PersistenceCapabilities & { sql: true } = {
    sql: true,
    transactions: true,
    jsonb: true,
    vectorStorage: false,
    migrations: true,
  };

  // Note: Capabilities are returned by getCapabilities() method below

  constructor(
    config: PersistenceConfig,
    preValidated?: { sql: ReturnType<typeof postgres>; pgvectorVerified: boolean }
  ) {
    super();
    if (config.backend !== "postgres" || !config.postgres) {
      throw new Error("PostgresPersistenceProvider requires postgres configuration");
    }
    this.config = config;
    // mt#2973: the factory may hand us an already-open, capability-probed client
    // to reuse (eliminating a redundant second handshake). Adopted in initialize().
    if (preValidated) {
      this.preValidatedSql = preValidated.sql;
      this.pgvectorVerified = preValidated.pgvectorVerified;
    }
  }

  /** Returns the postgres config — guaranteed non-null by the constructor. */
  private get pgConfig(): NonNullable<PersistenceConfig["postgres"]> {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.config.postgres!;
  }

  /**
   * Initialize PostgreSQL connection
   */
  async initialize(deps?: {
    sqlClient?: ReturnType<typeof postgres>;
    postgresFactory?: typeof postgres;
    /**
     * Test-only override (mt#1763 PR #1065 R2 / mt#1767): when explicitly set,
     * overrides the deps-based suppression in `shouldAutoMigrate`. Lets a test
     * that injects a `postgresFactory` (to avoid a real socket) still flow
     * through the auto-migrate branch so behavioral coverage of the happy path
     * is possible without a real DB. Production callsites leave this
     * `undefined` and let `shouldAutoMigrate` decide.
     */
    _overrideAutoMigrate?: boolean;
  }): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    const pgConfig = this.pgConfig;
    // Track whether we created the connection (vs injected) for cleanup
    let createdSql: ReturnType<typeof postgres> | null = null;

    try {
      log.debug("Initializing PostgreSQL persistence provider");

      // Resolve the factory — allows tests to inject a mock without mock.module()
      const pgFactory = deps?.postgresFactory ?? postgres;

      // Connection sourcing (mt#2973), in priority order:
      //   1. deps.sqlClient — the test seam (caller owns it; suppresses
      //      auto-migrate via shouldAutoMigrate).
      //   2. this.preValidatedSql — a factory-probed client handed in for REUSE.
      //      The factory already opened the remote connection AND ran SELECT 1
      //      on it, so we adopt it and skip the provider's own handshake +
      //      SELECT 1 (the ~486ms redundant second cold-boot handshake). The
      //      provider OWNS this client now (tracked as createdSql for cleanup),
      //      and auto-migrate is honored normally (unlike the deps.sqlClient seam).
      //   3. Otherwise open a fresh client (the standalone path).
      // `onnotice` (inside buildPostgresClient) routes NOTICEs through log.debug
      // (postgres-notice-handler.ts) to keep stdout clean (mt#1827/mt#1828).
      const reusingProbedClient = !deps?.sqlClient && this.preValidatedSql !== null;
      const sql =
        deps?.sqlClient ?? this.preValidatedSql ?? buildPostgresClient(pgConfig, pgFactory);

      // Track connections we created/own so we can clean up on failure without
      // closing an injected test-seam client the caller still owns. The
      // factory-probed client IS provider-owned (the factory deliberately left
      // it open), so it is tracked here too.
      if (!deps?.sqlClient) {
        createdSql = sql;
      }

      // Create Drizzle instance
      const db = drizzle(sql);

      // Verify connection — retry on pool saturation (mt#1193). Skip when
      // reusing the factory's pre-validated client: it already ran SELECT 1
      // during the capability probe, so a second round-trip here is pure
      // redundant remote latency (the second handshake mt#2973 eliminates).
      if (!reusingProbedClient) {
        profileCheckpoint("pg_init_select1_start");
        await withPgPoolRetry(() => sql`SELECT 1`, "postgres-provider.initialize");
        profileCheckpoint("pg_init_select1_done");
      } else {
        profileCheckpoint("pg_init_reused_probed_client");
      }

      // Cache the connection objects BEFORE running migrations. runMigrations
      // uses `this.db` / `this.sql`, but `this.isInitialized` stays false until
      // migrations succeed — per mt#1763 R1 BLOCKING #1, callers waiting on
      // initialize() must not see isInitialized=true while migrations are
      // still running (race window where they could read pre-migration schema).
      this.sql = sql;
      this.db = db;
      // mt#2973: ownership of a reused probed client transfers fully to
      // this.sql now (createdSql tracks it for failure cleanup); clear the
      // field so close()'s orphan-cleanup path (never-initialized case) doesn't
      // double-end it.
      this.preValidatedSql = null;

      // mt#2560: auto-migrate-on-boot is OFF by default. It runs ONLY when the
      // MINSKY_AUTO_MIGRATE opt-in is set ("true"/"1") AND no deps were injected
      // (see `shouldAutoMigrate`). Prod is migrated by the deploy-keyed single
      // runner (mt#2505); no binary migrates a shared DB on boot. The
      // `_overrideAutoMigrate` test seam can force the branch (see initialize
      // signature for rationale).
      const autoMigrate = deps?._overrideAutoMigrate ?? shouldAutoMigrate(deps);
      if (autoMigrate) {
        // mt#2560 SC2: audit-log when the opt-in actually fires. This should
        // only happen for a local/dev/throwaway DB the caller solely owns —
        // NEVER a shared/prod DB.
        log.warn(
          "Auto-migrating on boot: MINSKY_AUTO_MIGRATE opt-in enabled. " +
            "Only safe for a local/dev/throwaway DB you solely own; " +
            "prod is migrated by the deploy-keyed runner (mt#2505)."
        );
        await this.runMigrations(resolveMigrationsFolder());
      } else if (deps?.sqlClient !== undefined || deps?.postgresFactory !== undefined) {
        log.debug("Skipping auto-migration: caller-injected deps (test seam)");
      } else {
        // debug (not warn): this is now the routine per-boot path on every CLI/
        // hook/session/MCP process — consistent with the sibling test-seam skip
        // above. Verified (mt#2560): no CI gate / smoke / runbook greps this line.
        log.debug(
          "Skipping auto-migration (default OFF, mt#2560): MINSKY_AUTO_MIGRATE not opted in. " +
            "Migrations are applied out-of-band by the deploy-keyed runner (mt#2505)."
        );
      }

      // All checks passed AND migrations applied — now mark initialized.
      this.isInitialized = true;
      log.debug("Base PostgreSQL persistence provider initialized");
    } catch (error) {
      // Clean up connection we created to prevent pool leaks
      if (createdSql) {
        try {
          await createdSql.end();
        } catch {
          /* ignore cleanup errors */
        }
      }
      this.sql = null;
      this.guardedSql = null;
      this.db = null;
      this.isInitialized = false;
      log.error(
        "Failed to initialize PostgreSQL provider:",
        error instanceof Error ? error : { error: String(error) }
      );
      throw error;
    }
  }

  /**
   * Get provider capabilities
   */
  getCapabilities(): PersistenceCapabilities {
    return this.capabilities;
  }

  /**
   * Get direct database connection
   */
  async getDatabaseConnection(): Promise<PostgresJsDatabase> {
    if (!this.isInitialized) {
      throw new Error("PostgresPersistenceProvider not initialized");
    }

    if (!this.db) {
      throw new Error("Database connection not available");
    }

    return this.db;
  }

  /**
   * Get raw SQL connection for migrations and low-level operations.
   *
   * Returns the pooler-guarded view (mt#2773 / PR #1922 R1): `.unsafe()` is
   * capped at pool-max in-flight and returns plain rows — see GuardedRawSql.
   */
  async getRawSqlConnection(): Promise<GuardedRawSql> {
    if (!this.isInitialized) {
      throw new Error("PostgresPersistenceProvider not initialized");
    }

    if (!this.sql) {
      throw new Error("Raw SQL connection not available");
    }

    // mt#2773: hand out a guarded view that bounds in-flight `.unsafe()`
    // queries at the pool's max — zero-bind raw queries submitted beyond pool
    // capacity wedge the Supavisor transaction pooler (connections destroyed
    // during ramp-up) and postgres-js never settles some of the destroyed
    // connection's promises. See raw-sql-pooler-guard.ts for the experiment
    // matrix and rationale. The underlying `this.sql` (used by drizzle and
    // sql.begin() transactions) is deliberately untouched.
    return this.getGuardedSql(this.sql);
  }

  /**
   * Memoized guarded view of `this.sql` (mt#2773; second consumer wired mt#4298).
   *
   * Every `.unsafe()` consumer MUST come through here rather than wrapping
   * `this.sql` itself. The guard's protection is a SHARED in-flight counter
   * bounded at the pool's `max`; two independently-constructed guards would
   * each admit `max` concurrent queries, so wrapping twice doubles the very
   * bound the cap exists to hold and reinstates the wedge it prevents.
   */
  protected getGuardedSql(sql: ReturnType<typeof postgres>): GuardedRawSql {
    if (!this.guardedSql) {
      this.guardedSql = guardRawSqlAgainstPoolerWedge(sql);
    }
    return this.guardedSql;
  }

  /**
   * Get a session-mode-capable Sql instance for LISTEN/NOTIFY (mt#1852).
   *
   * The transaction-mode pooler (:6543) is incompatible with LISTEN — the pooler
   * may route each command to a different backend connection, breaking per-connection
   * LISTEN registrations. This method returns a connection over the session-mode pooler
   * (:5432 on Supabase/Supavisor), which preserves backend connections for the life of
   * the client session.
   *
   * The connection is created lazily on first call and cached for the lifetime of this
   * provider instance. It uses max:1 and idle_timeout:0 so the LISTEN state persists
   * without expiration.
   *
   * The underlying Sql instance is NOT closed by this method — lifecycle is owned by
   * the caller (typically a `PostgresChannelListener`). `close()` on this provider
   * closes the listen connection as part of full teardown.
   */
  async getListenCapableSqlConnection(): Promise<ReturnType<typeof postgres>> {
    if (!this.isInitialized) {
      throw new Error("PostgresPersistenceProvider not initialized");
    }

    if (this.listenSql) {
      return this.listenSql;
    }

    const sessionUrl = this.resolveSessionConnectionString();
    this.listenSql = postgres(sessionUrl, {
      max: 1, // listener needs one connection; LISTEN state is per-connection
      connect_timeout: this.pgConfig.connectTimeout ?? 10,
      idle_timeout: 0, // never idle out — LISTEN must persist
      prepare: false,
      onnotice: logPostgresNotice,
    });

    return this.listenSql;
  }

  /**
   * Resolve the session-mode connection string for LISTEN/NOTIFY.
   * Uses the explicit sessionConnectionString config when set;
   * otherwise auto-derives by swapping :6543 → :5432 (Supavisor port-swap).
   */
  private resolveSessionConnectionString(): string {
    if (this.pgConfig.sessionConnectionString) {
      return this.pgConfig.sessionConnectionString;
    }
    // Supavisor port-swap auto-derive: transaction pooler is on :6543, session
    // pooler is on :5432, same host. For non-Supavisor hosts the URL is returned
    // unchanged (assumed already session-mode-capable).
    return swapSupavisorPort(this.pgConfig.connectionString);
  }

  /**
   * Run database migrations
   */
  async runMigrations(migrationsFolder: string): Promise<void> {
    if (!this.db) {
      throw new Error("Database connection not available");
    }

    try {
      log.info(`Running migrations from ${migrationsFolder}`);

      // Fresh-DB bootstrap (mt#2439): a database with an absent-or-empty
      // drizzle ledger cannot replay the migration tree — `0000` is an empty
      // baseline that assumes the pre-baseline schema exists, so `0001` fails
      // on a fresh database. Bootstrap from the committed full-schema snapshot
      // first; migrate() below then applies only entries newer than the
      // snapshot. Non-empty databases never enter this branch.
      if (this.sql) {
        const { bootstrapFreshPostgres, isMigrationLedgerEmpty } = await import(
          "../postgres-bootstrap"
        );
        if (await isMigrationLedgerEmpty(this.sql)) {
          const { readFileSync } = await import("fs");
          const { join } = await import("path");
          const journalRaw = readFileSync(join(migrationsFolder, "meta", "_journal.json"), {
            encoding: "utf8",
          }) as string;
          const bootstrap = await bootstrapFreshPostgres(
            this.sql,
            migrationsFolder,
            JSON.parse(journalRaw)
          );
          if (bootstrap) {
            log.info(
              `Bootstrapped fresh database through ${bootstrap.throughTag} ` +
                `(${bootstrap.stampedCount} journal entries stamped)`
            );
          }
        }
      }

      await migrate(this.db, { migrationsFolder });
      log.info("Migrations completed successfully");
    } catch (error) {
      log.error(
        "Failed to run migrations:",
        error instanceof Error ? error : { error: String(error) }
      );
      throw error;
    }
  }

  /**
   * Close database connections
   */
  async close(): Promise<void> {
    try {
      // Close the session-mode listen connection first (if created)
      if (this.listenSql) {
        try {
          await this.listenSql.end();
        } catch (listenErr) {
          log.warn(
            `Error closing listen SQL connection: ${listenErr instanceof Error ? listenErr.message : String(listenErr)}`
          );
        }
        this.listenSql = null;
      }
      // mt#2973: if a factory-probed client was handed in for reuse but
      // initialize() never adopted it into this.sql (constructed-then-closed
      // without initializing), end it here so the pool doesn't leak.
      if (!this.sql && this.preValidatedSql) {
        try {
          await this.preValidatedSql.end();
        } catch {
          /* ignore cleanup errors */
        }
        this.preValidatedSql = null;
      }
      if (this.sql) {
        await this.sql.end();
        this.sql = null;
        this.guardedSql = null;
        this.db = null;
        this.isInitialized = false;
        log.debug("PostgreSQL connections closed");
      }
    } catch (error) {
      log.error(
        "Error closing PostgreSQL connections:",
        error instanceof Error ? error : { error: String(error) }
      );
      throw error;
    }
  }

  /**
   * Get connection information
   */
  getConnectionInfo(): string {
    if (!this.config.postgres) {
      return "PostgreSQL: Not configured";
    }

    const connectionString = this.config.postgres.connectionString;
    // Remove credentials for display
    const displayString = connectionString.replace(/\/\/[^@]+@/, "//***@");

    return `PostgreSQL: ${displayString} (${this.isInitialized ? "connected" : "disconnected"})`;
  }
}

/**
 * PostgreSQL persistence provider with vector storage support
 * Only created when pgvector extension is available
 */
export class PostgresVectorPersistenceProvider
  extends PostgresPersistenceProvider
  implements VectorCapablePersistenceProvider
{
  /**
   * PostgreSQL capabilities with vector storage
   */
  override readonly capabilities: PersistenceCapabilities & { sql: true; vectorStorage: true } = {
    sql: true,
    transactions: true,
    jsonb: true,
    vectorStorage: true,
    migrations: true,
  };

  async initialize(deps?: {
    sqlClient?: ReturnType<typeof postgres>;
    postgresFactory?: typeof postgres;
    /**
     * Test-only override (mt#1763 PR #1065 R2 / mt#1767): forwarded to
     * `super.initialize()` so the auto-migrate branch is exercisable in
     * tests that inject a `postgresFactory` to avoid a real DB socket.
     */
    _overrideAutoMigrate?: boolean;
  }): Promise<void> {
    // Initialize base PostgreSQL functionality first
    await super.initialize(deps);

    // Verify pgvector extension is available (should have been checked by factory)
    if (!this.sql) {
      throw new Error("SQL connection not available");
    }

    // mt#2973: when the factory already verified pgvector (on the client it
    // handed us for reuse), the class choice IS the verification — re-running
    // the pg_extension probe here is a redundant remote round-trip (~81ms).
    // Only probe on the standalone path (no factory verdict), where this IS the
    // first and only check.
    if (this.pgvectorVerified) {
      profileCheckpoint("pg_init_vector_reprobe_skipped");
      log.debug(
        "PostgreSQL persistence provider initialized with vector support (factory-verified)"
      );
      return;
    }

    try {
      const result = await this.sql`
        SELECT EXISTS (
          SELECT 1 FROM pg_extension WHERE extname = 'vector'
        ) as exists
      `;
      profileCheckpoint("pg_init_vector_reprobe");

      if (!result[0]?.exists) {
        throw new Error("pgvector extension not available - factory should have prevented this");
      }

      log.debug("PostgreSQL persistence provider initialized with vector support");
    } catch (error) {
      log.error(
        "Failed to verify pgvector extension:",
        error instanceof Error ? error : { error: String(error) }
      );
      throw error;
    }
  }

  /**
   * Get vector storage for a specific domain.
   * Each domain has its own embeddings table (EMBEDDINGS_CONFIGS); this method
   * routes to the correct table, preventing cross-domain contamination.
   */
  getVectorStorageForDomain(domain: VectorDomain, dimension: number): VectorStorage {
    if (!this.isInitialized) {
      throw new Error("PostgresVectorPersistenceProvider not initialized");
    }

    if (!this.sql || !this.db) {
      throw new Error("Database connections not available");
    }

    const config = EMBEDDINGS_CONFIGS[domain];
    // The `metadata` (JSONB) and `content_hash` (TEXT) columns are created by
    // createEmbeddingsTable() on every embeddings table; pass them through so
    // PostgresVectorStorage actually writes the values it's been given.
    // Pre-mt#1930 these were silently dropped on the floor.
    // mt#4298: hand vector storage the GUARDED instance. Its queries — the
    // `<-> $1::vector` search, store, and delete — all go through `.unsafe()`,
    // which is exactly the surface mt#2773's guard bounds. Passing the raw
    // `this.sql` here left every tasks_search / *_similar / index write as
    // unguarded raw fan-out at the Supavisor transaction pooler, whose wedge
    // leaves postgres-js promises permanently unsettled — hangs with no error.
    // The mt#2773 carve-out covers drizzle-driver traffic and sql.begin(), not
    // this consumer.
    return new PostgresVectorStorage(this.getGuardedSql(this.sql), this.db, dimension, {
      tableName: config.tableName,
      idColumn: config.idColumn,
      embeddingColumn: config.vectorColumn,
      lastIndexedAtColumn: config.indexedAtColumn,
      metadataColumn: "metadata",
      contentHashColumn: "content_hash",
    });
  }

  getConnectionInfo(): string {
    const baseInfo = super.getConnectionInfo();
    return baseInfo.replace("PostgreSQL:", "PostgreSQL (with vectors):");
  }
}
