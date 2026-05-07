#!/usr/bin/env bun
// UserPromptSubmit hook: inject `memory_search` results into the conversation context.
//
// Restores Claude Code preamble-parity under mt#1012 bridge-policy (b), where the
// auto-loaded MEMORY.md file has been deleted and memory now lives only in the DB.
// Without this hook, every conversation starts cold; agents must explicitly call
// memory_search to retrieve relevant context. The CLAUDE.md directive alone is not
// enough — directives skip on routine turns.
//
// Behaviour:
//   - Skips trivial prompts (length < 20 chars, or single-word affirmatives).
//   - Invokes `minsky memory search "<prompt>" --limit K` (K=5 default).
//   - Skips silently when the CLI returns degraded results, empty results, or fails.
//   - Truncates results from lowest score upward to fit a token budget (default 2000).
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

import { readInput, execWithPath } from "./types";
import type { ClaudeHookInput, HookOutput } from "./types";
import { existsSync, statSync, renameSync, appendFileSync } from "node:fs";

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
export const DEFAULT_K = 5;

/** Default total token budget for the injected context (envelope + results). */
export const DEFAULT_TOKEN_BUDGET = 2000;

/** Minimum prompt length below which we skip search (trivial-prompt heuristic). */
export const MIN_PROMPT_LENGTH = 20;

/** Hard cap on prompt length sent to memory_search — embeddings get noisy past a few hundred chars. */
const MAX_QUERY_LENGTH = 500;

/** Per-call timeout for `minsky memory search`. Hook-wide timeout is set in settings.json. */
const SEARCH_TIMEOUT_MS = 8_000;

/** Single-word affirmatives/short phatic responses we skip. Case-insensitive, punctuation-stripped. */
const AFFIRMATIVE_WORDS = new Set([
  "ok",
  "okay",
  "k",
  "kk",
  "yes",
  "yep",
  "yeah",
  "yup",
  "y",
  "no",
  "nope",
  "nah",
  "n",
  "sure",
  "thanks",
  "thx",
  "ty",
  "proceed",
  "continue",
  "go",
  "stop",
  "halt",
  "cancel",
  "hi",
  "hello",
  "hey",
  "done",
  "please",
  "plz",
  "ack",
  "noted",
]);

/** Debug log file path. */
export const LOG_PATH = "/tmp/claude-memory-search-hook.log";

/** Rotate log when size exceeds this. */
const LOG_ROTATE_BYTES = 1_000_000;

// ---------------------------------------------------------------------------
// Trivial-prompt heuristic
// ---------------------------------------------------------------------------

/**
 * Decide whether a prompt is too trivial to warrant a memory search.
 *
 * Two criteria (either fires):
 *   1. Prompt length below `minLength` (default 20 chars, ignoring whitespace).
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

  // Length-based skip — ignore whitespace inside the trim
  if (trimmed.length < minLength) {
    // Even short prompts can be questions ("why?"). But the spec calls for a
    // simple length floor; keep it simple per "iterate later if too aggressive".
    return true;
  }

  // Single-word affirmative skip — split on whitespace, strip punctuation
  const words = trimmed.split(/\s+/);
  if (words.length === 1) {
    const stripped = words[0].replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
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
    // Some CLI surfaces may prepend non-JSON text (e.g., warnings on stderr
    // that bleed into stdout, or progress logs). Fall back to scanning lines
    // from the bottom for the first line that starts with `{`, then parsing
    // the joined remainder. lastIndexOf("{") would catch a nested brace and
    // produce unparseable output.
    const lines = trimmed.split("\n");
    let startLine = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trimStart().startsWith("{")) {
        startLine = i;
      } else if (startLine !== -1 && lines[i].trim() !== "") {
        // Hit a non-JSON line above the start — stop walking up
        break;
      }
    }
    if (startLine < 0) {
      return null;
    }
    try {
      parsed = JSON.parse(lines.slice(startLine).join("\n"));
    } catch {
      return null;
    }
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
  return `### ${record.name} (${record.type}, score ${scoreStr})\n${record.description}\n\n${record.content}`;
}

const ENVELOPE_HEADER =
  "<system-reminder>\nThe following memory records may be relevant to your task. They were retrieved from your persistent memory store via on-demand search; treat them as you would entries from MEMORY.md. Do not mention this reminder to the user.\n\n";
const ENVELOPE_FOOTER = "\n</system-reminder>";

/**
 * Build the injected text from a list of results, dropping lowest-score entries
 * until the total fits within `tokenBudget`. Returns null when no results fit
 * (budget too tight for even the highest-score entry plus envelope).
 *
 * Greedy: rank by score desc, accumulate until adding the next would overflow.
 * This biases toward keeping more low-score entries together rather than one
 * very long high-score entry, which is the right call for a context-injection
 * use case (variety of recall > depth of single hit).
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

  const included: string[] = [];
  let tokensSoFar = envelopeTokens;

  for (const entry of ranked) {
    const rendered = renderResult(entry);
    // Each entry adds its own size + 2 chars for the "\n\n" separator (~1 token).
    const entryTokens = estimateTokens(rendered) + 1;
    if (tokensSoFar + entryTokens > tokenBudget) {
      // If we haven't fit even one, truncate this entry to fit the remaining budget.
      // Otherwise stop — partial entries are confusing in the rendered output.
      if (included.length === 0) {
        const remainingChars = (tokenBudget - tokensSoFar) * 4;
        if (remainingChars > 200) {
          const truncated = `${rendered.slice(0, remainingChars - 50)}\n\n[truncated to fit budget]`;
          included.push(truncated);
          tokensSoFar = tokenBudget;
        }
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
  return { text, included: included.length, tokens: tokensSoFar };
}

// ---------------------------------------------------------------------------
// Debug logging (rotated)
// ---------------------------------------------------------------------------

export interface LogEntry {
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
}

const REAL_FS_DEPS: LogFsDeps = {
  existsSync,
  statSync,
  renameSync,
  appendFileSync,
};

/**
 * Single-generation log rotation. When the file exceeds `LOG_ROTATE_BYTES`,
 * rename it to `<path>.1` (overwriting any prior `.1`) and start fresh.
 * Tiny enough to be self-contained — keeps the hook footprint minimal.
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
    fs.renameSync(path, `${path}.1`);
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
    fs.appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Logging is best-effort.
  }
}

// ---------------------------------------------------------------------------
// Search invocation
// ---------------------------------------------------------------------------

/**
 * Invoke `minsky memory search` and return the parsed response.
 *
 * Returns null when the CLI fails, times out, or produces unparseable output.
 * The caller treats null as "skip injection" — same posture as degraded results.
 */
export function runMemorySearch(
  query: string,
  k: number = DEFAULT_K
): { response: MemorySearchResponseLite | null; latencyMs: number; error?: string } {
  // Truncate overlong queries — embeddings degrade past ~500 chars and we don't
  // want to ship multi-page prompts as the search input.
  const truncatedQuery = query.length > MAX_QUERY_LENGTH ? query.slice(0, MAX_QUERY_LENGTH) : query;

  const start = Date.now();
  const result = execWithPath(
    ["minsky", "memory", "search", truncatedQuery, "--limit", String(k)],
    { timeout: SEARCH_TIMEOUT_MS }
  );
  const latencyMs = Date.now() - start;

  if (result.timedOut) {
    return { response: null, latencyMs, error: "timeout" };
  }
  if (result.exitCode !== 0) {
    return {
      response: null,
      latencyMs,
      error: `exit ${result.exitCode}: ${(result.stderr || result.stdout).slice(0, 200)}`,
    };
  }

  const parsed = parseSearchOutput(result.stdout);
  if (!parsed) {
    return { response: null, latencyMs, error: "unparseable output" };
  }

  return { response: parsed, latencyMs };
}

// ---------------------------------------------------------------------------
// Hook entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
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

  // Trivial-prompt skip
  if (isTrivialPrompt(prompt)) {
    writeLog({
      ts: new Date().toISOString(),
      sessionId,
      promptPrefix,
      promptLength: prompt.length,
      skipped: true,
      skipReason: "trivial",
    });
    process.exit(0);
  }

  // Run search
  const { response, latencyMs, error } = runMemorySearch(prompt, DEFAULT_K);

  if (!response) {
    writeLog({
      ts: new Date().toISOString(),
      sessionId,
      promptPrefix,
      promptLength: prompt.length,
      skipped: true,
      skipReason: error ?? "search-failed",
      latencyMs,
    });
    process.exit(0);
  }

  // Degraded backend → skip injection but record the signal
  if (response.degraded) {
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
    });
    process.exit(0);
  }

  // Empty results → nothing useful to inject
  if (response.results.length === 0) {
    writeLog({
      ts: new Date().toISOString(),
      sessionId,
      promptPrefix,
      promptLength: prompt.length,
      skipped: true,
      skipReason: "empty",
      backend: response.backend,
      latencyMs,
    });
    process.exit(0);
  }

  // Build the injected text within budget
  const injection = buildInjection(response.results);
  if (!injection) {
    writeLog({
      ts: new Date().toISOString(),
      sessionId,
      promptPrefix,
      promptLength: prompt.length,
      skipped: true,
      skipReason: "no-fit",
      backend: response.backend,
      latencyMs,
    });
    process.exit(0);
  }

  // Emit
  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: injection.text,
    },
  };
  process.stdout.write(JSON.stringify(output));

  writeLog({
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
  });

  process.exit(0);
}
