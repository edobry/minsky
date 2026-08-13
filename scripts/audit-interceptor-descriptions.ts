#!/usr/bin/env bun
//
// Audit the interceptor description store against the REAL repo and the REAL
// fire log — mt#4008.
//
// The test suite (`.minsky/hooks/interceptor-descriptions.test.ts`) is
// hermetic: it exercises the pure decision functions with injected inputs, so
// it runs in a bare checkout with no state dir. That leaves three claims whose
// subject is the live world, which only this script can settle:
//
//   AT2  — every distinct `guardName` in the LIVE fire log resolves to a
//          description or an explicit `undescribed` marker. Zero silent drops.
//          This is the arm that matters: the population is the fire log's, and
//          registry-derived authoring drops over half the corpus (mt#3754
//          falsifier (6)).
//   AT3  — every provenance pointer resolves to a file that exists on disk.
//   SC2  — every `FailureClass` in the union is documented in the ontology
//          page's table, so the module and the page cannot drift into two
//          vocabularies.
//
// Exits non-zero when any claim fails, so it can be wired into CI later.
//
// Usage:
//   bun scripts/audit-interceptor-descriptions.ts
//   bun scripts/audit-interceptor-descriptions.ts --json
//
// The fire log lives outside the repo (`$MINSKY_STATE_DIR` or
// `~/.local/state/minsky/fire-log.jsonl`) and is tens of megabytes, so it is
// streamed line-by-line and its absence is reported as SKIPPED rather than
// failing — a bare checkout has no fire log, and that is not a defect.

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { GUARD_REGISTRY } from "../.minsky/hooks/registry";
import {
  findMissingProvenance,
  findUndocumentedFailureClasses,
  resolveCatalogEntry,
  type RegistryFacts,
  type ResolveCatalogInput,
} from "../.minsky/hooks/interceptor-descriptions";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ONTOLOGY_PAGE = "docs/architecture/interceptors.md";

function fireLogPath(): string {
  const stateDir = process.env["MINSKY_STATE_DIR"] ?? join(homedir(), ".local", "state", "minsky");
  return join(stateDir, "fire-log.jsonl");
}

function buildInput(): ResolveCatalogInput {
  const registryFacts = new Map<string, RegistryFacts>();
  for (const r of GUARD_REGISTRY) {
    registryFacts.set(r.name, {
      tuningOwnership: r.tuningOwnership,
      hasAttentionCost: r.attentionCost !== undefined,
      hasCanary: r.canary !== undefined,
    });
  }
  return { registryFacts };
}

/** Stream the fire log, collecting distinct `guardName` values with counts. */
async function readFireLogNames(path: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let malformed = 0;
  for await (const line of rl) {
    if (line.trim() === "") continue;
    let name: unknown;
    try {
      name = (JSON.parse(line) as { guardName?: unknown }).guardName;
    } catch {
      // A truncated tail line is normal for an append-only log being written
      // concurrently; count it rather than aborting the whole audit.
      malformed += 1;
      continue;
    }
    if (typeof name !== "string" || name === "") continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  if (malformed > 0) {
    process.stderr.write(`note: skipped ${malformed} unparseable fire-log line(s)\n`);
  }
  return counts;
}

interface AuditResult {
  readonly fireLogPath: string;
  readonly fireLogRead: boolean;
  readonly distinctFireLogNames: number;
  readonly registryEntries: number;
  readonly registryCoveragePct: number;
  readonly undescribed: readonly string[];
  readonly missingProvenance: readonly string[];
  readonly undocumentedClasses: readonly string[];
  readonly unregisteredButDescribed: number;
  readonly ok: boolean;
}

async function audit(): Promise<AuditResult> {
  const input = buildInput();
  const path = fireLogPath();
  const fireLogRead = existsSync(path);

  const counts = fireLogRead ? await readFireLogNames(path) : new Map<string, number>();
  const names = [...counts.keys()].sort();

  const undescribed: string[] = [];
  let unregisteredButDescribed = 0;
  let registeredInPopulation = 0;
  for (const name of names) {
    const entry = resolveCatalogEntry(name, input);
    if (entry.registered) registeredInPopulation += 1;
    if (entry.undescribed) undescribed.push(name);
    else if (!entry.registered) unregisteredButDescribed += 1;
  }

  const missingProvenance = findMissingProvenance((p) => existsSync(join(REPO_ROOT, p)));

  const pagePath = join(REPO_ROOT, ONTOLOGY_PAGE);
  const undocumentedClasses = existsSync(pagePath)
    ? findUndocumentedFailureClasses(readFileSync(pagePath, "utf8"))
    : ["<ontology page missing>"];

  return {
    fireLogPath: path,
    fireLogRead,
    distinctFireLogNames: names.length,
    registryEntries: GUARD_REGISTRY.length,
    // Intersection-based, NOT `GUARD_REGISTRY.length / names.length`: the raw
    // ratio exceeds 100% whenever the observed population is a subset of the
    // registry, which is exactly what a scoped or synthetic log produces.
    registryCoveragePct:
      names.length === 0 ? 0 : Math.round((registeredInPopulation / names.length) * 100),
    undescribed,
    missingProvenance,
    undocumentedClasses,
    unregisteredButDescribed,
    ok:
      undescribed.length === 0 &&
      missingProvenance.length === 0 &&
      undocumentedClasses.length === 0,
  };
}

function report(result: AuditResult): void {
  const line = (s: string): void => void process.stdout.write(`${s}\n`);

  line("interceptor description audit (mt#4008)");
  line("");

  if (!result.fireLogRead) {
    line(`AT2  SKIPPED — no fire log at ${result.fireLogPath}`);
    line("     (expected in a bare checkout; the declared-population arm runs in the test suite)");
  } else {
    line(`AT2  ${result.undescribed.length === 0 ? "PASS" : "FAIL"} — live fire-log population`);
    line(`     distinct guardName values : ${result.distinctFireLogNames}`);
    line(
      `     GuardRegistration entries : ${result.registryEntries} ` +
        `(${result.registryCoveragePct}% of the population)`
    );
    line(`     described, no registry entry : ${result.unregisteredButDescribed}`);
    line(`     undescribed (silent drops) : ${result.undescribed.length}`);
    for (const name of result.undescribed) line(`       - ${name}`);
  }

  line("");
  line(`AT3  ${result.missingProvenance.length === 0 ? "PASS" : "FAIL"} — provenance resolution`);
  for (const m of result.missingProvenance) line(`       - ${m}`);

  line("");
  line(
    `SC2  ${result.undocumentedClasses.length === 0 ? "PASS" : "FAIL"} — ` +
      `every failure class documented in ${ONTOLOGY_PAGE}`
  );
  for (const c of result.undocumentedClasses) line(`       - ${c}`);

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
