#!/usr/bin/env bun
/**
 * Live acceptance run for `minsky setup local-http` (mt#3816).
 *
 * Covers the acceptance tests that unit tests structurally cannot: a real
 * daemon process, a real `claude` client reaching Minsky's tool surface through
 * BOTH a proxy entry and a shim entry at once (AT5), and the revert leaving no
 * listener behind (AT4/AT6).
 *
 * ## Isolation
 *
 * This machine normally has a local daemon serving 48765 with a discovery
 * record at `~/.local/state/minsky/local-mcp.json`. That file is a fixed path
 * and last-writer-wins, so a second daemon started without care would clobber
 * the live daemon's record. Everything here is therefore scoped:
 *
 *   - `MINSKY_STATE_DIR`             → a scratch dir (its own discovery record)
 *   - `MINSKY_LOCAL_MCP_TOKEN_PATH`  → a scratch token
 *   - `--port 48799`                 → not the contract port
 *   - a scratch HOME and project root for the config scan
 *
 * The operator's daemon is never probed, signalled, or written to.
 *
 * Usage: bun scripts/verify-setup-local-http.ts
 * Exit 0 = every check passed (or SKIPped for a missing precondition).
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { runSetupLocalHttp } from "../src/adapters/shared/commands/setup-local-http";

const TEST_PORT = 48799;
const MCP_URL = `http://127.0.0.1:${TEST_PORT}/mcp`;
const HEALTH_URL = `http://127.0.0.1:${TEST_PORT}/health`;
const REPO_ROOT = path.resolve(import.meta.dir, "..");

let failures = 0;
let skipped = 0;

function check(label: string, ok: boolean, detail = ""): void {
  const status = ok ? "PASS" : "FAIL";
  if (!ok) failures++;
  console.log(`[${status}] ${label}${detail ? ` — ${detail}` : ""}`);
}

function skip(label: string, why: string): void {
  skipped++;
  console.log(`[SKIP] ${label} — ${why}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function probeHealth(): Promise<{ ok: boolean; service?: string }> {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json()) as { service?: string };
    return { ok: true, ...(body.service === undefined ? {} : { service: body.service }) };
  } catch {
    return { ok: false };
  }
}

function listenerPid(port: number): number | null {
  const out = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const first = String(out.stdout ?? "")
    .trim()
    .split(/\s+/)[0];
  if (!first) return null;
  const pid = Number.parseInt(first, 10);
  return Number.isFinite(pid) ? pid : null;
}

async function main(): Promise<void> {
  const existing = listenerPid(TEST_PORT);
  if (existing !== null) {
    console.error(
      `Refusing to run: port ${TEST_PORT} is already held by pid ${existing}. ` +
        `This script needs an unused port so it cannot disturb a real daemon.`
    );
    process.exit(1);
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mt3816-"));
  const home = path.join(tmp, "home");
  const project = path.join(tmp, "project");
  const stateDir = path.join(tmp, "state");
  const tokenPath = path.join(tmp, "local-mcp-token");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  console.log(`scratch: ${tmp}\n`);

  // Two Minsky entries under distinct names, both starting on the proxy. Only
  // one is migrated, which is the side-by-side transition AT5 exercises.
  const configPath = path.join(project, ".mcp.json");
  const original = `${JSON.stringify(
    {
      mcpServers: {
        "minsky-proxy": {
          command: process.argv[0],
          args: [
            path.join(REPO_ROOT, "src/cli.ts"),
            "mcp",
            "proxy",
            "--child-args",
            JSON.stringify(["mcp", "start", "--repo", REPO_ROOT]),
          ],
        },
        "minsky-shim": {
          command: process.argv[0],
          args: [
            path.join(REPO_ROOT, "src/cli.ts"),
            "mcp",
            "proxy",
            "--child-args",
            JSON.stringify(["mcp", "start", "--repo", REPO_ROOT]),
          ],
        },
      },
    },
    null,
    2
  )}\n`;
  fs.writeFileSync(configPath, original, "utf8");

  // ---- AT1/AT2: dry-run writes nothing; --execute rewrites + backs up -------
  const dry = await runSetupLocalHttp(
    { url: MCP_URL, repo: project, server: ["minsky-shim"] },
    { home, cwd: project, skipDaemon: true }
  );
  check(
    "AT1 dry-run leaves the config byte-identical",
    fs.readFileSync(configPath, "utf8") === original
  );
  check(
    "AT1 dry-run reports a pending change",
    dry.changed === false && /would be migrated/.test(dry.message)
  );

  await runSetupLocalHttp(
    { url: MCP_URL, repo: project, server: ["minsky-shim"], execute: true },
    { home, cwd: project, skipDaemon: true }
  );
  const migrated = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    mcpServers: Record<string, { args: string[]; env?: Record<string, string> }>;
  };
  check(
    "AT2 the named entry is on the shim",
    JSON.stringify(migrated.mcpServers["minsky-shim"]?.args?.slice(-4)) ===
      JSON.stringify(["mcp", "shim", "--url", MCP_URL])
  );
  check(
    "coexistence: the unnamed sibling is untouched on the proxy",
    migrated.mcpServers["minsky-proxy"]?.args?.includes("proxy") === true
  );
  const backup = fs
    .readdirSync(project)
    .filter((n) => n.startsWith(".mcp.json.minsky-backup-"))
    .sort()
    .pop();
  check(
    "AT2 the backup holds the original bytes",
    backup !== undefined && fs.readFileSync(path.join(project, backup), "utf8") === original
  );

  // ---- AT3: a second --execute is a no-op ----------------------------------
  const afterFirst = fs.readFileSync(configPath, "utf8");
  const second = await runSetupLocalHttp(
    { url: MCP_URL, repo: project, server: ["minsky-shim"], execute: true },
    { home, cwd: project, skipDaemon: true }
  );
  check(
    "AT3 a second --execute changes nothing",
    second.changed === false && fs.readFileSync(configPath, "utf8") === afterFirst
  );

  // ---- Start an isolated daemon -------------------------------------------
  const daemonEnv = {
    ...process.env,
    MINSKY_STATE_DIR: stateDir,
    MINSKY_LOCAL_MCP_TOKEN_PATH: tokenPath,
  };
  const daemon = spawn(
    process.argv[0] as string,
    [
      path.join(REPO_ROOT, "src/cli.ts"),
      "mcp",
      "start",
      "--http",
      "--local-daemon",
      "--port",
      String(TEST_PORT),
      "--repo",
      REPO_ROOT,
    ],
    { env: daemonEnv, stdio: "ignore", detached: true }
  );
  daemon.unref();

  let health: { ok: boolean; service?: string } = { ok: false };
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    health = await probeHealth();
    if (health.ok) break;
  }
  check(
    "daemon answers /health as minsky-mcp",
    health.ok && health.service === "minsky-mcp",
    health.service ?? "no response"
  );
  check(
    "the operator's discovery record was NOT touched",
    fs.existsSync(path.join(stateDir, "local-mcp.json"))
  );

  // ---- AT5: a real client through BOTH entries -----------------------------
  const claudeBin = spawnSync("which", ["claude"], { encoding: "utf8" }).stdout.trim();
  if (!health.ok) {
    skip("AT5 live client through both entries", "daemon never became healthy");
  } else if (!claudeBin) {
    skip("AT5 live client through both entries", "claude is not on PATH");
  } else {
    // The shim reads its bearer token from this path; the proxy spawns its own
    // stdio server and needs neither.
    const clientConfig = path.join(tmp, "client-mcp.json");
    const entry = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    const shimEntry = entry.mcpServers["minsky-shim"] as Record<string, unknown>;
    shimEntry["env"] = { MINSKY_LOCAL_MCP_TOKEN_PATH: tokenPath };
    fs.writeFileSync(clientConfig, JSON.stringify(entry, null, 2), "utf8");

    for (const server of ["minsky-proxy", "minsky-shim"]) {
      const prompt =
        `Call the tool mcp__${server}__debug_echo with message "mt3816-${server}". ` +
        `Then reply with exactly the word DONE and nothing else.`;
      const run = spawnSync(
        claudeBin,
        [
          "-p",
          prompt,
          "--mcp-config",
          clientConfig,
          "--strict-mcp-config",
          "--dangerously-skip-permissions",
        ],
        { encoding: "utf8", timeout: 180_000, cwd: project }
      );
      const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
      check(
        `AT5 a Minsky tool call succeeds through "${server}"`,
        out.includes(`mt3816-${server}`) || /DONE/.test(out),
        out.trim().split("\n").slice(-1)[0]?.slice(0, 120) ?? "no output"
      );
    }
  }

  // ---- AT4: revert restores bytes and stops the daemon ----------------------
  const reverted = await runSetupLocalHttp(
    { revert: true, execute: true, repo: project },
    {
      home,
      cwd: project,
      daemon: {
        readRecord: () => {
          const record = path.join(stateDir, "local-mcp.json");
          if (!fs.existsSync(record)) return null;
          return JSON.parse(fs.readFileSync(record, "utf8")) as {
            port: number;
            host: string;
            pid: number;
            startedAt: string;
          };
        },
        probe: async () => {
          const h = await probeHealth();
          return h.ok
            ? { kind: "body", body: { service: h.service } }
            : { kind: "unreachable", detail: "no answer" };
        },
      },
    }
  );
  check(
    "AT4 --revert restores the pre-migration bytes",
    fs.readFileSync(configPath, "utf8") === original,
    reverted.message
  );

  await sleep(1500);
  const stillListening = listenerPid(TEST_PORT);
  check(
    "AT4 the daemon port has no listener after revert",
    stillListening === null,
    stillListening === null ? "" : `pid ${stillListening} still listening`
  );

  // ---- AT6: no leftovers ---------------------------------------------------
  const leftovers = spawnSync("pgrep", ["-f", `--port ${TEST_PORT}`], { encoding: "utf8" });
  const leftoverPids = String(leftovers.stdout ?? "").trim();
  check("AT6 no leftover processes from this run", leftoverPids === "", leftoverPids);

  if (stillListening !== null) {
    // Never leave a process behind, even on a failed run.
    try {
      process.kill(stillListening, "SIGTERM");
    } catch {
      console.log(`could not signal leftover pid ${stillListening}`);
    }
  }

  console.log(`\nscratch dir left for inspection: ${tmp}`);
  console.log(
    failures === 0 ? `\nALL CHECKS PASSED (${skipped} skipped)` : `\n${failures} CHECK(S) FAILED`
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
