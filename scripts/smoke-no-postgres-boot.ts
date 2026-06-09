#!/usr/bin/env bun
/**
 * Smoke: no-Postgres boot-tolerance (mt#2349)
 *
 * Verifies the boot-tolerant / fail-on-use contract that replaced the former
 * silent SQLite fallback when no Postgres connection is configured:
 *
 *   1. `mcp start --http` boots and serves GET /health 200 (this is exactly what
 *      the CI bundle-boot-smoke gate does — with no Postgres configured).
 *   2. A non-DB command (`config get version`) succeeds (exit 0) offline.
 *   3. A DB-backed command (`session list`) fails with a clear, actionable
 *      "configure Postgres" error (non-zero exit) — fail-on-use, not silent.
 *
 * Runnable: `bun scripts/smoke-no-postgres-boot.ts`. Self-contained — uses a
 * throwaway XDG_CONFIG_HOME with no persistence block and strips
 * MINSKY_POSTGRES_URL so the no-Postgres path is exercised regardless of the
 * caller's environment. Exit 0 = pass, non-zero = fail.
 */

import { spawn, spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = ["run", "src/cli.ts"];
const PORT = 30000 + Math.floor(Date.now() % 9000);

function envWithoutPostgres(home: string): NodeJS.ProcessEnv {
  const env = { ...process.env, XDG_CONFIG_HOME: home } as NodeJS.ProcessEnv;
  delete env.MINSKY_POSTGRES_URL;
  delete env.MINSKY_PERSISTENCE_POSTGRES_URL;
  delete env.MINSKY_PERSISTENCE_POSTGRES_CONNECTIONSTRING;
  return env;
}

async function main(): Promise<number> {
  const home = mkdtempSync(join(tmpdir(), "mt2349-smoke-"));
  mkdirSync(join(home, "minsky"), { recursive: true });
  writeFileSync(join(home, "minsky", "config.yaml"), "version: 1\nbackendConfig: {}\n");
  const env = envWithoutPostgres(home);

  const failures: string[] = [];

  // --- 1) mcp start --http boots and /health responds 200 ------------------
  const server = spawn(
    "bun",
    [...CLI, "mcp", "start", "--http", "--host=127.0.0.1", `--port=${PORT}`],
    {
      env,
      stdio: "ignore",
    }
  );
  try {
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/health`);
        if (res.status === 200) {
          healthy = true;
          break;
        }
      } catch {
        // not up yet
      }
    }
    if (healthy) {
      console.log("PASS: mcp start serves /health 200 without Postgres");
    } else {
      failures.push("mcp start /health never returned 200 without Postgres");
    }
  } finally {
    server.kill("SIGTERM");
  }

  // --- 2) non-DB command works offline (exit 0) ----------------------------
  const cfg = spawnSync("bun", [...CLI, "config", "get", "version"], { env, encoding: "utf8" });
  if (cfg.status === 0) {
    console.log("PASS: `config get version` exits 0 without Postgres");
  } else {
    failures.push(`config get version exited ${cfg.status} (expected 0)`);
  }

  // --- 3) DB-backed command fails clearly (non-zero, names Postgres) -------
  const sl = spawnSync("bun", [...CLI, "session", "list"], { env, encoding: "utf8" });
  const slOut = (sl.stdout ?? "") + (sl.stderr ?? "");
  if (sl.status !== 0 && /Postgres/i.test(slOut)) {
    console.log("PASS: `session list` fails clearly (names Postgres) without a connection");
  } else {
    failures.push(
      `session list did not fail clearly (status=${sl.status}, mentionsPostgres=${/Postgres/i.test(slOut)})`
    );
  }

  rmSync(home, { recursive: true, force: true });

  if (failures.length > 0) {
    console.error(`\nFAIL:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    return 1;
  }
  console.log("\nAll no-Postgres boot-tolerance checks passed.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("smoke-no-postgres-boot crashed:", err);
    process.exit(1);
  });
