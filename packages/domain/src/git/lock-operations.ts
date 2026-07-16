import { stat, rm } from "fs/promises";
import { join } from "path";
import { validateProcess } from "../schemas/runtime";

// POSIX shell single-quote escape
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface LockDependencies {
  execAsync: (
    command: string,
    options?: Record<string, unknown>
  ) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Minimum age (ms) an `index.lock` must have — with NO live owning process
 * detected — before it is eligible for automatic removal.
 *
 * Grounded in the mt#2820 incident data: the Jul 14 2026 abandoned lock in
 * the main workspace was ~22 HOURS old and zero-byte when discovered. No
 * legitimate git operation this tool wraps (status/restore/pull/stash/reset —
 * all short, local, single-command invocations) holds `index.lock` anywhere
 * close to that long; even `pull`'s network round-trip rarely exceeds a few
 * seconds. The MCP server's own staleness-drain cap (`staleDrainCapMs`,
 * mt#2701) treats 30s as the outer bound of patience for an in-flight tool
 * call before force-exiting the process. 10 minutes gives a wide (20x)
 * safety margin over that bound — comfortably distinguishing "still
 * legitimately running" from "abandoned" — while remaining two orders of
 * magnitude below the 22h incident value, so the tool stays useful for
 * near-real-time repair instead of requiring an overnight wait.
 */
export const LOCK_STALE_THRESHOLD_MS = 10 * 60 * 1000;

export interface IndexLockInfo {
  /** Absolute path to the index.lock file. */
  lockPath: string;
  /** Age of the lock file in milliseconds, from its mtime. */
  ageMs: number;
  /** Size of the lock file in bytes (0 for the classic abandoned case). */
  sizeBytes: number;
  /** Whether a live process currently holds/references the lock. */
  liveProcess: boolean;
  /** PID of the holding process, when determinable. */
  holderPid?: number;
  /**
   * Whether liveness was conclusively determined by at least one probe
   * (`lsof` or `ps`). When false, `liveProcess` is a conservative `false`
   * default that callers MUST NOT trust for repair decisions — see
   * `repairIndexLock`, which refuses to remove when this is false.
   */
  livenessDetermined: boolean;
  /** Which probe produced the liveness verdict. */
  livenessMethod: "lsof" | "ps" | "undetermined";
}

export interface LockRepairResult {
  lockPath: string;
  removed: boolean;
  reason: "removed" | "no-lock-present";
  ageMs?: number;
  sizeBytes?: number;
}

/** The classic git fatal for a held/abandoned index.lock. */
const INDEX_LOCK_ERROR_RE = /index\.lock['"]?:?\s*File exists/i;

/** Detect whether a git stderr blob is the classic index.lock contention error. */
export function isIndexLockError(stderr: string): boolean {
  return INDEX_LOCK_ERROR_RE.test(stderr);
}

/**
 * Resolve the actual `.git` directory for a repo path. Uses git itself
 * (`rev-parse --absolute-git-dir`) rather than assuming `<repo>/.git` so
 * this works uniformly for plain clones (main workspace, most session
 * workspaces) AND worktree/submodule layouts where `.git` is a file with
 * `gitdir: <path>` indirection.
 */
async function resolveGitDir(repoPath: string, deps: LockDependencies): Promise<string> {
  const qRepo = shellQuote(repoPath);
  const { stdout } = await deps.execAsync(`git -C ${qRepo} rev-parse --absolute-git-dir`);
  return stdout.trim();
}

/**
 * Determine whether a live process currently holds the lock file open.
 *
 * Primary signal: `lsof -t -- <lockfile>` reports a PID with an open file
 * descriptor on the lock — this is the strongest possible signal, since git
 * keeps the lockfile open for the duration of the write it's protecting.
 *
 * Secondary signal: any running `git` process whose command line references
 * this repo path — covers the narrow window between a process acquiring the
 * lock (via O_CREAT|O_EXCL, which happens first) and its first write.
 *
 * Fail-safe: if BOTH probes error out (e.g. neither `lsof` nor `ps` is on
 * PATH, or both are denied), liveness is reported `undetermined` — callers
 * must treat this as "cannot safely repair", not as "confirmed not live".
 */
async function checkLockLiveness(
  lockPath: string,
  repoPath: string,
  deps: LockDependencies
): Promise<{ live: boolean; pid?: number; method: "lsof" | "ps" | "undetermined" }> {
  let lsofRan = false;
  try {
    const { stdout } = await deps.execAsync(`lsof -t -- ${shellQuote(lockPath)}`);
    lsofRan = true;
    const pids = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => Number.parseInt(l, 10))
      .filter((n) => Number.isFinite(n));
    if (pids.length > 0) {
      return { live: true, pid: pids[0], method: "lsof" };
    }
  } catch {
    // lsof missing/denied/errored (including its normal "no match" non-zero
    // exit on some platforms) — fall through to the `ps` secondary probe.
    lsofRan = false;
  }

  try {
    const { stdout } = await deps.execAsync(`ps -A -o pid=,command=`);
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const match = /^(\d+)\s+(.*)$/.exec(trimmed);
      if (!match) continue;
      const pidStr = match[1] ?? "";
      const command = match[2] ?? "";
      if (command.includes("git") && command.includes(repoPath)) {
        return { live: true, pid: Number.parseInt(pidStr, 10), method: "ps" };
      }
    }
    // ps ran cleanly and found no matching git process. Combined with a
    // clean (even if inconclusive) lsof run above, this is a confident
    // "not live" verdict.
    return { live: false, method: "ps" };
  } catch {
    // ps also failed. If lsof at least ran cleanly (even with zero PIDs),
    // treat as a determined "not live" — lsof is the stronger of the two
    // signals. Otherwise neither probe answered: undetermined.
    return lsofRan ? { live: false, method: "lsof" } : { live: false, method: "undetermined" };
  }
}

/**
 * Detect a present `.git/index.lock` and report its age, size, and
 * owning-process liveness. Returns `null` when no lock is present.
 */
export async function detectIndexLock(
  options: { repoPath?: string },
  deps: LockDependencies
): Promise<IndexLockInfo | null> {
  const repoPath = options.repoPath ?? validateProcess(process).cwd();
  const gitDir = await resolveGitDir(repoPath, deps);
  const lockPath = join(gitDir, "index.lock");

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw err;
  }

  const ageMs = Date.now() - stats.mtimeMs;
  const liveness = await checkLockLiveness(lockPath, repoPath, deps);

  return {
    lockPath,
    ageMs,
    sizeBytes: stats.size,
    liveProcess: liveness.live,
    livenessDetermined: liveness.method !== "undetermined",
    holderPid: liveness.pid,
    livenessMethod: liveness.method,
  };
}

/** Human-readable diagnostic line for enriching a blocked git operation's error. */
export function formatLockDiagnostic(info: IndexLockInfo): string {
  const ageMinutes = (info.ageMs / 60_000).toFixed(1);
  const size = info.sizeBytes === 0 ? "zero-byte" : `${info.sizeBytes} bytes`;
  if (!info.livenessDetermined) {
    return (
      `${info.lockPath} is ${ageMinutes}m old, ${size} — owning-process liveness could not be ` +
      `determined (neither \`lsof\` nor \`ps\` answered conclusively).`
    );
  }
  if (info.liveProcess) {
    return `${info.lockPath} is ${ageMinutes}m old, ${size} — held by a LIVE process${
      info.holderPid ? ` (PID ${info.holderPid})` : ""
    }. Busy, not stale.`;
  }
  const thresholdMinutes = (LOCK_STALE_THRESHOLD_MS / 60_000).toFixed(0);
  const stale = info.ageMs >= LOCK_STALE_THRESHOLD_MS;
  return `${info.lockPath} is ${ageMinutes}m old, ${size} — no owning process detected ${
    stale
      ? `and age exceeds the ${thresholdMinutes}m staleness threshold: eligible for repair.`
      : `but age is below the ${thresholdMinutes}m staleness threshold: not yet eligible for repair.`
  }`;
}

/**
 * Repair a `.git/index.lock`: remove it ONLY when provably stale (no live
 * owning process AND age above `LOCK_STALE_THRESHOLD_MS`). Requires
 * `confirm: true` — never removes silently. Throws (does not silently
 * no-op) when the lock is held by a live process, or when liveness/age
 * can't confidently be classified as stale — a caller must never receive a
 * `{removed: false}` result while assuming removal happened.
 */
export async function repairIndexLock(
  options: { repoPath?: string; confirm: boolean },
  deps: LockDependencies
): Promise<LockRepairResult> {
  if (!options.confirm) {
    throw new Error(
      "git index.lock repair requires confirm: true. This inspects the lock's age and " +
        "owning-process liveness and ONLY removes it when provably stale (no live process AND " +
        "age above the staleness threshold). Call again with confirm: true to proceed, or " +
        "inspect first without confirm to see the diagnostic."
    );
  }

  const repoPath = options.repoPath ?? validateProcess(process).cwd();
  const info = await detectIndexLock({ repoPath }, deps);

  if (!info) {
    return { lockPath: "", removed: false, reason: "no-lock-present" };
  }

  if (!info.livenessDetermined) {
    throw new Error(
      `Cannot determine whether ${info.lockPath} is held by a live process (neither \`lsof\` ` +
        `nor \`ps\` gave a conclusive answer) — refusing to remove for safety. Verify manually ` +
        `before retrying.`
    );
  }

  if (info.liveProcess) {
    throw new Error(
      `${info.lockPath} is held by a live process${
        info.holderPid ? ` (PID ${info.holderPid})` : ""
      } — busy, not stale. Will not remove. Wait for the operation to finish, or investigate ` +
        `PID ${info.holderPid ?? "(unknown)"} if it appears wedged.`
    );
  }

  if (info.ageMs < LOCK_STALE_THRESHOLD_MS) {
    const ageMinutes = (info.ageMs / 60_000).toFixed(1);
    const thresholdMinutes = (LOCK_STALE_THRESHOLD_MS / 60_000).toFixed(0);
    throw new Error(
      `${info.lockPath} has no detected owning process but is only ${ageMinutes}m old ` +
        `(threshold: ${thresholdMinutes}m) — ambiguous, refusing to remove. If this lock is ` +
        `genuinely abandoned, retry once it has aged past the threshold, or verify manually.`
    );
  }

  await rm(info.lockPath, { force: false });

  return {
    lockPath: info.lockPath,
    removed: true,
    reason: "removed",
    ageMs: info.ageMs,
    sizeBytes: info.sizeBytes,
  };
}

export interface LockAwareExecOptions {
  repoPath?: string;
  /** When true, auto-repair a stale index.lock (confirm-gated internally) and retry once. */
  repairLock?: boolean;
}

/**
 * Execute a git command, catching the classic `index.lock: File exists`
 * failure and turning it into an actionable, diagnosis-enriched error — or,
 * when `repairLock: true`, attempting a confirm-gated repair-then-retry.
 *
 * Mirrors the pattern established by `pullImpl`'s conflict-file enrichment
 * (`./pull-operations.ts`): classify the specific stderr shape and throw a
 * structured, actionable error rather than relaying the raw git fatal.
 */
export async function runGitCommandWithLockHandling(
  command: string,
  deps: LockDependencies,
  options: LockAwareExecOptions
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await deps.execAsync(command);
  } catch (err: unknown) {
    const stderr =
      err !== null && typeof err === "object" && "stderr" in err
        ? String((err as { stderr: unknown }).stderr ?? "")
        : "";

    if (!isIndexLockError(stderr)) {
      throw err;
    }

    if (options.repairLock) {
      // repairIndexLock throws its own descriptive error when the lock is
      // busy or ambiguous — let that propagate unchanged.
      await repairIndexLock({ repoPath: options.repoPath, confirm: true }, deps);
      return await deps.execAsync(command);
    }

    const info = await detectIndexLock({ repoPath: options.repoPath }, deps);
    throw new Error(
      `Git operation blocked by index.lock.\n` +
        `${info ? formatLockDiagnostic(info) : "(lock disappeared between failure and diagnosis)"}\n\n` +
        `Pass \`repairLock: true\` to attempt an automatic repair (only removes the lock when ` +
        `provably stale: no live process AND age above threshold) and retry.`
    );
  }
}
