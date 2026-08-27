#!/usr/bin/env bun
/**
 * Measure the coverage-claim path detector against the live corpus (mt#4426).
 *
 * This is the SC1 / AT1 instrument: it runs the SHIPPING matcher — not a
 * reimplementation — over every source file in the repo and prints the fire
 * set, so the false-positive rate is a measurement rather than an argument.
 *
 * Why a script and not a test: the corpus changes under us, so pinning a number
 * in an assertion would make an unrelated comment edit fail the suite. The test
 * file pins the DISCRIMINATIONS (each measured FP class, each measured true
 * positive); this reports the aggregate against whatever the tree currently
 * holds. mem#1067's rule applies to reading its output — re-run it after ANY
 * matcher change, because an over-narrow conjunct's failure direction is a
 * better-looking number.
 *
 * Usage:
 *   bun scripts/measure-coverage-claim-paths.ts            # summary + findings
 *   bun scripts/measure-coverage-claim-paths.ts --naive    # also show the naive
 *                                                          # matcher's fire set,
 *                                                          # for the comparison
 *                                                          # SC1 asks for
 *
 * Exit code is 0 on a completed measurement regardless of what it finds — this
 * reports, it does not gate. The detector ships log-only (ADR-024 ladder).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { findUnresolvedCoverageClaims } from "../.minsky/hooks/coverage-claim-path";

/** Trees an agent actually edits — the population a write-time detector meets. */
const ROOTS = ["src", "packages", "scripts", "services", "tests", ".minsky"];

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "__fixtures__"]);

const repoRoot = process.cwd();

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // unreadable tree — nothing to measure here, not an error
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      yield full;
    }
  }
}

const exists = (repoRelativePath: string): boolean => existsSync(join(repoRoot, repoRelativePath));

interface Row {
  file: string;
  line: number;
  citedPath: string;
  claimPhrase: string;
  context: string;
}

const rows: Row[] = [];
let filesScanned = 0;

for (const root of ROOTS) {
  const abs = join(repoRoot, root);
  if (!existsSync(abs)) continue;
  for (const file of walk(abs)) {
    const rel = relative(repoRoot, file);
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    filesScanned++;
    for (const finding of findUnresolvedCoverageClaims(source, rel, exists)) {
      rows.push({ file: rel, ...finding });
    }
  }
}

console.log(`Scanned ${filesScanned} TypeScript files across ${ROOTS.join(", ")}.`);
console.log(`Detector fired ${rows.length} time(s).\n`);

for (const row of rows) {
  console.log(`${row.file}:${row.line}`);
  console.log(`  cited:  ${row.citedPath}`);
  console.log(`  phrase: ${row.claimPhrase}`);
  console.log(`  context: ${row.context}`);
  console.log("");
}

if (process.argv.includes("--naive")) {
  // The comparison SC1 asks for: what the "decidable by grep" matcher — the
  // premise mt#4413's planning audit asserted and this task's Evidence section
  // falsified — would have reported over the same corpus.
  const naive = new Set<string>();
  for (const root of ROOTS) {
    const abs = join(repoRoot, root);
    if (!existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(/scripts\/[A-Za-z0-9._/-]+\.ts/g)) {
        if (!existsSync(join(repoRoot, m[0]))) naive.add(m[0]);
      }
    }
  }
  console.log(`Naive matcher (path mention + repo-root existence): ${naive.size} distinct misses.`);
  console.log(`Shipping matcher: ${rows.length} fire(s).`);
}
