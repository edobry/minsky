#!/usr/bin/env bun
/**
 * Smoke: mcp start --http orphan/idle exit path (mt#3764)
 *
 * Exercises the two live-process mechanisms in src/mcp/orphan-exit.ts
 * against real OS process behavior — the class of correctness no unit test
 * (which injects a fake clock and fake ppid) can cover on its own:
 *
 *   AT1 (parent-death): spawn `mcp start --http` as the child of a short
 *   bash wrapper, SIGKILL the wrapper (leaving the server orphaned exactly
 *   like the mt#3764 incident process), and verify the server exits within
 *   the bounded poll window instead of persisting.
 *
 *   AT2 (never-connected idle exit): spawn `mcp start --http` directly (a
 *   non-hosted ppid, so the watcher is armed by default), never connect an
 *   MCP client, and verify it self-terminates within the bounded window.
 *
 *   AT3 (hosted-deployment safety, static half): assert the root
 *   Dockerfile's CMD uses SHELL form (not the JSON exec-array form). Shell
 *   form is what makes `bun` a CHILD of the container's PID-1 shell (ppid
 *   1 from the first tick) rather than PID 1 itself (ppid 0) — the
 *   invariant `looksLikeHostedEntrypoint()`'s ppid-1 check depends on. The
 *   dynamic half of AT3 (the gating decision itself) is covered
 *   deterministically by the injected-clock unit tests in
 *   src/mcp/orphan-exit.test.ts — spawning a REAL ppid-1 process requires
 *   an actual container and is intentionally not attempted here.
 *
 * Runnable: `bun scripts/smoke-mcp-http-orphan-exit.ts`. Self-contained —
 * throwaway XDG_CONFIG_HOME, no Postgres required (mirrors
 * scripts/smoke-no-postgres-boot.ts's boot-tolerance pattern). Exit 0 =
 * pass, non-zero = fail.
 */

import { spawn, spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const CLI = ["run", "src/cli.ts"];

function envFor(home: string, overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, XDG_CONFIG_HOME: home, ...overrides } as NodeJS.ProcessEnv;
  delete env.MINSKY_POSTGRES_URL;
  delete env.MINSKY_PERSISTENCE_POSTGRES_URL;
  delete env.MINSKY_PERSISTENCE_POSTGRES_CONNECTIONSTRING;
  return env;
}

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "mt3764-smoke-"));
  mkdirSync(join(home, "minsky"), { recursive: true });
  writeFileSync(join(home, "minsky", "config.yaml"), "version: 1\nbackendConfig: {}\n");
  return home;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  pollMs = 250
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(pollMs);
  }
  return predicate();
}

// --- AT1: parent-death exit -------------------------------------------------
async function testParentDeathExit(): Promise<string | null> {
  const home = makeHome();
  const port = 31000 + Math.floor(Math.random() * 2000);
  const pidFile = join(home, "child.pid");
  const pollMs = 300;
  const env = envFor(home, {
    MINSKY_MCP_PARENT_DEATH_POLL_MS: String(pollMs),
    // Isolate: don't let the never-connected watcher's default 30-minute
    // window interfere (it won't fire in this short test regardless, but
    // disabling it keeps the test's intent — parent-death only — explicit).
    MINSKY_MCP_DISABLE_NEVER_CONNECTED_EXIT: "1",
  });

  // Wrapper bash: backgrounds the mcp server, records ITS pid, then waits
  // on it. SIGKILLing the wrapper does NOT kill the backgrounded child
  // (kill targets only the named pid) — the child is left running with a
  // now-dead original parent, exactly like the mt#3764 incident process.
  const bunBin = process.execPath;
  const wrapperScript = [
    `${JSON.stringify(bunBin)} ${CLI.map((a) => JSON.stringify(a)).join(" ")} mcp start --http --host=127.0.0.1 --port=${port} >/dev/null 2>&1 &`,
    `echo $! > ${JSON.stringify(pidFile)}`,
    `wait`,
  ].join("\n");

  const wrapper = spawn("bash", ["-c", wrapperScript], { env, stdio: "ignore" });
  const wrapperPid = wrapper.pid;
  if (!wrapperPid) {
    rmSync(home, { recursive: true, force: true });
    return "AT1: failed to spawn bash wrapper";
  }

  try {
    const gotPidFile = await waitUntil(() => existsSync(pidFile), 10_000, 100);
    if (!gotPidFile) return "AT1: wrapper never wrote the child pid file within 10s";

    const childPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (!Number.isFinite(childPid)) return `AT1: unreadable child pid in ${pidFile}`;

    // Wait for /health, not just OS-level pid existence: `wireOrphanExitWatchers`
    // runs late in the boot sequence (after the HTTP listener is already up),
    // so killing the wrapper the instant the pid EXISTS races the watcher's
    // own `initialPpid` capture — if the wrapper is already dead by the time
    // that line runs, the watcher records the POST-reparent ppid as its
    // baseline and never observes a "transition". A /health 200 guarantees
    // boot has progressed well past that point.
    const healthy = await waitUntil(
      () => {
        const result = spawnSync("curl", ["-fsS", `http://127.0.0.1:${port}/health`], {
          stdio: "ignore",
          timeout: 2_000,
        });
        return result.status === 0;
      },
      20_000,
      300
    );
    if (!healthy) return `AT1: child pid ${childPid} never served /health 200 within 20s`;

    // Kill ONLY the wrapper — leaves the mcp server orphaned.
    try {
      process.kill(wrapperPid, "SIGKILL");
    } catch {
      // already gone
    }

    // The watcher polls every `pollMs`; give it a generous multiple as
    // margin over one poll tick before declaring failure.
    const exited = await waitUntil(() => !isPidAlive(childPid), pollMs * 10 + 5_000, 200);
    if (!exited) {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // best-effort cleanup
      }
      return `AT1: orphaned mcp server (pid ${childPid}) did not self-exit within ${pollMs * 10 + 5_000}ms of its parent dying`;
    }
    return null;
  } finally {
    try {
      if (wrapper.pid) process.kill(wrapper.pid, "SIGKILL");
    } catch {
      // already gone
    }
    rmSync(home, { recursive: true, force: true });
  }
}

// --- AT2: never-connected idle exit ----------------------------------------
async function testNeverConnectedExit(): Promise<string | null> {
  const home = makeHome();
  const port = 33000 + Math.floor(Math.random() * 2000);
  const timeoutMs = 3_000;
  const env = envFor(home, {
    MINSKY_MCP_NEVER_CONNECTED_TIMEOUT_MS: String(timeoutMs),
    MINSKY_MCP_DISABLE_PARENT_DEATH_EXIT: "1",
  });

  const server = spawn(
    process.execPath,
    [...CLI, "mcp", "start", "--http", "--host=127.0.0.1", `--port=${port}`],
    { env, stdio: "ignore" }
  );
  const pid = server.pid;
  if (!pid) {
    rmSync(home, { recursive: true, force: true });
    return "AT2: failed to spawn mcp server";
  }

  try {
    const up = await waitUntil(() => isPidAlive(pid), 15_000, 250);
    if (!up) return `AT2: server pid ${pid} never came alive within 15s`;

    // Deliberately never connect an MCP client and never probe /health —
    // the point of this test is a server that NOTHING ever talks to.
    const exited = await waitUntil(() => !isPidAlive(pid), timeoutMs + 8_000, 250);
    if (!exited) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // best-effort cleanup
      }
      return `AT2: never-connected mcp server (pid ${pid}) did not self-exit within ${timeoutMs + 8_000}ms`;
    }
    return null;
  } finally {
    try {
      if (server.pid) process.kill(server.pid, "SIGKILL");
    } catch {
      // already gone
    }
    rmSync(home, { recursive: true, force: true });
  }
}

// --- AT3 (static half): Dockerfile CMD is shell form ------------------------
function testDockerfileShellFormCmd(): string | null {
  const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");
  const cmdLines = dockerfile
    .split("\n")
    .filter((line) => /^\s*CMD\b/.test(line) && !/^\s*#/.test(line));
  if (cmdLines.length === 0) return "AT3: no CMD line found in root Dockerfile";
  const cmdLine = cmdLines[cmdLines.length - 1] ?? "";
  // JSON exec-array form looks like: CMD ["bun", "run", ...]
  const isExecForm = /^\s*CMD\s*\[/.test(cmdLine);
  if (isExecForm) {
    return (
      `AT3: Dockerfile CMD uses JSON exec-array form — this would make bun PID 1 ` +
      `directly (ppid 0, not 1), breaking looksLikeHostedEntrypoint()'s ppid-1 ` +
      `assumption. Keep CMD in shell form, or update looksLikeHostedEntrypoint() ` +
      `to also treat ppid 0 as hosted-shaped. Found: ${cmdLine.trim()}`
    );
  }
  if (!/mcp start --http/.test(cmdLine)) {
    return `AT3: Dockerfile CMD does not look like an 'mcp start --http' invocation: ${cmdLine.trim()}`;
  }
  return null;
}

async function main(): Promise<number> {
  const failures: string[] = [];

  console.log("Running AT1 (parent-death exit)...");
  const at1 = await testParentDeathExit();
  if (at1) {
    failures.push(at1);
  } else {
    console.log("PASS: AT1 — orphaned mcp server self-exits after its parent dies");
  }

  console.log("Running AT2 (never-connected idle exit)...");
  const at2 = await testNeverConnectedExit();
  if (at2) {
    failures.push(at2);
  } else {
    console.log("PASS: AT2 — never-connected mcp server self-exits within its idle window");
  }

  console.log("Running AT3 (static: Dockerfile CMD shell-form invariant)...");
  const at3 = testDockerfileShellFormCmd();
  if (at3) {
    failures.push(at3);
  } else {
    console.log(
      "PASS: AT3 (static) — Dockerfile CMD is shell form, so the hosted bun process's " +
        "ppid is 1 from the first tick (never-connected watcher's default gate is inapplicable there)"
    );
  }

  if (failures.length > 0) {
    console.error(`\nFAIL:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
    return 1;
  }
  console.log("\nAll mcp start --http orphan-exit smoke checks passed.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("smoke-mcp-http-orphan-exit crashed:", err);
    process.exit(1);
  });
