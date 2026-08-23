#!/usr/bin/env bun
/**
 * mt#4413 — live coverage for mt#3816's AT4 "no listener" half and AT5 client run.
 *
 * ## Why this script exists rather than a unit test
 *
 * `setup-local-http.test.ts` covers acceptance tests 1-4 in unit form against an
 * INJECTED filesystem, and every one of those cases passes `skipDaemon: true`.
 * Two halves of mt#3816 are therefore untestable there by construction:
 *
 *   - **AT4's second clause** — *"assert ... the daemon port has no listener"*.
 *     A test that skips the daemon cannot observe a listener either way.
 *   - **AT5** — *"drive a real `claude -p --mcp-config <cfg> --strict-mcp-config`
 *     at each and assert a Minsky tool call succeeds through both"*. mt#3816's own
 *     wording says this *"needs the live client, not a config-shape assertion."*
 *
 * The header of that test file claimed both were *"exercised against real processes
 * in scripts/verify-setup-local-http.ts"* — a script that had never existed. This is
 * that script.
 *
 * ## Why the positive control comes first
 *
 * "The port has no listener" is trivially true when the daemon never started, so
 * asserting it alone is a probe that cannot fail (mem#704). Half A therefore asserts
 * the port IS listening after `--execute` BEFORE asserting it is NOT after
 * `--revert`. Without that first assertion the whole half passes on a machine where
 * the spawn is broken.
 *
 * ## Isolation
 *
 * Every daemon runs against a scratch project root and on a non-default port, so
 * an operator's real daemon is neither probed nor stopped and no daemon is ever
 * handed the operator's working tree.
 *
 * HOME differs by half, deliberately. Half A passes a scratch home, so the two
 * files `revertCandidates` targets are `<scratch>/.mcp.json` and
 * `<scratchHome>/.claude.json` — never the operator's own. Half B INHERITS the
 * real HOME, because the `claude` client's credentials live there and it cannot
 * authenticate without them; that is why the end-of-run check is scoped as it is,
 * and `mcpServersFingerprint` carries the measurement behind that choice. The
 * script fingerprints the operator's MCP configuration before and after and fails
 * if it moved — whole-file for the repo's `.mcp.json`, and the `mcpServers` subtree
 * for `~/.claude.json`, which is also the `claude` client's own state file and is
 * rewritten by any client run. `mcpServersFingerprint` carries why that narrowing
 * is the honest invariant rather than a loosened one.
 *
 * Run: bun scripts/verify-setup-local-http.ts
 * Exit 0 = every half that could run, passed (a SKIPPED half is not a failure).
 * Exit 1 = a half ran and failed.
 */

import { spawn, type ChildProcess } from "child_process";
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { runSetupLocalHttp } from "../src/adapters/shared/commands/setup-local-http";
import { projectConfigPath, claudeJsonPath } from "../src/mcp/setup/local-http-config";

const HOST = "127.0.0.1";
const PORT = Number(process.env.MT4413_VERIFY_PORT ?? 48803);
const MCP_URL = `http://${HOST}:${PORT}/mcp`;
const HEALTH_URL = `http://${HOST}:${PORT}/health`;
const REPO = process.cwd();

/** Half B drives a real model, which costs tokens and time — so it is opt-in. */
const LIVE_CLIENT_OPT_IN = process.env.MT4413_LIVE_CLIENT === "1";

type HalfOutcome = { state: "pass" | "skip" | "fail"; detail: string };

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/**
 * Whether ANYTHING accepts a TCP connection on the port.
 *
 * Deliberately a raw connect rather than a `/health` fetch: AT4 asks whether the
 * PORT has a listener, and a daemon that is up but unhealthy would answer that
 * question wrongly through an HTTP probe.
 */
function hasListener(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: HOST, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForListener(port: number, want: boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await hasListener(port)) === want) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function waitForHealthy(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = (await res.json()) as { ready?: boolean };
        if (body.ready === true) return true;
      }
    } catch {
      // intentional-swallow: still booting; the deadline governs.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function sha256OrAbsent(file: string): string {
  if (!existsSync(file)) return "absent";
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Fingerprint of a config's MCP-SERVER declarations, ignoring everything else.
 *
 * Used for `~/.claude.json`, and the narrowing is deliberate. That file is BOTH
 * the operator's MCP config and the `claude` client's own mutable state — it
 * records conversation history and per-project bookkeeping, and the client
 * rewrites it on every run. So whole-file byte identity cannot survive Half B
 * driving a real client, and the two requirements are not jointly satisfiable:
 *
 *   - Redirecting HOME moves the writes, but the client's CREDENTIALS live there
 *     too, so it answers "Not logged in · Please run /login" and verifies nothing.
 *   - `CLAUDE_CONFIG_DIR` was measured (2026-08-22): it does relocate the state
 *     and leaves the real file byte-identical — and loses auth the same way, for
 *     the same reason.
 *
 * What this script must not do is damage the operator's MCP CONFIGURATION, which
 * is what `mcpServers` holds; a client updating its own history is what running
 * the client means. So the invariant is scoped to that subtree. The repo's
 * `.mcp.json` keeps the strict whole-file check — nothing legitimately writes it.
 */
function mcpServersFingerprint(file: string): string {
  if (!existsSync(file)) return "absent";
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    const servers =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)["mcpServers"]
        : undefined;
    return createHash("sha256")
      .update(JSON.stringify(servers ?? null))
      .digest("hex");
  } catch {
    // A malformed file cannot be compared subtree-wise; fall back to bytes so a
    // corruption introduced by this run still shows up as a difference.
    return sha256OrAbsent(file);
  }
}

function makeScratch(): { root: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), "mt4413-"));
  const root = join(base, "project");
  const home = join(base, "home");
  mkdirSync(root, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { root, home };
}

// ---------------------------------------------------------------------------
// Half A — AT4's "no listener" clause
// ---------------------------------------------------------------------------

async function runNoListenerHalf(): Promise<HalfOutcome> {
  console.log("\n[mt#4413] HALF A — AT4 'no listener' after --revert");

  if (await hasListener(PORT)) {
    return {
      state: "skip",
      detail:
        `something is already listening on ${HOST}:${PORT}, so neither the ` +
        `positive nor the negative assertion would mean anything. Set ` +
        `MT4413_VERIFY_PORT to a free port to run this half.`,
    };
  }

  const { root, home } = makeScratch();
  const configFile = projectConfigPath(root);

  // A proxy-form entry the migration will actually rewrite. `command: "minsky"`
  // is required, not incidental: `canRouteShim` rejects `bun .../cli.ts` forms
  // because `mcp shim` is intercepted by the package bin and never reaches
  // `src/cli.ts`, so a dev-form entry is discovered and then correctly left alone.
  const original = `${JSON.stringify(
    { mcpServers: { "minsky-proxy": { command: "minsky", args: ["mcp", "proxy"] } } },
    null,
    2
  )}\n`;
  writeFileSync(configFile, original);
  const originalHash = sha256OrAbsent(configFile);

  // `argv` is a real seam, not decoration: `resolveSelfInvocation` reads argv[1]
  // and would otherwise resolve to THIS script — spawning a daemon that re-runs
  // the verifier instead of the CLI.
  const argv = [process.argv[0] ?? "bun", "src/cli.ts"];
  const common = { url: MCP_URL, repo: root } as const;

  let daemon: "started" | "not-started" = "not-started";
  try {
    const applied = await runSetupLocalHttp({ ...common, execute: true }, { home, argv });
    console.log(`[mt#4413]   execute: ${applied.message}`);

    if (!(await waitForListener(PORT, true, 60_000))) {
      return {
        state: "fail",
        detail:
          `after --execute nothing was listening on ${HOST}:${PORT} within 60s. ` +
          `This is the POSITIVE control: without it, the no-listener assertion ` +
          `below would pass on a machine where the daemon never starts.`,
      };
    }
    daemon = "started";
    const healthy = await waitForHealthy(30_000);
    console.log(`[mt#4413]   listener present after --execute (ready:${healthy})`);

    if (sha256OrAbsent(configFile) === originalHash) {
      return {
        state: "fail",
        detail: "--execute left the config byte-identical; nothing was migrated to revert.",
      };
    }

    const reverted = await runSetupLocalHttp(
      { ...common, execute: true, revert: true },
      {
        home,
        argv,
      }
    );
    console.log(`[mt#4413]   revert: ${reverted.message}`);

    if (sha256OrAbsent(configFile) !== originalHash) {
      return { state: "fail", detail: "--revert did not restore the original config bytes." };
    }

    if (!(await waitForListener(PORT, false, 30_000))) {
      return {
        state: "fail",
        detail:
          `--revert restored the config but ${HOST}:${PORT} still has a listener ` +
          `after 30s — AT4's second clause is unmet.`,
      };
    }
    daemon = "not-started";

    return {
      state: "pass",
      detail: "config bytes restored AND the daemon port has no listener (positive control held).",
    };
  } finally {
    if (daemon === "started") {
      // Best-effort: leave nothing behind even on the failure paths above.
      await runSetupLocalHttp({ ...common, execute: true, revert: true }, { home, argv }).catch(
        () => undefined
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Half B — AT5's live client through BOTH entry forms
// ---------------------------------------------------------------------------

interface StreamEvent {
  type?: string;
  message?: { content?: Array<{ type?: string; name?: string; is_error?: boolean }> };
}

/**
 * Drive one `claude -p` run and report whether a tool from `server` was invoked.
 *
 * Asserts on the `tool_use` EVENT rather than on the prose answer: a model can
 * write a plausible reply without ever reaching the server, and `--strict-mcp-config`
 * plus a broken entry produces exactly that. The tool name carries the server name
 * (`mcp__<server>__<tool>`), which is what makes this discriminate BETWEEN the two
 * coexisting entries rather than merely proving "some Minsky tool worked".
 */
async function driveClient(configFile: string, server: string): Promise<string | null> {
  const toolName = `mcp__${server}__debug_echo`;
  const prompt =
    `Call the ${toolName} tool with message "mt4413". ` +
    `Then reply with exactly DONE. Do not use any other tool.`;

  const child = spawn(
    "claude",
    [
      "-p",
      prompt,
      "--mcp-config",
      configFile,
      "--strict-mcp-config",
      "--output-format",
      "stream-json",
      "--verbose",
    ],
    // Inherits HOME deliberately — see `assertMcpConfigUnchanged` for why the
    // end-of-run check is scoped to the MCP config rather than to whole-file
    // byte identity of the client's own state file.
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] }
  );

  let out = "";
  let err = "";
  child.stdout?.on("data", (d) => (out += d.toString()));
  child.stderr?.on("data", (d) => (err += d.toString()));

  const exitCode = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve(-1);
    }, 180_000);
    const settle = (code: number) => {
      clearTimeout(timer);
      resolve(code);
    };
    // `error` fires when the binary cannot be spawned at all, and it fires
    // INSTEAD of `close` — listening only for `close` turns "not installed" into
    // a 180s wait ending in a timeout message that names the wrong cause.
    child.once("error", () => settle(-2));
    child.once("close", (code) => settle(code ?? -1));
  });

  if (exitCode === -2) return `${server}: could not spawn \`claude\`.`;
  if (exitCode === -1) return `${server}: the client did not finish within 180s.`;

  let invoked = false;
  let errored = false;
  for (const line of out.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event: StreamEvent;
    try {
      event = JSON.parse(line) as StreamEvent;
    } catch {
      // intentional-swallow: partial or non-JSON line; the assertions below govern.
      continue;
    }
    for (const block of event.message?.content ?? []) {
      if (block.type === "tool_use" && block.name === toolName) invoked = true;
      if (block.type === "tool_result" && block.is_error === true) errored = true;
    }
  }

  if (!invoked) {
    return (
      `${server}: no \`tool_use\` for ${toolName} appeared in the stream, so the ` +
      `entry never served a Minsky tool call.\n  exit=${exitCode}\n  ${err.slice(-600)}`
    );
  }
  if (errored) return `${server}: ${toolName} was invoked but returned an error result.`;
  return null;
}

async function runLiveClientHalf(): Promise<HalfOutcome> {
  console.log("\n[mt#4413] HALF B — AT5 live client through proxy AND shim entries");

  if (!LIVE_CLIENT_OPT_IN) {
    return {
      state: "skip",
      detail:
        "MT4413_LIVE_CLIENT=1 not set. This half drives a real model through two " +
        "clients, which costs tokens and minutes, so it is opt-in rather than default.",
    };
  }
  // Both binaries are preconditions, not just `claude`: every entry in the
  // config below invokes `minsky`, so a missing one turns a genuine SKIP into
  // two tool-call failures that read as a real AT5 regression.
  const missing = ["claude", "minsky"].filter((bin) => Bun.which(bin) === null);
  if (missing.length > 0) {
    return {
      state: "skip",
      detail: `not on PATH: ${missing.join(", ")}. This half needs both to drive a real client.`,
    };
  }
  if (await hasListener(PORT)) {
    return { state: "skip", detail: `${HOST}:${PORT} is occupied; cannot run an isolated daemon.` };
  }

  const { root } = makeScratch();
  const configFile = join(root, "coexist.mcp.json");

  // Both forms, under DIFFERENT names, in ONE config — that pairing is the
  // coexistence claim AT5 states, and it is why each assertion keys on the
  // server name rather than on "a Minsky tool ran".
  writeFileSync(
    configFile,
    `${JSON.stringify(
      {
        mcpServers: {
          "minsky-proxy-e2e": { command: "minsky", args: ["mcp", "proxy"] },
          "minsky-shim-e2e": { command: "minsky", args: ["mcp", "shim", "--url", MCP_URL] },
        },
      },
      null,
      2
    )}\n`
  );

  const daemon: ChildProcess = spawn(
    "bun",
    [
      "run",
      "src/cli.ts",
      "mcp",
      "start",
      "--http",
      "--local-daemon",
      "--host",
      HOST,
      "--port",
      String(PORT),
      // The SCRATCH root, matching Half A — whose daemon gets it from
      // `runSetupLocalHttp`'s projectRoot. Pointing this at the real repo would
      // hand a daemon the operator's working tree for the duration of the run,
      // which contradicts this script's isolation claim (PR #3247 R1).
      "--repo",
      root,
    ],
    // `cwd` stays the repo: that is where `src/cli.ts` is resolved from, and it
    // decides nothing about which tree the daemon serves.
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] }
  );
  let daemonLog = "";
  daemon.stdout?.on("data", (d) => (daemonLog += d.toString()));
  daemon.stderr?.on("data", (d) => (daemonLog += d.toString()));

  try {
    if (!(await waitForHealthy(90_000))) {
      return {
        state: "fail",
        detail: `the scratch daemon never reported ready:true within 90s.\n${daemonLog.slice(-1200)}`,
      };
    }
    console.log(`[mt#4413]   scratch daemon ready on ${HOST}:${PORT}`);

    const failures: string[] = [];
    for (const server of ["minsky-proxy-e2e", "minsky-shim-e2e"]) {
      const failure = await driveClient(configFile, server);
      console.log(`[mt#4413]   ${server}: ${failure === null ? "PASS" : "FAIL"}`);
      if (failure !== null) failures.push(failure);
    }

    return failures.length === 0
      ? { state: "pass", detail: "a Minsky tool call succeeded through BOTH entries." }
      : { state: "fail", detail: failures.join("\n") };
  } finally {
    try {
      daemon.kill("SIGTERM");
    } catch {
      // intentional-swallow: best-effort teardown; it may already be gone.
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  console.log(`[mt#4413] verifying mt#3816's AT4/AT5 live halves on ${HOST}:${PORT}`);

  // SC4 / AT4-of-this-task: the operator's own configs must be byte-identical
  // after any run. Captured here and re-read at the end.
  const realProject = projectConfigPath(REPO);
  const realHome = claudeJsonPath(homedir());
  const before = { project: sha256OrAbsent(realProject), home: mcpServersFingerprint(realHome) };

  const halves: Array<[string, HalfOutcome]> = [];
  halves.push(["A (AT4 no-listener)", await runNoListenerHalf()]);
  halves.push(["B (AT5 live client)", await runLiveClientHalf()]);

  const after = { project: sha256OrAbsent(realProject), home: mcpServersFingerprint(realHome) };
  const untouched = before.project === after.project && before.home === after.home;

  console.log("\n[mt#4413] ── summary ─────────────────────────────────────────");
  for (const [name, outcome] of halves) {
    console.log(
      `[mt#4413] ${outcome.state.toUpperCase().padEnd(4)} half ${name}: ${outcome.detail}`
    );
  }
  console.log(
    `[mt#4413] operator MCP config unchanged: ${untouched ? "yes" : "NO"} ` +
      `(${realProject} bytes; ${realHome} mcpServers)`
  );

  if (!untouched) {
    console.error(
      "[mt#4413] FAIL: this run changed the operator's MCP configuration outside its scratch roots."
    );
    return 1;
  }
  if (halves.some(([, o]) => o.state === "fail")) return 1;
  if (halves.every(([, o]) => o.state === "skip")) {
    console.log("[mt#4413] SKIP: neither half could run; nothing was verified.");
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(
      `[mt#4413] unexpected failure: ${err instanceof Error ? err.stack : String(err)}`
    );
    process.exit(1);
  });
