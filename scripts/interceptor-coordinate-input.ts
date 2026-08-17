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
import {
  STANDALONE_SCRIPT_ALIASES,
  type CoordinateResolutionInput,
} from "../.minsky/hooks/interceptor-coordinates";

const REPO_ROOT = resolve(import.meta.dir, "..");

/** Matches the hook script basename in a `.claude/settings.json` command string. */
const SCRIPT_BASENAME = /([a-z0-9-]+)\.ts/;

/**
 * Script basename -> harness event, or null when the file is absent or a command
 * used a shape this parser cannot read (mt#4129).
 *
 * **Null vs empty is the whole point of this signature.** Two callers want
 * opposite things from a failed read:
 *
 * - The POINT path (`readSettingsEvents` below) wants leniency. An underivable
 *   point is already reported as a gap, so "report what you could not establish"
 *   holds and an empty map is safe.
 * - The POPULATION path (`readSettingsHookNames`) does not. An empty map there
 *   reads as "no hook is registered", which reports the whole corpus as fine
 *   while the catalog omits all of it — which is precisely the mt#4129 defect,
 *   reintroduced through its own fix. It must be able to say "I could not
 *   derive this."
 *
 * A command that matches no script basename is a SHORTFALL, not a skip: it means
 * settings.json grew a shape this parser does not read, and the honest answer is
 * null rather than a population silently missing that hook. Same rule, and the
 * same reasoning, as `parsePrecommitStepNames` (`./precommit-step-names.ts`).
 */
function parseSettingsEvents(): Map<string, string> | null {
  const settingsPath = join(REPO_ROOT, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return null;

  let settings: { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return null;
  }

  const events = new Map<string, string>();
  let commands = 0;
  let named = 0;
  for (const [event, matchers] of Object.entries(settings.hooks ?? {})) {
    for (const matcher of matchers) {
      for (const hook of matcher.hooks ?? []) {
        if (typeof hook.command !== "string") continue;
        commands++;
        const basename = hook.command.match(SCRIPT_BASENAME)?.[1];
        if (!basename) continue;
        named++;
        events.set(basename, event);
      }
    }
  }

  if (commands === 0 || named < commands) return null;
  return events;
}

/**
 * Script basename -> harness event, empty when underivable.
 *
 * The lenient face of `parseSettingsEvents`, for the point-resolution path whose
 * contract already reports an underivable point as a gap.
 */
function readSettingsEvents(): Map<string, string> {
  return parseSettingsEvents() ?? new Map();
}

/** `STANDALONE_SCRIPT_ALIASES` inverted: script basename -> canonical guard name. */
const GUARD_NAME_BY_SCRIPT: ReadonlyMap<string, string> = new Map(
  Object.entries(STANDALONE_SCRIPT_ALIASES).map(([guardName, script]) => [script, guardName])
);

/**
 * Every guard name REGISTERED in `.claude/settings.json`, or null when the
 * derivation failed (mt#4129).
 *
 * This is the population half of the same read. Registration is what decides
 * whether something runs at a lifecycle point; fire-logging is a downstream
 * behavior of only some members, so a population defined by fire-log presence
 * omits every hook that decides quietly — 30 of them, measured 2026-08-16, at 13
 * events the catalog's own divergence check reported no discrepancy about.
 *
 * Names are alias-resolved through the INVERSE of `STANDALONE_SCRIPT_ALIASES`
 * rather than a second alias map: two copies of one declaring fact is the drift
 * this module's header exists to prevent, and the inverse is derived, not
 * restated.
 */
export function readSettingsHookNames(): readonly string[] | null {
  const events = parseSettingsEvents();
  if (!events) return null;
  const names = new Set<string>();
  for (const script of events.keys()) {
    names.add(GUARD_NAME_BY_SCRIPT.get(script) ?? script);
  }
  return [...names].sort();
}

/** Read the three declaring sources the resolver derives an interception point from. */
export function buildCoordinateResolutionInput(): CoordinateResolutionInput {
  const registryEvents = new Map<string, string>();
  for (const reg of GUARD_REGISTRY) registryEvents.set(reg.name, reg.event);

  const strata = new Map<string, string>();
  for (const [name, desc] of INTERCEPTOR_DESCRIPTIONS) strata.set(name, desc.stratum);

  return { registryEvents, settingsEvents: readSettingsEvents(), strata };
}
