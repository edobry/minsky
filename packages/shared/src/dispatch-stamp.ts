/**
 * The mt#2292 dispatch correlation stamp — format, and the parser for it.
 *
 * Lives in `@minsky/shared` for the same reason `harness-markup.ts` does
 * (mt#3322): both the hook tree and the cockpit's BROWSER bundle need it, and
 * `custom/no-node-import-in-cockpit-web` (mt#3239) bans value imports from
 * `@minsky/domain` in browser code. One format, one parser, two consumers —
 * rather than a second regex in the render layer that can drift from the one
 * that writes the stamp.
 *
 * The WRITE half (`buildDispatchStamp` / `stampPrompt`) stays in
 * `.minsky/hooks/agent-dispatch-stamp.ts`: only the dispatch guard writes
 * stamps, and nothing in the browser should be able to mint one.
 *
 * Why the stamp is in the prompt BODY at all, quoted from that module because
 * it is the load-bearing constraint: *"The prompt is the only channel that
 * provably crosses the boundary"* — PreToolUse on `Agent` has a `tool_use_id`
 * and no `agent_id`; SubagentStop has an `agent_id` and no `tool_use_id`.
 *
 * @see .minsky/hooks/agent-dispatch-stamp.ts — the write half + the recording decision
 * @see src/cockpit/web/lib/turn-origin.ts — the render-side consumer (mt#4354)
 */

/** Stamp version marker. Bump ONLY on a breaking format change. */
export const DISPATCH_STAMP_VERSION = "minsky:dispatch:v1";

/**
 * Matches a stamp anywhere in a body of text.
 *
 * Deliberately tolerant of surrounding whitespace and of trailing content on
 * the line, because the text this runs against is a JSONL record's decoded
 * `content` field, not a line the writer controls end to end.
 *
 * NOT global-flagged: a global regex carries mutable `lastIndex` across
 * `.exec()` calls, and this module-level instance is shared by every turn a
 * render pass walks.
 */
const STAMP_PATTERN = new RegExp(
  `<!--\\s*${DISPATCH_STAMP_VERSION}\\s+parent=(\\S+)\\s+tool_use=(\\S+)\\s*-->`
);

/** The dispatch-side identity a stamp carries. */
export interface DispatchStamp {
  /** Harness conversation id of the dispatching (parent) agent. */
  parentAgentSessionId: string;
  /** Harness `tool_use` id of the `Agent` call that dispatched this. */
  parentToolUseId: string;
}

/**
 * Recover a stamp from arbitrary text (a prompt, or a child transcript record).
 *
 * Returns null when no stamp is present — the normal case for a subagent
 * dispatched before the stamp shipped, and for any prompt the guard did not
 * rewrite. Callers must render the no-stamp case rather than treating it as an
 * error: an unstamped dispatch is ordinary, not broken.
 */
export function parseDispatchStamp(text: string | undefined | null): DispatchStamp | null {
  if (!text) return null;
  const match = STAMP_PATTERN.exec(text);
  if (!match?.[1] || !match[2]) return null;
  return { parentAgentSessionId: match[1], parentToolUseId: match[2] };
}

/**
 * Both watermark comments Minsky appends to a generated prompt, as a matcher
 * for STRIPPING them from rendered prose (mt#4354).
 *
 * They are correlation metadata addressed to machines — an HTML comment
 * precisely so a model reads them as metadata rather than instruction — and
 * rendering them as body text is what made the principal notice the block was
 * mislabeled in the first place. The render path shows their CONTENT in the
 * header instead.
 *
 * `minsky:task-prompt:v1` is deliberately ABSENT. That watermark marks prompts
 * generated for a HUMAN to paste (`tasks decompose|estimate|analyze`), so a
 * turn carrying it is genuinely the operator speaking and nothing about it
 * should be stripped or relabeled.
 */
const PROMPT_MARKER_PATTERN = new RegExp(
  `[ \\t]*<!--\\s*(?:minsky:prompt:v1|${DISPATCH_STAMP_VERSION}[^>]*?)\\s*-->[ \\t]*\\n?`,
  "g"
);

/**
 * Remove Minsky's own prompt watermarks from text about to be rendered as prose.
 *
 * Returns the input unchanged when it carries none, so this is safe to call on
 * every turn.
 */
export function stripPromptMarkers(text: string): string {
  return text.replace(PROMPT_MARKER_PATTERN, "").trimEnd();
}
