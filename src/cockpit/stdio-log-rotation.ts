/**
 * Stdio-redirect log rotation for the cockpit daemon (mt#3298).
 *
 * The daemon's raw stdout/stderr are captured to
 * `~/.local/state/minsky/logs/cockpit-{stdout,stderr}.log` by whichever
 * supervisor started it — the tray supervisor (`cockpit-tray/src-tauri/src/
 * supervisor.rs`'s `open_log()`, `.append(true)`) or the launchd plist
 * (`StandardOutPath`/`StandardErrorPath`, `./launchd.ts`). Both grew without
 * bound (6.2 GB by 2026-07-29) because nothing owned rotating them: the
 * structured `cockpit-daemon.log` rotates via winston (`./daemon-file-log.ts`),
 * but these two files are written by supervisor-owned fds the daemon merely
 * inherits.
 *
 * That inheritance is why this module uses copy-then-truncate (logrotate's
 * `copytruncate` pattern) instead of the rename-based rotation newsyslog(8)
 * and winston use: the daemon cannot reopen inherited fds 1/2, so a renamed
 * file would keep receiving every subsequent write forever. Both supervisors
 * open the files O_APPEND (verified live: `lsof +fg` shows the `AP` flag), so
 * truncating the live file cleanly resets the write position to 0. If a
 * future launch path opened without O_APPEND the mechanism degrades to a
 * sparse file whose real disk usage stays bounded at the cap — never to
 * unbounded growth. The documented copytruncate race (writes landing between
 * the copy and the truncate are lost) is accepted: at this cadence the window
 * is milliseconds of raw stdio, and `cockpit-daemon.log` is the primary
 * operational record.
 *
 * Runs as an interval sweep in the daemon itself (rather than in either
 * supervisor) so the policy holds for every launch path with one mechanism —
 * the same supervisor-agnostic placement mt#2894 chose for the structured
 * log. Filesystem-only: deliberately NOT gated on schema readiness (mt#3297).
 */
import fs from "fs";
import path from "path";
import { log } from "@minsky/shared/logger";
import { getDaemonLogDir } from "./daemon-file-log";
import { createIntervalSweeper, type SweepTickResult } from "./sweepers";

/**
 * Per-file size cap before rotation. Grounding (mt#3298 spec §Plan decision):
 * steady-state growth is single-digit MB/h (weeks per 50 MB); the worst
 * observed burst (mt#3297's migration-lag window, ~500 MB over a few hours)
 * keeps its most recent — diagnostically useful — hours within 50 MB.
 */
export const STDIO_LOG_MAX_BYTES = 50 * 1024 * 1024; // 50MB

/**
 * Rotated files retained per stream (`.1` newest, `.2` oldest). Worst case on
 * disk: (50 + 2x50) MB x 2 streams = 300 MB, matching the scale of
 * `daemon-file-log.ts`'s 20 MB x 5 winston retention.
 */
export const STDIO_LOG_ROTATIONS_RETAINED = 2;

/**
 * Sweep cadence. A stat() per minute is negligible; at the worst observed
 * burst rate (~3 MB/min) the overshoot past the cap between ticks stays
 * single-digit MB.
 */
export const STDIO_LOG_ROTATION_INTERVAL_MS = 60 * 1000;

/** The two supervisor-redirected stdio capture files this policy bounds. */
export const STDIO_LOG_FILE_NAMES = ["cockpit-stdout.log", "cockpit-stderr.log"] as const;

export interface StdioLogRotationLimits {
  maxBytes?: number;
  rotationsRetained?: number;
}

/**
 * Rotate one stdio log in place if it exceeds the cap: shift retained
 * rotations (`.1` -> `.2`, replacing the older file), drop any rotation
 * beyond the retention count, copy the live file's LAST `maxBytes` to `.1`,
 * then truncate the live file to zero. The live file is never renamed,
 * unlinked, or reopened — the supervisor-held fds keep pointing at it (see
 * module docblock for why).
 *
 * Only the tail is copied so a single rotation bounds the directory even
 * when the live file is far past the cap — the "oversized file left by a
 * previous run" boot case. A full copy would just move the unbounded bytes
 * into `.1` and retain them there forever, since no later tick re-examines
 * rotated files (PR #2387 R1 BLOCKING #2).
 *
 * Throws on copy/truncate failure (the caller's tick wraps per-file); an
 * absent file returns false rather than throwing, since a manually-started
 * daemon has no stdio redirect and may not have these files at all.
 *
 * @returns true when a rotation happened.
 */
export function rotateStdioLogIfOversized(
  filePath: string,
  limits?: StdioLogRotationLimits
): boolean {
  const maxBytes = limits?.maxBytes ?? STDIO_LOG_MAX_BYTES;
  const retained = limits?.rotationsRetained ?? STDIO_LOG_ROTATIONS_RETAINED;

  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;

  for (let i = retained; i >= 2; i--) {
    const src = `${filePath}.${i - 1}`;
    if (fs.existsSync(src)) {
      fs.renameSync(src, `${filePath}.${i}`);
    }
  }
  // Rotations beyond the retention count are stale — a lowered retention
  // setting, or the retained<=1 cases where the shift loop above never runs.
  for (let i = retained + 1; fs.existsSync(`${filePath}.${i}`); i++) {
    fs.rmSync(`${filePath}.${i}`);
  }

  if (retained >= 1) {
    copyTail(filePath, `${filePath}.1`, size, Math.min(size, maxBytes));
  }
  fs.truncateSync(filePath, 0);
  return true;
}

/**
 * Copy the last `tailBytes` of `src` (whose size was just stat'd as
 * `srcSize`) into `dest`, replacing it. Reads at explicit offsets so the
 * live writer's O_APPEND appends never move this reader's position.
 */
function copyTail(src: string, dest: string, srcSize: number, tailBytes: number): void {
  const srcFd = fs.openSync(src, "r");
  try {
    const destFd = fs.openSync(dest, "w");
    try {
      // Uint8Array rather than Buffer.alloc: the project's TS Buffer stub
      // (src/types/node.d.ts) only exposes Buffer.from.
      const chunk = new Uint8Array(1024 * 1024);
      let offset = srcSize - tailBytes;
      while (offset < srcSize) {
        const n = fs.readSync(srcFd, chunk, 0, Math.min(chunk.length, srcSize - offset), offset);
        if (n <= 0) break;
        fs.writeSync(destFd, chunk, 0, n);
        offset += n;
      }
    } finally {
      fs.closeSync(destFd);
    }
  } finally {
    fs.closeSync(srcFd);
  }
}

/**
 * Start the periodic stdio-log rotation sweep in this cockpit process.
 *
 * Runs one pass at boot (via createIntervalSweeper's boot tick), so an
 * oversized file left by a previous run is bounded immediately, then every
 * `intervalMs`. Fail-open per file: a failed rotation logs and waits for the
 * next tick — the sweep must never crash the cockpit.
 *
 * @returns stop function (clears the interval).
 */
export function startStdioLogRotationSweeper(
  intervalMs?: number,
  opts?: StdioLogRotationLimits & { logDir?: string }
): () => void {
  return createIntervalSweeper({
    name: "stdio-log rotation",
    intervalMs: intervalMs ?? STDIO_LOG_ROTATION_INTERVAL_MS,
    tick: async (): Promise<SweepTickResult> => {
      const logDir = opts?.logDir ?? getDaemonLogDir();
      // mt#4412: the per-file fail-open below is deliberate and stays — one
      // unrotatable file must not stop the others. But it also meant a sweep
      // that failed on EVERY file returned exactly like one that rotated
      // nothing because nothing was oversized, which is this sweep's normal
      // and healthy result. Counting the failures is what separates them.
      let failed = 0;
      for (const name of STDIO_LOG_FILE_NAMES) {
        const filePath = path.join(logDir, name);
        try {
          if (rotateStdioLogIfOversized(filePath, opts)) {
            log.info("cockpit: rotated oversized stdio log", { filePath });
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn("cockpit: stdio log rotation failed", { filePath, message });
          failed++;
        }
      }
      return { ok: failed === 0 };
    },
  });
}
