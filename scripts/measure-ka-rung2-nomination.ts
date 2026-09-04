#!/usr/bin/env bun
/**
 * mt#3772 — measure Rung-2 nomination for the knowledge-acquisition detector
 * against its OWN recorded corpus.
 *
 * What this answers, and why it needs its own script: ADR-024 sign-off (b)
 * gates enabling a rung on measured precision ("0 known-FP AND <=5% new
 * false-negative"), and `DEFAULT_SIMILARITY_THRESHOLD` (0.455) was derived from
 * the retrospective-trigger exemplar band — a different question against
 * different text. Nothing has measured where research-text-vs-skill-description
 * cosines actually live, so the threshold cannot be assumed to transfer.
 *
 * The corpus is the detector's own calibration log. Records carrying
 * `matchedTextExcerpt` (added by mt#3617) are the only ones usable here — a
 * record without it cannot be replayed, because the text the gate scored is
 * not recoverable from the record. That is the instrumentation mt#3617 shipped
 * precisely so this measurement could be run at all.
 *
 * Usage:
 *   bun scripts/measure-ka-rung2-nomination.ts [--threshold 0.4] [--limit N]
 *
 * Exit codes: 0 on a completed run (or a documented SKIP), non-zero on error.
 */
import "reflect-metadata";

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  nominate,
  DEFAULT_SIMILARITY_THRESHOLD,
  type ExemplarSet,
  type NominationDeps,
} from "../packages/domain/src/detectors/embedding-nomination";
import { extractFrontmatterDescription } from "../.minsky/hooks/knowledge-acquisition-detector";
import { calibrationLogPath } from "../.minsky/hooks/dispatcher";
import { resolve } from "node:path";

/**
 * mt#4971: resolved through the WRITER's own function rather than the pre-mt#4748
 * repo path, which no longer exists — reading it produced a SKIP that looked like
 * "no records" rather than "wrong location". `fallbackCwd` (not `projectDir`) keeps
 * the resolver's `CLAUDE_PROJECT_DIR` tier ahead of this checkout.
 */
const CALIBRATION_LOG = calibrationLogPath("knowledge-acquisition", {
  fallbackCwd: resolve(import.meta.dir, ".."),
});
const SKILL_ROOT = ".claude/skills";

interface Record_ {
  session_id?: string;
  loadedSkills?: string[];
  matchedSkill?: string;
  matchedKeyword?: string;
  matchedTextExcerpt?: string;
  hadPropagation?: boolean;
}

function parseArgs(): {
  threshold: number;
  limit: number;
  log: string;
  skillRoot: string;
  out: string;
  classify: string;
} {
  const argv = process.argv.slice(2);
  const read = (flag: string, fallback: number): number => {
    const i = argv.indexOf(flag);
    if (i === -1) return fallback;
    const v = Number(argv[i + 1]);
    return Number.isFinite(v) ? v : fallback;
  };
  const readStr = (flag: string, fallback: string): string => {
    const i = argv.indexOf(flag);
    return i === -1 ? fallback : (argv[i + 1] ?? fallback);
  };
  // `--log` / `--skill-root` exist because the calibration log is local state,
  // not repo content: a session workspace is a fresh clone and has neither the
  // accumulated log nor the operator's skill set. Without these the measurement
  // could only ever run from the main workspace.
  return {
    threshold: read("--threshold", 0.0),
    limit: read("--limit", 1000),
    log: readStr("--log", CALIBRATION_LOG),
    skillRoot: readStr("--skill-root", SKILL_ROOT),
    out: readStr("--out", ""),
    classify: readStr("--classify", ""),
  };
}

async function buildDeps(): Promise<NominationDeps | null> {
  const { initializeConfiguration, CustomConfigFactory, getConfiguration } = await import(
    "../packages/domain/src/configuration"
  );
  const { createEmbeddingServiceFromConfig } = await import(
    "../packages/domain/src/ai/embedding-service-factory"
  );

  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const config = await getConfiguration();
  const provider = config.embeddings?.provider || config.ai?.defaultProvider || "openai";
  if (provider === "local") {
    process.stderr.write(
      "SKIP: embeddings.provider is 'local' (hash stub, no semantic signal) — " +
        "this measurement needs a real provider.\n"
    );
    return null;
  }

  return { embeddingService: await createEmbeddingServiceFromConfig(), semantic: true };
}

/** One exemplar set per loaded skill, its description as the exemplar. */
function buildExemplarSets(loadedSkills: string[], skillRoot: string): ExemplarSet[] {
  const sets: ExemplarSet[] = [];
  for (const skill of loadedSkills) {
    const path = join(skillRoot, skill, "SKILL.md");
    if (!existsSync(path)) continue;
    const description = extractFrontmatterDescription(readFileSync(path, "utf8"));
    if (description.trim().length > 0) sets.push({ family: skill, exemplars: [description] });
  }
  return sets;
}

async function main(): Promise<void> {
  const { threshold, limit, log, skillRoot, out, classify } = parseArgs();

  if (!existsSync(log)) {
    process.stderr.write(`SKIP: ${log} not present.\n`);
    return;
  }

  const all: Record_[] = [];
  for (const line of readFileSync(log, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      all.push(JSON.parse(line) as Record_);
    } catch {
      // A malformed line is a corpus defect, not a reason to abandon the run —
      // report the count at the end rather than dying on the first one.
    }
  }

  const replayable = all
    .filter((r) => r.matchedTextExcerpt && (r.loadedSkills?.length ?? 0) > 0)
    .slice(0, limit);

  process.stdout.write(
    `corpus: ${all.length} records, ${replayable.length} replayable ` +
      `(carry matchedTextExcerpt + loadedSkills)\n` +
      `inherited threshold (retrospective band): ${DEFAULT_SIMILARITY_THRESHOLD}\n` +
      `scoring threshold for this run: ${threshold}\n\n`
  );

  if (replayable.length === 0) {
    process.stdout.write(
      "Nothing replayable. Records predating mt#3617's instrumentation carry no\n" +
        "excerpt, so the text the gate scored cannot be recovered.\n"
    );
    return;
  }

  const deps = await buildDeps();
  if (deps === null) return;

  interface Row {
    lexicalSkill: string | null;
    lexicalKeyword: string | null;
    rung2Skill: string | null;
    score: number | null;
    verdict: string;
  }

  const rows: Row[] = [];
  const scores: number[] = [];
  let agree = 0;
  let disagree = 0;
  let noNomination = 0;

  process.stdout.write("lexicalSkill\tlexicalKeyword\trung2Skill\tscore\tverdict\n");

  for (const record of replayable) {
    const sets = buildExemplarSets(record.loadedSkills ?? [], skillRoot);
    if (sets.length === 0) continue;

    const result = await nominate(record.matchedTextExcerpt ?? "", sets, deps, { threshold });
    if (result.degraded) {
      process.stdout.write(`DEGRADED\t${result.degradedReason ?? "unknown"}\n`);
      continue;
    }

    let best: { family: string; score: number } | undefined;
    for (const n of result.nominations) {
      if (best === undefined || n.score > best.score) best = { family: n.family, score: n.score };
    }

    if (best === undefined) {
      noNomination += 1;
      rows.push({
        lexicalSkill: record.matchedSkill ?? null,
        lexicalKeyword: record.matchedKeyword ?? null,
        rung2Skill: null,
        score: null,
        verdict: "no-nomination",
      });
      process.stdout.write(
        `${record.matchedSkill ?? "-"}\t${record.matchedKeyword ?? "-"}\t(none)\t-\tno-nomination\n`
      );
      continue;
    }

    scores.push(best.score);
    const same = best.family === record.matchedSkill;
    if (same) agree += 1;
    else disagree += 1;
    rows.push({
      lexicalSkill: record.matchedSkill ?? null,
      lexicalKeyword: record.matchedKeyword ?? null,
      rung2Skill: best.family,
      score: best.score,
      verdict: same ? "agrees" : "disagrees",
    });
    process.stdout.write(
      `${record.matchedSkill ?? "-"}\t${record.matchedKeyword ?? "-"}\t${best.family}\t` +
        `${best.score.toFixed(4)}\t${same ? "agrees" : "DISAGREES"}\n`
    );
  }

  // Structured results, so the classification is data rather than something a
  // reader re-derives by eye from a table. `--classify` closes the loop: with a
  // label map the script computes the FP rate itself, at every threshold the
  // corpus actually produces, instead of leaving that arithmetic to prose in a
  // PR body where it cannot be re-run.
  if (out) {
    writeFileSync(out, `${JSON.stringify({ threshold, rows }, null, 2)}\n`, "utf8");
    process.stdout.write(`\nwrote ${rows.length} rows to ${out}\n`);
  }

  if (classify) {
    const labels = JSON.parse(readFileSync(classify, "utf8")) as Record<string, "TP" | "FP">;
    const labelled = rows
      .filter((r) => r.rung2Skill !== null)
      .map((r) => ({ ...r, label: labels[`${r.lexicalKeyword}->${r.lexicalSkill}`] }))
      .filter((r) => r.label !== undefined);

    process.stdout.write(`\nclassified: ${labelled.length} of ${rows.length} rows\n`);
    if (labelled.length === 0) {
      process.stdout.write(
        "No row matched a label key. Keys are `<lexicalKeyword>-><lexicalSkill>`.\n"
      );
    } else {
      // Sweep the thresholds the corpus itself produces — a threshold no record
      // sits near is not a candidate, so sweeping arbitrary round numbers would
      // report on cutoffs the data never exercises.
      const candidates = [...new Set(labelled.map((r) => r.score ?? 0))].sort((a, b) => a - b);
      process.stdout.write("\nthreshold\tadmitted\tTP\tFP\tFPrate\n");
      for (const t of candidates) {
        const admitted = labelled.filter((r) => (r.score ?? 0) >= t);
        const tp = admitted.filter((r) => r.label === "TP").length;
        const fp = admitted.filter((r) => r.label === "FP").length;
        const rate = admitted.length === 0 ? "-" : `${fp}/${admitted.length}`;
        process.stdout.write(`${t.toFixed(4)}\t${admitted.length}\t${tp}\t${fp}\t${rate}\n`);
      }
      const totalTp = labelled.filter((r) => r.label === "TP").length;
      process.stdout.write(
        `\nADR-024 sign-off (b) needs 0 known-FP with the true positives retained.\n` +
          `Any row above with FP=0 AND TP=${totalTp} is a passing threshold; if there is\n` +
          `none, no global cutoff separates the classes on this corpus.\n`
      );
    }
  }

  scores.sort((a, b) => a - b);
  const pct = (p: number): string => {
    if (scores.length === 0) return "-";
    const idx = Math.min(scores.length - 1, Math.floor((p / 100) * scores.length));
    return (scores[idx] ?? 0).toFixed(4);
  };

  process.stdout.write(
    `\nscored: ${scores.length}  agrees-with-lexical: ${agree}  disagrees: ${disagree}  ` +
      `no-nomination: ${noNomination}\n` +
      `score distribution — min ${pct(0)}  p25 ${pct(25)}  median ${pct(50)}  ` +
      `p75 ${pct(75)}  max ${pct(100)}\n\n` +
      `Read this as the INPUT to a threshold decision, not as the decision. A\n` +
      `disagreement is not automatically an improvement: each one needs\n` +
      `hand-classification against whether the research was actually about that\n` +
      `skill's domain. Record the classified counts in mt#3772's Outcome.\n`
  );
}

await main();
