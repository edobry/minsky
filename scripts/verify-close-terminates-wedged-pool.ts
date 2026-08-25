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
 * THE TECHNIQUE (mem#838). A local TCP proxy sits in front of the real pooler.
 * Once the pool is full it FREEZES: it stops forwarding bytes in both directions
 * but keeps every socket open and never propagates a close. That is exactly the
 * half-open shape — the peer is gone, the socket is not — so every in-flight
 * query's promise is left permanently unsettled, which is what makes
 * `Promise.all(connections.map(c => c.end()))` unable to settle.
 *
 * Two gotchas that cost time before (both from mem#838, kept because they are
 * not obvious and this script would silently misbehave without them):
 *   1. Forward per-chunk with explicit listeners, NOT `pipe()`. Attaching a
 *      `data` listener before piping consumes and DROPS the early bytes,
 *      including postgres's startup message.
 *   2. `net.connect({ family: 4 })`. The pooler hostname resolves to several
 *      mixed-family addresses and Bun's multi-address connect path is defective
 *      (oven-sh/bun#25633, mt#3534).
 *
 * The proxy itself is the counter — no `lsof` needed. It knows exactly how many
 * client sockets it is holding, which is the number this task is about.
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
import { createServer, connect, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const UNBOUNDED = process.argv.includes("--unbounded");
/** How long we allow close() to take before declaring it hung. */
const HANG_DEADLINE_MS = 15_000;
/** Concurrent queries used to fill the pool before freezing. */
const FILL_CONCURRENCY = 6;

function readConnectionString(): string | null {
  try {
    const raw = readFileSync(join(homedir(), ".config/minsky/config.yaml"), "utf8");
    // `Bun.YAML.parse`, not `js-yaml` (PR #3308 R1). The repo declares only
    // `@types/js-yaml`, so importing the runtime package resolved transitively
    // and would break the moment that transitive edge moved. Bun ships a YAML
    // parser and this file already requires Bun via its shebang, so the
    // dependency is removed rather than added.
    //
    // Cast because `YAML` is honoured at runtime (verified on the pinned Bun
    // 1.3.14) but is absent from the installed `@types/bun` — the same shape as
    // postgres-provider.ts's `socket` option, and scoped to this one property so
    // nothing else loses checking.
    const bunYaml = (Bun as { YAML?: { parse(text: string): unknown } }).YAML;
    if (!bunYaml) return null; // older Bun without the built-in parser
    const cfg = bunYaml.parse(raw) as {
      persistence?: { postgres?: { connectionString?: string } };
    } | null;
    return cfg?.persistence?.postgres?.connectionString ?? null;
  } catch {
    return null;
  }
}

const connectionString = readConnectionString();
if (!connectionString) {
  console.log("SKIP: no persistence.postgres.connectionString configured");
  process.exit(0);
}

const upstream = new URL(connectionString.replace(/^postgres(ql)?:/, "http:"));
const upstreamHost = upstream.hostname;
const upstreamPort = Number(upstream.port || 6543);

// ── the freeze-proxy ────────────────────────────────────────────────────────
let frozen = false;
const clientSockets = new Set<Socket>();
const upstreamSockets = new Set<Socket>();

const proxy = createServer((client) => {
  clientSockets.add(client);
  const server = connect({ host: upstreamHost, port: upstreamPort, family: 4 });
  upstreamSockets.add(server);

  // Explicit per-chunk forwarding (gotcha 1). While frozen, bytes are dropped
  // rather than forwarded and no close is propagated — the half-open shape.
  client.on("data", (chunk) => {
    if (!frozen) server.write(chunk);
  });
  server.on("data", (chunk) => {
    if (!frozen) client.write(chunk);
  });

  const drop = (s: Socket, set: Set<Socket>) => {
    set.delete(s);
    if (!frozen) {
      try {
        s.destroy();
      } catch {
        /* already gone */
      }
    }
  };
  client.on("close", () => drop(client, clientSockets));
  server.on("close", () => drop(server, upstreamSockets));
  client.on("error", () => drop(client, clientSockets));
  server.on("error", () => drop(server, upstreamSockets));
});

await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
const proxyPort = (proxy.address() as { port: number }).port;
console.log(`proxy listening on 127.0.0.1:${proxyPort} -> upstream :${upstreamPort}`);

// Point a client at the proxy, preserving credentials and database.
const viaProxy = new URL(connectionString);
viaProxy.hostname = "127.0.0.1";
viaProxy.port = String(proxyPort);

const postgres = (await import("postgres")).default;
const sql = postgres(viaProxy.toString(), {
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
  const beforeFreeze = clientSockets.size;
  console.log(`sockets held after filling the pool: ${beforeFreeze}`);
  if (beforeFreeze === 0) {
    console.error("FAIL: the proxy is holding no sockets — the pool never opened through it");
    process.exit(1);
  }

  // ── freeze, then wedge every slot ─────────────────────────────────────────
  frozen = true;
  console.log("proxy frozen — sockets stay open, bytes stop moving");
  for (let i = 0; i < FILL_CONCURRENCY; i++) {
    void sql`select 1`.catch(() => {});
  }
  await new Promise((r) => setTimeout(r, 500));
  const wedged = clientSockets.size;
  console.log(`sockets held while wedged: ${wedged}`);

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
    console.log(`sockets still held: ${clientSockets.size}`);
    if (UNBOUNDED) {
      console.log("PASS (negative control): the unbounded close hangs, as the defect predicts");
    } else {
      console.error("FAIL: the bounded close should have returned");
      exitCode = 1;
    }
  } else {
    // Give the OS a moment to reflect the destroyed sockets.
    await new Promise((r) => setTimeout(r, 300));
    const remaining = clientSockets.size;
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
  frozen = false;
  for (const s of [...clientSockets, ...upstreamSockets]) {
    try {
      s.destroy();
    } catch {
      /* already gone */
    }
  }
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
}

process.exit(exitCode);
