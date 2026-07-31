/**
 * Skill-listing description budget (mt#3476).
 *
 * The harness's injected available-skills listing is built from the `description`
 * frontmatter of `.claude/skills/<name>/SKILL.md` and is charged against a shared
 * CUMULATIVE character budget: entries are emitted until the budget is spent, and each
 * subsequent entry lands only if it still fits. An oversized entry is skipped while a
 * smaller later entry can still fit — so an over-long description costs OTHER skills
 * their descriptions, not only its own. A skill listed name-only cannot be routed to.
 *
 * Mechanism evidence (mt#3487): solving the constraint system across the 29 zero-usage
 * project skills yields one feasible budget window, [5708, 5853) chars, consistent with
 * every observed render/no-render state. That is a model fit against observed output,
 * NOT a read of the harness's listing code (which is not in this repo).
 *
 * **Why this measures the OUTPUT directory, not the compiled definition set.** The
 * `claude-skills` target discovers work from `.minsky/skills/` and compiles only the
 * skills that have a source there — 43 of 57 at time of writing. The other 14 are
 * vendored or hand-authored and the target never sees them. The listing budget is
 * consumed by ALL of them, so a budget computed from `definitionsIncluded` would
 * structurally under-count the total it exists to police. This module therefore reads
 * the emitted output directory: what the harness actually lists.
 *
 * Sibling of `size-budget.ts` (mt#2802), whose shape this follows — report the size,
 * fail over threshold, name the offenders. It is deliberately NOT a reuse of that
 * module's call site: `size-budget.ts` documents itself as being for monolithic
 * single-file targets, and `claude-skills` is a multi-file target whose per-file sizes
 * are irrelevant here (only the description field is charged).
 */

import matter from "gray-matter";

/** Target per-description length. A description is a routing key, not documentation. */
export const DESCRIPTION_TARGET_CHARS = 250;
/** Hard cap per OWNED description. */
export const DESCRIPTION_CAP_CHARS = 400;
/** Listing total the corpus aims to stay under (mt#3476 criterion 3). */
export const LISTING_TOTAL_TARGET_CHARS = 18_000;

export interface SkillListingEntry {
  name: string;
  descriptionChars: number;
  /** True when a `.minsky/skills/<name>/` source exists — i.e. this repo owns the text. */
  owned: boolean;
}

export interface SkillListingBudgetEvaluation {
  entries: SkillListingEntry[];
  totalChars: number;
  /** OWNED descriptions over the cap. These are actionable and gate `--check`. */
  ownedOverCap: SkillListingEntry[];
  /**
   * Vendored descriptions over the cap. Reported, never gated: a vendored skill's
   * description is set upstream and a local edit is reverted on the next refetch
   * (ADR-015), so failing on one would make the check unshippable through no fault of
   * any commit. They still consume the shared budget, so they stay in `totalChars`.
   */
  vendoredOverCap: SkillListingEntry[];
  status: "ok" | "fail";
}

/**
 * Read a skill's charged description length from its emitted `SKILL.md`.
 *
 * Uses `gray-matter` — the same parser the compile targets use — rather than a
 * hand-rolled reader. A hand-rolled one misparses quoted scalars, embedded colons, and
 * leading blank lines, and would silently under- or over-count the very budget this
 * module exists to measure.
 *
 * A file with no frontmatter, unparseable frontmatter, or a non-string `description`
 * charges 0: nothing reaches the listing, which is the truthful reading. Parse failures
 * are surfaced to the caller rather than swallowed.
 */
export function descriptionCharsFromSkillMd(raw: string): { chars: number } | { error: string } {
  let data: Record<string, unknown>;
  try {
    data = matter(raw).data as Record<string, unknown>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { error: `Failed to parse frontmatter: ${reason}` };
  }
  const description = data["description"];
  if (typeof description !== "string") return { chars: 0 };
  return { chars: description.trim().length };
}

/** Classify a collected entry set against the cap and total. */
export function evaluateSkillListingBudget(
  entries: SkillListingEntry[],
  totalTarget: number = LISTING_TOTAL_TARGET_CHARS,
  cap: number = DESCRIPTION_CAP_CHARS
): SkillListingBudgetEvaluation {
  const totalChars = entries.reduce((sum, e) => sum + e.descriptionChars, 0);
  const overCap = entries.filter((e) => e.descriptionChars > cap);
  const ownedOverCap = overCap
    .filter((e) => e.owned)
    .sort((a, b) => b.descriptionChars - a.descriptionChars);
  const vendoredOverCap = overCap
    .filter((e) => !e.owned)
    .sort((a, b) => b.descriptionChars - a.descriptionChars);
  return {
    entries,
    totalChars,
    ownedOverCap,
    vendoredOverCap,
    status: ownedOverCap.length > 0 || totalChars > totalTarget ? "fail" : "ok",
  };
}

/** Human-readable summary lines for a compile report or a CLI run. */
export function formatSkillListingBudget(
  evaluation: SkillListingBudgetEvaluation,
  totalTarget: number = LISTING_TOTAL_TARGET_CHARS,
  cap: number = DESCRIPTION_CAP_CHARS
): string[] {
  const lines = [
    `skill listing: ${evaluation.totalChars} chars across ${evaluation.entries.length} skills (target <= ${totalTarget})`,
  ];
  for (const e of evaluation.ownedOverCap) {
    lines.push(`  OVER CAP (${cap}): ${e.name} — ${e.descriptionChars} chars`);
  }
  if (evaluation.vendoredOverCap.length > 0) {
    lines.push(
      `  vendored over cap (upstream-owned, not enforced): ${evaluation.vendoredOverCap
        .map((e) => `${e.name} (${e.descriptionChars})`)
        .join(", ")}`
    );
  }
  return lines;
}
