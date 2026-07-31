/**
 * Synchronous stdout/stderr writes for one-shot CLI invocations (mt#3067).
 *
 * ## The bug this fixes
 *
 * `src/cli.ts`'s `main()` ends with an explicit `exit(0)` (a documented
 * workaround for un-torn-down resources). When stdout is a **pipe**, Node/Bun
 * stream writes are asynchronous and buffered — so `process.exit()` terminates
 * the process while output is still queued, silently discarding the tail.
 * Writes to a **file** are synchronous and were never affected, which is why
 * the same command produced valid JSON via `> out.json` and truncated JSON via
 * `| jq`.
 *
 * Measured before the fix (Bun on macOS, 1 MiB payload, exit immediately after
 * write): a pipe received 65,536 bytes; a file received all 1,048,576. Real
 * commands truncated at 192 KiB / 256 KiB, and the cut point VARIED BETWEEN
 * RUNS on identical input — the signature of a drain race rather than corrupt
 * content.
 *
 * The truncation OFFSET is platform-dependent: macOS cuts on exact 64 KiB
 * buffer boundaries; Linux CI cuts at an arbitrary offset. Only the data loss
 * itself reproduces on both, so that is what the regression test asserts.
 *
 * ## Why this approach, and what does NOT work
 *
 * Routing writes through `fs.writeSync` makes them complete before `write()`
 * returns, so a subsequent `process.exit()` has nothing left to discard. Three
 * more obvious fixes were measured and REJECTED (do not "simplify" this back
 * into one of them):
 *
 *   - `await new Promise(r => process.stdout.write("", r))` before exiting —
 *     still truncates. The write callback fires before the pipe drains.
 *   - Polling `process.stdout.writableLength` to zero — still truncates. The
 *     pending bytes are not reflected there.
 *   - `await setTimeout(...)` before exiting — a RACE, not a fix. A 0 ms tick
 *     produced a partial 589,824 bytes; longer sleeps only widen the window
 *     and would still lose data on a larger payload or a slower consumer.
 *
 * `process.stdout._handle.setBlocking(true)` (the Node-native approach) is
 * unavailable: Bun does not expose `_handle`.
 *
 * ## Scope
 *
 * Applied only to one-shot CLI commands, via the `preAction` hook in
 * `src/cli.ts`. Long-lived server modes (`mcp start`, `cockpit`,
 * `completion-server`) are deliberately EXCLUDED: they do not exit immediately
 * after writing, so they never hit this bug, and synchronous writes would block
 * their event loop under log volume.
 *
 * @see mt#3067 — this module's tracking task
 * @see src/cli.ts — the `exit(0)` that makes async buffering lossy
 */

import { writeSync } from "node:fs";

/** Streams this module knows how to patch, with their POSIX file descriptors. */
type PatchTarget = { name: "stdout" | "stderr"; fd: number };

const PATCH_TARGETS: PatchTarget[] = [
  { name: "stdout", fd: 1 },
  { name: "stderr", fd: 2 },
];

type WriteFn = (
  chunk: string | Uint8Array,
  encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
  cb?: (err?: Error | null) => void
) => boolean;

/**
 * Identity set of `write` functions this module installed. A WeakSet keeps the
 * check off the function object itself — stamping a marker property would need
 * casts through `unknown` on every read and write of it.
 */
const patchedWrites = new WeakSet<object>();

/** True when `stream.write` has already been replaced by this module. */
function isPatched(write: unknown): boolean {
  return typeof write === "function" && patchedWrites.has(write as object);
}

/**
 * Make `process.stdout` and `process.stderr` write synchronously, so a
 * subsequent `process.exit()` cannot discard buffered output.
 *
 * Idempotent — calling it twice patches nothing the second time. Safe to call
 * before any output has been produced; safe to call when stdout is a TTY or a
 * file (those were never lossy, and a synchronous write is still correct).
 */
export function enableSynchronousStdout(): void {
  for (const target of PATCH_TARGETS) {
    const stream = process[target.name];
    if (!stream || isPatched(stream.write)) continue;

    const original = stream.write.bind(stream) as WriteFn;

    const patched: WriteFn = function patchedWrite(chunk, encodingOrCb, cb) {
      const callback = typeof encodingOrCb === "function" ? encodingOrCb : cb;
      const encoding: BufferEncoding = typeof encodingOrCb === "string" ? encodingOrCb : "utf8";

      const buf: Uint8Array = typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk;

      // `written` MUST stay in scope for the catch below: on a partial write we
      // have already emitted `written` bytes to the fd, so any fallback must
      // send only the REMAINDER. Re-sending the whole chunk would duplicate
      // those bytes — silent corruption, and worse than the truncation this
      // module exists to fix.
      let written = 0;
      try {
        while (written < buf.length) {
          try {
            // `writeSync` may return a short count (a partial write) and may
            // throw EAGAIN when a non-blocking pipe's buffer is momentarily
            // full — neither is an error, both just mean "call again".
            written += writeSync(target.fd, buf, written, buf.length - written);
          } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code === "EAGAIN") continue;
            throw err;
          }
        }
        callback?.();
        return true;
      } catch (err) {
        // EPIPE is normal and expected: the reader closed early (`| head`).
        // Swallow it exactly as a stream would, rather than crashing the CLI.
        if ((err as NodeJS.ErrnoException)?.code === "EPIPE") {
          callback?.();
          return true;
        }
        // Anything else (a closed fd, an unexpected errno): degrade to the
        // original async stream write rather than throwing — but only for the
        // bytes that have NOT already reached the fd.
        if (written > 0) {
          return original(buf.subarray(written), cb);
        }
        return original(chunk, encodingOrCb, cb);
      }
    };

    patchedWrites.add(patched);
    stream.write = patched as typeof stream.write;
  }
}

/** Test seam: true when both standard streams carry this module's patch. */
export function isSynchronousStdoutEnabled(): boolean {
  return PATCH_TARGETS.every((t) => isPatched(process[t.name]?.write));
}
