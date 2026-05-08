import { validateProcess } from "../../schemas/runtime";

// POSIX shell single-quote escape
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Shared deps type
// ---------------------------------------------------------------------------

export interface StashDependencies {
  execAsync: (
    command: string,
    options?: Record<string, unknown>
  ) => Promise<{ stdout: string; stderr: string }>;
}

// ---------------------------------------------------------------------------
// git_stash
// ---------------------------------------------------------------------------

export interface StashOptions {
  repoPath?: string;
  /** Optional message for the stash entry */
  message?: string;
  /** Optional list of paths to stash selectively */
  paths?: string[];
}

export interface StashImplResult {
  workdir: string;
  stashRef: string | null;
  stashed: boolean;
}

/**
 * Push changes onto the stash. Returns `{ stashed: false }` when there is
 * nothing to stash (working tree clean).
 */
export async function stashImpl(
  options: StashOptions,
  deps: StashDependencies
): Promise<StashImplResult> {
  const workdir = options.repoPath ?? validateProcess(process).cwd();
  const qWorkdir = shellQuote(workdir);

  const args: string[] = [`git -C ${qWorkdir} stash push`];
  if (options.message) {
    args.push(`-m ${shellQuote(options.message)}`);
  }
  if (options.paths && options.paths.length > 0) {
    args.push("--");
    for (const p of options.paths) {
      args.push(shellQuote(p));
    }
  }

  const { stdout } = await deps.execAsync(args.join(" "));
  const trimmed = stdout.trim();

  // git outputs "No local changes to save" when tree is clean
  if (trimmed === "No local changes to save") {
    return { workdir, stashRef: null, stashed: false };
  }

  // Parse the stash ref from output like "Saved working directory and index state stash@{0}: ..."
  const refMatch = trimmed.match(/stash@\{\d+\}/);
  const stashRef = refMatch ? refMatch[0] : "stash@{0}";

  return { workdir, stashRef, stashed: true };
}

// ---------------------------------------------------------------------------
// git_stash_pop
// ---------------------------------------------------------------------------

export interface StashPopOptions {
  repoPath?: string;
  /** Specific stash ref to pop, e.g. "stash@{1}". Defaults to most recent. */
  ref?: string;
}

export interface StashPopResult {
  workdir: string;
  popped: boolean;
  conflicts: string[];
}

/**
 * Pop (apply + drop) a stash entry. Returns any conflict paths if the pop
 * resulted in merge conflicts.
 */
export async function stashPopImpl(
  options: StashPopOptions,
  deps: StashDependencies
): Promise<StashPopResult> {
  const workdir = options.repoPath ?? validateProcess(process).cwd();
  const qWorkdir = shellQuote(workdir);

  const refArg = options.ref ? ` ${shellQuote(options.ref)}` : "";
  const cmd = `git -C ${qWorkdir} stash pop${refArg}`;

  try {
    await deps.execAsync(cmd);
    return { workdir, popped: true, conflicts: [] };
  } catch (err: unknown) {
    // Extract stderr/stdout safely using direct property access rather than validateGitError,
    // because the exec error's `signal: null` fails gitErrorSchema (z.string().optional()
    // does not accept null), causing the schema fallback to strip these fields entirely.
    const stderr =
      err !== null && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr ?? "")
        : "";
    const stdout =
      err !== null && typeof err === "object" && "stdout" in err
        ? String((err as { stdout: unknown }).stdout ?? "")
        : "";

    // Conflict during stash pop: git exits non-zero and prints CONFLICT lines
    if (stderr.includes("CONFLICT") || stdout.includes("CONFLICT")) {
      const conflictLines = `${stderr}\n${stdout}`
        .split("\n")
        .filter((l) => l.includes("CONFLICT"))
        .map((l) => l.replace(/^CONFLICT \([^)]+\): /, "").trim());
      return { workdir, popped: false, conflicts: conflictLines };
    }

    throw err;
  }
}

// ---------------------------------------------------------------------------
// git_stash_list
// ---------------------------------------------------------------------------

export interface StashListOptions {
  repoPath?: string;
}

export interface StashEntry {
  ref: string;
  message: string;
  branch: string;
  timestamp: string;
}

export interface StashListResult {
  workdir: string;
  stashes: StashEntry[];
}

/**
 * List all stash entries with structured metadata.
 */
export async function stashListImpl(
  options: StashListOptions,
  deps: StashDependencies
): Promise<StashListResult> {
  const workdir = options.repoPath ?? validateProcess(process).cwd();
  const qWorkdir = shellQuote(workdir);

  // Use a delimiter-separated format for reliable parsing
  // Format: ref|timestamp|branch|message
  const fmt = "%gd|%ci|%gs";
  const { stdout } = await deps.execAsync(
    `git -C ${qWorkdir} stash list --format=${shellQuote(fmt)}`
  );

  const stashes: StashEntry[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Expected: "stash@{0}|2026-01-01 12:00:00 +0000|On main: message text"
    const firstPipe = trimmed.indexOf("|");
    const secondPipe = trimmed.indexOf("|", firstPipe + 1);
    if (firstPipe === -1 || secondPipe === -1) continue;

    const ref = trimmed.slice(0, firstPipe);
    const timestamp = trimmed.slice(firstPipe + 1, secondPipe);
    const gsField = trimmed.slice(secondPipe + 1);

    // %gs format: "On <branch>: <message>" or "WIP on <branch>: <hash> <message>"
    let branch = "";
    let message = gsField;

    const onMatch = gsField.match(/^(?:WIP )?[Oo]n ([^:]+):\s*(.*)/);
    if (onMatch) {
      branch = (onMatch[1] ?? "").trim();
      message = (onMatch[2] ?? gsField).trim();
    }

    stashes.push({ ref, message, branch, timestamp });
  }

  return { workdir, stashes };
}

// ---------------------------------------------------------------------------
// git_stash_drop
// ---------------------------------------------------------------------------

export interface StashDropOptions {
  repoPath?: string;
  /** Stash ref to drop (required). E.g. "stash@{0}". */
  ref: string;
  /**
   * Explicit confirmation required for this destructive operation.
   * Must be set to `true` to proceed.
   */
  confirmDrop: boolean;
}

export interface StashDropResult {
  workdir: string;
  dropped: boolean;
}

/**
 * Drop a specific stash entry. Requires `confirmDrop: true` to proceed
 * (enforced at the schema layer and re-checked here for defense-in-depth).
 */
export async function stashDropImpl(
  options: StashDropOptions,
  deps: StashDependencies
): Promise<StashDropResult> {
  if (!options.confirmDrop) {
    throw new Error(
      "stash_drop requires `confirmDrop: true`. " +
        "This operation permanently deletes the stash entry and cannot be undone. " +
        "Set `confirmDrop: true` to proceed."
    );
  }

  const workdir = options.repoPath ?? validateProcess(process).cwd();
  const qWorkdir = shellQuote(workdir);

  await deps.execAsync(`git -C ${qWorkdir} stash drop ${shellQuote(options.ref)}`);

  return { workdir, dropped: true };
}
