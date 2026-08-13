#!/usr/bin/env bun
/**
 * mt#3879 verification artifact: does a COLD hook-shaped process actually
 * reach Postgres under the shipped configuration?
 *
 * The defect this guards against is invisible from inside the process that has
 * it — `resolvePersistenceProvider()` returns null and every DB-backed hook
 * fails open, which is indistinguishable from "there was nothing to do". So the
 * check has to run in a fresh process, exactly as a hook does, and assert on the
 * provider it gets rather than on any hook's output.
 *
 * Deliberately sets NO connect-timeout env var: the point is to exercise
 * whatever the shipped default resolves to. Emits timings and a verdict only —
 * never a connection string, host, or credential.
 *
 * Usage:  bun scripts/verify-hook-provider-resolves.ts [--runs N]
 * Exit:   0 = every run resolved a provider (or the env has no Postgres
 *             configured, which is a SKIP), 1 = at least one run failed.
 */

// Static, first runtime import: this entry point reaches the persistence layer,
// and without the polyfill the domain import throws inside tsyringe (mt#3019 /
// mt#3176). The child re-enters it via `ensureHookDomainBootstrap` anyway; this
// is what makes the PARENT safe to import the factory path at all.
import "reflect-metadata";

const RUNS = (() => {
  const i = process.argv.indexOf("--runs");
  const n = i === -1 ? NaN : Number(process.argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
})();

const BOOTSTRAP_PATH = new URL("../.minsky/hooks/domain-bootstrap.ts", import.meta.url).pathname;
const FACTORY_PATH = new URL("../packages/domain/src/persistence/factory.ts", import.meta.url)
  .pathname;

/**
 * One cold measurement. Spawned as a child so each run pays a real cold
 * connect — resolving twice in THIS process would hit the provider cache and
 * report a warm number as if it were cold.
 */
async function childMain(): Promise<void> {
  const t0 = performance.now();
  const { ensureHookDomainBootstrap } = await import(BOOTSTRAP_PATH);
  const boot = await ensureHookDomainBootstrap();
  const bootstrapMs = Math.round(performance.now() - t0);

  if (!boot.ok) {
    console.log(JSON.stringify({ outcome: "bootstrap-failed", bootstrapMs, error: boot.error }));
    return;
  }

  const t1 = performance.now();
  const { resolvePersistenceProvider } = await import(FACTORY_PATH);
  let provider: unknown = null;
  let error: string | undefined;
  try {
    provider = await resolvePersistenceProvider();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const resolveMs = Math.round(performance.now() - t1);

  console.log(
    JSON.stringify({
      outcome: provider ? "resolved" : "null-provider",
      bootstrapMs,
      resolveMs,
      capEnv:
        process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT ?? "(unset — inherits default)",
      ...(error ? { error } : {}),
    })
  );
}

async function parentMain(): Promise<void> {
  const results: Array<Record<string, unknown>> = [];

  for (let i = 0; i < RUNS; i++) {
    const proc = Bun.spawn(["bun", import.meta.path, "--child"], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MINSKY_HOOK_PROVIDER_VERIFY_CHILD: "1" },
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    const line = out
      .split("\n")
      .filter((l) => l.trim().startsWith("{"))
      .pop();
    if (!line) {
      results.push({ outcome: "no-output" });
      continue;
    }
    results.push(JSON.parse(line));
  }

  for (const r of results) console.log(JSON.stringify(r));

  const bootstrapFailures = results.filter((r) => r.outcome === "bootstrap-failed");
  if (bootstrapFailures.length === results.length) {
    // No Postgres configured (CI, a fresh checkout) — not a failure of this check.
    console.log("SKIP: no usable Postgres configuration in this environment");
    process.exit(0);
  }

  const resolved = results.filter((r) => r.outcome === "resolved").length;
  console.log(`${resolved}/${results.length} cold processes resolved a persistence provider`);
  if (resolved !== results.length) {
    console.log("FAIL: a cold hook-shaped process could not reach Postgres");
    process.exit(1);
  }
  console.log("PASS");
}

if (process.argv.includes("--child")) {
  await childMain();
  // A resolved provider holds an open pool, which keeps the event loop alive
  // forever. Exit explicitly — the measurement is already printed, and a child
  // that never exits would hang the parent's `await proc.exited`.
  process.exit(0);
} else {
  await parentMain();
}
