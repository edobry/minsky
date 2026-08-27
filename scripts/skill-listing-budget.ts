#!/usr/bin/env bun
/**
 * Skill-listing description budget report (mt#3476).
 *
 * CLI front-end over `packages/domain/src/compile/skill-listing-budget.ts`, which the
 * `claude-skills` compile target also calls — the compile path is the enforcement point;
 * this script is the operator-facing report for working on descriptions without running a
 * full compile. Both read the EMITTED `.claude/skills/` directory and share one parser
 * and one set of thresholds, so they cannot disagree.
 *
 * Usage:
 *   bun run skills:budget                # report
 *   bun run skills:budget:check          # non-zero exit when over cap or over total
 *   bun scripts/skill-listing-budget.ts --json
 *   bun scripts/skill-listing-budget.ts --budget 5800   # override the assumed harness budget
 */

import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DESCRIPTION_CAP_CHARS,
  LISTING_TOTAL_TARGET_CHARS,
  SKILL_SOURCE_FILENAMES,
  descriptionCharsFromSkillMd,
  evaluateSkillListingBudget,
  type SkillListingEntry,
} from "../packages/domain/src/compile/skill-listing-budget";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

/**
 * Assumed harness listing budget — midpoint of the mt#3487 feasible window
 * [5708, 5853). Used ONLY by the fill simulation below, never to gate anything: the
 * true value belongs to the harness and is not ours to know.
 */
export const ASSUMED_HARNESS_BUDGET_CHARS = 5_780;

export interface FillResult extends SkillListingEntry {
  runningTotal: number;
  fits: boolean;
}

async function collectSkills(workspacePath: string): Promise<SkillListingEntry[]> {
  const skillsDir = join(workspacePath, ".claude", "skills");
  let dirents;
  try {
    dirents = await readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read ${skillsDir}: ${reason}`);
  }

  const entries: SkillListingEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const name = dirent.name;
    let raw: string;
    try {
      raw = await readFile(join(skillsDir, name, "SKILL.md"), "utf-8");
    } catch {
      continue; // not a skill dir — charges nothing to the listing
    }
    // Ownership is decided by the presence of a source FILE, matching the compile
    // target exactly — see SKILL_SOURCE_FILENAMES. Testing directory existence here
    // would let the two disagree about which skills the cap applies to.
    const sourceDir = join(workspacePath, ".minsky", "skills", name);
    const ownedChecks = await Promise.all(
      SKILL_SOURCE_FILENAMES.map(async (filename) => {
        try {
          await access(join(sourceDir, filename));
          return true;
        } catch {
          return false;
        }
      })
    );
    const owned = ownedChecks.some(Boolean);
    const result = descriptionCharsFromSkillMd(raw);
    if ("error" in result) {
      console.error(`WARN: ${name}: ${result.error}`);
      entries.push({ name, descriptionChars: 0, owned });
      continue;
    }
    entries.push({ name, descriptionChars: result.chars, owned });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Simulate the greedy cumulative fill: walk entries in order, adding each one's cost when
 * it still fits and skipping it (without consuming budget) when it does not.
 *
 * ORDER-NAIVE, therefore WORST-CASE. Entries arrive alphabetically, but the real listing
 * does not appear to spend its budget alphabetically: every skill observed losing its
 * description was a ZERO-usage skill and no skill with recorded usage lost one, so the
 * harness looks to fund used skills first. Usage counts live in the user's
 * `~/.claude.json` — outside this repo and specific to one machine — so this deliberately
 * does not read them.
 *
 * Consequence: this over-predicts drops (45 vs the 13 actually observed on 2026-07-31).
 * Use it to see which entries sit in the expensive tail, not to predict a given session.
 * The deterministic, portable signals are the per-description cap and the listing total.
 */
export function simulateFill(entries: SkillListingEntry[], budget: number): FillResult[] {
  let runningTotal = 0;
  return entries.map((entry) => {
    const next = runningTotal + entry.descriptionChars;
    const fits = next <= budget;
    if (fits) runningTotal = next;
    return { ...entry, runningTotal, fits };
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const check = args.includes("--check");
  const budgetFlag = args.indexOf("--budget");
  const budget =
    budgetFlag !== -1 && args[budgetFlag + 1] !== undefined
      ? Number(args[budgetFlag + 1])
      : ASSUMED_HARNESS_BUDGET_CHARS;
  if (!Number.isFinite(budget) || budget <= 0) {
    console.error(`Invalid --budget value: ${args[budgetFlag + 1]}`);
    process.exit(2);
  }

  const entries = await collectSkills(process.cwd());
  const evaluation = evaluateSkillListingBudget(entries);

  if (json) {
    // Stable schema: `entries`, `total`, `overCap`, and `status` are the contract and
    // reflect only on-disk facts. The simulation is namespaced under `simulation` and
    // carries its own `assumedBudget`, so a consumer can ignore everything that depends
    // on an estimated harness budget rather than having it interleaved with hard data.
    console.log(
      JSON.stringify(
        {
          total: evaluation.totalChars,
          skillCount: entries.length,
          cap: DESCRIPTION_CAP_CHARS,
          totalTarget: LISTING_TOTAL_TARGET_CHARS,
          status: evaluation.status,
          overCap: { owned: evaluation.ownedOverCap, vendored: evaluation.vendoredOverCap },
          entries,
          simulation: {
            assumedBudget: budget,
            orderNaive: true,
            fill: simulateFill(entries, budget),
          },
        },
        null,
        2
      )
    );
  } else {
    console.log(`Skills: ${entries.length}`);
    console.log(
      `Listing total: ${evaluation.totalChars} chars (target <= ${LISTING_TOTAL_TARGET_CHARS})`
    );
    const overCapCount = evaluation.ownedOverCap.length + evaluation.vendoredOverCap.length;
    console.log(`Over per-description cap (${DESCRIPTION_CAP_CHARS}): ${overCapCount}`);
    for (const e of [...evaluation.ownedOverCap, ...evaluation.vendoredOverCap].sort(
      (a, b) => b.descriptionChars - a.descriptionChars
    )) {
      console.log(
        `  ${String(e.descriptionChars).padStart(5)}  ${e.name}${e.owned ? "" : "  [vendored]"}`
      );
    }
    const atRisk = simulateFill(entries, budget).filter((f) => !f.fits);
    console.log(
      `\nOrder-naive worst-case fill at budget=${budget}: ${atRisk.length} description(s) in the expensive tail.` +
        `\n(Alphabetical order; the real listing appears to fund used skills first, so this over-predicts.)`
    );
  }

  if (check) {
    if (evaluation.vendoredOverCap.length > 0) {
      console.log(
        `\nNOTE: ${evaluation.vendoredOverCap.length} vendored description(s) over the cap ` +
          `(${evaluation.vendoredOverCap.map((e) => e.name).join(", ")}). Upstream-owned — not ` +
          `enforced here, but counted in the listing total.`
      );
    }
    if (evaluation.status === "fail") {
      console.error(
        `\nFAIL: ${evaluation.ownedOverCap.length} owned description(s) over the ` +
          `${DESCRIPTION_CAP_CHARS}-char cap; listing total ${evaluation.totalChars} vs target ` +
          `${LISTING_TOTAL_TARGET_CHARS}`
      );
      process.exit(1);
    }
    console.log("\nOK: every owned description within cap and listing total within target");
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(getLoggableErrorSummary(error));
    process.exit(2);
  });
}
