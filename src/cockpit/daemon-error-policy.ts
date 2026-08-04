/**
 * Policy for errors that reach the cockpit daemon's process-level handlers.
 *
 * Two concerns live here, both extracted from `start-command.ts`'s
 * `uncaughtException` handler (mt#3626):
 *
 * 1. **What gets logged.** The handler used to write `err.message` alone, so a
 *    crash left no frame, no error code, and no cause behind. Diagnosing one
 *    such line (mt#3534) required disassembling the runtime's bundled
 *    `node:net` out of the Bun binary.
 * 2. **Whether the process dies.** The handler used to `process.exit(1)` on
 *    every uncaught exception. A transient outbound-connection failure inside
 *    the RUNTIME's own net module is not a defect in daemon state, and killing
 *    the process for one drops every in-flight page load, SSE stream, and
 *    driven-session websocket.
 *
 * ADR-014 already sets the policy this extends: supervisor restart is reserved
 * for "genuinely fatal crashes", and the sibling `unhandledRejection` handler
 * has degraded-in-place for DB errors since gh#1761 rather than exiting.
 */
import { safeTruncate } from "../utils/safe-truncate";

/**
 * Error codes for connection attempts that failed for reasons outside this
 * process — the peer, the route, or the name service. None of them indicate
 * corrupt daemon state, so none of them warrant killing a process that is
 * serving live clients.
 */
const TRANSIENT_CONNECT_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ERR_SOCKET_CLOSED",
]);

/**
 * Runtime-internal module specifiers. A throw whose ORIGINATING frame (see
 * `originatingFrame`) sits in one of these came from the runtime's own socket
 * machinery rather than from Minsky code.
 *
 * Deliberately matched at the originating frame only. Matching anywhere in the
 * stack would also swallow genuine Minsky bugs, since any error raised inside a
 * socket callback carries these frames further down.
 */
const RUNTIME_SOCKET_MODULES = ["node:net", "node:tls", "node:dns", "node:_http_client"];

/** Guards `formatErrorForLog` against a cyclic `cause` chain. */
const MAX_CAUSE_DEPTH = 4;

/** Caps the survived-error signature table so a varying message cannot grow it without bound. */
const MAX_TRACKED_SIGNATURES = 200;

/** Caps one signature's length, so a long message cannot bloat the table's keys. */
const MAX_SIGNATURE_CHARS = 200;

function readCode(reason: object): string | undefined {
  if (!("code" in reason)) return undefined;
  const code = (reason as { code: unknown }).code;
  return code === undefined || code === null ? undefined : String(code);
}

/**
 * Runtime error-construction frames that sit ABOVE the frame that actually
 * failed, and so must be skipped when asking "where did this originate?".
 *
 * Verified against a real Bun 1.2.21 ECONNREFUSED, whose stack is:
 *
 *   Error: connect ECONNREFUSED 127.0.0.1:1
 *       at new ExceptionWithHostPort (internal:shared:42:10)
 *       at afterConnect (node:net:1172:39)
 *
 * Testing the literal top frame would read `internal:shared` and miss the
 * `node:net` origin one line below it.
 */
const RUNTIME_INTERNAL_FRAME_PREFIXES = ["internal:"];

/**
 * Returns the frame a throw actually originated in — the topmost `at …` frame
 * that is not one of the runtime's own error-construction helpers — or
 * `undefined` when the stack has no frames (the message-only case Bun produces
 * for some builtin throws).
 */
export function originatingFrame(stack: string | undefined): string | undefined {
  if (stack === undefined) return undefined;
  for (const line of stack.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("at ")) continue;
    if (RUNTIME_INTERNAL_FRAME_PREFIXES.some((prefix) => trimmed.includes(`(${prefix}`))) continue;
    return trimmed;
  }
  return undefined;
}

/**
 * True when `reason` is a failed outbound connection attempt rather than a
 * defect in this process.
 *
 * Matches on either signal:
 *   - a transient network error `code` (see `TRANSIENT_CONNECT_ERROR_CODES`), or
 *   - a throw whose originating frame is inside a runtime socket module.
 *
 * The second signal is what covers the mt#3534 class. That crash surfaces as a
 * bare `TypeError` with no `code`, from a known upstream defect in Bun's
 * `autoSelectFamily` path (oven-sh/bun#25633, fixed in PR #32660, unreleased as
 * of 2026-08-03). Its MESSAGE text is deliberately NOT matched: upstream
 * documents that JSC mislabels the throw site inside builtin code, so the text
 * names the wrong expression and varies between runtime versions.
 */
export function isTransientConnectError(reason: unknown): boolean {
  if (reason === null || typeof reason !== "object") return false;

  const code = readCode(reason);
  if (code !== undefined && TRANSIENT_CONNECT_ERROR_CODES.has(code)) return true;

  if (!(reason instanceof Error)) return false;
  const frame = originatingFrame(reason.stack);
  if (frame === undefined) return false;
  return RUNTIME_SOCKET_MODULES.some((moduleName) => frame.includes(moduleName));
}

/**
 * Renders an error with everything the handler used to discard: the stack, the
 * error code, and the `cause` chain.
 */
export function formatErrorForLog(err: unknown, depth = 0): string {
  if (!(err instanceof Error)) return String(err);

  const parts = [err.stack ?? `${err.name}: ${err.message}`];

  const code = readCode(err);
  if (code !== undefined) parts.push(` [code=${code}]`);

  const cause = (err as { cause?: unknown }).cause;
  if (cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    parts.push(`\ncaused by: ${formatErrorForLog(cause, depth + 1)}`);
  }

  return parts.join("");
}

export type UncaughtExceptionDisposition = "survive" | "exit";

/**
 * Decides whether an uncaught exception should terminate the daemon.
 *
 * Everything that is not a transient connection failure still exits — an
 * unrelated programming error must not be swallowed into a process that keeps
 * serving from unknown state.
 */
export function classifyUncaughtException(reason: unknown): UncaughtExceptionDisposition {
  return isTransientConnectError(reason) ? "survive" : "exit";
}

function errorSignature(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return safeTruncate(raw, MAX_SIGNATURE_CHARS, "head");
}

/**
 * Telemetry for exceptions the daemon survived, surfaced on `/api/health`.
 *
 * Surviving is the DESIGNED behavior, so this never changes `status` — it is a
 * visibility field, not a degradation verdict. Its job is that a daemon which
 * has swallowed 400 connect crashes is distinguishable from one that has
 * swallowed none, without reading logs. A RISING `count` across polls is the
 * recurrence signal; the mt#3534 signature appeared 190 times in one rotated
 * log, and post-mt#3626 that same condition produces a live daemon and a quiet
 * log — exactly the shape that goes unnoticed.
 */
export interface SurvivedExceptions {
  /** ISO timestamp of the most recent survived exception, or null if none. */
  lastAt: string | null;
  /** Total survived exceptions since this process started. */
  count: number;
  /** How many DISTINCT error signatures are represented in that count. */
  distinctSignatures: number;
}

let survivedTotal = 0;
let survivedLastAtMs: number | null = null;
const survivedSignatures = new Map<string, number>();

/** Read the survived-exception telemetry. Zero-valued — never absent — when none have occurred. */
export function getSurvivedExceptions(): SurvivedExceptions {
  return {
    lastAt: survivedLastAtMs === null ? null : new Date(survivedLastAtMs).toISOString(),
    count: survivedTotal,
    distinctSignatures: survivedSignatures.size,
  };
}

/** @internal Test-only — resets the module-level telemetry between cases. */
export function resetSurvivedExceptions(): void {
  survivedTotal = 0;
  survivedLastAtMs = null;
  survivedSignatures.clear();
}

function recordSurvived(signature: string, nowMs: number): number {
  survivedTotal += 1;
  survivedLastAtMs = nowMs;
  if (!survivedSignatures.has(signature) && survivedSignatures.size >= MAX_TRACKED_SIGNATURES) {
    survivedSignatures.clear();
  }
  const count = (survivedSignatures.get(signature) ?? 0) + 1;
  survivedSignatures.set(signature, count);
  return count;
}

/**
 * Builds the logger for exceptions the daemon survives.
 *
 * Surviving changes the failure shape: an error that used to kill the process
 * once can now repeat for as long as the condition lasts. The observed mt#3534
 * signature appeared 190 times in a single rotated log, so full detail is
 * written for the first occurrence of each signature and then every
 * `fullDetailEvery`-th, with the running count on every line that is written.
 */
export function createSurvivedErrorLogger(
  write: (line: string) => void,
  fullDetailEvery = 50
): (err: unknown) => void {
  return (err: unknown) => {
    const signature = errorSignature(err);
    // Counting lives in the module-level telemetry so `/api/health` reads the
    // SAME bookkeeping the log lines are derived from, rather than a second
    // parallel counter that could drift from it.
    const count = recordSurvived(signature, Date.now());

    if (count === 1 || count % fullDetailEvery === 0) {
      write(
        `Cockpit: survivable uncaught exception (occurrence ${count}) — ` +
          `daemon staying up: ${formatErrorForLog(err)}`
      );
    }
  };
}
