#!/usr/bin/env bun
/**
 * Measure END-TO-END transcript ingest latency (mt#4324, criterion 5).
 *
 * ADR-044 makes this figure a PRECONDITION: entity-thread agent turns may only
 * become a read-time join over ingested transcript rows if the ingest lands
 * fast enough that the panel's poll does not render a visibly empty thread.
 * The gate is `POLL_INTERVAL_MS = 3_000` (`EntityThreadPanel.tsx:45`); if
 * measured p95 exceeds it, mt#4324 stops rather than flipping.
 *
 * ## Why this script exists instead of a query
 *
 * The figure is NOT computable from stored data. `agent_transcript_turns` has
 * eight-ish columns and none of them records when the ROW landed —
 * `started_at` / `ended_at` both come from the JSONL content, i.e. when the
 * TURN happened. Verified against the live table, not just the drizzle schema.
 *
 * That absence leaves a trap worth naming, because the substitute is one query
 * away: `now() - max(ended_at)` looks like a lag measurement and is not one. On
 * a quiet system it returns "how long since anyone last spoke"; on a busy one it
 * returns something small whether or not the watcher is alive. It yields a
 * plausible number in every state, including broken — mem#704's can't-fail
 * probe. This script measures the actual interval instead.
 *
 * ## What it measures
 *
 *   t0 = the assistant line's OWN `timestamp` field, as written into the JSONL
 *   t1 = the first moment a DB poll can see that turn
 *   latency = t1 - t0
 *
 * `t0` is the line's timestamp rather than the file's mtime on purpose: mtime is
 * the last write to the whole file, so a later unrelated line moves it, and the
 * probe's own observation time is inflated by its poll cadence. The line
 * timestamp is the instant the turn actually happened, which is also the instant
 * the operator starts waiting — so this is the interval the panel experiences.
 *
 * The DB-side signal is `max(ended_at) >= t0` for that conversation. That works
 * because `ended_at` is derived from the same line timestamps, so the inequality
 * flips exactly when the turn carrying `t0` has been extracted and written.
 *
 * ## A sample that never lands is NOT a dropped sample
 *
 * Each wait is bounded. A turn that never appears within the bound is counted
 * and reported SEPARATELY as `never-appeared`, never folded into the
 * distribution — folding it in would silently discard exactly the observations
 * that should fail this gate, which is the failure mode the gate exists to
 * catch.
 *
 * ## Usage
 *
 *   bun scripts/measure-transcript-ingest-latency.ts [--samples N] [--timeout-ms N] [--max-wait-min N]
 *
 * Read-only: it issues SELECTs and never writes, so it needs no write-ack flag.
 * Requires live agent activity to sample; this repo produces it continuously.
 *
 * Exit codes: 0 = measured (read the p95 against the gate), 1 = could not
 * measure (no samples collected, or persistence unavailable).
 */

// Must come first: the config bootstrap below pulls in tsyringe.
import "reflect-metadata";

import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const { initializeConfiguration, CustomConfigFactory } = await import(
  "@minsky/domain/configuration"
);
await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

const { getContextInspectorDb } = await import("../src/cockpit/db-providers");
const { sql } = await import("drizzle-orm");

function numArg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const raw = process.argv[i + 1];
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const TARGET_SAMPLES = numArg("--samples", 12);
const PER_SAMPLE_TIMEOUT_MS = numArg("--timeout-ms", 30_000);
const MAX_WAIT_MIN = numArg("--max-wait-min", 20);
const DB_POLL_MS = 100;
const FILE_POLL_MS = 250;

/** The panel's poll interval — the gate this measurement is judged against. */
const GATE_MS = 3_000;

const PROJECTS_ROOT = join(homedir(), ".claude", "projects");

interface Candidate {
  /** Conversation id — the JSONL basename, which is how ingest keys the rows. */
  agentSessionId: string;
  /** The assistant line's own timestamp. */
  t0Ms: number;
}

/** Every `*.jsonl` under the projects root, one level deep (the layout ingest walks). */
function listTranscriptFiles(): string[] {
  const out: string[] = [];
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(PROJECTS_ROOT);
  } catch {
    return out;
  }
  for (const dir of projectDirs) {
    const full = join(PROJECTS_ROOT, dir);
    try {
      if (!statSync(full).isDirectory()) continue;
      for (const f of readdirSync(full)) {
        if (f.endsWith(".jsonl")) out.push(join(full, f));
      }
    } catch {
      // A directory that vanished mid-walk is not an error for a sampler.
      continue;
    }
  }
  return out;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

/**
 * The newest assistant line's timestamp in the bytes appended since `fromByte`.
 *
 * Returns null when the appended bytes carry no assistant line — a user line,
 * a sidecar record, or a partial write. A partial trailing line simply fails to
 * parse and is skipped; the next poll sees it complete.
 */
function newestAssistantTimestamp(path: string, fromByte: number): number | null {
  let text: string;
  try {
    const buf = readFileSync(path);
    text = buf.subarray(Math.max(0, fromByte)).toString("utf8");
  } catch {
    return null;
  }
  let newest: number | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let rec: { type?: unknown; timestamp?: unknown };
    try {
      rec = JSON.parse(trimmed) as typeof rec;
    } catch {
      continue; // partial trailing line; a later poll will see it whole
    }
    if (rec.type !== "assistant" || typeof rec.timestamp !== "string") continue;
    const ms = Date.parse(rec.timestamp);
    if (Number.isFinite(ms) && (newest === null || ms > newest)) newest = ms;
  }
  return newest;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] as number;
}

async function main(): Promise<void> {
  const db = await getContextInspectorDb();
  if (!db) {
    console.error("FAIL: no SQL persistence available — cannot measure ingest latency");
    process.exit(1);
  }

  console.log(
    `Measuring end-to-end transcript ingest latency.\n` +
      `  target samples: ${TARGET_SAMPLES}\n` +
      `  per-sample bound: ${PER_SAMPLE_TIMEOUT_MS}ms\n` +
      `  gate (EntityThreadPanel POLL_INTERVAL_MS): ${GATE_MS}ms\n` +
      `  watching: ${PROJECTS_ROOT}\n`
  );

  // Baseline every file's size so only NEW appends are sampled.
  const sizes = new Map<string, number>();
  for (const f of listTranscriptFiles()) sizes.set(f, fileSize(f));
  console.log(`  baselined ${sizes.size} transcript file(s)\n`);

  const latencies: number[] = [];
  let neverAppeared = 0;
  const deadline = Date.now() + MAX_WAIT_MIN * 60_000;

  while (latencies.length + neverAppeared < TARGET_SAMPLES && Date.now() < deadline) {
    await sleep(FILE_POLL_MS);

    const candidates: Candidate[] = [];
    for (const f of listTranscriptFiles()) {
      const prev = sizes.get(f);
      const now = fileSize(f);
      if (now < 0) continue;
      if (prev === undefined) {
        sizes.set(f, now); // new file appeared mid-run; baseline it, don't sample it
        continue;
      }
      if (now <= prev) continue;
      const t0Ms = newestAssistantTimestamp(f, prev);
      sizes.set(f, now);
      if (t0Ms === null) continue;
      const agentSessionId = f.slice(f.lastIndexOf("/") + 1, -".jsonl".length);
      candidates.push({ agentSessionId, t0Ms });
    }

    for (const c of candidates) {
      if (latencies.length + neverAppeared >= TARGET_SAMPLES) break;

      const waitUntil = Date.now() + PER_SAMPLE_TIMEOUT_MS;
      let landedAt: number | null = null;
      while (Date.now() < waitUntil) {
        const rows = await db.execute(
          sql`SELECT max(ended_at) AS newest FROM agent_transcript_turns
              WHERE agent_session_id = ${c.agentSessionId}`
        );
        const newest = Array.from(rows as Iterable<{ newest: string | Date | null }>)[0]?.newest;
        const newestMs =
          newest instanceof Date
            ? newest.getTime()
            : typeof newest === "string"
              ? Date.parse(newest)
              : NaN;
        if (Number.isFinite(newestMs) && newestMs >= c.t0Ms) {
          landedAt = Date.now();
          break;
        }
        await sleep(DB_POLL_MS);
      }

      if (landedAt === null) {
        neverAppeared++;
        console.log(
          `  [never-appeared] ${c.agentSessionId.slice(0, 8)}… turn at ` +
            `${new Date(c.t0Ms).toISOString()} not visible within ${PER_SAMPLE_TIMEOUT_MS}ms`
        );
        continue;
      }

      const latency = landedAt - c.t0Ms;
      latencies.push(latency);
      console.log(
        `  [sample ${latencies.length}] ${c.agentSessionId.slice(0, 8)}… ${latency}ms${
          latency > GATE_MS ? "  ← OVER GATE" : ""
        }`
      );
    }
  }

  console.log("");
  if (latencies.length === 0) {
    console.error(
      `FAIL: collected 0 timed samples (${neverAppeared} never-appeared) in ` +
        `${MAX_WAIT_MIN} min. This is NOT a passing result — it means the ` +
        `measurement did not run, which is a different thing from low latency.`
    );
    process.exit(1);
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const max = sorted[sorted.length - 1] as number;

  console.log(`Samples:        ${latencies.length} timed, ${neverAppeared} never-appeared`);
  console.log(`p50:            ${p50}ms`);
  console.log(`p95:            ${p95}ms`);
  console.log(`max:            ${max}ms`);
  console.log(`gate:           ${GATE_MS}ms (EntityThreadPanel POLL_INTERVAL_MS)`);
  console.log("");

  if (neverAppeared > 0) {
    console.log(
      `NOTE: ${neverAppeared} turn(s) never appeared within the bound. These are NOT in the\n` +
        `percentiles above and are not "slow" — they are unmeasured. Treat a non-zero count as a\n` +
        `gate concern in its own right, not a rounding detail.`
    );
  }
  console.log(p95 <= GATE_MS ? `RESULT: p95 within gate.` : `RESULT: p95 EXCEEDS gate.`);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(`FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
