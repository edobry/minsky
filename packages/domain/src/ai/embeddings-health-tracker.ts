/**
 * EmbeddingsHealthTracker — singleton health tracker for the embeddings subsystem.
 *
 * Mirrors the DisconnectTracker pattern (mt#1645/mt#1682): in-memory ring buffer
 * of error events, summary for debug_systemInfo, and event emission on degradation.
 *
 * @see mt#2147 — this task
 * @see src/mcp/disconnect-tracker.ts — architectural precedent
 */

import { log } from "@minsky/shared/logger";
import type { EventEmitter, SystemEventInput } from "../events/emitter";

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
}

const MAX_EVENTS = 100;
const ONE_HOUR_MS = 60 * 60 * 1000;

export class EmbeddingsHealthTracker {
  private static instance: EmbeddingsHealthTracker | null = null;

  private events: EmbeddingsErrorEvent[] = [];
  private eventEmitter: EventEmitter | null = null;
  private emittedForCurrentDegradation = false;
  private currentStatus: EmbeddingsHealthStatus = "healthy";
  private currentReason: string | null = null;
  private provider = "unknown";

  private constructor() {}

  static getInstance(): EmbeddingsHealthTracker {
    if (!EmbeddingsHealthTracker.instance) {
      EmbeddingsHealthTracker.instance = new EmbeddingsHealthTracker();
    }
    return EmbeddingsHealthTracker.instance;
  }

  static resetForTest(): void {
    EmbeddingsHealthTracker.instance = null;
  }

  setEventEmitter(emitter: EventEmitter): void {
    this.eventEmitter = emitter;
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
      this.emittedForCurrentDegradation = true;
      await this.emitDegradationEvent(event);
    }
  }

  recordRecovery(): void {
    this.currentStatus = "healthy";
    this.currentReason = null;
    this.emittedForCurrentDegradation = false;
  }

  getSummary(): EmbeddingsHealthSummary {
    const lastEvent = this.events.length > 0 ? this.events[this.events.length - 1] : null;

    return {
      provider: this.provider,
      status: this.currentStatus,
      lastErrorAt: lastEvent?.timestamp ?? null,
      errorCountLastHour: this.countErrorsInWindow(ONE_HOUR_MS),
      degradedReason: this.currentReason,
    };
  }

  private countErrorsInWindow(windowMs: number): number {
    const cutoff = Date.now() - windowMs;
    return this.events.filter((e) => new Date(e.timestamp).getTime() >= cutoff).length;
  }

  private async emitDegradationEvent(triggerEvent: EmbeddingsErrorEvent): Promise<void> {
    if (!this.eventEmitter) return;

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

    try {
      await this.eventEmitter.emit(eventInput);
      log.warn("Embeddings provider degraded — event emitted", {
        provider: triggerEvent.provider,
        status: this.currentStatus,
        reason: this.currentReason,
      });
    } catch (err) {
      log.debug("Failed to emit embeddings.provider_degraded event", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
