#!/usr/bin/env bun
/**
 * Replay the retrospective-trigger corpus over real assistant turns (mt#3098).
 *
 * WHY THIS EXISTS. `FAMILY_PATTERNS` in `.minsky/hooks/retrospective-trigger-scanner.ts`
 * is a recall/precision tradeoff, and the detector INJECTS — a false positive is
 * recurring operator noise, not a silent log line. Every widening of the corpus
 * therefore needs a precision measurement over REAL turns, and that measurement has
 * to be reproducible by someone who is not the author. Before this script existed,
 * the mt#3098 widening's precision number came from a scratch file that no reviewer
 * could re-run.
 *
 * WHY NOT `transcripts_search-text`. The obvious corpus source is the transcripts DB,
 * but that tool is full-text SEARCH: it needs a query term, so every sample it returns
 * is term-biased — the wrong shape for measuring false positives, which are by
 * definition the turns nobody thought to search for. The local harness JSONLs are the
 * same content one stage earlier (they are what the DB ingests) and are exactly what
 * the hook itself scans, so consecutive-turn sampling from them is unbiased.
 *
 * MEASURING A DELTA. This script reports the fires of ONE checkout's corpus. To get
 * the before/after delta for a corpus change, run it from both checkouts over the same
 * corpus and diff the printed fire lists:
 *
 *     bun scripts/replay-retrospective-trigger-corpus.ts --files 60          # in main
 *     bun scripts/replay-retrospective-trigger-corpus.ts --files 60          # in the session
 *
 * Every fire is printed with family, matched phrase, and surrounding excerpt so the
 * NEW-only ones can be hand-classified as genuine admissions or false positives.
 *
 * PARITY MODE. `--probe` runs a canonical fixture set through BOTH the source scanner
 * and the generated `.claude/hooks` copy the harness actually executes, and fails if
 * they disagree or if any fixture's expectation is unmet — a missed recompile and a
 * regression both surface as a non-zero exit.
 *
 *     bun scripts/replay-retrospective-trigger-corpus.ts --probe
 *
 * Exits 0 with a SKIP notice when no transcript corpus is present (CI, a fresh
 * machine); replay cannot be a hard gate on a machine that has never run the harness.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { detectTriggerPhrases as detectFromSource } from "../.minsky/hooks/retrospective-trigger-scanner";
import { detectTriggerPhrases as detectFromGenerated } from "../.claude/hooks/retrospective-trigger-scanner";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

const DEFAULT_FILE_COUNT = 60;

/**
 * Turns actually embedded in `--rung2` mode (mt#3408).
 *
 * Rung 2 costs one provider round-trip PER TURN (~450ms measured), so replaying
 * the whole corpus the way Rung 1 does would be thousands of calls. This bounds
 * the sample; the bound is reported in the output so a measurement is never
 * mistaken for full-corpus coverage.
 */
const DEFAULT_RUNG2_TURN_LIMIT = 150;
const EXCERPT_RADIUS = 100;

/**
 * Canonical fixtures for `--probe`. Positives are the phrasings mt#3098 widened the
 * corpus for plus the forward-order originals they must not displace; negatives are
 * the near-misses that separate an admission from ordinary narration.
 */
const PROBE_FIXTURES: Array<{ text: string; expect: "fire" | "silent"; note: string }> = [
  {
    text: "I'll invoke it rather than improvise going forward.",
    expect: "fire",
    note: "reversed-order commitment (the 2026-07-23 miss)",
  },
  {
    text: "I improvised a reasonable-looking handoff instead of running the canonical skill.",
    expect: "fire",
    note: "improvised-instead-of admission (the 2026-07-23 miss)",
  },
  {
    text: "Going forward I'll invoke the skill.",
    expect: "fire",
    note: "forward-order commitment (regression guard)",
  },
  {
    text: "I made a mistake on the config.",
    expect: "fire",
    note: "R1 baseline (regression guard)",
  },
  {
    text: "I improvised a fixture for the integration test.",
    expect: "silent",
    note: "improvisation with no skipped-canonical-path contrast",
  },
  {
    text: "The sweeper will keep reconciling going forward.",
    expect: "silent",
    note: "temporal phrase with no first-person commitment",
  },
  {
    text: "I'll rerun the test suite now.",
    expect: "silent",
    note: "first-person future with no commitment phrase",
  },
];

interface Fire {
  family: string;
  phrase: string;
  excerpt: string;
}

function parseArgs(argv: string[]): {
  files: number;
  probe: boolean;
  rung2: boolean;
  rung3: boolean;
  limit: number;
  json: boolean;
  projectsDir: string;
  corpusDir: string | null;
} {
  let files = DEFAULT_FILE_COUNT;
  let probe = false;
  let rung2 = false;
  let rung3 = false;
  let limit = DEFAULT_RUNG2_TURN_LIMIT;
  let json = false;
  let projectsDir = join(homedir(), ".claude", "projects");
  let corpusDir: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--probe") probe = true;
    else if (arg === "--rung2") rung2 = true;
    else if (arg === "--rung3") rung3 = true;
    else if (arg === "--limit") limit = Number(argv[++i] ?? DEFAULT_RUNG2_TURN_LIMIT);
    else if (arg === "--json") json = true;
    else if (arg === "--files") files = Number(argv[++i] ?? DEFAULT_FILE_COUNT);
    else if (arg === "--projects-dir") projectsDir = String(argv[++i] ?? projectsDir);
    else if (arg === "--corpus-dir") corpusDir = String(argv[++i] ?? "");
  }
  return { files, probe, rung2, rung3, limit, json, projectsDir, corpusDir };
}

/**
 * The harness stores a project's transcripts under a directory named after the
 * project's absolute path with separators replaced by dashes. Derived at runtime
 * (never a baked-in absolute) so this runs on any machine and any checkout.
 */
function corpusDirFor(projectsDir: string, repoRoot: string): string {
  return join(projectsDir, repoRoot.replace(/\//g, "-"));
}

/** Assistant turn texts, newest transcript files first. */
function readAssistantTurns(corpusDir: string, fileCount: number): string[] {
  const files = readdirSync(corpusDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, mtime: statSync(join(corpusDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, fileCount);

  const turns: string[] = [];
  for (const { f } of files) {
    let raw: string;
    try {
      raw = readFileSync(join(corpusDir, f), "utf-8");
    } catch {
      continue; // a transcript being rotated mid-read is not a measurement failure
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let rec: { type?: string; message?: { content?: unknown } };
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec?.type !== "assistant") continue;
      const content = rec?.message?.content;
      if (!Array.isArray(content)) continue;
      const text = content
        .filter(
          (b): b is { type: string; text: string } =>
            typeof b === "object" &&
            b !== null &&
            (b as { type?: unknown }).type === "text" &&
            typeof (b as { text?: unknown }).text === "string"
        )
        .map((b) => b.text)
        .join("\n");
      if (text.trim()) turns.push(text);
    }
  }
  return turns;
}

function runProbe(json: boolean): number {
  const results = PROBE_FIXTURES.map((fx) => {
    const source = detectFromSource(fx.text);
    const generated = detectFromGenerated(fx.text);
    const sourceFired = source.length > 0;
    const generatedFired = generated.length > 0;
    return {
      note: fx.note,
      expect: fx.expect,
      sourceFired,
      generatedFired,
      families: source.map((m) => m.family),
      phrase: source[0]?.matchedPhrase ?? null,
      expectationMet: sourceFired === (fx.expect === "fire"),
      parity: sourceFired === generatedFired,
    };
  });

  const failures = results.filter((r) => !r.expectationMet || !r.parity);

  if (json) {
    console.log(JSON.stringify({ mode: "probe", results, failed: failures.length }, null, 2));
  } else {
    for (const r of results) {
      const status = !r.expectationMet ? "EXPECTATION" : !r.parity ? "PARITY" : "ok";
      const fired = r.sourceFired ? `fires [${r.families.join(",")}] "${r.phrase}"` : "silent";
      console.log(`${status.padEnd(11)} ${r.note}\n            → ${fired}`);
    }
    console.log(`\n${results.length - failures.length}/${results.length} fixtures ok`);
    if (failures.length > 0) {
      console.log(
        "PARITY failures mean the generated .claude/hooks copy is stale — recompile before merging."
      );
    }
  }
  return failures.length > 0 ? 1 : 0;
}

function runReplay(
  files: number,
  projectsDir: string,
  json: boolean,
  corpusDirOverride: string | null
): number {
  const repoRoot = resolve(import.meta.dir, "..");
  // A session workspace has its own path-derived corpus dir, which is empty — the
  // conversations being measured live under the MAIN checkout's dir. `--corpus-dir`
  // points the replay at that corpus so the same measurement can run from either.
  const corpusDir = corpusDirOverride ?? corpusDirFor(projectsDir, repoRoot);

  if (!existsSync(corpusDir)) {
    console.log(`SKIP: no transcript corpus at ${corpusDir} — nothing to replay.`);
    return 0;
  }

  const turns = readAssistantTurns(corpusDir, files);
  const fires: Fire[] = [];
  for (const turn of turns) {
    const matches = detectFromSource(turn);
    const first = matches[0];
    if (!first) continue;
    const idx = turn.indexOf(first.matchedPhrase);
    fires.push({
      family: first.family,
      phrase: first.matchedPhrase,
      excerpt: turn
        .slice(Math.max(0, idx - EXCERPT_RADIUS), idx + first.matchedPhrase.length + EXCERPT_RADIUS)
        .replace(/\n/g, " "),
    });
  }

  if (json) {
    console.log(JSON.stringify({ mode: "replay", corpusDir, turns: turns.length, fires }, null, 2));
  } else {
    console.log(`corpus dir:      ${corpusDir}`);
    console.log(`files scanned:   ${files}`);
    console.log(`assistant turns: ${turns.length}`);
    console.log(`fires:           ${fires.length}\n`);
    for (const f of fires) {
      console.log(`[${f.family}] "${f.phrase}"\n    …${f.excerpt}…\n`);
    }
    console.log(
      "Diff this fire list against the same command run from the other checkout to get the delta;\nhand-classify every NEW-only fire as a genuine admission or a false positive."
    );
  }
  return 0;
}

/**
 * Rung-2 fire delta over real turns (mt#3408).
 *
 * Runs Rung 1 and Rung 1+2 over the SAME sampled turns and reports only the
 * turns where Rung 2 added a family Rung 1 missed. Those NEW-ONLY fires are the
 * precision question: each one is either a genuine admission the regex corpus
 * was blind to, or a false positive. This prints them for hand-classification —
 * it deliberately does not guess.
 */
async function runRung2Delta(
  files: number,
  limit: number,
  projectsDir: string,
  json: boolean,
  corpusDirOverride: string | null
): Promise<number> {
  const repoRoot = resolve(import.meta.dir, "..");
  const corpusDir = corpusDirOverride ?? corpusDirFor(projectsDir, repoRoot);
  if (!existsSync(corpusDir)) {
    console.log(`SKIP: no transcript corpus at ${corpusDir} — nothing to replay.`);
    return 0;
  }

  const { detectTriggerPhrasesWithNomination } = await import(
    "../.minsky/hooks/retrospective-trigger-scanner"
  );

  const allTurns = readAssistantTurns(corpusDir, files);
  const turns = allTurns.slice(0, limit);

  const newOnly: Array<{ families: string[]; excerpt: string }> = [];
  let rung1FireCount = 0;
  let degradedCount = 0;

  // This mode measures RUNG 2 in isolation. Since mt#3652 the live path also
  // runs the Rung-3 confirm on nominated turns; disabling it here keeps this
  // mode's cost and semantics exactly what mt#3408 shipped (one embedding call
  // per turn, no completion calls) — `--rung3` is the mode that measures the
  // full pipeline.
  const priorRung3Disable = process.env.MINSKY_DISABLE_RUNG3_CONFIRM;
  process.env.MINSKY_DISABLE_RUNG3_CONFIRM = "1";
  try {
    for (const turn of turns) {
      const rung1 = detectFromSource(turn);
      if (rung1.length > 0) rung1FireCount++;

      const detected = await detectTriggerPhrasesWithNomination(turn);
      if (detected.degradedReason !== undefined) {
        degradedCount++;
        continue;
      }
      if (detected.nominatedFamilies.length === 0) continue;

      const added = detected.matches.find((m) =>
        detected.nominatedFamilies.includes(m.family as string)
      );
      newOnly.push({
        families: detected.nominatedFamilies,
        excerpt: (added?.matchedPhrase ?? turn).slice(0, 2 * EXCERPT_RADIUS).replace(/\n/g, " "),
      });
    }
  } finally {
    if (priorRung3Disable === undefined) delete process.env.MINSKY_DISABLE_RUNG3_CONFIRM;
    else process.env.MINSKY_DISABLE_RUNG3_CONFIRM = priorRung3Disable;
  }

  const summary = {
    mode: "rung2-delta",
    corpusDir,
    turnsAvailable: allTurns.length,
    turnsSampled: turns.length,
    limit,
    rung1Fires: rung1FireCount,
    rung2NewOnlyFires: newOnly.length,
    degradedTurns: degradedCount,
    newOnly,
  };

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`corpus dir:        ${corpusDir}`);
    console.log(`turns available:   ${allTurns.length}`);
    console.log(`turns sampled:     ${turns.length} (bounded by --limit ${limit})`);
    console.log(`Rung-1 fires:      ${rung1FireCount}`);
    console.log(`Rung-2 NEW-only:   ${newOnly.length}`);
    console.log(`degraded turns:    ${degradedCount}\n`);
    for (const f of newOnly) {
      console.log(`[+${f.families.join(",")}] …${f.excerpt}…\n`);
    }
    console.log(
      "Hand-classify every NEW-only fire above as a genuine admission or a false positive,\n" +
        "and record the resulting precision delta in the task's ## Outcome."
    );
  }
  return 0;
}

/**
 * Full-pipeline delta over real turns (mt#3652): Rung 1 + Rung 2 + Rung-3
 * confirm. Where `--rung2` prints every nomination for hand-classification,
 * this mode reports which nominations the confirm stage ENDORSED — each
 * confirmed fire is a turn that would now inject where the pre-Rung-3 hook
 * stayed quiet, so the confirmed list is the new-noise question and the
 * rejected count is the precision the confirm stage added.
 */
async function runRung3Delta(
  files: number,
  limit: number,
  projectsDir: string,
  json: boolean,
  corpusDirOverride: string | null
): Promise<number> {
  const repoRoot = resolve(import.meta.dir, "..");
  const corpusDir = corpusDirOverride ?? corpusDirFor(projectsDir, repoRoot);
  if (!existsSync(corpusDir)) {
    console.log(`SKIP: no transcript corpus at ${corpusDir} — nothing to replay.`);
    return 0;
  }

  const { detectTriggerPhrasesWithNomination } = await import(
    "../.minsky/hooks/retrospective-trigger-scanner"
  );

  const allTurns = readAssistantTurns(corpusDir, files);
  const turns = allTurns.slice(0, limit);

  const confirmedFires: Array<{ families: string[]; excerpt: string }> = [];
  let rung1FireCount = 0;
  let nominatedTurns = 0;
  let rejectedTurns = 0;
  let degradedCount = 0;
  const confirmLatencies: number[] = [];

  for (const turn of turns) {
    const rung1 = detectFromSource(turn);
    if (rung1.length > 0) rung1FireCount++;

    const detected = await detectTriggerPhrasesWithNomination(turn);
    if (detected.degradedReason !== undefined || detected.rung3?.degraded) {
      degradedCount++;
      continue;
    }
    if (detected.nominatedFamilies.length === 0) continue;
    nominatedTurns++;
    if (detected.rung3?.latencyMs !== undefined) confirmLatencies.push(detected.rung3.latencyMs);

    if (detected.confirmedFamilies.length === 0) {
      rejectedTurns++;
      continue;
    }
    const added = detected.matches.find((m) =>
      detected.confirmedFamilies.includes(m.family as string)
    );
    confirmedFires.push({
      families: detected.confirmedFamilies,
      excerpt: (added?.matchedPhrase ?? turn).slice(0, 2 * EXCERPT_RADIUS).replace(/\n/g, " "),
    });
  }

  const meanLatency =
    confirmLatencies.length > 0
      ? Math.round(confirmLatencies.reduce((a, b) => a + b, 0) / confirmLatencies.length)
      : null;

  const summary = {
    mode: "rung3-delta",
    corpusDir,
    turnsAvailable: allTurns.length,
    turnsSampled: turns.length,
    limit,
    rung1Fires: rung1FireCount,
    nominatedTurns,
    confirmedFires: confirmedFires.length,
    rejectedByConfirm: rejectedTurns,
    degradedTurns: degradedCount,
    meanConfirmLatencyMs: meanLatency,
    confirmed: confirmedFires,
  };

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`corpus dir:          ${corpusDir}`);
    console.log(`turns available:     ${allTurns.length}`);
    console.log(`turns sampled:       ${turns.length} (bounded by --limit ${limit})`);
    console.log(`Rung-1 fires:        ${rung1FireCount}`);
    console.log(`nominated turns:     ${nominatedTurns}`);
    console.log(`confirmed (inject):  ${confirmedFires.length}`);
    console.log(`rejected by confirm: ${rejectedTurns}`);
    console.log(`degraded turns:      ${degradedCount}`);
    console.log(`mean confirm ms:     ${meanLatency ?? "n/a"}\n`);
    for (const f of confirmedFires) {
      console.log(`[+${f.families.join(",")}] …${f.excerpt}…\n`);
    }
    console.log(
      "Every confirmed fire above is a turn the pre-Rung-3 hook stayed quiet on;\n" +
        "hand-classify each as a genuine admission or a false positive and record\n" +
        "the result in the task's ## Outcome."
    );
  }
  return 0;
}

async function main(): Promise<number> {
  const { files, probe, rung2, rung3, limit, json, projectsDir, corpusDir } = parseArgs(
    process.argv.slice(2)
  );
  if (probe) return runProbe(json);
  if (rung2) return runRung2Delta(files, limit, projectsDir, json, corpusDir);
  if (rung3) return runRung3Delta(files, limit, projectsDir, json, corpusDir);
  return runReplay(files, projectsDir, json, corpusDir);
}

// Deliberately NOT a top-level await. `--rung2` is the only async path; the
// long-standing `--probe` and default replay paths are synchronous, and a
// top-level await would make the entire module async for every invocation
// style regardless of which path runs. Keeping the entry point a `.then` leaves
// those two paths' execution shape exactly as it was before --rung2 existed.
main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(getLoggableErrorSummary(error));
    process.exit(1);
  }
);
