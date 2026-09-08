/**
 * Keep `init`'s machine-local writes out of git (mt#5014).
 *
 * `init` creates `.minsky/config.local.yaml`, and `setup db` later writes the
 * Postgres connection string — password included — into that same file. Two
 * comments in `config-content.ts` already called the file "gitignored"; nothing
 * made it true. On a fresh repository `init` wrote no `.gitignore` at all, so
 * the file sat untracked-and-unignored, which is precisely the state where
 * `git add -A`, `git add .`, or an editor's "stage all" commits it.
 *
 * Reproduced 2026-09-08: `minsky init --backend minsky` in a directory holding
 * only a `package.json` produced `.minsky/config.local.yaml` and no
 * `.gitignore`. The blast radius is a live credential in a git history, which
 * deleting the file in a later commit does not undo.
 *
 * The exposure window opens at `init` — when the file becomes committable — and
 * only becomes credential-bearing at `setup db`. So the entry is written at
 * CREATION time rather than when the secret arrives: by then a `git add -A` may
 * already have staged it.
 *
 * ## Why the ignore probe is injected
 *
 * "Is this path already ignored?" is a question only git can answer, because
 * the answer may come from a parent directory's `.gitignore`, the user's global
 * excludes file, or `.git/info/exclude` — none of which are visible in the
 * repository's own `.gitignore`. Writing a redundant entry in those cases is
 * the failure this module's caller explicitly does not want.
 *
 * Taking that probe as a parameter (rather than reaching for git inside) is
 * what lets the tests drive every branch — already-ignored, absent-file,
 * existing-file, no-git — against real filesystem doubles without a subprocess
 * and without patching a module the code reaches itself.
 */

import * as path from "path";
import type { FsLike } from "../interfaces/fs-like";
import { execGitWithTimeout } from "../utils/git-exec";

/**
 * The path `init` must keep out of git. Exported so the test and any future
 * caller assert against the same literal the writer uses.
 */
export const LOCAL_CONFIG_GITIGNORE_ENTRY = ".minsky/config.local.yaml";

/** What `ensurePathIgnored` did, so the caller can log it and tests can assert it. */
export type EnsurePathIgnoredAction =
  /** git already ignores it — via this file, a parent, or a global excludes file. */
  | "already-ignored"
  /** `.gitignore` existed and the entry was appended, leaving every prior line intact. */
  | "appended"
  /** No `.gitignore` existed; one was created carrying just this entry. */
  | "created";

export interface EnsurePathIgnoredResult {
  readonly action: EnsurePathIgnoredAction;
  readonly gitignorePath: string;
}

/**
 * Answers "does git already ignore this path?" — the real implementation.
 *
 * `git check-ignore --quiet` exits 0 when the path is ignored and 1 when it is
 * not, and it consults the FULL ignore chain, which is the whole reason this is
 * a git call rather than a read of one file.
 *
 * **Fails to `false`, deliberately.** A missing git, a directory that is not a
 * repository, or any other error means we could not establish that the path is
 * ignored — and the safe response to "unknown" here is to write the entry. A
 * redundant line in a `.gitignore` is harmless; a credential that is committable
 * because a probe errored is not. The one cost is a possible duplicate entry in
 * a non-repo directory, and the text check in `ensurePathIgnored` catches that.
 */
export async function gitIgnoresPath(repoPath: string, entry: string): Promise<boolean> {
  try {
    await execGitWithTimeout("init-check-ignore", `check-ignore --quiet ${entry}`, {
      workdir: repoPath,
      timeout: 5000,
    });
    return true;
  } catch {
    // intentional-swallow: a non-zero exit is the documented "not ignored"
    // answer, and every other failure is deliberately treated the same way —
    // see the fail-to-false rationale above.
    return false;
  }
}

/** Does this `.gitignore` text already carry `entry` as a line of its own? */
function textAlreadyLists(gitignoreText: string, entry: string): boolean {
  return gitignoreText
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === entry);
}

/**
 * Ensure `entry` is ignored by git under `repoPath`, without disturbing
 * anything already there.
 *
 * Idempotent: a second call finds the path ignored and writes nothing. The
 * append path never rewrites existing content — it only adds a line, and adds
 * a separating newline first when the file does not already end in one.
 *
 * @param ignoreProbe injected so tests can drive the already-ignored branch;
 *   defaults to a real `git check-ignore`.
 */
export async function ensurePathIgnored(
  repoPath: string,
  entry: string,
  fileSystem: FsLike,
  ignoreProbe: (repoPath: string, entry: string) => Promise<boolean> = gitIgnoresPath
): Promise<EnsurePathIgnoredResult> {
  const gitignorePath = path.join(repoPath, ".gitignore");

  // SC3: a project that already ignores this path — through a parent
  // `.gitignore`, a global excludes file, or an entry it wrote itself — is left
  // alone rather than given a redundant line.
  if (await ignoreProbe(repoPath, entry)) {
    return { action: "already-ignored", gitignorePath };
  }

  if (!(await fileSystem.exists(gitignorePath))) {
    await fileSystem.writeFile(gitignorePath, `${entry}\n`);
    return { action: "created", gitignorePath };
  }

  const existing = await fileSystem.readFile(gitignorePath, "utf8");

  // Belt-and-braces for the case the probe could not answer (no git, not a
  // repository): without this, a fail-to-false probe would append the same line
  // on every run.
  if (textAlreadyLists(existing, entry)) {
    return { action: "already-ignored", gitignorePath };
  }

  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  await fileSystem.writeFile(gitignorePath, `${existing}${separator}${entry}\n`);
  return { action: "appended", gitignorePath };
}
