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
 * Narrowed `process` handle for `kill` (mt#4255).
 *
 * bun-types' resolved ambient `process` global doesn't expose `kill` in this
 * project's type resolution — the same ambiguity {@link killIfIdentityMatches}
 * documents inline below, and the same module-level const ./port-recovery.ts
 * already uses for its own `kill` calls.
 */
// eslint-disable-next-line custom/no-excessive-as-unknown -- process.kill side-channel, no alternative typing (mirrors ./port-recovery.ts precedent)
const proc = process as unknown as {
  kill(pid: number, signal?: NodeJS.Signals | number): boolean;
};

/**
 * Whether `pid` currently names a live process — THREE-valued, deliberately
 * (mt#4255).
 *
 * `signal 0` is the POSIX existence check: it performs the permission and
 * existence checks and delivers nothing. The three outcomes are genuinely
 * different facts, and collapsing them is what makes a sweep unsafe:
 *
 *  - `ESRCH` — the kernel says no such process. DECISIVE.
 *  - `EPERM` — the process exists but belongs to another user. Also decisive,
 *    in the other direction: it is `present`.
 *  - anything else — the probe itself could not answer. NOT the same as
 *    `absent`, and a caller that retires a record on it is retiring on its own
 *    malfunction.
 *
 * ./port-recovery.ts's `isProcessAlive` answers the same question with a
 * boolean because its caller only needs "may I take this port?" — where
 * "cannot tell" and "absent" lead to the same conservative move. This one is
 * separate rather than a refactor of that: widening its return type would
 * change a predicate three other call sites read as a boolean, for no benefit
 * to them.
 */
export type PidPresence = "present" | "absent" | "unknown";

export function readPidPresence(pid: number): PidPresence {
  if (!Number.isInteger(pid) || pid <= 0) return "absent";
  try {
    proc.kill(pid, 0);
    return "present";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "absent";
    if (code === "EPERM") return "present";
    return "unknown";
  }
}

/** What a probe learned about the process a persisted record recorded. */
export type ProcessIdentityVerdict =
  /** Alive, and its command line still matches what we recorded. */
  | "ours"
  /** Alive, but it is a DIFFERENT process — PID reuse. */
  | "not-ours"
  /** No such process. */
  | "gone"
  /** The probe could not answer. Callers MUST fail open on this. */
  | "unknown";

/** Test seams for {@link probeProcessIdentity}. */
export interface ProbeProcessIdentityDeps {
  execFileFn?: ExecFileFn;
  readPresence?: (pid: number) => PidPresence;
}

/**
 * Full four-way identity probe (mt#4255) — the read {@link verifyProcessIdentity}
 * collapses.
 *
 * That predicate answers one question ("may I kill this?") and returns `false`
 * for every reason not to, which is correct for a kill and wrong for a sweep:
 * "the process is gone" and "`ps` could not answer" are the same `false`, so a
 * caller retiring records on it would retire the whole table the first time
 * `ps` misbehaved.
 *
 * Presence is established FIRST, and that ordering is what makes the rest
 * unambiguous: once the kernel has confirmed the PID exists, a command line we
 * then fail to read is a failure of OUR probe, never evidence about the
 * process — so it resolves to `unknown` rather than to a verdict. Without that
 * ordering the same empty read would have to be disambiguated from `ps`'s exit
 * status, which varies by platform.
 *
 * `expectedCmdSubstring` follows the same convention as the sibling functions:
 * callers pass the full persisted command line when they have one and fall
 * back to the bare binary name.
 */
export async function probeProcessIdentity(
  pid: number,
  expectedCmdSubstring: string,
  deps: ProbeProcessIdentityDeps = {}
): Promise<ProcessIdentityVerdict> {
  const presence = (deps.readPresence ?? readPidPresence)(pid);
  if (presence === "absent") return "gone";
  if (presence === "unknown") return "unknown";

  const cmdline = await readProcessCommandLine(pid, deps.execFileFn ?? prodExecFile);
  if (cmdline === null) return "unknown";
  return cmdline.includes(expectedCmdSubstring) ? "ours" : "not-ours";
}

/**
 * Verify `pid` is (a) still alive AND (b) its live command line contains
 * `expectedCmdSubstring` — the practical substring every caller in this
 * codebase passes is the binary name (`"claude"`), rather than a full argv
 * match, which would be brittle against argument reordering across CLI
 * versions. Never throws; a lookup failure resolves to `false`.
 *
 * Deliberately NOT re-expressed on {@link probeProcessIdentity} (mt#4255):
 * its `false` is load-bearing for the kill path — every reason not to kill
 * must produce it — and routing through the richer probe would add a
 * `kill(pid, 0)` syscall to that path while changing nothing its callers can
 * observe.
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
