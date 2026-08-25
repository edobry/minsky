/**
 * Verdict scoring for the post-deploy health monitor (mt#3921).
 *
 * ## Why this is a separate module
 *
 * `scripts/post-deploy-health-monitor.ts` calls `main()` at module scope, so a
 * test cannot import it without running the monitor against live Railway and
 * GitHub. The scoring logic therefore lives here — a pure function over a plain
 * summary object, with no IO — so the property that actually failed in
 * production can be asserted directly.
 *
 * ## What failed in production
 *
 * From 2026-08-05 to 2026-08-10 the monitor's Railway credential was scoped to
 * the wrong project. Every run, for all five services, logged
 * `Railway GraphQL errors: Not Authorized`, printed `Status: HEALTHY`, and
 * ended `Total alerts fired: 0` (run 31392266054 is one of ~650). The deploy
 * check errored and the digest check was skipped for want of its data; neither
 * set an alert flag, and the verdict was computed as "no alerts fired, so the
 * service is fine."
 *
 * The monitor that exists to catch a frozen-but-healthy deploy was itself
 * fail-open, which is why the minsky-mcp outage (mt#3890) ran 4.5 days unseen.
 *
 * ## The rule this encodes
 *
 * A check that could not run is not a check that passed. That distinction has
 * to survive into the value the scorer reads, so each check reports a
 * three-state outcome rather than a nullable string plus a separate error
 * field:
 *
 * | Outcome            | Meaning                                                  | Alerts? |
 * | ------------------ | -------------------------------------------------------- | ------- |
 * | `ok`               | ran to completion                                        | only if it found a real problem |
 * | `not-applicable`   | does not apply to this service by design                 | never |
 * | `failed`           | applies, but could not complete (auth, network, parse)   | always |
 *
 * `not-applicable` is a design fact about the service — a repo-source service
 * has no configured image, so there is no registry digest to compare against.
 * `failed` is a fact about this run. Collapsing the two is exactly the bug: the
 * old log line read `SKIP (No Railway deployment data available)`, which sounds
 * like "nothing to check" and meant "I could not look."
 *
 * This extends ADR-035's rule 3 — *"'Configured but failing' MUST be
 * distinguishable from 'not configured.' These are different states with
 * different correct responses"* — from a service's own liveness surface to the
 * verdict a monitor computes about it. ADR-035 rule 5 names this shape too: the
 * monitor's log was honest on every one of those runs while its verdict was
 * not, and surface honesty is not recovery.
 *
 * @see docs/architecture/adr-035-failed-initializer-must-not-be-memoized-as-a-value.md
 * @see mem#704 — a probe that returns the same result when the system is broken
 *   is not verification
 */

/** Three-state result of a single per-service check. */
export type CheckOutcome = "ok" | "not-applicable" | "failed";

/**
 * Failure classes the monitor alerts on. Each one is a de-duplication key: the
 * monitor keeps at most one open GitHub issue per (service, class), so a
 * service with several unrunnable checks raises ONE `check-failed` alert
 * naming all of them rather than one alert per check.
 */
export type AlertClass =
  | "deploy-failed"
  | "health-down"
  | "digest-lag"
  | "check-failed"
  /**
   * (d) The service's DB-pool RECOVERY mechanism reported a failed teardown
   * (mt#1495). Its own class rather than a flavour of `health-down`, because the
   * de-dup key IS the remediation: a service answering 200 while its pool recycle
   * strands connections is not down, and telling an operator "health-down" would
   * send them to look at the wrong thing.
   */
  | "recovery-degraded";

/** One check's contribution to the verdict. */
export interface CheckSummary {
  /** Whether the check ran, does not apply, or could not complete. */
  outcome: CheckOutcome;
  /**
   * Why, for the non-`ok` outcomes — the error text for `failed`, the design
   * reason for `not-applicable`. Surfaced verbatim in the alert body, because
   * `Not Authorized` alone does not tell an operator whether the credential is
   * wrong-scoped or merely expired (mem#915).
   */
  detail: string | null;
  /**
   * True when the check RAN and found a real problem. Meaningless unless
   * `outcome` is `ok` — a check that could not run has observed nothing.
   */
  problem: boolean;
}

/** The four checks the monitor runs against one service. */
export interface ServiceCheckSummary {
  service: string;
  /** (a) Railway's latest deploy is in a failed terminal state. */
  deploy: CheckSummary;
  /** (b) GET <service>/health answers 200 with the right service identity. */
  health: CheckSummary;
  /** (c) The running image's digest matches the registry's newest (mt#3251). */
  digest: CheckSummary;
  /**
   * (d) The service's DB-pool recovery mechanism is releasing connections
   * (mt#1495). Derived from the SAME `/health` body check (b) already fetched, so
   * it costs no extra request — see `monitor-recovery-alarm.ts`.
   *
   * Almost always `not-applicable`: only the cockpit publishes `dbRecycle` today,
   * and even there it is `not-applicable` until a recycle has actually happened.
   */
  recovery: CheckSummary;
}

export interface ServiceAlert {
  class: AlertClass;
  /** Operator-facing sentence explaining why this alert fired. */
  reason: string;
}

export interface ServiceScore {
  verdict: "HEALTHY" | "DEGRADED";
  alerts: ServiceAlert[];
}

const CHECK_LABELS: Record<keyof Omit<ServiceCheckSummary, "service">, string> = {
  deploy: "Railway deploy status",
  health: "HTTP /health probe",
  digest: "deployed-image digest",
  recovery: "DB-pool recovery counters",
};

/**
 * Score one service's checks into a verdict plus the alerts it should raise.
 *
 * `digestLagSustained` is resolved by the caller before this is called: a
 * single observation of a digest lag is expected during a normal
 * build-push-redeploy cycle, so escalation requires the cross-run tracker
 * (mt#3251 R2 / mt#3284). Passing it in keeps that IO out of the scorer.
 *
 * A service is HEALTHY only when nothing alerted — and an unrunnable check
 * always alerts, so a blind monitor can no longer report a fleet as fine.
 */
export function scoreService(
  summary: ServiceCheckSummary,
  digestLagSustained: boolean
): ServiceScore {
  const alerts: ServiceAlert[] = [];

  const CHECK_KEYS = ["deploy", "health", "digest", "recovery"] as const;

  const failed = CHECK_KEYS.filter((key) => summary[key].outcome === "failed");

  if (failed.length > 0) {
    const detail = failed
      .map((key) => `${CHECK_LABELS[key]}: ${summary[key].detail ?? "no detail recorded"}`)
      .join("; ");
    alerts.push({
      class: "check-failed",
      reason:
        `${failed.length} of ${CHECK_KEYS.length} checks could not run, so this service's ` +
        `state is UNKNOWN, not healthy — ${detail}`,
    });
  }

  if (summary.deploy.outcome === "ok" && summary.deploy.problem) {
    alerts.push({
      class: "deploy-failed",
      reason: summary.deploy.detail ?? "latest Railway deployment is in a failed terminal state",
    });
  }

  if (summary.health.outcome === "ok" && summary.health.problem) {
    alerts.push({
      class: "health-down",
      reason: summary.health.detail ?? "health probe did not return a healthy response",
    });
  }

  if (summary.digest.outcome === "ok" && summary.digest.problem && digestLagSustained) {
    alerts.push({
      class: "digest-lag",
      reason: summary.digest.detail ?? "deployed image digest lags the registry's newest",
    });
  }

  // No sustained-observation gate here, unlike `digest-lag` above. A digest lag is
  // expected transiently during a normal build-push-redeploy cycle, so a single
  // observation is not a fault. An abandoned close is not transient in that way:
  // the counter is monotonic and only rises when a recycle has ALREADY failed to
  // release its connections, so the first observation is already the aftermath.
  if (summary.recovery.outcome === "ok" && summary.recovery.problem) {
    alerts.push({
      class: "recovery-degraded",
      reason: summary.recovery.detail ?? "DB-pool recovery mechanism reported a failed teardown",
    });
  }

  return { verdict: alerts.length === 0 ? "HEALTHY" : "DEGRADED", alerts };
}
