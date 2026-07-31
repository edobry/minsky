/**
 * Raw (uncalibrated) LLM-judge pass for the reviewer benchmark (mt#2726
 * Milestone A, wave 3).
 *
 * Scores individual corpus findings for validity via a cross-provider panel
 * (2-3 diverse provider/model configs, reusing `providers.ts`'s
 * `callReviewer()` multi-provider dispatch) and selects the
 * disagreement-weighted subset that mt#2746's human-labeling pass consumes.
 *
 * UNCALIBRATED / PROVISIONAL: this module makes no kappa or trust claim.
 * Calibration against mt#2746's returned human labels is Milestone B
 * (mt#2991) — see the mt#2726 spec's "Out of scope" section.
 */

import { safeTruncate } from "@minsky/shared/safe-truncate";
import type { ReviewerConfig } from "./config";
import { callReviewer, type ReviewOutput } from "./providers";
import type { CorpusFinding, CorpusLabel, CorpusRow } from "./eval-corpus";
import type { FindingVerdict } from "./eval-metrics";

// ---------------------------------------------------------------------------
// Judge model configuration
// ---------------------------------------------------------------------------

/** One judge in the panel: a provider/model pair plus its resolved API key.
 * Callers build this list (2-3 diverse provider/model configs per the
 * mt#2726 spec) — this module doesn't resolve env vars itself, so it stays
 * testable without touching `process.env`. */
export interface JudgeModelConfig {
  provider: ReviewerConfig["provider"];
  model: string;
  apiKey: string;
}

// ---------------------------------------------------------------------------
// Per-judge + aggregate verdict shapes
// ---------------------------------------------------------------------------

export interface PerJudgeVerdict {
  provider: ReviewerConfig["provider"];
  model: string;
  verdict: FindingVerdict;
  rationale: string;
  /** Set when the judge's response text didn't match the expected
   * VERDICT/RATIONALE format (or the call itself failed) and a conservative
   * default had to be used instead. Absent on a clean parse. */
  parseError?: string;
}

export interface JudgeResult {
  /** Aggregate verdict across the panel — see `aggregateVerdicts` for the
   * majority-vote-with-median-tiebreak rule. UNCALIBRATED / PROVISIONAL. */
  verdict: FindingVerdict;
  perJudge: PerJudgeVerdict[];
  /** True only when every judge in the panel returned the identical
   * verdict. */
  agreement: boolean;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM_PROMPT = `You are an independent judge evaluating a code-review finding for validity. You did NOT raise this finding — a different reviewer did — and you are checking whether it holds up, not re-reviewing the whole diff.

Given the finding text and the surrounding code context, decide: is this a real, valid issue?

- BUG_HIT: the finding correctly identifies a real bug or defect in the code.
- VALID: the finding is a legitimate, non-bug observation (e.g. a style or clarity nit) — not a bug, but not noise either.
- NOISE: the finding is spurious — it does not hold up against the code context shown (a false positive).

This is a RAW, uncalibrated judgment. You have no access to any human label or ground truth for this finding — judge only from the finding text and the code context provided below.

Respond with EXACTLY two lines and nothing else:
VERDICT: BUG_HIT|VALID|NOISE
RATIONALE: <one-line rationale, no line breaks>`;

function buildJudgeUserPrompt(finding: CorpusFinding, codeContextWindow: string): string {
  const lineDescriptor =
    finding.line !== undefined
      ? `Line: ${finding.line}${
          finding.lineEnd !== undefined && finding.lineEnd !== finding.line
            ? `-${finding.lineEnd}`
            : ""
        }`
      : "Line: (unspecified)";

  return [
    "## Finding",
    `File: ${finding.file}`,
    `Severity: ${finding.severity}`,
    lineDescriptor,
    "",
    finding.text,
    "",
    "## Code context",
    "```",
    codeContextWindow,
    "```",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Response parsing (trust boundary — model output is untrusted free text)
// ---------------------------------------------------------------------------

const VALID_VERDICTS: ReadonlySet<string> = new Set(["BUG_HIT", "VALID", "NOISE"]);

/**
 * Parse a judge model's raw text response into a verdict + rationale.
 * Defensive: model output is untrusted free text (this judge pass does not
 * use structured tool calls — see `judgeFinding`), so a missing or
 * malformed VERDICT line must not throw. Falls back to `VALID` — the
 * deliberately non-extreme default, since it counts as neither a positive
 * nor negative match in `judgeVerdictDisagreesWithLabel` below — with
 * `parseError` set so the degraded parse is visible to callers.
 *
 * Pure. Exported for tests.
 */
export function parseJudgeResponseText(text: string): {
  verdict: FindingVerdict;
  rationale: string;
  parseError?: string;
} {
  const verdictMatch = text.match(/VERDICT:\s*(BUG_HIT|VALID|NOISE)/i);

  if (!verdictMatch) {
    const preview = safeTruncate(text.trim(), 200, "head");
    return {
      verdict: "VALID",
      rationale: preview || "(empty response)",
      parseError: "no VERDICT line found in judge response",
    };
  }

  const rawVerdict = verdictMatch[1]?.toUpperCase() ?? "";
  const verdict: FindingVerdict = VALID_VERDICTS.has(rawVerdict)
    ? (rawVerdict as FindingVerdict)
    : "VALID";

  const rationaleMatch = text.match(/RATIONALE:\s*(.+)/i);
  const rationale = rationaleMatch?.[1]?.trim() || "(no rationale provided)";

  return { verdict, rationale };
}

// ---------------------------------------------------------------------------
// Aggregation — median/majority vote (not mean)
// ---------------------------------------------------------------------------

/**
 * Ordinal ranking used ONLY for the median tie-break below — not a claim
 * that the `FindingVerdict` taxonomy is a linear scale. Ordered by "how
 * confirmed-real is this finding": NOISE < VALID < BUG_HIT.
 */
const VERDICT_ORDER: readonly FindingVerdict[] = ["NOISE", "VALID", "BUG_HIT"];

/**
 * Aggregate a panel of per-judge verdicts into one verdict, per the mt#2726
 * spec's "robust central-tendency vote (median vote, not mean)" instruction:
 *
 *   1. Plurality (majority) vote: the verdict with the most votes wins.
 *   2. Tie-break: when two or more verdicts are tied for the plurality,
 *      resolve via the ORDINAL MEDIAN of the FULL vote list (not just the
 *      tied subset) — sort votes by `VERDICT_ORDER`, take the LOWER of the
 *      two middle elements for an even-length panel. "Lower" is a
 *      deliberate conservative choice: it doesn't let a split panel default
 *      toward over-crediting a finding as more "real" than the votes
 *      actually support.
 *
 * A categorical taxonomy has no meaningful arithmetic mean; "majority vote,
 * median-broken" is what the spec's "median/majority" phrasing operationalizes
 * for a 2-3-judge panel — outlier-robust without requiring an odd panel size.
 *
 * Pure. Exported for tests.
 */
export function aggregateVerdicts(verdicts: readonly FindingVerdict[]): FindingVerdict {
  if (verdicts.length === 0) return "VALID";

  const counts = new Map<FindingVerdict, number>();
  for (const v of verdicts) counts.set(v, (counts.get(v) ?? 0) + 1);

  const maxCount = Math.max(...counts.values());
  const plurality = VERDICT_ORDER.filter((v) => (counts.get(v) ?? 0) === maxCount);

  if (plurality.length === 1) {
    return plurality[0] ?? "VALID";
  }

  const sortedOrdinals = verdicts.map((v) => VERDICT_ORDER.indexOf(v)).sort((a, b) => a - b);
  const midIndex = Math.floor((sortedOrdinals.length - 1) / 2);
  const ordinal = sortedOrdinals[midIndex] ?? 1;
  return VERDICT_ORDER[ordinal] ?? "VALID";
}

// ---------------------------------------------------------------------------
// Live judge call (network — not exercised by unit tests; reuses callReviewer)
// ---------------------------------------------------------------------------

/**
 * Build a minimal `ReviewerConfig` for a judge call. Only the fields
 * `callReviewer` actually reads (provider, providerApiKey, providerModel,
 * modelTimeoutMs) matter; the rest are unused placeholders — this module
 * never boots the reviewer server or authenticates as the GitHub App.
 */
function buildJudgeReviewerConfig(judgeConfig: JudgeModelConfig): ReviewerConfig {
  return {
    appId: 0,
    privateKey: "",
    installationId: 0,
    webhookSecret: "",
    provider: judgeConfig.provider,
    providerApiKey: judgeConfig.apiKey,
    providerModel: judgeConfig.model,
    tier2Enabled: false,
    mcpUrl: undefined,
    mcpToken: undefined,
    port: 0,
    logLevel: "info",
    modelTimeoutMs: 120_000,
    githubTimeoutMs: 120_000,
  };
}

async function callOneJudge(
  judgeConfig: JudgeModelConfig,
  userPrompt: string
): Promise<PerJudgeVerdict> {
  const config = buildJudgeReviewerConfig(judgeConfig);
  try {
    // No `tools` argument: a single plain-text completion per judge, not the
    // multi-round tool-use loop the production reviewer runs — the judge
    // question ("is this finding real?") needs one text response, not
    // structured findings.
    const output: ReviewOutput = await callReviewer(config, JUDGE_SYSTEM_PROMPT, userPrompt);
    const parsed = parseJudgeResponseText(output.text);
    return {
      provider: judgeConfig.provider,
      model: judgeConfig.model,
      verdict: parsed.verdict,
      rationale: parsed.rationale,
      ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      provider: judgeConfig.provider,
      model: judgeConfig.model,
      verdict: "VALID",
      rationale: "(judge call failed)",
      parseError: `judge call error: ${message}`,
    };
  }
}

/**
 * Judge one finding across a panel of 2-3 diverse provider/model configs
 * (per the mt#2726 spec: "2-3 diverse provider/model configs, robust
 * central-tendency vote"). Calls `callReviewer()` in parallel across
 * `configs`, parses each response, and aggregates via `aggregateVerdicts`.
 *
 * UNCALIBRATED / PROVISIONAL — no kappa or trust claim; see module
 * docstring. Not unit-tested directly (live network call); the pure
 * building blocks (`parseJudgeResponseText`, `aggregateVerdicts`,
 * `findDisagreementWeightedSubset`) are.
 */
export async function judgeFinding(
  finding: CorpusFinding,
  codeContextWindow: string,
  configs: readonly JudgeModelConfig[]
): Promise<JudgeResult> {
  const userPrompt = buildJudgeUserPrompt(finding, codeContextWindow);
  const perJudge = await Promise.all(configs.map((c) => callOneJudge(c, userPrompt)));

  const verdict = aggregateVerdicts(perJudge.map((j) => j.verdict));
  const firstVerdict = perJudge[0]?.verdict;
  const agreement = perJudge.every((j) => j.verdict === firstVerdict);

  return { verdict, perJudge, agreement };
}

// ---------------------------------------------------------------------------
// Disagreement-weighted subset selection (pure, unit-tested)
// ---------------------------------------------------------------------------

/**
 * A ground-truth label is "positive" when its confidence tag is `gold` or
 * `noisy-positive` — mirrors the identical convention documented in
 * `scripts/paired-eval-runner.ts`'s `isPositiveGroundTruth` (kept as a
 * separate local function since the two modules don't share a boundary, but
 * the reasoning is the same: `confidence` is the corpus schema's intended
 * positive/negative discriminator, not `label.value`).
 */
function isPositiveLabel(label: CorpusLabel): boolean {
  return label.confidence === "gold" || label.confidence === "noisy-positive";
}

/**
 * Whether a judge panel's AGGREGATE verdict disagrees with a row's
 * deterministic label. Disagreement is a POLARITY conflict, not mere
 * non-identity:
 *
 *   - positive label (git-diff-fixed / injected-exact) + judge verdict
 *     NOISE -> disagreement (the judge thinks it's spurious; deterministic
 *     mining says the underlying issue was real).
 *   - negative label (dismissed-no-change / carried-forward-unchanged) +
 *     judge verdict BUG_HIT -> disagreement (the judge thinks it's a
 *     confirmed bug; deterministic mining says it was dismissed / never
 *     addressed).
 *   - a VALID judge verdict never counts as disagreement against either
 *     polarity — VALID is a legitimate middle ground ("not a bug, but not
 *     noise either"), not a contradiction of either label.
 *
 * Pure. Exported for tests.
 */
export function judgeVerdictDisagreesWithLabel(
  verdict: FindingVerdict,
  label: CorpusLabel
): boolean {
  if (isPositiveLabel(label)) return verdict === "NOISE";
  return verdict === "BUG_HIT";
}

/**
 * Select the disagreement-weighted subset of corpus rows: rows where the
 * judge PANEL disagrees among itself (not unanimous, i.e. `!agreement`) OR
 * the judge panel's AGGREGATE verdict disagrees with the row's own
 * deterministic label (per `judgeVerdictDisagreesWithLabel`). This is the
 * exact ~40-finding subset mt#2746's human-labeling pass consumes — the
 * residual slice deterministic labels plus a single judge pass can't
 * resolve confidently.
 *
 * `rows` and `judgeResults` must be the same length, index-aligned: one
 * `JudgeResult` per `CorpusRow`, produced by a prior `judgeFinding` call per
 * row (the live judge calls are a separate concern from this pure selection
 * logic — callers run `judgeFinding` over `rows` first, then pass the
 * results here). A length mismatch is handled defensively: only the
 * overlapping prefix is scored, matching `scoreModelFindings`'s
 * `noUncheckedIndexedAccess`-safe indexing convention in
 * `paired-eval-runner.ts`.
 *
 * Pure. Exported for tests.
 */
export function findDisagreementWeightedSubset(
  rows: readonly CorpusRow[],
  judgeResults: readonly JudgeResult[]
): CorpusRow[] {
  const selected: CorpusRow[] = [];
  const n = Math.min(rows.length, judgeResults.length);

  for (let i = 0; i < n; i++) {
    const row = rows[i];
    const result = judgeResults[i];
    if (row === undefined || result === undefined) continue;

    const panelDisagrees = !result.agreement;
    const disagreesWithLabel = judgeVerdictDisagreesWithLabel(result.verdict, row.label);

    if (panelDisagrees || disagreesWithLabel) {
      selected.push(row);
    }
  }

  return selected;
}
