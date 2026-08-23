#!/usr/bin/env bun
/**
 * Live verification for mt#3377 — a driven session actually gets the minsky
 * MCP server.
 *
 * ## Why a script and not just unit tests
 *
 * The unit tests assert the argv we BUILD. They cannot assert that the genuine
 * `claude` binary accepts that argv, honors `--strict-mcp-config`, and
 * ultimately resolves `mcp__minsky__*` tools from a session-workspace cwd —
 * that is live external behavior. And the failure mode is silent: a session
 * with zero MCP servers still runs, it just degrades to shelling out to the
 * CLI. Nothing crashes, so only an explicit probe catches a regression.
 *
 * This script imports the PRODUCTION config builder rather than restating the
 * JSON, so it verifies the real binding — a hand-copied config could pass here
 * while the shipped code emits something different.
 *
 * ## Usage
 *
 *   bun scripts/verify-driven-session-mcp-config.ts [workspacePath] [sourceDir]
 *
 * `workspacePath` is the driven session's cwd; `sourceDir` is where the
 * operator's `.mcp.json` lives (mt#4239 — the daemon's checkout, NOT the
 * session workspace, which never has one because the file is gitignored).
 * Both default to the current directory. Exits 0 on pass or graceful skip
 * (`claude` not on PATH), non-zero on failure. Emits a JSON result object on
 * stdout.
 *
 * Each check runs one real `claude -p` turn against the operator's own
 * subscription — no `--dangerously-skip-permissions`, no autonomous agent,
 * two trivial prompts.
 */
import { spawnSync } from "child_process";
import { resolveDrivenSessionMcpConfig } from "../src/cockpit/driven-session-mcp-config";

const SKIP_EXIT = 0;
const FAIL_EXIT = 1;
const TURN_TIMEOUT_MS = 240_000;

interface InitEvent {
  readonly subtype?: string;
  readonly mcp_servers?: ReadonlyArray<{ name?: string; status?: string }>;
}

function claudeOnPath(): boolean {
  const probe = spawnSync("which", ["claude"], { encoding: "utf-8", timeout: 10_000 });
  return probe.status === 0;
}

/** Run one `claude -p` turn with the config under test; return its stdout lines. */
function runTurn(prompt: string, mcpConfig: string, cwd: string): string[] {
  const result = spawnSync(
    "claude",
    [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--mcp-config",
      mcpConfig,
      "--strict-mcp-config",
    ],
    { cwd, encoding: "utf-8", timeout: TURN_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }
  );

  if (result.status !== 0) {
    throw new Error(
      `claude exited ${result.status ?? "null"}: ${(result.stderr || "").slice(-2000)}`
    );
  }
  return (result.stdout || "").split("\n").filter((line) => line.trim().length > 0);
}

function parseLines(lines: string[]): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // stream-json emits only JSON lines; a non-JSON line is log noise.
    }
  }
  return parsed;
}

function main(): void {
  const workspace = process.argv[2] ?? process.cwd();

  if (!claudeOnPath()) {
    process.stdout.write(
      `${JSON.stringify({ status: "SKIP", reason: "claude not on PATH" }, null, 2)}\n`
    );
    process.exit(SKIP_EXIT);
  }

  // mt#4239: the expected set is no longer the constant `["minsky"]` — it is
  // whatever the production resolver produces for this machine's `.mcp.json`.
  // Deriving the expectation from the SAME function under test is deliberate
  // here: the question this script answers is "does the genuine `claude` binary
  // accept and honor what we emit", not "did we emit the right names" (the unit
  // tests own that). Restating a literal set would make the script fail on any
  // machine configured differently, which is how a verify script gets ignored.
  // argv[3] is the directory holding the operator's `.mcp.json` — the DAEMON's
  // checkout, which is not the driven session's workspace and is very often not
  // this script's cwd either. Running from a session clone without it resolves
  // nothing and quietly verifies only the `minsky` path, i.e. it would pass
  // while testing none of what mt#4239 added.
  const sourceDir = process.argv[3] ?? process.cwd();
  const resolution = resolveDrivenSessionMcpConfig(workspace, { sourceDir });
  const mcpConfig = resolution.config;
  const expected = [...resolution.serverNames].sort();
  const failures: string[] = [];

  // Check 1 — the session loads exactly the server set we declare, and
  // --strict-mcp-config excludes the operator's ambient claude.ai/plugin
  // servers (without it the driven tool surface varies per machine).
  const initEvent = parseLines(runTurn("say OK", mcpConfig, workspace)).find(
    (event) => (event as InitEvent).subtype === "init"
  ) as InitEvent | undefined;

  const servers = (initEvent?.mcp_servers ?? []).map((server) => server.name);
  if (JSON.stringify([...servers].sort()) !== JSON.stringify(expected)) {
    failures.push(
      `expected exactly ${JSON.stringify(expected)}, got ${JSON.stringify([...servers].sort())}`
    );
  }

  // A rejection is reported, never a failure: refusing a remote server is this
  // build working as designed (mt#4239), and refusing a name absent from the
  // operator's `.mcp.json` is a local configuration fact, not a defect in the
  // code under test.
  for (const { name, reason } of resolution.rejected) {
    process.stderr.write(`note: not provisioning \`${name}\` — ${reason}\n`);
  }

  // Check 2 — the tools actually resolve. At init the server reports
  // "pending": Claude Code connects MCP servers in the background and the wait
  // happens inside the ToolSearch call, so the server list alone does NOT
  // prove a tool is reachable. This is the check that reproduces the mt#3377
  // symptom directly ("No matching deferred tools found").
  //
  // mt#4239 extends it to EVERY provisioned server, not just `minsky`. The
  // reason is this task's own originating finding: the Notion connector appears
  // in a payload perfectly happily and then fails to authenticate, so "declared"
  // and "reachable" are different claims and only the second one matters. A
  // check that probed `minsky` alone would have reported PASS for a driven
  // session whose `github` tools were entirely dead.
  const PROBE_TOOL_BY_SERVER: Readonly<Record<string, string>> = {
    minsky: "mcp__minsky__tasks_status_get",
    github: "mcp__github__get_me",
    supabase: "mcp__supabase__list_tables",
  };

  const probeTools = servers
    .map((name) => (name === undefined ? undefined : PROBE_TOOL_BY_SERVER[name]))
    .filter((tool): tool is string => tool !== undefined);

  // A provisioned server with no known probe tool is NAMED rather than silently
  // skipped — an unprobed server must not read as a verified one.
  const unprobed = servers.filter(
    (name) => name !== undefined && PROBE_TOOL_BY_SERVER[name] === undefined
  );
  if (unprobed.length > 0) {
    process.stderr.write(
      `note: no probe tool registered for ${JSON.stringify(unprobed)} — ` +
        "these were NOT checked for reachability\n"
    );
  }

  const probe = parseLines(
    runTurn(
      `Call ToolSearch with query "select:${probeTools.join(",")}". Then reply with ` +
        "exactly LOADED if EVERY one of those tool schemas came back, or MISSING if any " +
        "returned no matching deferred tools. Reply with one word only.",
      mcpConfig,
      workspace
    )
  ).find((event) => event["type"] === "result");

  const answer = String(probe?.["result"] ?? "").trim();
  if (answer !== "LOADED") {
    failures.push(`ToolSearch probe returned ${JSON.stringify(answer)}, expected "LOADED"`);
  }

  const status = failures.length === 0 ? "PASS" : "FAIL";
  process.stdout.write(
    `${JSON.stringify(
      {
        status,
        workspace,
        sourceDir,
        expected,
        servers,
        rejected: resolution.rejected,
        toolSearchProbe: answer,
        failures,
      },
      null,
      2
    )}\n`
  );
  process.exit(failures.length === 0 ? 0 : FAIL_EXIT);
}

try {
  main();
} catch (err) {
  // A thrown error here means the probe could not COMPLETE (claude exited
  // non-zero, spawn failed, output unreadable) — which is a failed
  // verification, not a pass. Report it structurally so a CI consumer reads
  // the same JSON shape on every path.
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(`${JSON.stringify({ status: "FAIL", failures: [message] }, null, 2)}\n`);
  process.exit(FAIL_EXIT);
}
