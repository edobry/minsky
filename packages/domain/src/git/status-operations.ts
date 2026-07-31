import { validateProcess } from "../schemas/runtime";
import { runGitCommandWithLockHandling, type LockDependencies } from "./lock-operations";

/**
 * Options for status operations.
 */
export interface StatusOptions {
  repoPath?: string;
  /**
   * When true, a blocked `.git/index.lock` is auto-repaired (confirm-gated
   * internally: only removed when provably stale) and status retried once.
   * When false/omitted, a lock-blocked error is enriched with diagnostics
   * (age, owning-process liveness) instead of the raw git fatal.
   */
  repairLock?: boolean;
}

/**
 * Structured result from git status, matching session_status shape for parity.
 */
export interface StatusResult {
  workdir: string;
  branch: string;
  /**
   * The configured upstream ref (e.g. `origin/main`), or null when the branch
   * has none (mt#3164).
   *
   * Null does NOT strictly mean "never pushed" — a branch pushed without `-u`,
   * one created with `--no-track`, or one whose upstream ref was deleted also
   * has none. What null reliably means is that git has no upstream to compare
   * against, so `ahead`/`behind` are unanswerable. "Never pushed" is the common
   * cause, not the definition (PR #2314 R1).
   */
  upstream: string | null;
  /**
   * Commits ahead of / behind the upstream, or **null when there is no
   * upstream** — the question does not apply rather than answering zero.
   *
   * Consumers must not coerce null to 0: that reintroduces the exact ambiguity
   * this distinction exists to remove, one layer up.
   */
  ahead: number | null;
  behind: number | null;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicted: string[];
}

/**
 * Dependencies for status operations
 */
export type StatusDependencies = LockDependencies;

// POSIX shell single-quote escape
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Parse `git status --porcelain=v2 --branch -z` output into a structured result.
 *
 * Why `-z`: porcelain v2 without `-z` C-quotes paths containing newlines,
 * spaces, double-quotes, or non-ASCII; with `-z` the paths are emitted RAW
 * and records are NUL-terminated, eliminating the need to unquote and
 * preventing mis-parses on pathological filenames. Rename records (`2 `)
 * also separate orig from new path with a single inline NUL when `-z` is
 * passed (instead of `\t`). Branch headers (`# branch.*`) remain LF-
 * terminated, but trailing-LF is fine because we identify them by leading
 * `# branch.` and skip empty records.
 */
function parsePorcelainV2(output: string): {
  branch: string;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicted: string[];
} {
  let branch = "HEAD";
  let upstream: string | null = null;
  // NOT initialized to 0 (mt#3164). Git emits `# branch.ab` only when the
  // branch HAS an upstream, so a `0` default made "no upstream configured"
  // indistinguishable from "configured and exactly in sync" — a branch that had
  // never been pushed reported the same `ahead: 0, behind: 0` as one fully up to
  // date. Deciding whether work was pushed then required a second, different
  // tool call. Null means "this question does not apply here."
  let ahead: number | null = null;
  let behind: number | null = null;
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const conflicted: string[] = [];

  // With `-z`, EVERY record is NUL-terminated — including each `# branch.*`
  // header line. (Verified empirically: `# branch.oid <oid>\0# branch.head
  // main\0# branch.ab +0 -0\0? a.ts\0`.) So each split() element is exactly
  // one record: one branch header OR one changed entry.
  const records = output.split("\0");

  let i = 0;
  while (i < records.length) {
    const record = records[i] ?? "";
    if (!record) {
      i++;
      continue;
    }

    if (record.startsWith("# branch.head ")) {
      branch = record.slice("# branch.head ".length).trim();
      i++;
      continue;
    }

    if (record.startsWith("# branch.ab ")) {
      const abPart = record.slice("# branch.ab ".length).trim();
      const m = abPart.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        ahead = parseInt(m[1] ?? "0", 10);
        behind = parseInt(m[2] ?? "0", 10);
      }
      i++;
      continue;
    }

    if (record.startsWith("# branch.upstream ")) {
      // Present only when an upstream is configured — which is precisely the
      // signal that distinguishes "never pushed" from "in sync" (mt#3164).
      upstream = record.slice("# branch.upstream ".length).trim() || null;
      i++;
      continue;
    }

    if (record.startsWith("# ")) {
      // Other branch headers (oid) — ignore.
      i++;
      continue;
    }

    if (record.startsWith("1 ")) {
      // Ordinary changed entry: "1 XY sub mH mI mW hH hI <path>"
      // 8 space-separated fields then the path verbatim. With `-z` the path
      // is RAW (not C-quoted), so any embedded spaces/special chars are
      // preserved as-is. Splitting into max 9 segments keeps the path
      // intact in field[8].
      const fields = splitMax(record, " ", 9);
      const xy = fields[1] ?? "";
      if (xy.length >= 2) {
        const indexStatus = xy.charAt(0);
        const worktreeStatus = xy.charAt(1);
        const filePath = fields[8] ?? "";
        if (filePath) {
          if (indexStatus && indexStatus !== "." && indexStatus !== " ") {
            staged.push(filePath);
          }
          if (worktreeStatus && worktreeStatus !== "." && worktreeStatus !== " ") {
            unstaged.push(filePath);
          }
        }
      }
      i++;
      continue;
    }

    if (record.startsWith("2 ")) {
      // Rename/copy entry: "2 XY sub mH mI mW hH hI X<score> <newpath>"
      // followed by the orig-path as the NEXT NUL-terminated record. We
      // collect the new path here and skip the orig follow-up.
      const fields = splitMax(record, " ", 10);
      const xy = fields[1] ?? "";
      if (xy.length >= 2) {
        const indexStatus = xy.charAt(0);
        const worktreeStatus = xy.charAt(1);
        const filePath = fields[9] ?? "";
        if (filePath) {
          if (indexStatus && indexStatus !== "." && indexStatus !== " ") {
            staged.push(filePath);
          }
          if (worktreeStatus && worktreeStatus !== "." && worktreeStatus !== " ") {
            unstaged.push(filePath);
          }
        }
      }
      i += 2;
      continue;
    }

    if (record.startsWith("u ")) {
      // Unmerged entry: "u XY sub m1 m2 m3 mW h1 h2 h3 <path>"
      const fields = splitMax(record, " ", 11);
      const filePath = fields[10] ?? "";
      if (filePath) {
        conflicted.push(filePath);
      }
      i++;
      continue;
    }

    if (record.startsWith("? ")) {
      // Untracked: "? <path>"
      const filePath = record.slice(2);
      if (filePath) {
        untracked.push(filePath);
      }
      i++;
      continue;
    }

    // Unknown record type — skip.
    i++;
  }

  return { branch, upstream, ahead, behind, staged, unstaged, untracked, conflicted };
}

/**
 * Split `s` on `sep` into at most `max` segments. The final segment retains
 * any embedded separator characters verbatim — necessary for porcelain v2
 * fields where the path is the last token and may itself contain spaces.
 */
function splitMax(s: string, sep: string, max: number): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let n = 0; n < max - 1; n++) {
    const idx = s.indexOf(sep, start);
    if (idx === -1) break;
    parts.push(s.slice(start, idx));
    start = idx + sep.length;
  }
  parts.push(s.slice(start));
  return parts;
}

/**
 * Get working tree status for main workspace (analog of session_status).
 * Uses `git status --porcelain=v2 --branch -z` for robust parsing of paths
 * with embedded spaces, newlines, or special characters.
 */
export async function statusImpl(
  options: StatusOptions,
  deps: StatusDependencies
): Promise<StatusResult> {
  const workdir = options.repoPath ?? validateProcess(process).cwd();
  const qWorkdir = shellQuote(workdir);

  const { stdout } = await runGitCommandWithLockHandling(
    `git -C ${qWorkdir} status --porcelain=v2 --branch -z`,
    deps,
    { repoPath: workdir, repairLock: options.repairLock }
  );

  const parsed = parsePorcelainV2(stdout);

  return {
    workdir,
    ...parsed,
  };
}
