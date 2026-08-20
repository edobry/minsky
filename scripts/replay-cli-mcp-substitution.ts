#!/usr/bin/env bun
/**
 * Replays real Claude Code transcripts through `cli-mcp-substitution`'s OLD and NEW suppression
 * rules and reports how the verdicts differ (mt#4353).
 *
 * Why this exists. The change swaps a monotonic suppression ("any MCP success silences the rest of
 * the session") for a run-length one ("a success silences only the next substitution"). The obvious
 * way to size that — replaying the calibration log — cannot work: the log records only substitution
 * events, never the MCP successes that reset the counter, so it can produce an UPPER BOUND and
 * nothing tighter. Measured that way the bound was 467 of 529 (88%), which is uninformative
 * precisely because every interleaved MCP success is invisible to it.
 *
 * Transcripts carry both, so this replays those instead and reports the real delta.
 *
 * Usage:
 *   bun scripts/replay-cli-mcp-substitution.ts [--limit N] [--dir <path>] [--verbose]
 *
 * Exit codes: 0 = replay completed (whatever it found); 2 = could not replay (no transcripts, no
 * manifest). Never 1 — this measures, it does not pass or fail.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { readManifest, scanCommand } from "../.minsky/hooks/detect-cli-mcp-substitution";
import { extractToolResultText, TOOL_DENIAL_MARKER } from "../.minsky/hooks/transcript";

const MCP_TOOL_NAME_PATTERN = /^mcp__minsky__/;
const COMMAND_TOOL_NAMES = new Set(["Bash", "mcp__minsky__session_exec"]);
const DEFAULT_LIMIT = 200;

interface Block {
  type?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  is_error?: boolean;
  input?: Record<string, unknown>;
  content?: unknown;
}

function defaultTranscriptDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Newest-first transcript paths. `root` may be either the projects ROOT (whose children are
 * per-project directories) or a single project directory holding `.jsonl` files directly — pointing
 * at one project is how you scope the measurement to the population the guard actually runs in,
 * so both shapes have to work.
 */
function findTranscripts(root: string, limit: number): string[] {
  if (!fs.existsSync(root)) return [];
  const files: Array<{ file: string; mtime: number }> = [];

  const collect = (dir: string): void => {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path.join(dir, f);
      try {
        files.push({ file: full, mtime: fs.statSync(full).mtimeMs });
      } catch {
        // intentional-swallow: a transcript that vanished mid-scan is not a measurement error.
      }
    }
  };

  collect(root);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) collect(path.join(root, entry.name));
  }
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((f) => f.file);
}

/**
 * Every tool_use on a parsed line, across BOTH transcript shapes — a top-level
 * `type: "tool_use"` line and an assistant line whose `message.content` holds `tool_use` blocks.
 * Mirrors the guard's own `toolUsesOf` (PR #3186 R1): a measurement that parses less than
 * production does biases the delta it reports.
 */
function toolUsesOf(line: string): Block[] {
  const uses: Block[] = [];
  try {
    const parsed = JSON.parse(line) as {
      type?: string;
      name?: string;
      tool_name?: string;
      id?: string;
      input?: Record<string, unknown>;
    };
    if (parsed.type === "tool_use") {
      const name = parsed.name ?? parsed.tool_name;
      if (typeof name === "string") {
        uses.push({ type: "tool_use", name, id: parsed.id, input: parsed.input });
      }
    }
  } catch {
    // intentional-swallow: a truncated trailing line is normal in a live transcript.
  }
  for (const block of blocksOf(line)) {
    if (block.type === "tool_use") uses.push(block);
  }
  return uses;
}

function blocksOf(line: string): Block[] {
  try {
    const parsed = JSON.parse(line) as { message?: { content?: unknown } };
    const content = parsed.message?.content;
    return Array.isArray(content) ? (content as Block[]) : [];
  } catch {
    // intentional-swallow: a truncated trailing line is normal in a live transcript.
    return [];
  }
}

interface Delta {
  file: string;
  /** Substitutions the OLD rule suppressed and the NEW rule fires on. */
  newlyFiring: number;
  /** Substitutions both rules fire on (no MCP success yet). */
  firingBoth: number;
  /** Substitutions both rules suppress. */
  suppressedBoth: number;
  runLengths: number[];
}

function replay(file: string, manifest: NonNullable<ReturnType<typeof readManifest>>): Delta {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);

  // Pass 1: correlate every tool_result to its tool_use, exactly as the hook does.
  const resultById = new Map<string, { text: string; isError: boolean }>();
  for (const line of lines) {
    for (const block of blocksOf(line)) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const prior = resultById.get(block.tool_use_id);
      resultById.set(block.tool_use_id, {
        text: (prior?.text ?? "") + extractToolResultText(block.content),
        isError: (prior?.isError ?? false) || block.is_error === true,
      });
    }
  }

  const delta: Delta = {
    file,
    newlyFiring: 0,
    firingBoth: 0,
    suppressedBoth: 0,
    runLengths: [],
  };

  // Pass 2: walk in order. At each substitution, decide as `run()` would have, BEFORE folding this
  // call into the state — the hook is PreToolUse, so the pending call is never in its own window.
  let succeeded = false;
  let run = 0;

  for (const line of lines) {
    for (const block of toolUsesOf(line)) {
      if (typeof block.name !== "string") continue;
      const name = block.name;

      const command = block.input?.["command"];
      const isSubstitution =
        COMMAND_TOOL_NAMES.has(name) &&
        typeof command === "string" &&
        command !== "" &&
        scanCommand(command, manifest).matched;

      if (isSubstitution) {
        const oldSuppressed = succeeded;
        const newSuppressed = succeeded && run === 0;
        if (oldSuppressed && !newSuppressed) {
          delta.newlyFiring++;
          delta.runLengths.push(run);
        } else if (!oldSuppressed && !newSuppressed) {
          delta.firingBoth++;
        } else if (oldSuppressed && newSuppressed) {
          delta.suppressedBoth++;
        }
        run++;
      }

      if (!MCP_TOOL_NAME_PATTERN.test(name) || typeof block.id !== "string") continue;
      const outcome = resultById.get(block.id);
      if (!outcome || outcome.isError || TOOL_DENIAL_MARKER.test(outcome.text)) continue;
      succeeded = true;
      if (!isSubstitution) run = 0;
    }
  }

  return delta;
}

function main(): number {
  const argv = process.argv.slice(2);
  const limitFlag = argv.indexOf("--limit");
  const dirFlag = argv.indexOf("--dir");
  const verbose = argv.includes("--verbose");
  const limit = limitFlag >= 0 ? Number(argv[limitFlag + 1]) : DEFAULT_LIMIT;
  const dir = dirFlag >= 0 ? String(argv[dirFlag + 1]) : defaultTranscriptDir();

  const manifest = readManifest();
  if (!manifest) {
    console.error("COULD NOT REPLAY: completion manifest missing. Run `bun run build` first.");
    return 2;
  }

  const files = findTranscripts(dir, limit);
  if (files.length === 0) {
    console.error(`COULD NOT REPLAY: no transcripts under ${dir}.`);
    return 2;
  }

  const deltas = files.map((f) => replay(f, manifest));
  const sum = (pick: (d: Delta) => number): number => deltas.reduce((a, d) => a + pick(d), 0);

  const newlyFiring = sum((d) => d.newlyFiring);
  const firingBoth = sum((d) => d.firingBoth);
  const suppressedBoth = sum((d) => d.suppressedBoth);
  const substitutions = newlyFiring + firingBoth + suppressedBoth;
  const sessionsAffected = deltas.filter((d) => d.newlyFiring > 0).length;

  console.log(`transcripts replayed:        ${files.length}`);
  console.log(`substitution calls seen:     ${substitutions}`);
  console.log("");
  console.log(`fires under BOTH rules:      ${firingBoth}  (no MCP success yet — unchanged)`);
  console.log(
    `suppressed under BOTH:       ${suppressedBoth}  (first substitution after a success)`
  );
  console.log(`NEWLY firing under mt#4353:  ${newlyFiring}`);
  console.log("");
  const oldTotal = firingBoth;
  const newTotal = firingBoth + newlyFiring;
  console.log(`total fires: ${oldTotal} (old) -> ${newTotal} (new)`);
  console.log(`sessions with >=1 new fire:  ${sessionsAffected} of ${files.length}`);

  if (verbose) {
    const worst = [...deltas].sort((a, b) => b.newlyFiring - a.newlyFiring).slice(0, 10);
    console.log("\nmost-affected transcripts:");
    for (const d of worst) {
      if (d.newlyFiring === 0) continue;
      console.log(`  ${d.newlyFiring.toString().padStart(4)}  ${path.basename(d.file)}`);
    }
  }

  return 0;
}

process.exit(main());
