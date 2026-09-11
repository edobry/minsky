/**
 * Ownership guard for every PER-FILE compile output (mt#5065).
 *
 * mt#4986 stopped `compile` and `init` from destroying a user's own `CLAUDE.md`
 * / `AGENTS.md`, and its docblock recorded that "Minsky plays nice with foreign
 * content in every PER-FILE channel it writes". That was measured on a
 * NON-colliding filename: a hand-authored `.claude/rules/acme-house-style.md`
 * survived because nothing wanted to write that path. A file with the SAME name
 * as a generated output did not survive — every per-file writer ended in a bare
 * `fs.writeFile`, so a project whose `.cursor/rules/dont-ignore-errors.mdc` was
 * its own (or a scaffold copy it had edited) got it replaced, exit 0, with the
 * path listed under `filesWritten` exactly like a routine regeneration.
 * Reproduced 2026-09-10 against the live `cursor-rules-ts` target; the cold-agent
 * run that found it (mt#4705, target `edobry/chitin`) lost three tracked files.
 *
 * The accepted rules-plane RFC states the rule this enforces: a regeneration
 * "never lets a lower layer silently overwrite a higher one".
 *
 * ## One seam, not five edits
 *
 * All five per-file targets receive their filesystem from
 * `MinskyCompileService.compile` (`compile-service.ts`), so the guard wraps that
 * ONE `fs` rather than patching each writer: `writeFile` consults the same
 * banner predicate the monolithic gate uses (`readMonolithicOwnership`, keyed on
 * `GENERATION_BANNER_PATTERNS` — the marker every ownership decision in this
 * codebase keys on, mem#373) and refuses a path that exists without it. The
 * service then drops refused paths from `filesWritten` and reports them under
 * `skippedForeignOutputs`, the field mt#4986 already introduced for "a whole
 * output file was left alone". A writer that does not know the guard exists is
 * covered by it, which is what keeps the next target honest without a checklist.
 *
 * `--overwrite` (the `init` / `setup` precedent) is the explicit way through: a
 * FOREIGN file is then written and reported under `foreignOverwritten`, so the
 * destruction is recorded rather than silent. An UNREADABLE file is refused even
 * then — it cannot be classified, and a file we cannot classify is not a file we
 * may overwrite (the same reasoning as `readMonolithicOwnership`).
 *
 * What this does NOT decide: whether a banner-less file is an UNTOUCHED copy of
 * Minsky's historical scaffold. That carve-out belongs to the RFC's Phase 1
 * provenance manifest (mt#4871); until it lands every banner-less collision is
 * foreign here, which is the safe direction, and `--overwrite` is the manual path.
 */

import type { MinskyCompileFsDeps } from "./types";
import { BANNER_SCAN_LINES, hasGenerationBanner } from "./monolithic-ownership";
import { GENERATION_BANNER_PATTERNS } from "../rules/compile/banner-constants";

/**
 * The content with its generation-banner line removed, when that line sits in
 * the head the predicates scan. Used to recognise a file Minsky generated
 * BEFORE the target emitted a banner (mt#5065 added one to `claude-agents`):
 * such a file carries no banner, so it reads as foreign, yet it is
 * byte-identical to what the target is about to write once the banner line is
 * set aside. That equality is the one case of "untouched copy of our own
 * output" the guard can decide without the provenance manifest the rules-plane
 * RFC assigns to mt#4871 — a user's hand-authored file cannot coincide with
 * the target's rendering by accident.
 */
export function withoutBannerLine(content: string): string {
  const lines = content.split("\n");
  const head = lines.slice(0, BANNER_SCAN_LINES);
  const index = head.findIndex((line) =>
    GENERATION_BANNER_PATTERNS.some(({ re }) => re.test(line))
  );
  if (index === -1) return content;
  lines.splice(index, 1);
  return lines.join("\n");
}

/**
 * What sits at a per-file output path, relative to the content about to go there.
 *
 * - `absent` — nothing on disk; write it.
 * - `generated` — carries the banner; ours, regenerate.
 * - `pre-banner-own` — no banner, but byte-identical to the new content minus its
 *   banner line; our own earlier output, regenerate (see {@link withoutBannerLine}).
 * - `foreign` — no banner and not ours; refuse unless `--overwrite`.
 * - `unreadable` — cannot be classified; refuse even with `--overwrite`.
 * - `untracked` — the NEW content carries no banner, so the target has not
 *   opted into marker-based ownership and nothing can be established either
 *   way; write as before. Every live target emits one (mt#5065 gave
 *   `claude-agents` its banner for exactly this reason), so this is the
 *   posture for a target that does not, not a loophole for a file.
 */
export type OutputOwnership =
  | "absent"
  | "generated"
  | "pre-banner-own"
  | "foreign"
  | "unreadable"
  | "untracked";

export async function classifyOutputOwnership(
  path: string,
  newContent: string,
  fs: Pick<MinskyCompileFsDeps, "readFile">
): Promise<OutputOwnership> {
  if (!hasGenerationBanner(newContent)) return "untracked";
  let existing: string;
  try {
    existing = await fs.readFile(path, "utf-8");
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
      ? "absent"
      : "unreadable";
  }
  if (hasGenerationBanner(existing)) return "generated";
  return existing === withoutBannerLine(newContent) ? "pre-banner-own" : "foreign";
}

/** A per-file output the guard refused to write, with the operator-facing reason. */
export interface ForeignFileSkip {
  path: string;
  reason: string;
}

export interface GuardedCompileFs {
  /** The `fs` to hand to the target. Only `writeFile` differs from `inner`. */
  fs: MinskyCompileFsDeps;
  /** Paths refused because they exist without a generation banner (or are unreadable). */
  skipped: ForeignFileSkip[];
  /** Paths that existed without a banner and were written anyway because `overwrite` was set. */
  overwritten: string[];
}

/**
 * The operator-facing reason a per-file output was left alone.
 *
 * Says which file, why, and what to do — the third clause is the one that turns
 * a refusal into an actionable message rather than a dead end.
 */
export function foreignFileSkipReason(path: string, ownership: "foreign" | "unreadable"): string {
  if (ownership === "unreadable") {
    return (
      `${path} could not be read, so compile cannot tell whether it is Minsky's output or ` +
      `yours, and left it alone. Fix its permissions and re-run.`
    );
  }
  return (
    `${path} exists and carries no generation banner — it is not Minsky's output, so compile ` +
    `left it alone. Move it aside, or re-run with --overwrite to replace it.`
  );
}

/**
 * Wrap a compile filesystem so `writeFile` never silently replaces a file that
 * is not Minsky's own.
 *
 * Returned `skipped` / `overwritten` arrays fill in as the target writes; read
 * them AFTER `target.compile` returns.
 */
export function guardForeignWrites(
  inner: MinskyCompileFsDeps,
  options: { overwrite?: boolean } = {}
): GuardedCompileFs {
  const skipped: ForeignFileSkip[] = [];
  const overwritten: string[] = [];
  const overwrite = options.overwrite === true;

  // `inner` may be the real `fs/promises` module, whose methods are not
  // enumerable own properties — a spread would copy nothing. Bind each method
  // the interface names explicitly so the wrapper is complete either way.
  const fs: MinskyCompileFsDeps = {
    readFile: (path, encoding) => inner.readFile(path, encoding),
    mkdir: (path, opts) => inner.mkdir(path, opts),
    readdir: (path) => inner.readdir(path),
    access: (path) => inner.access(path),
    chmod: (path, mode) => inner.chmod(path, mode),
    async writeFile(path, data, encoding) {
      const ownership = await classifyOutputOwnership(path, data, inner);
      if (ownership === "unreadable") {
        skipped.push({ path, reason: foreignFileSkipReason(path, "unreadable") });
        return;
      }
      if (ownership === "foreign") {
        if (!overwrite) {
          skipped.push({ path, reason: foreignFileSkipReason(path, "foreign") });
          return;
        }
        overwritten.push(path);
      }
      await inner.writeFile(path, data, encoding);
    },
  };
  // Optional on the interface; only present when the inner fs provides it, so a
  // target's `fs.unlink?.(…)` probe keeps meaning what it did.
  const innerUnlink = inner.unlink;
  if (innerUnlink) {
    fs.unlink = (path) => innerUnlink.call(inner, path);
  }

  return { fs, skipped, overwritten };
}
