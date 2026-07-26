/**
 * useSessionFilmForceLayout — React wiring for the living-layout d3-force
 * simulation (mt#3231 SC 4, the A2->A3 motion climb).
 *
 * Wraps a STATIC `computeStageLayout` result (`session-film-layout.ts`) with
 * a continuously-ticking `session-film-force-layout.ts` simulation and
 * returns a `StageLayout`-shaped value whose `nodes[].x/y` are the LIVE
 * simulated positions — a drop-in replacement for the static layout at
 * every downstream call site (edges, beams, avatar excursions, node
 * clicks), since nodes are still keyed by the SAME `id`/`entityId`.
 *
 * ## Why setInterval, not requestAnimationFrame
 *
 * Matches this module's sibling ticker, `useAmbientClock.ts` (also
 * `setInterval`-based) — a d3-force settle doesn't need 60fps precision,
 * `config.forceLayout.tickIntervalMs` is a deliberately coarser, testable,
 * and lower-CPU cadence than rAF would give for the same visual effect.
 *
 * ## Mount/prop-change behavior
 *
 * On first mount (or whenever the incoming `layout` reference changes — the
 * page recomputes it every playhead step via `useMemo`), the effect either
 * CREATES a fresh simulation (first layout ever seen) or MERGES the new
 * layout into the existing one (`mergeForceLayout` — re-flow, not reset).
 * Under `prefers-reduced-motion`, the effect settles ONCE synchronously
 * (`settleForceLayoutOnce`) and schedules exactly one deferred re-render (a
 * `setTimeout(0)`, not synchronous — see the inline comment) instead of
 * starting the interval loop; no further ticking happens for that layout.
 *
 * The RETURNED layout is computed by reading the simulation's ref-tracked
 * state directly during render (not memoized against `layout`'s identity)
 * so a tick-triggered re-render (`forceTick`) picks up fresh positions
 * without needing `layout` itself to have changed. On the very FIRST render
 * of a brand-new layout, `stateRef.current` is still whatever the PREVIOUS
 * layout's simulation held (or `null` on true first mount) — in the `null`
 * case this falls back to the static `layout` unchanged (harmless: a fresh
 * simulation's tick-0 positions are BY CONSTRUCTION identical to the static
 * input anyway, so there is no visible flash either way).
 *
 * @see session-film-force-layout.ts — the pure simulation logic this hook drives
 * @see SessionFilmStage.tsx — the sole consumer (shadows its `layout` prop with this hook's return)
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { StageLayout } from "../lib/session-film-layout";
import type { SessionFilmConfig } from "../lib/session-film-config";
import {
  createForceLayout,
  isForceLayoutSettled,
  mergeForceLayout,
  readForceLayoutPositions,
  settleForceLayoutOnce,
  tickForceLayout,
  type ForceLayoutState,
} from "../lib/session-film-force-layout";

export function useSessionFilmForceLayout(
  layout: StageLayout,
  config: SessionFilmConfig,
  reducedMotion: boolean
): StageLayout {
  const stateRef = useRef<ForceLayoutState | null>(null);
  // Latest-`config` mirror (mt#3231 review R1, non-blocking #5 — "interval
  // captures state/tickIntervalMs, not updated on nested config change").
  // `config` IS already a full effect dependency below, so a caller that
  // gives it a NEW reference on every relevant change already gets a fresh
  // tick loop for free. This ref is the defensive belt for the documented
  // anti-pattern the reviewer flagged: a caller that mutates `config`'s
  // NESTED fields in place on a STABLE reference (contrary to the
  // immutability this hook assumes elsewhere). Reading through this ref on
  // every scheduled tick (see the self-rescheduling `setTimeout` below)
  // means the interval always uses the CURRENT `tickIntervalMs`, not the
  // value the tick loop's closure captured at effect-setup time.
  const configRef = useRef(config);
  configRef.current = config;
  // A COUNTER (not a bare `[, forceTick]`) — deliberately included in the
  // final `useMemo` dependency array below. Every downstream consumer
  // (`SessionFilmStage.tsx`'s "arrival physics" effect, keyed off
  // `layout.nodes`) does REFERENCE-EQUALITY dependency checks; returning a
  // brand-new `nodes` array on every render regardless of whether a tick
  // actually happened made that effect think the node set changed EVERY
  // render, and (under reduced motion) its unconditional
  // `setJustArrivedIds(new Set())` call — a fresh object each time, so
  // React never bails via `Object.is` — became a synchronous infinite
  // render loop. Memoizing on `tick` keeps the returned reference STABLE
  // across renders where nothing actually moved.
  const [tick, setTick] = useState(0);

  useEffect(() => {
    stateRef.current = stateRef.current
      ? mergeForceLayout(stateRef.current, layout, config)
      : createForceLayout(layout, config);

    if (reducedMotion) {
      settleForceLayoutOnce(stateRef.current);
      // Deferred (not synchronous): keeps this settle from forcing a SECOND
      // synchronous render inside the SAME `act()` pass a caller's `render()`
      // triggered — a real browser paints the settled arrangement shortly
      // after mount either way; a synchronous re-render here would only
      // matter to a test asserting on the exact tick=0 pass-through values.
      const timeout = setTimeout(() => setTick((n) => n + 1), 0);
      return () => clearTimeout(timeout);
    }

    const state = stateRef.current;
    // Self-rescheduling `setTimeout` (mt#3231 review R1, non-blocking #5 —
    // NOT a bare `setInterval`): a `setInterval`'s delay is fixed at the
    // moment it's created, from whatever `config.forceLayout.tickIntervalMs`
    // the closure captured then — reading `configRef.current` fresh on
    // EVERY reschedule instead means a nested config change (even one that
    // violates the "config is immutable" assumption by mutating in place on
    // a stable reference) takes effect on the very next tick, not never.
    // Self-clearing (belt-and-suspenders alongside the effect cleanup
    // below): once the simulation settles, the loop stops rescheduling
    // ITSELF rather than ticking-and-no-op'ing forever — bounds how long
    // any one loop can possibly stay alive even if an unmount were ever
    // missed (e.g. a synchronous test error skipping React's normal
    // teardown).
    let timeoutId: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const scheduleNextTick = () => {
      timeoutId = setTimeout(() => {
        if (cancelled || !state || isForceLayoutSettled(state)) return;
        tickForceLayout(state);
        setTick((n) => n + 1);
        scheduleNextTick();
      }, configRef.current.forceLayout.tickIntervalMs);
    };
    scheduleNextTick();
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [layout, config, reducedMotion]);

  // Memoized on `[layout, tick]` (NOT recomputed on every render) — see the
  // `tick` state declaration's comment above for why reference stability
  // here is load-bearing, not just a performance nicety.
  return useMemo(() => {
    const state = stateRef.current;
    if (!state) return layout;
    const positions = readForceLayoutPositions(state);
    return {
      homeX: layout.homeX,
      homeY: layout.homeY,
      nodes: layout.nodes.map((node) => {
        const pos = positions.get(node.id);
        return pos ? { ...node, x: pos.x, y: pos.y } : node;
      }),
    };
    // `stateRef.current` is a ref (not itself declarable as a dep); `tick`
    // is the deliberate re-computation trigger whose bumps are exactly what
    // signals a relevant change to it — see the `tick` declaration's comment above.
  }, [layout, tick]);
}
