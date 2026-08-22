#!/usr/bin/env bun
/**
 * Live verification for mt#4361's ask age signal.
 *
 * `openStateAgeStats` is a new SQL path — a per-state COALESCE over four
 * timestamp columns plus a FILTER aggregate — and its hermetic tests exercise
 * `FakeAskRepository`, which reimplements those semantics in TypeScript. Two
 * implementations of one meaning: the tests can be green while the Postgres
 * query is wrong. This script runs the REAL query against the configured
 * database and checks it against `countByState`, which is separately known to
 * work.
 *
 * **The check that can actually fail.** A broken query — wrong column, wrong
 * GROUP BY, an aggregate over an empty join — returns no rows, and the result
 * builder then hands back the zero-filled default: every `oldestAgeMs` null,
 * every `stalledCount` 0. That is byte-identical to a genuinely empty database.
 * So the assertion is a CROSS-CHECK rather than a shape check: for every open
 * state `countByState` reports a nonzero count for, `oldestAgeMs` must be
 * non-null, and vice versa. Printing the numbers and eyeballing them would pass
 * against exactly the failure this exists to catch.
 *
 * Read-only: it issues two SELECTs and writes nothing.
 *
 * Usage:
 *   bun scripts/verify-ask-age-stats.ts
 *
 * Exit codes:
 *   0 — checked, consistent (or SKIP: no SQL-capable persistence configured)
 *   1 — checked, INCONSISTENT (the cross-check failed)
 *   2 — the check did not complete (bootstrap error) — never conflated with a pass
 *
 * @see mt#4361
 */

import "reflect-metadata";

import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";

const DAY_MS = 24 * 60 * 60 * 1000;

interface Finding {
  state: string;
  count: number;
  oldestAgeMs: number | null;
  problem: string;
}

async function main(): Promise<number> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
  const { DrizzleAskRepository } = await import("@minsky/domain/ask/repository");
  const { DEFAULT_ASK_STALL_THRESHOLD_MS } = await import(
    "@minsky/domain/ask/state-counts-provider"
  );
  const { OPEN_ASK_STATES } = await import("@minsky/domain/ask/state-machine");

  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (
    !persistence ||
    !(persistence instanceof PersistenceProvider) ||
    !persistence.capabilities.sql ||
    typeof persistence.getDatabaseConnection !== "function"
  ) {
    // Not a failure: a developer without Postgres configured should not get a
    // red build from a verification script.
    console.log("SKIP: no SQL-capable persistence provider configured.");
    return 0;
  }

  const connection = await (persistence as SqlCapablePersistenceProvider).getDatabaseConnection();
  if (!connection) {
    console.log("SKIP: SQL-capable provider has no initialized connection.");
    return 0;
  }

  const repo = new DrizzleAskRepository(connection);
  const nowMs = Date.now();

  const [byState, ageByState] = await Promise.all([
    repo.countByState(),
    repo.openStateAgeStats({ nowMs, stallThresholdMs: DEFAULT_ASK_STALL_THRESHOLD_MS }),
  ]);

  const findings: Finding[] = [];
  for (const state of OPEN_ASK_STATES) {
    const count = byState[state] ?? 0;
    const { oldestAgeMs, stalledCount } = ageByState[state];

    if (count > 0 && oldestAgeMs === null) {
      findings.push({
        state,
        count,
        oldestAgeMs,
        problem: "countByState reports rows but the age query produced none for this state",
      });
    }
    if (count === 0 && oldestAgeMs !== null) {
      findings.push({
        state,
        count,
        oldestAgeMs,
        problem: "the age query produced a row for a state countByState reports as empty",
      });
    }
    if (stalledCount > count) {
      findings.push({
        state,
        count,
        oldestAgeMs,
        problem: `stalledCount (${stalledCount}) exceeds the total in this state`,
      });
    }
  }

  console.log(
    JSON.stringify(
      {
        checkedAt: new Date(nowMs).toISOString(),
        stallThresholdMs: DEFAULT_ASK_STALL_THRESHOLD_MS,
        stallThresholdDays: DEFAULT_ASK_STALL_THRESHOLD_MS / DAY_MS,
        byState,
        ageByState: Object.fromEntries(
          OPEN_ASK_STATES.map((s) => {
            // Bound to a local so the null check narrows it — a repeated
            // `ageByState[s].oldestAgeMs` does not, and reaching for `!` to
            // paper over that is a warning this repo treats as unshippable.
            const stats = ageByState[s];
            return [
              s,
              {
                ...stats,
                oldestAgeDays:
                  stats.oldestAgeMs === null
                    ? null
                    : Number((stats.oldestAgeMs / DAY_MS).toFixed(2)),
              },
            ];
          })
        ),
        crossCheck: findings.length === 0 ? "consistent" : "INCONSISTENT",
        findings,
      },
      null,
      2
    )
  );

  return findings.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Exit 2, never 1: "the check did not run" must not read as "the check failed".
    console.error("verify-ask-age-stats: check did not complete —", err);
    process.exit(2);
  });
