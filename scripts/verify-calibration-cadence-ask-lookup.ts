#!/usr/bin/env bun
/**
 * Live verification for mt#3270, re-pointed at mt#3744's seam — the ask-state PRODUCER
 * against the REAL ask store, then the CONSUMER reading back what it wrote.
 *
 * The unit tests inject both halves, so they prove the formatter branches and the snapshot
 * shape and nothing about the binding. That is precisely the gap mt#3019 / mt#3046 turned into
 * two dead hooks: a persistence path throws, the failure is swallowed, and the surface renders
 * a plausible "nothing to report" forever.
 *
 * mt#3744 moved the database read out of the hook (ADR-028 D7(5)) and into the cockpit sweep,
 * so the binding that has to be exercised live is now `refreshAskStateCache` — and the hook's
 * own read is a local file, which is the point. This script therefore checks the WHOLE chain:
 * real SQL -> snapshot file -> `readAskStateCache` -> `resolveAskStates`.
 *
 * The check is a NEGATIVE CONTROL by construction: if the producer's binding is dead it writes
 * nothing, the consumer reports `absent`, and this script FAILS. It cannot pass without a
 * working end-to-end path.
 *
 *   bun scripts/verify-calibration-cadence-ask-lookup.ts
 *
 * Env: a configured Minsky database. Skips (exit 0) when the store is unreachable — an
 * unconfigured CI runner is not a regression — but says so explicitly rather than passing.
 *
 * Exit: 0 = pass or documented skip, non-zero = fail.
 */

// Must precede every other import: resolving the persistence provider goes through tsyringe,
// which needs the polyfill installed at the entry point. Without it this script reported
// "no raw-SQL connection available" — a script-side defect that read as a missing database.
import "reflect-metadata";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  readAskStateCache,
  resolveAskStates,
} from "../.minsky/hooks/calibration-review-cadence-detector";
import { refreshAskStateCache, type UnsafeSql } from "../src/cockpit/ask-state-cache";

/** ask#5425 — responded and closed 2026-07-23T21:03:10.616Z. The incident's own ask. */
const KNOWN_SETTLED_ASK = "109807e1-0ec6-49ff-9759-805a1bb02a64";
/** A well-formed uuid that cannot exist, exercising the not-found branch against a live store. */
const ABSENT_ASK = "00000000-0000-4000-8000-000000000000";

function fail(msg: string, detail?: unknown): never {
  console.error(`FAIL: ${msg}`);
  if (detail !== undefined) console.error(JSON.stringify(detail, null, 2));
  process.exit(1);
}

/**
 * Persistence symbols the detector must no longer name (mt#3744). This is the source-level
 * half of the structural regression; its unit-test half asserts that the per-turn functions
 * are synchronous. It lives HERE rather than in the test file because
 * `custom/no-real-fs-in-tests` forbids a test from reading source off disk.
 */
const FORBIDDEN_PERSISTENCE_SYMBOLS = [
  "resolvePersistenceProvider",
  "ensureHookDomainBootstrap(",
  "DrizzleAskRepository",
  "@minsky/domain/persistence/factory",
  "@minsky/domain/ask/repository",
];

/**
 * Strip line and block comments so the prose EXPLAINING why these symbols are gone — which
 * necessarily names every one of them — cannot decide this check. Deliberately crude: it is
 * scanning for identifiers, not parsing TypeScript, and erring toward stripping too much can
 * only produce a false PASS on a comment, never a false FAIL on code.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Assert the detector's source names no persistence symbol. Runs unconditionally — including
 * on the no-database SKIP path below — because it needs no database and is the check most
 * likely to catch a regression that reintroduces the live read.
 */
function checkNoPersistenceSymbols(): void {
  const detectorPath = join(
    dirname(import.meta.dir),
    ".minsky",
    "hooks",
    "calibration-review-cadence-detector.ts"
  );
  const code = stripComments(String(readFileSync(detectorPath, "utf-8")));
  const found = FORBIDDEN_PERSISTENCE_SYMBOLS.filter((symbol) => code.includes(symbol));
  if (found.length > 0) {
    fail(
      "the detector's per-turn path names persistence symbols again — the ADR-028 D7(5) fix has regressed",
      { detectorPath, found }
    );
  }
}

/**
 * Resolve the provider's raw-SQL accessor exactly as `startAskStateRefreshSweeper` does.
 *
 * Returns the REASON on failure rather than a bare null. Swallowing it would make "this
 * environment has no database" indistinguishable from "the accessor is broken" — the exact
 * looks-like-nothing-to-do failure shape this task exists to remove, reproduced in the script
 * that is supposed to detect it.
 */
async function resolveRawSql(): Promise<{ sql: UnsafeSql } | { reason: string }> {
  try {
    // The cockpit process initializes configuration during boot before any sweeper runs; a
    // standalone script has to do it itself, exactly as `scripts/asks-backlog-triage.ts` does.
    const { initializeConfiguration, CustomConfigFactory } = await import(
      "@minsky/domain/configuration"
    );
    await initializeConfiguration(new CustomConfigFactory(), {
      workingDirectory: process.cwd(),
    });

    const { getSharedPersistenceService } = await import("../src/cockpit/shared-persistence");
    const svc = await getSharedPersistenceService();
    const provider = svc.getProvider();
    if (
      !("getRawSqlConnection" in provider) ||
      typeof (provider as { getRawSqlConnection?: unknown }).getRawSqlConnection !== "function"
    ) {
      return { reason: `provider ${provider.constructor.name} exposes no getRawSqlConnection` };
    }
    return {
      sql: (await (
        provider as { getRawSqlConnection: () => Promise<unknown> }
      ).getRawSqlConnection()) as UnsafeSql,
    };
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) };
  }
}

async function main(): Promise<number> {
  // First, and independent of any database: the structural regression.
  checkNoPersistenceSymbols();

  // A temp cache path, never the real one: this script must not blank or backdate the snapshot
  // a running cockpit maintains for live turns.
  const cachePath = join(mkdtempSync(join(tmpdir(), "mt3744-verify-")), "ask-state-cache.json");
  const askIds = [KNOWN_SETTLED_ASK, ABSENT_ASK];

  const resolved = await resolveRawSql();
  if ("reason" in resolved) {
    console.log(
      JSON.stringify(
        {
          result: "SKIP",
          reason: `no raw-SQL connection available: ${resolved.reason}`,
          structuralCheck: "PASS — detector source names no persistence symbol",
        },
        null,
        2
      )
    );
    return 0;
  }

  const wrote = await refreshAskStateCache(
    resolved.sql,
    askIds,
    new Date().toISOString(),
    cachePath
  );
  if (!wrote) {
    console.log(
      JSON.stringify(
        { result: "SKIP", reason: "producer could not read the ask store; nothing written" },
        null,
        2
      )
    );
    return 0;
  }

  // The consumer half, timed: SC5 asks for the per-turn cost to be recorded as a measurement
  // rather than asserted. This is the entire per-turn cost of the lookup after mt#3744.
  const startedNs = process.hrtime.bigint();
  const lookups = resolveAskStates(readAskStateCache(cachePath), askIds, Date.now());
  const consumerMs = Number(process.hrtime.bigint() - startedNs) / 1e6;

  const settled = lookups.get(KNOWN_SETTLED_ASK);
  const absent = lookups.get(ABSENT_ASK);
  const summary = { [KNOWN_SETTLED_ASK]: settled, [ABSENT_ASK]: absent };

  if (settled?.kind !== "settled") {
    fail(
      `expected ${KNOWN_SETTLED_ASK} (closed 2026-07-23) to resolve as "settled", got "${settled?.kind}"`,
      summary
    );
  }
  if (settled.state !== "closed") {
    fail(`expected the known ask to report state "closed", got "${settled.state}"`, summary);
  }
  if (absent?.kind !== "not-found") {
    fail(`expected a nonexistent uuid to resolve as "not-found", got "${absent?.kind}"`, summary);
  }

  console.log(
    JSON.stringify(
      {
        result: "PASS",
        note: "producer wrote a live snapshot; consumer read it back and distinguished a real closed ask from a nonexistent one",
        structuralCheck: "PASS — detector source names no persistence symbol",
        consumerReadMs: Number(consumerMs.toFixed(3)),
        summary,
      },
      null,
      2
    )
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
