/**
 * useAmbientClock — a periodically-advancing timestamp, ANCHORED to the
 * fold's own playhead moment, for the session film's aliveness pass
 * (mt#3226 SC 4).
 *
 * This is the ONE JS ticker behind "the scene visibly cools between events
 * rather than snapping": it does NOT mutate any fold/world state (the
 * honest-motion law's "no fake node activity" holds — nothing here
 * invents a touch or a beam), it only advances a timestamp that
 * `session-film-aliveness.ts`'s `computeGlowBrightness` reads to derive a
 * continuously-decaying visual brightness from an ALREADY-KNOWN
 * `lastTouchedAt`. Disabled entirely under `prefers-reduced-motion` (per
 * the ambient-register carve-out's own gating rule) — the caller should
 * pass `enabled: false` in that case, degrading brightness to a single
 * static computation against the fold's own `nowIso`.
 *
 * Critically, this does NOT jump to the browser's real wall-clock date: a
 * replayed session's events carry HISTORICAL timestamps (the transcript may
 * be from last week), so ticking against `new Date()` directly would make
 * every node read as maximally cold forever (elapsed time = "now" minus a
 * historical timestamp, effectively unbounded). Instead the returned value
 * is `baseIso + (real wall-clock time elapsed since baseIso was last set)`
 * — anchored to the fold's OWN timeline, advancing at real-time RATE. Every
 * time `baseIso` changes (the user scrubs to a new playhead position), the
 * anchor resyncs so ticking resumes counting up from the NEW moment.
 */
import { useEffect, useRef, useState } from "react";

/**
 * Returns an ISO timestamp anchored to `baseIso` (the fold's current
 * playhead moment) that advances at real-time rate every `intervalMs` while
 * `enabled`; returns `baseIso` unchanged (no ticking at all) otherwise.
 */
export function useAmbientClock(enabled: boolean, intervalMs: number, baseIso: string): string {
  const trackedBaseIsoRef = useRef<string>(baseIso);
  const baseMsRef = useRef<number>(Date.parse(baseIso));
  const anchoredAtRef = useRef<number>(Date.now());
  const [, forceTick] = useState(0);

  // Resync the anchor SYNCHRONOUSLY DURING RENDER (the React-endorsed
  // "adjust state while rendering" pattern — comparing a ref-cached
  // previous value against the current prop and updating both in the same
  // pass) whenever the fold's own playhead moment changes. Doing this in an
  // effect instead would lag: the returned value wouldn't reflect the new
  // anchor until the NEXT tick fires (up to `intervalMs` later), which
  // would visibly stall the glow on every playhead jump.
  if (trackedBaseIsoRef.current !== baseIso) {
    trackedBaseIsoRef.current = baseIso;
    baseMsRef.current = Date.parse(baseIso);
    anchoredAtRef.current = Date.now();
  }

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => forceTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);

  if (!enabled) return baseIso;
  const baseMs = Number.isNaN(baseMsRef.current) ? Date.now() : baseMsRef.current;
  const elapsedRealMs = Date.now() - anchoredAtRef.current;
  return new Date(baseMs + elapsedRealMs).toISOString();
}
