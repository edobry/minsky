/**
 * Shared failure-posture declaration accessor — mt#3981 (thin-hooks RFC rev. 2, phase 1).
 *
 * A guard's per-effect verdict-shape + failure-posture declaration lives on one of two
 * surfaces, mirroring `./calibration-log-declarations.ts`'s mt#3716 precedent for the same
 * two-surface split:
 *
 *   1. `GUARD_REGISTRY[].effects` (`.minsky/hooks/registry.ts`) — dispatcher-registered guards.
 *   2. `STANDALONE_GUARD_CANARIES[].effects` (`./standalone-guard-canaries.ts`) — standalone
 *      (non-dispatcher) guards wired directly in `.claude/settings.json`, plus the merge-gate
 *      and pre-commit family reachable through that same canary declaration surface.
 *
 * This module is the ONE shared accessor over that union — mirroring the mt#3716 precedent so
 * a future consumer (the mt#3754 catalog, a coverage script) reads declarations from here
 * rather than re-deriving the union a second time. Per mt#3586's constraint, `src/` code that
 * needs these types routes through this accessor rather than hand-copying a mirror of
 * `GuardEffectDeclaration`.
 *
 * ## SC2 scope (RFC rev. 2 rescope)
 *
 * The union view here covers the REGISTERED population (`GUARD_REGISTRY` +
 * `STANDALONE_GUARD_CANARIES`) — not the full fire-log corpus. The RFC rev. 2 expert review
 * established that four lifecycle events (PostToolUse, SessionStart, SubagentStop, SessionEnd)
 * have no dispatcher at all and ~55% of the corpus carries no registration at all; closing that
 * gap is catalog-driven follow-up work, not a phase-1 rider (see the task spec's `## Rescope`
 * section). `getPostureCoverage` below still LISTS what it cannot cover — explicitly, not
 * silently — by cross-referencing the fire log's observed `guardName` population against the
 * declared set.
 *
 * @see mt#3981 — this task
 * @see mt#3716 — the calibration-log accessor this mirrors
 * @see mt#3754 — the catalog umbrella this feeds
 * @see docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md
 */

import { GUARD_REGISTRY } from "../../.minsky/hooks/registry";
import type { GuardEffectDeclaration } from "../../.minsky/hooks/registry";
import { STANDALONE_GUARD_CANARIES } from "./standalone-guard-canaries";
import { readFireLogEntries } from "../../.minsky/hooks/fire-log";

/**
 * One guard's declared posture, normalized across both source surfaces. `event`/`matcher`/
 * `timeoutMs` are present only for `GUARD_REGISTRY` entries — a standalone guard's dispatcher
 * wiring (if any) lives in `.claude/settings.json`, outside this accessor's scope.
 */
export interface DeclaredGuardPosture {
  guardName: string;
  /** `"registry"` for a GUARD_REGISTRY entry, `"standalone"` for a STANDALONE_GUARD_CANARIES entry. */
  source: "registry" | "standalone";
  event?: string;
  matcher?: string;
  timeoutMs?: number;
  effects: [GuardEffectDeclaration, ...GuardEffectDeclaration[]];
}

/**
 * The declared posture for every guard in the REGISTERED population (SC2 scope above), keyed
 * by `guardName`. `GUARD_REGISTRY` entries take precedence on a name collision — none is
 * expected (a guard is either dispatcher-migrated or standalone, never both), but registry
 * entries are the richer declaration (event/matcher/timeoutMs), so they win if one ever occurs.
 */
export function getDeclaredGuardPostures(): Map<string, DeclaredGuardPosture> {
  const map = new Map<string, DeclaredGuardPosture>();
  for (const canary of STANDALONE_GUARD_CANARIES) {
    map.set(canary.guardName, {
      guardName: canary.guardName,
      source: "standalone",
      effects: canary.effects,
    });
  }
  for (const reg of GUARD_REGISTRY) {
    map.set(reg.name, {
      guardName: reg.name,
      source: "registry",
      event: reg.event,
      matcher: reg.matcher,
      timeoutMs: reg.timeoutMs,
      effects: reg.effects,
    });
  }
  return map;
}

/**
 * Cross-references the fire log's observed `guardName` population against the declared set
 * (SC2/AT2). `covered` is every declared guard name (sorted); `notCovered` is every fire-log
 * guard name absent from the declared set — listed explicitly, not silently dropped, per the
 * RFC rev. 2 rescope's "the union accessor still lists what it cannot cover" instruction.
 *
 * An empty fire log (fresh clone; the log is gitignored) makes `notCovered` trivially empty —
 * that is an absence-of-evidence result, not a coverage claim; see `readFireLogEntries`'s own
 * fail-to-`[]` contract.
 */
export function getPostureCoverage(): { covered: string[]; notCovered: string[] } {
  const declared = getDeclaredGuardPostures();
  const fireLogNames = new Set(readFireLogEntries().map((e) => e.guardName));
  const notCovered = [...fireLogNames].filter((name) => !declared.has(name)).sort();
  return { covered: [...declared.keys()].sort(), notCovered };
}
