/**
 * Conversation label precedence (mt#2770).
 *
 * Pure function isolating the label-precedence decision from the DB/task-
 * provider wiring in widgets/context-inspector.ts, so the precedence logic
 * itself is unit-testable without a mocked Drizzle chain.
 *
 * Precedence (per the mt#2770 spec):
 *   1. Bound task title (via `minsky_session_links` -> `sessions` -> task
 *      backend), when the link AND the title both resolve.
 *   2. First-SUBSTANTIVE-user-prompt snippet (markdown-stripped, harness-
 *      markup-stripped, ~60 chars). "First" is not always the literal
 *      earliest turn: a slash-command or hook-injected turn (e.g. a bare
 *      `<command-message>error-handling</command-message>`) is markup, not
 *      operator prose, so {@link pickSubstantiveUserText} (mt#2784) skips it
 *      in favor of the next user turn — bounded to the first
 *      {@link MAX_USER_TURN_CANDIDATES} turns so a long conversation's full
 *      turn history never drives this lookup's cost.
 *   3. Subagent dispatch descriptor (from `agent_spawns` / `subagent_invocations`),
 *      when resolvable.
 *   4. Existing timestamp·cwd fallback (unchanged from the mt#2023 baseline).
 *
 * Each tier is skipped (not just degraded) when its input is null/empty —
 * this is what makes the empty-`minsky_session_links` case (sparse until
 * mt#2441/mt#2756 land) fall through cleanly to tier 2/3/4 with no special
 * casing required at the call site.
 */
import { toDisplaySnippet } from "./text-snippet";

/** Max length for a first-user-prompt snippet label (tier 2). */
export const FIRST_PROMPT_SNIPPET_MAX_LEN = 60;

/** Max length for a task-title label (tier 1) — titles are usually short, but cap defensively. */
export const TASK_TITLE_MAX_LEN = 100;

/** Max length for a subagent-descriptor label (tier 3). */
export const SUBAGENT_DESCRIPTOR_MAX_LEN = 80;

/**
 * Bound on how many of a conversation's earliest user turns
 * {@link pickSubstantiveUserText} will inspect when the first turn turns out
 * to be markup-only (mt#2784). Deliberately small: this lookup runs inside
 * the run-list merge path (mt#2767 / PR #1910's latency fix), so it must stay
 * O(1) per conversation rather than scanning an unbounded turn history.
 */
export const MAX_USER_TURN_CANDIDATES = 5;

/**
 * Pick the first candidate user-turn text that is substantive after
 * harness-markup + markdown stripping (mt#2784), scanning at most the
 * earliest {@link MAX_USER_TURN_CANDIDATES} candidates. `candidates` must
 * already be ordered earliest-turn-first (callers own the turnIndex sort —
 * this function does not re-sort). Returns the RAW (un-stripped) winning
 * candidate — {@link computeConversationLabel}'s tier-2 branch re-derives the
 * display snippet via `toDisplaySnippet`, so this only decides WHICH turn's
 * text wins, not the finally-rendered string.
 *
 * Returns `null` when none of the scanned candidates are substantive (e.g.
 * the whole window is harness markup) — callers treat that exactly like an
 * absent first-user-text today, i.e. tier 2 is skipped and precedence falls
 * through to tier 3 (subagent descriptor) / tier 4 (timestamp·cwd fallback).
 */
export function pickSubstantiveUserText(candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates.slice(0, MAX_USER_TURN_CANDIDATES)) {
    if (candidate && toDisplaySnippet(candidate, FIRST_PROMPT_SNIPPET_MAX_LEN)) {
      return candidate;
    }
  }
  return null;
}

export interface ConversationLabelInputs {
  agentSessionId: string;
  cwd: string | null;
  startedAt: Date | null;

  /** Tier 1: resolved task title, only when BOTH the link and the title resolved. */
  linkedTaskTitle: string | null;

  /** Tier 2: raw first-user-turn text (un-stripped markdown), if any. */
  firstUserText: string | null;

  /** Tier 3: pre-composed subagent dispatch descriptor, if any (see composeSubagentDescriptor). */
  subagentDescriptor: string | null;
}

/**
 * Compose a tier-3 subagent descriptor from whatever structured fields
 * resolved. There is no free-text "dispatch description" column in either
 * `agent_spawns` or `subagent_invocations` today, so this composes the best
 * available proxy: `{agentType} — {taskTitle-or-taskId}` when a subagent
 * invocation resolved, else `{agentKind} subagent` when only the spawn edge
 * resolved, else null (falls through to tier 4).
 */
export function composeSubagentDescriptor(input: {
  /** `agentType` from subagent_invocations (e.g. "refactorer"), if a row resolved. */
  invocationAgentType: string | null;
  /** The subagent's own bound task id (display form, e.g. "mt#123"), if any. */
  invocationTaskId: string | null;
  /** Resolved title for `invocationTaskId`, if the task-title lookup succeeded. */
  invocationTaskTitle: string | null;
  /** `agentKind` from agent_spawns (e.g. "Explore"), if only the spawn edge resolved. */
  spawnAgentKind: string | null;
}): string | null {
  if (input.invocationAgentType) {
    const subject = input.invocationTaskTitle ?? input.invocationTaskId;
    return subject
      ? `${input.invocationAgentType} — ${subject}`
      : `${input.invocationAgentType} subagent`;
  }
  if (input.spawnAgentKind) {
    return `${input.spawnAgentKind} subagent`;
  }
  return null;
}

/** Tier-4 fallback label — mirrors the original mt#2023 `deriveLabel`. */
export function deriveFallbackLabel(
  agentSessionId: string,
  cwd: string | null,
  startedAt: Date | null
): string {
  const sessionPrefix = agentSessionId.slice(0, 8);
  const cwdSuffix = cwd
    ? cwd
        .replace(/\\/g, "/")
        .split("/")
        .filter((s) => s.length > 0)
        .slice(-2)
        .join("/") || cwd
    : "unknown";
  const ts = startedAt ? startedAt.toISOString().slice(0, 16).replace("T", " ") : "no-ts";
  return `${ts} · ${cwdSuffix} · ${sessionPrefix}`;
}

/** Compute the display label for a conversation row per the precedence above. */
export function computeConversationLabel(input: ConversationLabelInputs): string {
  if (input.linkedTaskTitle && input.linkedTaskTitle.trim().length > 0) {
    return toDisplaySnippet(input.linkedTaskTitle, TASK_TITLE_MAX_LEN) || input.linkedTaskTitle;
  }

  const snippet = toDisplaySnippet(input.firstUserText, FIRST_PROMPT_SNIPPET_MAX_LEN);
  if (snippet) return snippet;

  if (input.subagentDescriptor && input.subagentDescriptor.trim().length > 0) {
    return (
      toDisplaySnippet(input.subagentDescriptor, SUBAGENT_DESCRIPTOR_MAX_LEN) ||
      input.subagentDescriptor
    );
  }

  return deriveFallbackLabel(input.agentSessionId, input.cwd, input.startedAt);
}
