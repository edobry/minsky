/**
 * Resolve the spec text an agent authored in a tool call — inline OR by file
 * reference (mt#4525, subsuming mt#4295).
 *
 * ## Why this exists
 *
 * `tasks_edit` accepts the spec body two ways: inline as `specContent`, or by
 * reference as `specFile`, whose contents the command reads and uses as the new
 * body (`src/adapters/shared/commands/tasks/edit-commands.ts`). A guard that reads
 * only the inline key sees a `--spec-file` write as a call carrying NO spec — and
 * because that is indistinguishable from a legitimately spec-less call, the miss
 * reports itself as a clean skip. A recall hole that looks like a clean skip is not
 * discoverable by use.
 *
 * **Three guards hit this independently before it was extracted:**
 *
 * 1. `spec-criterion-claim-detector.ts` — patched by PR #3063 R1 after review caught
 *    it; its own comment called the gap "a silent coverage hole". That patch is the
 *    reference this module generalizes.
 * 2. `claim-provenance-scan.ts` — same hole, found separately, months later (mt#4295).
 * 3. `code-mechanism-assertion-detector.ts` — worse: `tasks_edit` was absent from its
 *    tool allowlist entirely, so neither path was read (mt#4525).
 *
 * Guard #4 would inherit it by default. The per-guard fix tier demonstrably did not
 * contain the class, which is why the resolution lives here instead.
 *
 * ## What this module deliberately does NOT own
 *
 * **Which tools a guard scans is the guard's own policy, not this module's.** Each
 * caller passes its own inline-key map. That is not indecision — the three callers
 * genuinely scan different tool sets (`claim-provenance-scan` reads
 * `tasks_spec_search_replace`, `spec-criterion-claim-detector` does not), and folding
 * them into one shared set would silently WIDEN each guard's corpus. A widened corpus
 * changes fire rates, which confounds the before/after replay every one of these
 * guards is calibrated by (the confound mem#1067 §2 names). Sharing the resolution
 * while leaving scope alone is the whole point.
 *
 * @see mt#4525 — the extraction; mt#4295 — subsumed into it
 * @see mt#4536 — the ADJACENT and much larger hole: a write routed through the CLI
 *   reaches the DB via a subprocess, so no PreToolUse guard sees it at all. This
 *   module cannot help there; it resolves an argument of a tool call that happened.
 */

import { closeSync, fstatSync, openSync, readSync, realpathSync } from "fs";
import { isAbsolute, relative, resolve } from "path";
import { findRepoRoot } from "./types";

/**
 * Tool-input key naming a FILE whose contents become the spec.
 *
 * Only `tasks_edit` has one — `tasks_create`, `tasks_spec_patch` and
 * `tasks_spec_search_replace` take their bodies inline only. Keyed on the
 * NORMALIZED name; see {@link normalizeSpecToolName}.
 */
const SPEC_FILE_KEY_BY_TOOL: Readonly<Record<string, string>> = {
  tasks_edit: "specFile",
};

/**
 * Size ceiling for a `specFile` read. A spec is prose — the largest in this repo is
 * comfortably under 100 KB — so anything past this is not a spec, and the hook
 * declines rather than pulling an arbitrarily large file into a PreToolUse budget.
 */
export const MAX_SPEC_FILE_BYTES = 512 * 1024;

/**
 * Normalize a tool name to the bare command form.
 *
 * **The two existing callers key on DIFFERENT spellings** — `spec-criterion-claim-detector`
 * on the fully-prefixed `mcp__minsky__tasks_edit`, `claim-provenance-scan` on the bare
 * `tasks_edit` after its own `normalize()`. A resolver that accepted only one spelling
 * would cover one caller and silently miss the other, which is this family's own defect
 * re-entered through its fix. So normalization happens HERE, once, and both spellings
 * resolve to the same key.
 */
export function normalizeSpecToolName(toolName: string): string {
  return toolName
    .replace(/^mcp__minsky__/, "")
    .replace(/\./g, "_")
    .toLowerCase();
}

/**
 * Is one REAL path inside another? Pure string comparison, and it is only sound
 * because {@link canonicalizeInsideRepo} has already expanded both.
 *
 * mt#4295 SC4. A PreToolUse guard runs against arbitrary tool input, so the file key
 * is attacker-adjacent in the same sense any tool argument is; an observer should not
 * be turned into a read primitive for `/etc/passwd` or `~/.aws/credentials` by a
 * crafted argument.
 *
 * **The reference implementation this module generalizes does NOT do this check** —
 * `spec-criterion-claim-detector.readSpecFileFromDisk` reads whatever path it is
 * given. So the extraction is not a pure move: it closes a hole in its own reference,
 * which is the criterion mt#4295 carried and the sibling never had.
 *
 * Exported for its own tests: containment is a decision worth asserting directly
 * rather than only through a file read, and a pure function is testable without
 * touching a filesystem (`custom/no-real-fs-in-tests`).
 */
export function isInsideRepo(realPath: string, realRepoRoot: string): boolean {
  const rel = relative(realRepoRoot, realPath);
  // `relative` returns "" for the root itself, a `..`-prefixed path for anything
  // above it, and an absolute path when the two are on different roots.
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Canonicalize a candidate spec path and decide whether it is inside the repo.
 *
 * **Both arguments must already be REAL paths — that is the whole fix (PR #3309 R1).**
 * The first version of this check compared `resolve()`d strings, which is LEXICAL: it
 * never touches the filesystem, so an in-repo symlink pointing outside
 * (`docs/spec.md -> /etc/passwd`) produced a relative path of `docs/spec.md` — no
 * `..`, not absolute — and sailed through, while `readFileSync` cheerfully followed
 * the link. The reviewer caught it, and it was correct: the check reintroduced the
 * exact class it was written to close, which is worse than not having it, because the
 * comment above it asserted the protection.
 *
 * The repo ROOT is canonicalized too, not just the candidate. On macOS the session
 * workspaces and `/tmp` are themselves symlinked (`/tmp` → `/private/tmp`), so
 * comparing a real path against a non-real root rejects legitimate in-repo files.
 *
 * `realpathSync` throws on a path that does not exist, which is why this returns a
 * discriminated result rather than a boolean: the caller must not report a missing
 * file as "outside the repo".
 */
export function canonicalizeInsideRepo(
  path: string,
  /**
   * Injected so the SYMLINK case is assertable without creating one on a real
   * filesystem (`custom/no-real-fs-in-tests`). This seam is what makes the fix
   * testable at all: a test of {@link isInsideRepo} alone cannot discriminate,
   * because the old lexical code ALSO returned false for `/etc/passwd` — its bug
   * was that it never obtained the real path in the first place. Stubbing the
   * expansion is the only way to assert that expansion HAPPENS.
   */
  realpath: (p: string) => string = realpathSync,
  /**
   * Repo-root anchor. `findRepoRoot` WALKS UP to the git root rather than trusting
   * `process.cwd()` (PR #3309 R2, non-blocking).
   *
   * The difference is a silent coverage LOSS, which is exactly the failure class this
   * whole module exists to remove: a hook process whose cwd is a subdirectory would
   * anchor containment there, and every legitimate spec path outside that subtree
   * would be refused — recorded as `specFileUnreadable`, indistinguishable from a
   * genuinely bad path. Shipping that inside a coverage fix would have been the joke
   * writing itself.
   */
  cwd: () => string = () => findRepoRoot(process.cwd())
): string | null {
  try {
    const realRoot = realpath(cwd());
    // resolve() first so a relative path is anchored to the repo, THEN realpath so
    // every symlink in the chain — including intermediate directories — is expanded.
    const realPath = realpath(resolve(realRoot, path));
    return isInsideRepo(realPath, realRoot) ? realPath : null;
  } catch {
    // intentional-swallow: a nonexistent or unreadable path is a coverage miss the
    // caller records, never a reason to fail the tool call.
    return null;
  }
}

/**
 * Read a spec file from disk, or null if it cannot be read as a spec.
 *
 * Every failure is a null rather than a throw: this is an observer that must not turn
 * a valid `tasks_edit` into an error. A null is never SILENT — the caller records
 * `specFileUnreadable`, so the miss stays measurable instead of looking like a call
 * that carried no spec. That distinction is mt#4295 SC2: a guard that cannot read its
 * input has not adjudicated it, and must not record `clean`.
 */
export function readSpecFileFromDisk(path: string): string | null {
  const realPath = canonicalizeInsideRepo(path);
  if (realPath === null) return null;

  // ONE descriptor for the size check and the read (PR #3309 R1, non-blocking).
  // The previous shape was existsSync → statSync(path) → readFileSync(path): three
  // separate resolutions of the same name, so the file could be swapped between the
  // size check and the read. Sizing via `fstatSync` on the descriptor we then read
  // from means the bytes measured are the bytes returned.
  let fd: number | null = null;
  try {
    fd = openSync(realPath, "r");
    const stat = fstatSync(fd);
    // Not a regular file — a directory, fifo or device. `readSync` on one of those
    // either throws or blocks, and neither is a spec.
    if (!stat.isFile()) return null;
    if (stat.size > MAX_SPEC_FILE_BYTES) return null;
    if (stat.size === 0) return null;

    const buffer = Buffer.allocUnsafe(stat.size);
    let read = 0;
    while (read < stat.size) {
      const n = readSync(fd, buffer, read, stat.size - read, read);
      if (n <= 0) break;
      read += n;
    }
    const text = buffer.subarray(0, read).toString("utf8");
    return text.trim() === "" ? null : text;
  } catch {
    // intentional-swallow: an unreadable spec file is a coverage miss, recorded by the
    // caller via `specFileUnreadable` — never a reason to fail the tool call.
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // intentional-swallow: a failed close cannot change the value already read,
        // and must not turn a successful read into an error.
      }
    }
  }
}

/** What a spec-body read produced, and — when it produced nothing — why. */
export interface SpecTextRead {
  text: string | null;
  /**
   * A spec file was named and could not be read. Distinguishes a MISS from "this call
   * carries no spec", which is the whole reason this field exists.
   */
  specFileUnreadable: boolean;
}

/**
 * Read the authored spec body out of a tool call, or null when it carries none.
 *
 * `inlineKeys` is the CALLER's map of normalized tool name → the input key carrying
 * the body inline. It is a parameter rather than a constant here for the scope reason
 * in this module's header.
 *
 * **A trap worth carrying from the reference:** `tasks_edit`'s own `spec` parameter is
 * a BOOLEAN flag, not a body (PR #3063 R1 read the two as the same key and was wrong).
 * The `typeof value === "string"` check below is what keeps that from mattering, so do
 * not relax it into a truthiness test.
 *
 * `readFile` is injectable so the file branch is testable without touching a real
 * filesystem — `testing-standards.mdc §Testable Design`: inject the collaborator
 * rather than patching it.
 */
export function readAuthoredSpecText(
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
  inlineKeys: Readonly<Record<string, string>>,
  readFile: (path: string) => string | null = readSpecFileFromDisk
): SpecTextRead {
  const miss: SpecTextRead = { text: null, specFileUnreadable: false };
  if (!toolName || !toolInput) return miss;

  const normalized = normalizeSpecToolName(toolName);

  const inlineKey = inlineKeys[normalized];
  if (inlineKey !== undefined) {
    const value = toolInput[inlineKey];
    if (typeof value === "string" && value.trim() !== "") {
      return { text: value, specFileUnreadable: false };
    }
  }

  // Only AFTER the inline body is absent: the two are alternatives, and the inline
  // form is both cheaper and the common case.
  const fileKey = SPEC_FILE_KEY_BY_TOOL[normalized];
  if (fileKey !== undefined) {
    const path = toolInput[fileKey];
    if (typeof path === "string" && path.trim() !== "") {
      const text = readFile(path);
      return text === null
        ? { text: null, specFileUnreadable: true }
        : { text, specFileUnreadable: false };
    }
  }

  return miss;
}
