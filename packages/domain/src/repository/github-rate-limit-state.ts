/**
 * Process-wide GitHub REST rate-limit snapshot (mt#2888).
 *
 * GitHub returns `x-ratelimit-remaining` / `x-ratelimit-limit` /
 * `x-ratelimit-reset` (Unix epoch seconds) headers on every REST response —
 * documented at "Rate limits for the REST API"
 * (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).
 * Heavy parallel-agent days can exhaust the token's hourly quota with no
 * visibility until a hard 403/429 failure (mt#2888 originating incident,
 * 2026-07-16). This module captures the headers from every Octokit request
 * (success AND failure) at `createOctokit`'s hook layer
 * (`github-pr-operations.ts`) so the LAST-OBSERVED state is readable
 * in-band — `debug.systemInfo` and classified read-path errors both surface
 * it — without a dedicated `GET /rate_limit` poll (which itself costs quota).
 *
 * Module-level singleton state, mirroring the existing `DisconnectTracker` /
 * `SubagentDispatchTracker` / `GuardHealthTracker` process-wide-singleton
 * pattern already used by `debug.systemInfo` (src/adapters/shared/commands/
 * debug.ts) — no persistence, resets on process restart, which is
 * acceptable: the value is "quota state as of the last GitHub call this
 * process made," not a durable audit record.
 */

export interface GithubRateLimitSnapshot {
  /** Requests remaining in the current window. */
  remaining: number;
  /** Total requests allowed per window. */
  limit: number;
  /** ISO-8601 timestamp the window resets. */
  reset: string;
  /** The rate-limit resource bucket (e.g. "core", "search"), when GitHub reports it. */
  resource?: string;
  /** ISO-8601 timestamp this snapshot was captured. */
  observedAt: string;
}

let lastSnapshot: GithubRateLimitSnapshot | null = null;

/**
 * Record rate-limit headers from a single Octokit response (success or
 * error). Silently no-ops when the expected headers are absent or
 * unparseable — this is a best-effort observability capture, never a
 * correctness dependency, so a malformed/missing header must never throw.
 */
export function recordRateLimitHeaders(headers: Record<string, unknown> | undefined | null): void {
  if (!headers) return;
  const remainingRaw = headers["x-ratelimit-remaining"];
  const limitRaw = headers["x-ratelimit-limit"];
  const resetRaw = headers["x-ratelimit-reset"];
  const resourceRaw = headers["x-ratelimit-resource"];

  if (remainingRaw === undefined || resetRaw === undefined) return;

  const remaining = Number(remainingRaw);
  const limit = Number(limitRaw);
  const resetEpochSeconds = Number(resetRaw);

  if (!Number.isFinite(remaining) || !Number.isFinite(resetEpochSeconds)) return;

  lastSnapshot = {
    remaining,
    limit: Number.isFinite(limit) ? limit : remaining,
    reset: new Date(resetEpochSeconds * 1000).toISOString(),
    resource: typeof resourceRaw === "string" ? resourceRaw : undefined,
    observedAt: new Date().toISOString(),
  };
}

/** Read the last-observed rate-limit snapshot, or `null` if none has been captured yet this process. */
export function getLastGithubRateLimitSnapshot(): GithubRateLimitSnapshot | null {
  return lastSnapshot;
}

/** Test seam: reset the module-level snapshot between tests. */
export function resetGithubRateLimitStateForTests(): void {
  lastSnapshot = null;
}
