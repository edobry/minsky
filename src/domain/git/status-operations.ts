import { validateProcess } from "../../schemas/runtime";

/**
 * Options for status operations.
 */
export interface StatusOptions {
  repoPath?: string;
}

/**
 * Structured result from git status, matching session_status shape for parity.
 */
export interface StatusResult {
  workdir: string;
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicted: string[];
}

/**
 * Dependencies for status operations
 */
export interface StatusDependencies {
  execAsync: (
    command: string,
    options?: Record<string, unknown>
  ) => Promise<{ stdout: string; stderr: string }>;
}

// POSIX shell single-quote escape
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Parse `git status --porcelain=v2 --branch` output into a structured result.
 *
 * v2 format: branch header lines start with "# branch.", changed entries
 * start with "1 " (ordinary), "2 " (rename/copy), "u " (unmerged), or "? " (untracked).
 */
function parsePorcelainV2(output: string): {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicted: string[];
} {
  const lines = output.split("\n");
  let branch = "HEAD";
  let ahead = 0;
  let behind = 0;
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const conflicted: string[] = [];

  for (const line of lines) {
    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length).trim();
    } else if (line.startsWith("# branch.ab ")) {
      // Format: "# branch.ab +N -M"
      const abPart = line.slice("# branch.ab ".length).trim();
      const m = abPart.match(/\+(\d+)\s+-(\d+)/);
      if (m) {
        ahead = parseInt(m[1] ?? "0", 10);
        behind = parseInt(m[2] ?? "0", 10);
      }
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      // Ordinary changed entry: "1 XY sub mH mI mW hH hI path"
      // Rename entry: "2 XY sub mH mI mW hH hI X score orig\tpath"
      // XY = two-char status: index (X) + worktree (Y)
      const parts = line.split(" ");
      const xy = parts[1] ?? "";
      if (!xy || xy.length < 2) continue;
      const indexStatus = xy.charAt(0);
      const worktreeStatus = xy.charAt(1);

      // Path is the last whitespace-separated token (renames have tab-sep orig)
      const pathPart = parts.slice(8).join(" ");
      const filePath = pathPart.includes("\t")
        ? (pathPart.split("\t")[1] ?? "").trim()
        : pathPart.trim();

      if (indexStatus && indexStatus !== "." && indexStatus !== " ") {
        staged.push(filePath);
      }
      if (worktreeStatus && worktreeStatus !== "." && worktreeStatus !== " ") {
        unstaged.push(filePath);
      }
    } else if (line.startsWith("u ")) {
      // Unmerged entry: "u XY sub m1 m2 m3 mW h1 h2 h3 path"
      const parts = line.split(" ");
      const filePath = parts.slice(10).join(" ").trim();
      conflicted.push(filePath);
    } else if (line.startsWith("? ")) {
      // Untracked: "? path"
      const filePath = line.slice(2).trim();
      untracked.push(filePath);
    }
  }

  return { branch, ahead, behind, staged, unstaged, untracked, conflicted };
}

/**
 * Get working tree status for main workspace (analog of session_status).
 * Uses `git status --porcelain=v2 --branch` for parseable output.
 */
export async function statusImpl(
  options: StatusOptions,
  deps: StatusDependencies
): Promise<StatusResult> {
  const workdir = options.repoPath ?? validateProcess(process).cwd();
  const qWorkdir = shellQuote(workdir);

  const { stdout } = await deps.execAsync(`git -C ${qWorkdir} status --porcelain=v2 --branch`);

  const parsed = parsePorcelainV2(stdout);

  return {
    workdir,
    ...parsed,
  };
}
