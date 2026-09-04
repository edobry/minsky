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
import type { MinskyCompileFsDeps } from "./types";
import { GENERATION_BANNER_PATTERNS } from "../rules/compile/banner-constants";

/**
 * How many leading lines are scanned for the banner.
 *
 * Matches `.minsky/hooks/check-generated-file-edit.ts`, deliberately: that hook
 * decides whether a file may be hand-edited, and this predicate decides whether
 * it may be machine-written. A file the hook calls generated (so refuses to let
 * you edit) and this predicate calls foreign (so refuses to let the pipeline
 * regenerate) would be editable by nobody.
 */
const BANNER_SCAN_LINES = 5;

/** What a monolithic output path holds right now. */
export type MonolithicOwnership =
  /** Nothing on disk — a fresh project. Write it. */
  | "absent"
  /** Carries the generation banner — Minsky's own output. Regenerate it. */
  | "generated"
  /** Present without a banner — the user authored it. Never write it. */
  | "foreign";

/** True when the file's first {@link BANNER_SCAN_LINES} lines carry a generation banner. */
export function hasGenerationBanner(content: string): boolean {
  const head = content.split("\n").slice(0, BANNER_SCAN_LINES).join("\n");
  return GENERATION_BANNER_PATTERNS.some(({ re }) => re.test(head));
}

/**
 * Classify what sits at `outputPath`.
 *
 * A read that fails for ANY reason resolves to `"absent"`, not `"foreign"`. The
 * overwhelmingly common cause is ENOENT on a fresh project, and the failure
 * modes are asymmetric: treating an unreadable file as foreign would silently
 * stop maintaining a `CLAUDE.md` that IS ours — an inert pipeline with no error
 * — whereas the write that follows `"absent"` fails loudly on a file that
 * genuinely cannot be written.
 */
export async function readMonolithicOwnership(
  outputPath: string,
  fsDeps?: MinskyCompileFsDeps
): Promise<MonolithicOwnership> {
  const fs = fsDeps ?? (realFs as MinskyCompileFsDeps);
  let content: string;
  try {
    content = await fs.readFile(outputPath, "utf-8");
  } catch {
    return "absent";
  }
  return hasGenerationBanner(content) ? "generated" : "foreign";
}

/** Convenience: `true` only for a present, non-banner-carrying file. */
export async function isForeignMonolith(
  outputPath: string,
  fsDeps?: MinskyCompileFsDeps
): Promise<boolean> {
  return (await readMonolithicOwnership(outputPath, fsDeps)) === "foreign";
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
export function foreignOutputSkipReason(outputPath: string): string {
  return (
    `${outputPath} was left untouched — it does not carry Minsky's generated-file banner, ` +
    `so it is treated as yours and is never overwritten. Minsky's rule sources are in ` +
    `.minsky/rules/; nothing loads them into your agent automatically while this file is ` +
    `yours, so an agent has to ask for one by name with \`rules_get <name>\`. To hand the ` +
    `file over to Minsky instead, move it aside and re-run.`
  );
}
