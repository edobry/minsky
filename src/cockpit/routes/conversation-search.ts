/**
 * Cockpit conversation content/time search (mt#2523).
 *
 *   GET /api/conversations/search — find a past conversation by content
 *   (FTS default, semantic optional) and/or a `from`/`to` time window,
 *   returning the conversation id and a ready `claude --resume <id>` hint
 *   for each matched turn.
 *
 * Thin pass-through over the existing transcripts substrate
 * (`TranscriptFtsService` / `TranscriptSimilarityService`) — no new
 * indexing or storage. Reuses the mt#2319 SC#4 coverage-gap signal
 * (`assessWindowCoverage` / `buildSearchResponse`) so a windowed query over
 * an unindexed range returns `{ results, coverage }` with a clear note
 * pointing at the indexing cadence (mt#2234) instead of a silent empty
 * `results: []`.
 *
 * @see mt#2523 — this endpoint
 * @see packages/domain/src/transcripts/transcript-search-filters.ts — the
 *   shared coverage/response-shape helpers this route reuses verbatim
 * @see src/adapters/shared/commands/transcripts/search-command.ts and
 *   search-text-command.ts — the CLI/MCP siblings of this endpoint; this
 *   route deliberately mirrors their DB-resolution + service-construction
 *   pattern rather than shelling out to the command registry
 */
import type express from "express";
import { log } from "@minsky/shared/logger";
import { getContextInspectorDb } from "../db-providers";

/** Accepted `mode` query values. Defaults to `text` (FTS — no embedding API dependency). */
type SearchMode = "text" | "semantic";

function parseMode(raw: unknown): SearchMode {
  return raw === "semantic" ? "semantic" : "text";
}

function parseLimit(raw: unknown): number {
  const n = typeof raw === "string" ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 10;
}

function parseDate(raw: unknown): Date | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Mount /api/conversations/search on `app`. */
export function mountConversationSearchRoutes(app: express.Express): void {
  /**
   * GET /api/conversations/search?q=<text>&mode=text|semantic&from=<iso>&to=<iso>&limit=<n>
   *
   * Returns:
   *   - 200 `{ results, coverage? }` — `results` is ranked transcript turns
   *     (each carrying `resumeHint`); `coverage` is present only when a
   *     `from`/`to` window was supplied AND it contains sessions not yet
   *     indexed into searchable turns (mt#2319 SC#4 / mt#2234).
   *   - 400 when `q` is missing/blank.
   *   - 503 when the DB is unavailable (persistence provider is non-SQL or
   *     unresolved).
   *   - 500 on any other failure (embedding-service unavailable for
   *     `mode=semantic`, query error, etc.).
   */
  app.get("/api/conversations/search", async (req, res) => {
    const rawQuery = req.query.q;
    const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
    if (!query) {
      res.status(400).json({ error: "Query parameter 'q' is required" });
      return;
    }

    const mode = parseMode(req.query.mode);
    const limit = parseLimit(req.query.limit);
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    const dateRange = from || to ? { from, to } : undefined;

    try {
      const db = await getContextInspectorDb();
      if (!db) {
        res.status(503).json({
          error: "DB unavailable — persistence provider does not support SQL",
        });
        return;
      }

      const { assessWindowCoverage, buildSearchResponse } = await import(
        "@minsky/domain/transcripts/transcript-search-filters"
      );

      let results: import("@minsky/domain/transcripts/transcript-similarity-service").TranscriptTurnResult[];

      if (mode === "semantic") {
        const { createEmbeddingServiceFromConfig } = await import(
          "@minsky/domain/ai/embedding-service-factory"
        );
        const embeddingService = await createEmbeddingServiceFromConfig();
        const { TranscriptSimilarityService } = await import(
          "@minsky/domain/transcripts/transcript-similarity-service"
        );
        const svc = new TranscriptSimilarityService(db, embeddingService);
        results = await svc.search(query, { limit, dateRange });
      } else {
        const { TranscriptFtsService } = await import(
          "@minsky/domain/transcripts/transcript-fts-service"
        );
        const svc = new TranscriptFtsService(db);
        results = await svc.searchText(query, { limit, dateRange });
      }

      const coverage = await assessWindowCoverage(db, dateRange);
      res.json(buildSearchResponse(results, coverage));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[conversations] GET /api/conversations/search — internal error: ${message}`);
      res.status(500).json({ error: "An internal error occurred while searching conversations." });
    }
  });
}
