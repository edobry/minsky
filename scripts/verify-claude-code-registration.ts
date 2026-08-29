#!/usr/bin/env bun
/**
 * Live verification for the ClaudeCodeRegistrar (mt#4676).
 *
 * Why a unit test is not enough. Every registration test in
 * `packages/domain/src/mcp/registration.test.ts` injects a mock FsLike, which
 * proves the merge LOGIC is correct — that it preserves an existing
 * `projects` key, overwrites a stale `minsky-server` entry, etc. It cannot
 * prove the write lands correctly against the REAL, live `~/.claude.json` —
 * a 90KB+ file carrying real OAuth credentials and per-project state whose
 * actual shape no mock can fully anticipate. And no unit test can prove the
 * registered entry is actually REACHABLE: that requires a fresh Claude Code
 * process to reload `~/.claude.json` and call an `mcp__minsky__*` tool,
 * which cannot happen from inside the same running conversation that wrote
 * the file (MCP servers resolve once, at process start).
 *
 * What this script does:
 *   1. Reports what `detectAgentHarness()` / `detectInstalledClients()` /
 *      `resolveInitClient()` resolve to in the CURRENT live environment.
 *   2. Dry-run (default): reads the real `~/.claude.json`, reports whether a
 *      user-scope `minsky-server` entry already exists, and previews the
 *      exact entry `--execute` would write (the SHIM form — PR #3423 R2;
 *      `ClaudeCodeRegistrar` no longer emits the raw stdio-spawn `mcp start`
 *      form the base registrar class defaults to) — no writes.
 *   3. Probes the local daemon's `/health` endpoint (best-effort, 2s
 *      timeout) and reports whether it is reachable. The shim entry this
 *      script previews/writes CONNECTS to that daemon; if it is not running,
 *      every MCP tool call through the shim retries for up to
 *      `RETRY_WINDOW_MS` (15s, `src/mcp/shim/client.ts`) before returning a
 *      clear JSON-RPC error naming the condition — not a hang, not a silent
 *      failure, but a real per-call latency cost until the daemon starts.
 *   4. `--execute`: actually registers Minsky at Claude Code's user scope
 *      via the real `registerWithClient()` + `ClaudeCodeRegistrar`, against
 *      the real filesystem, then re-reads the file and asserts the entry
 *      landed with the expected shape.
 *
 * `--execute` WRITES to `~/.claude.json` on whatever machine this runs on —
 * the operator's live Claude Code state file. The merge path preserves
 * every other key (tested exhaustively with mocks), but this is still a
 * real write to shared developer state and should not run unattended;
 * per `decision-defaults.mdc §Missing MCP tool` / operational-safety
 * dry-run-first convention, the flag is required before anything is
 * written.
 *
 * Usage (from the repo root):
 *
 *   bun scripts/verify-claude-code-registration.ts             # dry-run
 *   bun scripts/verify-claude-code-registration.ts --execute    # writes
 *
 * After `--execute`, restart Claude Code (or run the `/mcp` reconnect flow)
 * in ANY project and confirm `mcp__minsky__*` tools are reachable via an
 * actual tool call — that half of the verification cannot run from here.
 *
 * Exit codes: 0 = pass (dry-run report, or successful --execute write and
 * re-read), 1 = failure (reason printed to stderr).
 */

import { getRegistrar, registerWithClient } from "@minsky/domain/mcp/registration";
import { createRealFs } from "@minsky/domain/interfaces/real-fs";
import {
  detectAgentHarness,
  detectInstalledClients,
  resolveInitClient,
} from "@minsky/domain/runtime/harness-detection";

const EXECUTE = process.argv.includes("--execute");

function fail(reason: string): never {
  console.error(`FAIL: ${reason}`);
  process.exit(1);
}

/**
 * Best-effort check of whether the local MCP daemon is answering — the
 * daemon the shim entry above connects to. Read-only, short timeout (2s):
 * this script's job is to REPORT the condition honestly, not to wait it out
 * the way the shim's own 15s retry window does.
 */
async function probeDaemonHealth(): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:48765/health", {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const harness = detectAgentHarness();
  const installed = detectInstalledClients();
  const resolved = resolveInitClient();

  console.log(`detectAgentHarness(): ${harness}`);
  console.log(
    `detectInstalledClients(): ${installed.length > 0 ? installed.join(", ") : "(none)"}`
  );
  console.log(`resolveInitClient() (what \`minsky init\` would pick right now): ${resolved}`);

  const registrar = getRegistrar("claude-code");
  const configPath = registrar.configPath(process.cwd());
  console.log(`\nClaudeCodeRegistrar target path: ${configPath}`);

  const fs = createRealFs();
  const existed = await fs.exists(configPath);
  let hadEntry = false;

  if (existed) {
    const raw = await fs.readFile(configPath, "utf-8");
    let parsed: { mcpServers?: Record<string, unknown> };
    try {
      parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    } catch {
      fail(`${configPath} exists but is not valid JSON — refusing to touch it`);
    }
    hadEntry = Boolean(parsed.mcpServers?.["minsky-server"]);
  } else {
    console.log("(file does not exist yet — registration would create it)");
  }

  console.log(`Existing user-scope "minsky-server" entry present: ${hadEntry}`);

  const previewConfig = registrar.generateConfig("stdio");
  const previewEntry = (JSON.parse(previewConfig) as { mcpServers: Record<string, unknown> })
    .mcpServers["minsky-server"];
  console.log(`\nEntry that would be written (shim form, PR #3423 R2):`);
  console.log(`  ${JSON.stringify(previewEntry)}`);

  const daemonReachable = await probeDaemonHealth();
  console.log(
    `\nLocal daemon health (http://127.0.0.1:48765/health): ${
      daemonReachable ? "reachable" : "NOT reachable"
    }`
  );
  if (!daemonReachable) {
    console.log(
      "  The shim entry above connects to this daemon. Until it is running, every " +
        "MCP tool call through it will retry for up to 15s (RETRY_WINDOW_MS) then fail " +
        "with a clear error naming the condition (not a hang or a silent failure) — " +
        "run `minsky mcp start --http --local-daemon` (or `minsky setup local-http " +
        "--execute`, which also ensures the daemon) to start it."
    );
  }

  if (!EXECUTE) {
    console.log(
      "\nDRY RUN (default) — no writes performed. Re-run with --execute to " +
        "actually register the user-scope minsky-server entry (merges in, " +
        "preserves every other key in the file — see registerWithClient()'s " +
        "merge path and its exhaustive mock-fs tests in registration.test.ts)."
    );
    process.exit(0);
  }

  console.log("\n--execute passed: registering minsky at claude-code user scope...");
  await registerWithClient(process.cwd(), { transport: "stdio" }, "claude-code", fs, true);

  const rawAfter = await fs.readFile(configPath, "utf-8");
  let parsedAfter: { mcpServers?: Record<string, unknown> };
  try {
    parsedAfter = JSON.parse(rawAfter) as { mcpServers?: Record<string, unknown> };
  } catch {
    fail(`${configPath} is not valid JSON after registration — write may have corrupted it`);
  }

  const entry = parsedAfter.mcpServers?.["minsky-server"] as
    | { command?: string; args?: string[] }
    | undefined;

  if (!entry || entry.command !== "minsky") {
    fail("registration completed but the minsky-server entry is missing or malformed");
  }

  console.log(
    `PASS: wrote minsky-server entry (command=${entry.command}, args=${JSON.stringify(
      entry.args
    )}) to ${configPath}`
  );
  console.log(
    "\nThis is necessary but NOT sufficient. Restart Claude Code (or run the " +
      "/mcp reconnect flow) in any project and confirm mcp__minsky__* tools are " +
      "reachable via an actual tool call — that half cannot run from inside a " +
      "live conversation, since MCP servers resolve once at process start."
  );
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
