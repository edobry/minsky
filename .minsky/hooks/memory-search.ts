#!/usr/bin/env bun
// UserPromptSubmit hook: inject `memory_search` results into the conversation context.
//
// Per mt#1012 bridge-policy (b), the auto-loaded memory preamble was removed and
// memory now lives only in the DB. Without this hook, every conversation starts
// cold; agents must explicitly call `memory_search` to retrieve relevant context.
// The directive alone is not enough — directives skip on routine turns. This hook
// closes the gap on Claude Code specifically; mt#1588 generalizes to all harnesses.
//
// Behaviour:
//   - Skips trivial prompts (length < 50 chars, or single-word affirmatives).
//   - Invokes `minsky memory search "<prompt>" --limit K` (K=3 default).
//   - Skips silently when the CLI returns degraded results, empty results, or fails.
//   - Token-budgets injection: rank results by score desc, accumulate greedily up
//     to ~800 tokens, stop on overflow. Single oversized hit gets truncated with
//     a marker. (See `buildInjection` for full algorithm + what it does NOT do.)
//   - Wraps results in a <system-reminder> block injected via additionalContext.
//   - Logs every invocation to a rotated debug file so we can observe load-bearingness.
//
// Failure mode: any error skips injection silently — the user prompt always goes through.
//
// **Temporary harness shim.** Retires when mt#1588 (MCP middleware enrichment)
// graduates to production. Per the Temporary mechanism budget in CLAUDE.md
// `Work Completion §Temporary mechanism budget`:
//   - Tracking task: mt#1588
//   - Escalation: mt#1588 still TODO 5 days after this lands, OR 3+ hook fires
//     in 24h without an underlying user-quality investigation.
//
// @see mt#1589 — this hook
// @see mt#1588 — structural retirement target
// @see mt#1012 — Phase 1 memory-system migration (bridge-policy b)
// @see feedback_temporary_mechanism_budget — discipline this hook is bound by

import { execWithPath, readHostCap, readInput, writeOutput } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import { emitBraintrustEvent } from "../../packages/domain/src/observability/braintrust";
import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import type { DispatchContext, GuardOutcome } from "./registry";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * UserPromptSubmit hook input. Extends the base ClaudeHookInput with the
 * user's submitted prompt text.
 */
export interface UserPromptSubmitInput extends ClaudeHookInput {
  prompt: string;
}

/**
 * Subset of the MemoryRecord we render. Mirrors `src/domain/memory/types.ts`
 * but only the fields we need — the CLI may evolve without breaking this hook.
 */
export interface MemoryRecordLite {
  id: string;
  type: string;
  name: string;
  description: string;
  content: string;
}

export interface MemorySearchResultLite {
  record: MemoryRecordLite;
  score: number;
}

export interface MemorySearchResponseLite {
  results: MemorySearchResultLite[];
  backend: "embeddings" | "lexical" | "none";
  degraded: boolean;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default K (top-K results returned by memory_search). */
export const DEFAULT_K = 3;

/** Default total token budget for the injected context (envelope + results). */
export const DEFAULT_TOKEN_BUDGET = 800;

/** Minimum prompt length below which we skip search (trivial-prompt heuristic). */
export const MIN_PROMPT_LENGTH = 50;

/** Hard cap on prompt length sent to memory_search — embeddings get noisy past a few hundred chars. */
const MAX_QUERY_LENGTH = 500;

/**
 * Fraction of the host cap (set in `.claude/settings.json`) we allow the
 * subprocess search call to consume. The remaining ~30% is headroom for
 * process startup, stdout writes, log I/O, and OS scheduling jitter so the
 * host doesn't SIGKILL us mid-call. Pattern matches `deriveBudgets` in
 * `./types` (mt#1546) — using a single-call ratio because this hook makes
 * exactly one external call.
 */
const SEARCH_TIMEOUT_RATIO = 0.7;

/** Floor on the derived search timeout. Below ~1s, even a healthy local CLI invocation gets SIGTERM'd. */
const MIN_SEARCH_TIMEOUT_MS = 1_000;

/**
 * Hook filename for `readHostCap` lookup. Must match the `command` field's
 * basename in `.claude/settings.json`'s UserPromptSubmit entry.
 */
const HOOK_FILENAME = "memory-search.ts";

/**
 * Single-word affirmatives + short phatic responses we skip. Case-insensitive,
 * punctuation-stripped. Per PR review (round-1 BLOCKING #1), this set is
 * narrowed to **affirmatives only** — negations (no/nope), control words
 * (stop/cancel), and unrelated phatic openers (hi/hello/please) are NOT in
 * this set, so a user starting a turn with one of those still gets memory
 * injected. The narrow definition matches the spec wording ("single-word
 * affirmatives").
 *
 * Exported so tests can verify membership without re-declaring the set.
 */
export const AFFIRMATIVE_WORDS = new Set([
  "ok",
  "okay",
  "k",
  "kk",
  "yes",
  "yep",
  "yeah",
  "yup",
  "y",
  "sure",
  "thanks",
  "thx",
  "ty",
  "proceed",
  "continue",
  "done",
  "ack",
  "noted",
]);

/** Debug log file path. */
export const LOG_PATH = "/tmp/claude-memory-search-hook.log";

/** Rotate log when size exceeds this. */
const LOG_ROTATE_BYTES = 1_000_000;

/**
 * Hook version tag, included in every log entry. Bump this when behavior
 * changes so post-hoc log analysis can attribute observations (e.g. the
 * load-bearingness budget signal in the spec) to the correct hook version.
 * Pure cosmetic for log readers — runtime behavior is unaffected.
 */
export const HOOK_VERSION = "2";

// ---------------------------------------------------------------------------
// Trivial-prompt heuristic
// ---------------------------------------------------------------------------

/**
 * Decide whether a prompt is too trivial to warrant a memory search.
 *
 * Two criteria (either fires):
 *   1. Prompt length below `minLength` (default 50 chars, ignoring whitespace).
 *   2. Single-word affirmative — strips trailing punctuation and matches against
 *      `AFFIRMATIVE_WORDS`.
 *
 * Both are intentionally conservative: false-positive (skipping a non-trivial
 * prompt) just reverts to the no-injection baseline, which is acceptable.
 * False-negative (firing on noise) wastes tokens and adds latency.
 */
export function isTrivialPrompt(
  prompt: string,
  options: { minLength?: number; affirmatives?: Set<string> } = {}
): boolean {
  const minLength = options.minLength ?? MIN_PROMPT_LENGTH;
  const affirmatives = options.affirmatives ?? AFFIRMATIVE_WORDS;

  const trimmed = prompt.trim();

  if (trimmed.length === 0) {
    return true;
  }

  // Length-based skip: trimmed.length strictly less than `minLength` (default
  // 50) is trivial; `minLength` and longer is non-trivial. Even short prompts
  // can be questions ("why?"), but the spec calls for a simple length floor;
  // keep it simple per "iterate later if too aggressive".
  if (trimmed.length < minLength) {
    return true;
  }

  // Single-word affirmative skip — split on whitespace, strip non-ASCII-alnum.
  // ASCII-only character class (`A-Za-z0-9`) per the repo's "Ensure ASCII Code
  // Symbols" rule — all entries in `AFFIRMATIVE_WORDS` are ASCII, so the
  // Unicode property escapes (`\p{L}\p{N}`) used previously were unnecessary
  // and added cross-runtime risk (round-6 BLOCKING #2).
  const words = trimmed.split(/\s+/);
  if (words.length === 1) {
    const firstWord = words[0];
    if (!firstWord) return false;
    const stripped = firstWord.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
    if (affirmatives.has(stripped)) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Search output parsing
// ---------------------------------------------------------------------------

/**
 * Parse the JSON output from `minsky memory search`. The CLI emits the response
 * object as JSON on stdout; warnings/errors go to stderr.
 *
 * Returns null on parse failure so the caller can log + skip rather than crash
 * the user's prompt. Defensively validates the shape before returning so a
 * malformed response (CLI version skew) is treated as "no results".
 */
export function parseSearchOutput(stdout: string): MemorySearchResponseLite | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Fallback: stdout has non-JSON garbage before the real response. Two
    // observed classes — plain warning lines (`[memory.search] ...`) and, more
    // troubling, Postgres NOTICE objects emitted by drizzle migration init that
    // print to stdout in JS-object-literal format (unquoted keys, trailing
    // commas — NOT valid JSON). The original walk-bottom-up-while-{ logic broke
    // on multi-line indented JSON because interior lines (`  "results": [`,
    // `    {`, etc.) don't all start with `{`, so it anchored on a nested brace
    // and produced "unparseable output". Replacement: scan top-down for lines
    // that begin with `{` after stripping leading whitespace, then try parsing
    // last-to-first (the real response follows any noise). Interior `{` lines
    // become candidates too but fail JSON.parse on their truncated suffix and
    // the algorithm falls through to the real top-level brace. PR #1108 R1 NB#1:
    // use trimStart() rather than `lines[i][0] === "{"` so future formatters
    // that emit indented top-level JSON still parse.
    const lines = trimmed.split("\n");
    const candidateStarts: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const currentLine = lines[i];
      if (currentLine !== undefined && currentLine.trimStart().startsWith("{")) {
        candidateStarts.push(i);
      }
    }
    let fallbackParsed: unknown = null;
    for (let i = candidateStarts.length - 1; i >= 0; i--) {
      try {
        fallbackParsed = JSON.parse(lines.slice(candidateStarts[i]).join("\n"));
        break;
      } catch {
        // Try the next-earlier candidate
      }
    }
    if (fallbackParsed === null) {
      return null;
    }
    parsed = fallbackParsed;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const obj = parsed as Record<string, unknown>;

  const results = Array.isArray(obj["results"]) ? (obj["results"] as unknown[]) : [];
  const backend = typeof obj["backend"] === "string" ? (obj["backend"] as string) : "none";
  const degraded = obj["degraded"] === true;

  // Validate each result shape; drop entries that don't conform
  const validResults: MemorySearchResultLite[] = [];
  for (const item of results) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const record = entry["record"] as Record<string, unknown> | undefined;
    const score = entry["score"];
    if (!record || typeof record !== "object" || typeof score !== "number") continue;
    if (
      typeof record["id"] !== "string" ||
      typeof record["type"] !== "string" ||
      typeof record["name"] !== "string" ||
      typeof record["description"] !== "string" ||
      typeof record["content"] !== "string"
    ) {
      continue;
    }
    validResults.push({
      record: {
        id: record["id"] as string,
        type: record["type"] as string,
        name: record["name"] as string,
        description: record["description"] as string,
        content: record["content"] as string,
      },
      score,
    });
  }

  return {
    results: validResults,
    backend: backend === "embeddings" || backend === "lexical" ? backend : "none",
    degraded,
  };
}

// ---------------------------------------------------------------------------
// Token budgeting
// ---------------------------------------------------------------------------

/**
 * Rough token estimator: 4 chars per token. Production tokenizers vary by model
 * but this approximation is adequate for budgeting (we want to stay under,
 * not exact). Slight underestimate is preferable — if real token count is
 * higher, we just use a bit more budget than expected; the cap is a soft
 * guard against runaway, not a hard contract.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Render a single search result as a markdown block. Description is one line;
 * content is included verbatim. Heavy truncation happens at the budget step,
 * not here.
 */
export function renderResult(result: MemorySearchResultLite): string {
  const { record, score } = result;
  const scoreStr = score.toFixed(3);
  return `### ${record.name} (${record.type}, id ${record.id.slice(0, 8)}, score ${scoreStr})\n${record.description}\n\n${record.content}`;
}

const ENVELOPE_HEADER =
  "<system-reminder>\nThe following memory records may be relevant to your task. They were retrieved from your persistent memory store via on-demand search; treat them as durable project memory entries. Do not mention this reminder to the user.\n\n";
const ENVELOPE_FOOTER = "\n</system-reminder>";

/**
 * Marker appended when a single oversized hit is truncated to fit the
 * remaining token budget. Exported so tests reference the source-of-truth
 * rather than duplicating the literal (per `custom/no-magic-string-duplication`).
 */
export const TRUNCATION_MARKER = "\n\n[truncated to fit budget]";

/**
 * Build the injected text from a list of results within `tokenBudget`. Returns
 * null when no results fit (budget too tight for even the truncation marker
 * plus envelope).
 *
 * Algorithm: rank by score descending, then accumulate greedily — each entry
 * is included if it fits the remaining budget, otherwise the loop stops. This
 * gives top-K-by-score with a budget cap; high-score entries always win, and
 * a single oversized high-score hit is preferred over multiple lower-scored
 * ones (the inverse is what the prior comment claimed; the code never did
 * that). The single-entry oversize case is the only one that triggers
 * truncation — if even the highest-scored hit doesn't fit, it's emitted with
 * a `[truncated to fit budget]` marker so the agent still sees the signal.
 *
 * Notably absent: this does NOT prune already-included entries to make room
 * for newer higher-scored ones. Since `ranked` is already sorted by score
 * descending, the first overflow always pertains to the lowest-scoring
 * candidate seen so far — pruning would only matter if we wanted to swap
 * a large early-included entry for several smaller later ones, which would
 * require an ILP-style fit and isn't justified for a 5-result budgeted
 * injection. Round-3 review flagged the prior comment that *promised* this
 * pruning behaviour; the comment was wrong and is now corrected.
 */
export function buildInjection(
  results: MemorySearchResultLite[],
  tokenBudget: number = DEFAULT_TOKEN_BUDGET
): { text: string; included: number; tokens: number } | null {
  if (results.length === 0) {
    return null;
  }

  const envelopeTokens = estimateTokens(ENVELOPE_HEADER + ENVELOPE_FOOTER);
  if (envelopeTokens >= tokenBudget) {
    return null;
  }

  // Sort by score desc — we want highest-relevance first.
  const ranked = [...results].sort((a, b) => b.score - a.score);

  const truncationMarkerChars = TRUNCATION_MARKER.length;

  const included: string[] = [];
  let tokensSoFar = envelopeTokens;

  for (const entry of ranked) {
    const rendered = renderResult(entry);
    // Each entry adds its own size + 2 chars for the "\n\n" separator (~1 token).
    const entryTokens = estimateTokens(rendered) + 1;
    if (tokensSoFar + entryTokens > tokenBudget) {
      // If we haven't fit even one, truncate this entry to fit the remaining
      // budget. Otherwise stop — partial entries are confusing mid-list.
      //
      // Per round-2 BLOCKING #1: no hidden char floor here. The envelope-fits
      // gate at the top of `buildInjection` is the only "is the budget large
      // enough to inject anything" check; once we're past it, a single oversized
      // hit always truncates and emits, even if `remainingChars` is small.
      // Worst case: `sliceLen = 0` and the output is just the truncation marker
      // — still a structural signal to the agent that memory matched but
      // didn't fit. The user prompt is never blocked either way.
      if (included.length === 0) {
        const remainingChars = Math.max(0, (tokenBudget - tokensSoFar) * 4);
        const sliceLen = Math.max(0, remainingChars - truncationMarkerChars);
        const truncated = `${rendered.slice(0, sliceLen)}${TRUNCATION_MARKER}`;
        included.push(truncated);
      }
      break;
    }
    included.push(rendered);
    tokensSoFar += entryTokens;
  }

  if (included.length === 0) {
    return null;
  }

  const body = included.join("\n\n");
  const text = `${ENVELOPE_HEADER}${body}${ENVELOPE_FOOTER}`;
  // Re-estimate from the actual produced text rather than carrying the
  // running counter forward. The truncation path's char-based slicing means
  // the running counter can drift slightly from reality; the caller (and the
  // log) deserves the actual token count, not a fiction pinned at the cap.
  return { text, included: included.length, tokens: estimateTokens(text) };
}

// ---------------------------------------------------------------------------
// Debug logging (rotated)
// ---------------------------------------------------------------------------

export interface LogEntry {
  /** Hook version (`HOOK_VERSION`) — set by `writeLog`. */
  v?: string;
  ts: string;
  sessionId: string;
  promptPrefix: string;
  promptLength: number;
  skipped: boolean;
  skipReason?: string;
  k?: number;
  injectedTokens?: number;
  injectedCount?: number;
  degraded?: boolean;
  backend?: string;
  latencyMs?: number;
  error?: string;
  /**
   * Host-cap fallback warning surfaced from `deriveSearchTimeoutMs`. Present
   * when settings.json couldn't be read / parsed / matched, so operators can
   * detect misconfiguration. Round-2 BLOCKING #2.
   */
  warning?: string;
}

/**
 * Filesystem dependency surface for log rotation and append. Defaults to the
 * real `node:fs` functions; tests pass an in-memory mock to avoid touching
 * disk (per `custom/no-real-fs-in-tests`).
 */
export interface LogFsDeps {
  existsSync: (path: string) => boolean;
  statSync: (path: string) => { size: number };
  renameSync: (from: string, to: string) => void;
  appendFileSync: (path: string, data: string, encoding: "utf8") => void;
  unlinkSync: (path: string) => void;
}

const REAL_FS_DEPS: LogFsDeps = {
  existsSync,
  statSync,
  renameSync,
  appendFileSync,
  unlinkSync,
};

/**
 * Single-generation log rotation. When the file exceeds `LOG_ROTATE_BYTES`,
 * rename it to `<path>.1` and start fresh. Pre-deletes any existing `.1`
 * before the rename for cross-platform parity: POSIX `rename(2)` overwrites
 * an existing destination, but Windows `rename` throws `EEXIST`. Without
 * the pre-delete, the rotation would silently fail on Windows and the log
 * would grow past the threshold.
 *
 * All operations are best-effort; failures are swallowed so the hook never
 * blocks the user prompt on log housekeeping.
 */
export function rotateLogIfNeeded(
  path: string = LOG_PATH,
  maxBytes: number = LOG_ROTATE_BYTES,
  fs: LogFsDeps = REAL_FS_DEPS
): void {
  if (!fs.existsSync(path)) return;
  try {
    const size = fs.statSync(path).size;
    if (size <= maxBytes) return;
    const rotatedPath = `${path}.1`;
    if (fs.existsSync(rotatedPath)) {
      fs.unlinkSync(rotatedPath);
    }
    fs.renameSync(path, rotatedPath);
  } catch {
    // Rotation failures are silent — logging is best-effort.
  }
}

/**
 * Append a log entry as one JSON line. Failures are silent so log issues
 * never propagate to the user prompt.
 */
export function writeLog(
  entry: LogEntry,
  path: string = LOG_PATH,
  fs: LogFsDeps = REAL_FS_DEPS
): void {
  try {
    rotateLogIfNeeded(path, LOG_ROTATE_BYTES, fs);
    const stamped: LogEntry = { v: HOOK_VERSION, ...entry };
    fs.appendFileSync(path, `${JSON.stringify(stamped)}\n`, "utf8");
  } catch {
    // Logging is best-effort.
  }
}

// ---------------------------------------------------------------------------
// Braintrust emission (mt#1813 — Phase 1a of the trace-shape RFC)
//
// Each hook invocation emits a Braintrust log event with K/budget/MIN/
// sessionId/variant/injectedTokens/latencyMs metadata, so we can compare hook-
// tuning intervention variants (mt#1783) in the Braintrust dashboard.
//
// The SDK interaction lives in the shared module at
// `src/domain/observability/braintrust.ts` (extracted in mt#1778); this hook
// owns the memory-search-specific event shape and variant derivation.
//
// Emission is graceful-degradation: missing/invalid config → silent skip;
// SDK or network failure → silent skip; we never block the hook on
// instrumentation. The local JSONL log at `/tmp/claude-memory-search-hook.log`
// remains the source of truth.
// ---------------------------------------------------------------------------

/**
 * Derive the variant tag from the current K/budget/MIN constants.
 * Auto-updates when the constants change in source; lets pre/post comparison
 * happen via filtering on `metadata.variant` in Braintrust's UI.
 */
export function deriveVariantTag(
  k: number = DEFAULT_K,
  budget: number = DEFAULT_TOKEN_BUDGET,
  minLen: number = MIN_PROMPT_LENGTH
): string {
  return `K=${k},B=${budget},MIN=${minLen}`;
}

/**
 * Emit a hook-fire event to Braintrust. Builds the memory-search-specific
 * input/output/metadata shape, then delegates the SDK interaction to the
 * shared emitter at `src/domain/observability/braintrust.ts`.
 *
 * Always awaitable; never throws — see `emitBraintrustEvent` for the
 * graceful-degradation contract. Callers `await emitBraintrust(entry)`
 * before `process.exit(0)` so the event lands before the hook subprocess exits.
 */
export async function emitBraintrust(entry: LogEntry): Promise<void> {
  const variant = deriveVariantTag();
  const output = entry.skipped
    ? { skipped: true, skipReason: entry.skipReason ?? "unknown" }
    : {
        skipped: false,
        injectedTokens: entry.injectedTokens,
        injectedCount: entry.injectedCount,
        backend: entry.backend,
        latencyMs: entry.latencyMs,
      };

  await emitBraintrustEvent({
    input: {
      prompt_prefix: entry.promptPrefix,
      prompt_length: entry.promptLength,
    },
    output,
    metadata: {
      sessionId: entry.sessionId,
      variant,
      k: DEFAULT_K,
      tokenBudget: DEFAULT_TOKEN_BUDGET,
      minPromptLength: MIN_PROMPT_LENGTH,
      latencyMs: entry.latencyMs,
      hookVersion: HOOK_VERSION,
      warning: entry.warning,
      source: "minsky.hooks.memory-search",
    },
  });
}

// ---------------------------------------------------------------------------
// Search invocation
// ---------------------------------------------------------------------------

/**
 * Derive the per-call search timeout from the host cap declared in
 * `.claude/settings.json`. Returns `{timeoutMs, warning?}` so callers can
 * surface fallback warnings to the debug log.
 *
 * Pattern: mt#1546 introduced `readHostCap` precisely to avoid the
 * hardcoded-timeout drift this PR's first round flagged. We use a single
 * 70% ratio rather than `deriveBudgets`'s git-tailored ratios because this
 * hook makes one external call (not a sequence of git probes).
 */
export function deriveSearchTimeoutMs(): { timeoutMs: number; warning?: string } {
  const cap = readHostCap(HOOK_FILENAME, undefined, { events: ["UserPromptSubmit"] });
  const timeoutMs = Math.max(
    MIN_SEARCH_TIMEOUT_MS,
    Math.floor(cap.hostCapSec * 1000 * SEARCH_TIMEOUT_RATIO)
  );
  return { timeoutMs, warning: cap.warning };
}

/**
 * Invoke `minsky memory search` and return the parsed response.
 *
 * Returns null when the CLI fails, times out, or produces unparseable output.
 * The caller treats null as "skip injection" — same posture as degraded results.
 *
 * The returned `warning` carries any host-cap fallback signal from
 * `deriveSearchTimeoutMs` (CLAUDE_PROJECT_DIR unset, settings.json missing,
 * no matcher entry). Operators see this in the debug log so misconfigured
 * `.claude/settings.json` is detectable. Per round-2 BLOCKING #2.
 *
 * `timeoutMs` defaults to the value derived from the host cap; tests can
 * override to exercise edge cases hermetically. When provided, no warning
 * is generated (the caller has already taken responsibility for the value).
 */
export function runMemorySearch(
  query: string,
  k: number = DEFAULT_K,
  timeoutMs?: number
): {
  response: MemorySearchResponseLite | null;
  latencyMs: number;
  error?: string;
  warning?: string;
} {
  // Truncate overlong queries — embeddings degrade past ~500 chars and we don't
  // want to ship multi-page prompts as the search input.
  const truncatedQuery = query.length > MAX_QUERY_LENGTH ? query.slice(0, MAX_QUERY_LENGTH) : query;

  let effectiveTimeout: number;
  let derivationWarning: string | undefined;
  if (typeof timeoutMs === "number") {
    effectiveTimeout = timeoutMs;
  } else {
    const derived = deriveSearchTimeoutMs();
    effectiveTimeout = derived.timeoutMs;
    derivationWarning = derived.warning;
  }

  const start = Date.now();
  const result = execWithPath(
    ["minsky", "memory", "search", truncatedQuery, "--limit", String(k)],
    { timeout: effectiveTimeout }
  );
  const latencyMs = Date.now() - start;

  if (result.timedOut) {
    return { response: null, latencyMs, error: "timeout", warning: derivationWarning };
  }
  if (result.exitCode !== 0) {
    return {
      response: null,
      latencyMs,
      error: `exit ${result.exitCode}: ${(result.stderr || result.stdout).slice(0, 200)}`,
      warning: derivationWarning,
    };
  }

  const parsed = parseSearchOutput(result.stdout);
  if (!parsed) {
    return {
      response: null,
      latencyMs,
      error: "unparseable output",
      warning: derivationWarning,
    };
  }

  return { response: parsed, latencyMs, warning: derivationWarning };
}

// ---------------------------------------------------------------------------
// Dispatcher-compatible pure function (ADR-028 Phase 2b, mt#2687)
// ---------------------------------------------------------------------------

/**
 * Guard-dispatcher entry point. Mirrors `main()`'s orchestration but returns
 * a `GuardOutcome` instead of writing to stdout / calling `process.exit` —
 * the dispatcher owns stdout and aggregates every matched guard's output
 * (D1). Logging (`writeLog`) and Braintrust telemetry (`emitBraintrust`) are
 * preserved as side effects on every branch, matching `main()` exactly; this
 * guard has no calibration log — `additionalContext` only.
 */
export async function run(
  input: ClaudeHookInput,
  _ctx: DispatchContext
): Promise<GuardOutcome | null> {
  // Explicit event guard, matching the sibling injection hooks
  // (inject-current-time, inject-git-state, inject-prod-state,
  // inject-dispatch-watchdog) — in practice the dispatcher only invokes
  // UserPromptSubmit-registered guards for the UserPromptSubmit event, but
  // this keeps `run()` safe if ever called directly / matched differently.
  if (input.hook_event_name !== "UserPromptSubmit") return null;

  const promptInput = input as UserPromptSubmitInput;
  const sessionId = input.session_id ?? "unknown";
  const prompt = promptInput.prompt ?? "";
  const promptPrefix = prompt.slice(0, 80).replace(/\s+/g, " ").trim();

  const logAndReturn = async (
    entry: LogEntry,
    outcome: GuardOutcome | null
  ): Promise<GuardOutcome | null> => {
    writeLog(entry);
    await emitBraintrust(entry);
    return outcome;
  };

  if (isTrivialPrompt(prompt)) {
    return logAndReturn(
      {
        ts: new Date().toISOString(),
        sessionId,
        promptPrefix,
        promptLength: prompt.length,
        skipped: true,
        skipReason: "trivial",
      },
      null
    );
  }

  const { response, latencyMs, error, warning } = runMemorySearch(prompt, DEFAULT_K);

  if (!response) {
    return logAndReturn(
      {
        ts: new Date().toISOString(),
        sessionId,
        promptPrefix,
        promptLength: prompt.length,
        skipped: true,
        skipReason: error ?? "search-failed",
        latencyMs,
        warning,
      },
      null
    );
  }

  if (response.degraded) {
    const degradedWarning =
      `[memory-search] Embeddings subsystem is degraded (backend: ${response.backend ?? "none"}). ` +
      `Memory search returned no results because the embedding provider is unavailable. ` +
      `This may be caused by OpenAI API quota exhaustion. ` +
      `Run \`minsky config doctor\` or check \`debug_systemInfo\` → embeddingsHealth for details.`;
    return logAndReturn(
      {
        ts: new Date().toISOString(),
        sessionId,
        promptPrefix,
        promptLength: prompt.length,
        skipped: true,
        skipReason: "degraded",
        degraded: true,
        backend: response.backend,
        latencyMs,
        warning,
      },
      { additionalContext: degradedWarning }
    );
  }

  if (response.results.length === 0) {
    return logAndReturn(
      {
        ts: new Date().toISOString(),
        sessionId,
        promptPrefix,
        promptLength: prompt.length,
        skipped: true,
        skipReason: "empty",
        backend: response.backend,
        latencyMs,
        warning,
      },
      null
    );
  }

  const injection = buildInjection(response.results);
  if (!injection) {
    return logAndReturn(
      {
        ts: new Date().toISOString(),
        sessionId,
        promptPrefix,
        promptLength: prompt.length,
        skipped: true,
        skipReason: "no-fit",
        backend: response.backend,
        latencyMs,
        warning,
      },
      null
    );
  }

  return logAndReturn(
    {
      ts: new Date().toISOString(),
      sessionId,
      promptPrefix,
      promptLength: prompt.length,
      skipped: false,
      k: DEFAULT_K,
      injectedTokens: injection.tokens,
      injectedCount: injection.included,
      backend: response.backend,
      latencyMs,
      warning,
    },
    { additionalContext: injection.text }
  );
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  await (async () => {
    let input: UserPromptSubmitInput;
    try {
      input = await readInput<UserPromptSubmitInput>();
    } catch {
      // Can't even read input — exit silently so the prompt isn't blocked.
      process.exit(0);
    }

    const sessionId = input.session_id ?? "unknown";
    const prompt = input.prompt ?? "";
    const promptPrefix = prompt.slice(0, 80).replace(/\s+/g, " ").trim();

    // Helper: write to both the local JSONL log and Braintrust, then exit.
    // Braintrust emission is fire-and-await with internal failure swallowed; the
    // local log is the source of truth and is never blocked by instrumentation.
    const recordAndExit = async (entry: LogEntry): Promise<never> => {
      writeLog(entry);
      await emitBraintrust(entry);
      process.exit(0);
    };

    // Trivial-prompt skip
    if (isTrivialPrompt(prompt)) {
      return await recordAndExit({
        ts: new Date().toISOString(),
        sessionId,
        promptPrefix,
        promptLength: prompt.length,
        skipped: true,
        skipReason: "trivial",
      });
    }

    // Run search. The warning carries any host-cap fallback signal so operators
    // can detect misconfigured settings.json — surfaced on every log path
    // (round-2 BLOCKING #2).
    const { response, latencyMs, error, warning } = runMemorySearch(prompt, DEFAULT_K);

    if (!response) {
      return await recordAndExit({
        ts: new Date().toISOString(),
        sessionId,
        promptPrefix,
        promptLength: prompt.length,
        skipped: true,
        skipReason: error ?? "search-failed",
        latencyMs,
        warning,
      });
    }

    // Degraded backend → inject warning so the operator knows embeddings are down
    if (response.degraded) {
      const degradedWarning =
        `[memory-search] Embeddings subsystem is degraded (backend: ${response.backend ?? "none"}). ` +
        `Memory search returned no results because the embedding provider is unavailable. ` +
        `This may be caused by OpenAI API quota exhaustion. ` +
        `Run \`minsky config doctor\` or check \`debug_systemInfo\` → embeddingsHealth for details.`;
      const degradedOutput: HookOutput = {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: degradedWarning,
        },
      };
      writeOutput(degradedOutput);

      writeLog({
        ts: new Date().toISOString(),
        sessionId,
        promptPrefix,
        promptLength: prompt.length,
        skipped: true,
        skipReason: "degraded",
        degraded: true,
        backend: response.backend,
        latencyMs,
        warning,
      });
      await emitBraintrust({
        ts: new Date().toISOString(),
        sessionId,
        promptPrefix,
        promptLength: prompt.length,
        skipped: true,
        skipReason: "degraded",
        degraded: true,
        backend: response.backend,
        latencyMs,
        warning,
      });
      process.exit(0);
    }

    // Empty results → nothing useful to inject
    if (response.results.length === 0) {
      return await recordAndExit({
        ts: new Date().toISOString(),
        sessionId,
        promptPrefix,
        promptLength: prompt.length,
        skipped: true,
        skipReason: "empty",
        backend: response.backend,
        latencyMs,
        warning,
      });
    }

    // Build the injected text within budget
    const injection = buildInjection(response.results);
    if (!injection) {
      return await recordAndExit({
        ts: new Date().toISOString(),
        sessionId,
        promptPrefix,
        promptLength: prompt.length,
        skipped: true,
        skipReason: "no-fit",
        backend: response.backend,
        latencyMs,
        warning,
      });
    }

    // Emit via the shared writer so any future schema changes / instrumentation
    // in `writeOutput` apply uniformly across hooks (PR review round-1 BLOCKING #3).
    const output: HookOutput = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: injection.text,
      },
    };
    writeOutput(output);

    await recordAndExit({
      ts: new Date().toISOString(),
      sessionId,
      promptPrefix,
      promptLength: prompt.length,
      skipped: false,
      k: DEFAULT_K,
      injectedTokens: injection.tokens,
      injectedCount: injection.included,
      backend: response.backend,
      latencyMs,
      warning,
    });
  })();
}
