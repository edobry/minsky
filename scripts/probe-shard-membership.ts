#!/usr/bin/env bun
/**
 * Throwaway probe (mt#3016 investigation) — NOT part of the deliverable.
 * Reconstructs the shard file assignment using the SAME discoverTestFiles +
 * binPackFiles logic run-tests-main-sharded.ts uses (read-only reuse, does
 * not modify that script) so we can see exactly which files land in the
 * same shard as a target file, for bisecting a cross-file test-isolation
 * leak.
 */
import { readFileSync, existsSync } from "node:fs";
import { discoverTestFiles } from "./run-tests-main";
import { binPackFiles } from "./run-tests-main-sharded";

const DURATION_CACHE_PATH =
  process.env.PROBE_DURATION_CACHE_PATH ?? "./scripts/test-duration-cache.json";

const files = discoverTestFiles();
let durationCache: Record<string, number> = {};
if (existsSync(DURATION_CACHE_PATH)) {
  durationCache = JSON.parse(readFileSync(DURATION_CACHE_PATH, "utf-8"));
}

const fileDurations = files.map((f) => ({
  path: f,
  durationMs: durationCache[f] ?? 0,
}));

const shardCount = 16;
const shards = binPackFiles(fileDurations, shardCount);

const target = process.argv[2] ?? "src/cockpit/widgets/agents.test.ts";
const targetIdx = shards.findIndex((s) => s.some((f) => f.includes(target)));
console.log(`Target "${target}" is in shard-${targetIdx} (${shards[targetIdx]?.length} files)`);
console.log(JSON.stringify(shards[targetIdx], null, 2));
