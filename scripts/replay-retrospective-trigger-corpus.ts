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

const DEFAULT_FILE_COUNT = 60;
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
  json: boolean;
  projectsDir: string;
  corpusDir: string | null;
} {
  let files = DEFAULT_FILE_COUNT;
  let probe = false;
  let json = false;
  let projectsDir = join(homedir(), ".claude", "projects");
  let corpusDir: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--probe") probe = true;
    else if (arg === "--json") json = true;
    else if (arg === "--files") files = Number(argv[++i] ?? DEFAULT_FILE_COUNT);
    else if (arg === "--projects-dir") projectsDir = String(argv[++i] ?? projectsDir);
    else if (arg === "--corpus-dir") corpusDir = String(argv[++i] ?? "");
  }
  return { files, probe, json, projectsDir, corpusDir };
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

const { files, probe, json, projectsDir, corpusDir } = parseArgs(process.argv.slice(2));
process.exit(probe ? runProbe(json) : runReplay(files, projectsDir, json, corpusDir));
