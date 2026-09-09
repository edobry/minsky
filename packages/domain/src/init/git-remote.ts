/**
 * Read a repository's `origin` remote, for init's forge-support notice (mt#5015).
 *
 * `init` warns when a project's remote is not GitHub, because GitHub is the only
 * repository backend Minsky implements and nothing said so until the first
 * `session start` — after init, the database, migrations and a created task. The
 * mt#5012 cold-agent run invested that whole setup before hitting the wall.
 *
 * Deliberately its own module rather than a line inside `init.ts`: reading a
 * remote is a filesystem/subprocess concern with three distinct outcomes (a
 * remote, no remote, not a repository), and naming them here keeps `init.ts`'s
 * notice a single readable condition.
 */

import { execFileSync } from "child_process";

/**
 * The `origin` remote URL, or `null` when there isn't one to read.
 *
 * `null` covers every "no answer" case — not a git repository, no `origin`
 * configured, git unavailable — because init's caller treats them identically:
 * say nothing. A project with no remote yet is not misconfigured, and
 * `session start` states the requirement precisely when it becomes relevant.
 * Distinguishing them would give the caller a choice it does not want to make.
 *
 * `execFileSync` with an argv array rather than a shell string, so `repoPath` is
 * passed verbatim and cannot be read as syntax — same class as mt#1674, and the
 * remedy PR #3682 R1 applied to init's other git call.
 */
export function readOriginRemote(repoPath: string): string | null {
  try {
    const output = execFileSync("git", ["-C", repoPath, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    const trimmed = String(output).trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // intentional-swallow: every failure mode here — not a repository, no
    // `origin`, git missing — is the same answer to the caller's question, and
    // the caller's response to it is silence. See the docblock above.
    return null;
  }
}
