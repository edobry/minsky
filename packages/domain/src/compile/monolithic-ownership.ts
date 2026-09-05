/**
 * Ownership of the two monolithic outputs, `CLAUDE.md` and `AGENTS.md` (mt#4986).
 *
 * Minsky plays nice with foreign content in every PER-FILE channel it writes —
 * `.claude/rules/` keeps hand-authored files and removes only banner-carrying
 * orphans (`targets/claude-rules.ts`), `.claude/settings.json` preserves foreign
 * hook groups (`setup/hook-provisioning.ts`), `.minsky/config.yaml` merges every
 * key `init` does not own (mt#4866 SC2). The two monolithic markdown files were
 * the sole exception, and they were the exception by INHERITANCE rather than by
 * choice: in the Minsky repository `CLAUDE.md` genuinely IS wholly generated, so
 * the plant's posture shipped into the product without the user-owned case ever
 * being in frame. Measured 2026-09-04: a scratch repo carrying a hand-written
 * 140-byte `CLAUDE.md` ran `minsky init` and got back 15,085 bytes with zero
 * original lines surviving and no warning, while its own
 * `.claude/rules/acme-house-style.md` was left byte-identical.
 *
 * The marker is the generation banner, which is what every other ownership
 * decision in this codebase already keys on (mem#373). A file that carries it
 * is ours to regenerate; a file that does not is the user's and is never
 * written. Absence of the file is not foreignness — a fresh project has nothing
 * to protect and gets the full output.
 *
 * **Why a whole module for one predicate.** It has three consumers that must
 * agree exactly: the two writers (which refuse the write), `listOutputFiles`
 * (which must report no outputs so `--check` does not call a user's file
 * stale), and target selection in `compile.ts` (which drops the target
 * entirely). A disagreement between any two of them is either a destroyed user
 * file or a Minsky repo that can no longer refresh its own `CLAUDE.md`.
 */

import realFs from "fs/promises";
import { join } from "path";

import { GENERATION_BANNER_PATTERNS } from "../rules/compile/banner-constants";

/**
 * The only capability this module needs: read a file as text.
 *
 * Narrower than `MinskyCompileFsDeps` on purpose (PR #3646 CI). Both that type
 * and `FsLike` — the interface `init.ts` is handed — satisfy it structurally, so
 * every caller can inject the filesystem it already has rather than falling back
 * to the real one. An earlier revision took `MinskyCompileFsDeps`, which
 * `init.ts` does not have, so its call ran against the REAL disk while the rest
 * of `initializeProject` ran on an injected mock. That made four init tests
 * depend on whether `/tmp/test-repo/CLAUDE.md` happened to exist on the machine:
 * green locally where a stale one did, red in CI where it did not.
 */
export interface MonolithicOwnershipFs {
  readFile(path: string, encoding: "utf-8"): Promise<string>;
}

/**
 * How many leading lines are scanned for the banner.
 *
 * Matches `.minsky/hooks/check-generated-file-edit.ts`, deliberately: that hook
 * decides whether a file may be hand-edited, and this predicate decides whether
 * it may be machine-written. A file the hook calls generated (so refuses to let
 * you edit) and this predicate calls foreign (so refuses to let the pipeline
 * regenerate) would be editable by nobody.
 */
export const BANNER_SCAN_LINES = 5;

/**
 * The monolithic compile targets and the file each one owns.
 *
 * An explicit record rather than an inline conditional (PR #3643 R1): a
 * `target === "claude.md" ? "CLAUDE.md" : "AGENTS.md"` ternary silently
 * mis-maps any third monolithic target to `AGENTS.md`, and the failure is a
 * WRONG PATH in an operator-facing message rather than a type error. Adding a
 * target here forces the lookup to be updated deliberately.
 */
export const MONOLITHIC_TARGET_OUTPUTS = {
  "claude.md": "CLAUDE.md",
  "agents.md": "AGENTS.md",
} as const satisfies Record<string, string>;

export type MonolithicTargetId = keyof typeof MONOLITHIC_TARGET_OUTPUTS;

/** The output filename for a monolithic target id, or `undefined` if it is not one. */
export function monolithicOutputName(target: string): string | undefined {
  return (MONOLITHIC_TARGET_OUTPUTS as Record<string, string>)[target];
}

/** What a monolithic output path holds right now. */
export type MonolithicOwnership =
  /** Nothing on disk — a fresh project. Write it. */
  | "absent"
  /** Carries the generation banner — Minsky's own output. Regenerate it. */
  | "generated"
  /** Present without a banner — the user authored it. Never write it. */
  | "foreign"
  /**
   * Present but unreadable — a permissions error, or any read failure that is
   * not "no such file". Never write it either; see
   * {@link readMonolithicOwnership} for why this is NOT folded into `"absent"`.
   */
  | "unreadable";

/** True when the file's first {@link BANNER_SCAN_LINES} lines carry a generation banner. */
export function hasGenerationBanner(content: string): boolean {
  const head = content.split("\n").slice(0, BANNER_SCAN_LINES).join("\n");
  return GENERATION_BANNER_PATTERNS.some(({ re }) => re.test(head));
}

/**
 * Classify what sits at `outputPath`.
 *
 * **Only ENOENT is `"absent"`.** Every other read failure is `"unreadable"`,
 * and both `"unreadable"` and `"foreign"` mean "do not write". An earlier
 * revision folded all read errors into `"absent"`, reasoning that the
 * subsequent write would fail loudly on a file that cannot be written — and
 * that reasoning does not hold for the case that matters: a file can be
 * unreadable and still writable (mode `0200`), so a user's file would be
 * silently destroyed, which is the exact defect this module exists to prevent
 * (PR #3643 R1).
 *
 * The cost of the other direction is real but bounded and LOUD: a `CLAUDE.md`
 * that is genuinely ours but momentarily unreadable stops being regenerated,
 * and the operator is told which file and why rather than left with an inert
 * pipeline. Loud-and-stalled beats silent-and-destructive on a question about
 * overwriting someone's work.
 */
export async function readMonolithicOwnership(
  outputPath: string,
  fsDeps?: MonolithicOwnershipFs
): Promise<MonolithicOwnership> {
  const fs: MonolithicOwnershipFs = fsDeps ?? (realFs as MonolithicOwnershipFs);
  let content: string;
  try {
    content = await fs.readFile(outputPath, "utf-8");
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
      ? "absent"
      : "unreadable";
  }
  return hasGenerationBanner(content) ? "generated" : "foreign";
}

/**
 * `true` when the file must NOT be written — the user's own, or unverifiable.
 *
 * Named for the common case; the union is what callers actually need, since a
 * file we cannot classify is not a file we may overwrite.
 */
export async function isForeignMonolith(
  outputPath: string,
  fsDeps?: MonolithicOwnershipFs
): Promise<boolean> {
  const ownership = await readMonolithicOwnership(outputPath, fsDeps);
  return ownership === "foreign" || ownership === "unreadable";
}

/**
 * Whether this workspace has a `CLAUDE.md` that Minsky itself generated (mt#5003).
 *
 * The question behind it is "does the always-apply set already have a home?", and
 * it has exactly three answers, of which only one is yes:
 *
 * - **generated** — ours. `claude.md` carries the always-apply rules, as it always has.
 * - **absent** — a fresh project. We do NOT create one; the rules go to `.claude/rules/`
 *   as `paths`-less files, which Claude Code loads at launch at the same priority
 *   (ask#11711, decided 2026-09-05).
 * - **foreign / unreadable** — the user's. Same as absent for this purpose, and mt#4986
 *   already refuses to write it.
 *
 * This is the single predicate that keeps the two channels MUTUALLY EXCLUSIVE. Without
 * it, widening `isEligibleForClaudeRules` to admit always-apply rules would emit this
 * repository's own 138K always-apply corpus into `.claude/rules/` *as well as*
 * `CLAUDE.md`, roughly doubling its always-loaded context.
 */
export async function claudeMdIsOurs(
  workspacePath: string,
  fsDeps?: MonolithicOwnershipFs
): Promise<boolean> {
  const claudeMdPath = join(workspacePath, MONOLITHIC_TARGET_OUTPUTS["claude.md"]);
  return (await readMonolithicOwnership(claudeMdPath, fsDeps)) === "generated";
}

/**
 * The skip entry for a monolithic output we must not write, or `undefined` when
 * writing it is fine (it is ours, or it is not there yet).
 *
 * The one place that pairs the ownership READ with the reason it produces, so a
 * caller cannot report a cause the read did not establish. Every writer and the
 * selection-gate report go through it.
 */
export async function monolithicSkipIfNotOurs(
  outputPath: string,
  fsDeps?: MonolithicOwnershipFs
): Promise<{ path: string; reason: string } | undefined> {
  const ownership = await readMonolithicOwnership(outputPath, fsDeps);
  if (ownership === "generated" || ownership === "absent") return undefined;
  return { path: outputPath, reason: foreignOutputSkipReason(outputPath, ownership) };
}

/**
 * The operator-facing reason a monolithic target was skipped (mt#4986 SC2).
 *
 * Says which file was left alone, why, AND where the rules actually are — the
 * third clause is the one that is easy to drop and the one the operator needs.
 * Today the honest answer is "nowhere automatic": the base rules are
 * `alwaysApply: true`, and `.claude/rules/` only accepts rules that declare
 * globs AND `alwaysApply: false` (`targets/claude-rules.ts`), so a project whose
 * `CLAUDE.md` we do not own receives no always-apply rules at all until the
 * delivery-channel question (ask#11711, parent mt#4986) is answered. That is a
 * real interim gap and the message must not paper over it.
 */
export function foreignOutputSkipReason(
  outputPath: string,
  ownership: MonolithicOwnership = "foreign"
): string {
  // The two states have DIFFERENT causes and must not share a sentence: saying
  // an unreadable file "does not carry the banner" asserts something this run
  // could not check, which is the failure mode this whole task is about.
  const cause =
    ownership === "unreadable"
      ? `it could not be read, leaving Minsky unable to confirm it generated it`
      : `it does not carry Minsky's generated-file banner`;
  const remedy =
    ownership === "unreadable"
      ? `Fix its permissions and re-run; if it is yours, no action is needed.`
      : `To hand the file over to Minsky instead, move it aside and re-run.`;

  // Where the rules ACTUALLY went, which differs by file and became true only
  // with mt#5003. Before it, both files shared one sentence saying nothing loads
  // the rules automatically — accurate then, and false for CLAUDE.md the moment
  // `.claude/rules/` started carrying the always-apply set. A reassuring truth
  // and an alarming falsehood read identically to someone who does not check.
  const destination = outputPath.endsWith(MONOLITHIC_TARGET_OUTPUTS["claude.md"])
    ? `Minsky's rules still reach your agent: the always-apply ones are written to ` +
      `.claude/rules/ as paths-less files, which Claude Code loads at launch at the same ` +
      `priority this file would have had. Your instructions and Minsky's coexist.`
    : `Minsky's rule sources are in .minsky/rules/; this harness has no channel that loads ` +
      `them automatically while this file is yours, so an agent has to ask for one by name ` +
      `with \`rules_get <name>\`.`;

  return (
    `${outputPath} was left untouched — ${cause}, so it is treated as yours and is never ` +
    `overwritten. ${destination} ${remedy}`
  );
}
