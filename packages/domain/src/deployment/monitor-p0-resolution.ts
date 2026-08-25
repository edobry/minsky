/**
 * P0 resolution for the post-deploy health monitor (mt#3963).
 *
 * ## What was missing
 *
 * The monitor had exactly one issue-closing path — `closeDigestLagPendingTracker`
 * — and it closed only the `[pending]` digest-lag tracker. `alertViaGitHubIssue`
 * opens and updates escalated P0 issues; nothing ever closed one. So a P0 stayed
 * open after the condition resolved, after the fix merged, and after the monitor
 * itself reported the service healthy on every subsequent run.
 *
 * Four P0s were open when this shipped, the oldest for 54 days, every one of
 * them for a condition the same monitor run reported OK. That is the failure
 * this module exists to stop: once a P0 can be stale, the `p0-outage` label
 * stops meaning "live", which is the opposite of what a P0 channel is for.
 *
 * This is the `work-completion.mdc §Recovery layer spec discipline` shape — the
 * digest-lag detector enumerated what it COVERS (detect, escalate) and never
 * enumerated its own resolution, so the recovery layer had no exit.
 *
 * ## Why this is a separate module
 *
 * Same reason as `monitor-verdict.ts`: `scripts/post-deploy-health-monitor.ts`
 * calls `main()` at module scope, so a test cannot import it without running the
 * monitor against live Railway and GitHub. The decisions therefore live here, as
 * pure functions over plain values, and the script keeps only the IO shell.
 *
 * ## The two rules this encodes
 *
 * **1. Recovery needs POSITIVE evidence, per class.** A class is recovered only
 * when the check that detects it RAN (`outcome: "ok"`) and found no problem. A
 * check that could not run has observed nothing — it is not evidence the
 * condition cleared, and closing a P0 on it would be the same fail-open mistake
 * mt#3921 fixed on the raising side, one tier up. `not-applicable` is likewise
 * not evidence: a service that no longer has a configured image tells you
 * nothing about whether its old digest lag resolved.
 *
 * **2. Recovery must be SUSTAINED before the P0 closes.** The escalation side
 * already requires a sustained observation (`DIGEST_LAG_MIN_SUSTAINED_INTERVAL_MS`,
 * mt#3284); closing on the first healthy run would be asymmetric and would flap
 * an issue open/closed across a rolling deploy. This matches community practice:
 * condition-based alerts auto-resolve, and the named hazard is flapping, whose
 * canonical mitigation is a recovery threshold (Grafana's `keep_firing_for`).
 * This repo has already watched the un-thresholded version of this happen — the
 * pending tracker opened and closed every ~30 minutes through mt#3933's lag.
 *
 * @see mem#704 — a probe that returns the same result when the system is broken
 *   is not verification
 * @see packages/domain/src/deployment/monitor-verdict.ts — the raising side
 */

import type { AlertClass, ServiceCheckSummary } from "./monitor-verdict";

/**
 * Minimum wall-clock time a service must be observed RECOVERED before its open
 * P0 is closed. Deliberately mirrors the escalation side's
 * `DIGEST_LAG_MIN_SUSTAINED_INTERVAL_MS` (8 minutes, set just under the
 * workflow's 10-minute cron cadence so the very next scheduled tick satisfies
 * it with no added delay): an asymmetry between how long a failure must persist
 * to open an issue and how long a recovery must persist to close one is what
 * produces flapping.
 *
 * The two constants are intentionally NOT shared. This one governs closing and
 * lives with the closing logic; unifying them would couple a change in the
 * digest check's escalation timing to the resolution behavior of all four alert
 * classes.
 */
export const P0_RECOVERY_MIN_SUSTAINED_INTERVAL_MS = 8 * 60 * 1000; // 8 minutes

/** Machine-parseable marker line embedded in a P0 issue's body. */
const P0_RECOVERY_MARKER_PREFIX = "P0_RECOVERY_FIRST_OBSERVED_AT:";

const P0_RECOVERY_RE = /^P0_RECOVERY_FIRST_OBSERVED_AT:\s*(\S+)\s*$/m;

/**
 * The signature `alertViaGitHubIssue` writes into every P0 body it opens. Used
 * as the ownership check: this monitor closes only issues it opened itself, so a
 * hand-filed `p0-outage` issue is never touched no matter what its title is.
 *
 * Verified against all four P0s open when this shipped (#2362, #1775, #1774,
 * #1718 — the oldest opened 2026-06-18): every one carries this line.
 */
const MONITOR_AUTHORED_SIGNATURE = "Auto-opened by [post-deploy-health-monitor]";

export function formatP0RecoveryMarker(firstObservedAtIso: string): string {
  return `${P0_RECOVERY_MARKER_PREFIX} ${firstObservedAtIso}`;
}

/**
 * Read back the recovery marker. Returns the ISO string, or null when the
 * marker is absent OR present but unparseable as a date — the caller treats
 * both the same way (start over from a fresh observation), which fails closed:
 * a garbled marker delays a close, it never causes one.
 */
export function parseP0RecoveryMarker(body: string | null | undefined): string | null {
  if (!body) return null;
  const match = P0_RECOVERY_RE.exec(body);
  if (!match) return null;
  const [, isoString] = match;
  if (!isoString || Number.isNaN(Date.parse(isoString))) return null;
  return isoString;
}

/**
 * Body with the recovery marker line removed, and the blank space it leaves
 * behind normalized.
 *
 * Bodies are rewritten repeatedly (mark on recovery, clear on re-failure), so a
 * strip that only collapsed TRAILING blank runs would accumulate a double blank
 * line in the middle of the body every time an operator had moved the marker
 * inline. Collapse any run of 3+ newlines anywhere, then end the body with
 * exactly one newline.
 */
export function stripP0RecoveryMarker(body: string | null | undefined): string {
  if (!body) return "";
  return body
    .split("\n")
    .filter((line) => !line.startsWith(P0_RECOVERY_MARKER_PREFIX))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "\n");
}

/** Body with a fresh recovery marker, replacing any marker already present. */
export function withP0RecoveryMarker(
  body: string | null | undefined,
  firstObservedAtIso: string
): string {
  const base = stripP0RecoveryMarker(body).replace(/\s+$/, "");
  return `${base}\n\n${formatP0RecoveryMarker(firstObservedAtIso)}\n`;
}

/**
 * Whether this issue is one THIS monitor opened, and therefore one it may
 * close. An issue carrying the P0 label but not the monitor's own signature is
 * somebody's hand-filed incident — leave it alone.
 */
export function isMonitorAuthoredP0(body: string | null | undefined): boolean {
  return Boolean(body && body.includes(MONITOR_AUTHORED_SIGNATURE));
}

/**
 * Machine-parseable marker naming WHICH (service, failure class) a P0 belongs
 * to, written into the body when the issue is opened.
 *
 * The issue's title already encodes both, but a title is operator-editable:
 * adding context during an incident ("… — investigating") would make an exact
 * title comparison miss, and the issue would then never be auto-closed — the
 * exact stale-P0 outcome this module exists to end. The body marker is the
 * stable identity; the title is a fallback for issues opened before it existed.
 */
export function formatP0SubjectMarker(service: string, failureClass: AlertClass): string {
  return `${P0_SUBJECT_MARKER_PREFIX} ${service}|${failureClass}`;
}

const P0_SUBJECT_MARKER_PREFIX = "P0_SUBJECT:";

const P0_SUBJECT_RE = /^P0_SUBJECT:\s*(\S+)\|(\S+)\s*$/m;

const ALERT_CLASSES: readonly AlertClass[] = [
  "deploy-failed",
  "health-down",
  "digest-lag",
  "check-failed",
  "recovery-degraded",
];

export function parseP0SubjectMarker(
  body: string | null | undefined
): { service: string; failureClass: AlertClass } | null {
  if (!body) return null;
  const match = P0_SUBJECT_RE.exec(body);
  if (!match) return null;
  const [, service, failureClass] = match;
  if (!service || !failureClass) return null;
  if (!ALERT_CLASSES.includes(failureClass as AlertClass)) return null;
  return { service, failureClass: failureClass as AlertClass };
}

export interface P0IssueLike {
  title: string;
  body: string | null;
}

/**
 * Whether this open issue is the P0 for (service, failureClass).
 *
 * The subject marker wins when present — it survives any title edit. When it is
 * absent (a P0 opened before the marker shipped), fall back to finding the
 * canonical title as a SUBSTRING rather than requiring equality, so an
 * operator-added prefix or suffix does not strand the issue. Substring matching
 * cannot collide across subjects: every canonical title carries both the
 * service name and the class label, so no canonical title contains another.
 *
 * Callers must still check `isMonitorAuthoredP0` — this answers "which subject",
 * not "may I close it".
 */
export function matchesP0Subject(
  issue: P0IssueLike,
  subject: { service: string; failureClass: AlertClass; canonicalTitle: string }
): boolean {
  const marker = parseP0SubjectMarker(issue.body);
  if (marker) {
    return marker.service === subject.service && marker.failureClass === subject.failureClass;
  }
  return issue.title.includes(subject.canonicalTitle);
}

/**
 * The alert classes this run observed as RECOVERED, with positive evidence.
 *
 * Disjoint from `scoreService`'s alert classes by construction: each class here
 * requires its check to have run AND found no problem, and each alert there
 * requires the opposite. A class appears in NEITHER set when its check could not
 * run — the state is unknown, so the P0 neither fires nor closes.
 *
 * `digest-lag` deliberately reads `problem`, not the caller's sustained flag: a
 * lag that is present but not yet sustained raises no alert this run, and it is
 * emphatically not a recovery.
 */
export function observedRecoveredClasses(summary: ServiceCheckSummary): AlertClass[] {
  const recovered: AlertClass[] = [];

  const ranClean = (key: "deploy" | "health" | "digest" | "recovery"): boolean =>
    summary[key].outcome === "ok" && !summary[key].problem;

  // `check-failed` is the absence of unrunnable checks, so `not-applicable`
  // counts here — unlike the four condition classes below, where it is silence.
  const anyCheckFailed = (["deploy", "health", "digest", "recovery"] as const).some(
    (key) => summary[key].outcome === "failed"
  );
  if (!anyCheckFailed) recovered.push("check-failed");

  if (ranClean("deploy")) recovered.push("deploy-failed");
  if (ranClean("health")) recovered.push("health-down");
  if (ranClean("digest")) recovered.push("digest-lag");

  // `recovery-degraded` recovers ONLY on a positive healthy reading — recycles
  // happened AND all of them released. An unexercised mechanism maps to
  // `not-applicable` upstream (see `toRecoveryCheckSummary`) precisely so it
  // cannot land here: every counter resets on process restart, so treating a
  // zeroed payload as recovery would let restarting the cockpit auto-close the
  // P0 that its own abandoned closes had opened.
  if (ranClean("recovery")) recovered.push("recovery-degraded");

  return recovered;
}

export type P0ResolutionAction = "mark" | "wait" | "close";

export interface P0ResolutionDecision {
  action: P0ResolutionAction;
  /** Operator-facing sentence, logged and (for `close`) written into the comment. */
  note: string;
}

export interface P0ResolutionInput {
  /** Marker read back from the issue body; null when absent or unparseable. */
  recoveryFirstObservedAtIso: string | null;
  nowMs: number;
  minSustainedMs?: number;
}

/**
 * Given an open, monitor-authored P0 whose failure class this run observed as
 * recovered, decide what to do with it.
 *
 * - `mark`  — first recovered observation: stamp the body and wait.
 * - `wait`  — recovered again, but not for long enough yet.
 * - `close` — recovered continuously for at least the sustained interval.
 *
 * A marker timestamp in the FUTURE (clock skew, a hand-edited body) yields
 * `wait`, never `close`.
 */
export function decideP0Resolution(input: P0ResolutionInput): P0ResolutionDecision {
  const minSustainedMs = input.minSustainedMs ?? P0_RECOVERY_MIN_SUSTAINED_INTERVAL_MS;
  const thresholdSec = Math.round(minSustainedMs / 1000);

  if (!input.recoveryFirstObservedAtIso) {
    return {
      action: "mark",
      note: `first recovered observation — recording it; closing requires ${thresholdSec}s of sustained recovery`,
    };
  }

  const elapsedMs = input.nowMs - Date.parse(input.recoveryFirstObservedAtIso);
  const elapsedSec = Math.round(elapsedMs / 1000);

  if (elapsedMs >= minSustainedMs) {
    return {
      action: "close",
      note: `recovered continuously for ${elapsedSec}s (>= ${thresholdSec}s threshold) since ${input.recoveryFirstObservedAtIso}`,
    };
  }

  return {
    action: "wait",
    note: `recovered ${elapsedSec}s ago (< ${thresholdSec}s threshold) — waiting for sustained recovery`,
  };
}
