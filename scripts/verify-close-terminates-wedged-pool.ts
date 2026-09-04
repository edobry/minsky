#!/usr/bin/env bun
/**
 * mt#4515 — live verification that `close()` releases connections on a WEDGED pool.
 *
 * WHY THIS SCRIPT EXISTS. The unit test can only assert that we pass
 * `{ timeout }` to postgres-js; the termination itself is the driver's
 * behaviour, and a mocked `end()` cannot exhibit it. A healthy-pool test proves
 * nothing either — an unbounded `end()` drains a healthy pool perfectly well.
 * The defect appears only when connections CANNOT drain, so the verification has
 * to produce that state for real.
 *
 * THE TECHNIQUE (mem#838) now lives in `scripts/lib/freeze-proxy.ts`, extracted
 * by mt#4547 so its two non-obvious gotchas (per-chunk forwarding rather than
 * `pipe()`; `family: 4` against oven-sh/bun#25633) exist in ONE place rather
 * than in two copies that can drift. Read that module's docblock for the
 * mechanism; this script is now just the mt#4515 assertion on top of it.
 *
 * The proxy is the counter — no `lsof` needed. It knows exactly how many client
 * sockets it is holding, which is the number this task is about.
 *
 * SCOPE, and the sibling that covers the other half (mt#4547). This script
 * measures the CLIENT side: did OUR sockets go away? It says nothing about what
 * Supavisor thinks, and `pg_stat_activity` cannot answer that either — see
 * `scripts/verify-supavisor-slot-reclaim.ts`, which reads the pooler's own
 * client-connection gauge from the Supabase metrics endpoint.
 *
 * USAGE
 *   bun scripts/verify-close-terminates-wedged-pool.ts              # the fix
 *   bun scripts/verify-close-terminates-wedged-pool.ts --unbounded  # negative control
 *
 * The `--unbounded` mode calls `sql.end()` with NO timeout — the pre-mt#4515
 * behaviour — and is expected to HANG past the deadline and exit 1. Run it to
 * confirm the harness can actually fail before trusting the passing run.
 *
 * Skips (exit 0) when no Postgres connection string is configured.
 *
 * NOTE ON OUTPUT: this prints socket counts, timings and pass/fail only. The
 * connection string is read into a variable and never printed, on any path.
 */
import {
  readPoolerConnectionString,
  upstreamTargetOf,
  proxyConnectionString,
  startFreezeProxy,
} from "./lib/freeze-proxy";

const UNBOUNDED = process.argv.includes("--unbounded");
/** How long we allow close() to take before declaring it hung. */
const HANG_DEADLINE_MS = 15_000;
/** Concurrent queries used to fill the pool before freezing. */
const FILL_CONCURRENCY = 6;

// `yaml` (a declared dependency, ^2.8.0) rather than the `Bun.YAML` global this
// script used before the mt#4547 extraction. The original note warned against
// `js-yaml` — only its @types are declared — but `yaml` is a different package,
// is a real dependency, and is what `scripts/supabase/restart-project.ts`
// already uses. That also retires the cast for a global absent from @types/bun.
const connectionString = await readPoolerConnectionString();
if (!connectionString) {
  console.log("SKIP: no persistence.postgres.connectionString configured");
  process.exit(0);
}

const upstream = upstreamTargetOf(connectionString);
const proxy = await startFreezeProxy(upstream);
console.log(`proxy listening on 127.0.0.1:${proxy.port} -> upstream :${upstream.port}`);

const postgres = (await import("postgres")).default;
const sql = postgres(proxyConnectionString(connectionString, proxy.port), {
  max: FILL_CONCURRENCY,
  connect_timeout: 10,
  idle_timeout: 0,
  prepare: false,
  onnotice: () => {},
});

let exitCode = 0;
try {
  // ── fill the pool ─────────────────────────────────────────────────────────
  await Promise.all(
    Array.from({ length: FILL_CONCURRENCY }, () => sql`select pg_sleep(0)`.catch(() => {}))
  );
  const beforeFreeze = proxy.clientSocketCount();
  console.log(`sockets held after filling the pool: ${beforeFreeze}`);
  if (beforeFreeze === 0) {
    console.error("FAIL: the proxy is holding no sockets — the pool never opened through it");
    process.exit(1);
  }

  // ── freeze, then wedge every slot ─────────────────────────────────────────
  proxy.freeze();
  console.log("proxy frozen — sockets stay open, bytes stop moving");
  for (let i = 0; i < FILL_CONCURRENCY; i++) {
    void sql`select 1`.catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 500));
  console.log(`sockets held while wedged: ${proxy.clientSocketCount()}`);

  // ── the measurement ───────────────────────────────────────────────────────
  const startedAt = Date.now();
  const closePromise = UNBOUNDED
    ? sql.end() // pre-mt#4515: timeout defaults to null, destroy timer never arms
    : sql.end({ timeout: 3 }); // mt#4515: CLOSE_TIMEOUT_SECONDS

  const hung = Symbol("hung");
  const outcome = await Promise.race([
    closePromise.then(() => "closed" as const),
    new Promise<typeof hung>((r) => setTimeout(() => r(hung), HANG_DEADLINE_MS)),
  ]);
  const elapsedMs = Date.now() - startedAt;

  if (outcome === hung) {
    console.log(`close() DID NOT RETURN within ${HANG_DEADLINE_MS}ms`);
    console.log(`sockets still held: ${proxy.clientSocketCount()}`);
    if (UNBOUNDED) {
      console.log("PASS (negative control): the unbounded close hangs, as the defect predicts");
    } else {
      console.error("FAIL: the bounded close should have returned");
      exitCode = 1;
    }
  } else {
    // Give the OS a moment to reflect the destroyed sockets.
    await new Promise((r) => setTimeout(r, 300));
    const remaining = proxy.clientSocketCount();
    console.log(`close() returned in ${elapsedMs}ms; sockets still held: ${remaining}`);
    if (UNBOUNDED) {
      console.error("FAIL (negative control): the unbounded close was expected to hang");
      exitCode = 1;
    } else if (remaining > 0) {
      console.error(
        `FAIL: ${remaining} socket(s) survived close() — connections were not released`
      );
      exitCode = 1;
    } else {
      console.log("PASS: the bounded close returned and released every connection");
    }
  }
} finally {
  await proxy.close();
}

process.exit(exitCode);
