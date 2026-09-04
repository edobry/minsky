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
 * GitHub error/success paths. Only **auth-class** failures (HTTP 401 /
 * `"Bad credentials"` / `"unauthorized"`) move the counter; a success resets it;
 * a non-auth failure (timeout, 5xx, network, a bare 403 permission/rate-limit)
 * is ignored so transient blips neither trip the alert nor mask a real
 * credential failure. When `>= threshold` consecutive
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
import { GITHUB_APP_SETTINGS_URL, type AskEmitter } from "./ask-emitter";
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
 * Classify an error as a GitHub credential (token mint/refresh) failure.
 *
 * True for HTTP 401 and the `"Bad credentials"` / `"unauthorized"` message
 * families GitHub returns for an expired or invalid installation token. A bare
 * 403 is deliberately NOT auth-class: GitHub uses 403 for per-repo permission
 * denials ("Resource not accessible by integration") and for rate limiting /
 * abuse detection — none of which are token-refresh failures — so classifying
 * all 403s would page the global auth-health alert on transient rate limits or
 * expected per-repo access denials. Rate-limit / abuse messages are excluded
 * outright. False for timeouts, 5xx, and network errors.
 */
export function isAuthError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  // GitHub returns 403 (not 401) for rate limiting / abuse detection. Exclude
  // those first so a rate-limit burst can never trip the auth-health page.
  if (/rate limit|abuse detection|secondary rate/.test(message)) return false;
  // 401 is the definitive expired/invalid installation-token signal — GitHub
  // returns 401 "Bad credentials" for an aged-out token (the mt#2717 signature).
  if (getStatus(err) === 401) return true;
  // Message-only classification for wrapped errors without a numeric status.
  // Intentionally excludes bare 403 (permission denial / rate limit) — only a
  // token mint/refresh failure should page the global auth-health alert.
  return /bad credentials|unauthorized/.test(message);
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
 * The operator-incident ask emitter, injected once at server boot (mt#2719).
 *
 * `null` until configured, in which case a trip still logs and still pushes to
 * the alert sink — the ask + page are ADDITIVE, exactly as the sink is. This is
 * the third, independent surface for one trip, and they degrade independently:
 * a missing DB costs the ask, a missing Telegram config costs the page, and the
 * error log survives both.
 *
 * Why an ask at all when the sink already reaches Telegram: the sink is
 * fire-and-forget prose with no state. The ask is a durable, respondable record
 * on the cockpit operator surface, and it is what carries `severity: "incident"`
 * into the substrate's paging + rate-limiting machinery (mt#3595).
 */
let configuredAskEmitter: AskEmitter | null = null;

/**
 * Wire the shared auth-health tracker's operator-incident ask emitter (mt#2719).
 * Called once from the reviewer server boot with the same `AskEmitter` instance
 * the sweepers use, per the mt#2451 single-instance convention.
 */
export function configureGithubAuthHealthAskEmitter(emitter: AskEmitter | null): void {
  configuredAskEmitter = emitter;
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
        `${consecutiveFailures} consecutive GitHub credential failures (>= ${threshold}) ` +
          `across the reviewer sweepers (latest source: ${source}). The GitHub App installation ` +
          `token is not authenticating. Latest error: ${lastError}. Operator action required (mt#2717).`
      )
    ).catch((sinkErr: unknown) => {
      log.warn("reviewer.auth_health_alert_sink_unhandled", {
        event: "reviewer.auth_health_alert_sink_unhandled",
        error: sinkErr instanceof Error ? sinkErr.message : String(sinkErr),
      });
    });

    // mt#2719: the paging tier. Deduped by the SAME `tripped` flag that guards
    // this whole callback — `onTrip` fires exactly once per trip and re-arms
    // only after a recovery — so no dedup state is added here.
    //
    // Fire-and-forget with the same guard as the sink above: `onTrip` is
    // synchronous by contract (it is called from `recordFailure`, on the
    // sweepers' error path), and a paging failure must never propagate into a
    // sweep cycle. `emitOperatorIncidentAlert` already never rejects; the
    // `.catch` is belt-and-braces against a future emitter that violates that.
    void Promise.resolve(
      configuredAskEmitter?.emitOperatorIncidentAlert({
        source: "github_auth",
        consecutiveFailures,
        threshold,
        observedBy: source,
        lastError,
        remediationUrl: GITHUB_APP_SETTINGS_URL,
      })
    ).catch((askErr: unknown) => {
      log.warn("reviewer.auth_health_ask_unhandled", {
        event: "reviewer.auth_health_ask_unhandled",
        error: askErr instanceof Error ? askErr.message : String(askErr),
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
