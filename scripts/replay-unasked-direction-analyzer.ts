#!/usr/bin/env bun
/**
 * Replay the unasked-direction analyzer (Surface 4) over already-stored transcripts.
 *
 * mt#4196 SC4/AT5. The analyzer produced 496 recorded runs and zero findings because it
 * read `msg.content`, which stored rows do not have. Fixing the read is only half the
 * deliverable — the other half is MEASURING what it says once it can see, over real
 * sessions rather than fixtures. A run that still yields zero findings across 20 real
 * transcripts is a publishable result, not a failure.
 *
 * Two modes, and the safe one is not the whole script (§7a dual-mode discipline):
 *
 *   --render-only   Resolve and render each transcript; report the non-text ratio.
 *                   No LLM calls, no cost. This is the blindness measurement.
 *   (default)       The above, plus a real analyzer call per transcript. Costs one
 *                   cheap-model completion per session.
 *
 * Both branches share the fetch and render path, so --render-only genuinely exercises
 * everything except the completion call.
 *
 * Env-gated: exits 0 with a SKIP line when persistence or AI providers are unavailable,
 * so it is safe to run anywhere.
 *
 * Usage:
 *   bun scripts/replay-unasked-direction-analyzer.ts --render-only --limit 20
 *   bun scripts/replay-unasked-direction-analyzer.ts --limit 20
 */

// Must precede anything that can reach tsyringe (the persistence factory does). Same
// first-import convention the other domain-touching scripts here follow.
import "reflect-metadata";

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { resolvePersistenceProviderOrError } from "../packages/domain/src/persistence/factory";
import { AgentTranscriptService } from "../packages/domain/src/provenance/transcript-service";
import type { TranscriptMessage } from "../packages/domain/src/provenance/transcript-service";
import {
  detectBlindRendering,
  resolveMessageText,
} from "../packages/domain/src/provenance/transcript-content";
import {
  UnaskedDirectionAnalyzer,
  __TEST_ONLY,
} from "../packages/domain/src/detectors/unasked-direction-analyzer";
import type { ConversationId } from "../packages/domain/src/ids";

interface ReplayRow {
  conversationId: string;
  messageCount: number;
  nonTextRatio: number;
  /**
   * Fraction of messages resolving to text that is empty or whitespace.
   *
   * Distinct from `nonTextRatio`, and not covered by it: a tool-use-only assistant message
   * has a real block array with no `text` blocks, so it extracts to `""` — resolution
   * SUCCEEDED and the message still carries nothing for the model to read. Recorded
   * separately because the two have different causes and different fixes.
   */
  emptyTextRatio: number;
  blind: boolean;
  findingCount: number | null;
  summary: string | null;
  error: string | null;
}

function parseIntArg(flag: string, fallback: number): number {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  const raw = process.argv[idx + 1];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function skip(reason: string): never {
  console.log(`SKIP: ${reason}`);
  process.exit(0);
}

/**
 * Initialize configuration before anything touches persistence or the AI providers.
 *
 * Both `resolvePersistenceProviderOrError` and `getResolvedConfig` below fail with
 * "Configuration not initialized" without this. Same sequence the other domain-touching
 * scripts here use; the post-merge hook reaches it through `ensureHookDomainBootstrap`
 * instead, which is hook-specific.
 */
async function initializeConfig(): Promise<void> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });
}

async function openDatabase(): Promise<PostgresJsDatabase> {
  const resolution = await resolvePersistenceProviderOrError();
  if (!resolution.ok) skip(`persistence unavailable (${JSON.stringify(resolution)})`);
  const provider = resolution.provider;
  if (!("getDatabaseConnection" in provider)) skip("provider has no database connection");
  const db = await (
    provider as { getDatabaseConnection(): Promise<unknown> }
  ).getDatabaseConnection();
  if (!db) skip("database connection unavailable");
  return db as PostgresJsDatabase;
}

/** Build a completion service, or null when no AI provider is configured. */
async function buildCompletionService(): Promise<unknown | null> {
  try {
    const { createCompletionService } = await import("../packages/domain/src/ai/service-factory");
    const { requireAIProviders } = await import("../packages/domain/src/ai/provider-operations");
    const { getResolvedConfig } = await import("../src/adapters/shared/commands/ai/shared-helpers");
    const resolved = getResolvedConfig();
    requireAIProviders(resolved);
    return createCompletionService(resolved);
  } catch (err) {
    console.log(
      `note: completion service unavailable (${err instanceof Error ? err.message : String(err)})`
    );
    return null;
  }
}

async function main(): Promise<void> {
  const limit = parseIntArg("--limit", 20);
  const renderOnly = process.argv.includes("--render-only");

  await initializeConfig();

  const db = await openDatabase();
  const service = new AgentTranscriptService(db);

  // Validated at the boundary rather than asserted through it: a raw driver result is
  // external input, and a cast would let a schema change surface as an undefined id
  // deep in the loop instead of here.
  const rawIdRows = await db.execute(
    sql`select agent_session_id from agent_transcripts order by ingested_at desc nulls last limit ${limit}`
  );
  const conversationIds: string[] = [];
  for (const row of rawIdRows as Iterable<Record<string, unknown>>) {
    const id = row.agent_session_id;
    if (typeof id === "string" && id.length > 0) conversationIds.push(id);
  }

  if (conversationIds.length === 0) skip("no transcripts stored");

  const completionService = renderOnly ? null : await buildCompletionService();
  if (!renderOnly && !completionService) {
    skip("AI providers not configured — re-run with --render-only for the blindness measurement");
  }
  const analyzer = completionService
    ? new UnaskedDirectionAnalyzer(
        completionService as import("../packages/domain/src/ai/completion-service").DefaultAICompletionService
      )
    : null;

  const rows: ReplayRow[] = [];

  for (const conversationId of conversationIds) {
    let messages: TranscriptMessage[] | null = null;
    try {
      messages = await service.getTranscript(conversationId as ConversationId);
    } catch (err) {
      rows.push({
        conversationId,
        messageCount: 0,
        nonTextRatio: 0,
        emptyTextRatio: 0,
        blind: false,
        findingCount: null,
        summary: null,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (!messages || messages.length === 0) {
      rows.push({
        conversationId,
        messageCount: 0,
        nonTextRatio: 0,
        emptyTextRatio: 0,
        blind: false,
        findingCount: null,
        summary: null,
        error: "no messages",
      });
      continue;
    }

    // Measured over the window the analyzer ACTUALLY reads, not the whole transcript —
    // these sessions run to thousands of messages and the analyzer caps at
    // TRANSCRIPT_MESSAGE_CAP. Read from the analyzer's own constant rather than mirroring
    // the number here, so the two cannot drift.
    const window = messages.slice(0, __TEST_ONLY.TRANSCRIPT_MESSAGE_CAP);
    const verdict = detectBlindRendering(window);
    const emptyCount = window.reduce(
      (n, m) => (resolveMessageText(m).text.trim() === "" ? n + 1 : n),
      0
    );
    const row: ReplayRow = {
      conversationId,
      messageCount: messages.length,
      nonTextRatio: Number(verdict.ratio.toFixed(4)),
      emptyTextRatio: window.length === 0 ? 0 : Number((emptyCount / window.length).toFixed(4)),
      blind: verdict.blind,
      findingCount: null,
      summary: null,
      error: null,
    };

    if (analyzer) {
      try {
        const output = await analyzer.analyzeTranscript(messages, { sessionId: conversationId });
        row.findingCount = output.findings.length;
        row.summary = output.summary;
      } catch (err) {
        row.error = err instanceof Error ? err.message : String(err);
      }
    }

    rows.push(row);
    console.log(
      `[${rows.length}/${conversationIds.length}] ${conversationId} msgs=${row.messageCount} ` +
        `nonTextRatio=${row.nonTextRatio}${row.blind ? " BLIND" : ""}${
          row.findingCount === null ? "" : ` findings=${row.findingCount}`
        }${row.error ? ` error=${row.error}` : ""}`
    );
  }

  const analyzed = rows.filter((r) => r.findingCount !== null);
  const totalFindings = analyzed.reduce((n, r) => n + (r.findingCount ?? 0), 0);
  const blindCount = rows.filter((r) => r.blind).length;

  const summary = {
    mode: renderOnly ? "render-only" : "live",
    transcriptsRequested: limit,
    transcriptsFetched: conversationIds.length,
    transcriptsWithMessages: rows.filter((r) => r.messageCount > 0).length,
    blindRenderings: blindCount,
    analyzedMessageWindow: __TEST_ONLY.TRANSCRIPT_MESSAGE_CAP,
    meanEmptyTextRatioInWindow: Number(
      (rows.reduce((sum, r) => sum + r.emptyTextRatio, 0) / Math.max(rows.length, 1)).toFixed(4)
    ),
    analyzed: analyzed.length,
    totalFindings,
    transcriptsWithAtLeastOneFinding: analyzed.filter((r) => (r.findingCount ?? 0) > 0).length,
  };

  console.log("");
  console.log(JSON.stringify({ summary, rows }, null, 2));

  // A blind rendering after this fix is the defect recurring — fail loudly rather than
  // reporting a clean zero, which is exactly how the original went unnoticed for 496 runs.
  if (blindCount > 0) {
    console.error(`FAIL: ${blindCount} of ${rows.length} transcripts still render as non-text`);
    process.exit(1);
  }
  console.log(`PASS: 0 blind renderings across ${rows.length} transcripts`);
}

await main();
