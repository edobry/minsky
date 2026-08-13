/**
 * Resident-memory session admission for the shared local daemon (mt#3814).
 *
 * ## What was already handled, and what was not
 *
 * mt#3886 wired a resident-memory ceiling that self-terminates an MCP process
 * at 2048MB, and that exit already runs the graceful path: `onExit` calls the
 * same `cleanup` the SIGTERM handler uses, which calls `server.drain()` —
 * rejecting new tool calls, waiting up to 5s for in-flight ones, then closing.
 * So "the daemon would exit mid-request" is NOT true today, and this module
 * deliberately does not re-implement draining.
 *
 * What the ceiling has no answer for is the step BEFORE it. Under a
 * per-conversation server, hitting the ceiling costs one conversation. Under a
 * shared daemon it costs every conversation on the machine at once, and the
 * process gives no warning on the way there: it serves normally at 2047MB and
 * is gone at 2048MB. This module adds the intermediate state — above a
 * watermark, stop admitting NEW sessions while continuing to serve the ones
 * already established.
 *
 * ## Why the watermark and not a bigger ceiling
 *
 * The intuition that a shared daemon needs a HIGHER ceiling than a
 * per-conversation server does not survive measurement. mt#3811 sampled daemon
 * RSS at 1, 5 and 10 concurrent clients: settled-window medians ~110MB /
 * ~170MB / ~104MB — non-monotonic, all 30 samples inside an 84–257MB band, and
 * the same band appears with zero clients connected (allocator burst-and-decay,
 * not client-driven growth). Per-conversation `mcp start` processes sampled in
 * mt#3885 sat at 427–644MB. The shared daemon's floor is measurably LOWER, so
 * 2048MB is generous headroom for it and raising the number would only delay
 * the same cliff.
 *
 * The blast radius of the ACTION is what changes under consolidation, not the
 * threshold that triggers it — hence a graceful step before it rather than a
 * larger number.
 *
 * ## What this does NOT do
 *
 * It does not bound the offending work. A single request that allocates tens of
 * GB — the shape mt#3885 is still investigating, and whose process class is
 * still unattributed — will cross the watermark and the ceiling within one poll
 * interval, and this gate will not have refused anything useful. Shedding load
 * per-request, or a supervised drain-then-RESTART, is the successor; it needs
 * mt#3815 (a supervisor that can restart this daemon at all) and mt#3885
 * (knowing what is being allocated). This is a graceful step, not a fix for the
 * leak.
 */

const BYTES_PER_MB = 1024 * 1024;

/**
 * Watermark as a fraction of the kill ceiling, when not set explicitly.
 *
 * 0.75 leaves a quarter of the budget between "stop taking new work" and "the
 * process is gone" — enough for mt#3973's capture watcher to write its
 * artifact and for established sessions to finish their calls, without sitting
 * so low that a daemon in its normal 84–257MB band ever approaches it. Against
 * the 2048MB default the watermark is 1536MB, which is ~6x the top of the
 * measured band.
 */
export const DEFAULT_ADMISSION_WATERMARK_FRACTION = 0.75;

/**
 * Resolve the admission watermark in bytes, or null when the gate is off.
 *
 * Off by default and armed only by the daemon's own wiring: this changes when
 * a server refuses a session, and quietly applying that to every `mcp start`
 * — including the hosted Railway surface, which mt#3814's spec puts explicitly
 * out of scope — is not a change that should ride along with a local feature.
 */
export function resolveAdmissionWatermarkBytes(
  ceilingBytes: number,
  env: NodeJS.ProcessEnv = process.env
): number | null {
  const explicit = env["MINSKY_MCP_SESSION_ADMISSION_WATERMARK_MB"];
  if (explicit !== undefined) {
    const parsed = Number.parseInt(explicit, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed * BYTES_PER_MB;
    return null;
  }
  if (!Number.isFinite(ceilingBytes) || ceilingBytes <= 0) return null;
  return Math.floor(ceilingBytes * DEFAULT_ADMISSION_WATERMARK_FRACTION);
}

export interface AdmissionDecision {
  admit: boolean;
  /** `null` when memory could not be measured — see `measured`. */
  residentBytes: number | null;
  watermarkBytes: number;
  /**
   * False when the reading failed and this decision is therefore a fail-open
   * default rather than an observation (mt#4104).
   *
   * Without this, "comfortably under the watermark" and "we could not tell"
   * produce the same `admit: true` — which is the shape that let a daemon
   * holding 48 GB read as healthy.
   */
  measured: boolean;
}

/**
 * Admit a NEW session only below the watermark.
 *
 * Deliberately `>=` rather than `>`: an exactly-at-watermark process is
 * already in the state this gate exists to react to.
 */
export function decideAdmission(input: {
  residentBytes: number;
  watermarkBytes: number;
}): AdmissionDecision {
  return {
    admit: input.residentBytes < input.watermarkBytes,
    residentBytes: input.residentBytes,
    watermarkBytes: input.watermarkBytes,
    // This overload only accepts a real number, so reaching it IS a measurement.
    measured: true,
  };
}

/** The message a refused session receives. */
export function formatAdmissionRefusal(
  decision: AdmissionDecision,
  retryAfterSecs: number
): string {
  // A refusal is only ever produced from a real reading — the unmeasured branch
  // fails open — so this formats the measured case. `?? 0` is a type-level
  // fallback for an unreachable state, not a substituted measurement.
  return (
    `Service unavailable: the shared MCP daemon is above its session-admission watermark ` +
    `(${Math.round((decision.residentBytes ?? 0) / BYTES_PER_MB)}MB of ` +
    `${Math.round(decision.watermarkBytes / BYTES_PER_MB)}MB) and is not accepting new sessions. ` +
    `Established sessions are unaffected. Retry after ${retryAfterSecs}s.`
  );
}

export type AdmissionGate = () => AdmissionDecision;

/**
 * Build the gate the server consults before creating a session.
 *
 * The resident-bytes read is injected rather than called directly so the
 * decision is testable at a chosen memory level — the alternative is a test
 * that can only assert the behavior the machine it runs on happens to produce.
 */
export function createAdmissionGate(options: {
  getResidentBytes: () => number | null;
  watermarkBytes: number;
}): AdmissionGate {
  return () => {
    const residentBytes = options.getResidentBytes();
    // Fail OPEN when memory cannot be measured (mt#4104). Refusing every session
    // because the READING failed turns a measurement gap into a total outage,
    // which is the larger failure; `measured: false` keeps the two states
    // distinguishable so this never silently reads as a healthy daemon.
    if (residentBytes === null) {
      return {
        admit: true,
        residentBytes: null,
        watermarkBytes: options.watermarkBytes,
        measured: false,
      };
    }
    return decideAdmission({ residentBytes, watermarkBytes: options.watermarkBytes });
  };
}
