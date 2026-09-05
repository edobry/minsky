#!/usr/bin/env bun
/**
 * Live verification for mt#4707 — the daemon-ensuring step wired into `setup`.
 *
 * Unit tests cover the DECISION with an injected seam. This exercises the real
 * `ensureDaemonRunning` against real sockets, which is the only way to know the
 * spawn actually works: a unit test with a stubbed `ensure` is blind to a bad
 * spawn argv, a daemon that never becomes healthy, or a probe that misreads a
 * live server.
 *
 * ## Why it spawns on a SCRATCH port
 *
 * The obvious live test — stop the machine's daemon and run `setup` — is not
 * available here: on a developer machine that daemon is serving the operator's
 * own Claude Code conversations, and stopping it to prove a point would break
 * their session. So the spawn branch is exercised on an unused high port with a
 * bounded lifetime and an explicit kill, per `/implement-task` §7a's dual-mode
 * rule: run EACH production branch, using a bounded invocation for the one with
 * side effects, rather than only the safe branch.
 *
 * ## Usage
 *
 *   bun scripts/verify-setup-daemon-ensure.ts
 *
 * Exits 0 on pass, non-zero on failure. Skips gracefully (exit 0) if no `bun`
 * runtime path can be resolved.
 */

import {
  daemonSpawnCommand,
  ensureDaemonRunning,
  localDaemonHealthUrl,
  resolveSelfInvocation,
} from "../src/mcp/setup/local-http-apply";
import { ensureLocalDaemonForSetup } from "../src/mcp/setup/ensure-local-daemon-for-setup";

/** A port nothing in this repo binds by default, kept off the 48765 contract. */
const SCRATCH_PORT = 48799;
const SCRATCH_HOST = "127.0.0.1";

function report(label: string, ok: boolean, detail: string): boolean {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}\n      ${detail}`);
  return ok;
}

async function isServing(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const results: boolean[] = [];
  const repoRoot = process.cwd();

  // ── Branch 1: a port with nothing on it — the cold-machine case ────────────
  const scratchHealth = localDaemonHealthUrl(SCRATCH_HOST, SCRATCH_PORT);
  if (await isServing(scratchHealth)) {
    console.log(
      `SKIP: something is already serving ${scratchHealth}; cannot test the spawn branch`
    );
    process.exit(0);
  }

  // `resolveSelfInvocation` derives the spawn prefix from the INVOKING
  // process's argv — in production that process is the `minsky` CLI, so it
  // yields `bun <cli.ts>`. Run from this script, argv[1] is this script, and
  // the daemon would be spawned as `bun verify-setup-daemon-ensure.ts mcp
  // start …`, which is not a CLI and never becomes healthy. That is a defect in
  // the PROBE, not the production path, and it is why this passes a simulated
  // CLI argv rather than its own: the check must exercise what `setup` would
  // actually spawn.
  const cliArgv = [process.argv[0] ?? "bun", `${repoRoot}/src/cli.ts`];
  const spawnArgv = daemonSpawnCommand(resolveSelfInvocation(cliArgv), repoRoot, {
    host: SCRATCH_HOST,
    port: SCRATCH_PORT,
  });
  console.log(`spawn argv: ${spawnArgv.join(" ")}\n`);

  let spawnedOk = false;
  try {
    const cold = await ensureDaemonRunning(spawnArgv, { healthUrl: scratchHealth, attempts: 60 });
    spawnedOk = cold.spawned;
    results.push(
      report(
        "cold port: a daemon is spawned",
        cold.spawned,
        `spawned=${cold.spawned} state=${cold.status.state}`
      )
    );
    results.push(
      report(
        "cold port: it is actually serving afterwards",
        await isServing(scratchHealth),
        `GET ${scratchHealth}`
      )
    );

    // ── Branch 2: the same call again — SC2's idempotence ──────────────────
    const warm = await ensureDaemonRunning(spawnArgv, { healthUrl: scratchHealth });
    results.push(
      report(
        "SC2 — a second call spawns nothing",
        warm.spawned === false && warm.status.state === "running",
        `spawned=${warm.spawned} state=${warm.status.state}`
      )
    );
  } finally {
    if (spawnedOk) {
      // Bounded: kill only what this script started, identified by the scratch
      // port. `-sTCP:LISTEN` is load-bearing — a bare `lsof -ti tcp:<port>`
      // matches EVERY socket on that port, including this script's own client
      // connections from the health probes above, so the first version of this
      // cleanup killed the verifier itself (observed: exit 143, SIGTERM). The
      // own-pid guard is belt-and-braces for the same reason.
      const { spawnSync } = await import("child_process");
      const found = spawnSync("lsof", ["-ti", `tcp:${SCRATCH_PORT}`, "-sTCP:LISTEN"], {
        encoding: "utf-8",
      });
      if (found.error !== undefined) {
        // `lsof` is a POSIX-developer-machine assumption, and this script is a
        // developer-machine verifier — but a cleanup that silently does nothing
        // would leave a daemon running on the scratch port and the NEXT run
        // would "SKIP: something is already serving", reading as an environment
        // quirk rather than a leak (PR #3658 R1).
        console.error(
          `\ncleanup FAILED: could not run lsof (${found.error.message}). A daemon may still be ` +
            `listening on port ${SCRATCH_PORT} — stop it manually.`
        );
        process.exit(1);
      }
      const pids = (found.stdout ?? "")
        .trim()
        .split("\n")
        .filter(Boolean)
        .filter((pid) => pid !== String(process.pid));
      for (const pid of pids) spawnSync("kill", [pid]);
      console.log(`\ncleanup: killed ${pids.length} listener(s) on port ${SCRATCH_PORT}`);
    }
  }

  // ── Branch 3: the adapter against the REAL daemon, if one is running ──────
  // Read-only by construction: a healthy daemon means `ensureDaemonRunning`
  // returns before it would spawn anything.
  if (await isServing(localDaemonHealthUrl())) {
    const outcome = await ensureLocalDaemonForSetup(repoRoot);
    results.push(
      report(
        "adapter against the live daemon: already-running, nothing spawned",
        outcome.kind === "already-running",
        `outcome=${outcome.kind}`
      )
    );
  } else {
    console.log("SKIP: no daemon on the default port; adapter-against-live check not run");
  }

  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
