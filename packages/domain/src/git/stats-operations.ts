import { validateProcess } from "../schemas/runtime";

// POSIX shell single-quote escape
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface GitStatsDependencies {
  execAsync: (
    command: string,
    options?: Record<string, unknown>
  ) => Promise<{ stdout: string; stderr: string }>;
}

// ---------------------------------------------------------------------------
// git_stats — churn-by-path analytics (mt#2624)
// ---------------------------------------------------------------------------
//
// Wraps `git log --numstat` (or `--name-only` for the lighter-weight listing
// mode) so churn/hotspot analysis — the standard tech-debt prioritization
// input (file-churn x complexity) — is expressible through the sanctioned
// MCP path instead of the blocked `git log --name-only`/`--numstat` Bash
// invocation. See mt#2624 spec for the origin of this gap.

export interface GitStatsOptions {
  repoPath?: string;
  /** Show commits more recent than a specific date (e.g. "2024-01-01", "1 week ago"). */
  since?: string;
  /** Show commits older than a specific date. */
  until?: string;
  /** Restrict the query to commits touching this path (file or directory). */
  path?: string;
  /** Filter commits by author name or email. */
  author?: string;
  /**
   * When true, skip insertion/deletion counting and just list the distinct
   * paths touched in the window (lighter-weight — uses `git log --name-only`
   * instead of `--numstat`). Per-path commit counts are still computed.
   */
  nameOnly?: boolean;
  /** Cap the number of files returned, sorted by total churn (insertions + deletions) descending. */
  limit?: number;
}

export interface FileChurnStat {
  path: string;
  /** Number of distinct commits in the window that touched this path. */
  commits: number;
  insertions: number;
  deletions: number;
}

export interface GitStatsResult {
  workdir: string;
  since?: string;
  until?: string;
  path?: string;
  nameOnly: boolean;
  /** Number of distinct commits observed in the window (across all paths). */
  totalCommits: number;
  files: FileChurnStat[];
}

/**
 * Sentinel byte prefixed onto every commit-hash line via the pretty format
 * `%x00%H` (git emits a raw NUL byte for `%x00`, then the 40-char hash).
 * NUL never appears in a numstat/name-only path line, so this framing
 * disambiguates commit-boundary lines from file lines UNAMBIGUOUSLY —
 * unlike a heuristic that treats any bare 40-hex-char line as a hash,
 * which misclassifies a root-level file whose NAME happens to be a
 * 40-char lowercase hex string (a valid filename) in `--name-only` mode.
 */
const COMMIT_LINE_PREFIX = "\0";
const COMMIT_HASH_RE = /^[0-9a-f]{40}$/;

interface FileAccumulator {
  commits: Set<string>;
  insertions: number;
  deletions: number;
}

/**
 * Parse the output of `git log --pretty=format:%x00%H` combined with either
 * `--numstat` or `--name-only`. Both formats interleave a NUL-prefixed
 * commit hash line with per-file lines for that commit (separated by a
 * blank line, which this parser ignores). Only NUL-prefixed lines are
 * treated as commit boundaries — this is the sole discriminator, so a
 * bare 40-hex-char file path (in `--name-only` mode) is never
 * misclassified as a hash. `--numstat` lines are tab-separated
 * `<insertions>\t<deletions>\t<path>` (or `-\t-\t<path>` for binary files);
 * `--name-only` lines are bare paths.
 */
function parseLogOutput(output: string): {
  files: Map<string, FileAccumulator>;
  totalCommits: number;
} {
  const files = new Map<string, FileAccumulator>();
  const seenCommits = new Set<string>();
  let currentHash: string | null = null;

  for (const rawLine of output.split("\n")) {
    if (rawLine.startsWith(COMMIT_LINE_PREFIX)) {
      const hash = rawLine.slice(COMMIT_LINE_PREFIX.length).trim();
      if (COMMIT_HASH_RE.test(hash)) {
        currentHash = hash;
        seenCommits.add(hash);
      }
      continue;
    }

    const line = rawLine.trim();
    if (!line) continue;

    if (!currentHash) continue;

    let filePath: string;
    let insertions = 0;
    let deletions = 0;

    if (line.includes("\t")) {
      // --numstat line: "<insertions>\t<deletions>\t<path>"
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const [insStr, delStr, ...pathParts] = parts;
      filePath = pathParts.join("\t");
      insertions = insStr === "-" ? 0 : parseInt(insStr ?? "0", 10) || 0;
      deletions = delStr === "-" ? 0 : parseInt(delStr ?? "0", 10) || 0;
    } else {
      // --name-only line: bare path (may itself look like a 40-hex hash —
      // that's fine, only the NUL-prefixed line above is a commit boundary)
      filePath = line;
    }

    if (!filePath) continue;

    let entry = files.get(filePath);
    if (!entry) {
      entry = { commits: new Set(), insertions: 0, deletions: 0 };
      files.set(filePath, entry);
    }
    entry.commits.add(currentHash);
    entry.insertions += insertions;
    entry.deletions += deletions;
  }

  return { files, totalCommits: seenCommits.size };
}

/**
 * Compute per-path churn (commit count + insertions/deletions) over a
 * window, via `git log --numstat` (or `--name-only` when `nameOnly` is
 * set). Renames are intentionally NOT collapsed (`--no-renames` is always
 * passed) so results are deterministic regardless of the caller's
 * `diff.renames` config — a rename is counted as a full delete of the old
 * path plus a full add of the new path, which is defensible for churn
 * analysis (a rename is itself a churn event).
 */
export async function gitStatsImpl(
  options: GitStatsOptions,
  deps: GitStatsDependencies
): Promise<GitStatsResult> {
  const workdir = options.repoPath ?? validateProcess(process).cwd();
  const qWorkdir = shellQuote(workdir);
  const nameOnly = options.nameOnly ?? false;

  const args: string[] = ["git", "-C", qWorkdir, "log", "--no-renames"];
  args.push(nameOnly ? "--name-only" : "--numstat");
  // %x00 emits a raw NUL byte before the hash so parseLogOutput can treat
  // ONLY NUL-prefixed lines as commit boundaries (mt#2624 R1) — this
  // disambiguates from a --name-only path that happens to be a bare
  // 40-hex-char filename.
  args.push("--pretty=format:%x00%H");

  if (options.since) {
    args.push(`--since=${shellQuote(options.since)}`);
  }
  if (options.until) {
    args.push(`--until=${shellQuote(options.until)}`);
  }
  if (options.author) {
    args.push(`--author=${shellQuote(options.author)}`);
  }
  if (options.path) {
    args.push("--", shellQuote(options.path));
  }

  const { stdout } = await deps.execAsync(args.join(" "));
  const { files: fileMap, totalCommits } = parseLogOutput(stdout);

  let files: FileChurnStat[] = Array.from(fileMap.entries()).map(([path, stat]) => ({
    path,
    commits: stat.commits.size,
    insertions: stat.insertions,
    deletions: stat.deletions,
  }));

  files.sort((a, b) => {
    const churnDiff = b.insertions + b.deletions - (a.insertions + a.deletions);
    return churnDiff !== 0 ? churnDiff : b.commits - a.commits;
  });

  if (typeof options.limit === "number" && options.limit >= 0) {
    files = files.slice(0, options.limit);
  }

  return {
    workdir,
    since: options.since,
    until: options.until,
    path: options.path,
    nameOnly,
    totalCommits,
    files,
  };
}
