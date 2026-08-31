#!/usr/bin/env bun
/**
 * Measure whether the citation-scope axis is mechanically detectable — mt#4830 SC1 / AT3.
 *
 * ## What question this answers
 *
 * mt#4830 asks whether "a TRUE code citation licensing a FALSE conclusion" can be caught by a
 * mechanism, and explicitly admits **"not mechanically detectable at the useful precision" as a
 * legitimate and complete outcome, provided it is measured.** This script produces the
 * measurement. It is not a hook and is not wired into anything.
 *
 * ## Why merged PR bodies
 *
 * The worked instance is a PR body, the failure ships through review in PR bodies, and merged
 * bodies are a real corpus rather than a synthetic one. AT3 sets the floor at 50.
 *
 * ## Reading the output
 *
 * Three nested layers (see `scripts/lib/citation-scope-matcher.ts`), so the result is a PRECISION
 * CURVE rather than one threshold's verdict:
 *
 *   L1 — a citation and a licensing connective share a claim window (recall ceiling; over-broad
 *        by design, never a candidate mechanism)
 *   L2 — plus a scope assertion whose subject is not one of the cited symbols
 *   L3 — plus an unquantified citation under a totality conclusion
 *
 * **The hit counts are NOT a false-positive rate.** The matcher flags a STRUCTURE; whether the
 * flagged conclusion is actually false is a judgment no regex makes. So this script prints every
 * flagged excerpt for labeling, and the FP rate is computed from labels a reader assigns — the
 * number AT3 wants is a labeled rate, and a script cannot hand it to you unlabeled. The bar it is
 * measured against is **10%**, taken from ADR-034's written bar for the sibling detector on this
 * surface (mt#4830's `## Governing decision records`).
 *
 * ## Egress
 *
 * stdout ONLY. The single subprocess is `gh pr list`, which receives flags and a repo slug — no
 * claim text, no excerpt, and no prose leaves this process by any other channel. No network call
 * is made directly and no third-party SDK is involved. Excerpts printed to stdout come from
 * already-public merged PR bodies on the repo the caller is already authenticated to.
 *
 * ## Usage
 *
 *   bun scripts/measure-citation-scope-detectability.ts
 *   bun scripts/measure-citation-scope-detectability.ts --limit 80
 *   bun scripts/measure-citation-scope-detectability.ts --layer L3 --show 40
 *   bun scripts/measure-citation-scope-detectability.ts --json
 *
 * Exit 0 = measured. Exit 1 = the corpus could not be fetched or an argument is malformed.
 * Exit 2 = the corpus came back empty although the fetch succeeded, which means the filter is
 * probably wrong rather than the repo being quiet.
 */

import { safeTruncate } from "../src/utils/safe-truncate";
import {
  findCitationScopeMatches,
  tallyByLayer,
  type CitationScopeMatch,
  type MatchLayer,
} from "./lib/citation-scope-matcher";

/** AT3's floor. Raising `--limit` is fine; going below this stops the run. */
const AT3_MINIMUM_CORPUS = 50;

/** ADR-034's written bar for the sibling detector on this surface. */
const PRECISION_BAR_PERCENT = 10;

interface PullRequestBody {
  number: number;
  title: string;
  body: string;
}

interface Args {
  limit: number;
  layer: MatchLayer;
  show: number;
  json: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { limit: 60, layer: "L2", show: 25, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--limit": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < AT3_MINIMUM_CORPUS) {
          fail(`--limit must be an integer >= ${AT3_MINIMUM_CORPUS} (AT3's floor); got ${value}`);
        }
        args.limit = n;
        i += 1;
        break;
      }
      case "--layer": {
        if (value !== "L1" && value !== "L2" && value !== "L3") {
          fail(`--layer must be L1, L2 or L3; got ${value}`);
        }
        args.layer = value;
        i += 1;
        break;
      }
      case "--show": {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0)
          fail(`--show must be a non-negative integer; got ${value}`);
        args.show = n;
        i += 1;
        break;
      }
      case "--json":
        args.json = true;
        break;
      default:
        fail(`unrecognized argument: ${flag}`);
    }
  }
  return args;
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

/**
 * Fetch merged PR bodies. `gh` is used rather than an HTTP client so the caller's existing
 * authentication applies and no credential is read, held, or passed by this process.
 */
function fetchMergedPullRequests(limit: number): PullRequestBody[] {
  const result = Bun.spawnSync(
    [
      "gh",
      "pr",
      "list",
      "--state",
      "merged",
      "--limit",
      String(limit),
      "--json",
      "number,title,body",
    ],
    { stdout: "pipe", stderr: "pipe" }
  );

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    fail(`gh exited ${result.exitCode}: ${stderr.length > 0 ? stderr : "no stderr"}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.toString());
  } catch (cause) {
    fail(`gh returned unparseable JSON: ${(cause as Error).message}`);
  }
  if (!Array.isArray(parsed)) fail("gh returned JSON that is not an array");

  return (parsed as PullRequestBody[]).filter((pr) => typeof pr.body === "string");
}

interface FlaggedMatch extends CitationScopeMatch {
  prNumber: number;
  prTitle: string;
}

function atOrDeeper(match: CitationScopeMatch, layer: MatchLayer): boolean {
  const order: Record<MatchLayer, number> = { L1: 1, L2: 2, L3: 3 };
  return order[match.layer] >= order[layer];
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const pullRequests = fetchMergedPullRequests(args.limit);

  if (pullRequests.length === 0) {
    process.stderr.write("error: gh succeeded but returned no merged PRs — check the filter\n");
    process.exit(2);
  }
  if (pullRequests.length < AT3_MINIMUM_CORPUS) {
    process.stderr.write(
      `error: corpus is ${pullRequests.length} PRs, below AT3's floor of ${AT3_MINIMUM_CORPUS}\n`
    );
    process.exit(1);
  }

  const flagged: FlaggedMatch[] = [];
  const totals: Record<MatchLayer, number> = { L1: 0, L2: 0, L3: 0 };
  const prsWithHit: Record<MatchLayer, Set<number>> = {
    L1: new Set(),
    L2: new Set(),
    L3: new Set(),
  };

  for (const pr of pullRequests) {
    const matches = findCitationScopeMatches(pr.body);
    const tally = tallyByLayer(matches);
    for (const layer of ["L1", "L2", "L3"] as const) {
      totals[layer] += tally[layer];
      if (tally[layer] > 0) prsWithHit[layer].add(pr.number);
    }
    for (const m of matches) {
      if (atOrDeeper(m, args.layer)) flagged.push({ ...m, prNumber: pr.number, prTitle: pr.title });
    }
  }

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          corpusSize: pullRequests.length,
          precisionBarPercent: PRECISION_BAR_PERCENT,
          matchesByLayer: totals,
          prsWithHitByLayer: {
            L1: prsWithHit.L1.size,
            L2: prsWithHit.L2.size,
            L3: prsWithHit.L3.size,
          },
          flagged: flagged.slice(0, args.show),
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const pct = (n: number): string => `${((n / pullRequests.length) * 100).toFixed(1)}%`;

  process.stdout.write(`Corpus: ${pullRequests.length} merged PR bodies\n\n`);
  process.stdout.write("Layer  matches  PRs with >=1 hit  share of corpus\n");
  for (const layer of ["L1", "L2", "L3"] as const) {
    process.stdout.write(
      `${layer}     ${String(totals[layer]).padStart(7)}  ${String(prsWithHit[layer].size).padStart(16)}  ${pct(prsWithHit[layer].size).padStart(14)}\n`
    );
  }

  process.stdout.write(
    `\nFlagged at ${args.layer} or deeper: ${flagged.length}. Showing ${Math.min(args.show, flagged.length)} for labeling.\n`
  );
  process.stdout.write(
    `A hit is a STRUCTURE, not a defect — label each below, then compute the rate against the ${PRECISION_BAR_PERCENT}% bar.\n\n`
  );

  for (const m of flagged.slice(0, args.show)) {
    process.stdout.write(`--- PR #${m.prNumber} [${m.layer}] ${m.prTitle}\n`);
    process.stdout.write(`    symbols:  ${m.citedSymbols.join(", ")}\n`);
    process.stdout.write(`    joined by: ${m.connectives.join(", ")}\n`);
    const drifting = m.scopeAssertions.filter((a) => a.subjectDrifts);
    if (drifting.length > 0) {
      process.stdout.write(
        `    scope:    ${drifting.map((a) => `"${a.marker}" on "${a.subject}"`).join("; ")}\n`
      );
    }
    // safeTruncate, not `.slice` — a PR body can carry an emoji or a box-drawing glyph, and
    // splitting a UTF-16 surrogate pair would corrupt the excerpt a reader is about to LABEL.
    process.stdout.write(
      `    excerpt:  ${safeTruncate(m.excerpt.replace(/\s+/g, " "), 240, "head")}\n\n`
    );
  }
}

main();
