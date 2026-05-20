/**
 * Topic filter helper for the cockpit SSE broker — mt#1853.
 *
 * Decides whether a Postgres NOTIFY channel matches a SSE-client's
 * `?topics=...` filter list. Supports:
 *
 *   - Exact match:          `minsky.attention_window_opened`
 *   - Dotted-segment glob:  `attention.*` matches any channel that contains
 *     `.attention` at a dot boundary (see rule 3 below), which includes
 *     `minsky.attention_window_opened` and `minsky.attention_window_closed`.
 *   - Direct namespace:     `minsky.*` matches all channels that start with
 *     `minsky.` (rule 2), e.g. `minsky.attention_window_opened`.
 *   - Single-star wildcard: `*` matches everything (rule 0).
 *   - Multi-pattern OR:     any pattern matching returns true.
 *   - Empty patterns list:  returns false (client opted out).
 *
 * Glob matching semantics for a `<prefix>.*` pattern (prefix = text before
 * the trailing `.*`):
 *
 *   Rule 0 — bare `*`:                channel === anything → true
 *   Rule 1 — exact prefix match:      channel === prefix → true
 *             (e.g. `minsky.*` and channel `minsky` → true)
 *   Rule 2 — direct namespace child:  channel.startsWith(`${prefix}.`) → true
 *             (e.g. `minsky.*` and channel `minsky.foo` → true)
 *   Rule 3 — dotted boundary match:   channel.includes(`.${prefix}`) → true
 *             (e.g. `attention.*` and channel `minsky.attention_window_opened` →
 *             true, because the channel contains `.attention`)
 *
 * Rule 3 is the "cross-namespace" match: it lets clients subscribe to a
 * logical subsystem name (e.g. `attention`) without knowing which top-level
 * namespace (e.g. `minsky`) channels live under.
 *
 * NOTE: rule 3 is a strict dotted-boundary check (`.prefix`), NOT a plain
 * substring match. A channel `minsky.noattention` does NOT match `attention.*`
 * because the boundary character `.` must immediately precede `attention`.
 *
 * Only trailing-star globs (`prefix.*` or bare `*`) are supported. A pattern
 * like `a.*.b` is treated as a literal exact-match string (no glob).
 */

/**
 * Returns true if `channel` matches at least one pattern in `patterns`.
 *
 * @param channel  — Postgres NOTIFY channel name, e.g. `minsky.attention_window_opened`
 * @param patterns — Client topic filter list, e.g. `["attention.*", "session.*"]`
 */
export function matchesTopic(channel: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }

  for (const pattern of patterns) {
    if (matchesPattern(channel, pattern)) {
      return true;
    }
  }

  return false;
}

function matchesPattern(channel: string, pattern: string): boolean {
  // Bare wildcard — matches everything
  if (pattern === "*") {
    return true;
  }

  if (!pattern.endsWith(".*")) {
    // No glob — exact match only
    return channel === pattern;
  }

  // Glob prefix match: strip trailing ".*" to get the prefix token.
  // E.g., "attention.*" → prefix = "attention"
  const prefix = pattern.slice(0, -2);

  // 1. Exact match of the prefix itself (no trailing segment)
  if (channel === prefix) {
    return true;
  }

  // 2. Channel starts with "prefix." — direct child namespace
  //    E.g., prefix="minsky" matches "minsky.attention_window_opened"
  if (channel.startsWith(`${prefix}.`)) {
    return true;
  }

  // 3. Channel contains ".prefix" at a dotted boundary — cross-namespace match.
  //    E.g., prefix="attention" matches "minsky.attention_window_opened"
  //    because the channel contains ".attention" (dot immediately before the
  //    prefix token). This is a strict dotted-boundary check, NOT a plain
  //    substring match: "minsky.noattention" does NOT match "attention.*".
  if (channel.includes(`.${prefix}`)) {
    return true;
  }

  return false;
}
