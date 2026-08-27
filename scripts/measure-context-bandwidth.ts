#!/usr/bin/env bun
/**
 * Measure context re-upload cost from local Claude Code transcripts (mt#3842).
 *
 * The Messages API is stateless: every request re-sends the system prompt, all
 * tool schemas, and every prior message and tool result. Prompt caching prices
 * the unchanged prefix at 0.1x — it does NOT avoid the re-send (mem#762). So
 * the tokens a request carries are the tokens that went over the wire, and a
 * transcript is a record of bandwidth as well as of spend.
 *
 * This script answers three questions mt#3842 asks and had no numbers for:
 *
 *   1. **The re-upload tail.** A result of size S added at request i of an
 *      N-request session is re-sent (N − i) times. `--tail` reports the measured
 *      distribution of N, which is what turns that formula into a cost.
 *   2. **The session-length curve.** Upload grows with the SQUARE of session
 *      length when context grows linearly. `--curve` bins real sessions by
 *      request count and reports upload per session, so the quadratic can be
 *      confirmed or refuted against data rather than asserted.
 *   3. **Subagent dispatch as a bandwidth lever.** A subagent carries its own
 *      context and returns a summary, so its internal re-uploads never touch the
 *      parent's tail. `--subagents` measures internal upload against returned
 *      summary size — the ratio IS the lever.
 *
 * ## What this emits, on every channel
 *
 * Counts, token sums, byte sizes, and opaque ids. **No prompt text, no tool
 * results, no message content, on any channel** — and the enumeration is the
 * claim, not the intent (`claim-confidence.mdc`): stdout carries the aggregates
 * below; `--json <path>` writes those same aggregates to a local file; there are
 * no network calls, no subprocesses, and nothing is handed to a third-party SDK.
 * `assertNoText` below enforces it on the JSON path rather than trusting this
 * paragraph.
 *
 * Read-only with respect to the transcript corpus.
 */

import { readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code's per-project transcript directory, derived rather than hardcoded. */
function projectTranscriptDir(cwd: string): string {
  // The harness encodes the project path by replacing every separator with `-`.
  return join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"));
}

interface RequestUsage {
  /** Total prompt tokens carried by one API request — this is the uploaded context. */
  promptTokens: number;
  outputTokens: number;
}

interface SessionMeasurement {
  sessionId: string;
  /** Deduped API requests. NOT line count — see `groupRequests`. */
  requests: number;
  /** Sum of prompt tokens across every request: the session's total upload. */
  uploadedTokens: number;
  /** The largest single request's prompt — the context high-water mark. */
  peakContextTokens: number;
}

interface SubagentMeasurement {
  agentId: string;
  requests: number;
  /** What the subagent re-uploaded internally, and the parent never paid. */
  internalUploadedTokens: number;
  /** Bytes of the subagent's final assistant text — what the parent DID pay for. */
  returnedSummaryBytes: number;
}

/**
 * Group a transcript's assistant lines into API requests.
 *
 * **This is the measurement trap, and it is why raw line counts are wrong**
 * (mem#762): Claude Code writes ONE JSONL LINE PER CONTENT BLOCK, so a single
 * API response spans several lines sharing one `message.id`. Counting lines
 * over-counts requests — measured at 2.27x on this repo's largest transcript,
 * against mem#762's 2.36x — and makes a batched parallel tool call look serial.
 *
 * `message.id` is the key rather than `requestId`: on that same file the two
 * agree to within one line, and the line `requestId` was missing from is one
 * `message.id` covers.
 */
function groupRequests(filePath: string): RequestUsage[] {
  const byMessageId = new Map<string, RequestUsage>();
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    // An unreadable transcript is skipped, not fatal: the corpus is a directory
    // of files written by another process, some of which may be mid-write.
    return [];
  }

  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a partially-flushed final line is normal, not an error
    }
    if (typeof record !== "object" || record === null) continue;
    const entry = record as { type?: unknown; message?: unknown };
    if (entry.type !== "assistant") continue;
    const message = entry.message as { id?: unknown; usage?: unknown } | undefined;
    const id = message?.id;
    if (typeof id !== "string" || byMessageId.has(id)) continue;

    const usage = message?.usage as Record<string, unknown> | undefined;
    if (usage === undefined) continue;
    const num = (k: string): number => (typeof usage[k] === "number" ? (usage[k] as number) : 0);
    byMessageId.set(id, {
      // Every one of the three is prompt content the client sent. Cache reads
      // are priced at 0.1x, not exempted from transmission.
      promptTokens:
        num("input_tokens") + num("cache_creation_input_tokens") + num("cache_read_input_tokens"),
      outputTokens: num("output_tokens"),
    });
  }
  return [...byMessageId.values()];
}

function measureSession(filePath: string, sessionId: string): SessionMeasurement | null {
  const requests = groupRequests(filePath);
  if (requests.length === 0) return null;
  let uploaded = 0;
  let peak = 0;
  for (const r of requests) {
    uploaded += r.promptTokens;
    if (r.promptTokens > peak) peak = r.promptTokens;
  }
  return {
    sessionId,
    requests: requests.length,
    uploadedTokens: uploaded,
    peakContextTokens: peak,
  };
}

/** Bytes of the last assistant text block — the subagent's return value to its parent. */
function finalAssistantTextBytes(filePath: string): number {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return 0;
  }
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined || line.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = record as { type?: unknown; message?: unknown };
    if (entry.type !== "assistant") continue;
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    let bytes = 0;
    for (const block of content) {
      const b = block as { type?: unknown; text?: unknown };
      // Length only — the text itself is never retained or emitted.
      if (b.type === "text" && typeof b.text === "string") bytes += Buffer.byteLength(b.text);
    }
    if (bytes > 0) return bytes;
  }
  return 0;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

function measureSessions(dir: string): SessionMeasurement[] {
  if (!existsSync(dir)) return [];
  const out: SessionMeasurement[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const m = measureSession(join(dir, name), name.replace(/\.jsonl$/, ""));
    if (m !== null) out.push(m);
  }
  return out;
}

function measureSubagents(dir: string): SubagentMeasurement[] {
  if (!existsSync(dir)) return [];
  const out: SubagentMeasurement[] = [];
  for (const name of readdirSync(dir)) {
    const subDir = join(dir, name, "subagents");
    let entries: string[];
    try {
      if (!statSync(join(dir, name)).isDirectory() || !existsSync(subDir)) continue;
      entries = readdirSync(subDir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(subDir, file);
      const requests = groupRequests(path);
      if (requests.length === 0) continue;
      out.push({
        agentId: file.replace(/^agent-/, "").replace(/\.jsonl$/, ""),
        requests: requests.length,
        internalUploadedTokens: requests.reduce((sum, r) => sum + r.promptTokens, 0),
        returnedSummaryBytes: finalAssistantTextBytes(path),
      });
    }
  }
  return out;
}

/**
 * Fail closed if any payload field could carry transcript text.
 *
 * The docblock claims this script emits no content; a claim about a data flow
 * should be gated rather than described (`claim-confidence.mdc` — a `never
 * emits` sentence whose scope silently equals the channel its author had in
 * mind). Every value written to the JSON channel must be a number, or a string
 * that is an opaque id or a bin label.
 */
function assertNoText(payload: unknown, path: string[] = []): void {
  if (typeof payload === "number" || typeof payload === "boolean" || payload === null) return;
  if (typeof payload === "string") {
    // Ids and labels are short and have no whitespace runs; message text is not.
    if (payload.length > 120 || /\s{2,}|\n/.test(payload)) {
      throw new Error(`refusing to emit possible transcript text at ${path.join(".") || "<root>"}`);
    }
    return;
  }
  if (Array.isArray(payload)) {
    payload.forEach((v, i) => assertNoText(v, [...path, String(i)]));
    return;
  }
  if (typeof payload === "object") {
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
      assertNoText(v, [...path, k]);
    }
    return;
  }
  throw new Error(`unexpected payload type at ${path.join(".") || "<root>"}`);
}

const SESSION_BINS: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: "1-49", min: 1, max: 49 },
  { label: "50-99", min: 50, max: 99 },
  { label: "100-199", min: 100, max: 199 },
  { label: "200-399", min: 200, max: 399 },
  { label: "400-799", min: 400, max: 799 },
  { label: "800+", min: 800, max: Number.MAX_SAFE_INTEGER },
];

function main(): void {
  const args = process.argv.slice(2);
  // Keyed on whether a SECTION was selected, not on whether any argument was
  // passed: the first version asked `args.length === 0`, so supplying
  // `--project` alone turned every section off and the run printed a corpus
  // header and nothing else — exit 0, no error, no output worth reading.
  const SECTIONS = ["--tail", "--curve", "--subagents"] as const;
  const selected = SECTIONS.filter((s) => args.includes(s));
  const wantAll = selected.length === 0 || args.includes("--all");
  const want = (flag: string): boolean => wantAll || args.includes(flag);
  const jsonIdx = args.indexOf("--json");
  const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : undefined;

  const projectIdx = args.indexOf("--project");
  const dir = projectIdx >= 0 ? args[projectIdx + 1] : projectTranscriptDir(process.cwd());
  if (dir === undefined || !existsSync(dir)) {
    console.log(`SKIP: no transcript directory at ${dir ?? "<unset>"}`);
    process.exit(0);
  }

  const sessions = measureSessions(dir);
  if (sessions.length === 0) {
    console.log(`SKIP: no readable transcripts under ${dir}`);
    process.exit(0);
  }

  const payload: Record<string, unknown> = { sessionCount: sessions.length };
  console.log(`corpus: ${sessions.length} sessions under ${dir.replace(homedir(), "~")}\n`);

  if (want("--tail")) {
    const counts = sessions.map((s) => s.requests).sort((a, b) => a - b);
    const total = counts.reduce((a, b) => a + b, 0);
    const tail = {
      medianRequests: percentile(counts, 50),
      p90Requests: percentile(counts, 90),
      maxRequests: counts[counts.length - 1] ?? 0,
      meanRequests: Math.round(total / counts.length),
    };
    payload.tail = tail;
    console.log("## Re-upload tail — distribution of session length (requests)");
    console.log(
      `median ${tail.medianRequests}  p90 ${tail.p90Requests}  max ${tail.maxRequests}  mean ${tail.meanRequests}`
    );
    // The tail multiplier a result pays depends on WHERE in the session it lands.
    // Emitted at the median and p90 so the formula has real numbers attached.
    for (const n of [tail.medianRequests, tail.p90Requests, tail.maxRequests]) {
      console.log(
        `  a 100 KB result at request 1 of ${n} is re-sent ${n - 1}x -> ${(((n - 1) * 100) / 1024).toFixed(1)} MB`
      );
    }
    console.log("");
  }

  if (want("--curve")) {
    const bins = SESSION_BINS.map((bin) => {
      const inBin = sessions.filter((s) => s.requests >= bin.min && s.requests <= bin.max);
      const uploaded = inBin.reduce((a, s) => a + s.uploadedTokens, 0);
      const reqs = inBin.reduce((a, s) => a + s.requests, 0);
      return {
        bin: bin.label,
        sessions: inBin.length,
        meanRequests: inBin.length > 0 ? Math.round(reqs / inBin.length) : 0,
        meanUploadedMTokens: inBin.length > 0 ? uploaded / inBin.length / 1e6 : 0,
        meanTokensPerRequest: reqs > 0 ? Math.round(uploaded / reqs) : 0,
      };
    }).filter((b) => b.sessions > 0);
    payload.curve = bins;
    console.log("## Session-length curve — upload vs length");
    console.log("bin            sessions  mean reqs  mean upload (Mtok)  mean tok/req");
    for (const b of bins) {
      console.log(
        `${b.bin.padEnd(14)} ${String(b.sessions).padStart(8)} ${String(b.meanRequests).padStart(10)} ${b.meanUploadedMTokens.toFixed(1).padStart(19)} ${String(b.meanTokensPerRequest).padStart(13)}`
      );
    }
    console.log("");
  }

  if (want("--subagents")) {
    const subs = measureSubagents(dir);
    if (subs.length === 0) {
      console.log("## Subagent lever — no subagent transcripts found\n");
    } else {
      const internal = subs.reduce((a, s) => a + s.internalUploadedTokens, 0);
      const returned = subs.reduce((a, s) => a + s.returnedSummaryBytes, 0);
      const reqs = subs.reduce((a, s) => a + s.requests, 0);
      // ~4 bytes/token is the standard English approximation; used only to put
      // the two sides in one unit, and the ratio is robust to it being rough.
      const returnedTokens = returned / 4;
      const lever = {
        subagents: subs.length,
        totalRequests: reqs,
        internalUploadedMTokens: internal / 1e6,
        returnedSummaryMBytes: returned / 1e6,
        containmentRatio: returnedTokens > 0 ? internal / returnedTokens : 0,
        medianReturnedBytes: percentile(
          subs.map((s) => s.returnedSummaryBytes).sort((a, b) => a - b),
          50
        ),
      };
      payload.subagentLever = lever;
      console.log("## Subagent lever — internal upload vs what the parent pays");
      console.log(`subagents ${lever.subagents}, ${lever.totalRequests} requests`);
      console.log(`internal upload      ${lever.internalUploadedMTokens.toFixed(1)} Mtok`);
      console.log(
        `returned to parent   ${lever.returnedSummaryMBytes.toFixed(2)} MB (~${(returnedTokens / 1e6).toFixed(2)} Mtok)`
      );
      console.log(`containment ratio    ${lever.containmentRatio.toFixed(0)}x`);
      console.log(`median return        ${lever.medianReturnedBytes} bytes\n`);
    }
  }

  if (jsonOut !== undefined) {
    assertNoText(payload);
    writeFileSync(jsonOut, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`wrote ${jsonOut}`);
  }
}

main();
