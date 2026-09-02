/**
 * Transcript Search-Text Command
 *
 * Registers the `transcripts.search-text` MCP tool and
 * `minsky transcripts search-text` CLI command.
 *
 * Performs full-text search over agent transcript turns using Postgres FTS
 * (plainto_tsquery against the fts_text GENERATED column on agent_transcript_turns).
 *
 * Unlike `transcripts.search` (embedding-based), this command uses FTS and does
 * NOT require an EmbeddingService. It is suitable for keyword/phrase queries where
 * exact token matches are preferred over semantic similarity.
 *
 * Args:
 *   query          Required. The natural-language search query.
 *   limit          Optional. Max results to return (default 10).
 *   role           Optional. Filter to 'user' or 'assistant' turns.
 *   originKind     Optional. Filter by who authored the user text ('human' for
 *                  operator speech only). A separate axis from `role` (mt#4289).
 *   from           Optional. ISO date string — include only turns whose own timestamp is on/after this date.
 *   to             Optional. ISO date string — include only turns whose own timestamp is on/before this date.
 *   session        Optional. Restrict results to a single agent session UUID.
 *
 * DI pattern mirrors search-command.ts: persistence provider resolved from
 * `context.container` at execute time (not at registration time).
 *
 * @see mt#1355 — this file
 * @see mt#1352 — agent_transcript_turns fts_text GENERATED column
 * @see mt#1313 §Search tools — transcripts.search-text
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory } from "../../command-registry";
import type { SharedCommandRegistry } from "../../command-registry";
import {
  conversationIdParam,
  deprecatedConversationAlias,
  resolveConversationId,
} from "./conversation-id-param";
import { log } from "@minsky/shared/logger";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import {
  assessWindowCoverage,
  buildSearchResponse,
  type TranscriptSearchCommandResponse,
} from "@minsky/domain/transcripts/transcript-search-filters";
import {
  DEFAULT_FTS_SEARCH_MODE,
  parseSearchMode,
} from "@minsky/domain/transcripts/transcript-fts-search-query";
import {
  parseSearchProjection,
  projectTurnResults,
} from "@minsky/domain/transcripts/transcript-search-projection";
import { resolveTranscriptProjectScope } from "./resolve-transcript-project-scope";
import { projectionParam, PROJECTION_TOOL_DESCRIPTION_SUFFIX } from "./projection-param";

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Register the `transcripts.search-text` shared command.
 *
 * @param _container Optional DI container (resolved at execute time).
 * @param registry   Defaults to global sharedCommandRegistry. Pass a fresh
 *                   registry in tests to avoid global state mutation.
 */
export function registerTranscriptSearchTextCommand(
  _container?: AppContainerInterface,
  registry?: SharedCommandRegistry
): void {
  const targetRegistry = registry ?? sharedCommandRegistry;

  targetRegistry.registerCommand({
    id: "transcripts.search-text",
    category: CommandCategory.TRANSCRIPTS,
    name: "search-text",
    description:
      `Search agent transcript turns by full-text search (FTS) against the fts_text column. ` +
      `Set mode to control matching: "websearch" (default) supports "quoted phrases" (matched by ` +
      `adjacency), or, and -negation; "plain" ANDs the words with no adjacency; "exact" matches a ` +
      `literal substring with no stemming, for identifiers and punctuation-bearing strings. ` +
      `Results are ranked by ts_rank (higher = more relevant), except in exact mode which orders by ` +
      `recency. Each result carries a \`snippet\` — a bounded excerpt with matched spans in [brackets] — ` +
      `so a hit can be read without pulling the whole turn. ${
        PROJECTION_TOOL_DESCRIPTION_SUFFIX
      }Optionally filter by role (user/assistant), date range, or session UUID. ` +
      `Scoped to the current project by default; pass allProjects to search every project. ` +
      `Date filters bind the turn's own timestamp, so turns from long-running ` +
      `sessions are matched by when the turn happened, not when the session started. ` +
      `Returns { results, coverage }: when a date window contains sessions not yet ` +
      `indexed into searchable turns, \`coverage\` reports the gap instead of a silent ` +
      `empty result (those turns become searchable after \`transcripts index-embeddings\`).`,
    parameters: {
      query: {
        schema: z.string(),
        description:
          "Natural-language search query for full-text matching against transcript turns",
        required: true,
      },
      limit: {
        schema: z.number().int().positive(),
        description: "Maximum number of results to return (default 10)",
        required: false,
        defaultValue: 10,
      },
      role: {
        schema: z.enum(["user", "assistant"]),
        description: "Filter to turns by role: 'user' or 'assistant'",
        required: false,
      },
      originKind: {
        schema: z.string(),
        description:
          "Filter by who authored the turn's user text: 'human' for operator speech only, or a " +
          "harness kind ('compact_summary', 'harness_meta', 'task_notification', 'peer', 'sdk'). " +
          'NOT the same axis as `role`: `role: "user"` only means the turn HAS user text, and ' +
          "43.5% of such turns are harness-written (mt#4289). Each result carries `userOrigin`.",
        required: false,
      },
      from: {
        schema: z.string(),
        description:
          "ISO date string — include only turns whose own timestamp is on/after this date",
        required: false,
      },
      to: {
        schema: z.string(),
        description:
          "ISO date string — include only turns whose own timestamp is on/before this date",
        required: false,
      },
      conversationId: conversationIdParam(
        "Restrict results to a single harness conversation by its id (agent-session UUID)"
      ),
      session: deprecatedConversationAlias("session"),
      mode: {
        schema: z.enum(["websearch", "plain", "exact"]),
        description:
          "How the query is matched. 'websearch' (default) supports \"quoted phrases\", or, and -negation; " +
          "'plain' ANDs the words with no adjacency; 'exact' matches a literal substring without stemming.",
        required: false,
        defaultValue: DEFAULT_FTS_SEARCH_MODE,
      },
      allProjects: {
        schema: z.boolean(),
        description:
          "Return results across all projects (default: scoped to the resolved current project, mt#2417)",
        required: false,
        defaultValue: false,
      },
      projection: projectionParam(),
    },

    async execute(params, context): Promise<TranscriptSearchCommandResponse> {
      const query = params.query as string;
      const limit = (params.limit as number | undefined) ?? 10;
      const projection = parseSearchProjection(params.projection);
      const role = params.role as "user" | "assistant" | undefined;
      const originKind = params.originKind as string | undefined;
      const from = params.from as string | undefined;
      const to = params.to as string | undefined;
      const sessionId = resolveConversationId(params);
      const mode = parseSearchMode(params.mode);
      const allProjects = params.allProjects as boolean | undefined;

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
            "transcripts.search-text requires a PostgreSQL backend with Drizzle ORM."
        );
      }

      // ── Construct service and search ─────────────────────────────────────
      // FTS search does not need EmbeddingService — skip that part of the pattern.
      const { TranscriptFtsService } = await import(
        "@minsky/domain/transcripts/transcript-fts-service"
      );
      const svc = new TranscriptFtsService(
        db as import("drizzle-orm/postgres-js").PostgresJsDatabase
      );

      const dateRange: { from?: Date; to?: Date } = {};
      if (from) {
        dateRange.from = new Date(from);
      }
      if (to) {
        dateRange.to = new Date(to);
      }

      const windowed = Object.keys(dateRange).length > 0 ? dateRange : undefined;

      // Scoped to the resolved current project unless allProjects is set —
      // matching transcripts.search / transcripts.similar. Until mt#3713 this
      // surface applied no project filter at all (mt#2417 Phase 1.4 gap).
      const projectId = await resolveTranscriptProjectScope(allProjects, context);

      const results = await svc.searchText(query, {
        limit,
        role,
        originKind,
        dateRange: windowed,
        sessionId,
        mode,
        projectId,
      });

      // When a date window is supplied, report whether in-window sessions exist
      // that are not yet indexed (so an empty/short result isn't misread as
      // "nothing matched"). Omitted when there is no gap. (mt#2319 SC#4)
      const coverage = await assessWindowCoverage(
        db as import("drizzle-orm/postgres-js").PostgresJsDatabase,
        windowed
      );

      log.debug("transcripts.search-text complete", {
        query,
        resultCount: results.length,
        projection,
        unindexedSessionsInWindow: coverage.unindexedSessionsInWindow,
      });

      // mt#4917: project at the COMMAND layer only — the cockpit calls the
      // service directly and must keep receiving full turns.
      return buildSearchResponse(projectTurnResults(results, projection), coverage);
    },
  });

  log.debug("Transcript search-text command registered");
}
