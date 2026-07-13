/**
 * VitalsPage — the "/vitals" route: phone-form-factor compression of the
 * whole-system plant board (mt#2601, v3 feature 2 of mt#2378, umbrella
 * mt#2375 "the phone (pulse)").
 *
 * Same system as /plant, maximal compression: four loop cards (work /
 * learning / attention / deploy) rendered as compact gauge+sparkline
 * "breaths" (Apple-Watch-rings analogy), answering "is it okay, does it
 * need me" on a small screen. A sibling view of the wall-form plant board,
 * not a replacement — this file, its four card components, their hooks, and
 * the App.tsx route line are the ONLY things this task touches; PlantFlowPage.tsx
 * and plant-gestures.ts are untouched (owned by sibling sessions mt#2591/mt#2490).
 *
 * Truthfulness discipline (mt#2590 canon, carried into v3): every rendered
 * value is live-wired or a visibly honest placeholder with a code comment
 * naming the gap + owning task. No decorative animation — the only
 * transition here is the ring's fill-in on data arrival, gated by
 * `motion-reduce:transition-none` (RingGauge.tsx).
 *
 * Mobile-first: legible at 390x844 as a single column; scales to a 2x2 grid
 * at wider viewports. No horizontal-scroll assumptions — every card and the
 * aggregate line use `min-w-0` / `truncate` so long values never force
 * horizontal overflow.
 */
import { useSystemHealth, type HeaderHealth } from "../hooks/useSystemHealth";
import { useOpenAskCount } from "../hooks/useOpenAskCount";
import { WorkLoopCard } from "../components/vitals/WorkLoopCard";
import { LearningLoopCard } from "../components/vitals/LearningLoopCard";
import { AttentionLoopCard } from "../components/vitals/AttentionLoopCard";
import { DeployLoopCard } from "../components/vitals/DeployLoopCard";

/**
 * Header banner text + color per real aggregated health state.
 *
 * VERIFIED IDENTICAL (as of this PR, mt#2601) to PlantFlowPage.tsx's private
 * `headerStatusPresentation`: same three `HeaderHealth` branches (imported
 * from useSystemHealth.ts, not re-declared, so at least the INPUT type can't
 * drift), same label strings, same className tokens. It is intentionally a
 * separate, un-shared function rather than an extracted one:
 * PlantFlowPage.tsx is explicitly out of this task's file surface (owned by
 * sibling sessions mt#2591/mt#2490 per the coordinating agent's scope), so
 * hoisting both call sites onto one shared `lib/system-health-presentation.ts`
 * would require editing a file this PR is not permitted to touch. All three
 * branches are covered by VitalsPage.test.tsx's "aggregate header" tests so
 * at minimum THIS side of the duplication can't silently regress. If this
 * mapping and PlantFlowPage's diverge in a future change, that is the
 * trigger to file the consolidation this comment flags.
 */
function headerStatusPresentation(health: HeaderHealth | undefined): {
  label: string;
  className: string;
} {
  switch (health) {
    case "nominal":
      return { label: "● system nominal", className: "text-liveness-healthy" };
    case "degraded":
      return { label: "● system degraded", className: "text-warn-amber" };
    default:
      return { label: "● status unknown", className: "text-muted-foreground" };
  }
}

export function VitalsPage() {
  const { data: systemHealth } = useSystemHealth();
  const { data: openAskCount } = useOpenAskCount();
  const headerStatus = headerStatusPresentation(systemHealth?.header);
  const asksPending = (openAskCount ?? 0) > 0;

  return (
    <div
      className="flex flex-col gap-4 p-4 max-w-2xl mx-auto w-full min-w-0"
      data-testid="vitals-page"
    >
      <header className="flex flex-col gap-1">
        <h1 className="text-sm font-mono font-semibold tracking-[0.04em] m-0">MINSKY · VITALS</h1>
        <div className="flex items-center gap-2 text-xs font-mono">
          <span className={headerStatus.className}>{headerStatus.label}</span>
          {asksPending && (
            <span className="text-[oklch(var(--vsm-seam)/1)]" data-testid="vitals-needs-you">
              · needs you
            </span>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 min-w-0">
        <WorkLoopCard />
        <LearningLoopCard />
        <AttentionLoopCard />
        <DeployLoopCard />
      </div>
    </div>
  );
}
