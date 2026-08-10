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

import {
  fingerprintError,
  fingerprintGuardDenial,
  type DenialFingerprint,
  type ErrorFingerprint,
  type ObservationSource,
} from "./fingerprint";

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
  /**
   * Which surface produced this (mt#3802). Absent on records written before
   * guard-denial tracking existed, which is why it is optional rather than
   * defaulted — an absent value means "written before the discriminator", and
   * silently reading that as `"tool-error"` would put un-sourced history into a
   * bucket it was never measured into.
   */
  source?: ObservationSource;
  /** The denying guard, when `source` is `"guard-denial"`. */
  guardName?: string;
  /** Input hash of the FIRST strike, when the surface carries one. */
  firstInputHash?: string;
  /** Input hash of the SECOND strike — equal to the first means a byte-identical repeat. */
  secondInputHash?: string;
}

/** Handler signature registered via `onSecondStrike`. */
export type SecondStrikeHandler = (event: SecondStrikeEvent) => void | Promise<void>;

/** Persisted/serialised state for hook-script use (one record per active streak). */
export interface TrackerStateRecord {
  toolName: string;
  fingerprintHash: string;
  normalizedMessage: string;
  errorType: string;
  firstAt: string;
  /**
   * The map key this streak occupies (mt#3802).
   *
   * Absent means `toolName`, which is what every record written before
   * guard-denial tracking used — so existing on-disk state files rehydrate
   * unchanged. Denial streaks carry an explicit prefixed key so a guard denial
   * and a tool error on the SAME tool do not evict each other; they are
   * different surfaces and an agent can be mid-streak on both.
   */
  streakKey?: string;
  source?: ObservationSource;
  guardName?: string;
  inputHash?: string;
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
      // `streakKey ?? toolName` (mt#3802): records written before denial
      // tracking have no key field and used the tool name, so an existing
      // on-disk state file rehydrates to exactly the map it was written from.
      tracker.streaks.set(streak.streakKey ?? streak.toolName, { ...streak });
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
    return this.recordStrike(toolName, fingerprintError(toolName, error));
  }

  /**
   * Record a PreToolUse guard denial (mt#3802).
   *
   * The denial surface was structurally invisible before this: a PreToolUse
   * deny means the tool never runs, so the PostToolUse tracker never fires. It
   * is also the class most likely to be retried blindly, because the denial
   * text reads as advice ("use X instead") and the agent's next attempt feels
   * like a correction rather than a repeat.
   */
  recordDenial(input: {
    toolName: string;
    guardName: string;
    reason: unknown;
    toolInput: unknown;
  }): boolean {
    const fp = fingerprintGuardDenial(input);
    // Prefixed so a denial streak and a tool-error streak on the same tool
    // occupy different slots rather than evicting one another.
    return this.recordStrike(`guard:${input.guardName}:${input.toolName}`, fp);
  }

  /** Shared strike bookkeeping for both surfaces. */
  private recordStrike(streakKey: string, fp: ErrorFingerprint | DenialFingerprint): boolean {
    const toolName = fp.toolName;
    const denial = "inputHash" in fp ? fp : undefined;
    const existing = this.streaks.get(streakKey);
    const ts = this.now();

    if (existing && existing.fingerprintHash === fp.hash) {
      // Same slot, same fingerprint → SECOND STRIKE.
      const event: SecondStrikeEvent = {
        toolName,
        fingerprintHash: fp.hash,
        normalizedMessage: fp.normalizedMessage,
        errorType: fp.errorType,
        firstAt: existing.firstAt,
        secondAt: ts,
        ...(denial
          ? {
              source: "guard-denial" as const,
              guardName: denial.guardName,
              firstInputHash: existing.inputHash,
              secondInputHash: denial.inputHash,
            }
          : {}),
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
      this.streaks.delete(streakKey);
      return true;
    }

    // Different fingerprint OR first-ever error for this slot → start a
    // fresh streak. (Replacing an existing different-fingerprint streak is
    // the documented behaviour: two different errors don't accumulate.)
    this.streaks.set(streakKey, {
      toolName,
      fingerprintHash: fp.hash,
      normalizedMessage: fp.normalizedMessage,
      errorType: fp.errorType,
      firstAt: ts,
      ...(denial
        ? {
            streakKey,
            source: "guard-denial" as const,
            guardName: denial.guardName,
            inputHash: denial.inputHash,
          }
        : {}),
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
    // mt#3802: a success on this tool also breaks any DENIAL streak on it. SC1
    // says "second CONSECUTIVE denial", and a tool call that actually ran is
    // proof the agent stopped repeating the denied input. Without this, a
    // denial early in a session and an unrelated one much later would fire a
    // second strike with a successful call between them.
    for (const key of [...this.streaks.keys()]) {
      if (key.startsWith("guard:") && key.endsWith(`:${toolName}`)) this.streaks.delete(key);
    }
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
export {
  fingerprintError,
  fingerprintGuardDenial,
  type DenialFingerprint,
  type ErrorFingerprint,
  type ObservationSource,
};
