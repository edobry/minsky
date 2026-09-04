#!/usr/bin/env bun
/**
 * Reconciles `.minsky/rules/hook-observers.mdc` (the operational roster) against
 * `src/generated/interceptor-catalog.json` (the generated enumeration) — mt#4393.
 *
 * WHY THIS NEEDS A MAP AND NOT A NAME MATCH. The roster labels entries in prose
 * (`- **Subagent model verification**`); the catalog keys on `guardName`
 * (`verify-subagent-model`). They share no key, and the relationship is many-to-one:
 * `Injection (per-turn)` documents four hooks, `Calibration (log-only)` four more. So a
 * count difference between the two populations measures nothing — mt#4393 was originally
 * filed on `63 - 50 = 13`, and the real figure under an actual join is different in both
 * magnitude and membership.
 *
 * WHICH POPULATION. The roster's own header scopes it: "NON-BLOCKING hooks: detectors,
 * injection, reminders, trackers — no decisions. Gates + compile workflow: `hook-files`."
 * In catalog terms that is `interventions` carrying no `deny`. It is NOT the computed
 * `detector`/`injector` families, which get it wrong in both directions — they include
 * merge gates (`require-execution-evidence-before-merge`) and exclude the recorders and
 * stampers the roster already documents (`families: []`, mem#1101's out-of-model class).
 * Non-blocking (98) + blocking (52) = 150, the catalog's whole population, so this
 * definition partitions the corpus with `hook-files.mdc` instead of overlapping it.
 *
 * Exit 0 = reconciled. Exit 1 = a gap. `--report` always exits 0 and just prints, which is
 * how this runs while the known backlog is still being written up.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { ROSTER_TO_GUARDS, ROSTER_EXEMPT } from "./observer-roster-map";

interface CatalogEntry {
  guardName: string;
  interventions?: Array<{ type?: string }>;
}

const REPO_ROOT = join(import.meta.dir, "..");
const ROSTER_PATH = join(REPO_ROOT, ".minsky/rules/hook-observers.mdc");
const CATALOG_PATH = join(REPO_ROOT, "src/generated/interceptor-catalog.json");

/** A roster entry's label, as written in the rule: `- **Label**`. */
export function parseRosterLabels(source: string): string[] {
  const body = source.split("---").slice(2).join("---");
  return [...body.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1] as string);
}

/** Non-blocking = no `deny` intervention. See the module docblock for why. */
export function isNonBlocking(entry: CatalogEntry): boolean {
  return !(entry.interventions ?? []).some((i) => i.type === "deny");
}

export interface ReconcileResult {
  /** Non-blocking catalog entries with neither a roster entry nor an exemption. */
  missingFromRoster: string[];
  /** Roster labels present in the rule but absent from the map. */
  unmappedLabels: string[];
  /**
   * Labels the map carries with an EMPTY guard list — a roster entry documenting something
   * the catalog does not enumerate. The inverse of `missingFromRoster`, and it must be its
   * own class: mapping a label to `[]` would otherwise satisfy `unmappedLabels` and pass,
   * which is a check that cannot fail for exactly the case it should catch.
   */
  labelsWithNoCatalogEntry: string[];
  /** Map keys naming a label the rule no longer contains. */
  staleMapLabels: string[];
  /** Map or exemption entries naming a `guardName` the catalog does not contain. */
  unknownGuardNames: string[];
  /** Roster entries pointing at a BLOCKING interceptor — those belong in hook-files.mdc. */
  blockingInRoster: string[];
  nonBlockingCount: number;
  rosterLabelCount: number;
}

export function reconcile(rosterSource: string, catalogEntries: CatalogEntry[]): ReconcileResult {
  const labels = parseRosterLabels(rosterSource);
  const labelSet = new Set(labels);
  const allNames = new Set(catalogEntries.map((e) => e.guardName));
  const nonBlocking = catalogEntries.filter(isNonBlocking).map((e) => e.guardName);
  const nonBlockingSet = new Set(nonBlocking);

  const mapped = new Set<string>();
  const unknownGuardNames: string[] = [];
  const blockingInRoster: string[] = [];
  for (const [label, guards] of Object.entries(ROSTER_TO_GUARDS)) {
    for (const g of guards) {
      mapped.add(g);
      if (!allNames.has(g)) unknownGuardNames.push(`${label} -> ${g}`);
      else if (!nonBlockingSet.has(g)) blockingInRoster.push(`${label} -> ${g}`);
    }
  }
  for (const g of Object.keys(ROSTER_EXEMPT)) {
    if (!allNames.has(g)) unknownGuardNames.push(`exempt -> ${g}`);
  }

  return {
    missingFromRoster: nonBlocking.filter((g) => !mapped.has(g) && !(g in ROSTER_EXEMPT)).sort(),
    unmappedLabels: labels.filter((l) => !(l in ROSTER_TO_GUARDS)).sort(),
    labelsWithNoCatalogEntry: labels
      .filter((l) => l in ROSTER_TO_GUARDS && (ROSTER_TO_GUARDS[l] ?? []).length === 0)
      .sort(),
    staleMapLabels: Object.keys(ROSTER_TO_GUARDS)
      .filter((l) => !labelSet.has(l))
      .sort(),
    unknownGuardNames: unknownGuardNames.sort(),
    blockingInRoster: blockingInRoster.sort(),
    nonBlockingCount: nonBlocking.length,
    rosterLabelCount: labels.length,
  };
}

function main(): void {
  const reportOnly = process.argv.includes("--report");
  const catalog = JSON.parse(String(readFileSync(CATALOG_PATH))) as { entries: CatalogEntry[] };
  const result = reconcile(String(readFileSync(ROSTER_PATH)), catalog.entries);

  console.log(
    `[observer-roster] ${result.rosterLabelCount} roster entries against ` +
      `${result.nonBlockingCount} non-blocking catalog entries ` +
      `(${Object.keys(ROSTER_EXEMPT).length} exempt)`
  );

  const sections: Array<[string, string[]]> = [
    ["non-blocking interceptors with no roster entry and no exemption", result.missingFromRoster],
    ["roster labels missing from the map", result.unmappedLabels],
    ["roster entries the catalog does not enumerate at all", result.labelsWithNoCatalogEntry],
    ["map labels the roster no longer contains", result.staleMapLabels],
    ["map/exemption entries naming an unknown guardName", result.unknownGuardNames],
    [
      "roster entries pointing at a BLOCKING interceptor (belongs in hook-files)",
      result.blockingInRoster,
    ],
  ];

  let failed = false;
  for (const [title, items] of sections) {
    if (items.length === 0) continue;
    failed = true;
    console.log(`\n  ${items.length} ${title}:`);
    for (const i of items) console.log(`    - ${i}`);
  }

  if (!failed) {
    console.log("[observer-roster] reconciled — no gaps.");
    process.exit(0);
  }
  if (reportOnly) {
    console.log("\n[observer-roster] --report: gaps printed, exiting 0.");
    process.exit(0);
  }
  process.exit(1);
}

if (import.meta.main) main();
