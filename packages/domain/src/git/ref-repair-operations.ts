import { validateProcess } from "../schemas/runtime";

// POSIX shell single-quote escape
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface RefRepairDependencies {
  execAsync: (
    command: string,
    options?: Record<string, unknown>
  ) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Parse a ref name out of git's `fatal: bad object <ref>` message — the
 * exact shape from the mt#2820 incident:
 *   `fatal: bad object refs/remotes/origin/task/mt-2304`
 */
export function parseBadObjectRef(stderr: string): string | null {
  const m = /bad object (refs\/\S+)/.exec(stderr);
  return m ? (m[1] ?? null) : null;
}

export interface BadRefCheckResult {
  ref: string;
  bad: boolean;
  error?: string;
}

/**
 * Check whether a single ref resolves to a valid, readable object.
 *
 * Uses `git log -1 <ref>` rather than `git cat-file -e <ref>`: `cat-file -e`
 * is documented to suppress ALL output (silent, exit-code-only), which
 * throws away the diagnostic text a caller needs to explain what's wrong.
 * `log -1` exits 0 (with the commit shown, discarded here) when the ref is
 * healthy, and non-zero with the exact `fatal: bad object <ref>` message —
 * the same shape as the mt#2820 incident — when the ref points at a
 * missing/invalid object.
 */
export async function checkRef(
  options: { repoPath?: string; ref: string },
  deps: RefRepairDependencies
): Promise<BadRefCheckResult> {
  const repoPath = options.repoPath ?? validateProcess(process).cwd();
  const qRepo = shellQuote(repoPath);
  const qRef = shellQuote(options.ref);
  try {
    await deps.execAsync(`git -C ${qRepo} log -1 ${qRef}`);
    return { ref: options.ref, bad: false };
  } catch (err: unknown) {
    const stderr =
      err !== null && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr ?? "")
        : err instanceof Error
          ? err.message
          : String(err);
    return { ref: options.ref, bad: true, error: stderr.trim() };
  }
}

/**
 * Enumerate refs under a prefix (default `refs/remotes/origin`) and check
 * each for validity. Used for auto-discovery when the caller doesn't
 * already know which specific ref is bad.
 */
export async function scanForBadRefs(
  options: { repoPath?: string; refPrefix?: string },
  deps: RefRepairDependencies
): Promise<BadRefCheckResult[]> {
  const repoPath = options.repoPath ?? validateProcess(process).cwd();
  const refPrefix = options.refPrefix ?? "refs/remotes/origin";
  const qRepo = shellQuote(repoPath);
  const qPrefix = shellQuote(refPrefix);
  // `%(refname)`'s parens are shell metacharacters — must be quoted, or the
  // shell parses them as a subshell and the command fails with a syntax
  // error before git ever runs.
  const qFormat = shellQuote("--format=%(refname)");

  let refs: string[];
  try {
    const { stdout } = await deps.execAsync(`git -C ${qRepo} for-each-ref ${qFormat} ${qPrefix}`);
    refs = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch (err: unknown) {
    // for-each-ref itself failing means the ref DB is too corrupt for
    // automated enumeration — that class of general corruption recovery is
    // explicitly out of scope (mt#2820 spec). Surface a clear error rather
    // than silently returning an empty (misleadingly "all clean") list.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not enumerate refs under ${refPrefix} in ${repoPath} — the ref database may be ` +
        `too corrupt for automated enumeration (${message}). Manual investigation required.`
    );
  }

  const results: BadRefCheckResult[] = [];
  for (const ref of refs) {
    results.push(await checkRef({ repoPath, ref }, deps));
  }
  return results;
}

export interface RefRepairResult {
  ref: string;
  deleted: boolean;
  refetched: boolean;
  remote: string;
}

/**
 * Repair a single corrupt/stale remote-tracking ref:
 *   1. Verify it is ACTUALLY bad (never delete a healthy ref).
 *   2. `git update-ref -d <ref>` — identify + delete.
 *   3. `git fetch <remote> --prune` — re-fetch so a legitimately-existing
 *      upstream ref is recreated (and any other genuinely-deleted remote
 *      branches are pruned in the same pass).
 *
 * Requires `confirm: true`.
 */
export async function repairBadRef(
  options: { repoPath?: string; ref: string; confirm: boolean; remote?: string },
  deps: RefRepairDependencies
): Promise<RefRepairResult> {
  if (!options.confirm) {
    throw new Error(
      "Ref repair requires confirm: true. This deletes the named ref via `git update-ref -d` " +
        "and re-fetches from the remote — call again with confirm: true to proceed."
    );
  }

  const repoPath = options.repoPath ?? validateProcess(process).cwd();
  const remote = options.remote ?? "origin";
  const qRepo = shellQuote(repoPath);
  const qRef = shellQuote(options.ref);
  const qRemote = shellQuote(remote);

  const check = await checkRef({ repoPath, ref: options.ref }, deps);
  if (!check.bad) {
    throw new Error(
      `${options.ref} resolves to a valid object — it is not corrupt. Refusing to delete a ` +
        `healthy ref.`
    );
  }

  await deps.execAsync(`git -C ${qRepo} update-ref -d ${qRef}`);
  await deps.execAsync(`git -C ${qRepo} fetch ${qRemote} --prune`);

  return { ref: options.ref, deleted: true, refetched: true, remote };
}
