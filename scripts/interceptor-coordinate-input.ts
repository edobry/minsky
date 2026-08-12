/**
 * Assemble the `CoordinateResolutionInput` the coordinate resolver needs
 * (mt#4056 slice 1b).
 *
 * `.minsky/hooks/interceptor-coordinates.ts` is deliberately a dependency-free
 * leaf: it takes the declaring facts as a PARAMETER rather than reading
 * `registry.ts` and `.claude/settings.json` itself, which is what keeps every
 * branch of its resolution testable against a fixture. Somebody still has to
 * do the reading, and `scripts/` is where that belongs — it already imports
 * the hook tree freely, and `src/` does not import it at all (mt#4010's
 * generated-artifact boundary, pinned by
 * `tests/unit/hook-tree-import-boundary.test.ts`).
 *
 * This module exists so that the two readers — the coverage audit and the
 * catalog generator — share ONE copy. They previously would have had two, and
 * a drifting second copy is the exact failure PR #2914 R1 caught on
 * `DELIBERATELY_UNAUTHORED_NAMES`: the first symptom is one surface resolving
 * an interceptor's point while the other reports it as a gap, with no error
 * anywhere.
 *
 * @see .minsky/hooks/interceptor-coordinates.ts — the resolver this feeds
 * @see scripts/build-interceptor-catalog.ts — the catalog generator
 * @see scripts/audit-interceptor-coordinates.ts — the coverage audit
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GUARD_REGISTRY } from "../.minsky/hooks/registry";
import { INTERCEPTOR_DESCRIPTIONS } from "../.minsky/hooks/interceptor-descriptions";
import type { CoordinateResolutionInput } from "../.minsky/hooks/interceptor-coordinates";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** Matches the hook script basename in a `.claude/settings.json` command string. */
const SCRIPT_BASENAME = /([a-z0-9-]+)\.ts/;

/**
 * Script basename -> harness event, read from `.claude/settings.json`.
 *
 * A missing settings file yields an EMPTY map rather than throwing: a bare
 * checkout legitimately has none, and the resolver already reports an
 * underivable point as a gap. Silently returning empty is safe here precisely
 * because the downstream contract is "report what you could not establish"
 * rather than "assume a default".
 */
function readSettingsEvents(): Map<string, string> {
  const events = new Map<string, string>();
  const settingsPath = join(REPO_ROOT, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return events;

  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
  };
  for (const [event, matchers] of Object.entries(settings.hooks ?? {})) {
    for (const matcher of matchers) {
      for (const hook of matcher.hooks ?? []) {
        const basename = (hook.command ?? "").match(SCRIPT_BASENAME)?.[1];
        if (basename) events.set(basename, event);
      }
    }
  }
  return events;
}

/** Read the three declaring sources the resolver derives an interception point from. */
export function buildCoordinateResolutionInput(): CoordinateResolutionInput {
  const registryEvents = new Map<string, string>();
  for (const reg of GUARD_REGISTRY) registryEvents.set(reg.name, reg.event);

  const strata = new Map<string, string>();
  for (const [name, desc] of INTERCEPTOR_DESCRIPTIONS) strata.set(name, desc.stratum);

  return { registryEvents, settingsEvents: readSettingsEvents(), strata };
}
