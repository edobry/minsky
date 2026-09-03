/**
 * Spawn-cwd preflight (mt#3397), moved out of driven-session-host.ts verbatim
 * (mt#4934) — checking whether a driven session's target workspace directory
 * still exists before spawning (or respawning) a session driver into it.
 *
 * Generic filesystem-precondition logic, not stream-json wire format —
 * factored out of ./claude-transport.ts as its own module so that file stays
 * under the 400-line warning while keeping this concern (which any
 * CLI-spawning transport would need, not just the Claude one) separately
 * readable.
 *
 * @see mt#4934 — this split
 * @see ./claude-transport.ts — the transport that calls this
 */

import { statSync } from "fs";
import { stat } from "fs/promises";
import { log } from "@minsky/shared/logger";

/**
 * Verdict of {@link probeSpawnCwd}. Deliberately THREE-valued: `"unknown"` is
 * not merged into `"missing"`, because the two carry opposite consequences —
 * `"missing"` retires a conversation permanently, `"unknown"` must not.
 */
export type CwdProbeResult = "present" | "missing" | "unknown";

/**
 * Check whether a spawn cwd is a directory that exists.
 *
 * Why this exists: Node reports a missing `options.cwd` as an `ENOENT` naming
 * the COMMAND — `ENOENT: no such file or directory, posix_spawn 'claude'` —
 * indistinguishable from the binary being absent from PATH. Node documents this
 * and deliberately declined to pre-validate the cwd itself (nodejs/node#11520
 * → doc-only PR nodejs/node#34505), leaving the check to the caller. This is
 * that caller-side check.
 *
 * `"unknown"` (a permission error, an I/O error, an unresponsive network mount)
 * fails OPEN — the caller spawns anyway and lets the real error surface. Only a
 * definitive ENOENT/ENOTDIR, or a path that exists but is not a directory,
 * returns `"missing"`, because `"missing"` is what marks a conversation
 * unrecoverable FOREVER. A transiently unreadable workspace must never retire a
 * conversation the principal may still want.
 */
export function probeSpawnCwd(cwd: string): CwdProbeResult {
  try {
    return classifyCwdStat(statSync(cwd).isDirectory());
  } catch (err) {
    return classifyCwdProbeError(err, cwd);
  }
}

/**
 * Async twin of {@link probeSpawnCwd}, for callers that are already async.
 *
 * A synchronous `statSync` on a boot-time reconciliation loop over every
 * non-terminal row can stall the daemon's event loop for as long as the
 * slowest path takes to answer — unbounded on an unresponsive network mount.
 * The transport's own spawn paths keep the sync probe deliberately: they are
 * synchronous by contract and about to block on `spawn` anyway, so making
 * them async would ripple through every caller to remove a stat that
 * immediately precedes a process launch. The loops get this one instead.
 */
export async function probeSpawnCwdAsync(cwd: string): Promise<CwdProbeResult> {
  try {
    const stats = await stat(cwd);
    return classifyCwdStat(stats.isDirectory());
  } catch (err) {
    return classifyCwdProbeError(err, cwd);
  }
}

function classifyCwdStat(isDirectory: boolean): CwdProbeResult {
  return isDirectory ? "present" : "missing";
}

/**
 * Shared error classification for both probes.
 *
 * The `"unknown"` branch logs at WARN: failing open is the right behavior,
 * but doing it silently means an operator seeing a session stuck in
 * `reconnecting` has no way to find out that the probe could not read the
 * workspace. The errno is the diagnostic — EACCES reads very differently from
 * EIO or a hung mount's ETIMEDOUT.
 */
function classifyCwdProbeError(err: unknown, cwd: string): CwdProbeResult {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  log.warn(
    `[driven-session] could not determine whether ${cwd} exists (${code ?? "no errno"}) — ` +
      `treating it as possibly-present so the conversation is not retired on a transient fault`
  );
  return "unknown";
}

/**
 * The `unrecoverableReason` for a session whose workspace is gone.
 *
 * Deliberately says the WORKSPACE is gone, not that the work is: a driven
 * session's conversation lives in the harness's own on-disk transcript, which
 * survives both the session driver's death and the workspace's deletion (memory
 * mem#669 — "the process died" is NOT "the work is gone"). What is lost is the
 * ability to RESUME in place: `claude --resume` needs the original cwd, both to
 * run in and because the harness keys its transcript directory off that path.
 */
export function missingCwdReason(cwd: string): string {
  return (
    `deleted cwd — the workspace directory ${cwd} no longer exists, so this conversation ` +
    `cannot be resumed in place (its transcript is unaffected)`
  );
}
