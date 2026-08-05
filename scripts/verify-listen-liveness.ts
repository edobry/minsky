#!/usr/bin/env bun
/**
 * mt#3497 — live verification that the LISTEN connection detects its own death
 * and recovers WITHOUT a process restart.
 *
 * Unit tests cover the state machine against a stub. They cannot cover the two
 * things that only a real Supavisor can answer:
 *
 *   1. Does the resolved session-mode URL actually DELIVER a NOTIFY? (the
 *      provider's connect-time self-test — a transaction pooler accepts LISTEN
 *      and silently never delivers, which no stub reproduces)
 *   2. When the backend is killed server-side, does the heartbeat notice and
 *      re-establish every channel on a fresh connection?
 *
 * Run:
 *   bun scripts/verify-listen-liveness.ts
 *
 * Skips cleanly (exit 0) when no Postgres connection string is configured.
 * Exits non-zero on any failed assertion.
 */

// Must precede any import that pulls in tsyringe (the provider does): on Bun
// 1.3.x the ESM body of tsyringe evaluates before reflect-metadata's CJS body
// otherwise, and it throws at import time (mt#3561).
import "reflect-metadata";
import { readFile } from "fs/promises";
import { homedir } from "os";
import yaml from "js-yaml";
import postgres from "postgres";
import { PostgresPersistenceProvider } from "../packages/domain/src/persistence/providers/postgres-provider";
import {
  PostgresChannelListener,
  HEARTBEAT_CHANNEL,
} from "../packages/domain/src/mesh/postgres-channel-listener";

const PROBE_CHANNEL = `minsky.mt3497.verify.${process.pid}`;
const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}\n`);
}

function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (predicate()) {
        clearInterval(poll);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`));
      }
    }, 50);
  });
}

// ---------------------------------------------------------------------------
// Config — connection string is never printed.
// ---------------------------------------------------------------------------
const configPath = `${homedir()}/.config/minsky/config.yaml`;
let connectionString: string | undefined;
try {
  const cfg = yaml.load(await readFile(configPath, "utf-8")) as {
    persistence?: { postgres?: { connectionString?: string } };
  };
  connectionString = cfg?.persistence?.postgres?.connectionString;
} catch {
  // intentional-swallow: an absent/unreadable config is the documented SKIP
  // path, not a failure — see the env gate immediately below.
}
connectionString = process.env.MINSKY_POSTGRES_URL ?? connectionString;

if (!connectionString) {
  process.stdout.write(
    "SKIP: no persistence.postgres.connectionString configured and MINSKY_POSTGRES_URL unset\n"
  );
  process.exit(0);
}

// Recorded BEFORE any connection is opened, so the backend-kill step below can
// scope itself to connections this script created.
const provider = new PostgresPersistenceProvider({
  backend: "postgres",
  postgres: { connectionString },
});
await provider.initialize();

const scriptStartedAt = (
  (await (await provider.getRawSqlConnection()).unsafe("select now() as t")) as Array<{ t: string }>
)[0]?.t;
if (!scriptStartedAt) {
  process.stdout.write("FAIL  could not read server time to scope the backend kill\n");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1. The connect-time self-test must pass against the real resolved URL.
// ---------------------------------------------------------------------------
let sessionSql: ReturnType<typeof postgres>;
try {
  sessionSql = await provider.getListenCapableSqlConnection();
  record(
    "self-test: resolved session URL delivers NOTIFY",
    true,
    "getListenCapableSqlConnection() returned a verified connection"
  );
} catch (err) {
  record(
    "self-test: resolved session URL delivers NOTIFY",
    false,
    err instanceof Error ? err.message : String(err)
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1b. NEGATIVE CONTROL for the self-test (spec AT3): pointed at a TRANSACTION
// -mode URL, the self-test must FAIL loudly rather than hand back a connection
// that accepts LISTEN and silently never delivers. A probe that cannot fail
// carries no information, so this is what makes check 1 above meaningful.
// ---------------------------------------------------------------------------
{
  const txProvider = new PostgresPersistenceProvider({
    backend: "postgres",
    // Force the session URL to the transaction pooler, defeating the port-swap.
    postgres: { connectionString, sessionConnectionString: connectionString },
  });
  await txProvider.initialize();
  let threw: string | null = null;
  try {
    await txProvider.getListenCapableSqlConnection();
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  record(
    "self-test NEGATIVE control: transaction-mode URL is rejected",
    threw !== null,
    threw === null
      ? "the self-test PASSED against a transaction-mode URL — it cannot detect a non-delivering pooler"
      : `rejected as expected: ${threw.slice(0, 160)}…`
  );
  await txProvider.close();
}

const rawSql = await provider.getRawSqlConnection();

// ---------------------------------------------------------------------------
// 2. Wire the listener exactly as the cockpit broker does.
// ---------------------------------------------------------------------------
const received: string[] = [];
const listener = new PostgresChannelListener(
  sessionSql,
  { initialBackoffMs: 200, maxAttempts: 8 },
  {
    emit: async (channel: string, payload: string) => {
      await rawSql.unsafe("select pg_notify($1, $2)", [channel, payload]);
    },
    reopen: () => provider.getListenCapableSqlConnection({ forceNew: true }),
    intervalMs: 60_000, // ticks are driven manually below
    missesBeforeReconnect: 2,
  }
);

// Raw parser: the default is JSON.parse, and these probe payloads are bare
// strings, which it would reject as a parse error and silently skip.
await listener.subscribe<string>(
  PROBE_CHANNEL,
  (_c, payload) => {
    received.push(String(payload));
  },
  { parse: (raw: string) => raw }
);
await listener.startHeartbeat();

// Baseline: delivery works before we break anything.
await rawSql.unsafe("select pg_notify($1, $2)", [PROBE_CHANNEL, "before"]);
try {
  await waitFor(() => received.includes("before"), 10_000, "baseline NOTIFY");
  record("baseline delivery", true, "NOTIFY received on the probe channel");
} catch (err) {
  record("baseline delivery", false, err instanceof Error ? err.message : String(err));
  await listener.close();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Kill the LISTEN backend server-side — the real failure, not a simulation.
// ---------------------------------------------------------------------------
// Do NOT match on the probe channel: postgres-js multiplexes every channel
// onto ONE internal sub-connection, so the backend's `query` retains only the
// LAST `listen` issued — the heartbeat channel, not the probe.
//
// And do NOT match on channel name alone: a running cockpit daemon holds its
// own LISTEN backend on the same database, and killing THAT would take out the
// operator's live cockpit. Scope to backends started after this script did.
// Discriminate on query_start, NOT backend_start: Supavisor hands a client an
// EXISTING pooled backend, so backend_start can predate this script by hours
// and filtering on it misses our own connection (observed). query_start is when
// the `listen` actually ran, which is ours — and which also excludes a running
// cockpit daemon's LISTEN backend, established long before this script.
const backends = (await rawSql.unsafe(
  `select pid from pg_stat_activity
    where query ilike 'listen%'
      and query_start >= $1
      and pid <> pg_backend_pid()`,
  [scriptStartedAt]
)) as Array<{ pid: number }>;

if (backends.length === 0) {
  record(
    "locate LISTEN backend",
    false,
    "no backend found holding the probe LISTEN — cannot exercise the kill path"
  );
  await listener.close();
  process.exit(1);
}
record("locate LISTEN backend", true, `${backends.length} backend(s) holding the probe LISTEN`);

for (const { pid } of backends) {
  await rawSql.unsafe("select pg_terminate_backend($1)", [pid]);
}
process.stdout.write(`      terminated backend pid(s): ${backends.map((b) => b.pid).join(", ")}\n`);

// ---------------------------------------------------------------------------
// 4. Drive heartbeat ticks; the listener must notice and reconnect itself.
// ---------------------------------------------------------------------------
// Assert the OUTCOME (delivery resumes), not the mechanism. Against a REACHABLE
// database, postgres-js's own onclose reconnect often restores the channels
// before the heartbeat's miss threshold is reached — and that is a correct
// outcome, so demanding `action === "reconnected"` would make this check fail
// on the healthy path. The heartbeat exists for the case postgres-js does NOT
// recover (its re-listen failure is swallowed, or onclose never fires at all);
// the unit tests cover that, because the stub never self-heals.
let recoveredVia: string | null = null;
for (let tick = 0; tick < 10 && !recoveredVia; tick++) {
  const result = await listener.heartbeatTick();
  process.stdout.write(`      tick ${tick + 1}: ${result.action}\n`);

  if (result.action === "reconnected") {
    recoveredVia = `heartbeat-owned reconnect (re-established: ${result.channels.join(", ")})`;
    break;
  }
  if (result.action === "reconnect-failed") {
    record("broker recovers after the backend is killed", false, result.error);
    break;
  }

  // Probe whether delivery is working again by whatever path.
  const marker = `probe-${tick}`;
  await rawSql.unsafe("select pg_notify($1, $2)", [PROBE_CHANNEL, marker]);
  try {
    await waitFor(() => received.includes(marker), 1_500, "recovery probe");
    recoveredVia = "postgres-js self-heal (its own onclose re-listen succeeded)";
  } catch {
    // intentional-swallow: not recovered yet on this tick; keep ticking.
  }
  await new Promise((r) => setTimeout(r, 500));
}

if (recoveredVia) {
  record("broker recovers after the backend is killed", true, `recovered via ${recoveredVia}`);
} else {
  record(
    "broker recovers after the backend is killed",
    false,
    "no delivery and no heartbeat reconnect within 10 ticks"
  );
}
const reconnected = recoveredVia !== null;

// ---------------------------------------------------------------------------
// 5. Delivery must resume — with no process restart.
// ---------------------------------------------------------------------------
if (reconnected) {
  await rawSql.unsafe("select pg_notify($1, $2)", [PROBE_CHANNEL, "after"]);
  try {
    await waitFor(() => received.includes("after"), 10_000, "post-reconnect NOTIFY");
    record(
      "delivery resumed without a restart",
      true,
      "NOTIFY received on the re-established channel"
    );
  } catch (err) {
    record(
      "delivery resumed without a restart",
      false,
      err instanceof Error ? err.message : String(err)
    );
  }
}

process.stdout.write(`      heartbeat channel in use: ${HEARTBEAT_CHANNEL}\n`);

await listener.close();
await provider.close();

const failed = results.filter((r) => !r.ok);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
