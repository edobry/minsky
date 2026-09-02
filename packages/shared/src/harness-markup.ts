/**
 * Shared inventory of harness-injected markup tags (mt#3322).
 *
 * Two surfaces classify the same harness markup and, before this module,
 * each carried its own hand-maintained tag list:
 *
 *   - `packages/domain/src/transcripts/text-snippet.ts` (`stripHarnessMarkup`)
 *     — the conversation-LABEL surface, which DISCARDS these blocks.
 *   - `src/cockpit/web/lib/injected-content.ts` (`splitInjectedContent`)
 *     — the conversation-RENDER surface, which DEMOTES them behind a
 *     collapsed header.
 *
 * The two lists had already drifted apart in both directions:
 * `local-command-stdout` was in the label allowlist but absent from the
 * render detector, and `local-command-caveat` was missing from both. One
 * inventory, consumed by both, makes the next harness-markup addition a
 * one-line change in one place.
 *
 * **The inventory is empirically grounded, not guessed.** It is the set of
 * tags actually observed across the local transcript corpus (~2.6k
 * conversations, surveyed 2026-07-29). Three tags that a name-based guess
 * would plausibly include are deliberately ABSENT because the survey showed
 * they are ordinary prose, not harness markup:
 *
 *   - `<command>` (410 occurrences) — CLI help text (`exec [options] <command>`,
 *     `git <command> [<revision>...]`).
 *   - `<command-digest>` (16) — a code comment describing an id format.
 *   - `<skill-name>` (112) — rule prose describing the `/<skill-name>` form.
 *
 * A `local-command-stderr` tag does NOT exist in the corpus; do not add one
 * on symmetry grounds without observing it first. (Note that `bash-stderr`,
 * added below, is a DIFFERENT tag from a different family and was observed
 * before being added — it is not a counter-example to that rule.)
 *
 * **Why `@minsky/shared` and not `@minsky/domain`,** given that both consumers
 * are transcript code and one of them lives in the domain layer: the cockpit
 * consumer is browser-bundled, and `custom/no-node-import-in-cockpit-web`
 * (mt#3239) bans VALUE imports from `@minsky/domain` there — a domain module
 * may reach Node-only code transitively. This module has no dependencies at
 * all, so `shared` (which the domain layer already imports from, e.g.
 * `safe-truncate`) is the one home both surfaces can reach.
 *
 * @see src/cockpit/web/lib/injected-content.ts — the render-surface consumer
 * @see packages/domain/src/transcripts/text-snippet.ts — the label-surface consumer
 */

/**
 * Tags the harness emits as a group at the START of a user turn when a slash
 * command or skill is invoked.
 *
 * **Order is NOT fixed.** The corpus survey found both orderings in live use:
 * 124 turns lead with `command-name`, 10 lead with `command-message`.
 * Consumers must match this group order-tolerantly — a fixed-sequence pattern
 * silently misses whichever ordering it did not encode (which is exactly how
 * the render surface came to leak 124 of 134 command turns as raw XML).
 */
export const COMMAND_WRAPPER_TAGS = [
  "command-name",
  "command-message",
  "command-args",
  "skill-format",
] as const;

/**
 * Tags wrapping a local command's captured terminal output and the
 * agent-directed caveat the harness attaches to it.
 *
 * `local-command-caveat` is boilerplate addressed to the MODEL ("DO NOT
 * respond to these messages..."), not to the operator — it is the clearest
 * case in the inventory of markup that must never render as operator prose.
 * `local-command-stdout` carries raw terminal bytes and needs ANSI stripping
 * (`@minsky/shared/strip-ansi`) before display.
 */
export const LOCAL_COMMAND_TAGS = ["local-command-stdout", "local-command-caveat"] as const;

/**
 * Bash-mode tags (mt#4058) — what the harness records when the operator types a
 * `!`-prefixed command straight into the prompt, rather than invoking a slash
 * command.
 *
 * Shape differs from {@link LOCAL_COMMAND_TAGS} in one way that matters to
 * consumers: `bash-stdout` and `bash-stderr` arrive CONCATENATED inside a
 * single turn — `<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>` —
 * and one half is frequently EMPTY. A consumer that stops after the first
 * matched block leaks the second as raw prose.
 *
 * Corpus counts (surveyed 2026-08-12 over `~/.claude/projects/**\/*.jsonl`, the
 * same method as the 2026-07-29 survey above): 39 `bash-input`, 27
 * `bash-stdout`, 21 `bash-stderr`, across 14 conversations. `bash-input` is
 * role `user` and carries the operator's typed command; the stdout/stderr pair
 * is also role `user` and carries none of their words at all, which is why it
 * rendered under the operator's own label before this was added.
 */
export const BASH_MODE_TAGS = ["bash-input", "bash-stdout", "bash-stderr"] as const;

/** Harness reminder blocks. Unlike the others, these interleave anywhere in a turn. */
export const SYSTEM_REMINDER_TAGS = ["system-reminder"] as const;

/**
 * Background-task completion notices (mt#3396).
 *
 * The harness emits one of these as a whole `user` turn when a background task
 * finishes — `<task-notification><task-id>…</task-id><status>…</status>…`. The
 * operator wrote none of it, so like the caveat above it must never render as
 * operator prose. Measured across the local transcript corpus: 48 turns carry
 * the tag and ALL 48 are role `user`, which is exactly why it reached the
 * render surface under the operator's label.
 */
export const TASK_NOTIFICATION_TAGS = ["task-notification"] as const;

/**
 * The preamble the harness prepends to a worker fork's opening turn (mt#4072).
 *
 * Same class as `local-command-caveat`: addressed to the MODEL throughout —
 * "You are a worker fork. The transcript above is the parent's history —
 * inherited reference, not your situation… Do NOT spawn subagents with the
 * Agent tool… One shot: report once and stop." The operator wrote none of it,
 * and it carries `isMeta: undefined`, so the mt#3809 `isMeta` precedence branch
 * does not catch it and it rendered under the operator's own label.
 *
 * Corpus counts (measured 2026-09-02 over 1,744 `~/.claude/projects/**\/*.jsonl`
 * files, turn-start-anchored exactly as `scripts/audit-unknown-harness-tags.ts`
 * counts): **15 turns in 15 conversations, all under `subagents/`**, and the
 * block is INVARIANT at 947 characters — one variant, no drift.
 *
 * Two properties a consumer must not get wrong, both measured:
 *
 * - **Every occurrence is followed by the parent's actual directive** (15 of 15,
 *   89–4,196 chars), inside a two-block `[tool_result, text]` content array. A
 *   boilerplate-ONLY turn does not occur in the corpus. So a consumer that
 *   consumes to end-of-turn eats real content; the block must be split off and
 *   the remainder kept as prose.
 * - **The population is historical and shrinking**, unlike every other family
 *   here: all 15 are from 2026-07 and none has arrived since. It measured 29 on
 *   2026-08-13, so these transcripts are aging out. Do not read the count as a
 *   live rate.
 *
 * Counting caveat (mem#1022): a line-level `grep -rl fork-boilerplate` over the
 * corpus returns ~161 files, because it counts every transcript DISCUSSING the
 * tag — including this task's own planning conversations. Count turn-start
 * anchored, or just run the sweep.
 */
export const FORK_BOILERPLATE_TAGS = ["fork-boilerplate"] as const;

/**
 * Every harness markup tag, flattened. This is the DISCARD set for the label
 * surface: a tag here has contents that are never operator prose, so the
 * whole block (markers and body) is dropped rather than unwrapped.
 */
export const HARNESS_MARKUP_TAGS = [
  ...COMMAND_WRAPPER_TAGS,
  ...LOCAL_COMMAND_TAGS,
  ...BASH_MODE_TAGS,
  ...SYSTEM_REMINDER_TAGS,
  ...TASK_NOTIFICATION_TAGS,
  ...FORK_BOILERPLATE_TAGS,
] as const;

export type HarnessMarkupTag = (typeof HARNESS_MARKUP_TAGS)[number];

/**
 * Regex source for an opening tag, tolerating attributes and whitespace
 * padding (`<command-message kind="slash">`, `<command-message >`). The
 * harness's exact tag casing and attributes are not a guaranteed contract, so
 * consumers compile these case-insensitively.
 */
export function tagOpenSource(name: string): string {
  return `<${name}(?:\\s[^>]*)?>`;
}

/** Regex source for a closing tag. */
export function tagCloseSource(name: string): string {
  return `</${name}>`;
}

/**
 * Regex source for a full tag pair. `capture` wraps the body in a capture
 * group so callers can read the contained text.
 */
export function tagBlockSource(name: string, capture = false): string {
  const inner = capture ? "([\\s\\S]*?)" : "[\\s\\S]*?";
  return `${tagOpenSource(name)}${inner}${tagCloseSource(name)}`;
}
