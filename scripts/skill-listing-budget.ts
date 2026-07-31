#!/usr/bin/env bun
/**
 * Skill-listing budget report (mt#3476).
 *
 * The injected available-skills listing is built from `.claude/skills/<name>/SKILL.md`
 * frontmatter and is charged against a CUMULATIVE character budget: entries are emitted
 * in order until the budget is spent, and each subsequent entry lands only if it still
 * fits. An oversized entry is skipped while a smaller later entry can still fit — which
 * is why a skill's description can go missing without that skill being unusually long.
 *
 * Mechanism evidence (mt#3487): solving the constraint system across the 29 zero-usage
 * project skills — each rendered skill requires `budget >= running_total`, each dropped
 * skill requires `budget < running_total + its_length` — yields ONE feasible window,
 * [5708, 5853) chars, consistent with every observed render/no-render state. That is a
 * model fit against observed output, NOT a read of the harness's listing code (which is
 * not in this repo). Treat the window as an estimate; treat the ordering as an estimate.
 *
 * This script does not depend on the exact budget. It reports:
 *   - every skill's description length, and the listing total
 *   - which descriptions exceed the per-description cap
 *   - a cumulative-fill simulation, so the at-risk tail is visible before shipping
 *
 * Usage:
 *   bun scripts/skill-listing-budget.ts                # report
 *   bun scripts/skill-listing-budget.ts --json         # machine-readable
 *   bun scripts/skill-listing-budget.ts --budget 5800  # override the assumed budget
 *
 * Exit code is 0 for a report. Pass `--check` to exit non-zero when the per-description
 * cap or the listing total is exceeded.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Target per-description length. A description is a routing key, not documentation. */
export const DESCRIPTION_TARGET_CHARS = 250;
/** Hard cap per description. Exceeding this is a budget failure. */
export const DESCRIPTION_CAP_CHARS = 400;
/** Listing total we aim to stay under (mt#3476 criterion 3). */
export const LISTING_TOTAL_TARGET_CHARS = 18_000;
/**
 * Assumed harness listing budget, midpoint of the mt#3487 feasible window
 * [5708, 5853). Used ONLY to simulate which entries are at risk — never to
 * gate anything, since the true value is not ours to know.
 */
export const ASSUMED_HARNESS_BUDGET_CHARS = 5_780;

export interface SkillEntry {
  name: string;
  descriptionChars: number;
  /** True when `.minsky/skills/<name>/` exists — i.e. we own the source. */
  owned: boolean;
}

export interface FillResult extends SkillEntry {
  runningTotal: number;
  /** Whether this entry would fit under the simulated greedy fill. */
  fits: boolean;
}

/**
 * Extract the `description` value from a SKILL.md's YAML frontmatter.
 *
 * Deliberately a small hand-rolled reader rather than a YAML dependency: it only
 * needs the one scalar field, and it must tolerate both inline (`description: text`)
 * and folded (`description: >-`) forms, which is the whole variation present in this
 * corpus. Returns "" when there is no frontmatter or no description — callers treat
 * a zero length as "nothing charged to the listing", which is the truthful reading.
 */
export function extractDescription(raw: string): string {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return "";

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return "";

  const parts: string[] = [];
  let collecting = false;
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? "";
    const match = /^description:\s*(.*)$/.exec(line);
    if (match) {
      collecting = true;
      const inline = (match[1] ?? "").trim();
      // A folded/literal block scalar marker carries no text of its own.
      if (inline && inline !== ">-" && inline !== ">" && inline !== "|" && inline !== "|-") {
        parts.push(inline);
      }
      continue;
    }
    if (!collecting) continue;
    // A new top-level key ends the description block; indented lines continue it.
    if (/^[a-zA-Z_-]+:/.test(line)) break;
    const trimmed = line.trim();
    if (trimmed) parts.push(trimmed);
  }
  return parts.join(" ").trim();
}

export async function collectSkills(workspacePath: string): Promise<SkillEntry[]> {
  const skillsDir = join(workspacePath, ".claude", "skills");
  let dirents;
  try {
    dirents = await readdir(skillsDir, { withFileTypes: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read ${skillsDir}: ${reason}`);
  }

  const entries: SkillEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const name = dirent.name;
    let raw: string;
    try {
      raw = await readFile(join(skillsDir, name, "SKILL.md"), "utf-8");
    } catch {
      // No SKILL.md in this directory — not a skill; nothing is charged to the listing.
      continue;
    }
    let owned = true;
    try {
      await readdir(join(workspacePath, ".minsky", "skills", name));
    } catch {
      owned = false;
    }
    entries.push({ name, descriptionChars: extractDescription(raw).length, owned });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Simulate the greedy cumulative fill: walk entries in order, adding each one's cost
 * when it still fits in the remaining budget and skipping it (without consuming budget)
 * when it does not. Mirrors the mechanism inferred in mt#3487.
 *
 * ORDER-NAIVE, therefore WORST-CASE. Callers pass entries in alphabetical order, but the
 * real listing does not appear to spend its budget alphabetically: every skill observed
 * losing its description was a ZERO-usage skill, and no skill with recorded usage lost
 * one — so the harness looks to spend budget on used skills first and distribute the
 * remainder over the rest. Usage counts live in the user's `~/.claude.json`, outside this
 * repo and specific to one machine, so this script deliberately does not read them.
 *
 * Consequence: this simulation over-predicts drops (45 vs the 13 actually observed on
 * 2026-07-31). Use it to see WHICH ENTRIES SIT IN THE EXPENSIVE TAIL and how a trim moves
 * them — not as a prediction of what the next session will render. The deterministic,
 * portable signals in this script are the per-description cap and the listing total.
 */
export function simulateFill(entries: SkillEntry[], budget: number): FillResult[] {
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
  const total = entries.reduce((sum, e) => sum + e.descriptionChars, 0);
  const overCap = entries.filter((e) => e.descriptionChars > DESCRIPTION_CAP_CHARS);
  const filled = simulateFill(entries, budget);
  const atRisk = filled.filter((f) => !f.fits);

  if (json) {
    console.log(
      JSON.stringify(
        { total, skillCount: entries.length, budget, overCap, atRisk, entries: filled },
        null,
        2
      )
    );
  } else {
    console.log(`Skills: ${entries.length}`);
    console.log(`Listing total: ${total} chars (target <= ${LISTING_TOTAL_TARGET_CHARS})`);
    console.log(`Over per-description cap (${DESCRIPTION_CAP_CHARS}): ${overCap.length}`);
    for (const e of overCap.sort((a, b) => b.descriptionChars - a.descriptionChars)) {
      console.log(
        `  ${String(e.descriptionChars).padStart(5)}  ${e.name}${e.owned ? "" : "  [vendored]"}`
      );
    }
    console.log(
      `\nOrder-naive worst-case fill at budget=${budget}: ${atRisk.length} description(s) in the expensive tail.` +
        `\n(Alphabetical order; the real listing appears to fund used skills first, so this over-predicts. See simulateFill docs.)`
    );
    for (const e of atRisk) {
      console.log(`  ${String(e.descriptionChars).padStart(5)}  ${e.name}`);
    }
  }

  if (check) {
    // Vendored skills are upstream-canonical (ADR-015): their description is set upstream
    // and a local edit is silently reverted on the next refetch. Failing on them would make
    // this check unshippable through no fault of any commit, so the cap applies to OWNED
    // descriptions only. Vendored ones still count toward the listing TOTAL — the listing
    // pays for them either way — and are reported so the cost stays visible.
    const ownedOverCap = overCap.filter((e) => e.owned);
    const vendoredOverCap = overCap.filter((e) => !e.owned);
    const failed = ownedOverCap.length > 0 || total > LISTING_TOTAL_TARGET_CHARS;
    if (vendoredOverCap.length > 0) {
      console.log(
        `\nNOTE: ${vendoredOverCap.length} vendored description(s) over the cap ` +
          `(${vendoredOverCap.map((e) => e.name).join(", ")}). Upstream-owned — not enforced here, ` +
          `but counted in the listing total.`
      );
    }
    if (failed) {
      console.error(
        `\nFAIL: ${ownedOverCap.length} owned description(s) over the ${DESCRIPTION_CAP_CHARS}-char cap; ` +
          `listing total ${total} vs target ${LISTING_TOTAL_TARGET_CHARS}`
      );
      process.exit(1);
    }
    console.log("\nOK: every owned description within cap and listing total within target");
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  });
}
