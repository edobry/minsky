/**
 * EmbeddingsHealthTracker — singleton health tracker for the embeddings subsystem.
 *
 * Mirrors the DisconnectTracker pattern (mt#1645/mt#1682): in-memory ring buffer
 * of error events, summary for debug_systemInfo, and event emission on degradation.
 *
 * mt#2568: the one-shot `setEventEmitter()` fast-path wired fire-and-forget by
 * the MCP start-command has no retry. Pre-fix, `emitDegradationEvent` fired
 * ONCE per degradation cycle with `emittedForCurrentDegradation` latching to
 * true regardless of whether the emit actually succeeded — so a degradation
 * that raced the startup wiring (e.g. on a proxy/staleness-respawned server,
 * the exact race mt#2562/mt#2567 diagnosed for the presence write-path) lost
 * that `embeddings.provider_degraded` event PERMANENTLY for the cycle, not
 * just until the wiring caught up. `registerEventEmitterBuilder` gives
 * `emitDegradationEvent` a per-call fallback that builds a fresh EventEmitter
 * from the container on demand (mirrors the `buildAskRepository` /
 * `getPresenceClaimRepo` remedy from mt#2567). The latch now only sets on a
 * CONFIRMED successful emit (PR #2284 R1) — a transient per-call
 * builder/emit failure leaves it retriable by the next `recordError` call in
 * the same cycle, rather than reintroducing a narrower version of the same
 * permanent-loss bug one layer down.
 *
 * PR #2284 R2: "confirmed successful emit" required switching from
 * `EventEmitter.emit()` to `EventEmitterWithTryEmit.tryEmit()`. `emit()`'s
 * documented contract is "always resolves, never rejects, even on a DB
 * write failure" — so the R1 fix's `try { await emitter.emit(...); return
 * true } catch { return false }` could NEVER observe a real insert failure;
 * the latch would still incorrectly flip to `true` on a dead DB. `tryEmit`
 * (already the established pattern for retry-gating callers — see
 * `emit-best-effort.ts`, `bulk-edit-command.ts`) returns the actual
 * persistence signal.
 *
 * @see mt#2147 — this task (original wiring)
 * @see mt#2568 — per-call fallback for the startup-wiring race
 * @see src/mcp/disconnect-tracker.ts — architectural precedent
 */

import { log } from "@minsky/shared/logger";
import type { EventEmitterWithTryEmit, SystemEventInput } from "../events/emitter";

export type EmbeddingsHealthStatus = "healthy" | "degraded" | "exhausted";

export interface EmbeddingsErrorEvent {
  timestamp: string;
  provider: string;
  errorCode: string;
  message: string;
}

export interface EmbeddingsHealthSummary {
  provider: string;
  status: EmbeddingsHealthStatus;
  lastErrorAt: string | null;
  errorCountLastHour: number;
  degradedReason: string | null;
  fallbackActive: boolean;
  fallbackProvider: string | null;
}

/** Per-call fallback builder registered by the MCP start-command (mt#2568). */
export type EmbeddingsEventEmitterBuilder = () => Promise<EventEmitterWithTryEmit | null>;

const MAX_EVENTS = 100;
const ONE_HOUR_MS = 60 * 60 * 1000;

export class EmbeddingsHealthTracker {
  private static instance: EmbeddingsHealthTracker | null = null;

  /**
   * Per-call fallback builder (mt#2568). Class-level (not per-instance) —
   * there is exactly one EmbeddingsHealthTracker singleton per process, same
   * lifetime assumption `instance` already makes. Registered once by the MCP
   * start-command; invoked by `emitDegradationEvent` whenever the one-shot
   * `setEventEmitter()` fast-path hasn't fired yet (or failed outright).
   */
  private static eventEmitterBuilder: EmbeddingsEventEmitterBuilder | null = null;

  private events: EmbeddingsErrorEvent[] = [];
  private eventEmitter: EventEmitterWithTryEmit | null = null;
  private emittedForCurrentDegradation = false;
  private currentStatus: EmbeddingsHealthStatus = "healthy";
  private currentReason: string | null = null;
  private provider = "unknown";
  private fallbackActive = false;
  private fallbackProviderName: string | null = null;

  private constructor() {}

  static getInstance(): EmbeddingsHealthTracker {
    if (!EmbeddingsHealthTracker.instance) {
      EmbeddingsHealthTracker.instance = new EmbeddingsHealthTracker();
    }
    return EmbeddingsHealthTracker.instance;
  }

  static resetForTest(): void {
    EmbeddingsHealthTracker.instance = null;
    EmbeddingsHealthTracker.eventEmitterBuilder = null;
  }

  /**
   * Register the per-call fallback builder `emitDegradationEvent` invokes
   * whenever the one-shot `setEventEmitter()` fast-path hasn't fired yet
   * (mt#2568). Called once by the MCP server's startup path. Pass `null` to
   * clear the registration.
   */
  static registerEventEmitterBuilder(builder: EmbeddingsEventEmitterBuilder | null): void {
    EmbeddingsHealthTracker.eventEmitterBuilder = builder;
  }

  setEventEmitter(emitter: EventEmitterWithTryEmit): void {
    this.eventEmitter = emitter;
  }

  setFallbackActive(fallbackProvider: string): void {
    this.fallbackActive = true;
    this.fallbackProviderName = fallbackProvider;
  }

  async recordError(provider: string, errorCode: string, message: string): Promise<void> {
    this.provider = provider;

    const event: EmbeddingsErrorEvent = {
      timestamp: new Date().toISOString(),
      provider,
      errorCode,
      message,
    };

    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }

    if (/insufficient_quota/i.test(errorCode) || /insufficient_quota/i.test(message)) {
      this.currentStatus = "exhausted";
      this.currentReason = "insufficient_quota";
    } else if (/circuit_breaker_open/i.test(errorCode)) {
      this.currentStatus = "degraded";
      this.currentReason = "circuit_breaker_open";
    } else if (/429|rate.limit/i.test(errorCode)) {
      const recentCount = this.countErrorsInWindow(ONE_HOUR_MS);
      if (recentCount >= 3) {
        this.currentStatus = "degraded";
        this.currentReason = `repeated_rate_limit (${recentCount} errors in last hour)`;
      }
    }

    if (this.currentStatus !== "healthy" && !this.emittedForCurrentDegradation) {
      // mt#2568 PR #2284 R1: only latch emittedForCurrentDegradation on a
      // CONFIRMED successful emit. Setting the latch unconditionally here
      // (as before) reintroduced a narrower version of the exact bug this
      // task fixes: a TRANSIENT per-call builder/emit failure (container
      // momentarily unavailable, a dropped DB connection) would otherwise
      // permanently drop this degradation cycle's event, indistinguishable
      // from the pre-fix "one-shot setter never fired" case. Leaving the
      // latch false on failure lets the NEXT recordError call in this same
      // degradation cycle retry.
      const emitted = await this.emitDegradationEvent(event);
      if (emitted) {
        this.emittedForCurrentDegradation = true;
      }
    }
  }

  recordRecovery(): void {
    this.currentStatus = "healthy";
    this.currentReason = null;
    this.emittedForCurrentDegradation = false;
    this.fallbackActive = false;
    this.fallbackProviderName = null;
  }

  getSummary(): EmbeddingsHealthSummary {
    this.decayStaleDegradation();

    const lastEvent = this.events.length > 0 ? this.events[this.events.length - 1] : null;

    return {
      provider: this.provider,
      status: this.currentStatus,
      lastErrorAt: lastEvent?.timestamp ?? null,
      errorCountLastHour: this.countErrorsInWindow(ONE_HOUR_MS),
      degradedReason: this.currentReason,
      fallbackActive: this.fallbackActive,
      fallbackProvider: this.fallbackProviderName,
    };
  }

  /**
   * Clear a `degraded` status whose cause has provably expired (mt#4212).
   *
   * `recordRecovery()` is the only other way out of `degraded`, and it needs a
   * SUCCESSFUL embedding call in this process. Nothing guarantees one ever
   * happens: on 2026-08-17 a degradation at 09:08 was still on the cockpit's
   * banner at 15:14 because no consumer in that process embedded anything for
   * six hours. The operator was shown a resolved condition as current, with the
   * contradiction visible in the payload — `status: "degraded"` beside
   * `errorCountLastHour: 0`.
   *
   * An empty error window is sound evidence for BOTH degraded reasons, which is
   * why no new threshold is introduced here:
   *
   *   - `repeated_rate_limit` is DEFINED as "N errors in the last hour". At
   *     N = 0 the reason is not stale, it is false.
   *   - `circuit_breaker_open` cannot outlive `IntelligentRetryService`'s
   *     60s `circuitBreakerTimeout`, after which the breaker self-transitions
   *     to half-open and admits the next call. An hour without an error is two
   *     orders of magnitude past that.
   *
   * `exhausted` is deliberately NOT decayed. Quota exhaustion is a billing state
   * that persists until someone tops up the account; silence is not evidence it
   * ended, and the fallback provider it activates should stay active.
   *
   * Mirrors `IntelligentRetryService.isCircuitOpen`, which likewise performs its
   * time-based transition on read rather than on a timer.
   */
  private decayStaleDegradation(): void {
    if (this.currentStatus !== "degraded") return;
    if (this.countErrorsInWindow(ONE_HOUR_MS) > 0) return;

    log.debug("Embeddings degradation decayed — no errors within the reporting window", {
      provider: this.provider,
      previousReason: this.currentReason,
    });
    this.recordRecovery();
  }

  private countErrorsInWindow(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    return this.events.filter((e) => new Date(e.timestamp).getTime() >= cutoff).length;
  }

  /**
   * Resolve the EventEmitter to use for this emit: the pre-set fast-path
   * emitter if wiring already completed, otherwise a fresh per-call build
   * via the registered fallback builder (mt#2568). Never throws.
   */
  private async resolveEventEmitter(): Promise<EventEmitterWithTryEmit | null> {
    if (this.eventEmitter) return this.eventEmitter;
    if (!EmbeddingsHealthTracker.eventEmitterBuilder) return null;
    try {
      return await EmbeddingsHealthTracker.eventEmitterBuilder();
    } catch (err) {
      log.debug("embeddings-health-tracker: per-call event emitter build failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Emit the `embeddings.provider_degraded` event. Returns whether the
   * event was ACTUALLY PERSISTED (mt#2568 PR #2284 R2) so the caller only
   * latches `emittedForCurrentDegradation` on confirmed success.
   *
   * Uses `tryEmit`, not `emit` (PR #2284 R2 fix): `EventEmitter.emit()`'s
   * documented contract is "always resolves, never rejects" even when the
   * underlying DB write fails — so wrapping `emit()` in try/catch (the R1
   * fix) could never actually observe a real insert failure, and the latch
   * would still incorrectly flip to `true` on a dead DB. `tryEmit` returns
   * the real persistence signal (`DrizzleEventEmitter.tryEmit` returns
   * `false` on a caught DB error; `NoopEventEmitter.tryEmit` always
   * succeeds since pushing to an array cannot fail).
   */
  private async emitDegradationEvent(triggerEvent: EmbeddingsErrorEvent): Promise<boolean> {
    const emitter = await this.resolveEventEmitter();
    if (!emitter) return false;

    const eventInput: SystemEventInput = {
      eventType: "embeddings.provider_degraded",
      payload: {
        provider: triggerEvent.provider,
        errorCode: triggerEvent.errorCode,
        status: this.currentStatus,
        failureCount: this.countErrorsInWindow(ONE_HOUR_MS),
        degradedReason: this.currentReason,
      },
    };

    // tryEmit never throws (same best-effort contract as emit), but this
    // defensive wrapper protects against a non-conforming custom
    // EventEmitterWithTryEmit implementation (e.g. in a test fake).
    try {
      const persisted = await emitter.tryEmit(eventInput);
      if (persisted) {
        log.warn("Embeddings provider degraded — event emitted", {
          provider: triggerEvent.provider,
          status: this.currentStatus,
          reason: this.currentReason,
        });
      } else {
        log.debug("embeddings.provider_degraded event was not persisted; will retry", {
          provider: triggerEvent.provider,
        });
      }
      return persisted;
    } catch (err) {
      log.debug("Failed to emit embeddings.provider_degraded event", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}
