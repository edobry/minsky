#!/usr/bin/env bun
// UserPromptSubmit hook: surface guard-health "critical" escalation to the
// operator/agent (mt#2812).
//
// Reads the guard-health JSONL log (./guard-health.ts) and, when any guard's
// consecutive-failure streak has reached "critical" (3+ consecutive
// errors/check-skips, per this week's observed cadence in the mt#2806
// evidence), injects a warning naming the dead gate(s) — the agent about to
// rely on a guard's fail-open permit needs to know that permit may not
// reflect a real check having run.
//
// Per-session cooldown, not unconditional per-turn re-injection (mt#3072,
// REVISES the original posture below): the warning surfaces once per
// session, then is suppressed for the SAME critical-escalation signature
// until either a new failure changes it or ESCALATION_NOTIFY_COOLDOWN_MS
// elapses (see guard-health-escalation-notify-store.ts). Originally this
// module re-surfaced on EVERY turn while any guard remained critical,
// mirroring inject-current-time.ts / inject-git-state.ts's "fresh info every
// turn" posture — deliberately, to avoid "a dead gate silently forgotten
// after one mention." That intent is preserved (the cooldown still
// resurfaces periodically, and any NEW failure resurfaces immediately) but
// the unconditional every-turn repeat was itself the incident: the
// standalone-duplicate-matcher streak (2026-07-19 -> 07-22) never changed
// between failures, yet the banner re-injected on 385 of 697 turns (55%)
// across ~3 days for one unchanging, already-known cause.
//
// ADR-028 guard-dispatcher registration: this guard is registered in
// registry.ts's GUARD_REGISTRY (UserPromptSubmit family) — adding it here
// required NO dispatcher/settings.json changes beyond the family's shared
// host-cap budget bump (hook-files.mdc "Dispatcher host-cap budget model").
//
// @see mt#2812 — this task (original)
// @see mt#3072 — the cooldown + causeClass additions (this revision)
// @see .minsky/hooks/guard-health.ts — the shared record/read/aggregate module
// @see .minsky/hooks/guard-health-escalation-notify-store.ts — the cooldown store
// @see .minsky/hooks/dispatcher.ts — the automatic capture path for every
//      ADR-028-migrated guard's thrown errors
// @see .minsky/hooks/registry.ts — GUARD_REGISTRY entry for this guard

import { readInput, writeOutput } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import type { DispatchContext, GuardOutcome } from "./registry";
import { getGuardHealthSummary, STALE_ESCALATION_WINDOW_MS } from "./guard-health";
import { cappedEvidenceLines, truncateToRenderedLength } from "./guard-feedback-format";
import type { GuardHealthSummary } from "./guard-health";
import {
  shouldNotifyEscalation,
  escalationSignature,
} from "./guard-health-escalation-notify-store";

export interface UserPromptSubmitInput extends ClaudeHookInput {
  prompt: string;
}

/**
 * Most guards to name per section before collapsing the rest to a count
 * (mt#3705).
 *
 * Without it this banner had NO bound: `live`/`stale` are whatever
 * `summary.criticalGuards` contains, and a multi-guard failure streak is
 * precisely the condition it fires on. Measured pre-cap at 929 chars for three
 * guards and 1649 for six, against a declared ceiling of 600 — the ceiling held
 * only because the canary posed one guard with a short message.
 *
 * Two is enough to act on. The banner is an ALERT, not a report: full detail is
 * one `debug_systemInfo` call away, and the trailing line says so. Two rather
 * than three is worth 314 chars off the bound (1427 -> 1113 with the message cap
 * below), which is the difference between this guard being the largest
 * conditional detector on `UserPromptSubmit` and merely the second.
 */
export const MAX_LISTED_GUARDS = 2;

/**
 * Longest interpolated `lastEvent.message`, in UTF-16 code units (mt#3705).
 *
 * The SECOND unbounded axis, and the one that mattered more: this value is a
 * caught error's `.message`, so its length belongs to whatever threw. A single
 * guard with a 300-char stack-ish message rendered 829 chars — over the ceiling
 * at a list length of ONE, which no per-item cap would have caught.
 *
 * **The UNIT was wrong until mt#4359, and the bound leaked because of it.** This
 * was enforced with `truncateToCodePoints`, which bounds CODE POINTS, while the
 * ceiling it feeds is measured in UTF-16 units — `guard-feedback-shape.test.ts`
 * compares `advisory.length` against the declared number, and the dispatcher
 * SPENDS `rendered.length` against `MERGED_CONTEXT_BUDGET_CHARS`. One emoji is
 * one code point and two units, so a 60-code-point bound admitted a 120-unit
 * message on each of the (at most two) live lines.
 *
 * That is not academic for THIS value: the docblock on `truncateToCodePoints`
 * says a guard's interpolated `Error.message` "routinely carries emoji from a
 * subprocess's own output", and this field is exactly that. Measured 2026-08-20
 * against the live `buildCriticalWarning` at saturation — both lists overflowing
 * `MAX_LISTED_GUARDS` — the all-ASCII render was 1207 against a declared 1300,
 * and the identical all-emoji render was **1327: over the ceiling**. The margin
 * was 93 and the mismatch cost 120.
 *
 * `truncateToRenderedLength` bounds units while still iterating code points, so
 * a surrogate pair is never split. Same defect and same fix as mt#4234 on
 * `ask-routing-deferral-detector`; see that primitive's docblock for why the fix
 * belongs at the cap rather than at the ceiling's unit.
 *
 * **The declared 1300 stays, and is now a MEASURED ceiling rather than an
 * inherited one.** Saturating every axis at once — the two longest names in
 * `GUARD_REGISTRY` (37 chars) across an overflowing live list and an overflowing
 * stale list, six-digit streaks, and an all-emoji message past the cap — renders
 * **1219**. That is the true worst case, not the 1207 an earlier fixture with
 * 36-char names produced. 1300 clears it by 81.
 *
 * Deliberately NOT lowered to 1219. Unlike mt#4234, where the annotation was a
 * SAMPLE the render already exceeded and had to move, this number was never
 * breached on the ASCII path — only the emoji unit bug crossed it, and that is
 * fixed here. Tightening to the exact figure would buy 81 chars of a shared
 * budget (this guard sits in the top-five bucket `MERGED_CONTEXT_BUDGET_CHARS`
 * is derived from) at the cost of a ceiling that breaks on any guard RENAME —
 * the name axis is bounded only by whatever is registered, so the exact figure
 * is a moving target in a way the render text is not.
 */
export const MAX_ERROR_MESSAGE_CHARS = 60;

/** Bound an interpolated error message, marking any elision so it doesn't read as the whole message. */
function truncateMessage(message: string): string {
  return truncateToRenderedLength(message, MAX_ERROR_MESSAGE_CHARS);
}

/**
 * Render up to `MAX_LISTED_GUARDS` lines plus an overflow count.
 *
 * Shared by both sections so neither can regrow independently — the live list
 * and the stale list are separate collections and each needed the same bound.
 */
function cappedLines(names: string[], render: (name: string) => string): string[] {
  return cappedEvidenceLines(names, render, MAX_LISTED_GUARDS);
}

/** Humanize a millisecond age as "Nh Mm" / "Nh" / "Mm" for banner display. mt#2969. */
function formatAge(ms: number | null): string {
  if (ms == null) return "unknown";
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/**
 * Build the operator/agent-facing warning naming every currently-critical
 * guard. Returns null when overall escalation is not "critical" (the common
 * case — no injection). mt#2969: critical guards are partitioned into LIVE
 * (a failure within STALE_ESCALATION_WINDOW_MS) and STALE (no failure since —
 * likely recovered or dormant). A stale-only escalation is DE-ALARMED rather
 * than presented as an active incident — a stale ~19h-old streak previously
 * read as a live "CRITICAL" and drove a multi-hour misdiagnosis.
 */
export function buildCriticalWarning(summary: GuardHealthSummary): string | null {
  if (summary.escalation !== "critical" || summary.criticalGuards.length === 0) return null;

  // Freshness-window label derived from the constant so the banner text can't
  // drift from STALE_ESCALATION_WINDOW_MS (mt#2969 review nit).
  const windowLabel = formatAge(STALE_ESCALATION_WINDOW_MS);

  const live: string[] = [];
  const stale: string[] = [];
  for (const name of summary.criticalGuards) {
    (summary.byGuard[name]?.stale ? stale : live).push(name);
  }

  // mt#3072 SC2: append the known cause class when the last event carries
  // one, so a critical streak reads as immediately diagnosable ("infra" ->
  // an external dependency, "logic" -> the guard's own code) instead of an
  // opaque repeat count.
  const causeClassTag = (name: string): string => {
    const causeClass = summary.byGuard[name]?.lastEvent?.causeClass;
    return causeClass ? ` [${causeClass}]` : "";
  };
  const liveLine = (name: string): string => {
    const entry = summary.byGuard[name];
    const streak = entry?.consecutiveStreak ?? 0;
    const lastMessage = truncateMessage(entry?.lastEvent?.message ?? "unknown error");
    return `  - ${name}: ${streak} consecutive failures (last: ${lastMessage})${causeClassTag(name)}`;
  };
  const staleLine = (name: string): string => {
    const entry = summary.byGuard[name];
    const streak = entry?.consecutiveStreak ?? 0;
    const age = formatAge(entry?.lastFailureAgeMs ?? null);
    // mt#3892: say WHICH of the two "likely stale" cases this is, now that the
    // clean-run join can tell them apart. A guard that has decided cleanly
    // since its last failure resets its streak to 0 and never reaches this list
    // at all, so the only cases left here are the two that still need the
    // reader's judgment — and they call for opposite responses.
    const state =
      entry?.liveness === "failing"
        ? "no clean run since the failures — still broken, just not triggered lately"
        : "no clean-run evidence either way — dormant, or broken and unexercised";
    return `  - ${name}: ${streak} failures, last ${age} ago — ${state}${causeClassTag(name)}`;
  };

  if (live.length > 0) {
    const lines = [
      "⚠️ Guard-health escalation: CRITICAL. The following guard(s) have failed " +
        "3+ times in a row and cannot currently be trusted to enforce their " +
        "check — a fail-open guard that crashes permits silently, so its most " +
        'recent "allow" reflects a crash, not a verified check:',
      ...cappedLines(live, liveLine),
    ];
    if (stale.length > 0) {
      lines.push(
        `Also had a failure streak but NONE within the last ${windowLabel} (likely stale — ` +
          "recovered or dormant; verify, don't treat as active):",
        ...cappedLines(stale, staleLine)
      );
    }
    lines.push(
      "Treat the ACTIVE guards' recent permits as unchecked, not verified-allow. See " +
        "`mcp__minsky__debug_systemInfo`'s `guardHealth` field, or the cockpit " +
        "guard-health widget, for full detail."
    );
    return lines.join("\n");
  }

  // Only stale critical guards (mt#2969): de-alarmed. A streak that has gone
  // quiet (no failure within STALE_ESCALATION_WINDOW_MS) is likely recovered
  // or dormant, not an active incident. Surface it (nothing lost) without the
  // "cannot be trusted" active-danger framing; it clears on the 24h age-out.
  return [
    "ℹ️ Guard-health: the following guard(s) had a failure streak but NONE within " +
      `the last ${windowLabel} — likely stale (recovered or dormant), NOT an active incident. ` +
      "Verify via `mcp__minsky__debug_systemInfo`'s `guardHealth` before treating as " +
      "live; a stale streak clears automatically once its last failure ages past 24h:",
    ...cappedLines(stale, staleLine),
  ].join("\n");
}

/**
 * Guard-dispatcher entry point. Fail-safe: any read/aggregation error
 * degrades to "no injection" (mt#2812 acceptance test: "Tracker DB/log
 * unavailable -> guards still run normally") — this guard must never be the
 * next incident it's built to warn about.
 *
 * mt#3072 SC3: before injecting, checks the per-session cooldown store
 * (`guard-health-escalation-notify-store.ts`) — a critical escalation whose
 * signature (every critical guard's name + last-failure timestamp/message)
 * hasn't changed since it was last surfaced to THIS session within the
 * cooldown window is suppressed. `shouldNotifyEscalation` itself fails open
 * toward SURFACING on any cooldown-store read/write error (never the silent
 * direction) — an unreadable cooldown store must not become a new way to
 * hide a live critical guard.
 */
export function run(input: ClaudeHookInput, _ctx: DispatchContext): GuardOutcome | null {
  try {
    const summary = getGuardHealthSummary();
    const warning = buildCriticalWarning(summary);
    if (!warning) return null;
    if (!shouldNotifyEscalation(input.session_id, escalationSignature(summary))) return null;
    return { additionalContext: warning };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hook entry point (gated per mt#2835's guard-entrypoint-gate parity test)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  let sessionId = "";
  try {
    const input = await readInput<UserPromptSubmitInput>();
    sessionId = input.session_id;
  } catch {
    process.exit(0);
  }

  try {
    const summary = getGuardHealthSummary();
    const warning = buildCriticalWarning(summary);
    if (warning && shouldNotifyEscalation(sessionId, escalationSignature(summary))) {
      const output: HookOutput = {
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: warning },
      };
      writeOutput(output);
    }
  } catch {
    // Fail-safe — never block the turn.
  }

  process.exit(0);
}
