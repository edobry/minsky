#!/usr/bin/env bun
/**
 * mt#4547 — does Supavisor reclaim a CLIENT slot whose socket we terminated?
 *
 * WHAT THIS ANSWERS, AND WHY THE OBVIOUS INSTRUMENT CANNOT. mt#4515 verified
 * the CLIENT side: our sockets do go away. It said nothing about the pooler's
 * own accounting, and the task was filed proposing to close that gap with
 * `pg_stat_activity`. That view cannot: Supabase's Performance Tuning guide
 * states "`pg_stat_activity` only exposes information on direct connections to
 * the database. Information on the number of connections to Supavisor is
 * available via the metrics endpoint," and a live read confirms it — every row
 * carries `application_name = 'Supavisor'` because those rows ARE the pooler's
 * BACKEND connections. `POOLER_CLIENT_BUDGET = 600` caps CLIENT connections,
 * a different quantity. So this script reads `supavisor_connections_active`
 * from the Supabase metrics endpoint instead (see `lib/supavisor-metrics.ts`).
 *
 * WHY TWO ARMS RATHER THAN FOUR POINTS. The freeze-proxy never propagates a
 * close upstream while frozen (`lib/freeze-proxy.ts`), so under freeze a
 * client-side terminate CANNOT reach Supavisor by construction. That is
 * faithful to production half-open — the network path is dead and our close
 * never arrives — but it means "does terminating release the slot?" is two
 * questions:
 *
 *   ARM A — the close PROPAGATES (ordinary, unfrozen pool). Supavisor sees the
 *     FIN. Expected: prompt reclaim. This is also the negative control (AT1)
 *     and the instrument-latency calibration: it measures how long the gauge
 *     takes to reflect a change we know we made.
 *
 *   ARM B — the close CANNOT propagate (frozen proxy = the production case).
 *     Supavisor cannot know the client is gone, so the slot is held until its
 *     own client-side timeout — a value Supabase's user docs do not document.
 *     The budget risk lives entirely here.
 *
 * RESOLUTION BOUND — MEASURED 2026-08-27, and much worse than the docs imply.
 * Supabase's guidance is to scrape once per minute "to match Supabase's refresh
 * cadence". That is true of the `node_*` and `pgbouncer_*` series; it is NOT
 * true of `supavisor_*`, which refresh on their own far slower cadence:
 *
 *   - The whole `supavisor_*` block sat BYTE-IDENTICAL across 12 consecutive
 *     polls spanning 15:44:07Z-15:48:04Z (~4 minutes), then stepped as a block.
 *     Two steps were observed in 6.5 minutes, so the cadence is ~4-5 min.
 *   - This is not merely "unchanged values": `supavisor_client_joins_ok` is a
 *     MONOTONIC COUNTER and it too was frozen, which a live counter on a busy
 *     pooler cannot be. It moved +192 and then +299 across the two steps.
 *   - Decisive separation: in one poll the `node_disk_*` series changed while
 *     the `supavisor_*` counters did not. Same payload, two different refresh
 *     cadences — so a fresh-looking scrape says nothing about supavisor
 *     freshness, and the payload carries NO staleness indicator (same shape as
 *     mem#597's frozen `get_logs` snapshot).
 *
 * RATE LIMIT. The endpoint returns HTTP 429 when polled much faster than once
 * a minute — the vendor's 60s guidance is enforced, not advisory. `--poll`
 * therefore defaults to 60 and should not be lowered.
 *
 * NOISE, AND WHY IT DEFEATS A SMALL DELTA. The gauge counts the WHOLE tenant
 * under `user="postgres"` — the shared MCP daemon, the cockpit and the Railway
 * services all land in the same series. Measured churn: ~44-68 client joins per
 * MINUTE, and `supavisor_connections_active` swung 87 -> 65 -> 88 between
 * consecutive refreshes (±23) while this script's own contribution was a
 * constant +10. **A 10-connection test signal is invisible inside that.** The
 * run samples the idle gauge first and reports the jitter band so the result
 * can be read against it — and the rise gate below REFUSES to render a verdict
 * when the signal never clears the noise.
 *
 * THE FIX FOR THAT IS A LABEL, NOT A BIGGER POOL. The series carry a `user`
 * label, and a distinct DB role gets its own near-zero-baseline series (the
 * existing `minsky_preview` role shows exactly 1). Connecting the harness as a
 * dedicated role would separate the signal completely. Creating that role is a
 * shared-state change and is not this script's to make — see the task.
 *
 * USAGE
 *   bun scripts/verify-supavisor-slot-reclaim.ts --baseline
 *   bun scripts/verify-supavisor-slot-reclaim.ts --arm a
 *   bun scripts/verify-supavisor-slot-reclaim.ts --arm b --samples 15 --interval 60
 *
 * Both arms exceed session_exec's 120s cap — run detached and tail the log
 * (mem#294):
 *   nohup bun scripts/verify-supavisor-slot-reclaim.ts --arm a \
 *     > /tmp/mt4547-arm-a.log 2>&1 &
 *
 * EXIT CODES
 *   0  the measurement completed (Arm B records what it saw; not an assertion)
 *   1  the harness failed — the pool never opened, or the gauge never moved for
 *      a change we know was real (a control that cannot fail measures nothing,
 *      mem#704)
 *   2  SKIP — no connection string or no Supabase access token configured
 *
 * OUTPUT. Socket counts, gauge readings and timings only. The connection string
 * and the access token are read into variables and never printed on any path;
 * the token is reported by LENGTH, per
 * `terminal-command-best-practices.mdc §Secret handling`.
 */
import { writeFile } from "node:fs/promises";
import {
  readPoolerConnectionString,
  upstreamTargetOf,
  proxyConnectionString,
  startFreezeProxy,
  type FreezeProxy,
} from "./lib/freeze-proxy";
import {
  resolveSupabaseAccessToken,
  readClientConnections,
  DEFAULT_PROJECT_REF,
  CLIENT_CONNECTIONS_METRIC,
  type ClientConnectionReading,
} from "./lib/supavisor-metrics";

// ── arguments ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const raw = args[i + 1];
  const n = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`ERROR: --${name} requires a positive number`);
    process.exit(1);
  }
  return n;
}
const armIndex = args.indexOf("--arm");
const arm = armIndex === -1 ? null : args[armIndex + 1];
const baselineOnly = args.includes("--baseline");
const POOL_SIZE = flag("pool-size", 8);
const SAMPLES = flag("samples", 15);
const INTERVAL_SECONDS = flag("interval", 60);
/** Idle samples taken before touching anything, to characterise jitter. */
const BASELINE_SAMPLES = flag("baseline-samples", 3);
/**
 * How often we ask the endpoint while watching for a transition.
 *
 * 60s, and do NOT lower it: the Management API returns HTTP 429 when polled
 * much faster (observed 2026-08-27 at a 10-20s cadence across two concurrent
 * probes). Polling faster buys nothing anyway — the `supavisor_*` series only
 * refresh every ~4-5 minutes.
 */
const POLL_SECONDS = flag("poll", 60);
/**
 * Give up waiting for a transition after this long.
 *
 * 420s, not the 60s the vendor's scrape guidance would suggest: measured on
 * 2026-08-27 the gauge held one value for 84s and then stepped, so the endpoint
 * lags real connection state by well over a minute. A timeout sized to the
 * documented cadence produces a false "never moved" — which is how this
 * script's own first run mis-reported its negative control.
 */
const TRANSITION_TIMEOUT_SECONDS = flag("transition-timeout", 420);
/** The pooler mode this task is about — `:6543`, what production queries use. */
const MODE = "transaction" as const;

if (!baselineOnly && arm !== "a" && arm !== "b") {
  console.error("ERROR: pass --arm a | --arm b | --baseline (see the docblock)");
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
function log(message: string): void {
  console.log(`[${nowIso()}] ${message}`);
}

// ── preconditions ───────────────────────────────────────────────────────────
const connectionString = await readPoolerConnectionString();
if (!connectionString) {
  console.log("SKIP: no persistence.postgres.connectionString configured");
  process.exit(2);
}
const token = await resolveSupabaseAccessToken();
if (!token) {
  console.log(
    "SKIP: no Supabase access token (SUPABASE_ACCESS_TOKEN, " +
      "MINSKY_SUPABASE_ACCESS_TOKEN, or supabase.accessToken in config.yaml)"
  );
  process.exit(2);
}
log(`token resolved (${token.length} chars); project ${DEFAULT_PROJECT_REF}`);

// Re-bind both guarded values. Narrowing from the `process.exit` guards above
// holds at module top level but NOT inside the function bodies below — a
// closure could in principle run later — so capturing them here is what keeps
// every use site free of a non-null assertion.
const POOLER_URL: string = connectionString;
const ACCESS_TOKEN: string = token;

/**
 * A reading whose gauge is known-present. Narrowing it in the TYPE is what lets
 * every call site below read `.connections` as a number without a non-null
 * assertion — the absent case is turned into a throw exactly once, here.
 */
interface GaugeReading extends ClientConnectionReading {
  connections: number;
}

/** Read the client-connection gauge, failing loudly if the metric is absent. */
async function readGauge(): Promise<GaugeReading> {
  const reading = await readClientConnections(ACCESS_TOKEN, { mode: MODE, nowIso: nowIso() });
  const { connections } = reading;
  if (connections === undefined) {
    throw new Error(
      `${CLIENT_CONNECTIONS_METRIC}{mode="${MODE}"} is absent from the scrape ` +
        `(${reading.sampleCount} samples parsed). The metric may have been renamed ` +
        `upstream — do NOT read this as zero connections.`
    );
  }
  return { ...reading, connections };
}

interface Transition {
  observed: boolean;
  afterSeconds: number | null;
  readings: GaugeReading[];
}

/**
 * Poll until `predicate` holds on a reading, or the transition timeout elapses.
 * Returns every reading taken, so a caller can report the trace rather than
 * only the verdict.
 */
async function waitForGauge(
  label: string,
  predicate: (connections: number) => boolean
): Promise<Transition> {
  const startedAt = Date.now();
  const readings: GaugeReading[] = [];
  while ((Date.now() - startedAt) / 1000 < TRANSITION_TIMEOUT_SECONDS) {
    const reading = await readGauge();
    readings.push(reading);
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    log(`  ${label}: ${reading.connections} (t+${elapsed}s)`);
    if (predicate(reading.connections)) {
      return { observed: true, afterSeconds: elapsed, readings };
    }
    await sleep(POLL_SECONDS * 1000);
  }
  return { observed: false, afterSeconds: null, readings };
}

/** Sample the idle gauge to characterise the tenant's background jitter. */
async function measureBaseline(): Promise<{
  readings: GaugeReading[];
  min: number;
  max: number;
  last: number;
}> {
  log(`sampling the idle gauge ${BASELINE_SAMPLES}x at ${POLL_SECONDS}s to characterise jitter`);
  const readings: GaugeReading[] = [];
  // Tracked in the loop rather than indexed off the end afterwards, so the
  // "last" value needs no bounds assertion.
  let last = 0;
  for (let i = 0; i < BASELINE_SAMPLES; i++) {
    const reading = await readGauge();
    readings.push(reading);
    last = reading.connections;
    log(`  baseline[${i}]: ${reading.connections}`);
    if (i < BASELINE_SAMPLES - 1) await sleep(POLL_SECONDS * 1000);
  }
  const values = readings.map((r) => r.connections);
  const min = Math.min(...values);
  const max = Math.max(...values);
  log(`baseline: min=${min} max=${max} jitter=±${max - min} (tenant-wide, mode=${MODE})`);
  return { readings, min, max, last };
}

// ── the pool under test ─────────────────────────────────────────────────────
type Sql = Awaited<ReturnType<typeof openPool>>["sql"];

async function openPool(proxy: FreezeProxy) {
  const postgres = (await import("postgres")).default;
  const sql = postgres(proxyConnectionString(POOLER_URL, proxy.port), {
    max: POOL_SIZE,
    connect_timeout: 10,
    idle_timeout: 0,
    prepare: false,
    onnotice: () => {},
  });
  return { sql };
}

async function fillPool(sql: Sql, proxy: FreezeProxy): Promise<number> {
  await Promise.all(
    Array.from({ length: POOL_SIZE }, () => sql`select pg_sleep(0)`.catch(() => {}))
  );
  const held = proxy.clientSocketCount();
  log(`pool filled: ${held} client socket(s) held by the proxy`);
  if (held === 0) {
    throw new Error("the proxy is holding no sockets — the pool never opened through it");
  }
  return held;
}

// ── results ─────────────────────────────────────────────────────────────────
const results: Record<string, unknown> = {
  task: "mt#4547",
  metric: CLIENT_CONNECTIONS_METRIC,
  mode: MODE,
  projectRef: DEFAULT_PROJECT_REF,
  poolSize: POOL_SIZE,
  pollSeconds: POLL_SECONDS,
  scrapeResolutionNote:
    "MEASURED 2026-08-27: the supavisor_* series refresh every ~4-5 min (not the 60s the " +
    "vendor documents for the payload as a whole), carry no staleness indicator, and the " +
    'endpoint 429s if polled much faster than 60s. Tenant churn under user="postgres" was ' +
    "~44-68 client joins/min with the gauge swinging ±23 between refreshes, so a delta " +
    "smaller than that is not resolvable in this series.",
  startedAt: nowIso(),
};

async function writeResults(name: string): Promise<void> {
  results["finishedAt"] = nowIso();
  const path = `scripts/${name}`;
  await writeFile(path, `${JSON.stringify(results, null, 2)}\n`);
  log(`results written to ${path}`);
}

// ── --baseline ──────────────────────────────────────────────────────────────
if (baselineOnly) {
  const baseline = await measureBaseline();
  results["baseline"] = baseline;
  await writeResults("supavisor-slot-reclaim-baseline.json");
  process.exit(0);
}

// ── the arms ────────────────────────────────────────────────────────────────
const upstream = upstreamTargetOf(POOLER_URL);
const proxy = await startFreezeProxy(upstream);
log(`proxy listening on 127.0.0.1:${proxy.port} -> upstream :${upstream.port}`);

let exitCode = 0;
try {
  const baseline = await measureBaseline();
  results["baseline"] = baseline;

  const { sql } = await openPool(proxy);
  const held = await fillPool(sql, proxy);
  results["socketsHeldAfterFill"] = held;

  // Both arms first confirm the pooler actually COUNTS our new clients. If it
  // never does, nothing downstream can be interpreted.
  // ── the rise gate ─────────────────────────────────────────────────────────
  // Both arms first confirm the pooler actually COUNTS our new clients. This is
  // a HARD gate, not a warning: if the gauge never reflects `held` connections
  // that the proxy can see it is holding, then nothing measured afterwards is
  // interpretable, and — worse — the later "did it come back down?" check is
  // trivially satisfied by a gauge that never went up. That is the can't-fail
  // probe this task exists to avoid (mem#704), and an earlier revision of this
  // script shipped exactly it: a flat 69 across the whole hold was reported as
  // "PASS (negative control): the instrument moves for a change we know is
  // real." It had not moved at all.
  const rise = await waitForGauge("after open", (c) => c >= baseline.max + held);
  const peak = Math.max(...rise.readings.map((r) => r.connections), baseline.max);
  results["rise"] = { ...rise, peak, requiredAtLeast: baseline.max + held };
  if (!rise.observed) {
    log(
      `FAIL (rise gate): the gauge never reached baseline.max (${baseline.max}) + ${held} = ` +
        `${baseline.max + held} within ${TRANSITION_TIMEOUT_SECONDS}s. Peak seen: ${peak} ` +
        `(delta +${peak - baseline.max}). The proxy is holding ${held} sockets, so the ` +
        `connections are real — this says the METRIC is not tracking them at a usable ` +
        `latency, not that the connections are absent. Refusing to report a reclaim verdict ` +
        `on an instrument that has not been shown to move.`
    );
    results["verdict"] = "rise-gate-failed";
    exitCode = 1;
  } else {
    log(`open reflected in the gauge after ~${rise.afterSeconds}s (peak ${peak})`);
  }

  if (arm === "a") {
    // ── ARM A — the close propagates. Negative control + latency calibration.
    log("ARM A: closing an UNFROZEN pool — the close reaches Supavisor");
    const closedAt = Date.now();
    await sql.end({ timeout: 3 });
    log(`close() returned in ${Date.now() - closedAt}ms; sockets: ${proxy.clientSocketCount()}`);

    const fall = await waitForGauge("after close", (c) => c <= baseline.max);
    results["fall"] = fall;

    if (!rise.observed) {
      // The rise gate already failed and set exitCode. Say plainly that the
      // fall reading proves nothing here: a gauge that never rose satisfies
      // "came back down" for free.
      log(
        `Arm A INCONCLUSIVE: the fall check (${fall.observed ? "met" : "not met"}) carries no ` +
          `information because the rise gate failed — the gauge never went up, so it cannot ` +
          `meaningfully have come down. Fix the instrument before re-running.`
      );
      results["verdict"] = "arm-a-rise-gate-failed";
    } else if (fall.observed) {
      log(
        `PASS (negative control): the gauge rose by our ${held} connections and fell back to ` +
          `<= baseline.max within ~${fall.afterSeconds}s. The instrument moves in BOTH ` +
          `directions for changes we know are real, and an ordinary close reclaims.`
      );
      results["verdict"] = "arm-a-reclaimed";
    } else {
      log(
        `FINDING: the gauge rose by our ${held} connections but did NOT return to ` +
          `<= baseline.max (${baseline.max}) within ${TRANSITION_TIMEOUT_SECONDS}s after an ` +
          `ordinary, fully-propagating close. That is a real result about Supavisor, not an ` +
          `instrument failure — the rise gate already proved the gauge tracks us.`
      );
      results["verdict"] = "arm-a-not-reclaimed";
    }
    await writeResults("supavisor-slot-reclaim-arm-a.json");
  } else {
    // ── ARM B — the close cannot propagate. The production half-open case.
    //
    // Refuse to run on an instrument that failed the rise gate. Arm B's whole
    // output is "did the gauge come back down, and when?" — a gauge that never
    // went up answers that trivially and wrongly, and it would take 15 minutes
    // of sampling to produce the wrong answer.
    if (!rise.observed) {
      log(
        "ARM B ABORTED: the rise gate failed, so a reclaim verdict from this arm would be " +
          "meaningless. Run --arm a first and get a PASS before trusting anything here."
      );
      results["verdict"] = "arm-b-aborted-rise-gate-failed";
      await writeResults("supavisor-slot-reclaim-arm-b.json");
      await proxy.close();
      process.exit(1);
    }

    log("ARM B: freezing the proxy — from here a client close cannot reach Supavisor");
    proxy.freeze();
    for (let i = 0; i < POOL_SIZE; i++) {
      void sql`select 1`.catch(() => {});
    }
    await sleep(500);
    log(`sockets held while wedged: ${proxy.clientSocketCount()}`);
    results["socketsHeldWhileWedged"] = proxy.clientSocketCount();

    const wedged = await readGauge();
    results["whileWedged"] = wedged;
    log(`gauge while wedged: ${wedged.connections}`);

    const closedAt = Date.now();
    await sql.end({ timeout: 3 });
    log(
      `close() returned in ${Date.now() - closedAt}ms; client sockets: ` +
        `${proxy.clientSocketCount()}, upstream sockets still held by the frozen proxy: ` +
        `${proxy.upstreamSocketCount()}`
    );
    results["socketsAfterTerminate"] = {
      client: proxy.clientSocketCount(),
      upstreamHeldByProxy: proxy.upstreamSocketCount(),
    };

    const immediate = await readGauge();
    results["immediatelyPostTerminate"] = immediate;
    log(
      `gauge immediately post-terminate: ${immediate.connections} ` +
        `(expected to still show the pre-terminate value — that is the ~60s scrape ` +
        `resolution, not a finding about Supavisor)`
    );

    log(`sampling ${SAMPLES}x every ${INTERVAL_SECONDS}s to see whether the slot is reclaimed`);
    const samples: GaugeReading[] = [];
    let reclaimedAfterSeconds: number | null = null;
    const sampleStart = Date.now();
    for (let i = 0; i < SAMPLES; i++) {
      await sleep(INTERVAL_SECONDS * 1000);
      const reading = await readGauge();
      samples.push(reading);
      const elapsed = Math.round((Date.now() - sampleStart) / 1000);
      log(`  sample[${i}]: ${reading.connections} (t+${elapsed}s)`);
      if (reclaimedAfterSeconds === null && reading.connections <= baseline.max) {
        reclaimedAfterSeconds = elapsed;
        log(`  -> back to <= baseline.max (${baseline.max}) after ~${elapsed}s`);
      }
    }
    results["samples"] = samples;
    results["reclaimedAfterSeconds"] = reclaimedAfterSeconds;
    results["sampledForSeconds"] = SAMPLES * INTERVAL_SECONDS;

    if (reclaimedAfterSeconds !== null) {
      log(
        `FINDING: the slot WAS reclaimed ~${reclaimedAfterSeconds}s after a terminate that ` +
          `could not propagate — so Supavisor applies a client-side timeout of its own.`
      );
      results["verdict"] = "arm-b-reclaimed";
    } else {
      log(
        `FINDING: NOT reclaimed within ${SAMPLES * INTERVAL_SECONDS}s of a terminate that could ` +
          `not propagate. Bounded claim: not-reclaimed-within-that-window at ~60s resolution — ` +
          `NOT "never reclaimed". The follow-up is Supavisor's own client timeout.`
      );
      results["verdict"] = "arm-b-not-reclaimed-in-window";
    }

    // End-of-arm control: releasing the upstream sockets for real must move the
    // gauge. If it does not, the arm measured nothing and its finding is void.
    log("end-of-arm control: unfreezing and destroying the upstream sockets for real");
    await proxy.close();
    const released = await waitForGauge("after real release", (c) => c <= baseline.max);
    results["afterRealRelease"] = released;
    if (!released.observed) {
      log(
        `FAIL (end-of-arm control): the gauge did not fall after a REAL release within ` +
          `${TRANSITION_TIMEOUT_SECONDS}s. The arm's finding above is not interpretable — ` +
          `the instrument may not have been tracking these connections at all.`
      );
      results["verdict"] = `${String(results["verdict"])}-CONTROL-FAILED`;
      exitCode = 1;
    } else {
      log(`end-of-arm control PASSED: real release moved the gauge in ~${released.afterSeconds}s`);
    }
    await writeResults("supavisor-slot-reclaim-arm-b.json");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: ${message}`);
  exitCode = 1;
} finally {
  await proxy.close();
}

process.exit(exitCode);
