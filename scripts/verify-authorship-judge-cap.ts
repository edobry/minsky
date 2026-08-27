#!/usr/bin/env bun
/**
 * Verify the `authorship-judge` output cap now that it is actually enforced (mt#4314).
 *
 * ## Why this script exists
 *
 * `DefaultAICompletionService.generateObject` never forwarded `maxTokens`. `AuthorshipJudge`
 * has passed `maxTokens: 500` since it was written, and that cap has therefore NEVER been
 * applied — every judgment it has produced ran against the SDK's provider default. mt#4314
 * connects the knob, which means 500 binds for the first time on a path mt#4225 just
 * repaired.
 *
 * That is the whole risk of the fix, and it is not statically decidable: the judge's schema
 * carries two open-ended prose fields (`rationale`, `substantiveHumanInput`) plus a
 * `trajectoryChanges` array, so whether the model can finish inside 500 output tokens is a
 * question about the model, answerable only by asking it.
 *
 * A truncated structured response does NOT surface as a truncation error — it surfaces as a
 * schema-validation failure on whichever field the model had not reached yet, which is
 * exactly how mt#4314 was found in the first place. So this script's pass condition is that
 * every judgment PARSES, and its diagnostic output is how close each one came to the ceiling.
 *
 * Env-gated: exits 0 with a SKIP line when persistence or AI providers are unavailable, so it
 * is safe to run anywhere.
 *
 * Usage:
 *   bun scripts/verify-authorship-judge-cap.ts --limit 10
 */

// Must precede anything that can reach tsyringe (the persistence factory does). Same
// first-import convention the other domain-touching scripts here follow.
import "reflect-metadata";

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { resolvePersistenceProviderOrError } from "../packages/domain/src/persistence/factory";
import { AgentTranscriptService } from "../packages/domain/src/provenance/transcript-service";
import type { TranscriptMessage } from "../packages/domain/src/provenance/transcript-service";
import { AuthorshipJudge } from "../packages/domain/src/provenance/authorship-judge";
import type { ConversationId } from "../packages/domain/src/ids";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

interface JudgeRow {
  conversationId: string;
  messageCount: number;
  /** True when the judgment parsed against the schema. */
  parsed: boolean;
  tier: number | null;
  /**
   * Rough size of the model's answer, in characters, across the three open-ended fields.
   *
   * Not a token count and not presented as one — it is the cheap proxy for "how close did
   * this come to the ceiling", which is what decides whether 500 is the right cap.
   */
  answerChars: number | null;
  trajectoryChanges: number | null;
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
 * "Configuration not initialized" without this.
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
  const limit = parseIntArg("--limit", 10);

  await initializeConfig();

  const db = await openDatabase();
  const service = new AgentTranscriptService(db);

  // Validated at the boundary rather than asserted through it: a raw driver result is
  // external input, and a cast would let a schema change surface as an undefined id deep in
  // the loop instead of here.
  const rawIdRows = await db.execute(
    sql`select agent_session_id from agent_transcripts order by ingested_at desc nulls last limit ${limit}`
  );
  const conversationIds: string[] = [];
  for (const row of rawIdRows as Iterable<Record<string, unknown>>) {
    const id = row.agent_session_id;
    if (typeof id === "string" && id.length > 0) conversationIds.push(id);
  }
  if (conversationIds.length === 0) skip("no transcripts stored");

  const completionService = await buildCompletionService();
  if (!completionService) skip("AI providers not configured");

  const judge = new AuthorshipJudge(
    completionService as import("../packages/domain/src/ai/completion-service").DefaultAICompletionService
  );

  const rows: JudgeRow[] = [];

  for (const conversationId of conversationIds) {
    let messages: TranscriptMessage[] | null = null;
    try {
      messages = await service.getTranscript(conversationId as ConversationId);
    } catch (err) {
      rows.push({
        conversationId,
        messageCount: 0,
        parsed: false,
        tier: null,
        answerChars: null,
        trajectoryChanges: null,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (!messages || messages.length === 0) {
      rows.push({
        conversationId,
        messageCount: 0,
        parsed: false,
        tier: null,
        answerChars: null,
        trajectoryChanges: null,
        error: "no messages",
      });
      continue;
    }

    try {
      // `{}` for signals: every field on TierSignals is optional, and the signals shape is
      // not what this script is measuring — the model's ability to answer inside the cap is.
      const judgment = await judge.evaluateTranscript(messages, {});
      const answerChars =
        judgment.rationale.length +
        judgment.substantiveHumanInput.length +
        judgment.trajectoryChanges.reduce((n, s) => n + s.length, 0);

      rows.push({
        conversationId,
        messageCount: messages.length,
        parsed: true,
        tier: judgment.tier,
        answerChars,
        trajectoryChanges: judgment.trajectoryChanges.length,
        error: null,
      });
    } catch (err) {
      rows.push({
        conversationId,
        messageCount: messages.length,
        parsed: false,
        tier: null,
        answerChars: null,
        trajectoryChanges: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const row = rows[rows.length - 1];
    console.log(
      `[${rows.length}/${conversationIds.length}] ${conversationId} msgs=${row?.messageCount} ` +
        `${row?.parsed ? `tier=${row.tier} answerChars=${row.answerChars} trajectoryChanges=${row.trajectoryChanges}` : `FAILED ${row?.error}`}`
    );
  }

  const parsed = rows.filter((r) => r.parsed);
  const failed = rows.filter((r) => !r.parsed && r.error !== "no messages");
  const answerChars = parsed.map((r) => r.answerChars ?? 0);

  const summary = {
    transcriptsFetched: conversationIds.length,
    judged: parsed.length,
    failed: failed.length,
    skippedEmpty: rows.filter((r) => r.error === "no messages").length,
    maxAnswerChars: answerChars.length ? Math.max(...answerChars) : 0,
    meanAnswerChars: answerChars.length
      ? Math.round(answerChars.reduce((a, b) => a + b, 0) / answerChars.length)
      : 0,
  };

  console.log("");
  console.log(JSON.stringify({ summary, rows }, null, 2));

  // A judgment that does not parse is the cap biting. That is the exact regression this
  // script exists to catch before the forwarding fix ships, so it fails loudly rather than
  // reporting a clean run with a smaller denominator.
  if (failed.length > 0) {
    console.error(
      `FAIL: ${failed.length} of ${rows.length} judgments did not parse — the enforced cap is too tight`
    );
    process.exit(1);
  }
  console.log(`PASS: ${parsed.length} judgments parsed under the enforced cap`);
}

await main();
