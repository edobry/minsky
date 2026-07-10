/**
 * GitHub App auth-health signal for the reviewer service (mt#2717).
 *
 * ## Why this exists
 *
 * mt#2717: a `createOctokit` bug pinned the sweepers' GitHub client to a static
 * installation token that expired after ~60 minutes, so every session-level
 * GitHub call `401`'d with `"Bad credentials"` once the token aged out. The
 * merge-state sweeper alone logged **1,730** such failures in one ~15.5h window
 * — a 100%-failure credential state that surfaced ONLY as per-cycle
 * `session_error` / `cycle_error` spam, never as a distinct, alertable signal.
 * The refresh fix (github-client.ts) removes the cause; this module adds the
 * detector so that if a genuine sustained credential failure ever recurs
 * (revoked key, wrong installation id, GitHub outage), it PAGES instead of
 * silently spinning.
 *
 * ## Design
 *
 * A single process-wide {@link AuthHealthTracker} is fed by both sweepers'
 * GitHub error/success paths. Only **auth-class** failures (`401`/`403` /
 * `"Bad credentials"`) move the counter; a success resets it; a non-auth
 * failure (timeout, 5xx, network) is ignored so transient blips neither trip
 * the alert nor mask a real credential failure. When `>= threshold` consecutive
 * auth failures accumulate, `onTrip` fires exactly ONCE (deduped via the
 * `tripped` flag, mirroring the circuit-breaker one-shot pattern in
 * `sweeper.ts`) — emitting a distinct `reviewer.auth_health_failing` error log
 * and an off-cockpit alert via the configured {@link AlertSink}. The first
 * success after a trip fires `onRecover` and re-arms the detector.
 *
 * The threshold is deliberately low (default 3): a GitHub installation-token
 * `401` is effectively never transient — the token is either valid or
 * expired/revoked — so a fast trip is correct ("page instead of spinning").
 */

import { parsePositiveIntEnv } from "./config";
import type { AlertSink } from "./alert-sink";
import { log } from "./logger";

/**
 * Extract a numeric HTTP status from an Octokit RequestError-shaped value.
 * Mirrors `getErrorStatus` in github-client.ts; kept local so this module has
 * no dependency on the GitHub client.
 */
function getStatus(err: unknown): number | undefined {
  if (err instanceof Error && "status" in err) {
    const status = (err as { status?: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

/**
 * Classify an error as a GitHub auth-credential failure.
 *
 * True for HTTP 401/403 and for the `"Bad credentials"` / `"unauthorized"`
 * message families GitHub returns for an expired or invalid installation token.
 * False for timeouts, 5xx, and network errors — those are not credential
 * problems and must not trip the auth-health alert.
 */
export function isAuthError(err: unknown): boolean {
  const status = getStatus(err);
  if (status === 401 || status === 403) return true;
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return /bad credentials|unauthorized|\b401\b|\b403\b/.test(message);
}

/** Injected side effects, so the tracker itself is pure and unit-testable. */
export interface AuthHealthEmitters {
  onTrip(info: {
    consecutiveFailures: number;
    threshold: number;
    source: string;
    lastError: string;
  }): void;
  onRecover(info: { source: string; failuresBeforeRecovery: number }): void;
}

/**
 * Tracks consecutive GitHub auth-credential failures across the reviewer
 * sweepers and fires a one-shot alert when they cross a threshold.
 *
 * State machine (see module docstring):
 *  - `recordFailure` with an auth-class error → increment; trip once at threshold.
 *  - `recordFailure` with a non-auth error → no-op (neither increment nor reset).
 *  - `recordSuccess` → reset; if previously tripped, fire `onRecover`.
 */
export class AuthHealthTracker {
  private consecutive = 0;
  private tripped = false;
  private lastError = "";
  private lastSource = "";

  constructor(
    private readonly threshold: number,
    private readonly emitters: AuthHealthEmitters
  ) {}

  /** A GitHub call authenticated successfully. Resets the failure streak. */
  recordSuccess(): void {
    if (this.tripped) {
      this.emitters.onRecover({
        source: this.lastSource,
        failuresBeforeRecovery: this.consecutive,
      });
    }
    this.consecutive = 0;
    this.tripped = false;
    this.lastError = "";
  }

  /**
   * A GitHub call failed. Only auth-class failures (per {@link isAuthError})
   * move the counter; anything else is ignored so transient network/5xx errors
   * cannot trip the alert nor reset a real credential-failure streak.
   */
  recordFailure(source: string, err: unknown): void {
    if (!isAuthError(err)) return;
    this.consecutive++;
    this.lastError = err instanceof Error ? err.message : String(err);
    this.lastSource = source;
    if (!this.tripped && this.consecutive >= this.threshold) {
      this.tripped = true;
      this.emitters.onTrip({
        consecutiveFailures: this.consecutive,
        threshold: this.threshold,
        source,
        lastError: this.lastError,
      });
    }
  }

  /** Test/inspection accessors. */
  get isTripped(): boolean {
    return this.tripped;
  }
  get failureCount(): number {
    return this.consecutive;
  }
}

/**
 * Default trip threshold. A GitHub installation-token 401 is not transient, so
 * a low value pages fast. Overridable via `REVIEWER_AUTH_HEALTH_FAILURE_THRESHOLD`
 * (services/* env vars are excluded from the main dot-path parser — see
 * `alert-sink.ts` `loadAlertSinkConfig` for the same convention).
 */
const DEFAULT_AUTH_HEALTH_THRESHOLD = parsePositiveIntEnv(
  "REVIEWER_AUTH_HEALTH_FAILURE_THRESHOLD",
  3
);

/**
 * The off-cockpit alert sink, injected once at server boot via
 * {@link configureGithubAuthHealthAlertSink}. `null` until configured (and when
 * `ALERT_SINK_TYPE` is unset/off), in which case the trip still emits the
 * error-level log line — the sink is additive paging redundancy.
 */
let configuredAlertSink: AlertSink | null = null;

/**
 * Wire the shared auth-health tracker's off-cockpit alert sink. Called once
 * from the reviewer server boot with the same `AlertSink` instance the
 * sweepers use (mt#2451 single-instance convention).
 */
export function configureGithubAuthHealthAlertSink(sink: AlertSink | null): void {
  configuredAlertSink = sink;
}

/**
 * Process-wide auth-health tracker shared by both sweepers. The default
 * emitters log the distinct `reviewer.auth_health_failing` /
 * `reviewer.auth_health_recovered` events and push a trip to the configured
 * external alert sink (fail-open).
 */
export const githubAuthHealth = new AuthHealthTracker(DEFAULT_AUTH_HEALTH_THRESHOLD, {
  onTrip: ({ consecutiveFailures, threshold, source, lastError }) => {
    log.error("reviewer.auth_health_failing", {
      event: "reviewer.auth_health_failing",
      // mt#2464/mt#2465 convention: template the operator-facing detail into the
      // rendered message text, not JSON-only attributes — Railway's log surface
      // searches/displays only the message line.
      message:
        `GitHub App auth is FAILING: ${consecutiveFailures} consecutive credential ` +
        `failures (>= ${threshold}) across the reviewer sweepers (latest source: ${source}). ` +
        `Session-level GitHub calls cannot authenticate — the installation token is not ` +
        `minting/refreshing. Operator action required (mt#2717). Latest error: ${lastError}`,
      consecutiveFailures,
      threshold,
      source,
      lastError,
    });
    // Fail-open: AlertSink.notify never throws by contract, but guard the
    // fire-and-forget promise so a future/external sink that violates it can't
    // surface as an unhandled rejection.
    void Promise.resolve(
      configuredAlertSink?.notify(
        "error",
        "Reviewer GitHub auth failing",
        `${consecutiveFailures} consecutive "Bad credentials"/401 failures (>= ${threshold}) ` +
          `across the reviewer sweepers (latest source: ${source}). The GitHub App installation ` +
          `token is not authenticating. Operator action required (mt#2717).`
      )
    ).catch((sinkErr: unknown) => {
      log.warn("reviewer.auth_health_alert_sink_unhandled", {
        event: "reviewer.auth_health_alert_sink_unhandled",
        error: sinkErr instanceof Error ? sinkErr.message : String(sinkErr),
      });
    });
  },
  onRecover: ({ source, failuresBeforeRecovery }) => {
    log.info("reviewer.auth_health_recovered", {
      event: "reviewer.auth_health_recovered",
      message:
        `GitHub App auth RECOVERED after ${failuresBeforeRecovery} consecutive credential ` +
        `failures (source: ${source}). Session-level GitHub calls authenticate again.`,
      failuresBeforeRecovery,
      source,
    });
  },
});
