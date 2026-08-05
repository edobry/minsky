/**
 * Persistence Service
 *
 * Injectable service for managing persistence provider lifecycle.
 * Created by the DI container in composition roots — domain code
 * receives it via constructor injection or typed deps interfaces.
 *
 * @see mt#814 — converted from static singleton to injectable instance
 */

import { injectable } from "tsyringe";
import {
  PersistenceProvider,
  VectorCapablePersistenceProvider,
  PersistenceConfig,
  CapabilityNotSupportedError,
} from "./types";
import { PersistenceProviderFactory } from "./factory";
import { getConfiguration } from "../configuration";
import { getEffectivePersistenceConfig } from "../configuration/persistence-config";
import type { Configuration } from "../configuration/schemas";
import { log } from "@minsky/shared/logger";
import type { VectorStorage } from "../storage/vector/types";
import type { VectorDomain } from "../storage/schemas/embeddings-schema-factory";
import {
  type RetryBackoffState,
  initialRetryBackoffState,
  canAttempt,
  recordAttemptStart,
  widenBackoff,
  resetBackoff,
} from "./retry-backoff";

/**
 * Build a PersistenceConfig from a Configuration.
 *
 * Resolution priority (see getEffectivePersistenceConfig):
 *   1. config.persistence.*
 *   2. MINSKY_POSTGRES_URL env var (connection string only)
 *   3. Hard-coded default (backend = postgres)
 *
 * Throws LegacySessiondbConfigError if the merged config still contains a
 * sessiondb: block (see mt#1610).
 *
 * Exported as a pure function so the env-var-only resolution path is unit-
 * testable without mocking the global configuration provider.
 */
export function buildPersistenceConfigFrom(runtimeConfig: Configuration): PersistenceConfig {
  const effective = getEffectivePersistenceConfig(runtimeConfig);
  return {
    backend: effective.backend as PersistenceConfig["backend"],
    // Spread the full postgres sub-object (carries maxConnections, connectTimeout, etc.)
    // falling back to a minimal object when only the flat connectionString is available.
    postgres:
      effective.postgres ??
      (effective.connectionString ? { connectionString: effective.connectionString } : undefined),
  };
}

/**
 * Persistence service — injectable instance.
 *
 * Manages the lifecycle of a PersistenceProvider (database connection).
 * Created once per application context (CLI, MCP, test) via the DI container.
 */
@injectable()
export class PersistenceService {
  private provider: PersistenceProvider | null = null;
  private initPromise: Promise<void> | null = null;
  /** Config from the most recent `initialize()` call — reused by retry attempts (mt#3751). */
  private lastConfig: PersistenceConfig | undefined;
  /**
   * Retry/backoff bookkeeping for {@link getProviderWithRetry} (mt#3751 /
   * ADR-035 rule 1). See `retry-backoff.ts` for the shape and its provenance.
   */
  private retryState: RetryBackoffState = initialRetryBackoffState();
  /** Guards against overlapping retry attempts from concurrent callers. */
  private retryInFlight = false;
  /** Error message from the most recent FAILED attempt; undefined once healthy. */
  private lastAttemptErrorMessage: string | undefined;
  /**
   * Wall-clock ms of the FIRST attempt in the current degraded streak, or
   * undefined while healthy. Used to log the elapsed degraded duration on
   * recovery (mt#3751 SC5) — reset to undefined the moment `initialize()`
   * next succeeds.
   */
  private degradedSinceMs: number | undefined;
  /** Total `performInitialization()` invocations, for diagnostics/reporting. */
  private attemptCount = 0;
  /**
   * True once this instance's FIRST `performInitialization()` call has
   * completed (success or failure) — the explicit boot/retry boundary
   * (mt#3751 PR #2672 R1 NON-BLOCKING fix, replacing an `attemptCount <= 1`
   * comparison the reviewer flagged as an implicit encoding of this rule).
   *
   * The semantic this exists to pin down: **attempt #1 on a fresh instance
   * is ALWAYS the "boot attempt"** — whether it was triggered by an
   * explicit `initialize()` call or implicitly by `getProviderWithRetry()`
   * finding `attemptCount === 0`. Every attempt after that is a "retry
   * attempt". `lastRetryAttemptAt` below reads `lastAttemptWasRetry`
   * (captured per-attempt from this flag's value BEFORE the attempt) rather
   * than re-deriving the boundary from a raw count, so the rule has exactly
   * one place it's decided.
   */
  private bootAttemptCompleted = false;
  /**
   * Whether the MOST RECENT `performInitialization()` call was a retry
   * (true) or the boot attempt (false) — see {@link bootAttemptCompleted}.
   * ADR-035 rule 4: a boot-only failure must render `persistence_check`'s
   * "stuck since boot" branch; the first retry onward must render "retrying
   * since <ts>, live outage". This flag is what `lastRetryAttemptAt`
   * consults to pick the branch.
   */
  private lastAttemptWasRetry = false;

  /**
   * @param rand Injectable jitter source (mt#3751 PR #2672 R1 fix), default
   *   `Math.random`. Passed through to `widenBackoff()` on every retry so
   *   the backoff schedule is actually jittered (SC3) rather than pure
   *   doubling — tests inject a deterministic function to pin the jittered
   *   value or to prove two different `rand`s produce different schedules.
   */
  constructor(private readonly rand: () => number = Math.random) {}

  /**
   * Initialize the persistence service with configuration.
   * Safe to call multiple times — concurrent calls are coalesced.
   */
  async initialize(config?: PersistenceConfig): Promise<void> {
    if (config) {
      this.lastConfig = config;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.performInitialization(config ?? this.lastConfig);

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private async performInitialization(config?: PersistenceConfig): Promise<void> {
    // Captured BEFORE this attempt mutates state — see `bootAttemptCompleted`'s
    // doc comment for why this ordering is what makes the boot/retry boundary
    // unambiguous rather than re-derived from a count after the fact.
    this.lastAttemptWasRetry = this.bootAttemptCompleted;
    this.bootAttemptCompleted = true;
    this.attemptCount += 1;
    recordAttemptStart(this.retryState);
    try {
      const persistenceConfig = config || PersistenceService.loadConfiguration();
      const provider = await PersistenceProviderFactory.create(persistenceConfig);
      await provider.initialize();
      this.provider = provider;
      this.lastAttemptErrorMessage = undefined;
      if (this.degradedSinceMs !== undefined) {
        // mt#3751 SC5: log the latched-to-recovered transition at warn with
        // the elapsed degraded duration — this is the ONE signal an operator
        // gets that a self-heal actually happened, since nothing else in this
        // process changes state visibly (no restart, no user-facing error).
        const elapsedMs = Date.now() - this.degradedSinceMs;
        log.warn(
          `PersistenceService recovered after ${elapsedMs}ms degraded ` +
            `(re-initialization succeeded on attempt ${this.attemptCount})`
        );
        this.degradedSinceMs = undefined;
      }
      resetBackoff(this.retryState);
      log.info("PersistenceService initialized successfully");
    } catch (error) {
      this.provider = null;
      const message = error instanceof Error ? error.message : String(error);
      this.lastAttemptErrorMessage = message;
      if (this.degradedSinceMs === undefined) {
        this.degradedSinceMs = Date.now();
      }
      log.error(
        "Failed to initialize PersistenceService:",
        error instanceof Error ? error : { error: String(error) }
      );
      throw error;
    }
  }

  /**
   * Retry-aware provider accessor (mt#3751 / ADR-035 rule 1).
   *
   * `getProvider()` below is unchanged: it throws immediately and
   * unconditionally once `this.provider` is unset, and every existing
   * caller (44+ production call sites as of mt#3751) keeps that exact
   * synchronous contract. This method is for a caller that wants a
   * DB-backed operation to SELF-HEAL instead: if the most recent attempt
   * failed and enough backoff time has elapsed (doubling from
   * `RETRY_MIN_INTERVAL_MS`, capped at `RETRY_MAX_INTERVAL_MS`, ±20% jitter
   * — see `retry-backoff.ts`), this transparently re-attempts
   * `initialize()` before deciding whether to throw. A caller that was IDLE
   * through an entire outage and only calls this once the database has
   * recovered gets a working provider on that very call — no background
   * poller, no process restart (mt#3751 SC1/SC2).
   *
   * Usage-gated, not time-gated: nothing runs unless something calls this.
   */
  async getProviderWithRetry(): Promise<PersistenceProvider> {
    if (this.provider) {
      return this.provider;
    }
    const neverAttempted = this.attemptCount === 0;
    if (!this.retryInFlight && (neverAttempted || canAttempt(this.retryState))) {
      this.retryInFlight = true;
      try {
        await this.initialize(this.lastConfig);
      } catch {
        // performInitialization() already recorded the failure; widen the
        // backoff (WITH jitter — mt#3751 PR #2672 R1 fix: this call used to
        // omit `this.rand`, so the schedule doubled deterministically and
        // never actually spread the 70+-process fleet's retries, silently
        // missing SC3 despite `applyJitter()` existing in retry-backoff.ts)
        // so the NEXT call doesn't hammer immediately behind this one.
        widenBackoff(this.retryState, this.rand);
      } finally {
        this.retryInFlight = false;
      }
    }
    return this.getProvider();
  }

  /** True once at least one `initialize()` attempt has failed with no success since. */
  isDegraded(): boolean {
    return this.provider === null && this.lastAttemptErrorMessage !== undefined;
  }

  /**
   * ISO timestamp of the most recent re-initialization attempt, or
   * `undefined` when either nothing has been attempted yet, or the LAST
   * attempt this instance made was the original boot attempt (not a retry)
   * — `persistence_check`-style consumers use the undefined case to render
   * "stuck since boot" vs "retrying since <ts>" (ADR-035 rule 4). The
   * boot-vs-retry decision is `lastAttemptWasRetry`, not a count comparison
   * — see that field's doc comment for the exact rule.
   */
  get lastRetryAttemptAt(): string | undefined {
    if (!this.lastAttemptWasRetry) return undefined;
    return this.retryState.lastAttemptAtMs !== null
      ? new Date(this.retryState.lastAttemptAtMs).toISOString()
      : undefined;
  }

  /** Error message from the most recent failed attempt, whether boot or retry. */
  get lastAttemptError(): string | undefined {
    return this.lastAttemptErrorMessage;
  }

  /** Total `initialize()` attempts made by this instance (boot counts as 1). */
  get retryAttemptCount(): number {
    return this.attemptCount;
  }

  /**
   * Load configuration from runtime config via the documented fallback chain.
   * See `buildPersistenceConfigFrom` for the resolution semantics. Static
   * because it doesn't depend on instance state.
   */
  private static loadConfiguration(): PersistenceConfig {
    return buildPersistenceConfigFrom(getConfiguration());
  }

  /**
   * Get the persistence provider instance.
   * Throws if not initialized.
   */
  getProvider(): PersistenceProvider {
    if (!this.provider) {
      throw new Error("PersistenceService not initialized. Call initialize() first.");
    }
    return this.provider;
  }

  /**
   * Get vector storage for a specific domain — preferred API.
   * Routes to the correct embeddings table via EMBEDDINGS_CONFIGS, preventing
   * cross-domain table contamination.
   */
  getVectorStorageForDomain(domain: VectorDomain, dimension: number): VectorStorage {
    const provider = this.getProvider();

    if (!this.isVectorCapable(provider)) {
      throw new CapabilityNotSupportedError("vectorStorage", provider.constructor.name);
    }

    return provider.getVectorStorageForDomain(domain, dimension);
  }

  private isVectorCapable(
    provider: PersistenceProvider
  ): provider is VectorCapablePersistenceProvider {
    return (
      provider.capabilities.vectorStorage === true &&
      "getVectorStorageForDomain" in provider &&
      typeof (provider as VectorCapablePersistenceProvider).getVectorStorageForDomain === "function"
    );
  }

  /**
   * Check if service is initialized.
   */
  isInitialized(): boolean {
    return this.provider !== null;
  }

  /**
   * Close the persistence service and release resources.
   */
  async close(): Promise<void> {
    if (this.provider) {
      await this.provider.close();
      this.provider = null;
    }
  }
}
