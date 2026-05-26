/**
 * Hook-script preamble matcher.
 *
 * Claude Code's JSONL transcripts record hook injections as `attachment` lines
 * with `attachment.type === "hook_additional_context"`. The recorded
 * `attachment.hookName` field carries the *hook event* (e.g.,
 * `"UserPromptSubmit"`) — not the specific hook script that fired (e.g.,
 * `memory-search.ts` vs `skill-staleness-detector.ts`). Two distinct hooks can
 * fire on the same event class.
 *
 * Each in-tree hook script emits a stable content preamble inside its injected
 * `additionalContext`. This file maps preamble fingerprints back to script
 * names so the ingest pipeline can populate `agent_transcript_attachments.hookName`
 * with the specific script that produced each injection.
 *
 * When a new hook is added that emits `additionalContext` on `UserPromptSubmit`
 * (or any other context-injecting event), append its preamble fingerprint here.
 *
 * @see mt#2022 — substrate extension; this matcher
 * @see `.claude/hooks/memory-search.ts:338` — memory-search preamble source
 * @see `.claude/hooks/skill-staleness-detector.ts` — staleness preamble source
 */

/** A preamble match rule: identify the source hook from a content fragment. */
export interface HookPreambleRule {
  /** Hook script filename (basename, e.g., `"memory-search.ts"`). */
  scriptName: string;

  /** Hook event the script fires on (e.g., `"UserPromptSubmit"`). */
  hookEvent: string;

  /**
   * Required substring(s) within the injected content. ALL must appear for the
   * rule to match. Order-independent. Use distinctive phrases — short ones risk
   * false positives across hooks that share boilerplate.
   */
  contentMustInclude: readonly string[];
}

/**
 * Static index of in-tree hook scripts and their preamble fingerprints. Order
 * matters only for tie-breaking: the first matching rule wins.
 *
 * Each rule's `contentMustInclude` should pick the longest stable phrase the
 * hook reliably emits — typically the first line or two of its
 * `additionalContext` block.
 */
export const HOOK_PREAMBLE_RULES: readonly HookPreambleRule[] = [
  {
    scriptName: "memory-search.ts",
    hookEvent: "UserPromptSubmit",
    contentMustInclude: [
      "The following memory records may be relevant to your task",
      "retrieved from your persistent memory store",
    ],
  },
  {
    scriptName: "skill-staleness-detector.ts",
    hookEvent: "UserPromptSubmit",
    contentMustInclude: ["skill/agent/rule file", "since this session started"],
  },
] as const;

/**
 * Resolve a `hook_additional_context` attachment to its specific hook-script
 * name by content-preamble matching.
 *
 * @param hookEvent - The `attachment.hookName` field from the JSONL line
 *                    (despite the field name, this is the hook EVENT — e.g.,
 *                    `"UserPromptSubmit"` — not the script name).
 * @param content - The injected content string (typically the value of
 *                  `attachment.content` joined or the first element of the
 *                  attachment's `content` array). The matcher checks substring
 *                  presence against `HOOK_PREAMBLE_RULES`.
 * @returns The matching hook script's basename (e.g., `"memory-search.ts"`),
 *          or `null` if no rule's `contentMustInclude` phrases all appear OR
 *          if the hookEvent doesn't match any rule's `hookEvent`.
 */
export function matchHookScript(hookEvent: string, content: string): string | null {
  if (typeof hookEvent !== "string" || typeof content !== "string") return null;

  for (const rule of HOOK_PREAMBLE_RULES) {
    if (rule.hookEvent !== hookEvent) continue;
    const allPresent = rule.contentMustInclude.every((phrase) => content.includes(phrase));
    if (allPresent) return rule.scriptName;
  }

  return null;
}

/**
 * Helper: pull a string content payload out of a raw JSONL attachment line's
 * `content` field. Claude Code records `attachment.content` either as an array
 * of strings (joined for matching) or as a single string. Other shapes return
 * an empty string so callers can short-circuit cleanly.
 */
export function extractAttachmentContentString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((part): part is string => typeof part === "string").join("\n");
  }
  return "";
}
