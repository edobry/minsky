/**
 * spawn-link-writer — populates `minsky_session_links` with `subagent_spawn`
 * links (mt#2756).
 *
 * Sibling of `session-link-writer.ts` (mt#2441's `cwd_match` writer): writes
 * to the SAME `minsky_session_links` table via the same PK/upsert convention
 * (no parallel table, no parallel consumer contract), just a different link
 * class, kept in its own file to keep both modules focused.
 *
 * A dispatched subagent's conversation is linked to the workspace session its
 * task was dispatched INTO, even though its `cwd` never changes — it stays at
 * the parent conversation's cwd (the main repo), per the mt#2749 finding that
 * subagents don't chdir into their assigned workspace. That's exactly why
 * `cwd_match` yields low for this fleet shape; this module is the high-yield
 * complement.
 *
 * The signal is the spawn PROMPT text itself: `session_generate_prompt`
 * (`packages/domain/src/session/prompt-generation.ts`'s `renderCommonHeader`)
 * always embeds the literal absolute workspace directory in its opening line
 * ("You are working in Minsky session at `<sessionDir>`."), and that prompt
 * text is preserved verbatim as the `input.prompt` field on the Agent tool
 * call captured in the PARENT's own `tool_calls` JSONB. `AgentSpawnsPipeline`
 * (mt#1327, `agent-spawns-pipeline.ts`) already loads that JSONB and resolves
 * the spawn's `childAgentSessionId` — it calls {@link writeSpawnLink} for
 * each resolved spawn so no parallel writer or extra query is needed.
 *
 * No FK to the sessions table by design (mirrors mt#2441 SC4 for `cwd_match`):
 * the link is a computed relationship recorded at extraction time, not a live
 * reference.
 *
 * @see mt#1313 / mt#1324 — minsky_session_links schema
 * @see mt#1919 — the read-time cwd LIKE consumer this table replaces
 * @see mt#2749 — the low cwd_match / high subagent_spawn yield finding
 * @see mt#2441 / session-link-writer.ts — the sibling `cwd_match` link class
 * @see agent-spawns-pipeline.ts — the caller that resolves childAgentSessionId
 *   and drives {@link writeSpawnLink}
 * @see mt#2756 — this file
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { getSessionsDir } from "@minsky/shared/paths";
import { log } from "@minsky/shared/logger";
import { agentTranscriptTurnsTable } from "../storage/schemas/agent-transcript-turns-schema";
import { agentSpawnsTable } from "../storage/schemas/agent-spawns-schema";
import { minskySessionLinksTable } from "../storage/schemas/minsky-session-links-schema";
import { getErrorMessage } from "../errors/index";
import { findAgentToolCall } from "./agent-tool-call-shape";

/** Link-type value written by this module (mt#1313's `subagent_spawn` class). */
export const SUBAGENT_SPAWN_LINK_TYPE = "subagent_spawn";

/**
 * Confidence assigned to a spawn link. The extraction is deterministic (the
 * prompt text either embeds the exact `<stateDir>/sessions/<id>` path
 * `session_generate_prompt` writes, or it doesn't) — there is no partial-match
 * tier the way `cwd_match` has exact-vs-descendant, so every written spawn
 * link gets the same confidence.
 */
export const SUBAGENT_SPAWN_CONFIDENCE = 1.0;

/**
 * Escape every regex metacharacter in a literal string so it can be embedded
 * verbatim inside a dynamically-constructed `RegExp` pattern. This is the
 * standard MDN-documented `escapeRegExp` form
 * (developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions) —
 * named and isolated here (rather than inlined) so a reader doesn't have to
 * re-derive that the character class covers every metacharacter, including
 * `[` and `]` (see the `escapes regex special characters` test cases in
 * spawn-link-writer.test.ts for explicit `[`/`]` coverage).
 */
function escapeRegExpLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Extract the Minsky workspace session id embedded in a subagent dispatch
 * prompt (the text passed as the Agent tool call's `input.prompt`).
 *
 * `session_generate_prompt`'s `renderCommonHeader`
 * (`packages/domain/src/session/prompt-generation.ts`) always emits the
 * literal absolute workspace directory as the first line of every generated
 * prompt: `"You are working in Minsky session at <sessionDir>."` where
 * `<sessionDir>` is always `<stateDir>/sessions/<id>` — the same root
 * `detectCwdMatch` (session-link-writer.ts) matches against `cwd`. Searching
 * the free-form prompt text for that root and capturing the id segment that
 * follows recovers the Minsky session id without any DB round trip back to
 * the child's own transcript (which never carries this cwd — that's the
 * whole reason `cwd_match` misses dispatched subagents, mt#2749).
 *
 * Returns `null` when the prompt text does not contain the sessionsDir
 * prefix — a hand-crafted prompt, a non-Minsky dispatch, or a harness that
 * doesn't preserve prompt text in `tool_calls` JSON. That's a missed link,
 * not an error.
 */
export function extractMinskySessionIdFromPrompt(
  prompt: string | null | undefined,
  sessionsDir: string = getSessionsDir()
): string | null {
  if (!prompt || typeof prompt !== "string") return null;

  const normalizedRoot = sessionsDir.endsWith("/") ? sessionsDir.slice(0, -1) : sessionsDir;
  const escapedRoot = escapeRegExpLiteral(normalizedRoot);
  const match = prompt.match(new RegExp(`${escapedRoot}/([A-Za-z0-9-]+)`));
  return match?.[1] || null;
}

/**
 * Discriminated outcome of {@link writeSpawnLink} (mt#2756 R1 — replaces a
 * collapsing `boolean` return). A caller that only sees `false` cannot tell
 * WHY the link wasn't written: "there's no child conversation to link at
 * all" (`no-child`), "the child exists but its dispatch prompt wasn't
 * Minsky-shaped" (`no-prompt-match`), and "the DB write itself failed"
 * (`error`) are three distinct, actionable causes with different operator
 * responses — conflating them into one boolean was the exact ambiguity a
 * reviewer flagged (a low count could mean "children rarely resolve" OR
 * "prompts rarely match" OR "writes are failing," indistinguishably).
 */
export type WriteSpawnLinkOutcome = "written" | "no-child" | "no-prompt-match" | "error";

/**
 * Write the `subagent_spawn` link for one resolved `agent_spawns` row, given
 * the child's `agentSessionId` and the raw prompt text passed to the parent's
 * Agent tool call.
 *
 * No-ops (no DB call at all) when `childAgentSessionId` is absent (the spawn
 * hasn't been linked to a child transcript yet — a later sweep may resolve
 * it) or the prompt does not embed a Minsky session directory (non-Minsky
 * dispatch, or a hand-crafted prompt) — see {@link WriteSpawnLinkOutcome} for
 * how callers should distinguish these cases.
 *
 * Idempotent: the table's primary key is `(agent_session_id,
 * minsky_session_id)`, so re-running this (e.g. on every
 * `transcripts.spawns-extract` sweep) over an already-linked pair is a safe
 * no-op via `ON CONFLICT DO NOTHING` — the `"written"` outcome covers BOTH a
 * fresh insert and an already-linked pair, since the row's presence (not
 * whether THIS call physically inserted it) is what the caller cares about.
 *
 * Never throws — a DB failure is logged and swallowed so link-writing can
 * never block the spawn-extraction pass it rides alongside, matching
 * `writeCwdMatchLink`'s error-swallowing convention (session-link-writer.ts).
 */
export async function writeSpawnLink(
  db: PostgresJsDatabase,
  childAgentSessionId: string | null | undefined,
  prompt: unknown,
  sessionsDir?: string
): Promise<WriteSpawnLinkOutcome> {
  if (!childAgentSessionId) return "no-child";

  const promptText = typeof prompt === "string" ? prompt : null;
  const minskySessionId = extractMinskySessionIdFromPrompt(
    promptText,
    sessionsDir ?? getSessionsDir()
  );
  if (!minskySessionId) return "no-prompt-match";

  try {
    await db
      .insert(minskySessionLinksTable)
      .values({
        agentSessionId: childAgentSessionId,
        minskySessionId,
        linkType: SUBAGENT_SPAWN_LINK_TYPE,
        confidence: SUBAGENT_SPAWN_CONFIDENCE,
      })
      .onConflictDoNothing();
    return "written";
  } catch (err) {
    log.warn(`writeSpawnLink: failed to upsert link for session ${childAgentSessionId}`, {
      error: getErrorMessage(err),
      minskySessionId,
    });
    return "error";
  }
}

/**
 * Extract the `input.prompt` text from the first Agent tool call in a
 * `tool_calls` JSONB array, or `null` if none is found. Uses the shared
 * {@link findAgentToolCall} (agent-tool-call-shape.ts) — the SAME finder
 * `AgentSpawnsPipeline` uses — so the two `tool_calls`-JSONB parsers can't
 * drift apart (mt#2756 R1).
 */
function extractAgentPromptFromToolCalls(toolCalls: unknown): string | null {
  const agentCall = findAgentToolCall(toolCalls);
  if (!agentCall) return null;
  const prompt = agentCall.input?.["prompt"];
  return typeof prompt === "string" ? prompt : null;
}

export interface BackfillSpawnLinksResult {
  spawnsScanned: number;
  linksWritten: number;
  linksSkippedNoMatch: number;
  linksErrored: number;
}

/**
 * Backfill sweep: walk every already-extracted `agent_spawns` row (joined
 * back to the parent's `agent_transcript_turns` row for the prompt text) and
 * write its `subagent_spawn` link. Idempotent — safe to re-run; already-linked
 * pairs are no-ops via `ON CONFLICT DO NOTHING` inside {@link writeSpawnLink}.
 *
 * Mirrors `backfillCwdMatchLinks`'s pattern (session-link-writer.ts) for the
 * `subagent_spawn` class: `AgentSpawnsPipeline` writes the link inline for
 * every FUTURE spawn extraction (mt#2756), but rows extracted before that
 * wiring shipped need this one-time sweep.
 */
export async function backfillSpawnLinks(
  db: PostgresJsDatabase,
  sessionsDir?: string
): Promise<BackfillSpawnLinksResult> {
  const result: BackfillSpawnLinksResult = {
    spawnsScanned: 0,
    linksWritten: 0,
    linksSkippedNoMatch: 0,
    linksErrored: 0,
  };

  let rows: Array<{ childAgentSessionId: string | null; toolCalls: unknown }>;
  try {
    const { eq, and } = await import("drizzle-orm");
    rows = await db
      .select({
        childAgentSessionId: agentSpawnsTable.childAgentSessionId,
        toolCalls: agentTranscriptTurnsTable.toolCalls,
      })
      .from(agentSpawnsTable)
      .innerJoin(
        agentTranscriptTurnsTable,
        and(
          eq(agentSpawnsTable.parentAgentSessionId, agentTranscriptTurnsTable.agentSessionId),
          eq(agentSpawnsTable.parentTurnIndex, agentTranscriptTurnsTable.turnIndex)
        )
      );
  } catch (err) {
    log.error("backfillSpawnLinks: failed to load agent_spawns rows", {
      error: getErrorMessage(err),
    });
    return result;
  }

  result.spawnsScanned = rows.length;
  const resolvedSessionsDir = sessionsDir ?? getSessionsDir();

  for (const row of rows) {
    if (!row.childAgentSessionId) {
      result.linksSkippedNoMatch++;
      continue;
    }
    const prompt = extractAgentPromptFromToolCalls(row.toolCalls);
    try {
      // writeSpawnLink already re-derives minskySessionId internally and
      // reports "no-prompt-match" when it can't — no need to duplicate that
      // check here (mt#2756 R1: single source of truth for the resolution
      // logic, not two call sites that could drift).
      const outcome = await writeSpawnLink(
        db,
        row.childAgentSessionId,
        prompt,
        resolvedSessionsDir
      );
      if (outcome === "written") {
        result.linksWritten++;
      } else if (outcome === "error") {
        result.linksErrored++;
      } else {
        // "no-prompt-match" — childAgentSessionId is already guaranteed
        // present here (checked above), so "no-child" cannot occur.
        result.linksSkippedNoMatch++;
      }
    } catch (err) {
      result.linksErrored++;
      log.warn(`backfillSpawnLinks: failed for ${row.childAgentSessionId}`, {
        error: getErrorMessage(err),
      });
    }
  }

  log.info("backfillSpawnLinks: complete", { ...result });
  return result;
}
