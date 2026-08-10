/**
 * Embedding-similarity nomination — Rung 2 of the ADR-024 detection-mechanism
 * ladder (mt#3408).
 *
 * Rung 1 (deterministic regex) remains the default stopping point and stays
 * authoritative. This stage only ever ADDS nominations for text that a curated
 * exemplar set is semantically close to, so a paraphrase no regex family spells
 * out can still surface without widening the regex corpus — the arms race
 * ADR-024 exists to end.
 *
 * Contract, relied on by every consumer: `nominate` NEVER throws and NEVER
 * resolves later than its budget. Each failure path — an unconfigured provider,
 * a provider error, a stalled connection, or a provider whose vectors carry no
 * semantic signal — returns `degraded: true` with an empty nomination list so
 * the caller falls back to its Rung-1 result and STILL injects. ADR-024's
 * fail-to-Rung-1 invariant forbids silent-skipping here.
 */

import type { EmbeddingService } from "../ai/embeddings/types";

/**
 * Budget for the whole nomination round-trip.
 *
 * Both consuming guards declare `timeoutMs: 10000` in `.minsky/hooks/registry.ts`
 * (`retrospective-trigger-scanner`, `turn-end-retro-scan`). The embedding
 * service's own default is 15s (`REQUEST_TIMEOUT_MS`), which is LONGER than the
 * guard budget — so relying on it would let the guard be killed before the
 * degrade path could run, making the fallback unreachable and turning a slow
 * provider into a silent skip. This bound is enforced here, at the caller, so it
 * holds for every provider rather than only the one whose constructor happens to
 * accept a timeout.
 */
export const DEFAULT_NOMINATION_TIMEOUT_MS = 2000;

/**
 * Cosine floor for a segment/exemplar pair to count as a nomination.
 *
 * Measured, not chosen (`decision-defaults.mdc §Thresholds`). Against
 * text-embedding-3-small, `scripts/verify-rung2-nomination.ts` puts the mt#3341
 * recall fixture at 0.504 and the highest correct-ordering negative control
 * ("I committed before pushing") at 0.406; neutral prose sits at ~0.25. This
 * value is the midpoint of that observed band.
 *
 * The band is NARROW — ~0.05 either side, established against one recall
 * fixture and four negatives. That thinness is the reason this stage only
 * NOMINATES into an advisory reminder and is measured over real turns by
 * `scripts/replay-retrospective-trigger-corpus.ts` before being trusted; it is
 * not a number to treat as well-calibrated on the evidence so far.
 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.455;

/** Upper bound on candidate segments embedded per turn, to bound batch size. */
export const MAX_CANDIDATE_SEGMENTS = 40;

/** Longest single segment sent to the provider; embeddings degrade past ~500 chars. */
export const MAX_SEGMENT_CHARS = 500;

export type DegradedReason =
  | "provider-unconfigured"
  | "provider-error"
  | "timeout"
  | "non-semantic-provider"
  /**
   * The provider returned a batch whose length does not match the inputs it was
   * given. Distinct from `provider-error` on purpose: an exception is a
   * provider that FAILED, whereas this is a provider that SUCCEEDED while
   * returning something unusable — usually a model/config mismatch. Collapsing
   * the two hides that distinction from the calibration log, which is the only
   * place this is diagnosable after the fact.
   */
  | "provider-shape-mismatch";

export interface ExemplarSet {
  family: string;
  exemplars: string[];
}

export interface Nomination {
  family: string;
  score: number;
  /** The candidate segment that scored highest — the caller reports this as the matched phrase. */
  segment: string;
  matchedExemplar: string;
}

export interface NominationResult {
  nominations: Nomination[];
  degraded: boolean;
  degradedReason?: DegradedReason;
  /**
   * Human-readable specifics for a degraded result, when the reason alone is
   * not enough to act on (e.g. the observed vs expected batch size). Carried
   * into the calibration record so a degradation is diagnosable after the fact
   * rather than only countable.
   */
  degradedDetail?: string;
}

export interface NominationDeps {
  embeddingService: EmbeddingService;
  /**
   * False when the configured provider returns vectors with no semantic content
   * — specifically the `local` provider, which is a deterministic hash stub for
   * offline/dev use, not an embedding model. Nominating on hash vectors would
   * fire at random while reporting healthy, which is strictly worse than not
   * nominating at all.
   */
  semantic: boolean;
}

export interface NominateOptions {
  timeoutMs?: number;
  threshold?: number;
  maxSegments?: number;
}

/** Embedding providers whose vectors carry real semantic signal. */
const SEMANTIC_PROVIDERS: ReadonlySet<string> = new Set(["openai", "gemini"]);

/** True when `provider` produces semantically meaningful vectors. */
export function isSemanticProvider(provider: string | undefined): boolean {
  return provider !== undefined && SEMANTIC_PROVIDERS.has(provider);
}

/**
 * Split turn text into candidate segments.
 *
 * Matching is per-sentence rather than per-turn: a single admission sentence
 * buried in a long turn would be diluted to nothing by whole-turn averaging.
 */
export function splitCandidateSegments(
  text: string,
  maxSegments: number = MAX_CANDIDATE_SEGMENTS
): string[] {
  const segments: string[] = [];
  for (const rawLine of text.split(/\n+/)) {
    for (const rawSentence of rawLine.split(/(?<=[.!?])\s+/)) {
      const trimmed = rawSentence.trim();
      // Very short fragments ("Yes.", "Done.") carry no admission signal and
      // only inflate the batch.
      if (trimmed.length < 12) continue;
      segments.push(trimmed.slice(0, MAX_SEGMENT_CHARS));
      if (segments.length >= maxSegments) return segments;
    }
  }
  return segments;
}

/** Cosine similarity; returns 0 for mismatched or zero-magnitude vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

type TimedOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "timeout" }
  | { ok: false; reason: "error"; error: unknown };

/**
 * Bound `work` at `ms`, converting every outcome into a value rather than a
 * rejection. `work` is given a no-op rejection handler up front so a failure
 * arriving AFTER the timeout has already won cannot surface as an unhandled
 * rejection and take down the hook process.
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<TimedOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded: Promise<TimedOutcome<T>> = work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, reason: "error" as const, error })
  );
  const expiry = new Promise<TimedOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), ms);
  });
  try {
    return await Promise.race([guarded, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Nominate families whose exemplars are semantically close to some segment of
 * `text`. Never throws; never resolves past `options.timeoutMs`.
 */
export async function nominate(
  text: string,
  exemplarSets: ExemplarSet[],
  deps: NominationDeps,
  options: NominateOptions = {}
): Promise<NominationResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_NOMINATION_TIMEOUT_MS;
  const threshold = options.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const maxSegments = options.maxSegments ?? MAX_CANDIDATE_SEGMENTS;

  if (!deps.semantic) {
    return { nominations: [], degraded: true, degradedReason: "non-semantic-provider" };
  }

  const segments = splitCandidateSegments(text, maxSegments);
  const exemplars = exemplarSets.flatMap((s) => s.exemplars);
  if (segments.length === 0 || exemplars.length === 0) {
    return { nominations: [], degraded: false };
  }

  // One batched call: re-embedding the exemplar set each turn costs a few
  // hundred short inputs on the SAME round-trip, which is cheaper than the
  // extra network round-trip a separate query-only call would add. Precomputing
  // exemplar vectors at build time is the obvious optimization if this shows up
  // in latency measurements.
  const outcome = await withTimeout(
    deps.embeddingService.generateEmbeddings([...segments, ...exemplars]),
    timeoutMs
  );

  if (!outcome.ok) {
    return {
      nominations: [],
      degraded: true,
      degradedReason: outcome.reason === "timeout" ? "timeout" : "provider-error",
    };
  }

  const vectors = outcome.value;
  const expectedLength = segments.length + exemplars.length;
  if (!Array.isArray(vectors) || vectors.length !== expectedLength) {
    // A provider that returns a differently-shaped batch than it was asked for
    // is malfunctioning; scoring against it would silently mis-pair segments
    // with exemplars and produce confident nonsense. `expected`/`received` are
    // carried so the calibration log can say WHICH shape came back, rather than
    // only that something was wrong.
    return {
      nominations: [],
      degraded: true,
      degradedReason: "provider-shape-mismatch",
      degradedDetail: `expected ${expectedLength} vectors, received ${
        Array.isArray(vectors) ? vectors.length : typeof vectors
      }`,
    };
  }

  const segmentVectors = vectors.slice(0, segments.length);
  const exemplarVectors = vectors.slice(segments.length);

  const nominations: Nomination[] = [];
  let exemplarOffset = 0;
  for (const set of exemplarSets) {
    let best: Nomination | undefined;
    for (let e = 0; e < set.exemplars.length; e++) {
      const exemplarVector = exemplarVectors[exemplarOffset + e];
      if (exemplarVector === undefined) continue;
      for (let s = 0; s < segments.length; s++) {
        const segmentVector = segmentVectors[s];
        if (segmentVector === undefined) continue;
        const score = cosineSimilarity(segmentVector, exemplarVector);
        if (score < threshold) continue;
        if (best === undefined || score > best.score) {
          best = {
            family: set.family,
            score,
            segment: segments[s] as string,
            matchedExemplar: set.exemplars[e] as string,
          };
        }
      }
    }
    exemplarOffset += set.exemplars.length;
    if (best !== undefined) nominations.push(best);
  }

  nominations.sort((a, b) => b.score - a.score);
  return { nominations, degraded: false };
}
