/**
 * Scaffold a project's `.minsky/rules/` from the shipped product corpus
 * (mt#4974 SC3/SC5/SC7) — the replacement for `./rule-templates.ts`.
 *
 * ## What changes for a scaffolded project
 *
 * The template system wrote six TypeScript-generated files that Claude Code
 * could not reach and that carried three wrong instructions. This writes the
 * `base` tier of `../rules/corpus` — rules that are reachable by construction,
 * because a rule earns `base` only if it is emitted always-apply.
 *
 * Only `base` is written. `opinionated` rules ship in the corpus and are
 * deliberately withheld until Phase 2 (mt#573) gives a user a way to decline
 * them; writing them now would put rules into a project nobody was asked about.
 *
 * ## Overwrite is content-aware (SC7)
 *
 * `--overwrite` used to mean "replace unconditionally", which for a rule file is
 * the same as "discard whatever the user wrote there". A project scaffolded
 * before this change has the OLD template output on disk, and the whole point of
 * a migration is to replace exactly that and nothing else. So an overwrite
 * replaces a file whose content matches a shipped-version hash — ours to
 * replace, unmodified since we wrote it — and REPORTS a file that does not,
 * leaving it alone. A rule the user edited is theirs.
 */

import { createHash } from "crypto";
import path from "path";

import type { FsLike } from "../interfaces/fs-like";
import { loadRuleCorpus, selectScaffoldableRules, type CorpusRule } from "../rules/corpus";
import { HISTORICAL_SCAFFOLD_HASHES } from "./scaffold-history";

/** SHA-256 of a scaffolded rule file's bytes, as recorded in the hash table. */
export function hashRuleContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** What one rule's scaffold attempt did. */
export type ScaffoldOutcome =
  | { id: string; action: "written" }
  | { id: string; action: "refreshed" }
  | { id: string; action: "kept-existing" }
  | { id: string; action: "diverged"; reason: string };

export interface ScaffoldResult {
  readonly outcomes: ScaffoldOutcome[];
  /** Ids left alone because their on-disk content is not a version we shipped. */
  readonly diverged: string[];
  /** Ids present in the corpus but withheld from this project (non-base tiers). */
  readonly withheld: string[];
  /** What the retired template system left behind, and what became of it. */
  readonly retired: {
    /** Retired-scaffold files found on disk. */
    readonly present: string[];
    /** Removed: content matched a version we shipped, and `--overwrite` was set. */
    readonly removed: string[];
    /** Left alone: content is not ours, so the user has edited it. */
    readonly keptEdited: string[];
  };
}

/**
 * The filesystem surface this needs — injected so tests need no real disk.
 *
 * A `Pick` of the project-wide `FsLike` rather than a fresh interface, so an
 * existing in-memory double satisfies it without adaptation and `init` can pass
 * the same `fileSystem` it already threads everywhere else.
 */
export type ScaffoldFsDeps = Pick<FsLike, "readFile" | "writeFile" | "exists" | "unlink">;

/**
 * Write the base corpus into `rulesDirPath`.
 *
 * @param overwrite When false, an existing file is never touched. When true, a
 *   file is replaced only if its content hashes to a version we shipped — see
 *   the docblock. Neither mode ever silently discards user edits.
 */
export async function scaffoldRulesFromCorpus(
  rulesDirPath: string,
  overwrite: boolean,
  fs: ScaffoldFsDeps,
  corpusDir?: string,
  /**
   * The shipped-content hash table. Injected so a test can exercise the
   * recognized-vs-edited DECISION with content it controls, rather than
   * mutating the real table — which cannot be done safely, since restoring a
   * key that was never there means deleting it, and getting that wrong leaks
   * into whatever test runs next.
   */
  knownHashes: Readonly<Record<string, readonly string[]>> = HISTORICAL_SCAFFOLD_HASHES
): Promise<ScaffoldResult> {
  const corpus = await loadRuleCorpus(corpusDir);
  const scaffoldable = selectScaffoldableRules(corpus);
  const withheld = corpus
    .filter((r) => !scaffoldable.includes(r))
    .map((r) => r.id)
    .sort();

  const outcomes: ScaffoldOutcome[] = [];
  const diverged: string[] = [];

  for (const rule of scaffoldable) {
    const target = path.join(rulesDirPath, `${rule.id}.mdc`);

    if (!(await fs.exists(target))) {
      await fs.writeFile(target, rule.raw);
      outcomes.push({ id: rule.id, action: "written" });
      continue;
    }

    if (!overwrite) {
      outcomes.push({ id: rule.id, action: "kept-existing" });
      continue;
    }

    const existing = await fs.readFile(target, "utf-8");
    if (existing === rule.raw) {
      // Already current. Not a no-op worth reporting as a refresh.
      outcomes.push({ id: rule.id, action: "kept-existing" });
      continue;
    }

    const existingHash = hashRuleContent(existing);
    const known = isKnownShippedContent(rule.id, existingHash, knownHashes);
    if (known) {
      await fs.writeFile(target, rule.raw);
      outcomes.push({ id: rule.id, action: "refreshed" });
      continue;
    }

    diverged.push(rule.id);
    outcomes.push({
      id: rule.id,
      action: "diverged",
      reason:
        `on-disk content does not match any version Minsky shipped ` +
        `(sha256 ${existingHash.slice(0, 12)}…), so it has local edits and was left alone`,
    });
  }

  const retired = await sweepRetiredScaffolds(rulesDirPath, overwrite, fs, knownHashes);

  return { outcomes, diverged: diverged.sort(), withheld, retired };
}

/**
 * Did we ship this exact content for THIS rule id, at some point?
 *
 * Strictly id-keyed (PR #3629 R1). It previously also matched the union of every
 * id's hashes, on the reasoning that pre-migration files carry retired ids and an
 * id-keyed lookup would refuse to migrate them. That reasoning was wrong twice
 * over, so the union is gone:
 *
 *   - **It could not do the job.** This function is only reached for a path named
 *     `<corpusId>.mdc`, and no retired id is a corpus id — a pre-migration project
 *     has `minsky-workflow.mdc`, never `key-workflows.mdc`. The union therefore
 *     fired only if a user had RENAMED a file onto a corpus id, which is not the
 *     migration case it was written for. Retired scaffolds are now handled where
 *     they actually live, by `sweepRetiredScaffolds` below.
 *   - **It was unsound.** Any file whose bytes matched any historical scaffold was
 *     replaced, even under a different rule's name — content equality across ids
 *     is not evidence that THIS rule is ours to overwrite.
 */
function isKnownShippedContent(
  id: string,
  hash: string,
  table: Readonly<Record<string, readonly string[]>>
): boolean {
  return table[id]?.includes(hash) ?? false;
}

/**
 * Account for the files the RETIRED template system left in a project.
 *
 * Without this, "migrates safely" was only half true: the four base rules were
 * written and the six old scaffolds were left sitting beside them — inert
 * (they reach neither Claude Code channel) but still on disk, still telling
 * anyone who opens them to run `git approve` and to set DONE by hand.
 *
 * Removal happens only under `--overwrite`, and only for a file whose content is
 * one WE wrote. Anything else is reported and left alone: a file the user edited
 * is theirs, and a destructive default is the failure this whole task is about.
 */
async function sweepRetiredScaffolds(
  rulesDirPath: string,
  overwrite: boolean,
  fs: ScaffoldFsDeps,
  knownHashes: Readonly<Record<string, readonly string[]>>
): Promise<{ removed: string[]; keptEdited: string[]; present: string[] }> {
  const removed: string[] = [];
  const keptEdited: string[] = [];
  const present: string[] = [];

  for (const id of Object.keys(knownHashes)) {
    const target = path.join(rulesDirPath, `${id}.mdc`);
    if (!(await fs.exists(target))) continue;
    present.push(id);

    if (!overwrite) continue;

    const existing = await fs.readFile(target, "utf-8");
    if (isKnownShippedContent(id, hashRuleContent(existing), knownHashes)) {
      await fs.unlink(target);
      removed.push(id);
    } else {
      keptEdited.push(id);
    }
  }

  return { removed: removed.sort(), keptEdited: keptEdited.sort(), present: present.sort() };
}

/**
 * Render a scaffold result as the lines `init` prints, split by channel.
 *
 * The split is load-bearing, not cosmetic. `init`'s warning channel is what
 * mt#4770 uses to say something is WRONG — a rule nothing can reach, a target
 * that failed to compile — and `init-backend-selection.test.ts` asserts that
 * channel is silent on a healthy run. Reporting "wrote 4 rules" through it
 * would make a successful scaffold indistinguishable from a problem, which is
 * the same conflation this task is removing elsewhere.
 *
 * So: routine outcomes are `info`. Only a rule left alone because it diverged
 * from what we shipped is a `warning` — that one needs the operator to decide
 * whether they wanted the update.
 */
export function describeScaffoldResult(result: ScaffoldResult): {
  info: string[];
  warnings: string[];
} {
  const info: string[] = [];
  const warnings: string[] = [];
  const written = result.outcomes.filter((o) => o.action === "written").length;
  const refreshed = result.outcomes.filter((o) => o.action === "refreshed").length;

  if (written > 0) info.push(`minsky init: wrote ${written} base rule(s) to .minsky/rules.`);
  if (refreshed > 0) {
    info.push(`minsky init: refreshed ${refreshed} rule(s) that still had shipped content.`);
  }
  if (result.withheld.length > 0) {
    info.push(
      `minsky init: ${result.withheld.length} declinable rule(s) ship with Minsky but were ` +
        `NOT installed — ${result.withheld.join(", ")}. They are opt-in; nothing writes them ` +
        `into your project until you choose them.`
    );
  }
  for (const outcome of result.outcomes) {
    if (outcome.action === "diverged") {
      warnings.push(`minsky init: kept your edited "${outcome.id}" — ${outcome.reason}.`);
    }
  }

  const { present, removed, keptEdited } = result.retired;
  if (removed.length > 0) {
    info.push(
      `minsky init: removed ${removed.length} rule(s) left by the retired template system — ` +
        `${removed.join(", ")}. They were unreachable by your agent and three of them carried ` +
        `instructions that no longer work.`
    );
  }
  if (keptEdited.length > 0) {
    warnings.push(
      `minsky init: ${keptEdited.length} rule(s) from the retired template system are still in ` +
        `.minsky/rules and you have edited them — ${keptEdited.join(", ")}. Left alone. They are ` +
        `superseded and unreachable by your agent; delete them once you have moved anything you want.`
    );
  }
  const untouched = present.filter((id) => !removed.includes(id) && !keptEdited.includes(id));
  if (untouched.length > 0) {
    warnings.push(
      `minsky init: ${untouched.length} superseded rule(s) from the retired template system are ` +
        `still present — ${untouched.join(", ")}. Re-run with --overwrite to remove the ones ` +
        `Minsky wrote.`
    );
  }

  return { info, warnings };
}

export type { CorpusRule };
