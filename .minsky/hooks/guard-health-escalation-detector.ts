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
// No de-duplication / per-session "already warned" tracker: the warning is
// re-surfaced every turn while any guard remains critical, mirroring
// inject-current-time.ts / inject-git-state.ts's "fresh info every turn"
// posture — a dead gate silently forgotten after one mention would defeat
// the point of an ESCALATING signal.
//
// ADR-028 guard-dispatcher registration: this guard is registered in
// registry.ts's GUARD_REGISTRY (UserPromptSubmit family) — adding it here
// required NO dispatcher/settings.json changes beyond the family's shared
// host-cap budget bump (hook-files.mdc "Dispatcher host-cap budget model").
//
// @see mt#2812 — this task
// @see .minsky/hooks/guard-health.ts — the shared record/read/aggregate module
// @see .minsky/hooks/dispatcher.ts — the automatic capture path for every
//      ADR-028-migrated guard's thrown errors
// @see .minsky/hooks/registry.ts — GUARD_REGISTRY entry for this guard

import { readInput, writeOutput } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import type { DispatchContext, GuardOutcome } from "./registry";
import { getGuardHealthSummary } from "./guard-health";
import type { GuardHealthSummary } from "./guard-health";

export interface UserPromptSubmitInput extends ClaudeHookInput {
  prompt: string;
}

/**
 * Build the operator/agent-facing warning naming every currently-critical
 * guard. Returns null when overall escalation is not "critical" (the common
 * case — no injection, matching every other guard's "write nothing on
 * allow" convention).
 */
export function buildCriticalWarning(summary: GuardHealthSummary): string | null {
  if (summary.escalation !== "critical" || summary.criticalGuards.length === 0) return null;

  const lines = summary.criticalGuards.map((name) => {
    const entry = summary.byGuard[name];
    const streak = entry?.consecutiveStreak ?? 0;
    const lastMessage = entry?.lastEvent?.message ?? "unknown error";
    return `  - ${name}: ${streak} consecutive failures (last: ${lastMessage})`;
  });

  return [
    "⚠️ Guard-health escalation: CRITICAL. The following guard(s) have failed " +
      "3+ times in a row and cannot currently be trusted to enforce their " +
      "check — a fail-open guard that crashes permits silently, so its most " +
      'recent "allow" reflects a crash, not a verified check:',
    ...lines,
    "Treat these guards' recent permits as unchecked, not verified-allow. See " +
      "`mcp__minsky__debug_systemInfo`'s `guardHealth` field, or the cockpit " +
      "guard-health widget, for full detail.",
  ].join("\n");
}

/**
 * Guard-dispatcher entry point. Fail-safe: any read/aggregation error
 * degrades to "no injection" (mt#2812 acceptance test: "Tracker DB/log
 * unavailable -> guards still run normally") — this guard must never be the
 * next incident it's built to warn about.
 */
export function run(_input: ClaudeHookInput, _ctx: DispatchContext): GuardOutcome | null {
  try {
    const summary = getGuardHealthSummary();
    const warning = buildCriticalWarning(summary);
    return warning ? { additionalContext: warning } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Hook entry point (gated per mt#2835's guard-entrypoint-gate parity test)
// ---------------------------------------------------------------------------

if (import.meta.main) {
  try {
    await readInput<UserPromptSubmitInput>();
  } catch {
    process.exit(0);
  }

  try {
    const summary = getGuardHealthSummary();
    const warning = buildCriticalWarning(summary);
    if (warning) {
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
