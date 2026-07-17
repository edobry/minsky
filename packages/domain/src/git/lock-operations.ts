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
  /**
   * The staleness threshold (ms) used for THIS diagnosis — `LOCK_STALE_THRESHOLD_MS`
   * unless overridden via `options.staleThresholdMs` (PR #1986 R1: surfaced
   * for configurability rather than hardcoding the module default at every
   * comparison site).
   */
  staleThresholdMs: number;
  /**
   * Raw mtime (ms since epoch) at detection time. Paired with `inode`/
   * `device` as the file's identity snapshot — `repairIndexLock`'s
   * pre-unlink TOCTOU guard (mt#2820 PR #1986 R1) re-stats the lock
   * immediately before removal and aborts if ANY of these three differ,
   * since that means the file at this path is no longer the one that was
   * diagnosed as stale (e.g. a legitimate process removed the abandoned
   * lock and acquired a fresh one at the same path in the interim).
   */
  mtimeMs: number;
  /** Inode number at detection time — see `mtimeMs` doc for how this is used. */
  inode: number;
  /** Device id at detection time — paired with `inode` for a unique file identity. */
  device: number;
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
 * Primary (and ONLY negative-determining) signal: `lsof -t -- <lockfile>`
 * inspects the LOCK FILE'S OWN open file descriptors. This is authoritative
 * for "not live": a process actively holding this exact lock necessarily has
 * an open fd on it (git keeps the lockfile open for the duration of the
 * write it's protecting), so a clean `lsof` run that finds zero holders is
 * itself a confident, self-sufficient "not live" verdict.
 *
 * Secondary signal: any running `git` process whose command line references
 * this repo path — intended to catch the narrow window between a process
 * acquiring the lock (via O_CREAT|O_EXCL, which happens first) and its first
 * write. This is POSITIVE-ONLY: a match adds an extra "live" signal (a false
 * positive here just fails safe, toward not deleting), but the ABSENCE of a
 * match is NEVER used to confirm "not live" on its own (mt#2820 PR #1986
 * R1). Command-line substring matching is unreliable — a git process
 * launched with a relative path, or already cwd'd into the repo with no
 * `-C <path>` argument at all, produces a cmdline with NO textual reference
 * to `repoPath`, making a real live process invisible to this probe. Only
 * `lsof`'s direct fd inspection is trusted to declare "not live"; `ps`
 * degrades gracefully to "no additional signal", never to "confirmed clear".
 *
 * Fail-safe: if `lsof` itself doesn't run cleanly (missing, denied, or
 * erroring) — regardless of what `ps` finds or doesn't find — liveness is
 * reported `undetermined`. Callers must treat this as "cannot safely
 * repair", not as "confirmed not live".
 */
async function checkLockLiveness(
  lockPath: string,
  repoPath: string,
  deps: LockDependencies
): Promise<{ live: boolean; pid?: number; method: "lsof" | "ps" | "undetermined" }> {
  let lsofRanCleanly = false;
  try {
    const { stdout } = await deps.execAsync(`lsof -t -- ${shellQuote(lockPath)}`);
    lsofRanCleanly = true;
    const pids = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => Number.parseInt(l, 10))
      .filter((n) => Number.isFinite(n));
    if (pids.length > 0) {
      return { live: true, pid: pids[0], method: "lsof" };
    }
    // lsof ran cleanly, zero holders on THIS exact file — proceed to the ps
    // probe purely for its additional positive-signal value (see doc above);
    // its outcome cannot downgrade this clean-empty lsof result.
  } catch (err) {
    // lsof's OWN convention (verified empirically, macOS lsof 4.91) is to
    // exit non-zero with EMPTY stdout AND stderr when it simply finds no
    // matching open file descriptors — the same "no match" shape as `grep`.
    // Node's `exec()` rejects on ANY non-zero exit regardless of this
    // convention, so that clean "found nothing" case lands in this catch
    // block indistinguishably from a REAL failure unless we look at what
    // lsof actually emitted. A genuine failure always emits diagnostic text
    // (confirmed: missing binary -> exit 127 + "command not found" on
    // stderr; a malformed invocation or status error -> a message on
    // stderr) — so empty stdout AND empty stderr is the reliable signal
    // that this was a clean "zero holders" run, not a failure.
    const execErr = err as { stdout?: unknown; stderr?: unknown };
    const stdoutText = typeof execErr.stdout === "string" ? execErr.stdout : "";
    const stderrText = typeof execErr.stderr === "string" ? execErr.stderr : "";
    lsofRanCleanly = stdoutText.trim() === "" && stderrText.trim() === "";
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
  } catch {
    // ps failing changes nothing here — it was never trusted to establish a
    // negative verdict on its own; fall through to the lsof-gated verdict.
  }

  // Final verdict: "not live" is determined ONLY when lsof itself ran
  // cleanly and found no holder on this exact file. ps's clean-but-no-match
  // outcome is corroborating context, never the basis for the verdict —
  // per the unreliability of cmdline substring matching documented above.
  return lsofRanCleanly ? { live: false, method: "lsof" } : { live: false, method: "undetermined" };
}

/**
 * Detect a present `.git/index.lock` and report its age, size, and
 * owning-process liveness. Returns `null` when no lock is present.
 *
 * `staleThresholdMs` overrides `LOCK_STALE_THRESHOLD_MS` for this diagnosis
 * (PR #1986 R1) — an operator running Minsky against a repo/host where
 * legitimate operations routinely take longer (or shorter) than the 10-minute
 * default may need a different bound; the default remains the
 * incident-grounded value documented on `LOCK_STALE_THRESHOLD_MS`.
 */
export async function detectIndexLock(
  options: { repoPath?: string; staleThresholdMs?: number },
  deps: LockDependencies
): Promise<IndexLockInfo | null> {
  const repoPath = options.repoPath ?? validateProcess(process).cwd();
  const staleThresholdMs = options.staleThresholdMs ?? LOCK_STALE_THRESHOLD_MS;
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
    staleThresholdMs,
    mtimeMs: stats.mtimeMs,
    inode: stats.ino,
    device: stats.dev,
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
  const thresholdMinutes = (info.staleThresholdMs / 60_000).toFixed(0);
  const stale = info.ageMs >= info.staleThresholdMs;
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
  options: { repoPath?: string; confirm: boolean; staleThresholdMs?: number },
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
  const info = await detectIndexLock(
    { repoPath, staleThresholdMs: options.staleThresholdMs },
    deps
  );

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

  if (info.ageMs < info.staleThresholdMs) {
    const ageMinutes = (info.ageMs / 60_000).toFixed(1);
    const thresholdMinutes = (info.staleThresholdMs / 60_000).toFixed(0);
    throw new Error(
      `${info.lockPath} has no detected owning process but is only ${ageMinutes}m old ` +
        `(threshold: ${thresholdMinutes}m) — ambiguous, refusing to remove. If this lock is ` +
        `genuinely abandoned, retry once it has aged past the threshold, or verify manually.`
    );
  }

  // TOCTOU guard (mt#2820 PR #1986 R1): everything above is a SNAPSHOT taken
  // at `info`'s detection time. Between then and the unlink below, a
  // legitimate process could have removed the abandoned lock and acquired a
  // fresh one at the same path (e.g. the original owner finally exited
  // cleanly and a new operation started immediately after), or a process
  // could now hold the still-same lock open. Re-verify BOTH the file's
  // identity (has it been replaced?) and its liveness (is it held now?)
  // immediately before removal, and abort on ANY change rather than trusting
  // the earlier snapshot.
  let finalStats: Awaited<ReturnType<typeof stat>>;
  try {
    finalStats = await stat(info.lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      // The lock disappeared on its own between detection and repair (e.g.
      // the owning process finished and cleaned up, or a concurrent repair
      // attempt already removed it) — nothing left to do, not an error.
      return { lockPath: info.lockPath, removed: false, reason: "no-lock-present" };
    }
    throw err;
  }

  if (finalStats.ino !== info.inode || finalStats.dev !== info.device) {
    throw new Error(
      `${info.lockPath} was replaced between detection and repair (inode changed from ` +
        `${info.inode} to ${finalStats.ino}) — a different process may have legitimately ` +
        `acquired a new lock at this path since diagnosis. Aborting removal; re-diagnose ` +
        `before retrying.`
    );
  }

  // Secondary signal, checked after the primary inode/device identity check
  // above: even a same-inode file (an in-place rewrite, or a filesystem —
  // e.g. some tmpfs configurations — that reuses a just-freed inode number
  // faster than this window) can still show a changed mtime or size if a
  // process wrote to it. Either differing is grounds to abort.
  if (finalStats.mtimeMs !== info.mtimeMs || finalStats.size !== info.sizeBytes) {
    throw new Error(
      `${info.lockPath} was modified between detection and repair (mtime ${info.mtimeMs} -> ` +
        `${finalStats.mtimeMs}, size ${info.sizeBytes} -> ${finalStats.size}) — a process may be ` +
        `actively writing to it. Aborting removal; re-diagnose before retrying.`
    );
  }

  const finalLiveness = await checkLockLiveness(info.lockPath, repoPath, deps);
  if (finalLiveness.method === "undetermined") {
    throw new Error(
      `Cannot re-confirm ${info.lockPath}'s liveness immediately before removal (neither ` +
        `\`lsof\` nor \`ps\` gave a conclusive answer on the final check) — aborting for safety.`
    );
  }
  if (finalLiveness.live) {
    throw new Error(
      `${info.lockPath} is now held by a live process${
        finalLiveness.pid ? ` (PID ${finalLiveness.pid})` : ""
      } — acquired between detection and repair. Aborting removal.`
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
  /** Overrides `LOCK_STALE_THRESHOLD_MS` for this call — see `detectIndexLock`. */
  staleThresholdMs?: number;
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
      await repairIndexLock(
        {
          repoPath: options.repoPath,
          confirm: true,
          staleThresholdMs: options.staleThresholdMs,
        },
        deps
      );
      return await deps.execAsync(command);
    }

    const info = await detectIndexLock(
      { repoPath: options.repoPath, staleThresholdMs: options.staleThresholdMs },
      deps
    );
    throw new Error(
      `Git operation blocked by index.lock.\n` +
        `${info ? formatLockDiagnostic(info) : "(lock disappeared between failure and diagnosis)"}\n\n` +
        `Pass \`repairLock: true\` to attempt an automatic repair (only removes the lock when ` +
        `provably stale: no live process AND age above threshold) and retry.`
    );
  }
}
