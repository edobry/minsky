/**
 * Escalation eligibility for MCP disconnect events (mt#4499).
 *
 * ## Why this module exists
 *
 * This predicate had THREE hand-written copies, and they disagreed:
 *
 * - `src/mcp/disconnect-tracker.ts` — the in-process tracker.
 * - `.minsky/rules/mcp-disconnect-cadence.mdc` — the operator-facing prose.
 * - `src/cockpit/widgets/s3-gauges.ts` — the cockpit's S3 gauge, which reads
 *   the JSONL log directly and re-implemented the predicate from the rule.
 *
 * mt#4481 pinned the first two together with a test and did not know the third
 * existed. The widget's copy was missing `"signal"`, so for the 2026-07-26
 * crash burst the cockpit gauge and `debug_systemInfo` gave different answers
 * about the same 128 events in the same file.
 *
 * ## Why it is dependency-free
 *
 * The widget's own docstring declined to import the tracker for a good reason:
 * it is a different process's singleton and pulls in the logger, the
 * Braintrust emitter and the credential scrubber. That objection is to the
 * TRACKER, not to sharing a constant — so this module imports nothing at all,
 * and both sides can depend on it without taking any of that weight.
 *
 * Keep it that way. A VALUE import here re-creates the reason the copies
 * existed. The `import type` below is not one: TypeScript erases it entirely,
 * so it costs nothing at runtime and buys back the compile-time specificity
 * that a bare `ReadonlySet<string>` would have thrown away (PR #3283 R1).
 */
import type { McpDisconnectCause } from "./disconnect-tracker";

/**
 * Causes whose disconnect events are initiated by design and excluded from the
 * escalation count regardless of uptime.
 *
 * ## Deliberately ABSENT — these DO escalate
 *
 * - `signal_sigkill` and `proxy_observed_crash` — an external actor caused
 *   them; that is what escalation is for.
 * - `signal` — the proxy's catch-all for signals with no dedicated entry
 *   (SIGSEGV / SIGABRT / SIGBUS). **It was a member until mt#4499.**
 *
 * ## The `signal` history, corrected (mt#4499)
 *
 * mt#4481 wrote that mt#2830 added `"signal"` to this set. That is wrong, and
 * the blame says so: it was added on **2026-05-08 by mt#1682** (commit
 * `32283680c7`), two months before the cause had any producer at all.
 *
 * At that time `"signal"` was a dormant backward-compat value for mt#1645-era
 * logs, in an era when "a signal" meant SIGTERM / SIGINT / SIGHUP — so filing
 * it under "initiated by design" was reasonable and cost nothing, because
 * nothing emitted it. mt#2830 then adopted the dormant value as
 * `classifyExitForDisconnectLog`'s `default:` branch for CRASH signals. The
 * meaning changed; the membership did not, because nothing connected the two.
 *
 * Removing it reclassifies no historical record, because no record ever
 * carried the old meaning — verified across the whole log including the
 * mt#1645-era legacy array, which contains only `stdin_close` and `unknown`,
 * and every one of the 156 bare-`signal` records carries
 * `serverName: "minsky-proxy"`.
 */
export const SERVER_INITIATED_CAUSES: ReadonlySet<McpDisconnectCause> = new Set<McpDisconnectCause>(
  [
    "staleness_exit",
    "signal_sigterm",
    "signal_sigint",
    "signal_sighup",
    "server_close",
    "idle_timeout",
  ]
);

/**
 * The same set widened for lookup only.
 *
 * `ReadonlySet<McpDisconnectCause>.has()` accepts only union members, but the
 * predicate below is deliberately fed arbitrary strings — the cockpit widget
 * passes a `cause` it parsed out of a JSONL line, which can be anything a
 * past or future writer put there. Widening at the lookup keeps the EXPORTED
 * type strict for consumers while letting the predicate stay honest about what
 * it actually receives.
 */
const CAUSE_LOOKUP: ReadonlySet<string> = SERVER_INITIATED_CAUSES as ReadonlySet<string>;

/**
 * Disconnects shorter than this are harness probes and hook subprocesses, not
 * working sessions. Legacy mt#1645 events carry no `uptimeMs` and are counted
 * conservatively (see below).
 */
export const SHORT_LIVED_THRESHOLD_MS = 5000;

/**
 * The minimum shape the predicate reads. Deliberately structural and loose:
 * the tracker passes a fully-typed `McpDisconnectEvent`, while the cockpit
 * widget passes a record it parsed out of a JSONL line and validated only
 * shallowly. Both satisfy this.
 */
export interface EscalationCandidate {
  kind: string;
  cause?: string;
  uptimeMs?: number;
  processRole?: string;
}

/**
 * True when a disconnect event counts toward the escalation thresholds.
 *
 * Eligible means ALL of:
 * - `kind === "disconnect"`
 * - the cause is not in `SERVER_INITIATED_CAUSES`
 * - `uptimeMs >= SHORT_LIVED_THRESHOLD_MS`, **or absent** — legacy mt#1645
 *   events have no uptime, and are counted conservatively rather than dropped
 * - `processRole !== "helper"` (mt#1705) — helper sessions made zero tool
 *   calls. Legacy events without `processRole` are likewise counted
 *   conservatively, for the same reason.
 *
 * Both "conservative" branches bias toward OVER-reporting, which is the right
 * direction for a signal whose job is to surface reliability problems.
 */
export function isEscalationEligible(event: EscalationCandidate): boolean {
  if (event.kind !== "disconnect") return false;
  if (typeof event.cause === "string" && CAUSE_LOOKUP.has(event.cause)) return false;
  if (typeof event.uptimeMs === "number" && event.uptimeMs < SHORT_LIVED_THRESHOLD_MS) return false;
  if (event.processRole === "helper") return false;
  return true;
}
