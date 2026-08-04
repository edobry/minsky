/**
 * Persistence Health Assessment (mt#2949)
 *
 * During the 2026-07-19 outage, `minsky-mcp` crash-looped on boot-time
 * auto-migrate and DI substituted `UnconfiguredPersistenceProvider`. Because
 * that provider lets the process boot, `/health` kept returning 200 and
 * Railway reported the deployment SUCCESS — while every DB-backed tool was
 * dead. This module is the single place that decides whether persistence
 * state should be reported healthy for liveness surfaces (`/health` and any
 * future watchdog): it distinguishes "deliberately unconfigured" (no
 * Postgres connection anywhere — the expected local/dev/offline boot path,
 * mt#2349) from "configured but unavailable" (a connection string WAS
 * configured but initialization failed — a genuine outage).
 *
 * Only the latter is reported unhealthy. This keeps a laptop without a DB,
 * and the bundle-boot-smoke CI gate (which boots with no Postgres
 * configured), from being bricked — while making a deployed, configured-but-
 * down backend fail loud instead of silently masquerading as healthy.
 */

import type { PersistenceProvider } from "./types";
import { UnconfiguredPersistenceProvider } from "./unconfigured-provider";

export type PersistenceHealthMode = "connected" | "unconfigured" | "unavailable";

export interface PersistenceHealthStatus {
  /** false ONLY for the "configured but failed to initialize" case. */
  healthy: boolean;
  /**
   * - `"connected"`: a real SQL-capable provider is live.
   * - `"unconfigured"`: no Postgres connection was configured at all
   *   (expected local/dev/offline boot path, mt#2349) — degraded but not an
   *   error; `/health` stays green.
   * - `"unavailable"`: a Postgres connection WAS configured but
   *   initialization failed (deployed context) — a genuine outage;
   *   `/health` must report unhealthy.
   */
  mode: PersistenceHealthMode;
  reason?: string;
  /**
   * ISO timestamp of the last re-initialization attempt (mt#3635 / ADR-035
   * rule 4). ABSENT means no attempt has been made since boot — which is what
   * distinguishes a provider stuck since startup from one actively retrying
   * against a real outage. Without it an operator sees the same payload in
   * both cases and cannot tell a wedged process from a down database.
   */
  lastAttemptAt?: string;
}

/**
 * Assess persistence health for `/health` and similar liveness surfaces.
 *
 * Never throws — a missing/undefined provider (e.g., a stdio-mode path that
 * never wires persistence) is treated as the deliberately-unconfigured case
 * rather than an error.
 */
export function assessPersistenceHealth(
  provider: PersistenceProvider | undefined
): PersistenceHealthStatus {
  if (!provider) {
    return {
      healthy: true,
      mode: "unconfigured",
      reason: "persistence provider not wired",
    };
  }

  if (provider.getCapabilities().sql) {
    return { healthy: true, mode: "connected" };
  }

  if (provider instanceof UnconfiguredPersistenceProvider) {
    if (provider.configuredButUnavailable) {
      const attemptDetail = provider.lastAttemptError ? `: ${provider.lastAttemptError}` : "";
      const retryNote = provider.lastAttemptAt
        ? `Last re-initialization attempt ${provider.lastAttemptAt} also failed${attemptDetail}.`
        : "No re-initialization has been attempted since boot.";
      return {
        healthy: false,
        mode: "unavailable",
        reason:
          "Postgres connection is configured but persistence failed to initialize " +
          `(${provider.reason}) — see boot logs for the underlying error. This is ` +
          `NOT the expected local/dev degraded mode. ${retryNote}`,
        ...(provider.lastAttemptAt ? { lastAttemptAt: provider.lastAttemptAt } : {}),
      };
    }
    return {
      healthy: true,
      mode: "unconfigured",
      reason: "no Postgres connection configured (local/dev degraded mode)",
    };
  }

  // mt#2949 hardening (PR #2095 R1): Postgres has been the only backend since
  // mt#2349, and `UnconfiguredPersistenceProvider` is the only sql=false
  // placeholder this codebase constructs in production. An sql=false provider
  // that is NEITHER a real SQL-capable provider NOR the known Unconfigured
  // placeholder is an unrecognized state — do not silently green-light it as
  // the expected local/dev degraded mode; report it unhealthy instead.
  return {
    healthy: false,
    mode: "unavailable",
    reason:
      `Unrecognized non-SQL persistence provider (${provider.constructor.name}) — ` +
      "not the known UnconfiguredPersistenceProvider placeholder.",
  };
}
