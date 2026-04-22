/**
 * NLI-based Conflict Detection
 *
 * Provides an interface and default Anthropic implementation for Natural Language
 * Inference (NLI) classification of chunk pairs. Used at query time by
 * `knowledge.search` to populate the `conflicts` slot in `KnowledgeSearchResponse`.
 *
 * The classifier accepts two text excerpts and returns a verdict:
 *   - `contradicts` — the two chunks assert incompatible facts
 *   - `entails`     — one chunk is consistent with or restates the other
 *   - `unrelated`   — the chunks discuss different topics
 *
 * Only `contradicts` pairs are surfaced as conflicts in the response.
 *
 * Default model: `claude-haiku-4-5` (cost-efficient; configurable via
 * `knowledgeReconciliation.conflictModel` in the project config).
 */

import { z } from "zod";
import { generateObject, jsonSchema } from "ai";
import { log } from "../../../utils/logger";

// ─── Public types ─────────────────────────────────────────────────────────────

export type NliVerdict = "contradicts" | "entails" | "unrelated";

export interface NliResult {
  /** The NLI classification verdict */
  verdict: NliVerdict;
  /** Short natural-language explanation of the verdict */
  rationale: string;
}

/**
 * Interface for NLI (Natural Language Inference) classifiers.
 * Implementations determine whether two text chunks contradict each other.
 */
export interface NliClassifier {
  /**
   * Classify the relationship between two text chunks.
   *
   * @param chunkA - First text excerpt
   * @param chunkB - Second text excerpt
   * @returns NLI verdict with rationale
   */
  classify(chunkA: string, chunkB: string): Promise<NliResult>;
}

// ─── Zod schema for structured output ────────────────────────────────────────

const nliResultSchema = z.object({
  verdict: z
    .enum(["contradicts", "entails", "unrelated"])
    .describe(
      "NLI classification: 'contradicts' if the chunks assert incompatible facts, " +
        "'entails' if one restates or is consistent with the other, " +
        "'unrelated' if they cover different topics"
    ),
  rationale: z
    .string()
    .max(300)
    .describe("Brief explanation (1-2 sentences) justifying the verdict"),
});

// ─── Default Anthropic implementation ────────────────────────────────────────

const DEFAULT_CONFLICT_MODEL = "claude-haiku-4-5";

const SYSTEM_PROMPT = `You are a fact-checking assistant. You will be given two short text excerpts from a knowledge base.
Your job is to determine their logical relationship using Natural Language Inference (NLI):
- "contradicts": the excerpts assert incompatible facts about the same topic (e.g., one says "use bun" and the other says "use npm")
- "entails": the excerpts are consistent with each other, or one is a restatement/subset of the other
- "unrelated": the excerpts cover different topics and have no logical relationship

Be strict: only return "contradicts" if there is a clear factual conflict. Stylistic differences or different levels of detail do not constitute a contradiction.`;

/**
 * Options for the Anthropic NLI classifier.
 */
export interface AnthropicNliClassifierOptions {
  /**
   * Anthropic model to use for classification.
   * Defaults to "claude-haiku-4-5".
   */
  model?: string;
  /**
   * Injectable AI SDK generateObject function for testing.
   * Defaults to the real AI SDK function.
   */
  generateObjectFn?: typeof generateObject;
  /**
   * Injectable model resolver for testing.
   * When provided, bypasses real provider resolution and uses this model directly.
   */
  languageModel?: import("ai").LanguageModel;
}

/**
 * Default NLI classifier implementation using the Vercel AI SDK with Anthropic.
 *
 * Uses `generateObject` with a Zod schema to produce structured output,
 * matching the pattern established in `DefaultAICompletionService.generateObject`.
 */
export class AnthropicNliClassifier implements NliClassifier {
  private readonly model: string;
  private readonly generateObjectFn: typeof generateObject;
  private readonly languageModel?: import("ai").LanguageModel;

  constructor(options?: AnthropicNliClassifierOptions) {
    this.model = options?.model ?? DEFAULT_CONFLICT_MODEL;
    this.generateObjectFn = options?.generateObjectFn ?? generateObject;
    this.languageModel = options?.languageModel;
  }

  async classify(chunkA: string, chunkB: string): Promise<NliResult> {
    log.debug("[NliClassifier] Classifying chunk pair", { model: this.model });

    let model: import("ai").LanguageModel;

    if (this.languageModel) {
      // Injected model for testing
      model = this.languageModel;
    } else {
      // Resolve real Anthropic model via AI SDK
      const { anthropic } = await import("@ai-sdk/anthropic");
      model = anthropic(this.model);
    }

    const messages: Array<{ role: "user"; content: string }> = [
      {
        role: "user",
        content: `Excerpt A:\n${chunkA}\n\nExcerpt B:\n${chunkB}`,
      },
    ];

    // Use Zod v4's toJSONSchema, same pattern as DefaultAICompletionService.generateObject
    const schemaJson = z.toJSONSchema(nliResultSchema, { target: "draft-07" });

    try {
      const result = await this.generateObjectFn({
        model,
        system: SYSTEM_PROMPT,
        messages,
        schema: jsonSchema(schemaJson as Record<string, unknown>),
        temperature: 0.1, // Low temperature for consistent classification
      });

      // Validate against the original Zod schema
      const parsed = nliResultSchema.parse(result.object);

      log.debug("[NliClassifier] Classification complete", {
        verdict: parsed.verdict,
        model: this.model,
      });

      return parsed;
    } catch (error) {
      log.warn("[NliClassifier] Classification failed, defaulting to unrelated", {
        error: error instanceof Error ? error.message : String(error),
      });
      // On error, default to "unrelated" — do not surface a false conflict
      return { verdict: "unrelated", rationale: "Classification failed; defaulting to unrelated." };
    }
  }
}

// ─── Pairwise conflict detection ──────────────────────────────────────────────

/**
 * A raw chunk with ID and text content, used as input to pairwise NLI.
 */
export interface ClassifiableChunk {
  id: string;
  text: string;
}

/**
 * A detected conflict between two chunks.
 */
export interface DetectedConflict {
  chunkAId: string;
  chunkBId: string;
  disagreement: string;
}

/** Maximum number of chunks to run NLI over (hard cap at query time) */
export const NLI_CHUNK_CAP = 10;

/**
 * Run pairwise NLI over a list of chunks and return detected conflicts.
 *
 * Hard cap: only the first `NLI_CHUNK_CAP` (10) chunks are used, yielding
 * at most C(10, 2) = 45 model calls per query. If the input exceeds the cap,
 * a debug log entry is emitted.
 *
 * @param chunks   - Chunks to classify (in relevance order; top ones used first)
 * @param classifier - NLI classifier instance
 * @returns Detected contradiction pairs
 */
export async function detectConflicts(
  chunks: ClassifiableChunk[],
  classifier: NliClassifier
): Promise<DetectedConflict[]> {
  const effectiveChunks = chunks.slice(0, NLI_CHUNK_CAP);

  if (chunks.length > NLI_CHUNK_CAP) {
    log.debug(
      `[NliClassifier] Input has ${chunks.length} chunks; capping to top ${NLI_CHUNK_CAP} for NLI pass`
    );
  }

  const n = effectiveChunks.length;
  if (n < 2) {
    return [];
  }

  const conflicts: DetectedConflict[] = [];

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = effectiveChunks[i];
      const b = effectiveChunks[j];
      if (!a || !b) continue;

      const result = await classifier.classify(a.text, b.text);

      if (result.verdict === "contradicts") {
        conflicts.push({
          chunkAId: a.id,
          chunkBId: b.id,
          disagreement: result.rationale,
        });
      }
    }
  }

  return conflicts;
}
