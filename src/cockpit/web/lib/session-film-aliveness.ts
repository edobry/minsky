/**
 * Aliveness-pass pure logic (mt#3226 SC 4).
 *
 * Operator's summary judgment on the v1 stage: "it doesn't feel alive... I
 * don't get the sense of excitement I got from [Gource]." This module holds
 * the TESTABLE math behind the aliveness pass's non-visual parts — glow
 * brightness — so it's verifiable without a DOM. The remaining three
 * mechanics (arrival spring-settle, camera drift, avatar idle-float) are
 * CSS/DOM affordances applied directly in SessionFilmStage.tsx / PanZoomSVG.tsx,
 * gated by the same `prefers-reduced-motion` signal as everything here.
 *
 * ## Design-decision record — the honest-motion carve-out (verbatim)
 *
 * The plant board's honest-motion law (every motion is driven by a real
 * event; no event, no motion) is deliberately carved out for the session
 * film's AMBIENT register — camera drift, idle float, and decay breathing.
 * The film is a narrative surface, not a status instrument: ambience must
 * NEVER be event-mimicking (no fake beams, no fake node activity). Event-
 * driven motion (excursions, beams, arrivals) remains strictly honest.
 * Operator approved this direction 2026-07-25 by requesting it.
 *
 * @see SessionFilmStage.tsx — bloom filter, spring-settle, avatar idle-float
 * @see PanZoomSVG.tsx — ambient camera drift + user-override pause
 * @see session-film-config.ts — SessionFilmConfig["aliveness"], the ONE tunables object
 */
import type { SessionFilmConfig } from "./session-film-config";

/**
 * Continuous decay brightness (spec: "recency-weighted brightness so the
 * scene visibly cools between events rather than snapping"), in `[0, 1]`.
 * Deliberately the SAME exponential-decay shape as the DOI layout's
 * `recencyScore` (session-film-layout.ts) but an INDEPENDENT rate
 * (`config.aliveness.glowDecayPerSecond`, not `config.doi.recencyDecayPerSecond`)
 * — glow is a purely visual signal, DOI expansion is a structural one; they
 * should be separately tunable even though the underlying math matches.
 */
export function computeGlowBrightness(
  lastTouchedAtIso: string,
  nowIso: string,
  config: SessionFilmConfig
): number {
  const now = Date.parse(nowIso);
  const last = Date.parse(lastTouchedAtIso);
  if (Number.isNaN(now) || Number.isNaN(last)) return 0;
  const elapsedSec = Math.max(0, (now - last) / 1000);
  return Math.exp(-config.aliveness.glowDecayPerSecond * elapsedSec);
}

/** Bloom filter `stdDeviation`, scaled by brightness (brighter = a wider halo). */
export function bloomStdDeviation(brightness: number, config: SessionFilmConfig): number {
  return config.aliveness.bloomBlurStdDeviation * (0.4 + 0.6 * brightness);
}

/** Bloom halo opacity, scaled by brightness — fully idle nodes carry a faint but nonzero halo (never a hard on/off snap). */
export function bloomOpacity(brightness: number): number {
  return 0.15 + 0.55 * brightness;
}
