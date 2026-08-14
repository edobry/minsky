#!/usr/bin/env bun
/**
 * Fire-log guard-name audit — mt#3756.
 *
 * Reports every `guardName` in the fire-log that does not resolve to a real
 * enforcement point. Exists because `fire-log.jsonl` is the substrate every
 * corpus-level enforcement metric is derived from, and nothing had ever
 * checked that its records came from guards that exist: 19 records written on
 * 2026-08-03 by five hand-rolled live-verification fixtures skewed the
 * override count and put a 100%-deny guard into the deny-rate distribution.
 *
 * Usage:
 *   bun scripts/audit-fire-log.ts              # human-readable report
 *   bun scripts/audit-fire-log.ts --json       # structured JSON
 *   bun scripts/audit-fire-log.ts --log <path> # audit a specific log file
 *
 * Exit code: 0 = no actionable unknowns; 1 = at least one name is genuinely
 * unrecognized, or a retired name has resumed firing. Declared fixture names
 * and retired names inside their recorded window are REPORTED but do not fail
 * the run — see `known-guard-names.ts` for why that split exists.
 *
 * This is a script, not a hook or a CI check, and the tier is deliberate: the
 * fire-log is operator-local state that exists on no CI runner, so a CI check
 * would assert over an empty file and pass vacuously. The half that CAN be
 * checked mechanically — the resolution and classification logic — is unit
 * tested in `.minsky/hooks/known-guard-names.test.ts`.
 *
 * @see mt#3756 — this task
 * @see .minsky/hooks/known-guard-names.ts — the oracle this wraps
 * @see .minsky/hooks/fire-log.ts — the log's schema and reader
 */

import { readFireLogEntries, getFireLogPath } from "../.minsky/hooks/fire-log";
import {
  FIXTURE_GUARD_NAMES,
  PRECOMMIT_STEP_NAMES,
  RETIRED_GUARD_NAMES,
  findUnknownGuardNames,
  hasActionableUnknowns,
  resolveKnownGuardNames,
  type UnknownGuardName,
} from "../.minsky/hooks/known-guard-names";
import { GUARD_REGISTRY } from "../.minsky/hooks/registry";
import { derivePrecommitStepNames } from "./precommit-step-names";

function classify(unknown: UnknownGuardName): string {
  if (unknown.retiredButRecent) return "RETIRED-BUT-RESUMED";
  if (RETIRED_GUARD_NAMES.has(unknown.guardName)) return "retired";
  if (unknown.knownFixture) return "known-fixture";
  return "UNRECOGNIZED";
}

function main(): void {
  const argv = process.argv.slice(2);
  const jsonMode = argv.includes("--json");
  const logFlagIndex = argv.indexOf("--log");
  const logPath =
    logFlagIndex >= 0 && argv[logFlagIndex + 1] ? argv[logFlagIndex + 1] : getFireLogPath();

  const repoRoot = process.env["CLAUDE_PROJECT_DIR"] ?? process.cwd();
  // Kept as the NULLABLE derive rather than `resolvePrecommitStepNames`, which
  // folds the fallback in: this script REPORTS which branch it took
  // (`precommitSource` below, and the "FELL BACK to snapshot" line), so it
  // needs to distinguish them.
  const derived = derivePrecommitStepNames(repoRoot);

  const entries = readFireLogEntries({ logPath });

  // The derived set REPLACES the snapshot; it is not unioned with it.
  // `resolveKnownGuardNames` uses `precommitNames ?? PRECOMMIT_STEP_NAMES`, so
  // passing a derived set suppresses the snapshot entirely — which is the
  // point: a step DELETED from pre-commit.ts must stop being "known", and a
  // union would keep it known forever. The snapshot is a fallback for when the
  // parse fails, not a floor under the derivation.
  //
  // The parse itself moved to `scripts/precommit-step-names.ts` (mt#4071) so
  // the catalog generator resolves against the same source this does; it
  // previously read the snapshot and omitted a step that had been firing for
  // days.
  //
  // Verified by execution, not by reading: with a synthetic pre-commit.ts
  // declaring only `fake-derived-step`, that name resolves and the
  // snapshot-only `eslint-validation` reports UNRECOGNIZED (known-name count
  // 53 = 32 registry + 1 derived + 20 standalone, with no snapshot
  // contribution). PR #2664 R1 read this as "derived names are never used";
  // this comment and the hoisted variable exist so the precedence is legible
  // without running it.
  const precommitNames = derived ?? PRECOMMIT_STEP_NAMES;

  const known = resolveKnownGuardNames({
    registryNames: GUARD_REGISTRY.map((r) => r.name),
    precommitNames,
  });

  const unknowns = findUnknownGuardNames(entries, known);
  const actionable = hasActionableUnknowns(unknowns);

  if (jsonMode) {
    process.stdout.write(
      `${JSON.stringify(
        {
          logPath,
          totalRecords: entries.length,
          knownNameCount: known.size,
          precommitSource: derived ? "derived" : "snapshot-fallback",
          unknowns: unknowns.map((u) => ({ ...u, classification: classify(u) })),
          actionable,
        },
        null,
        2
      )}\n`
    );
    process.exit(actionable ? 1 : 0);
  }

  console.log(`Fire-log: ${logPath}`);
  console.log(`Records:  ${entries.length}`);
  console.log(
    `Known names: ${known.size} (pre-commit set ${derived ? "derived from source" : "FELL BACK to snapshot"})`
  );

  if (derived === null) {
    console.log(
      "  ! Could not parse src/hooks/pre-commit.ts — a renamed step may show as unrecognized below."
    );
  }

  if (unknowns.length === 0) {
    console.log("");
    console.log("PASS — every guardName resolves to a current enforcement point.");
    process.exit(0);
  }

  console.log("");
  console.log("Unresolved guard names:");
  for (const u of unknowns) {
    const label = classify(u);
    const detail = u.knownFixture
      ? ` (incident ${FIXTURE_GUARD_NAMES.get(u.guardName)?.incident})`
      : RETIRED_GUARD_NAMES.has(u.guardName)
        ? ` (${RETIRED_GUARD_NAMES.get(u.guardName)?.note})`
        : "";
    console.log(
      `  [${label}] ${u.guardName} — ${u.count} record(s), ${u.firstSeen.slice(0, 10)} to ${u.lastSeen.slice(0, 10)}${detail}`
    );
  }

  console.log("");
  if (actionable) {
    console.log(
      "FAIL — at least one name is unrecognized, or a retired name resumed firing. " +
        "If a name is legitimate, add it to the right list in .minsky/hooks/known-guard-names.ts; " +
        "if it came from an ad-hoc harness, use scripts/run-dispatcher-scenario.ts instead (ADR-028 Phase 6)."
    );
  } else {
    console.log(
      "PASS — the only unresolved names are declared fixtures and retired steps inside their windows."
    );
  }

  process.exit(actionable ? 1 : 0);
}

main();
