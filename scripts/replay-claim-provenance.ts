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
 *   bun scripts/replay-claim-provenance.ts <transcript.jsonl> [--list] [--detail]
 *   bun scripts/replay-claim-provenance.ts --sweep <dir> [--limit N] [--exclude S]
 *
 * `--detail` prints, per fire, the transcript, the task id, the cited PR numbers
 * and each offending paragraph. Without it a fire is a bare line number, which
 * cannot be hand-classified — and hand-classification is the ONLY way to tell a
 * true fire from a false one here, so a replay that does not support it forces
 * every tuning pass to hand-roll its own reader (mem#1022's tell: an ad-hoc query
 * where a vetted one should exist).
 *
 * `--exclude <substring>` drops transcripts whose FILENAME contains the
 * substring, and it is a correctness control rather than a convenience. The
 * corpus this sweeps ingests the agent's own conversations, so a session spent
 * tuning THIS guard writes collision prose into specs and then counts itself:
 * the pre-fix baseline for mt#4190 contained a fire that was mt#4190's own spec.
 * Contamination lands entirely in the newest window, which is the window a
 * write-triggered guard is measured on (mem#1067), so it moves a before/after
 * comparison in the flattering direction. Report both numbers, or name the
 * exclusion.
 *
 * A missing path is a SKIP (exit 0), not a failure — transcripts are local
 * artifacts and CI has none.
 *
 * @see .minsky/hooks/claim-provenance-scan.ts — the guard
 * @see scripts/replay-evidence-provenance.ts — the sibling this mirrors
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseTranscript } from "../.minsky/hooks/transcript";
import type { TranscriptLine } from "../.minsky/hooks/transcript";
import {
  run,
  SPEC_TEXT_FIELD_BY_TOOL,
  collisionParagraphs,
  citedPrNumbers,
  extractAuthoredSpecText,
  remainingWorkParagraphs,
  remainingWorkSubjects,
  targetTaskId,
} from "../.minsky/hooks/claim-provenance-scan";
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
  /** Calls whose text carried a recognized claim of any class. */
  claims: number;
  /** Claims with no discharging call in the prefix — the guard injects here. */
  fired: number;
  /** Claims discharged by a call in the prefix — the guard stays silent. */
  discharged: number;
  /** Claims the guard declined to adjudicate (no transcript prefix). */
  skipped: number;
  /**
   * Fires broken out by CLASS (mt#4299).
   *
   * An aggregate count cannot answer the question a new class's posture decision
   * turns on — "how often does THIS one fire, and are those fires true?" — and
   * the guard now carries three. A fire naming two classes increments both, so
   * these sum to at least `fired` rather than exactly it.
   */
  firedByKind: Record<string, number>;
}

/**
 * A FACTORY, not a shared constant — the tally now holds a nested object.
 *
 * This was `const EMPTY: Tally = {…}` spread with `{ ...EMPTY }` at both call
 * sites, which is a SHALLOW copy: every per-transcript tally aliased the one
 * `firedByKind` object hanging off the constant, so each fire accumulated into
 * it globally and `add()` then re-summed the same growing object once per file.
 * The first sweep reported 18 fires and 319 class-fires — arithmetic that cannot
 * happen, which is the only reason it was visible at all. Had the corpus been
 * smaller the inflated numbers would have looked plausible and gone straight
 * into a posture decision.
 */
function emptyTally(): Tally {
  return { considered: 0, claims: 0, fired: 0, discharged: 0, skipped: 0, firedByKind: {} };
}

/**
 * Tool names this guard is registered on, normalized the way it normalizes.
 *
 * Derived from the guard's own map rather than restated, so the sweep can only
 * ever consider the population the guard considers.
 *
 * It reads the `.minsky/hooks` SOURCE while the live guard runs the generated
 * `.claude/hooks` copy, and that is deliberate rather than a drift risk
 * (PR #3139 R1). Pre-commit's `regenerateStagedClaudeHooks` (mt#2977)
 * regenerates and re-STAGES the generated tree whenever a hook source is staged,
 * so the two cannot disagree in a committed tree. The only window where they
 * differ is between an edit and its commit — which is precisely when a replay
 * must measure the edit you just made, not the copy that predates it.
 */
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

interface ReportOptions {
  /** Print one line per fire. */
  list: boolean;
  /** Print the offending paragraphs too, so a fire can be hand-classified. */
  detail: boolean;
}

/**
 * The paragraph excerpt cap.
 *
 * Long enough that a gate-verdict block's shape is recognizable — which is the
 * whole judgement a reader makes here — and short enough that a 40-transcript
 * sweep stays readable in one screenful per fire.
 */
const MAX_PARAGRAPH_CHARS = 900;

/** One offending paragraph, labelled with the class that flagged it. */
function printParagraph(label: string, para: string): void {
  const trimmed = para.trim();
  const shown =
    trimmed.length > MAX_PARAGRAPH_CHARS ? `${trimmed.slice(0, MAX_PARAGRAPH_CHARS)}…` : trimmed;
  process.stdout.write(`        --- ${label} paragraph ---\n`);
  for (const line of shown.split("\n")) process.stdout.write(`        ${line}\n`);
}

function replayOne(path: string, opts: ReportOptions): Tally {
  const tally: Tally = emptyTally();
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

    if (verdict === "matched") {
      tally.fired += 1;
      const kinds = Array.isArray(cal?.["kinds"]) ? (cal["kinds"] as string[]) : [];
      // An unlabelled fire is counted under an explicit bucket rather than
      // dropped: a class breakdown that silently loses rows would understate the
      // very number the posture decision reads.
      for (const kind of kinds.length > 0 ? kinds : ["(unlabelled)"]) {
        tally.firedByKind[kind] = (tally.firedByKind[kind] ?? 0) + 1;
      }
    } else if (verdict === "clean") tally.discharged += 1;
    else tally.skipped += 1;

    if ((opts.list || opts.detail) && verdict === "matched") {
      const kinds = Array.isArray(cal?.["kinds"]) ? (cal["kinds"] as string[]).join("+") : "?";
      // The transcript is part of the identity of a fire. Without it a caller
      // holding a sweep's output cannot get back to the text that fired, which
      // is the one thing hand-classification needs.
      const taskId = typeof target.input["taskId"] === "string" ? target.input["taskId"] : "-";
      process.stdout.write(
        `  FIRE  ${basename(path)}:${target.index + 1}  ${normalize(target.toolName)}  ` +
          `task=${taskId}  [${kinds}]\n`
      );
      if (opts.detail) {
        const text = extractAuthoredSpecText(target.toolName, target.input) ?? "";
        const cited = citedPrNumbers(text);
        process.stdout.write(
          `        citedPRs: ${cited.length > 0 ? cited.join(",") : "(none)"}\n`
        );
        for (const para of collisionParagraphs(text)) {
          printParagraph("collision", para);
        }
        // The remaining-work class prints its resolved SUBJECTS alongside the
        // prose (mt#4299). Without them a reader cannot tell an explicit-id claim
        // from a deictic one resolved against the write's own target — which is
        // the single judgement hand-classifying this class turns on.
        const ownTaskId = targetTaskId(target.input);
        for (const para of remainingWorkParagraphs(text)) {
          const subjects = remainingWorkSubjects(para, ownTaskId);
          if (subjects.length === 0) continue;
          printParagraph(`remaining-work subjects=${subjects.join(",")}`, para);
        }
      }
    }
  }
  return tally;
}

function add(a: Tally, b: Tally): Tally {
  const firedByKind: Record<string, number> = { ...a.firedByKind };
  for (const [kind, n] of Object.entries(b.firedByKind)) {
    firedByKind[kind] = (firedByKind[kind] ?? 0) + n;
  }
  return {
    considered: a.considered + b.considered,
    claims: a.claims + b.claims,
    fired: a.fired + b.fired,
    discharged: a.discharged + b.discharged,
    skipped: a.skipped + b.skipped,
    firedByKind,
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
  // Printed even when empty, and that is the point: a class with ZERO fires is a
  // finding (the ownership half's zero is what mt#4190 §SC4 had to explain), and
  // omitting the line would make "did not fire" indistinguishable from "was not
  // measured".
  const kinds = Object.keys(t.firedByKind).sort();
  process.stdout.write(`  fires by class              : ${kinds.length === 0 ? "(none)" : ""}\n`);
  for (const kind of kinds) {
    process.stdout.write(`    ${kind.padEnd(28)}: ${t.firedByKind[kind]}\n`);
  }
}

const argv = process.argv.slice(2);
const reportOptions: ReportOptions = {
  list: argv.includes("--list"),
  detail: argv.includes("--detail"),
};
const sweepAt = argv.indexOf("--sweep");
const excludeAt = argv.indexOf("--exclude");
const excludeRaw = excludeAt === -1 ? null : (argv[excludeAt + 1] ?? "");
// An `--exclude` with no operand would silently exclude nothing, and the sweep
// would then report a contaminated number under a heading that claims the
// contamination was removed. Refuse instead — the same fail-closed reading the
// `--limit` guard below already applies.
if (excludeRaw !== null && (excludeRaw === "" || excludeRaw.startsWith("--"))) {
  process.stderr.write(`--exclude needs a filename substring; got "${excludeRaw}"\n`);
  process.exit(2);
}
const exclude: string | null = excludeRaw;

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
  const windowed = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(dir, f))
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((x) => x.p);

  // Exclusion applies AFTER the window is taken, never before. Filtering first
  // would backfill the window with OLDER transcripts to reach `limit`, quietly
  // changing the population — and the population is the whole point of the
  // recency ordering (mem#1067: a write-triggered guard is measured against what
  // is currently being written). So the excluded run has a SMALLER denominator
  // than the unexcluded one, and the drop count is printed rather than left for
  // the reader to infer from a total that moved.
  const files =
    exclude === null ? windowed : windowed.filter((p) => !basename(p).includes(exclude));
  const dropped = windowed.length - files.length;

  let total: Tally = emptyTally();
  for (const f of files) {
    try {
      total = add(total, replayOne(f, reportOptions));
    } catch {
      // A malformed transcript is skipped, not fatal — the sweep's value is the
      // aggregate, and one unreadable file must not lose the other 39.
      continue;
    }
  }
  const suffix = exclude === null ? "" : ` (excluded ${dropped} matching "${exclude}")`;
  report(`swept ${files.length} transcript(s) in ${dir}${suffix}`, total);
  process.exit(0);
}

const path = argv[0];
if (!path || !existsSync(path)) {
  process.stdout.write(`SKIP: transcript not found: ${path ?? "(none)"}\n`);
  process.exit(0);
}
report(path, replayOne(path, reportOptions));
