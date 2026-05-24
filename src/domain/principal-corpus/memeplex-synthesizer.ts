/**
 * Memeplex synthesis for the principal-corpus (mt#1930).
 *
 * After the raw corpus is embedded, an LLM-driven clustering pass
 * produces ~15-25 cluster-level "memeplex" entries — synthesized
 * propositions about how the principal thinks, each citing supporting
 * tweet IDs from the corpus. These get written to the product memory
 * store via `memory_create` and tagged `principal-thinking`.
 *
 * Architectural decision (mt#1930 spec): unlike raw tweets, synthesized
 * propositions ARE durable findings about how the principal thinks AND
 * are directly load-bearing for brand / position-paper / marketing
 * work — they satisfy CLAUDE.md `§Memory Usage`'s inclusion criterion.
 */

import { z } from "zod";
import { createCompletionService } from "../ai/service-factory";
import { getConfiguration } from "../configuration";
import type { ResolvedConfig, BackendConfig } from "../configuration/types";
import type { TweetRecord, TweetMetadata } from "./types";
import { log } from "../../utils/logger";

/** Use a stronger model than the classifier — the synthesis is reasoning-heavy. */
const SYNTHESIS_MODEL = "claude-sonnet-4-6";
const SYNTHESIS_PROVIDER = "anthropic";

export interface MemeplexEntry {
  /** Short, retrievable memory name (5-9 words). */
  name: string;
  /** One-line description suitable for the memory's description field. */
  description: string;
  /** The synthesized proposition itself — multi-paragraph; the memory's `content`. */
  content: string;
  /** Free-form thematic tag (e.g., "exocortex", "ego-plurality", "operative-ontology"). */
  theme: string;
  /** Citations: tweet IDs that support the proposition. */
  citations: string[];
}

const memeplexEntrySchema = z.object({
  name: z.string().min(8).max(120),
  description: z.string().min(10).max(400),
  content: z.string().min(80),
  theme: z.string().min(2).max(64),
  citations: z.array(z.string().min(3)).min(3),
});

/**
 * The synthesizer accepts either a bare array or an object wrapper with one
 * of several common keys (different Sonnet runs have returned `memeplexes`,
 * `entries`, `items`, or `propositions`). We coerce all shapes into a plain
 * array before validation.
 */
function coerceToArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    for (const key of ["memeplexes", "entries", "items", "propositions", "results"]) {
      if (Array.isArray(obj[key])) return obj[key] as unknown[];
    }
    const firstArrayVal = Object.values(obj).find((v) => Array.isArray(v));
    if (Array.isArray(firstArrayVal)) return firstArrayVal as unknown[];
  }
  throw new Error("Synthesizer response did not contain a recognisable array of memeplexes");
}

export interface TweetForSynthesis extends TweetRecord {
  relevance?: number;
  theme?: string;
}

const SYNTHESIS_SYSTEM_PROMPT = `You are a research assistant synthesizing recurring propositions from a tweet corpus into "memeplexes" — durable cluster-level claims about how the corpus author thinks.

A memeplex is NOT a topic; it is a PROPOSITION the author keeps articulating in different forms. It should be:
- A claim or stance, not a label ("Memory is a substrate, not storage" — not "Memory")
- Specific enough to be quotable in a position paper
- Supported by at least 3 distinct tweets that articulate it (cite tweet IDs)
- Phrased in the author's voice and idiom, not generic AI-speak

Each memeplex must have:
- name: 5-9 word claim (e.g., "Agents are intent-bearers, not productivity tools")
- description: one-line summary (≤ 30 words)
- content: 3-5 sentence elaboration (the proposition + why it matters + how it shows up in the corpus)
- theme: a single thematic tag (lowercase, hyphenated, e.g., "exocortex", "operative-ontology", "ego-plurality")
- citations: array of tweet ID strings, ≥ 3 tweets that articulate this proposition

Cluster the input. Identify 15-25 distinct propositions across the corpus. Avoid overlap; if two clusters reduce to the same proposition, merge them.

Output strict JSON: {"memeplexes": [...entries...]}.`;

export interface SynthesizeOptions {
  /** Hard cap on the number of memeplexes to emit. The model is also instructed in [15, 25]. */
  maxMemeplexes?: number;
  /** Hard cap on tweets to surface to the model (token budget). Default 600. */
  maxTweets?: number;
  /** Minimum classifier relevance to include. Default 0.7 (prefer the highest-signal tweets). */
  relevanceFloor?: number;
}

export async function synthesizeMemeplexes(
  tweets: TweetForSynthesis[],
  opts: SynthesizeOptions = {}
): Promise<MemeplexEntry[]> {
  const cfg = await getConfiguration();
  const resolvedConfig: ResolvedConfig = {
    backendConfig: cfg.backendConfig as BackendConfig,
    persistence: cfg.persistence,
    github: cfg.github,
    ai: cfg.ai,
    logger: cfg.logger,
    tasks: cfg.tasks as Record<string, unknown> | undefined,
  };
  const completionService = createCompletionService(resolvedConfig);

  const relevanceFloor = typeof opts.relevanceFloor === "number" ? opts.relevanceFloor : 0.7;
  const maxTweets = opts.maxTweets ?? 600;
  const maxMemeplexes = opts.maxMemeplexes ?? 25;

  const filtered = tweets
    .filter((t) => (t.relevance ?? 1) >= relevanceFloor)
    .sort(
      (a, b) =>
        (b.relevance ?? 0) * 1000 + b.favoriteCount - ((a.relevance ?? 0) * 1000 + a.favoriteCount)
    )
    .slice(0, maxTweets);

  log.info("[memeplex-synth] preparing synthesis batch", {
    inputTweets: tweets.length,
    afterFilter: filtered.length,
    relevanceFloor,
  });

  const corpusBlock = filtered
    .map(
      (t) =>
        `[${t.id} | ${t.createdAt.slice(0, 10)} | ${t.favoriteCount}♥ | theme:${t.theme ?? "?"}] ${oneLine(t.text)}`
    )
    .join("\n");

  const userPrompt = `Corpus (one tweet per line, format: [id | date | likes | classifier-theme] text):

${corpusBlock}

Synthesize between 15 and ${maxMemeplexes} distinct memeplexes from this corpus. Each must cite ≥ 3 tweet IDs from above.

Output ONLY a JSON array (no wrapper object, no markdown fences, no preamble). The array contains memeplex objects with keys: name, description, content, theme, citations.`;

  // Use generateText rather than generateObject — completion-service.generateObject
  // currently drops maxTokens (mt#1930), and we need ≥ 16K to fit 25 memeplexes.
  // We parse + validate manually below.
  const response = await completionService.complete({
    prompt: userPrompt,
    systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
    model: SYNTHESIS_MODEL,
    provider: SYNTHESIS_PROVIDER,
    temperature: 0.2,
    maxTokens: 16000,
  });

  const text = response.content ?? "";
  const parsed = parseJsonAllowingFences(text);
  const rawEntries = coerceToArray(parsed);
  const validated: MemeplexEntry[] = [];
  for (const item of rawEntries) {
    try {
      validated.push(memeplexEntrySchema.parse(item));
    } catch (err) {
      log.warn("[memeplex-synth] dropped invalid memeplex entry", {
        error: err instanceof Error ? err.message : String(err),
        item: JSON.stringify(item).slice(0, 200),
      });
    }
  }
  if (validated.length === 0) {
    const { safeTruncate } = await import("../../utils/safe-truncate");
    throw new Error(
      `Synthesizer returned no valid memeplexes. Raw response (truncated): ${safeTruncate(text, 500, "head")}`
    );
  }
  return validated;
}

/**
 * Parse JSON from a model response. Tolerates markdown code fences (```json ... ```),
 * leading prose ("Here are the memeplexes:\n["), and trailing prose.
 */
function parseJsonAllowingFences(text: string): unknown {
  // Try direct parse first
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Strip code fences and retry
  }
  const fenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try {
    return JSON.parse(fenced);
  } catch {
    // Extract first balanced JSON array or object
  }
  // Find the first '[' or '{' and the matching close
  for (const open of ["[", "{"]) {
    const startIdx = fenced.indexOf(open);
    if (startIdx === -1) continue;
    const close = open === "[" ? "]" : "}";
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let idx = startIdx; idx < fenced.length; idx++) {
      const ch = fenced[idx];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\" && inString) {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(fenced.slice(startIdx, idx + 1));
          } catch {
            // try other shape
            break;
          }
        }
      }
    }
  }
  throw new Error("Could not parse JSON from synthesizer response");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Re-export tweet metadata type for consumers that load tweets from
 * the vector store's metadata column rather than the parsed archive.
 */
export type { TweetMetadata };
