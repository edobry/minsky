#!/usr/bin/env bun
/**
 * Measure real embedding-request latency so mt#3444's timeout is grounded in
 * observed cadence rather than a round number (`decision-defaults §Thresholds`).
 *
 * Prints timings only — never the API key. Env-gated; exits 0 with SKIP when
 * the provider is not configured.
 */
import "reflect-metadata";
import { OpenAIEmbeddingService } from "@minsky/domain/ai/embedding-service-openai";

const N = Number(process.env.SAMPLES ?? 12);

let service: OpenAIEmbeddingService;
try {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });
  service = await OpenAIEmbeddingService.fromConfig();
} catch (e) {
  console.log(`SKIP: OpenAI embeddings not configured (${(e as Error)?.message})`);
  process.exit(0);
}

// A short single input (the query-embedding shape a *_search call makes) and a
// batch (the index shape), measured separately — they have different cost.
const singles: number[] = [];
const batches: number[] = [];

for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  await service.generateEmbedding(`latency probe ${i}: a representative search query about tasks`);
  singles.push(performance.now() - t0);
}

// The real index path batches 20 (`PerTurnEmbeddingPipeline.batchSize`, default
// 20) turns of transcript text, so measure THAT shape — 20 inputs of
// realistically long text — not a toy batch. This is the slowest legitimate
// call the timeout must not fire on.
const TURN_TEXT = "a representative transcript turn. ".repeat(60); // ~2KB
for (let i = 0; i < Math.ceil(N / 3); i++) {
  const inputs = Array.from({ length: 20 }, (_, j) => `batch ${i}-${j}: ${TURN_TEXT}`);
  const t0 = performance.now();
  await service.generateEmbeddings(inputs);
  batches.push(performance.now() - t0);
}

function stats(label: string, xs: number[]) {
  if (xs.length === 0) {
    console.log(`${label}: no samples`);
    return;
  }
  const s = [...xs].sort((a, b) => a - b);
  const at = (i: number) => s[Math.min(s.length - 1, Math.max(0, i))] ?? 0;
  const pick = (p: number) => at(Math.floor(p * s.length));
  console.log(
    `${label}: n=${s.length} min=${at(0).toFixed(0)}ms p50=${pick(0.5).toFixed(0)}ms ` +
      `p90=${pick(0.9).toFixed(0)}ms max=${at(s.length - 1).toFixed(0)}ms`
  );
}

stats("single  ", singles);
stats("batch-20", batches);
