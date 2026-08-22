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
 * ## The window arms (mt#4370) measure a TRADE, not a fix
 *
 * `window-400` / `window-200` / `window-150` vary `MESSAGE_TRUNCATE_CHARS`, and unlike every
 * arm above they change the PROMPT. Shrinking it is expected to buy compliance — prompt size
 * predicts rejection (mt#4365: 15.5% below 10,000 chars against 44.0% at or above, Fisher
 * p < 0.0001) — and to spend per-message depth, which is what the model reads the session
 * with. Both sides are recorded on every row so no run can report the purchase without the
 * price. They are opt-in (`--arms`), for the cost reason at `DEFAULT_ARMS`.
 *
 * **This harness does not decide anything.** mt#4370 SC5 keeps the lever itself
 * principal-owned; what ships from here is a pair of numbers.
 *
 * ## The replicate arm (mt#4409) — the one arm that varies NOTHING
 *
 * Every arm above varies something, and none repeats. So arm-to-arm disagreement has always
 * conflated the treatment effect with call-to-call nondeterminism, and no comparison this
 * harness produced had a noise floor to be judged against. `--replicate N` runs each selected
 * arm N times against the SAME rendered prompt: the difference between two such calls is the
 * instrument's own variance with the treatment held fixed, and its expected value is zero.
 * A run whose replicate pair differs significantly did not measure noise — it means the two
 * calls were not actually identical, which voids the run rather than reporting a finding.
 *
 * Per mem#1182: any arm-based experiment over a non-deterministic responder should carry one,
 * and it costs a single extra call per input.
 *
 * Env-gated like the replay: exits 0 with SKIP when persistence or AI providers are absent.
 *
 * Usage:
 *   bun scripts/experiment-analyzer-field-compliance.ts --limit 30
 *   bun scripts/experiment-analyzer-field-compliance.ts --limit 30 --out /tmp/run.jsonl
 *   bun scripts/experiment-analyzer-field-compliance.ts --limit 200 \
 *     --arms window-400,window-200,window-150 --out .tmp/mt4370-window.jsonl
 *   bun scripts/experiment-analyzer-field-compliance.ts --limit 250 \
 *     --arms window-400,window-150 --replicate 2 --out .tmp/mt4409-replicate.jsonl
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

const {
  analyzerOutputSchema,
  SYSTEM_PROMPT,
  ANALYZER_REQUEST_DEFAULTS,
  TRANSCRIPT_MESSAGE_CAP,
  MESSAGE_TRUNCATE_CHARS,
} = __TEST_ONLY;

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
  /**
   * Per-message truncation for THIS arm; unset means production's `MESSAGE_TRUNCATE_CHARS`.
   *
   * The first arm dimension that varies the PROMPT rather than the request or the schema
   * (mt#4370). Everything else here is answered against one rendered prompt per transcript;
   * a window arm cannot be, so the render moved inside the arm loop and is memoized by this
   * value — see `renderFor` in the main loop for what that does to the pairing guarantee.
   */
  truncateChars?: number;
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

  // mt#4370 — the window arms. A three-point DOSE-RESPONSE, not a two-arm contrast, because
  // mt#4365 established there is no floor: the smallest failing prompt was 1,283 chars and
  // the below-10,000 group still failed 15.5%. The 10,000-char threshold summarizes a
  // gradient, so a single contrast measures one point on a curve.
  //
  // `window-400` sets production's own value explicitly. It renders byte-identical to
  // `baseline` — the point is that the control's dose is RECORDED rather than implied by an
  // arm name, so the dose-response analysis reads its x-axis off the data (PR #3204 R1).
  {
    name: "window-400",
    schema: analyzerOutputSchema,
    systemPrompt: SYSTEM_PROMPT,
    truncateChars: 400,
  },
  // T=200: the last value with real above-threshold mass (72.9% of transcripts below 10,000
  // chars) at 79.3% dosage. T=150: the first value that clears every transcript, at 69.9%.
  // Both figures re-derived on the run's own corpus rather than quoted — see the dosage lines.
  {
    name: "window-200",
    schema: analyzerOutputSchema,
    systemPrompt: SYSTEM_PROMPT,
    truncateChars: 200,
  },
  {
    name: "window-150",
    schema: analyzerOutputSchema,
    systemPrompt: SYSTEM_PROMPT,
    truncateChars: 150,
  },
];

/**
 * What a bare invocation runs — deliberately NOT `ALL_ARMS`.
 *
 * The window arms (mt#4370) are opt-in: they answer a different question from the
 * field-compliance arms, and folding them into the default would raise the cost of every
 * unflagged run by 60% for a measurement the caller did not ask for. `--arms` still resolves
 * against the full registry, so an explicit name always works and a typo still throws.
 */
const DEFAULT_ARMS: readonly Arm[] = ALL_ARMS.filter((a) => a.truncateChars === undefined);

/**
 * Which arms this invocation runs, defaulting to all of them.
 *
 * A confirmation run does not need the arms that have already been falsified — it needs
 * the contrast that is actually load-bearing. `--arms baseline,reordered` halves the call
 * count, which matters because the prompt this measures is not frozen: mt#4289 changed how
 * a harness-written user line is labelled, so the corpus the model reads today is not the
 * one the original run read, and the comparison has to be re-taken rather than quoted.
 */
const SELECTED_ARMS: readonly Arm[] = (() => {
  const requested = parseStringArg("--arms", "");
  if (requested === "") return DEFAULT_ARMS;
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

/**
 * How many times each selected arm RUNS (mt#4409). 1 — the default — is the prior behavior.
 *
 * Validated here rather than through `parseIntArg`, which returns its fallback for anything
 * non-positive: `--replicate 0` would silently become 1 and the run would look like a normal
 * single-call run that measured no noise at all. Same reason a typo'd arm name throws.
 */
const REPLICATES: number = (() => {
  const raw = parseStringArg("--replicate", "1").trim();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== raw) {
    throw new Error(`--replicate must be a positive integer (got "${raw}")`);
  }
  return parsed;
})();

/** A registry arm as ACTUALLY RUN — the same configuration, plus which copy of it this is. */
interface RunArm extends Arm {
  /** The registry arm this run is a copy of. Identical across a replicate group. */
  baseName: string;
  /** 1-based; 1 is the original. Recorded per row, so nothing downstream parses a name. */
  replicateIndex: number;
}

/**
 * The arms this invocation actually calls, replicates expanded.
 *
 * The copies are minted by SPREADING the base arm and overriding only `name`, so
 * "identical in every dimension except the label" is guaranteed by construction — a
 * replicate cannot drift from its twin the way two hand-typed `--arms` entries could. That
 * matters because the replicate's whole job is to be a negative control: if the two arms
 * differ in any respect, the difference it measures is not noise.
 *
 * `--arms window-400,window-400` was already accepted and already issued two calls (names
 * resolve through `.map`, so duplicates survive). What it could not do is produce
 * DISTINGUISHABLE data: both rows carried `arm: "window-400"`, and the per-arm summary —
 * `rows.filter((r) => r.arm === arm.name)` — then scored each twin over the union of both.
 */
const ARMS: readonly RunArm[] = SELECTED_ARMS.flatMap((arm) =>
  Array.from({ length: REPLICATES }, (_unused, i) => ({
    ...arm,
    // `~2` rather than `-r2`: every registry name is hyphenated, so a hyphen suffix could be
    // mistaken for a registry arm, while `~` cannot appear in one.
    name: i === 0 ? arm.name : `${arm.name}~${i + 1}`,
    baseName: arm.name,
    replicateIndex: i + 1,
  }))
);

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

type Outcome =
  | {
      kind: "ok";
      findingCount: number;
      summaryChars: number;
      /**
       * The findings' labels, so the coverage comparison can be a SET comparison and not
       * only a count one (mt#4370 SC2). Two arms returning one finding each is compatible
       * with them agreeing and with them disagreeing completely, and a count cannot tell
       * those apart. Truncated because a label is free text and the row is a JSONL line.
       */
      findingLabels: string[];
    }
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
  /**
   * The registry arm this row's configuration came from (mt#4409).
   *
   * Equal to `arm` for a first call and to the twin's name for a replicate, so the analysis
   * can group a replicate pair WITHOUT parsing the `~2` suffix out of a name. Same discipline
   * as `mode` and `truncateChars` below: the grouping is read off the data, never off a
   * naming convention that a later arm could break.
   */
  armBase: string;
  /** Which call of the replicate group this is, 1-based. 1 on every non-replicate run. */
  replicateIndex: number;
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
  /**
   * The per-message truncation ACTUALLY used to render this row's prompt (mt#4370).
   *
   * Always the resolved number, never the arm's optional field — an arm that sets nothing
   * still ran at production's value, and recording `undefined` there would make the control
   * indistinguishable from a dataset predating this field. Same reason `mode` is recorded:
   * the analysis reads the dose off the DATA, never off an arm's name.
   */
  truncateChars: number;
  /**
   * Characters of TRANSCRIPT delivered, excluding the prompt's fixed scaffolding.
   *
   * `promptChars` above is the whole rendered prompt, so its floor under an aggressive
   * truncation is the scaffolding rather than zero. Recording both lets the dosage metric be
   * stated on either basis without re-running: transcript-only is the honest numerator for
   * "how much of the session did the model see", whole-prompt is what the size/compliance
   * result is a function of.
   */
  transcriptChars: number;
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

    // The window is selected ONCE per transcript and shared by every arm, so no arm can
    // differ by which messages it saw — only by how much of each one it was shown.
    const selected = selectAnalysisWindow(messages);
    const sampling = describeSampling(messages, selected);
    const fullWindow = sampling.analyzedMessages >= TRANSCRIPT_MESSAGE_CAP;

    // Rendered once PER DISTINCT TRUNCATION and reused by every arm that shares it.
    //
    // This is the pairing guarantee, narrowed rather than abandoned. It used to be "one
    // rendered prompt object per transcript, reused by all arms", which made a difference
    // between arms impossible to attribute to the input. A window arm varies the input by
    // definition (mt#4370), so the guarantee now holds WITHIN a truncation value and the
    // dose is what differs ACROSS values — which is the thing being measured, recorded on
    // every row. Arms that set no truncation still share one render with each other and
    // with `window-400`, exactly as before.
    const renderCache = new Map<number, { userPrompt: string; transcriptChars: number }>();
    const renderFor = (truncateChars: number): { userPrompt: string; transcriptChars: number } => {
      const cached = renderCache.get(truncateChars);
      if (cached) return cached;
      const userPrompt = __TEST_ONLY.buildUserPromptFromSelection(
        selected,
        sampling,
        { sessionId: conversationId },
        truncateChars
      );
      // The rendered transcript body, measured the way the prompt assembles it (one line per
      // selected message, newline-joined) rather than by subtracting a scaffolding constant —
      // a constant would silently go stale the next time the prompt's wording changes.
      const bodyLines = selected.map(({ message, index }) =>
        __TEST_ONLY.summarizeMessage(message, index, truncateChars)
      );
      const transcriptChars =
        bodyLines.reduce((acc, line) => acc + line.length, 0) + Math.max(0, bodyLines.length - 1);
      const rendered = { userPrompt, transcriptChars };
      renderCache.set(truncateChars, rendered);
      return rendered;
    };

    // Rotate which arm goes first, so no arm systematically occupies the position most
    // exposed to a rate-limit backoff or a provider-side warm-up.
    const offset = i % ARMS.length;
    const armOrder = [...ARMS.slice(offset), ...ARMS.slice(0, offset)];

    for (const arm of armOrder) {
      const truncateChars = arm.truncateChars ?? MESSAGE_TRUNCATE_CHARS;
      const { userPrompt, transcriptChars } = renderFor(truncateChars);
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
          findingLabels: result.findings.map((f) => {
            // Read defensively: the reply already passed the arm's schema, but `findings` is
            // typed `unknown[]` here and a label that came back as a non-string must render
            // as something inspectable rather than crash the run mid-corpus.
            const label = (f as { label?: unknown } | null)?.label;
            return safeTruncate(typeof label === "string" ? label : JSON.stringify(f), 160, "head");
          }),
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
        armBase: arm.baseName,
        replicateIndex: arm.replicateIndex,
        totalMessages: sampling.totalMessages,
        analyzedMessages: sampling.analyzedMessages,
        fullWindow,
        promptChars: userPrompt.length,
        // Read off the arm that was actually spread into the request, not off its name.
        mode: arm.mode ?? null,
        truncateChars,
        transcriptChars,
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
    const accepted = armRows.filter((r) => r.outcome.kind === "ok");
    const findingsTotal = accepted.reduce(
      (acc, r) => acc + (r.outcome.kind === "ok" ? r.outcome.findingCount : 0),
      0
    );
    return {
      arm: arm.name,
      attempted: armRows.length,
      ok: accepted.length,
      // mt#4370's coverage side, reported in the same object as the compliance side so a
      // paste of this summary cannot show one dimension of the trade without the other.
      truncateChars: [...new Set(armRows.map((r) => r.truncateChars))],
      transcriptCharsDelivered: armRows.reduce((acc, r) => acc + r.transcriptChars, 0),
      promptCharsDelivered: armRows.reduce((acc, r) => acc + r.promptChars, 0),
      findingsPerAcceptedRun:
        accepted.length === 0 ? null : Number((findingsTotal / accepted.length).toFixed(4)),
      findingBearingAcceptedRuns: `${accepted.filter((r) => r.outcome.kind === "ok" && r.outcome.findingCount > 0).length}/${accepted.length}`,
      schemaViolations: violations.length,
      // Reported separately and NEVER folded into the violation count: a provider or
      // transport failure says nothing about whether the model complied with the schema.
      callErrors: callErrors.length,
      missingFieldBreakdown: byField,
      fullWindowViolations: `${full.filter((r) => r.outcome.kind === "schema-violation").length}/${full.length}`,
      partialWindowViolations: `${partial.filter((r) => r.outcome.kind === "schema-violation").length}/${partial.length}`,
    };
  });

  // Dosage: delivered characters per arm as a fraction of PRODUCTION's truncation, which is
  // mt#4370's certain coverage metric — computed locally, guaranteed non-zero when the dose
  // differs, and therefore not reachable by the "coverage unchanged" reading that a metric
  // invariant by construction would have produced.
  //
  // The reference is the arm that ran at `MESSAGE_TRUNCATE_CHARS`. If no arm did, dosage is
  // reported as unavailable rather than re-based on the largest arm present: a ratio against
  // a substitute denominator is a different quantity wearing the same name.
  const referenceRows = rows.filter((r) => r.truncateChars === MESSAGE_TRUNCATE_CHARS);
  const dosage =
    referenceRows.length === 0
      ? `unavailable — no arm ran at production's ${MESSAGE_TRUNCATE_CHARS}, so there is no reference dose`
      : Object.fromEntries(
          ARMS.map((arm) => {
            // BOTH sides restricted to the transcripts the arm and the reference share
            // (PR #3225 R1). Restricting only the denominator was the original shape, and it
            // is a ratio between two different populations the moment the two sets diverge —
            // which they do the instant any transcript fails to produce a row for one arm.
            // Today every arm answers every usable transcript so the sets coincide and the
            // number is right; a ratio that is only right when nothing goes wrong is the
            // thing worth fixing, since a divergence here would move the dose silently and
            // the dose is what the whole trade is denominated in.
            const refIds = new Set(referenceRows.map((r) => r.conversationId));
            const armRows = rows.filter((r) => r.arm === arm.name && refIds.has(r.conversationId));
            // Per-transcript, not per-row: arms can differ in how many rows they produced.
            const ids = new Set(armRows.map((r) => r.conversationId));
            const refShared = referenceRows.filter((r) => ids.has(r.conversationId));
            const sum = (rs: ResultRow[], f: (r: ResultRow) => number): number =>
              rs.reduce((acc, r) => acc + f(r), 0);
            const refTranscript = sum(refShared, (r) => r.transcriptChars);
            const refPrompt = sum(refShared, (r) => r.promptChars);
            // Surfaced rather than absorbed: a dose computed over fewer transcripts than the
            // arm actually ran is still a valid ratio, but the reader must be able to see
            // that it was.
            const armRowCount = rows.filter((r) => r.arm === arm.name).length;
            return [
              arm.name,
              {
                truncateChars: arm.truncateChars ?? MESSAGE_TRUNCATE_CHARS,
                pairedTranscripts: armRows.length,
                ...(armRows.length === armRowCount
                  ? {}
                  : { droppedUnpairedRows: armRowCount - armRows.length }),
                transcriptDosage:
                  refTranscript === 0
                    ? null
                    : Number((sum(armRows, (r) => r.transcriptChars) / refTranscript).toFixed(4)),
                promptDosage:
                  refPrompt === 0
                    ? null
                    : Number((sum(armRows, (r) => r.promptChars) / refPrompt).toFixed(4)),
              },
            ];
          })
        );

  // The replicate group's own receipt (mt#4409). Two things a reader must be able to SEE
  // rather than infer: that each copy produced its own rows (a collapsed pair shows as a
  // halved count, not as a plausible-looking table), and that the twins were handed the same
  // prompt. The second is guaranteed by `renderFor`'s memo — which is exactly why it is worth
  // asserting on the data instead of trusting the mechanism, since a future edit to the
  // render path would break the replicate silently and nothing else would notice.
  const replicateIdentity = (() => {
    const bases = [...new Set(ARMS.filter((a) => a.replicateIndex > 1).map((a) => a.baseName))];
    if (bases.length === 0) return null;
    return bases.map((base) => {
      const names = ARMS.filter((a) => a.baseName === base).map((a) => a.name);
      const byConversation = new Map<string, ResultRow[]>();
      for (const r of rows) {
        if (!names.includes(r.arm)) continue;
        const bucket = byConversation.get(r.conversationId) ?? [];
        bucket.push(r);
        byConversation.set(r.conversationId, bucket);
      }
      const complete = [...byConversation.values()].filter((rs) => rs.length === names.length);
      const identical = complete.filter((rs) => {
        const first = rs[0];
        if (!first) return false;
        return rs.every(
          (r) =>
            r.truncateChars === first.truncateChars &&
            r.mode === first.mode &&
            r.promptChars === first.promptChars
        );
      });
      return {
        base,
        arms: names,
        rowsPerArm: Object.fromEntries(
          names.map((n) => [n, rows.filter((r) => r.arm === n).length])
        ),
        completeTuples: complete.length,
        // AT1's check, computed rather than asserted in prose: every paired row identical on
        // the three dimensions that define the configuration actually sent.
        identicalPromptRender: `${identical.length}/${complete.length}`,
      };
    });
  })();

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
          dosage,
          ...(replicateIdentity === null ? {} : { replicateIdentity }),
        },
      },
      null,
      2
    )
  );
  console.log(`\nrows written to ${outPath}`);
}

await main();
