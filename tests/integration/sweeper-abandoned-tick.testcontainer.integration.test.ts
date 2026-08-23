/**
 * mt#4335 SC1 — an abandoned sweeper tick must not strand its Postgres connection.
 *
 * `src/cockpit/sweepers.test.ts` pins the framework-level CAUSE (an abandoned
 * tick is not run concurrently with its successor) deterministically and with
 * no database. This file pins the CONSEQUENCE that SC1 actually names, against
 * a real Postgres: repeated induced tick timeouts must not accumulate backends.
 *
 * Why it needs a container rather than the production database: reproducing
 * this live means deliberately re-saturating the shared Supavisor pooler, which
 * is the outage this task exists to prevent. A throwaway Postgres gives the
 * same evidence — `pg_stat_activity` is `pg_stat_activity` — with no blast
 * radius.
 *
 * What the pre-fix behaviour looked like, and why the assertion is what it is:
 * releasing the `running` guard at `tickTimeoutMs` let the next tick start
 * beside an abandoned predecessor that still held a connection. Each cycle
 * added one. So the observable is that the count of sweep-attributable backends
 * stays at its floor across many cycles instead of climbing with them.
 *
 * Gate: TWO env vars, both required (matching the sibling saturation harness):
 *   RUN_INTEGRATION_TESTS=1
 *   RUN_TESTCONTAINER_TESTS=1
 *
 * Run:
 *   RUN_INTEGRATION_TESTS=1 RUN_TESTCONTAINER_TESTS=1 \
 *     bun test --preload ./tests/setup.ts --timeout=180000 \
 *       tests/integration/sweeper-abandoned-tick.testcontainer.integration.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import { GenericContainer, type WaitStrategy } from "testcontainers";
import postgres from "postgres";
import { createIntervalSweeper, getSweepLivenessSnapshot } from "../../src/cockpit/sweepers";

/**
 * No-op wait strategy — every built-in testcontainers strategy hangs under Bun
 * (docker-socket/child_process polling incompatibility). Readiness is instead
 * established by the SQL probe below. Copied deliberately from
 * `postgres-pool-saturation.testcontainer.integration.test.ts` rather than
 * shared: that file's copy is load-bearing for a different suite, and coupling
 * the two through a new export would make either one's bring-up changes break
 * the other.
 */
function makeNoOpWaitStrategy(defaultTimeoutMs: number): WaitStrategy {
  let storedTimeoutMs: number | undefined;
  const strategy: WaitStrategy = {
    async waitUntilReady() {
      // Intentionally empty — readiness is the SQL probe below.
    },
    withStartupTimeout(timeoutMs: number) {
      storedTimeoutMs = timeoutMs;
      return strategy;
    },
    isStartupTimeoutSet() {
      return storedTimeoutMs !== undefined;
    },
    getStartupTimeout() {
      return storedTimeoutMs ?? defaultTimeoutMs;
    },
  };
  return strategy;
}

const POSTGRES_IMAGE = "postgres:16-alpine";

/** Marker embedded in the tick's SQL so `pg_stat_activity` rows are attributable. */
const SWEEP_QUERY_MARKER = "mt4335_abandoned_tick_probe";

/**
 * Timings, chosen against the two deadlines rather than picked round.
 *
 * The tick must overrun `TICK_TIMEOUT_MS` (so it IS abandoned) while settling
 * inside `TICK_TIMEOUT_MS * ABANDONED_TICK_HARD_RELEASE_MULTIPLIER` (3x = 3s),
 * so this measures the settle path rather than the watchdog's force-release.
 * 1s / 2s / 3s leaves a full second of margin either side, which matters here
 * because container round-trips are far noisier than the unit test's timers.
 */
const TICK_TIMEOUT_MS = 1_000;
const TICK_SLEEP_SECONDS = 2;
const INTERVAL_MS = 400;
/** Enough cycles that a per-cycle leak would be unmistakable (pre-fix: ~1 each). */
const MIN_ABANDONMENTS = 5;

if (process.env.RUN_INTEGRATION_TESTS && process.env.RUN_TESTCONTAINER_TESTS) {
  process.stdout.write(`[mt4335/testcontainer] starting ${POSTGRES_IMAGE}\n`);

  const container = await new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({
      POSTGRES_PASSWORD: "postgres",
      POSTGRES_USER: "postgres",
      POSTGRES_DB: "postgres",
    })
    .withExposedPorts(5432)
    .withWaitStrategy(makeNoOpWaitStrategy(120_000))
    .withStartupTimeout(120_000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const connectionString = `postgresql://postgres:postgres@${host}:${port}/postgres`;

  // SQL-level readiness probe (the built-in strategies hang under Bun).
  // eslint-disable-next-line custom/no-real-fs-in-tests -- Date.now() is a timing deadline, not a path
  const probeDeadline = Date.now() + 60_000;
  let ready = false;
  // eslint-disable-next-line custom/no-real-fs-in-tests -- same: timing, not path construction
  while (Date.now() < probeDeadline) {
    try {
      const probe = postgres(connectionString, { max: 1, prepare: false, connect_timeout: 2 });
      try {
        await probe`SELECT 1`;
        ready = true;
        break;
      } finally {
        await probe.end().catch(() => {});
      }
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!ready) {
    await container.stop().catch(() => {});
    throw new Error(`[mt4335/testcontainer] readiness probe timed out at ${host}:${port}`);
  }
  process.stdout.write(`[mt4335/testcontainer] ready at ${host}:${port}\n`);

  describe("mt#4335 SC1 — an abandoned tick does not strand its connection", () => {
    afterAll(async () => {
      await container.stop().catch(() => {});
    });

    test("repeated induced tick timeouts do not accumulate backends", async () => {
      // Generous pool: if the fix regressed, the leak must be free to show as
      // accumulation rather than being masked by the pool refusing to grow.
      const sql = postgres(connectionString, { max: 10, prepare: false });
      // Separate observer connection so sampling never competes for the pool
      // the sweep is using — a shared pool would let the sampler itself be the
      // thing that blocks, and the measurement would describe the sampler.
      const observer = postgres(connectionString, { max: 1, prepare: false });

      const samples: number[] = [];
      let ticks = 0;
      let snap: ReturnType<typeof getSweepLivenessSnapshot>[number] | undefined;

      const countProbeBackends = async (): Promise<number> => {
        const rows = await observer<{ n: number }[]>`
          SELECT count(*)::int AS n
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND query LIKE ${`%${SWEEP_QUERY_MARKER}%`}
            AND query NOT LIKE '%pg_stat_activity%'
            -- The state filter is load-bearing, not tidying. pg_stat_activity
            -- reports a backend's LAST query, not its current one, so a
            -- connection returned to the pool still matches the marker
            -- indefinitely. Without this the count answers "backends that ever
            -- ran a probe" while reading as "probes in flight" — the first cut
            -- of this test failed its own teardown assertion for exactly that
            -- reason. A stranded ClientRead backend reports state='active',
            -- which is what SC1 is about, so this excludes nothing it needs.
            AND state <> 'idle'
        `;
        return rows[0]?.n ?? 0;
      };

      const stop = createIntervalSweeper({
        name: "mt4335-abandoned-tick-probe",
        intervalMs: INTERVAL_MS,
        tickTimeoutMs: TICK_TIMEOUT_MS,
        tick: async (signal: AbortSignal) => {
          ticks++;
          // The marker makes this row attributable in pg_stat_activity. The
          // sleep is what overruns the tick budget.
          // The marker rides in a SQL COMMENT, not as a bound parameter. With
          // `prepare: false` a parameter reaches `pg_stat_activity.query` as
          // `$2`, so a LIKE on the marker matches nothing — the first cut of
          // this test measured 0 backends for exactly that reason and reported
          // a flat series that proved nothing. A comment is part of the query
          // TEXT and is what the catalog actually shows.
          const q = sql`SELECT pg_sleep(${TICK_SLEEP_SECONDS}) /* ${sql.unsafe(SWEEP_QUERY_MARKER)} */`;
          // Honour the framework's cancellation channel (mt#4335). postgres-js
          // routes this to a protocol-level CancelRequest.
          const onAbort = () => {
            void (q as unknown as { cancel: () => void }).cancel();
          };
          signal.addEventListener("abort", onAbort, { once: true });
          try {
            await q;
          } catch {
            // A cancelled query rejects with 57014 — expected on the abandoned
            // path, and not a test failure.
          } finally {
            signal.removeEventListener("abort", onAbort);
          }
          // mt#4412: this probe's tick is ABOUT abandonment, so the value here
          // is never actually read on the path under test — an abandoned tick
          // is scored before it settles. Stated explicitly rather than left to
          // a bare fallthrough.
          return { ok: true };
        },
      });

      try {
        // Sample while the sweep runs. A per-cycle leak shows up as a rising
        // series; the fix keeps it flat at its floor.
        const started = performance.now();
        while (performance.now() - started < 12_000) {
          samples.push(await countProbeBackends());
          await new Promise((r) => setTimeout(r, 250));
        }
        // Read the snapshot BEFORE stopping. `getSweepLivenessSnapshot`
        // deliberately filters stopped entries out of the public payload, so a
        // read after `stop()` returns undefined and every counter assertion
        // below silently degrades to "undefined ?? 0" — which is how the first
        // cut of this test reported abandoned=undefined.
        snap = getSweepLivenessSnapshot().find((s) => s.name === "mt4335-abandoned-tick-probe");
      } finally {
        stop();
      }

      process.stdout.write(
        `[mt4335/testcontainer] ticks=${ticks} abandoned=${snap?.abandonedTicks} ` +
          `hardReleases=${snap?.abandonedTickHardReleases} ` +
          `maxBackends=${Math.max(...samples)} samples=${JSON.stringify(samples)}\n`
      );

      // The run must actually have exercised the abandonment path — otherwise
      // a flat series proves nothing (mem#704: a probe that cannot fail is not
      // verification).
      expect(snap?.abandonedTicks ?? 0).toBeGreaterThanOrEqual(MIN_ABANDONMENTS);

      // SC1: no accumulation. At most one probe query is in flight at a time,
      // because an abandoned tick keeps the guard until it settles. Pre-fix
      // this climbed with the cycle count.
      expect(Math.max(...samples)).toBeLessThanOrEqual(1);

      // And nothing is left behind once the sweep stops.
      await new Promise((r) => setTimeout(r, 2_500));
      expect(await countProbeBackends()).toBe(0);

      await sql.end({ timeout: 5 }).catch(() => {});
      await observer.end({ timeout: 5 }).catch(() => {});
    }, 120_000);
  });
} else {
  const missing: string[] = [];
  if (!process.env.RUN_INTEGRATION_TESTS) missing.push("RUN_INTEGRATION_TESTS=1");
  if (!process.env.RUN_TESTCONTAINER_TESTS) missing.push("RUN_TESTCONTAINER_TESTS=1");
  process.stdout.write(`[mt4335/testcontainer] skipped — set ${missing.join(", ")} to run\n`);
}
