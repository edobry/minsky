#!/usr/bin/env bun
/**
 * mt#4317 — why does Surface 4's analyzer lose a large minority of runs to a required
 * field being absent from an otherwise well-formed response?
 *
 * ## What this measures, and why it is shaped this way
 *
 * Three eliminations already hold (see the task spec): it is not the token budget (flat
 * across a 6x range), the emitted JSON Schema does carry `required: ["findings","summary"]`,
 * and `jsonSchema()` installs no validator — so the AI SDK returns whatever the model
 * produced and Zod's `.parse()` is the only gate. What remains is why the model omits a
 * field it is being told is mandatory.
 *
 * **The design point is PAIRING.** Attempt 1 compared whole runs taken on different days
 * against different samples, and a 10-point difference at n=40 per arm could not be
 * separated from run-to-run variance. Here every arm sees the SAME transcripts, and — more
 * than that — the same rendered prompt object, computed once per transcript and reused.
 * Between-transcript variance therefore cancels: an arm's failures can be compared to
 * another arm's ON THE SAME ROW, which is a far sharper instrument than comparing two
 * marginal rates.
 *
 * The primary question is also CATEGORICAL rather than a rate: not "does arm X fail less"
 * but "WHICH FIELD does arm X fail on". That is what partitions the hypotheses, and it is
 * legible at much smaller n than a rate difference is.
 *
 * ## The arms — each varies exactly one thing from production
 *
 * - `baseline`               the shipped call, unmodified. The control.
 * - `reordered`              `summary` declared BEFORE `findings`. If failures follow the
 *                            LAST declared field, the cause is an ordering/length effect;
 *                            if they stay on `summary`, it is field-specific.
 * - `described`             `.describe()` on both top-level fields. The shipped schema
 *                            emits `summary: {"type":"string"}` with no semantics at all —
 *                            the JSDoc above it is a TypeScript comment and reaches nothing.
 * - `prompt-names-summary`   the system prompt gains a line naming `summary`. The shipped
 *                            prompt details every `findings` sub-field and never mentions
 *                            `summary` anywhere.
 *
 * The last two are the same hypothesis — the model is never told the field exists — reached
 * through the two different channels that could carry it, kept separate so a result names
 * which channel did the work.
 *
 * Env-gated like the replay: exits 0 with SKIP when persistence or AI providers are absent.
 *
 * Usage:
 *   bun scripts/experiment-analyzer-field-compliance.ts --limit 30
 *   bun scripts/experiment-analyzer-field-compliance.ts --limit 30 --out /tmp/run.jsonl
 */

import "reflect-metadata";

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

import { resolvePersistenceProviderOrError } from "../packages/domain/src/persistence/factory";
import { AgentTranscriptService } from "../packages/domain/src/provenance/transcript-service";
import type { TranscriptMessage } from "../packages/domain/src/provenance/transcript-service";
import {
  describeSampling,
  selectAnalysisWindow,
  __TEST_ONLY,
} from "../packages/domain/src/detectors/unasked-direction-analyzer";
import type { ConversationId } from "../packages/domain/src/ids";
import type { DefaultAICompletionService } from "../packages/domain/src/ai/completion-service";
import { extractSchemaIssuePaths } from "./lib/generate-object-failure";
import { safeTruncate } from "../src/utils/safe-truncate";

const { analyzerOutputSchema, SYSTEM_PROMPT, ANALYZER_REQUEST_DEFAULTS, TRANSCRIPT_MESSAGE_CAP } =
  __TEST_ONLY;

// ---------------------------------------------------------------------------
// Schema variants
// ---------------------------------------------------------------------------

/**
 * Re-derived from the production schema's own shape rather than retyped.
 *
 * `analyzerOutputSchema.shape.findings` IS the shipped findings schema, so a variant
 * cannot drift from production by construction — the only difference between these and
 * the shipped object is the one property each is testing.
 */
const findingsField = analyzerOutputSchema.shape.findings;
const summaryField = analyzerOutputSchema.shape.summary;

/** `summary` first, `findings` last — the discriminating arm. */
const reorderedSchema = z.object({
  summary: summaryField,
  findings: findingsField,
});

/** Production order, but both fields carry semantics the provider can see. */
const describedSchema = z.object({
  findings: findingsField.describe(
    "Every preference-bound decision found in this session. An empty array when the session has none — this field is REQUIRED and must always be present."
  ),
  summary: summaryField.describe(
    "One sentence summarizing the overall judgment of this session. REQUIRED — always return it, including when findings is empty."
  ),
});

/** The shipped prompt, plus the sentence it never had. */
const SYSTEM_PROMPT_NAMING_SUMMARY = `${SYSTEM_PROMPT}

Always return BOTH top-level fields: "findings" (the array described above, empty if none) and "summary" (one sentence giving your overall judgment of the session). "summary" is required even when findings is empty.`;

interface Arm {
  name: string;
  schema: z.ZodType;
  systemPrompt: string;
  /** Overrides the request's structured-output strategy; unset means production's default. */
  mode?: "auto" | "json" | "tool";
}

const ALL_ARMS: readonly Arm[] = [
  { name: "baseline", schema: analyzerOutputSchema, systemPrompt: SYSTEM_PROMPT },
  { name: "reordered", schema: reorderedSchema, systemPrompt: SYSTEM_PROMPT },
  { name: "described", schema: describedSchema, systemPrompt: SYSTEM_PROMPT },
  {
    name: "prompt-names-summary",
    schema: analyzerOutputSchema,
    systemPrompt: SYSTEM_PROMPT_NAMING_SUMMARY,
  },
  // The one arm that overrides a REQUEST parameter rather than the schema or the prompt.
  //
  // `mode: "tool"` exposes the schema as a tool signature the provider enforces, instead of
  // asking the model to emit a conforming JSON document. Measured once at 11/40 against
  // `auto`'s 15/40 — not separable from variance at that n — so production does NOT set it
  // (see `ANALYZER_REQUEST_DEFAULTS`). It lives here so a run large enough to settle it costs
  // a flag rather than a re-implementation, and so `AIObjectGenerationRequest.mode` has a
  // consumer that exercises the forwarding path.
  { name: "tool-mode", schema: analyzerOutputSchema, systemPrompt: SYSTEM_PROMPT, mode: "tool" },
];

/**
 * Which arms this invocation runs, defaulting to all of them.
 *
 * A confirmation run does not need the arms that have already been falsified — it needs
 * the contrast that is actually load-bearing. `--arms baseline,reordered` halves the call
 * count, which matters because the prompt this measures is not frozen: mt#4289 changed how
 * a harness-written user line is labelled, so the corpus the model reads today is not the
 * one the original run read, and the comparison has to be re-taken rather than quoted.
 */
const ARMS: readonly Arm[] = (() => {
  const requested = parseStringArg("--arms", "");
  if (requested === "") return ALL_ARMS;
  const names = requested
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "");
  const selected = names.map((name) => {
    const arm = ALL_ARMS.find((a) => a.name === name);
    // Fail loudly: a typo'd arm name that silently ran zero arms would report a clean
    // summary over nothing at all.
    if (!arm)
      throw new Error(`unknown arm "${name}" (have: ${ALL_ARMS.map((a) => a.name).join(", ")})`);
    return arm;
  });
  return selected;
})();

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

type Outcome =
  | { kind: "ok"; findingCount: number; summaryChars: number }
  /** The response parsed as JSON but Zod rejected it — `paths` names the offending fields. */
  | { kind: "schema-violation"; paths: string[]; message: string }
  /** Anything else: provider error, transport failure, rate limit. NOT a compliance datum. */
  | { kind: "call-error"; message: string };

// ---------------------------------------------------------------------------
// Boilerplate shared with the replay script
// ---------------------------------------------------------------------------

function parseIntArg(flag: string, fallback: number): number {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  const raw = process.argv[idx + 1];
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseStringArg(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return fallback;
  return process.argv[idx + 1] ?? fallback;
}

function skip(reason: string): never {
  console.log(`SKIP: ${reason}`);
  process.exit(0);
}

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

async function buildCompletionService(): Promise<DefaultAICompletionService | null> {
  try {
    const { createCompletionService } = await import("../packages/domain/src/ai/service-factory");
    const { requireAIProviders } = await import("../packages/domain/src/ai/provider-operations");
    const { getResolvedConfig } = await import("../src/adapters/shared/commands/ai/shared-helpers");
    const resolved = getResolvedConfig();
    requireAIProviders(resolved);
    return createCompletionService(resolved) as DefaultAICompletionService;
  } catch (err) {
    console.log(
      `note: completion service unavailable (${err instanceof Error ? err.message : String(err)})`
    );
    return null;
  }
}

// ---------------------------------------------------------------------------

interface ResultRow {
  conversationId: string;
  arm: string;
  totalMessages: number;
  analyzedMessages: number;
  /** The Amendment-1 bucket: a full window failed ~44% against a partial window's ~10%. */
  fullWindow: boolean;
  /**
   * Size of the rendered user prompt, in characters.
   *
   * The leading open hypothesis after the field-order result failed to replicate: failures
   * skew to FULL windows in every run taken so far, which is a proxy for a big prompt.
   * `analyzedMessages` caps at 60 and so cannot separate a window of 60 short messages from
   * one of 60 long ones; this can. Recorded on every row so the question is answerable from
   * data already collected rather than needing another live run.
   */
  promptChars: number;
  /**
   * The structured-output strategy ACTUALLY SENT for this row — `null` when the request set
   * none, i.e. the SDK picks (`auto`), which is what production does.
   *
   * Recorded because the analysis must not have to INFER the configuration from an arm's name
   * (PR #3204 R1). An arm called `baseline` asserts nothing; a recorded `mode` is checkable.
   * Without it, a dataset gathered under one configuration can be analyzed and labelled as
   * another, which is precisely the mislabeling this whole task exists to avoid.
   */
  mode: "auto" | "json" | "tool" | null;
  outcome: Outcome;
}

async function main(): Promise<void> {
  const limit = parseIntArg("--limit", 30);
  // `.tmp/` rather than an invented `.scratch/`: it is already in .gitignore, so the default
  // output of an ad-hoc harness can never become an accidental commit.
  const outPath = parseStringArg("--out", ".tmp/analyzer-field-compliance.jsonl");

  await initializeConfig();
  const db = await openDatabase();
  const service = new AgentTranscriptService(db);

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

  // Created for whatever path the caller gave, not just the default: the previous version
  // assumed the directory existed because the author had made it by hand, so a clean checkout
  // threw ENOENT before running a single arm (PR #3200 R2).
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, "");
  const rows: ResultRow[] = [];
  /** Transcripts that never reached the model, with why — a DB fault is not a datum. */
  const unusable: { conversationId: string; reason: string }[] = [];

  for (const [i, conversationId] of conversationIds.entries()) {
    let messages: TranscriptMessage[];
    try {
      const fetched = await service.getTranscript(conversationId as ConversationId);
      if (!fetched || fetched.length === 0) {
        unusable.push({ conversationId, reason: "transcript has no messages" });
        continue;
      }
      messages = fetched;
    } catch (err) {
      // Distinguished from an empty transcript deliberately: the replay script conflated
      // the two and reported a failed DB query as a degenerate-corpus statistic (mt#4317).
      unusable.push({
        conversationId,
        reason: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    // Rendered ONCE and reused by every arm. This is the pairing: each arm answers the
    // identical prompt, so a difference between arms cannot be a difference in input.
    const selected = selectAnalysisWindow(messages);
    const sampling = describeSampling(messages, selected);
    const userPrompt = __TEST_ONLY.buildUserPromptFromSelection(selected, sampling, {
      sessionId: conversationId,
    });
    const fullWindow = sampling.analyzedMessages >= TRANSCRIPT_MESSAGE_CAP;

    // Rotate which arm goes first, so no arm systematically occupies the position most
    // exposed to a rate-limit backoff or a provider-side warm-up.
    const offset = i % ARMS.length;
    const armOrder = [...ARMS.slice(offset), ...ARMS.slice(0, offset)];

    for (const arm of armOrder) {
      let outcome: Outcome;
      try {
        const result = (await completionService.generateObject({
          messages: [
            { role: "system", content: arm.systemPrompt },
            { role: "user", content: userPrompt },
          ],
          schema: arm.schema,
          ...ANALYZER_REQUEST_DEFAULTS,
          // Spread AFTER the production defaults so an arm can override one of them, and
          // conditional so an arm that sets nothing is byte-identical to the production call.
          ...(arm.mode !== undefined ? { mode: arm.mode } : {}),
        })) as { findings: unknown[]; summary: string };
        outcome = {
          kind: "ok",
          findingCount: result.findings.length,
          summaryChars: result.summary.length,
        };
      } catch (err) {
        const paths = extractSchemaIssuePaths(err);
        const message = err instanceof Error ? err.message : String(err);
        outcome =
          paths === null
            ? { kind: "call-error", message: safeTruncate(message, 300, "head") }
            : { kind: "schema-violation", paths, message: safeTruncate(message, 300, "head") };
      }

      const row: ResultRow = {
        conversationId,
        arm: arm.name,
        totalMessages: sampling.totalMessages,
        analyzedMessages: sampling.analyzedMessages,
        fullWindow,
        promptChars: userPrompt.length,
        // Read off the arm that was actually spread into the request, not off its name.
        mode: arm.mode ?? null,
        outcome,
      };
      rows.push(row);
      appendFileSync(outPath, `${JSON.stringify(row)}\n`);

      const label =
        outcome.kind === "ok"
          ? `ok findings=${outcome.findingCount}`
          : outcome.kind === "schema-violation"
            ? `MISSING[${outcome.paths.join(",")}]`
            : `ERROR ${outcome.message.slice(0, 80)}`;
      console.log(
        `[${i + 1}/${conversationIds.length}] ${conversationId.slice(0, 8)} ` +
          `msgs=${sampling.totalMessages} analyzed=${sampling.analyzedMessages} ` +
          `${arm.name.padEnd(21)} ${label}`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  const perArm = ARMS.map((arm) => {
    const armRows = rows.filter((r) => r.arm === arm.name);
    const violations = armRows.filter((r) => r.outcome.kind === "schema-violation");
    const callErrors = armRows.filter((r) => r.outcome.kind === "call-error");
    const byField: Record<string, number> = {};
    for (const r of violations) {
      if (r.outcome.kind !== "schema-violation") continue;
      for (const p of r.outcome.paths) byField[p] = (byField[p] ?? 0) + 1;
    }
    const full = armRows.filter((r) => r.fullWindow);
    const partial = armRows.filter((r) => !r.fullWindow);
    return {
      arm: arm.name,
      attempted: armRows.length,
      ok: armRows.filter((r) => r.outcome.kind === "ok").length,
      schemaViolations: violations.length,
      // Reported separately and NEVER folded into the violation count: a provider or
      // transport failure says nothing about whether the model complied with the schema.
      callErrors: callErrors.length,
      missingFieldBreakdown: byField,
      fullWindowViolations: `${full.filter((r) => r.outcome.kind === "schema-violation").length}/${full.length}`,
      partialWindowViolations: `${partial.filter((r) => r.outcome.kind === "schema-violation").length}/${partial.length}`,
    };
  });

  console.log("");
  console.log(
    JSON.stringify(
      {
        summary: {
          transcriptsRequested: limit,
          transcriptsFetched: conversationIds.length,
          transcriptsUsable: conversationIds.length - unusable.length,
          // Never collapsed into one "empty" count — see `unusable` above.
          unusable,
          arms: perArm,
        },
      },
      null,
      2
    )
  );
  console.log(`\nrows written to ${outPath}`);
}

await main();
