#!/usr/bin/env bun
/**
 * mt#4168 — replay `claim-provenance-scan` over REAL transcripts.
 *
 * Answers the question the guard's registration cannot: at what rate does it
 * actually fire on recorded work, and are those fires true? A guard that
 * INJECTS at a high false-positive rate is the mem#719 failure mode — noise
 * teaches the reader to discount the true positives — and `evidence-record-
 * provenance` shipped record-only for exactly that reason, decided by a replay
 * like this one rather than by a second guess.
 *
 * WHY THE PREFIX MATTERS. The guard runs at PreToolUse, so it sees only the
 * calls that ALREADY happened. Replaying against the whole transcript would
 * hand it discharging calls the live guard could not have seen — including, in
 * the mt#3682 shape, the very search that ran two minutes too late. Every
 * judgement below is made against the prefix ending at the target call's own
 * index, which is what the live guard gets.
 *
 *   bun scripts/replay-claim-provenance.ts <transcript.jsonl> [--list]
 *   bun scripts/replay-claim-provenance.ts --sweep <dir> [--limit N]
 *
 * A missing path is a SKIP (exit 0), not a failure — transcripts are local
 * artifacts and CI has none.
 *
 * @see .minsky/hooks/claim-provenance-scan.ts — the guard
 * @see scripts/replay-evidence-provenance.ts — the sibling this mirrors
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseTranscript } from "../.minsky/hooks/transcript";
import type { TranscriptLine } from "../.minsky/hooks/transcript";
import { run, SPEC_TEXT_FIELD_BY_TOOL } from "../.minsky/hooks/claim-provenance-scan";
import type { DispatchContext } from "../.minsky/hooks/registry";
import type { ToolHookInput } from "../.minsky/hooks/types";
import { deriveBudgets } from "../.minsky/hooks/types";

/**
 * The dispatcher's host cap on this guard's matcher, READ from
 * `.claude/settings.json` rather than hardcoded (PR #3050 R1).
 *
 * A literal here would drift silently the moment the derived timeout moves —
 * and that timeout IS derived (`dispatch-timeout-budget.ts`), so it moves
 * whenever a guard joins the matcher. Falls back only if the file cannot be
 * read, since a replay that refuses to run teaches less than one running on a
 * stale budget it names.
 */
const FALLBACK_HOST_CAP_SEC = 10;

function readHostCapSec(): number {
  try {
    const settings = JSON.parse(readFileSync(".claude/settings.json", "utf8")) as {
      hooks?: { PreToolUse?: Array<{ matcher?: string; hooks?: Array<{ timeout?: number }> }> };
    };
    const block = settings.hooks?.PreToolUse?.find((b) =>
      (b.matcher ?? "").includes("mcp__minsky__tasks_spec_patch")
    );
    const timeout = block?.hooks?.[0]?.timeout;
    return typeof timeout === "number" && timeout > 0 ? timeout : FALLBACK_HOST_CAP_SEC;
  } catch {
    return FALLBACK_HOST_CAP_SEC;
  }
}

const HOST_CAP_SEC = readHostCapSec();

interface Tally {
  /** Calls carrying authored spec text at all. */
  considered: number;
  /** Calls whose text carried a collision or ownership claim. */
  claims: number;
  /** Claims with no discharging call in the prefix — the guard injects here. */
  fired: number;
  /** Claims discharged by a call in the prefix — the guard stays silent. */
  discharged: number;
  /** Claims the guard declined to adjudicate (no transcript prefix). */
  skipped: number;
}

const EMPTY: Tally = { considered: 0, claims: 0, fired: 0, discharged: 0, skipped: 0 };

/** Tool names this guard is registered on, normalized the way it normalizes. */
const TARGET_TOOLS = new Set(Object.keys(SPEC_TEXT_FIELD_BY_TOOL));

function normalize(name: string): string {
  return name
    .replace(/^mcp__.*?__/, "")
    .replace(/\./g, "_")
    .toLowerCase();
}

interface Target {
  index: number;
  toolName: string;
  input: Record<string, unknown>;
}

/** Every spec-write call in the transcript, in order. */
function findTargets(lines: TranscriptLine[]): Target[] {
  const out: Target[] = [];
  lines.forEach((line, index) => {
    const content = (line as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as { type?: unknown; name?: unknown; input?: unknown };
      if (b.type !== "tool_use" || typeof b.name !== "string") continue;
      if (!TARGET_TOOLS.has(normalize(b.name))) continue;
      out.push({
        index,
        toolName: b.name,
        input: (b.input ?? {}) as Record<string, unknown>,
      });
    }
  });
  return out;
}

function replayOne(path: string, list: boolean): Tally {
  const tally: Tally = { ...EMPTY };
  const lines = parseTranscript(path);
  for (const target of findTargets(lines)) {
    // The PREFIX, not the whole file — see the header.
    const prefix = lines.slice(0, target.index);
    // Built as the real types rather than cast through `unknown`: a replay
    // whose inputs are shaped by an assertion can drift from what the
    // dispatcher actually hands the guard, and this script's only value is
    // being a faithful stand-in for that.
    const input: ToolHookInput = {
      session_id: `replay:${path}`,
      cwd: process.cwd(),
      hook_event_name: "PreToolUse",
      tool_name: target.toolName,
      tool_input: target.input,
    };
    const ctx: DispatchContext = {
      event: "PreToolUse",
      hostCapSec: HOST_CAP_SEC,
      budgets: deriveBudgets(HOST_CAP_SEC),
      transcriptCandidates: [path],
      transcriptLines: prefix,
    };

    const outcome = run(input, ctx);
    const cal = outcome?.calibration as Record<string, unknown> | undefined;
    const verdict = typeof cal?.["outcome"] === "string" ? (cal["outcome"] as string) : "none";
    const reason = typeof cal?.["reason"] === "string" ? (cal["reason"] as string) : "";

    if (verdict === "skipped" && reason.startsWith("no authored spec text")) continue;
    tally.considered += 1;

    if (verdict === "clean" && reason === "no provenance-bearing claim") continue;
    tally.claims += 1;

    if (verdict === "matched") tally.fired += 1;
    else if (verdict === "clean") tally.discharged += 1;
    else tally.skipped += 1;

    if (list && verdict === "matched") {
      const kinds = Array.isArray(cal?.["kinds"]) ? (cal["kinds"] as string[]).join("+") : "?";
      process.stdout.write(
        `  FIRE  line ${target.index + 1}  ${normalize(target.toolName)}  [${kinds}]\n`
      );
    }
  }
  return tally;
}

function add(a: Tally, b: Tally): Tally {
  return {
    considered: a.considered + b.considered,
    claims: a.claims + b.claims,
    fired: a.fired + b.fired,
    discharged: a.discharged + b.discharged,
    skipped: a.skipped + b.skipped,
  };
}

function report(label: string, t: Tally): void {
  const rate = t.claims === 0 ? "n/a" : `${((t.fired / t.claims) * 100).toFixed(1)}%`;
  process.stdout.write(
    `${label}\n` +
      `  spec-write calls considered : ${t.considered}\n` +
      `  carrying a claim            : ${t.claims}\n` +
      `  FIRED (no discharging call) : ${t.fired}\n` +
      `  discharged (silent)         : ${t.discharged}\n` +
      `  not adjudicable             : ${t.skipped}\n` +
      `  fire rate over claims       : ${rate}\n`
  );
}

const argv = process.argv.slice(2);
const list = argv.includes("--list");
const sweepAt = argv.indexOf("--sweep");

if (sweepAt !== -1) {
  const dir = argv[sweepAt + 1];
  const limitAt = argv.indexOf("--limit");
  const limitRaw = limitAt === -1 ? 40 : Number.parseInt(argv[limitAt + 1] ?? "", 10);
  // An unparseable --limit must not sweep zero transcripts and report a clean
  // run (PR #3050 R1): a silently empty sweep is indistinguishable from a
  // corpus with no claims, which is the one reading this script exists to rule
  // out.
  if (!Number.isInteger(limitRaw) || limitRaw <= 0) {
    process.stderr.write(`--limit must be a positive integer; got "${argv[limitAt + 1] ?? ""}"\n`);
    process.exit(2);
  }
  const limit = limitRaw;
  if (!dir || !existsSync(dir)) {
    process.stdout.write(`SKIP: sweep dir not found: ${dir ?? "(none)"}\n`);
    process.exit(0);
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((x) => x.p);

  let total: Tally = { ...EMPTY };
  for (const f of files) {
    try {
      total = add(total, replayOne(f, list));
    } catch {
      // A malformed transcript is skipped, not fatal — the sweep's value is the
      // aggregate, and one unreadable file must not lose the other 39.
      continue;
    }
  }
  report(`swept ${files.length} transcript(s) in ${dir}`, total);
  process.exit(0);
}

const path = argv[0];
if (!path || !existsSync(path)) {
  process.stdout.write(`SKIP: transcript not found: ${path ?? "(none)"}\n`);
  process.exit(0);
}
report(path, replayOne(path, list));
