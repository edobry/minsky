#!/usr/bin/env bun
/**
 * Measure transcript ingest lag: how far behind the on-disk JSONL head each
 * actively-writing conversation's ingested high-water-mark sits (mt#4480, SC3/AT1).
 *
 * Why this exists: mt#4480 was filed on 3 timed observations in one 2-minute
 * window, which the ask itself flagged as thin. SC3 requires a real p95 over a
 * window of at least an hour, and AT1/AT2 need the SAME instrument run before
 * and after the fix so the two are comparable.
 *
 * What it measures, precisely — the bound matters, because a looser reading of
 * this number is what produced the task's original wrong framing:
 *
 *   lagSeconds = (newest `timestamp` in the conversation's JSONL on disk)
 *              - (that conversation's `lastIngestedJsonlTimestamp` in agent_transcripts)
 *
 * Both sides are JSONL-content timestamps, so this is "how much written content
 * has not yet been reflected", NOT a per-event queue delay and NOT a wall-clock
 * age. A conversation that stopped writing an hour ago and was fully ingested
 * reads 0, which is correct.
 *
 * Scope: only conversations whose JSONL was modified within `--active-window`
 * minutes are sampled. An idle conversation contributes a meaningless 0 and
 * would deflate every percentile.
 *
 * Output: one JSONL record per conversation per sample, appended to `--out`.
 * Summarize with `--summarize <file>`, which prints p50/p95/worst/n.
 *
 * Usage:
 *   bun scripts/measure-transcript-ingest-lag.ts --out /tmp/lag.jsonl            # one sample
 *   bun scripts/measure-transcript-ingest-lag.ts --out /tmp/lag.jsonl --minutes 60 --every 180
 *   bun scripts/measure-transcript-ingest-lag.ts --summarize /tmp/lag.jsonl
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Repo root and CLI entrypoint, resolved from THIS FILE rather than from
 * `process.cwd()` (PR #3278 R2). The measurement is meant to be run again
 * post-fix and compared against the pre-fix baseline, quite possibly from a
 * different directory.
 *
 * BOTH are needed, which running it from `/tmp` is what established: resolving
 * the entrypoint alone gets the CLI to start and it then fails with
 * *"This project hasn't been initialized. Run `minsky init` first."* — because
 * the CLI resolves its configuration from the CURRENT WORKING DIRECTORY, not
 * from where its own source lives. So the child is spawned with the repo root
 * as its cwd.
 */
const REPO_ROOT = resolve(import.meta.dir, "..");
const CLI_ENTRYPOINT = resolve(REPO_ROOT, "src", "cli.ts");

interface Sample {
  sampledAt: string;
  conversationId: string;
  diskHead: string | null;
  ingestedThrough: string | null;
  lagSeconds: number | null;
  /** True when the conversation has no row at all — a different defect from lag. */
  neverIngested: boolean;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

/**
 * Newest `timestamp` field across the JSONL's lines.
 *
 * Deliberately scans every line rather than reading the last one: transcript
 * writers do not guarantee monotonic timestamps within a file, and a trailing
 * line can be a partial write. Files are single-digit MB at most.
 */
async function newestJsonlTimestamp(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  let newest: number | null = null;
  let newestRaw: string | null = null;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('"timestamp"')) continue;
    let parsed: { timestamp?: unknown };
    try {
      parsed = JSON.parse(trimmed) as { timestamp?: unknown };
    } catch {
      continue;
    }
    const ts = parsed.timestamp;
    if (typeof ts !== "string") continue;
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) continue;
    if (newest === null || ms > newest) {
      newest = ms;
      newestRaw = ts;
    }
  }
  return newestRaw;
}

/** Conversation-level JSONL files modified within the active window. */
async function findActiveTranscripts(
  projectsDir: string,
  activeWindowMs: number
): Promise<Map<string, string>> {
  const cutoff = Date.now() - activeWindowMs;
  const active = new Map<string, string>();

  let projectDirs: string[];
  try {
    projectDirs = (await readdir(projectsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => join(projectsDir, e.name));
  } catch {
    return active;
  }

  for (const dir of projectDirs) {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(dir, entry.name);
      try {
        const st = await stat(path);
        if (st.mtimeMs < cutoff) continue;
      } catch {
        continue;
      }
      active.set(entry.name.replace(/\.jsonl$/, ""), path);
    }
  }
  return active;
}

/**
 * Ingest high-water-marks, keyed by conversation id.
 *
 * Goes through the `transcripts list` command rather than querying the table
 * directly so the measurement reads the same field a consumer would. The limit
 * is passed EXPLICITLY and large: the command applies `DEFAULT_LIST_CAP = 500`
 * when it is omitted, and reading a capped page as if it were the table is the
 * exact mistake that produced mt#4480's retracted "1,491 never-ingested"
 * finding.
 */
async function fetchIngestMarks(limit: number): Promise<Map<string, string | null>> {
  const proc = Bun.spawn(
    ["bun", "run", CLI_ENTRYPOINT, "transcripts", "list", "--limit", String(limit)],
    { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`transcripts list exited ${exitCode}: ${stderr.slice(0, 500)}`);
  }

  const parsed = JSON.parse(stdout) as {
    conversations?: Array<{ conversationId: string; lastIngestedJsonlTimestamp?: string | null }>;
    truncated?: boolean;
    total?: number;
    returned?: number;
  };

  // Fail loudly rather than silently measuring a subset — a truncated page
  // makes present conversations look never-ingested.
  if (parsed.truncated) {
    throw new Error(
      `transcripts list truncated at ${parsed.returned}/${parsed.total}; raise --list-limit`
    );
  }

  const marks = new Map<string, string | null>();
  for (const c of parsed.conversations ?? []) {
    marks.set(c.conversationId, c.lastIngestedJsonlTimestamp ?? null);
  }
  return marks;
}

async function takeSample(projectsDir: string, activeWindowMs: number, listLimit: number) {
  const sampledAt = new Date().toISOString();
  const active = await findActiveTranscripts(projectsDir, activeWindowMs);
  const marks = await fetchIngestMarks(listLimit);

  const samples: Sample[] = [];
  for (const [conversationId, path] of active) {
    const diskHead = await newestJsonlTimestamp(path);
    const hasRow = marks.has(conversationId);
    const ingestedThrough = marks.get(conversationId) ?? null;

    let lagSeconds: number | null = null;
    if (diskHead && ingestedThrough) {
      lagSeconds = Math.max(0, (Date.parse(diskHead) - Date.parse(ingestedThrough)) / 1000);
    }

    samples.push({
      sampledAt,
      conversationId,
      diskHead,
      ingestedThrough,
      lagSeconds,
      neverIngested: !hasRow,
    });
  }
  return samples;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}

const fmtSeconds = (s: number): string =>
  Number.isNaN(s) ? "n/a" : s >= 3600 ? `${(s / 3600).toFixed(1)}h` : `${s.toFixed(1)}s`;

function describe(lags: number[]): Record<string, unknown> {
  const sorted = [...lags].sort((a, b) => a - b);
  return {
    p50: fmtSeconds(percentile(sorted, 50)),
    p95: fmtSeconds(percentile(sorted, 95)),
    worst: fmtSeconds(sorted[sorted.length - 1] ?? NaN),
    p50Seconds: percentile(sorted, 50),
    p95Seconds: percentile(sorted, 95),
    worstSeconds: sorted[sorted.length - 1] ?? null,
    n: sorted.length,
  };
}

async function summarize(path: string): Promise<void> {
  const raw = await readFile(path, "utf8");
  const rows: Sample[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    rows.push(JSON.parse(t) as Sample);
  }

  const neverIngested = rows.filter((r) => r.neverIngested);
  const sampleTimes = new Set(rows.map((r) => r.sampledAt));
  const conversations = new Set(rows.map((r) => r.conversationId));

  // ── Two strata, and the second is the one to quote ───────────────────────
  //
  // `activeWindow` counts every conversation whose FILE was touched inside
  // `--active-window`. That set includes conversations touched once and already
  // fully ingested, which contribute a lag of exactly 0 — so its p50 moves with
  // how many conversations happened to be touched rather than with how far
  // behind ingest is. Observed live: the same run's p50 read 376.1s at 10
  // samples and 0.0s at 18, purely because a burst of already-caught-up
  // conversations entered the window. A number that swings like that cannot
  // support a before/after comparison.
  //
  // `writing` keeps only observations where the conversation's disk head
  // ADVANCED since its previous sample — it actually produced content in the
  // interval, which is the population "ingest latency" is about. Derived at
  // summarize time from data already recorded, so a run captured before this
  // distinction existed can still be re-summarized with it.
  const previousHead = new Map<string, string | null>();
  const writingLags: number[] = [];
  const activeLags: number[] = [];

  for (const row of [...rows].sort((a, b) => a.sampledAt.localeCompare(b.sampledAt))) {
    if (typeof row.lagSeconds === "number") activeLags.push(row.lagSeconds);

    const prior = previousHead.get(row.conversationId);
    const advanced = prior !== undefined && prior !== row.diskHead;
    previousHead.set(row.conversationId, row.diskHead);

    if (advanced && typeof row.lagSeconds === "number") writingLags.push(row.lagSeconds);
  }

  console.log(
    JSON.stringify(
      {
        file: path,
        samples: sampleTimes.size,
        observations: rows.length,
        conversations: conversations.size,
        windowStart: rows[0]?.sampledAt ?? null,
        windowEnd: rows[rows.length - 1]?.sampledAt ?? null,
        // Quote this one. See the comment above.
        writing: describe(writingLags),
        activeWindow: describe(activeLags),
        neverIngestedObservations: neverIngested.length,
        neverIngestedConversations: [...new Set(neverIngested.map((r) => r.conversationId))],
      },
      null,
      2
    )
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (typeof args.summarize === "string") {
    await summarize(args.summarize);
    return;
  }

  const out = typeof args.out === "string" ? args.out : null;
  if (!out) {
    console.error("--out <file> is required (or --summarize <file>)");
    process.exit(2);
  }

  const projectsDir = join(homedir(), ".claude", "projects");
  const activeWindowMs = Number(args["active-window"] ?? 10) * 60_000;
  const listLimit = Number(args["list-limit"] ?? 5000);
  const everySeconds = Number(args.every ?? 180);
  const minutes = Number(args.minutes ?? 0);
  const deadline = Date.now() + minutes * 60_000;

  do {
    const samples = await takeSample(projectsDir, activeWindowMs, listLimit);
    for (const s of samples) {
      await appendFile(out, `${JSON.stringify(s)}\n`);
    }
    const lags = samples.map((s) => s.lagSeconds).filter((v): v is number => typeof v === "number");
    const worst = lags.length ? Math.max(...lags) : NaN;
    console.log(
      `[${new Date().toISOString()}] ${samples.length} active conversation(s), ` +
        `worst lag ${Number.isNaN(worst) ? "n/a" : `${worst.toFixed(1)}s`}, ` +
        `${samples.filter((s) => s.neverIngested).length} never-ingested`
    );
    if (Date.now() >= deadline) break;
    await Bun.sleep(everySeconds * 1000);
  } while (Date.now() < deadline);
}

await main();
