#!/usr/bin/env bun
//
// Audit the interceptor COORDINATE store against the REAL sources and the REAL
// fire log — mt#4038. Sibling of `audit-interceptor-descriptions.ts`, which
// audits the description half of the same per-entity data.
//
// The test suite (`.minsky/hooks/interceptor-coordinates.test.ts`) resolves
// against the DECLARED population and injected fixtures. That leaves the claims
// whose subject is the live world, which only this script can settle:
//
//   AT1  — every distinct `guardName` in the LIVE fire log resolves to an
//          interception point, a non-empty capability set, a mechanism and a
//          role — or is on the deliberately-unauthored list, reported by name.
//          Zero silent defaults.
//   SC2  — every effect any declaring source names is mapped to an ontology
//          intervention type, so no consumer has to invent the translation.
//   AT3  — every authored entity lands in at least one computed family or is
//          explicitly out-of-model. Nothing is silently familyless.
//
// Exits non-zero when any claim fails, so it can be wired into CI later.
//
// Usage:
//   bun scripts/audit-interceptor-coordinates.ts
//   bun scripts/audit-interceptor-coordinates.ts --json
//
// The fire log lives outside the repo (`$MINSKY_STATE_DIR` or
// `~/.local/state/minsky/fire-log.jsonl`) and is tens of megabytes, so it is
// streamed line-by-line and its absence is reported as SKIPPED rather than
// failing — a bare checkout has no fire log, and that is not a defect.

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { GUARD_REGISTRY } from "../.minsky/hooks/registry";
import { INTERCEPTOR_DESCRIPTIONS } from "../.minsky/hooks/interceptor-descriptions";
import {
  DELIBERATELY_UNAUTHORED_NAMES,
  INTERCEPTOR_COORDINATES,
  OUT_OF_MODEL_NAMES,
  classifyFamilies,
  familylessAuthoredNames,
  resolveCoordinates,
  unmappedEffects,
} from "../.minsky/hooks/interceptor-coordinates";
import { buildCoordinateResolutionInput } from "./interceptor-coordinate-input";

/**
 * The exception list, imported from the module that owns it rather than
 * restated here — see `DELIBERATELY_UNAUTHORED_NAMES` for why the copy that
 * used to live at this line was a drift hazard (PR #2914 R1).
 */
const DELIBERATELY_UNAUTHORED = new Set(DELIBERATELY_UNAUTHORED_NAMES);

function fireLogPath(): string {
  const stateDir = process.env["MINSKY_STATE_DIR"] ?? join(homedir(), ".local", "state", "minsky");
  return join(stateDir, "fire-log.jsonl");
}

/** Stream the fire log, collecting distinct `guardName` values. */
async function readFireLogNames(path: string): Promise<Set<string>> {
  const names = new Set<string>();
  let malformed = 0;
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as { guardName?: unknown };
      if (typeof record.guardName === "string") names.add(record.guardName);
    } catch {
      malformed++;
    }
  }
  if (malformed > 0) {
    process.stderr.write(`note: skipped ${malformed} unparseable fire-log line(s)\n`);
  }
  return names;
}

interface AuditResult {
  readonly fireLogPath: string;
  readonly fireLogRead: boolean;
  readonly populationSize: number;
  readonly populationSource: "fire-log" | "declared";
  /** Population names with a coordinate gap that are NOT deliberate exceptions. */
  readonly incomplete: string[];
  /** Population names not authored and not on the deliberate list. */
  readonly unauthored: string[];
  /** Deliberate exceptions actually seen in the population — reported, not hidden. */
  readonly knownUnauthored: string[];
  readonly unmapped: string[];
  readonly outOfModelDrift: string[];
  readonly familyCounts: Record<string, number>;
  readonly ok: boolean;
}

async function audit(): Promise<AuditResult> {
  const input = buildCoordinateResolutionInput();
  const path = fireLogPath();
  const fireLogRead = existsSync(path);

  const declared = new Set(INTERCEPTOR_DESCRIPTIONS.keys());
  const fromLog = fireLogRead ? await readFireLogNames(path) : new Set<string>();
  // Union, so a name in the log but not declared still gets audited rather than
  // dropped — the whole point of a fire-log-derived population.
  const population = fireLogRead ? new Set([...declared, ...fromLog]) : declared;

  const incomplete: string[] = [];
  const unauthored: string[] = [];
  const knownUnauthored: string[] = [];
  const familyCounts: Record<string, number> = {
    guard: 0,
    detector: 0,
    injector: 0,
    "out-of-model": 0,
    unclassified: 0,
  };
  const bump = (key: string): void => {
    familyCounts[key] = (familyCounts[key] ?? 0) + 1;
  };

  for (const name of [...population].sort()) {
    const resolved = resolveCoordinates(name, input);
    const classification = classifyFamilies(resolved);

    if (!INTERCEPTOR_COORDINATES.has(name)) {
      if (DELIBERATELY_UNAUTHORED.has(name)) knownUnauthored.push(name);
      else unauthored.push(name);
    } else if (resolved.gaps.length > 0) {
      incomplete.push(`${name}: ${resolved.gaps.join(",")}`);
    }

    if (classification.unclassified) bump("unclassified");
    else if (classification.outOfModel) bump("out-of-model");
    for (const family of classification.families) bump(family);
  }

  const declaredEffects = GUARD_REGISTRY.flatMap((reg) => reg.effects.map((e) => e.effect));
  const unmapped = unmappedEffects(declaredEffects);

  // The constant and the computation must agree, or the catalog's "explicitly
  // out of model" rendering is asserting something the data no longer says.
  const computed = familylessAuthoredNames();
  const expected = [...OUT_OF_MODEL_NAMES];
  const outOfModelDrift =
    computed.length === expected.length && computed.every((n, i) => n === expected[i])
      ? []
      : [`computed=[${computed.join(",")}] expected=[${expected.join(",")}]`];

  return {
    fireLogPath: path,
    fireLogRead,
    populationSize: population.size,
    populationSource: fireLogRead ? "fire-log" : "declared",
    incomplete,
    unauthored,
    knownUnauthored,
    unmapped,
    outOfModelDrift,
    familyCounts,
    ok:
      incomplete.length === 0 &&
      unauthored.length === 0 &&
      unmapped.length === 0 &&
      outOfModelDrift.length === 0,
  };
}

function report(result: AuditResult): void {
  const line = (s: string): void => void process.stdout.write(`${s}\n`);

  line("interceptor coordinate audit (mt#4038)");
  line("");

  if (!result.fireLogRead) {
    line(`     no fire log at ${result.fireLogPath} — auditing the DECLARED population`);
    line("     (expected in a bare checkout; the live arm needs a state dir)");
  }
  line(`     population : ${result.populationSize} (${result.populationSource})`);
  line("");

  const at1 = result.incomplete.length === 0 && result.unauthored.length === 0;
  line(`AT1  ${at1 ? "PASS" : "FAIL"} — every interceptor resolves all four coordinates`);
  for (const entry of result.incomplete) line(`       incomplete: ${entry}`);
  for (const name of result.unauthored) line(`       UNAUTHORED: ${name}`);
  line(`     deliberately unauthored, by name : ${result.knownUnauthored.length}`);
  for (const name of result.knownUnauthored) line(`       - ${name}`);

  line("");
  line(`SC2  ${result.unmapped.length === 0 ? "PASS" : "FAIL"} — every declared effect is mapped`);
  for (const effect of result.unmapped) line(`       - ${effect}`);

  line("");
  line(`AT3  ${result.outOfModelDrift.length === 0 ? "PASS" : "FAIL"} — family classification`);
  for (const [family, count] of Object.entries(result.familyCounts)) {
    line(`       ${family.padEnd(14)} ${count}`);
  }
  for (const drift of result.outOfModelDrift) line(`       DRIFT: ${drift}`);

  line("");
  line(result.ok ? "OK" : "FAILED");
}

const result = await audit();
if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  report(result);
}
process.exit(result.ok ? 0 : 1);
