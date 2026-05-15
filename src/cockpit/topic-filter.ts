/**
 * Topic filter helper for the cockpit SSE broker — mt#1853.
 *
 * Decides whether a Postgres NOTIFY channel matches a SSE-client's
 * `?topics=...` filter list. Supports:
 *
 *   - Exact match:          `minsky.attention_window_opened`
 *   - Glob prefix match:    `attention.*`  matches `minsky.attention_window_opened`
 *     and `minsky.attention_window_closed` (the `*` matches any suffix within the
 *     dotted name after the glob prefix)
 *   - Single-star wildcard: `*` matches everything
 *   - Multi-pattern OR:     any pattern matching returns true
 *   - Empty patterns list:  returns false (client opted out)
 *
 * Glob semantics: a pattern ending with `.*` is treated as a prefix glob.
 * The prefix is everything before the trailing `.*`. The channel matches if:
 *   1. It equals the prefix exactly (no trailing segment), OR
 *   2. It starts with `<prefix>.` (dotted namespace child), OR
 *   3. It contains `.<prefix>` at some dotted boundary (sub-namespace segment
 *      match) — this is how `attention.*` matches `minsky.attention_window_opened`
 *      since the channel contains `attention` as a contiguous prefix of a
 *      dotted segment.
 *
 * Only trailing-star globs (`prefix.*` or bare `*`) are supported. A pattern
 * like `a.*.b` is treated as a literal exact-match string.
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

  // 3. Channel contains ".prefix" at a dotted boundary — sub-namespace match.
  //    E.g., prefix="attention" matches "minsky.attention_window_opened"
  //    because the channel contains ".attention" (dot then prefix).
  if (channel.includes(`.${prefix}`)) {
    return true;
  }

  return false;
}
