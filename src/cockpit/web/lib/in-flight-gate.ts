/**
 * In-flight-fetch gate (mt#3131 D4 — cockpit conversation-view polling storm).
 *
 * `App.tsx`'s app-level polling `useEffect` fires `fetchWidgetData(id)` on a
 * plain `setInterval` tick for each polling-mode widget (e.g. `task-graph`,
 * a 10s interval). Before this fix, nothing stopped a NEW tick from firing
 * while the PREVIOUS tick's fetch was still outstanding — if a single fetch
 * ever takes longer than the poll interval (the task-graph widget's own
 * comment flags it as expensive: "~1K nodes; 5s is too aggressive for a
 * heavy render"), ticks pile up unboundedly. A browser caps concurrent
 * same-origin connections (~6), so a backlog of pending same-origin fetches
 * starves OTHER requests too — matching the observed symptom of unrelated
 * tabs stalling while a live conversation is open (the investigating agent's
 * own conversation adds DB load that plausibly slows the task-graph query
 * past the 10s interval).
 *
 * This is a plain key-guard, no React/timer coupling, so it's directly
 * unit-testable without mounting the full `App` component (which pulls in
 * every lazy-loaded route).
 */
export interface InFlightGate {
  /**
   * Start `start()` under `key` UNLESS a previous call under the same key
   * hasn't settled yet — in which case this call is a no-op (the tick is
   * simply skipped, not queued; the next tick gets another chance).
   */
  run(key: string, start: () => Promise<void>): void;
  /** True while a `run()` call under `key` is outstanding. Test/inspection seam. */
  isInFlight(key: string): boolean;
}

export function createInFlightGate(): InFlightGate {
  const inFlight = new Set<string>();
  return {
    run(key, start) {
      if (inFlight.has(key)) return;
      inFlight.add(key);
      start()
        .catch(() => {})
        .finally(() => {
          inFlight.delete(key);
        });
    },
    isInFlight(key) {
      return inFlight.has(key);
    },
  };
}
