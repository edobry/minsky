#!/usr/bin/env bun
/**
 * Live verification for mt#2765: concurrent reviewer-widget fetches must all
 * settle. Before the fix, >pool-max concurrent queries wedged the shared
 * postgres-js pool and every concurrent fetch hung forever (see mt#2765 spec;
 * 8 concurrent fetches reproduced the hang 100%).
 *
 * Usage: bun scripts/verify-reviewer-widget-concurrency.ts
 * Exits 0 on pass or graceful skip (no DB configured); 1 on failure/timeout.
 */
import "reflect-metadata";
import { setupConfiguration } from "../packages/domain/src/config-setup";
import { reviewerBotStatusWidget } from "../src/cockpit/widgets/reviewer-bot-status";

function emit(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

try {
  await setupConfiguration();
} catch (err) {
  emit({
    status: "SKIP",
    reason: `configuration unavailable: ${err instanceof Error ? err.message : String(err)}`,
  });
  process.exit(0);
}

const CONCURRENCY = 8;
const CAP_MS = 45_000;

const started = Date.now();
const cap = setTimeout(() => {
  emit({ status: "FAIL", reason: `still pending after ${CAP_MS}ms — concurrency wedge present` });
  process.exit(1);
}, CAP_MS);

const results = await Promise.all(
  Array.from({ length: CONCURRENCY }, () =>
    reviewerBotStatusWidget.fetch({ id: "reviewer-bot-status", query: {} })
  )
);
clearTimeout(cap);

const states = results.map((r) => r.state);
const firstOk = results.find((r) => r.state === "ok") as
  | { state: "ok"; payload: { db: { reviewCount24h: number } | null } }
  | undefined;

emit({
  status: states.every((s) => s === "ok") ? "PASS" : "FAIL",
  elapsedMs: Date.now() - started,
  states,
  reviewCount24h: firstOk?.payload.db?.reviewCount24h ?? null,
});
process.exit(states.every((s) => s === "ok") ? 0 : 1);
