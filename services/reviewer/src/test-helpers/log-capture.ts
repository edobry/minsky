/**
 * Shared test helpers for capturing log output emitted via the reviewer-local
 * winston logger (`./logger`).
 *
 * Winston's Console transport writes to `process.stdout.write` directly,
 * bypassing the standard `console` global. Tests that previously intercepted
 * the standard logger to capture production output must instead intercept at
 * the stream level so the winston path is captured.
 *
 * This module factors out the helper originally inlined in `server.test.ts`
 * (mt#1255) so tests across the reviewer service share one canonical capture
 * pattern.
 */

export interface CapturedLogs {
  logs: string[];
  restore: () => void;
}

/**
 * Capture lines written to `process.stdout` for the duration of a test.
 *
 * Returns the captured lines (one per emitted log line, trimmed) and a
 * `restore()` function the caller MUST invoke in a `finally` block to
 * reinstate the original `process.stdout.write`.
 *
 * Each chunk written to stdout is split on newlines; blank lines are
 * dropped. Lines are NOT parsed — callers that need structured access
 * should pass each line to `JSON.parse` (winston emits one JSON object
 * per line in STRUCTURED mode).
 */
export function captureConsoleLogs(): CapturedLogs {
  const logs: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);

  // Node's overloaded WriteStream.write signatures use `Error | undefined`
  // for the callback err parameter. Must match exactly (not `Error | null`)
  // or TS rejects the assignment with TS2322 — see PR #1017 CI fix from
  // mt#1255.
  process.stdout.write = (
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    cb?: (err?: Error) => void
  ): boolean => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) logs.push(trimmed);
    }
    if (typeof encodingOrCb === "function") {
      return originalWrite(chunk, encodingOrCb);
    }
    if (cb !== undefined) {
      return originalWrite(chunk, encodingOrCb as BufferEncoding, cb);
    }
    if (encodingOrCb !== undefined) {
      return originalWrite(chunk, encodingOrCb as BufferEncoding);
    }
    return originalWrite(chunk);
  };

  return {
    logs,
    restore: () => {
      process.stdout.write = originalWrite;
    },
  };
}

/**
 * Replace `process.stdout.write` with a no-op for the lifetime of the
 * returned handle. Tests that do not need to assert on emitted log lines but
 * want to keep `bun test` output clean (the reviewer-local winston logger
 * routes everything through stdout) call this in `beforeEach` and invoke the
 * returned `restore()` in `afterEach`.
 *
 * Differs from `captureConsoleLogs()` in two ways: nothing is buffered, and
 * the original write is NOT called — output is dropped on the floor.
 */
export function silenceConsoleLogs(): { restore: () => void } {
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((
    _chunk: string | Uint8Array,
    _encodingOrCb?: BufferEncoding | ((err?: Error) => void),
    _cb?: (err?: Error) => void
  ): boolean => {
    return true;
  }) as typeof process.stdout.write;
  return {
    restore: () => {
      process.stdout.write = originalWrite;
    },
  };
}

/**
 * Parse captured log lines as JSON and return the first object whose `event`
 * field matches `eventName`. Returns `null` when no matching event is found.
 */
export function findLogEvent(logs: string[], eventName: string): Record<string, unknown> | null {
  for (const line of logs) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed["event"] === eventName) return parsed;
    } catch {
      // Not JSON — skip.
    }
  }
  return null;
}
