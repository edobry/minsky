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
 *   --render-only   Resolve and render each transcript; report the non-text ratio and
 *                   the empty-text ratio under BOTH the pre-mt#4235 head window and the
 *                   current selection. No LLM calls, no cost. This is the blindness
 *                   measurement, and since mt#4235 also the window measurement.
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
  describeSampling,
  selectAnalysisWindow,
  __TEST_ONLY,
} from "../packages/domain/src/detectors/unasked-direction-analyzer";
import type { TranscriptSampling } from "../packages/domain/src/detectors/unasked-direction-analyzer";
import type { ConversationId } from "../packages/domain/src/ids";
import { extractSchemaIssuePaths } from "./lib/generate-object-failure";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

interface ReplayRow {
  conversationId: string;
  messageCount: number;
  nonTextRatio: number;
  /**
   * Fraction of messages resolving to text that is empty or whitespace, over the window
   * the analyzer ACTUALLY reads today.
   *
   * Distinct from `nonTextRatio`, and not covered by it: a tool-use-only assistant message
   * has a real block array with no `text` blocks, so it extracts to `""` — resolution
   * SUCCEEDED and the message still carries nothing for the model to read. Recorded
   * separately because the two have different causes and different fixes.
   */
  emptyTextRatio: number;
  /**
   * The same fraction over the PRE-mt#4235 window (`messages.slice(0, CAP)`) — the
   * baseline, re-measured on THIS sample in THIS run.
   *
   * Both figures come from one run deliberately. The replay draws "the 20 most recently
   * ingested" transcripts, so the sample moves between runs: mt#4235 was filed citing
   * 0.8826 and the same command two days later pooled to ≈0.754 on different rows.
   * Comparing a post-change figure against a number measured on a different sample would
   * be a false comparison in either direction, so the baseline is computed here rather
   * than quoted.
   */
  headBaselineEmptyTextRatio: number;
  /** Messages actually fed to the model under the current selection. */
  analyzedMessages: number;
  /**
   * Which rule produced the window — `head-fallback` means nothing in the transcript carried
   * extractable text, so the row's other figures describe the unfiltered head rather than a
   * sample. Recorded because without it those two cases are indistinguishable in the output.
   */
  strategy: TranscriptSampling["strategy"];
  /** Transcript span the analyzed window covers, as `[firstIndex, lastIndex]`. */
  windowSpan: [number, number] | null;
  blind: boolean;
  findingCount: number | null;
  summary: string | null;
  error: string | null;
  /**
   * Why this row carries no measurements, when it carries none (mt#4317).
   *
   * `messageCount: 0` used to mean two unrelated things — a genuinely degenerate stored
   * transcript, and a transcript this run never managed to READ. One run returned 11 of 20
   * rows with `messageCount: 0` whose errors all read `Failed query: select
   * "agent_session_id", ...`; the database was failing, and the summary reported
   * `transcriptsWithZeroMessages: 11` as though the corpus were degenerate. A reader
   * comparing that run against another would have drawn a conclusion from an
   * infrastructure fault. The two cases now carry different labels and are counted apart.
   */
  fetchStatus: "ok" | "fetch-failed" | "empty";
  /**
   * For an analyzed row that threw: which schema fields the response was missing, or
   * `null` when the call failed for a reason that is not a schema violation at all
   * (rate limit, transport reset). `error` alone cannot distinguish those.
   */
  missingFields: string[] | null;
}

function parseIntArg(flag: string, fallback: number): number {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  const raw = process.argv[idx + 1];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Mean of a sample, rounded to 4dp. Returns 0 for an empty sample. */
function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(4));
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
    console.log(`note: completion service unavailable (${getLoggableErrorSummary(err)})`);
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
        headBaselineEmptyTextRatio: 0,
        analyzedMessages: 0,
        strategy: "head-fallback",
        windowSpan: null,
        blind: false,
        findingCount: null,
        summary: null,
        error: err instanceof Error ? err.message : String(err),
        fetchStatus: "fetch-failed",
        missingFields: null,
      });
      continue;
    }

    if (!messages || messages.length === 0) {
      rows.push({
        conversationId,
        messageCount: 0,
        nonTextRatio: 0,
        emptyTextRatio: 0,
        headBaselineEmptyTextRatio: 0,
        analyzedMessages: 0,
        strategy: "head-fallback",
        windowSpan: null,
        blind: false,
        findingCount: null,
        summary: null,
        error: "no messages",
        fetchStatus: "empty",
        missingFields: null,
      });
      continue;
    }

    // Two windows over the SAME transcript, in the same run:
    //
    //   `window`        what the analyzer reads today — `selectAnalysisWindow` (mt#4235).
    //   `headBaseline`  what it read before — the first CAP messages.
    //
    // Measuring both here is what makes the comparison honest. Read the cap from the
    // analyzer's own constant rather than mirroring the number, so the two cannot drift.
    const selected = selectAnalysisWindow(messages);
    const sampling = describeSampling(messages, selected);
    const window = selected.map((s) => s.message);
    const verdict = detectBlindRendering(window);

    const headBaseline = messages.slice(0, __TEST_ONLY.TRANSCRIPT_MESSAGE_CAP);
    const headEmptyCount = headBaseline.reduce(
      (n, m) => (resolveMessageText(m).text.trim() === "" ? n + 1 : n),
      0
    );

    const row: ReplayRow = {
      conversationId,
      messageCount: messages.length,
      nonTextRatio: Number(verdict.ratio.toFixed(4)),
      emptyTextRatio: Number(sampling.emptyTextRatio.toFixed(4)),
      headBaselineEmptyTextRatio:
        headBaseline.length === 0 ? 0 : Number((headEmptyCount / headBaseline.length).toFixed(4)),
      analyzedMessages: sampling.analyzedMessages,
      strategy: sampling.strategy,
      windowSpan:
        sampling.firstIndex === null || sampling.lastIndex === null
          ? null
          : [sampling.firstIndex, sampling.lastIndex],
      blind: verdict.blind,
      findingCount: null,
      summary: null,
      error: null,
      fetchStatus: "ok",
      missingFields: null,
    };

    if (analyzer) {
      try {
        const output = await analyzer.analyzeTranscript(messages, { sessionId: conversationId });
        row.findingCount = output.findings.length;
        row.summary = output.summary;
      } catch (err) {
        row.error = err instanceof Error ? err.message : String(err);
        // mt#4317: WHICH field was absent is the measurement, not the total. AT1 asks for
        // the per-error-class breakdown pasted rather than a count.
        row.missingFields = extractSchemaIssuePaths(err);
      }
    }

    rows.push(row);
    console.log(
      `[${rows.length}/${conversationIds.length}] ${conversationId} msgs=${row.messageCount} ` +
        `analyzed=${row.analyzedMessages} emptyText=${row.headBaselineEmptyTextRatio}→${row.emptyTextRatio} ` +
        `nonTextRatio=${row.nonTextRatio}${row.blind ? " BLIND" : ""}${
          row.findingCount === null ? "" : ` findings=${row.findingCount}`
        }${row.error ? ` error=${row.error}` : ""}`
    );
  }

  const analyzed = rows.filter((r) => r.findingCount !== null);
  const totalFindings = analyzed.reduce((n, r) => n + (r.findingCount ?? 0), 0);
  const blindCount = rows.filter((r) => r.blind).length;

  // Rows this run actually READ. Every ratio below is computed over these and only these:
  // a transcript the database refused to hand over has no empty-text ratio, and averaging
  // a fabricated 0.0 into the mean silently drags the headline figure down (mt#4317).
  const measured = rows.filter((r) => r.fetchStatus === "ok");
  const fetchFailed = rows.filter((r) => r.fetchStatus === "fetch-failed");
  const genuinelyEmpty = rows.filter((r) => r.fetchStatus === "empty");

  // A failed analyzer call splits two ways and the split is the point: a response missing a
  // required field is a compliance datum, a rate limit is not. Folding them together
  // inflates exactly the rate mt#4317 is trying to measure.
  const schemaViolations = rows.filter((r) => r.missingFields !== null);
  const callErrors = rows.filter(
    (r) => r.error !== null && r.missingFields === null && r.fetchStatus === "ok"
  );
  const missingFieldBreakdown: Record<string, number> = {};
  for (const r of schemaViolations) {
    for (const field of r.missingFields ?? []) {
      missingFieldBreakdown[field] = (missingFieldBreakdown[field] ?? 0) + 1;
    }
  }

  const corpusIntegrity = {
    transcriptsRead: measured.length,
    // Never merged into one "zero messages" figure — see `ReplayRow.fetchStatus`.
    transcriptsFetchFailed: fetchFailed.length,
    transcriptsGenuinelyEmpty: genuinelyEmpty.length,
    fetchFailureSamples: fetchFailed.slice(0, 3).map((r) => r.error?.slice(0, 160) ?? ""),
  };

  // A run whose corpus did not load has no ratio statistics to report — reporting them
  // anyway is what produced a degenerate-corpus reading of an infrastructure fault.
  if (measured.length === 0) {
    console.log("");
    console.log(JSON.stringify({ corpusIntegrity, rows }, null, 2));
    console.error(
      `FAIL: none of ${rows.length} transcripts could be read — no statistics reported ` +
        `(${fetchFailed.length} fetch failures, ${genuinelyEmpty.length} genuinely empty)`
    );
    process.exit(1);
  }

  const summary = {
    mode: renderOnly ? "render-only" : "live",
    transcriptsRequested: limit,
    transcriptsFetched: conversationIds.length,
    corpusIntegrity,
    transcriptsWithMessages: measured.length,
    blindRenderings: blindCount,
    analyzedMessageWindow: __TEST_ONLY.TRANSCRIPT_MESSAGE_CAP,
    // Before and after, over the same rows, from this run. See `headBaselineEmptyTextRatio`
    // for why the baseline is measured rather than quoted from the spec.
    meanEmptyTextRatioHeadBaseline: mean(measured.map((r) => r.headBaselineEmptyTextRatio)),
    meanEmptyTextRatioInWindow: mean(measured.map((r) => r.emptyTextRatio)),
    meanAnalyzedMessages: mean(measured.map((r) => r.analyzedMessages)),
    analyzed: analyzed.length,
    totalFindings,
    transcriptsWithAtLeastOneFinding: analyzed.filter((r) => (r.findingCount ?? 0) > 0).length,
    // mt#4317 AT1: the per-error-class breakdown, not just a total.
    schemaViolations: schemaViolations.length,
    missingFieldBreakdown,
    callErrors: callErrors.length,
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
