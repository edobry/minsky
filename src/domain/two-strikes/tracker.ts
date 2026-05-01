/**
 * In-memory 2-strikes tracker (mt#1484).
 *
 * Implements CLAUDE.md §Error Investigation's mechanical detection: when the
 * same tool emits the same error fingerprint twice in a row (no intervening
 * success), fire the registered handler so the agent can stop and diagnose.
 *
 * Per mt#1481 transport-availability lessons and ADR-008, the tracker SHIPS
 * IN OBSERVATION-ONLY MODE BY DEFAULT. The handler is invocation-gated by
 * `mode: "observation"`; in that mode every would-have-fired event is recorded
 * to an in-memory observation log instead of invoking the handler. mt#1476
 * (Ask emission for stuck.unblock) flips the mode to "live" once calibration
 * settles the heuristic. See mt#1484 §Implementation Choice in the spec.
 *
 * Reset semantics (per mt#1484 success criteria):
 *   - One streak per tool. error-on-tool-A then error-on-tool-B → no fire.
 *   - Intervening success on the same tool resets that tool's streak.
 *   - A different fingerprint on the same tool starts a fresh streak (count=1)
 *     for that fingerprint, replacing the prior streak entry. (Two different
 *     errors aren't "identical," so they don't accumulate.)
 *   - Streaks live for the lifetime of the tracker instance — per the spec,
 *     v1 ephemeral state, no persistence across sessions at the domain layer.
 *     The hook script in `.claude/hooks/` provides session-scoped persistence.
 */

import { fingerprintError, type ErrorFingerprint } from "./fingerprint";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Operating mode for the tracker. */
export type TrackerMode = "observation" | "live";

/** What the handler receives when 2-strikes fires. */
export interface SecondStrikeEvent {
  /** Tool that fired both errors. */
  toolName: string;
  /** Stable hash of the error fingerprint shared by both strikes. */
  fingerprintHash: string;
  /** The first strike's normalized message (what's matched on). */
  normalizedMessage: string;
  /** The first strike's error-type discriminator. */
  errorType: string;
  /** Wall-clock ISO of the first strike. */
  firstAt: string;
  /** Wall-clock ISO of the second strike. */
  secondAt: string;
}

/** Handler signature registered via `onSecondStrike`. */
export type SecondStrikeHandler = (event: SecondStrikeEvent) => void | Promise<void>;

/** Persisted/serialised state for hook-script use (one record per active streak). */
export interface TrackerStateRecord {
  toolName: string;
  fingerprintHash: string;
  normalizedMessage: string;
  errorType: string;
  count: number;
  firstAt: string;
}

/** Snapshot of the tracker's complete state. */
export interface TrackerSnapshot {
  mode: TrackerMode;
  streaks: TrackerStateRecord[];
  observations: SecondStrikeEvent[];
}

// ---------------------------------------------------------------------------
// Tracker class
// ---------------------------------------------------------------------------

/**
 * Per-session, in-memory tracker.
 *
 * Default mode is `"observation"` — see class doc-comment for rationale.
 * Tests inject the mode they need; production callers (the hook script) read
 * it from a config flag.
 *
 * The tracker is hermetic: no file I/O, no global state, no clocks. The
 * `now` function is injectable so tests can pin timestamps; the default is
 * `() => new Date().toISOString()`.
 */
export class TwoStrikesTracker {
  private readonly mode: TrackerMode;
  private readonly now: () => string;
  private readonly streaks = new Map<string, TrackerStateRecord>();
  private readonly observations: SecondStrikeEvent[] = [];
  private handler?: SecondStrikeHandler;

  constructor(opts?: { mode?: TrackerMode; now?: () => string }) {
    this.mode = opts?.mode ?? "observation";
    this.now = opts?.now ?? (() => new Date().toISOString());
  }

  /** Returns the configured mode (test seam). */
  getMode(): TrackerMode {
    return this.mode;
  }

  /** Snapshot the entire tracker state (test seam, also used by the hook for persistence). */
  snapshot(): TrackerSnapshot {
    return {
      mode: this.mode,
      streaks: [...this.streaks.values()].map((s) => ({ ...s })),
      observations: this.observations.map((o) => ({ ...o })),
    };
  }

  /** Restore a tracker from a snapshot — used by the hook to rehydrate per call. */
  static fromSnapshot(snap: TrackerSnapshot, opts?: { now?: () => string }): TwoStrikesTracker {
    const tracker = new TwoStrikesTracker({ mode: snap.mode, now: opts?.now });
    for (const streak of snap.streaks) {
      tracker.streaks.set(streak.toolName, { ...streak });
    }
    for (const obs of snap.observations) {
      tracker.observations.push({ ...obs });
    }
    return tracker;
  }

  /**
   * Register the second-strike handler. Only one handler at a time; calling
   * twice replaces the previous handler. In "observation" mode the handler
   * is never invoked — the observation log records the event instead, so
   * mt#1476 can be wired in advance and stay dormant until the mode flips.
   */
  onSecondStrike(handler: SecondStrikeHandler): void {
    this.handler = handler;
  }

  /**
   * Record a tool error.
   *
   * Returns `true` iff this call constituted a 2-strikes fire (handler invoked
   * in `live` mode, observation appended in `observation` mode). Returns
   * `false` for first-strike errors and for second-of-different-fingerprint
   * sequences.
   */
  recordError(toolName: string, error: unknown): boolean {
    const fp = fingerprintError(toolName, error);
    const existing = this.streaks.get(toolName);
    const ts = this.now();

    if (existing && existing.fingerprintHash === fp.hash) {
      // Same tool, same fingerprint → SECOND STRIKE.
      const event: SecondStrikeEvent = {
        toolName,
        fingerprintHash: fp.hash,
        normalizedMessage: fp.normalizedMessage,
        errorType: fp.errorType,
        firstAt: existing.firstAt,
        secondAt: ts,
      };

      if (this.mode === "observation") {
        this.observations.push(event);
      } else if (this.handler) {
        // Don't await — the handler may want to fire-and-forget, and the
        // recordError caller (a tool-call dispatch hook) shouldn't block on
        // handler latency. Errors thrown by the handler are this caller's
        // concern, not the tracker's.
        void this.handler(event);
      }

      // Reset this tool's streak after firing so a third identical error
      // doesn't immediately re-fire — the agent is expected to act on the
      // signal, and re-firing on every subsequent retry would flood the
      // operator. The next streak starts fresh on the next error.
      this.streaks.delete(toolName);
      return true;
    }

    // Different fingerprint OR first-ever error for this tool → start a
    // fresh streak, count=1. (Replacing an existing different-fingerprint
    // streak is the documented behaviour: two different errors don't
    // accumulate.)
    this.streaks.set(toolName, {
      toolName,
      fingerprintHash: fp.hash,
      normalizedMessage: fp.normalizedMessage,
      errorType: fp.errorType,
      count: 1,
      firstAt: ts,
    });
    return false;
  }

  /**
   * Record a tool success — clears the streak for that tool.
   *
   * The 2-strikes rule is "consecutive identical errors": any intervening
   * success resets the streak. Calling `recordSuccess` on a tool with no
   * active streak is a safe no-op.
   */
  recordSuccess(toolName: string): void {
    this.streaks.delete(toolName);
  }

  // -------------------------------------------------------------------------
  // Observation-mode introspection (used by the hook to flush observations
  // to the JSONL log between invocations).
  // -------------------------------------------------------------------------

  /** Read-only view of all observations recorded since the tracker was created or restored. */
  getObservations(): readonly SecondStrikeEvent[] {
    return [...this.observations];
  }

  /** Drain the observation log — returns the recorded events and clears the buffer. */
  drainObservations(): SecondStrikeEvent[] {
    const drained = this.observations.splice(0, this.observations.length);
    return drained;
  }
}

/** Re-exports so consumers don't need to chase down the fingerprint module. */
export { fingerprintError, type ErrorFingerprint };
