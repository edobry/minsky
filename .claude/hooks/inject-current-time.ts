#!/usr/bin/env bun
// UserPromptSubmit hook: inject the current date and time into every turn's
// context (mt#2181).
//
// Why this exists. The agent has no reliable way to know "now" without running
// `date` via a tool. The session-start system reminder anchors the date once,
// but conversations can run for hours or days; the anchor goes stale silently.
// Memory-tier discipline ("always run `date` before stating calendar facts")
// failed within minutes in the originating session (R1 then R2 ~30 min apart on
// 2026-05-30), because:
//   - The memory-search hook injects memories matched against the USER'S prompt
//   - "What's the status of this" has no calendar keywords → memory not surfaced
//   - The agent doesn't recognize its own future-tense response as a date assertion
//
// This hook fires on every UserPromptSubmit and injects the current local time
// (with day of week and timezone) plus UTC. Same architectural pattern as
// memory-search.ts and skill-staleness-detector.ts — the additionalContext makes
// the current time PRESENT in context whether the agent looks for it or not.
//
// Override: MINSKY_SKIP_TIME_INJECTION=1|true|yes skips injection with an
// audit-log line to stdout. Use only when intentionally testing the agent's
// stale-context handling.
//
// @see mt#2181 — this hook
// @see memory 53086971 — bridge memory this hook retires
// @see .claude/hooks/memory-search.ts — architectural template
// @see .claude/hooks/skill-staleness-detector.ts — sibling discipline hook

import { readInput, writeOutput } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";

export const TIME_INJECTION_OVERRIDE_ENV = "MINSKY_SKIP_TIME_INJECTION";

export interface UserPromptSubmitInput extends ClaudeHookInput {
  prompt: string;
}

/**
 * Build the additionalContext string for a given Date. Pure function for
 * testability; the entrypoint passes `new Date()` at runtime.
 *
 * Format example:
 *   "Current time: Saturday 2026-05-30 16:39:00 EDT-0400 (UTC: 2026-05-30T20:39:00Z)"
 *
 * Includes:
 *   - Day of week (so the agent can answer "what day is it?" without computing)
 *   - ISO local date (the canonical reference format)
 *   - Local time with timezone abbreviation and numeric offset (both useful;
 *     the numeric offset is unambiguous, the abbreviation is human-readable)
 *   - UTC ISO timestamp (canonical for scheduling, logging, cross-region work)
 */
export function buildTimeContext(now: Date): string {
  const dayName = now.toLocaleDateString("en-US", { weekday: "long" });
  const localDate = now.toLocaleDateString("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const localTime = now.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  // Timezone abbreviation (e.g., "EDT") and numeric offset (e.g., "-0400")
  const tzAbbr =
    new Intl.DateTimeFormat("en-US", {
      timeZoneName: "short",
    })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  const offsetMin = now.getTimezoneOffset();
  const offsetSign = offsetMin <= 0 ? "+" : "-";
  const offsetHours = String(Math.floor(Math.abs(offsetMin) / 60)).padStart(2, "0");
  const offsetMins = String(Math.abs(offsetMin) % 60).padStart(2, "0");
  const offsetStr = `${offsetSign}${offsetHours}${offsetMins}`;
  const utcIso = now.toISOString().replace(/\.\d{3}Z$/, "Z");

  return `Current time: ${dayName} ${localDate} ${localTime} ${tzAbbr}${offsetStr} (UTC: ${utcIso})`;
}

/**
 * Truthy values for the override env var. Matches the convention used by
 * sibling hooks (parallel-work-guard, bundle-boot-smoke, etc.).
 */
function isOverrideTruthy(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

async function main(): Promise<void> {
  // Override path: skip injection, emit audit line to stdout.
  if (isOverrideTruthy(process.env[TIME_INJECTION_OVERRIDE_ENV])) {
    const auditLine = `[inject-current-time] override active: ${TIME_INJECTION_OVERRIDE_ENV}=${process.env[TIME_INJECTION_OVERRIDE_ENV]} at ${new Date().toISOString()}`;
    // Audit lines go to stdout; they are not valid HookOutput JSON, so Claude
    // Code's hook-output parser logs them as "Ignoring non-JSON line on stdout".
    // Mirrors the convention used by sibling hooks (parallel-work-guard.ts,
    // check-branch-fresh.ts).
    process.stdout.write(`${auditLine}\n`);
    return;
  }

  // Read and discard the input — we don't need any of it; we always inject.
  // readInput is called so that the stdin pipe is consumed (Claude Code may
  // hang otherwise on some platforms if the hook never reads stdin).
  try {
    await readInput<UserPromptSubmitInput>();
  } catch {
    // Even if input parsing fails, we can still emit the time. The hook is
    // informational; it should never block the user prompt.
  }

  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: buildTimeContext(new Date()),
    },
  };
  writeOutput(output);
}

// Entrypoint guard: only run main() when this file is invoked as a script.
// Tests import the pure functions without triggering stdin reads.
if (import.meta.main) {
  await main();
}
