#!/usr/bin/env bun
/**
 * Fail when a hook registered in `.claude/settings.json` does not reach the
 * interceptor catalog as a PLACED entry (mt#4129).
 *
 * ## What this checks, and why not the obvious thing
 *
 * The obvious check — "is every registered hook in the oracle population?" —
 * **cannot fail**, and writing it would be the defect this task exists to
 * remove, rebuilt as its own fix. `collectOracleNames()` now unions the
 * settings-derived names IN, so comparing registered names against the oracle
 * compares a set against itself: `undeclared` is empty by construction, for a
 * healthy corpus and a broken one alike. A probe that returns the same result
 * when the system is broken is not verification (mem#704).
 *
 * What CAN still go wrong is the failure that produced mt#4129 in the first
 * place: a hook is registered at an event the model cannot represent, so
 * `derivePoint`'s `POINTS` gate drops it, and the entry lands with `point: null`
 * — present in the catalog, absent from every point-faceted view, and reported
 * as no divergence because both divergence lists are about DESCRIPTIONS. Six
 * events sat outside `POINTS` that way. So the check is: every registered hook
 * has an entry, and that entry has a resolved point.
 *
 * An unauthored DESCRIPTION or coordinate set IS a failure here, as of mt#4198.
 * It deliberately was not until then, and the reason was temporal rather than
 * principled: the 28 names on `declaredButNotDescribed` were mt#4198's own
 * queued work, so failing on them would have duplicated a live signal and
 * blocked CI for a reason someone was already acting on. That queue is now
 * empty, and the exclusion would otherwise have become permanent by default —
 * leaving the authoring pass verified exactly once, at the moment it landed,
 * with nothing to stop the NEXT settings-registered hook arriving blank.
 *
 * `deliberatelyUnauthored` entries are exempt, because for them the absence is
 * the authored answer (see `DELIBERATELY_UNAUTHORED_NAMES`) — a fire-log test
 * fixture and a name with no source module would both take fabricated
 * coordinates, which is what the coverage-gap posture exists to prevent.
 *
 * **Exits non-zero when the derivation itself fails**, rather than reporting a
 * clean sweep it did not perform — the mt#4196 shape (472 of 472 runs blind) is
 * what a checker that cannot read its input and says "all good" looks like.
 *
 * @see scripts/interceptor-coordinate-input.ts — `readSettingsHookNames`, the derivation
 * @see .minsky/hooks/interceptor-coordinates.ts — `POINTS`, the gate that drops an event
 * @see scripts/audit-interceptor-descriptions.ts — the sibling audit this matches in shape
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readSettingsHookNames } from "./interceptor-coordinate-input";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CATALOG_PATH = join(REPO_ROOT, "src", "generated", "interceptor-catalog.json");

interface CatalogEntry {
  guardName: string;
  point: string | null;
  undescribed?: boolean;
  coordinateGaps?: string[];
  deliberatelyUnauthored?: boolean;
}

function readCatalogEntries(): CatalogEntry[] | null {
  try {
    const parsed = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as { entries?: CatalogEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : null;
  } catch {
    return null;
  }
}

function main(): void {
  const registered = readSettingsHookNames();
  if (!registered) {
    console.error(
      "FAIL: could not derive hook registrations from .claude/settings.json.\n" +
        "  This is a hard failure, not an empty result: a population that cannot be read\n" +
        "  must not be reported as complete. Check the file exists and that every hook\n" +
        "  command still points at a `<name>.ts` script."
    );
    process.exit(1);
  }

  const entries = readCatalogEntries();
  if (!entries) {
    console.error(
      `FAIL: could not read the catalog at ${CATALOG_PATH}.\n` +
        "  Run `bun run build:interceptor-catalog` first."
    );
    process.exit(1);
    return;
  }

  const byName = new Map(entries.map((e) => [e.guardName, e]));
  const missing: string[] = [];
  const unplaced: string[] = [];
  const undescribed: string[] = [];
  const uncoordinated: string[] = [];

  for (const name of registered) {
    const entry = byName.get(name);
    if (!entry) {
      missing.push(name);
      continue;
    }
    if (entry.point === null) unplaced.push(name);
    if (entry.deliberatelyUnauthored === true) continue;
    if (entry.undescribed === true) undescribed.push(name);
    if ((entry.coordinateGaps ?? []).length > 0) {
      uncoordinated.push(`${name} (${(entry.coordinateGaps ?? []).join(", ")})`);
    }
  }

  if (
    missing.length === 0 &&
    unplaced.length === 0 &&
    undescribed.length === 0 &&
    uncoordinated.length === 0
  ) {
    console.log(
      `OK: all ${registered.length} settings-registered hook(s) have a catalog entry ` +
        `with a resolved point, an authored description, and a full coordinate set.`
    );
    return;
  }

  if (missing.length > 0) {
    const lines = missing.map((n) => `  MISSING: ${n}`).join("\n");
    console.error(`FAIL: ${missing.length} registered hook(s) have no catalog entry:\n${lines}`);
  }
  if (unplaced.length > 0) {
    const lines = unplaced.map((n) => `  UNPLACED: ${n}`).join("\n");
    console.error(
      `FAIL: ${unplaced.length} registered hook(s) have an entry but NO resolved ` +
        `interception point:\n${lines}\n\n` +
        `  The usual cause is an event that \`POINTS\` in ` +
        `.minsky/hooks/interceptor-coordinates.ts\n` +
        `  does not list, so the point is dropped and the hook disappears from every\n` +
        `  point-faceted view while the divergence lists stay empty. Add the event to\n` +
        `  \`POINTS\` and to all three \`InterceptionPoint\` unions, or author the coordinate.`
    );
  }
  if (undescribed.length > 0) {
    const lines = undescribed.map((n) => `  UNDESCRIBED: ${n}`).join("\n");
    console.error(
      `FAIL: ${undescribed.length} registered hook(s) have a catalog entry but NO ` +
        `authored description:\n${lines}\n\n` +
        `  Add an entry to .minsky/hooks/interceptor-descriptions-settings.ts, then\n` +
        `  re-run \`bun run build:interceptor-catalog\`. A registered hook nobody can\n` +
        `  read a description for is present in the catalog and useless in it.`
    );
  }
  if (uncoordinated.length > 0) {
    const lines = uncoordinated.map((n) => `  UNCOORDINATED: ${n}`).join("\n");
    console.error(
      `FAIL: ${uncoordinated.length} registered hook(s) are missing coordinates:\n${lines}\n\n` +
        `  Add an entry to .minsky/hooks/interceptor-coordinates.ts, then re-run\n` +
        `  \`bun run build:interceptor-catalog\`. An entry with no intervention type\n` +
        `  lands in no computed family, which renders identically to a hook that\n` +
        `  declares no capability at all.`
    );
  }
  process.exit(1);
}

main();
