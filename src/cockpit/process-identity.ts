/**
 * Process-identity verification for driven-session orphan cleanup (mt#3038,
 * RFC "Conversation-first drive" R1 expert-review delta #4 — BINDING).
 *
 * A persisted `DrivenSessionRecord`'s `pid` may refer to a process from a
 * PRIOR daemon lifetime — the daemon that recorded it may have restarted (or
 * crashed) hours or days ago. Over that gap the OS is free to reuse the same
 * PID number for a completely unrelated process. Killing by bare `pid` alone
 * (`process.kill(pid, signal)`) is therefore unsafe: it risks terminating
 * whatever unrelated process now happens to hold that number.
 *
 * This module verifies IDENTITY before killing: read the LIVE command line
 * at that PID via `ps` and confirm it still looks like the `claude`
 * driven-session child we recorded, before ever calling `process.kill`.
 * "Cannot confirm" (process doesn't exist, `ps` failed, command line doesn't
 * match) always resolves to the SAFE branch — refuse to kill — never to a
 * bare kill.
 *
 * Test seam: `execFileFn` — injectable so tests never shell out to a real
 * `ps` or touch a real process (mirrors the `spawnFn` injection convention in
 * ./driven-session-host.ts).
 *
 * @see mt#3038 — this module
 * @see ./driven-session-host.ts — the registry this backs
 * @see packages/domain/src/transcripts/driven-session-registry-store.ts — persists the pid/cmdline pair this verifies against
 */

import { execFile as nodeExecFile } from "child_process";
import { log } from "@minsky/shared/logger";

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export type ExecFileFn = (command: string, args: string[]) => Promise<ExecFileResult>;

/** Production default — the only place this module shells out to a real `ps`. */
const prodExecFile: ExecFileFn = (command, args) =>
  new Promise((resolve, reject) => {
    nodeExecFile(command, args, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });

/**
 * Read the live command line for `pid` via `ps -p <pid> -o command=`.
 * Returns `null` if the process doesn't exist (non-zero exit — `ps` reports
 * "no such process" this way, not via stderr text we could parse portably)
 * or the read otherwise fails. Callers MUST treat `null` as "cannot confirm
 * identity" and refuse to kill.
 */
export async function readProcessCommandLine(
  pid: number,
  execFileFn: ExecFileFn = prodExecFile
): Promise<string | null> {
  try {
    const { stdout } = await execFileFn("ps", ["-p", String(pid), "-o", "command="]);
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Verify `pid` is (a) still alive AND (b) its live command line contains
 * `expectedCmdSubstring` — the practical substring every caller in this
 * codebase passes is the binary name (`"claude"`), rather than a full argv
 * match, which would be brittle against argument reordering across CLI
 * versions. Never throws; a lookup failure resolves to `false`.
 */
export async function verifyProcessIdentity(
  pid: number,
  expectedCmdSubstring: string,
  execFileFn: ExecFileFn = prodExecFile
): Promise<boolean> {
  const cmdline = await readProcessCommandLine(pid, execFileFn);
  return cmdline !== null && cmdline.includes(expectedCmdSubstring);
}

/**
 * Kill `pid` ONLY after confirming its live command line still matches
 * `expectedCmdSubstring`. This is the ONLY sanctioned way this codebase kills
 * a driven-session orphan PID recorded from a persisted record — never a
 * bare `process.kill(pid)` (R1 delta #4). Returns whether a kill was actually
 * issued (`false` covers both "identity didn't match" and "kill() itself
 * failed", e.g. the process exited between the `ps` read and the kill call —
 * both are equally "no cleanup needed/possible" from the caller's view).
 */
export async function killIfIdentityMatches(
  pid: number,
  expectedCmdSubstring: string,
  signal: NodeJS.Signals = "SIGTERM",
  execFileFn: ExecFileFn = prodExecFile
): Promise<boolean> {
  const matches = await verifyProcessIdentity(pid, expectedCmdSubstring, execFileFn);
  if (!matches) {
    log.warn(
      `[process-identity] refusing to kill pid ${pid} — live command line no longer matches ` +
        `expected substring "${expectedCmdSubstring}" (likely PID reuse after a daemon-idle gap; skipping)`
    );
    return false;
  }
  try {
    // bun-types' resolved ambient `process` global doesn't expose `kill` in
    // this project's type resolution (the same bun-types/@types/node
    // ambiguity documented in ./driven-session-host.ts's `chunkToString`
    // comment) — Node's runtime `process.kill` exists regardless; this
    // narrows just enough to call it.
    // eslint-disable-next-line custom/no-excessive-as-unknown -- process.kill side-channel, no alternative typing (mirrors driven-session-host.ts precedent)
    (process as unknown as { kill(pid: number, signal?: NodeJS.Signals | number): boolean }).kill(
      pid,
      signal
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[process-identity] kill(${pid}, ${signal}) failed: ${message}`);
    return false;
  }
}
