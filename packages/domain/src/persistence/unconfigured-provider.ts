/**
 * Unconfigured Persistence Provider (mt#2349)
 *
 * Boot-tolerant placeholder used when persistence initialization fails because
 * no Postgres connection is configured. Lets the process boot — so `/health`,
 * `config get`, and other non-DB commands work offline — while failing with a
 * clear "configure Postgres" error the moment a DB-backed operation is
 * attempted (fail-on-use, not fail-on-boot).
 *
 * This is the boot-tolerant counterpart to removing the former silent SQLite
 * fallback: we no longer silently write to a local SQLite file when no Postgres
 * is configured, but we also don't crash the whole process at boot for commands
 * that never touch the database. Its capabilities are all `false`, so
 * capability-gated consumers (e.g. the MCP wake-enrichment / OAuth helpers that
 * check `capabilities.sql`) skip it gracefully rather than hitting the throw.
 */

import { PersistenceProvider, type PersistenceCapabilities } from "./types";
import type { VectorStorage } from "../storage/vector/types";
import type { VectorDomain } from "../storage/schemas/embeddings-schema-factory";

/**
 * Thrown when a DB-backed operation is attempted but persistence is not
 * configured (no Postgres connection). Carries `bootDeferrable = true` so the
 * DI container's `initialize()` can defer the failure to use-time for services
 * whose construction needs the database — letting non-DB commands and `/health`
 * boot — while still failing fast on every OTHER (real wiring) error. The
 * marker is a structural property (not an import) so the generic container layer
 * stays decoupled from the persistence layer.
 */
export class PersistenceUnavailableError extends Error {
  readonly bootDeferrable = true as const;
  constructor(message: string) {
    super(message);
    this.name = "PersistenceUnavailableError";
  }
}

/**
 * Structural marker for a substitute value a composition root registered in
 * place of a FAILED initialization (ADR-035 rule 1).
 *
 * A composition root "must not register a substitute value for a failed
 * initialization without also registering the retry." The container implements
 * that retry generically, so it needs to recognize such a substitute WITHOUT
 * importing the persistence layer — exactly the reason `bootDeferrable` above
 * is a structural property rather than an imported class. This is its
 * mirror-image for the returned-value path: `bootDeferrable` marks a failure
 * that was THROWN, this marks a failure that was CONVERTED INTO A VALUE.
 *
 * Deliberately NOT set for the deliberately-unconfigured boot path. ADR-035
 * rule 3 requires "configured but failing" to stay distinguishable from "not
 * configured": the second is a healthy, expected local/dev/offline state with
 * nothing to retry, and enrolling it would churn re-init attempts forever on a
 * laptop that simply has no database.
 */
export interface DegradedSubstitute {
  /** True only when this stands in for a failure that could later clear. */
  readonly degradedSubstitute: boolean;
  /**
   * ISO timestamp of the last re-initialization attempt, or `undefined` when
   * none has been made since boot. The absent case is load-bearing: it is what
   * distinguishes "stuck since boot" from "still retrying against a real
   * outage" (ADR-035 rule 4).
   */
  readonly lastAttemptAt?: string;
  /** Error from the last re-initialization attempt, when one has been made. */
  readonly lastAttemptError?: string;
  /** Record a re-initialization attempt that did not succeed. */
  noteRetryAttempt(at: Date, error: string): void;
}

/**
 * Structural type guard for {@link DegradedSubstitute}. Returns false for a
 * substitute whose `degradedSubstitute` is false (the unconfigured path).
 */
export function isDegradedSubstitute(value: unknown): value is DegradedSubstitute {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<DegradedSubstitute>;
  return candidate.degradedSubstitute === true && typeof candidate.noteRetryAttempt === "function";
}

const NO_CAPABILITIES: PersistenceCapabilities = {
  sql: false,
  transactions: false,
  jsonb: false,
  vectorStorage: false,
  migrations: false,
};

export class UnconfiguredPersistenceProvider extends PersistenceProvider {
  readonly capabilities = NO_CAPABILITIES;

  /**
   * @param reason The underlying initialization error message (typically the
   *   "PostgreSQL configuration required" error from the provider factory, or
   *   the real connection/migration error when a connection WAS configured).
   * @param configuredButUnavailable mt#2949: discriminates WHY this
   *   placeholder exists.
   *   - `false` (default): no Postgres connection was configured anywhere
   *     (no `persistence.postgres.connectionString`, no `MINSKY_POSTGRES_URL`).
   *     This is the deliberate, expected local/dev/offline boot path
   *     (mt#2349's original intent) — a laptop without a DB should not be
   *     bricked, and `/health` should stay green.
   *   - `true`: a Postgres connection string WAS configured, but
   *     `initialize()` failed (migration error, unreachable DB, bad
   *     credentials, etc). This is a genuine outage — the deployed-context
   *     case the 2026-07-19 incident missed. Consumers (`validatePostgresBackend`,
   *     `createConfiguredTaskService`, the `/health` route via
   *     `assessPersistenceHealth`) use this flag to fail loud instead of
   *     silently masking the failure as a legitimate degraded mode.
   */
  constructor(
    readonly reason: string,
    readonly configuredButUnavailable: boolean = false
  ) {
    super();
  }

  /**
   * Enrolls this placeholder for container-driven re-initialization (mt#3635)
   * when — and only when — it stands in for a configured backend that FAILED.
   * See {@link DegradedSubstitute} for why the unconfigured path is excluded.
   */
  get degradedSubstitute(): boolean {
    return this.configuredButUnavailable;
  }

  private _lastAttemptAt: string | undefined;
  private _lastAttemptError: string | undefined;

  /** ISO timestamp of the last re-init attempt; undefined means never retried. */
  get lastAttemptAt(): string | undefined {
    return this._lastAttemptAt;
  }

  /** Error from the last re-init attempt; undefined means never retried. */
  get lastAttemptError(): string | undefined {
    return this._lastAttemptError;
  }

  noteRetryAttempt(at: Date, error: string): void {
    this._lastAttemptAt = at.toISOString();
    this._lastAttemptError = error;
  }

  getCapabilities(): PersistenceCapabilities {
    return this.capabilities;
  }

  async initialize(): Promise<void> {
    // No-op: this provider represents the "could not initialize" state itself.
  }

  async close(): Promise<void> {
    // No-op: there is no underlying connection to release.
  }

  getConnectionInfo(): string {
    return "Unconfigured persistence (no Postgres connection — DB operations unavailable)";
  }

  private fail(): never {
    throw new PersistenceUnavailableError(
      `Persistence is not configured: ${this.reason} ` +
        "This operation requires a Postgres connection. Set " +
        "persistence.postgres.connectionString in config, or export " +
        "MINSKY_PERSISTENCE_POSTGRES_URL (or legacy MINSKY_POSTGRES_URL)."
    );
  }

  async getDatabaseConnection(): Promise<unknown> {
    this.fail();
  }

  async getRawSqlConnection(): Promise<unknown> {
    this.fail();
  }

  getVectorStorageForDomain(_domain: VectorDomain, _dimension: number): VectorStorage {
    this.fail();
  }
}

/**
 * Describe WHY a provider cannot serve DB-backed operations, for a consumer to
 * append to its own "not SQL-capable" error (mt#3636).
 *
 * "not SQL-capable" is true but not actionable: it says nothing about whether
 * Postgres was never configured (fix your config) or was configured and failed
 * to reach the database at boot (a genuine outage). Both produce the same
 * capability flags, and the discriminating detail — the initialization error —
 * is already on the placeholder; it was just never surfaced anywhere except
 * `persistence_check` and the boot log.
 *
 * Returns a sentence fragment intended to follow a caller's own prefix.
 */
export function describePersistenceUnavailability(provider: unknown): string {
  if (!(provider instanceof UnconfiguredPersistenceProvider)) {
    return "The active persistence provider is not SQL-capable.";
  }
  if (provider.configuredButUnavailable) {
    // mt#4383: this carries the correction mt#4379 made to the sibling
    // task-backend message, which was applied there and not here. The old
    // wording asserted "The database is unreachable" and "`minsky persistence
    // check` reports the same failure" in the PRESENT tense; both describe the
    // moment initialization failed, and both go false the instant the database
    // recovers. In the originating incident `persistence check` returned "All
    // checks passed" while this text claimed unreachability, and two separate
    // agent sessions each spent their first diagnostic minutes on a healthy
    // database.
    //
    // The parity claim was never derived from anything — it is a string
    // literal asserting that another command reports the same thing, which
    // nothing verifies. It is worse than unverified: `persistence check`
    // probes the LIVE connection while this describes the state one
    // initialization attempt left behind, so the two are EXPECTED to disagree
    // once the outage clears. Saying so is more useful than claiming parity.
    //
    // "Restart once the database is reachable" is also retired: since mt#4379
    // the container re-registers dependents on recovery, so a restart is no
    // longer the remedy it was when this sentence was written.
    //
    // The retry clause needs no new plumbing — `lastAttemptAt` /
    // `lastAttemptError` are already on this provider because ADR-035 rule 4
    // requires a degraded substitute to carry them, and their ABSENCE is the
    // load-bearing case: it distinguishes "stuck since boot" from "still
    // retrying against a real outage".
    const retryClause = provider.lastAttemptAt
      ? `Last re-initialization attempt ${provider.lastAttemptAt} also failed` +
        `${provider.lastAttemptError ? ` (${provider.lastAttemptError})` : ""}.`
      : "This provider has NOT been re-initialized since boot, so the underlying " +
        "dependency may well have recovered in the meantime.";
    return (
      `Postgres IS configured, but initialization failed AT BOOT: ${provider.reason}. ` +
      `${retryClause} This is a degraded provider, not a missing configuration, and not ` +
      "necessarily a current outage. Note `minsky persistence check` may well PASS while " +
      "this fails: it probes the live connection, whereas this reports the state this " +
      "provider was left in when initialization failed."
    );
  }
  return (
    `Persistence is not configured: ${provider.reason}. Set ` +
    "persistence.postgres.connectionString in config, or export " +
    "MINSKY_PERSISTENCE_POSTGRES_URL."
  );
}
