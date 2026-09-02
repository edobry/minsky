/**
 * Transcript Get Command
 *
 * Registers the `transcripts.get` MCP tool and
 * `minsky transcripts get` CLI command.
 *
 * Returns all turns for an agent session in turn_index order, optionally
 * sliced to a turn range. Delegates to TranscriptFtsService.getSession.
 *
 * Args:
 *   sessionId      Required. The agent session UUID.
 *   turnRange      Optional. Inclusive index range in "start-end" format (e.g. "10-20").
 *   role           Optional (mt#2818). Filter to turns by role: 'user' or 'assistant'.
 *   projection     Optional (mt#2818). 'full' (default) returns the structured
 *                  TranscriptTurnResult[] shape; 'text' returns a lean array of
 *                  { turnIndex, role, text, injected, userOrigin? } — see the projection
 *                  section below. `userOrigin` is present on USER entries only (mt#4072).
 *
 * DI pattern mirrors search-command.ts: persistence provider resolved from
 * `context.container` at execute time (not at registration time).
 *
 * ## Text projection (mt#2818)
 *
 * `projection: "text"` strips the response to just the role/text pairs a bulk
 * extraction workflow needs (the exact pattern the 2026-07-15 gap-analysis
 * session's 11 subagents reached for via disk `jq` instead). Tool-call
 * payloads are ALREADY excluded from `userText`/`assistantText` by
 * construction (`turn-extractor.ts`'s `extractUserText`/`extractAssistantText`
 * only join `text`-type content blocks — `tool_use`/`tool_result` blocks never
 * enter these columns), so no additional stripping is needed for that class.
 *
 * The remaining noise class is harness-injected TEXT markup embedded inside a
 * `text` block — slash-command wrappers (`<command-message>`), hook output
 * (`<local-command-stdout>`), and injected `<system-reminder>` blocks. This
 * projection reuses `stripHarnessMarkup` (mt#2784, lifted to
 * `packages/domain/src/transcripts/text-snippet.ts` by mt#2818) to detect
 * and strip those specific tags:
 *
 *   - A turn's text that is ENTIRELY markup (nothing left after stripping) is
 *     EXCLUDED from the projected output.
 *   - A turn's text that MIXES real content with markup is INCLUDED with the
 *     markup stripped and `injected: true`, so a caller can filter further if
 *     it wants pure-clean-only.
 *   - A turn with no markup detected is included verbatim with `injected: false`.
 *
 * **Heuristic limits** (documented per mt#2818's requirement, not a general
 * claim of completeness): this is a fixed marker-tag allowlist, not a general
 * parser. A harness-injected wrapper using a tag name outside that list is NOT
 * detected and will pass through unflagged. The list itself is
 * `HARNESS_MARKUP_TAGS` in `@minsky/shared/harness-markup` — read it there
 * rather than from a copy here. This docblock used to enumerate four tags by
 * hand and had already fallen two behind (`local-command-caveat`,
 * `task-notification`) before mt#4058 added the bash-mode family; the shared
 * inventory exists precisely to end that drift, and a fourth copy of the list
 * would reintroduce it.
 * It is also a regex match, not a real XML/HTML parser, so pathological
 * malformed/nested tags could mismatch. See `stripHarnessMarkup`'s own
 * docblock for the exact tag list and matching rules.
 *
 * @see mt#1355 — this file
 * @see mt#1352 — agent_transcript_turns schema
 * @see mt#1313 §Search tools — transcripts.get
 * @see mt#2818 — role + projection params, text-projection heuristic
 * @see mt#2784 — stripHarnessMarkup (reused here, not re-derived)
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory } from "../../command-registry";
import type { SharedCommandRegistry } from "../../command-registry";
import { log } from "@minsky/shared/logger";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import type { TranscriptTurnResult } from "@minsky/domain/transcripts/transcript-fts-service";
import type { AgentSessionId } from "@minsky/domain/transcripts/transcript-source";
import {
  conversationIdParam,
  deprecatedConversationAlias,
  resolveConversationId,
} from "./conversation-id-param";
// mt#2818: reuse the mt#2784 harness-markup heuristic rather than re-deriving
// it — both call sites (this projection and mt#2770's label snippets) must
// agree on what counts as injected markup. Imported from the domain layer
// (not `src/cockpit/`) so the command layer never depends on the cockpit app
// layer — the module was lifted there specifically so both sides could share
// it without that dependency direction.
import { stripHarnessMarkup } from "@minsky/domain/transcripts/text-snippet";
// mt#4072 — Minsky's own prompt watermarks, which `stripHarnessMarkup` cannot
// see because they are HTML comments rather than tags.
import { stripPromptMarkers } from "@minsky/shared/dispatch-stamp";

// ── Text projection types ────────────────────────────────────────────────────

export type TranscriptTurnRole = "user" | "assistant";

/** One text-projected turn entry (mt#2818, `projection: "text"`). */
export interface TranscriptTextProjectionEntry {
  turnIndex: number;
  role: TranscriptTurnRole;
  /** Cleaned text — harness-markup blocks stripped when `injected` is true. */
  text: string;
  /**
   * True when the raw stored text contained detectable harness-injected
   * markup (see the module docblock's "Heuristic limits" section) that was
   * stripped to produce `text`.
   *
   * **Deliberately NOT set for Minsky's own prompt watermarks (mt#4072).** Those
   * are stripped from `text` too, but they are not harness markup — Minsky
   * writes them — and overloading this flag would make it mean two different
   * things. Read {@link userOrigin} for that question. This mirrors mt#4354's
   * choice on the render surface, which added an author class rather than
   * reusing an existing flag for the same third category.
   */
  injected: boolean;
  /**
   * Who authored a `user` entry's text (mt#4072), passed through from
   * `agent_transcript_turns.user_origin` — the column mt#4289 writes with
   * `classifyUserLineOrigin`. Absent on assistant entries.
   *
   * This is the field that stops a Minsky-generated dispatch prompt reading as
   * the operator's own words. Measured 2026-09-02: 283 turns in the local
   * corpus carry Minsky's prompt watermark, 94 of them in 2026-08 alone, and
   * every one came out of this projection flagged `injected: false` with the
   * watermarks intact — i.e. presented as operator prose.
   *
   * **`"human"` is the classifier's FAIL-OPEN default, not positive evidence of
   * operator authorship** — it is what a line with no structural marker gets.
   * Only a NON-`human` value carries information, the same caveat the snapshot
   * block's `userOrigin` docblock states.
   *
   * Read from the COLUMN rather than recomputed, unlike the render surface,
   * which computes because its live-tail path has no row yet (mt#2232). This
   * projection reads from the DB by construction, so the column is always there
   * and re-deriving would be a second call site of one classifier for no gain.
   */
  userOrigin?: string;
}

/**
 * Project a set of full turn rows down to role/text pairs, applying the
 * mt#2818 injected-markup heuristic. `role` narrows which side(s) of each
 * turn are projected: omitted means both userText and assistantText (when
 * present) each become their own entry.
 */
export function projectTurnsToText(
  turns: Pick<TranscriptTurnResult, "turnIndex" | "userText" | "assistantText" | "userOrigin">[],
  role?: TranscriptTurnRole
): TranscriptTextProjectionEntry[] {
  const entries: TranscriptTextProjectionEntry[] = [];
  for (const turn of turns) {
    const candidates: { role: TranscriptTurnRole; raw: string | null }[] = [];
    if (!role || role === "user") candidates.push({ role: "user", raw: turn.userText });
    if (!role || role === "assistant")
      candidates.push({ role: "assistant", raw: turn.assistantText });

    for (const candidate of candidates) {
      if (!candidate.raw) continue;
      const stripped = stripHarnessMarkup(candidate.raw);
      const injected = stripped !== candidate.raw;
      // mt#4072: `stripHarnessMarkup` strips harness TAGS. Minsky's own prompt
      // watermarks are HTML COMMENTS, so it does not touch them and a generated
      // dispatch prompt left this projection with both markers intact. Applied
      // AFTER, and NOT folded into `injected`, because the two answer different
      // questions — see that field's docblock. `stripPromptMarkers` returns its
      // input unchanged when there is nothing to strip, and deliberately spares
      // `minsky:task-prompt:v1`, which marks a prompt generated for a HUMAN to
      // paste and is therefore genuinely the operator speaking.
      //
      // USER role ONLY (PR #3589 R1, BLOCKING). Minsky writes these watermarks
      // into PROMPTS, which are user turns — so the assistant side has nothing
      // to gain and something to lose: an assistant that QUOTES a watermark
      // while explaining the dispatch format would have the quote silently
      // deleted from its own words. Stripping only where the marker can
      // legitimately occur keeps that from being possible at all.
      const text = (candidate.role === "user" ? stripPromptMarkers(stripped) : stripped).trim();
      if (text.length === 0) continue; // entirely injected markup — excluded
      entries.push({
        turnIndex: turn.turnIndex,
        role: candidate.role,
        text,
        injected,
        ...(candidate.role === "user" && turn.userOrigin ? { userOrigin: turn.userOrigin } : {}),
      });
    }
  }
  return entries;
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Register the `transcripts.get` shared command.
 *
 * @param _container Optional DI container (resolved at execute time).
 * @param registry   Defaults to global sharedCommandRegistry. Pass a fresh
 *                   registry in tests to avoid global state mutation.
 */
export function registerTranscriptGetCommand(
  _container?: AppContainerInterface,
  registry?: SharedCommandRegistry
): void {
  const targetRegistry = registry ?? sharedCommandRegistry;

  targetRegistry.registerCommand({
    id: "transcripts.get",
    category: CommandCategory.TRANSCRIPTS,
    name: "get",
    description:
      "Return all turns for a harness conversation in turn_index order. " +
      "Optionally slice to a turn range using the turnRange parameter (format: 'start-end', e.g. '10-20'). " +
      "Optionally filter to a role ('user' or 'assistant', mt#2818) and/or request a lean " +
      "text-only projection (projection: 'text') that excludes tool-call payloads (already " +
      "excluded from userText/assistantText by construction) and strips/flags detectable " +
      "harness-injected markup (system-reminder / command wrappers — heuristic, see docs). " +
      "On USER entries it additionally strips Minsky's own prompt watermarks and reports " +
      "`userOrigin`, so a generated dispatch prompt is not returned as operator prose " +
      "(mt#4072); the human-paste watermark is deliberately left in place. " +
      "Throws if the conversation is not found. " +
      "Coverage: conversations are auto-ingested on MCP server boot; " +
      "if a conversation is missing, run `transcripts_ingest --all` to force a full sweep.",
    parameters: {
      // NOTE (mt#2526): the conversation id is REQUIRED, but enforced at execute time
      // (resolveConversationId below) rather than via the schema `required` flag — so the
      // deprecated `sessionId` alias still satisfies it. Schema/MCP consumers should NOT
      // read `required: false` as "optional": exactly one of conversationId / sessionId
      // must be supplied (the execute path throws otherwise).
      conversationId: conversationIdParam(
        "The harness conversation id (agent-session UUID) to retrieve turns for"
      ),
      sessionId: deprecatedConversationAlias("sessionId"),
      turnRange: {
        schema: z
          .string()
          .regex(/^\d+-\d+$/, "turnRange must be in 'start-end' format, e.g. '10-20'"),
        description:
          "Inclusive turn index range in 'start-end' format (e.g. '10-20'). " +
          "Returns only turns with turn_index between start and end (inclusive).",
        required: false,
      },
      role: {
        schema: z.enum(["user", "assistant"]),
        description:
          "Filter to turns by role: 'user' returns only turns with a non-null userText; " +
          "'assistant' returns only turns with a non-null assistantText.",
        required: false,
      },
      projection: {
        schema: z.enum(["full", "text"]),
        description:
          "'full' (default) returns the structured TranscriptTurnResult[] shape " +
          "(session metadata, timestamps, spawn-boundary flag). 'text' returns a lean " +
          "{ turnIndex, role, text, injected, userOrigin? }[] — see the command description " +
          "for the injected-markup heuristic and its documented limits. `userOrigin` is " +
          "present on USER entries only and names who authored the text (mt#4072); " +
          "'human' is a fail-open default, so only a non-'human' value carries information.",
        required: false,
        defaultValue: "full",
      },
    },

    async execute(
      params,
      context
    ): Promise<TranscriptTurnResult[] | TranscriptTextProjectionEntry[]> {
      const sessionId = resolveConversationId(params);
      if (!sessionId) {
        throw new Error(
          "transcripts.get requires conversationId (or its deprecated alias sessionId)."
        );
      }
      const turnRangeStr = params.turnRange as string | undefined;
      const role = params.role as TranscriptTurnRole | undefined;
      const projection = (params.projection as "full" | "text" | undefined) ?? "full";

      // ── Parse turnRange string into { start, end } ────────────────────────
      let turnRange: { start: number; end: number } | undefined;
      if (turnRangeStr) {
        const parts = turnRangeStr.split("-");
        const start = parseInt(parts[0] ?? "", 10);
        const end = parseInt(parts[1] ?? "", 10);
        if (!isNaN(start) && !isNaN(end)) {
          turnRange = { start, end };
        } else {
          throw new Error(
            `Invalid turnRange format: '${turnRangeStr}'. ` +
              "Expected 'start-end' with integer values, e.g. '10-20'."
          );
        }
      }

      // ── Resolve DB from DI container ─────────────────────────────────────
      const persistenceProvider = (() => {
        if (context.container?.has("persistence")) {
          return context.container.get(
            "persistence"
          ) as import("@minsky/domain/persistence/types").SqlCapablePersistenceProvider;
        }
        return null;
      })();

      if (!persistenceProvider) {
        throw new Error(
          "DI container missing 'persistence'. " +
            "Ensure the container was initialized before running this command."
        );
      }

      const db = await persistenceProvider.getDatabaseConnection();
      if (!db) {
        throw new Error(
          "getDatabaseConnection() returned null. " +
            "transcripts.get requires a PostgreSQL backend with Drizzle ORM."
        );
      }

      // ── Construct service and fetch session ──────────────────────────────
      const { TranscriptFtsService } = await import(
        "@minsky/domain/transcripts/transcript-fts-service"
      );
      const svc = new TranscriptFtsService(
        db as import("drizzle-orm/postgres-js").PostgresJsDatabase
      );

      const results = await svc.getSession(sessionId as AgentSessionId, { turnRange, role });

      if (projection === "text") {
        const projected = projectTurnsToText(results, role);
        log.debug("transcripts.get complete", {
          sessionId,
          resultCount: results.length,
          projectedCount: projected.length,
          projection,
        });
        return projected;
      }

      log.debug("transcripts.get complete", { sessionId, resultCount: results.length });

      return results;
    },
  });

  log.debug("Transcript get command registered");
}
