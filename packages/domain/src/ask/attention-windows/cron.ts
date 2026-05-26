/**
 * Attention window cron scheduling — mt#1489.
 *
 * Provides pure functions for evaluating whether a configured cron schedule
 * should fire at a given moment. The actual timer / setInterval loop lives
 * at the CLI entry point (or future daemon supervisor); this module is
 * intentionally side-effect free so it can be unit-tested without timers.
 *
 * Cron expression format: standard 5-field minute-resolution
 *   `<minute> <hour> <day-of-month> <month> <day-of-week>`
 *
 * Day-of-week values: 0=Sunday ... 6=Saturday. The shorthand "MON-FRI" is NOT
 * parsed here — callers should use numeric ranges (e.g. "1-5") or the
 * normalised forms from `getAttentionConfigPath`. The `config.ts` schema
 * stores user-entered strings as-is; this module only matches against them
 * at tick time by parsing numeric fields.
 *
 * Day-of-week abbreviations (MON, TUE, WED, THU, FRI, SAT, SUN) are
 * normalised to numbers before matching.
 *
 * NOTE: This is a lightweight implementation covering the use cases in the
 * spec (fixed times, weekday ranges). It does NOT support step values (e.g.
 * every 15 minutes) or L/W modifiers. A production-grade parser can be
 * introduced in a follow-up without changing this module's interface.
 */

// ---------------------------------------------------------------------------
// Day-of-week name map
// ---------------------------------------------------------------------------

const DOW_MAP: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

// ---------------------------------------------------------------------------
// Core cron-match logic
// ---------------------------------------------------------------------------

/**
 * Check whether a cron field value (single field from a 5-part expression)
 * matches the given numeric `value`.
 *
 * Supports:
 *   - `*`           — wildcard, always matches
 *   - `N`           — exact match (numeric or DOW abbreviation)
 *   - `A-B`         — inclusive range
 *   - `A,B,C`       — list (each element may be a range or exact)
 *
 * DOW abbreviation normalisation applies to any element.
 */
function fieldMatches(fieldExpr: string, value: number): boolean {
  // Split on commas first (list support)
  const parts = fieldExpr.split(",");
  return parts.some((part) => {
    const trimmed = part.trim();

    // Wildcard
    if (trimmed === "*") return true;

    // Range: A-B
    if (trimmed.includes("-")) {
      const dashIdx = trimmed.indexOf("-");
      const rawA = trimmed.slice(0, dashIdx);
      const rawB = trimmed.slice(dashIdx + 1);
      const a = parseFieldValue(rawA.trim());
      const b = parseFieldValue(rawB.trim());
      return value >= a && value <= b;
    }

    // Exact value
    return parseFieldValue(trimmed) === value;
  });
}

/** Parse a cron field token as a number, normalising DOW abbreviations. */
function parseFieldValue(token: string): number {
  const upper = token.toUpperCase();
  const dowValue = DOW_MAP[upper];
  if (dowValue !== undefined) {
    return dowValue;
  }
  const n = parseInt(token, 10);
  if (isNaN(n)) {
    throw new Error(`cron: invalid field token: "${token}"`);
  }
  return n;
}

/**
 * Returns true if `now` matches the given 5-field cron expression.
 *
 * Precision: minute-level. The seconds component of `now` is ignored —
 * if the minute/hour/day values match, the cron fires for the whole minute.
 *
 * @throws {Error} when `expr` does not have exactly 5 space-separated fields.
 */
export function matchesCronNow(expr: string, now: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron: expression must have exactly 5 fields, got "${expr}"`);
  }

  // Destructure with non-null assertion safe since we validated length === 5 above
  const minField = fields[0] as string;
  const hourField = fields[1] as string;
  const domField = fields[2] as string;
  const monthField = fields[3] as string;
  const dowField = fields[4] as string;

  const minute = now.getMinutes();
  const hour = now.getHours();
  const dom = now.getDate();
  const month = now.getMonth() + 1; // getMonth is 0-indexed
  const dow = now.getDay(); // 0=Sunday

  return (
    fieldMatches(minField, minute) &&
    fieldMatches(hourField, hour) &&
    fieldMatches(domField, dom) &&
    fieldMatches(monthField, month) &&
    fieldMatches(dowField, dow)
  );
}

// ---------------------------------------------------------------------------
// Window-fire decision
// ---------------------------------------------------------------------------

/**
 * Return true if an attention window with the given cron schedule should
 * fire at `now`, taking `lastFiredAt` into account to prevent duplicate
 * firings within the same minute.
 *
 * Rules:
 *   - `schedule.type === "manual"` -> never fires on a cron tick.
 *   - `lastFiredAt` is within the same calendar minute as `now` -> already
 *     fired this tick, skip.
 *   - Otherwise: delegate to `matchesCronNow`.
 *
 * @param schedule  Resolved schedule from `AttentionWindowConfig.schedule`.
 * @param now       Current timestamp (injected for testability).
 * @param lastFiredAt Optional timestamp of the last time this window auto-opened.
 */
export function shouldWindowFireNow(
  schedule: { type: "cron"; expr: string } | { type: "manual" },
  now: Date,
  lastFiredAt?: Date
): boolean {
  if (schedule.type === "manual") {
    return false;
  }

  // De-duplicate: skip if we already fired this minute
  if (lastFiredAt) {
    const sameMinute =
      lastFiredAt.getFullYear() === now.getFullYear() &&
      lastFiredAt.getMonth() === now.getMonth() &&
      lastFiredAt.getDate() === now.getDate() &&
      lastFiredAt.getHours() === now.getHours() &&
      lastFiredAt.getMinutes() === now.getMinutes();
    if (sameMinute) {
      return false;
    }
  }

  return matchesCronNow(schedule.expr, now);
}

// ---------------------------------------------------------------------------
// Next-fire computation (for `window list` display)
// ---------------------------------------------------------------------------

/**
 * Compute the next time a cron expression fires after `after`.
 *
 * Scans forward in 1-minute increments up to `maxMinutes` (default 10 080 = 1
 * week). Returns `null` when no match is found in the window.
 *
 * This is a brute-force approach suitable for the small number of configured
 * windows (typically < 5). A proper next-occurrence algorithm can replace it
 * in a follow-up without changing callers.
 */
export function nextCronFire(expr: string, after: Date, maxMinutes = 10_080): Date | null {
  // Start searching from the next minute (not `after` itself)
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let i = 0; i < maxMinutes; i++) {
    if (matchesCronNow(expr, candidate)) {
      return new Date(candidate);
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}
