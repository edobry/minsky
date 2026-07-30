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
 *   bun scripts/verify-driven-session-mcp-config.ts [workspacePath]
 *
 * Defaults to the current directory. Exits 0 on pass or graceful skip
 * (`claude` not on PATH), non-zero on failure. Emits a JSON result object on
 * stdout.
 *
 * Each check runs one real `claude -p` turn against the operator's own
 * subscription — no `--dangerously-skip-permissions`, no autonomous agent,
 * two trivial prompts.
 */
import { spawnSync } from "child_process";
import { buildDrivenSessionMcpConfig } from "../src/cockpit/driven-session-mcp-config";

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

  const mcpConfig = buildDrivenSessionMcpConfig(workspace);
  const failures: string[] = [];

  // Check 1 — the session loads exactly the server set we declare, and
  // --strict-mcp-config excludes the operator's ambient claude.ai/plugin
  // servers (without it the driven tool surface varies per machine).
  const initEvent = parseLines(runTurn("say OK", mcpConfig, workspace)).find(
    (event) => (event as InitEvent).subtype === "init"
  ) as InitEvent | undefined;

  const servers = (initEvent?.mcp_servers ?? []).map((server) => server.name);
  if (servers.length !== 1 || servers[0] !== "minsky") {
    failures.push(`expected exactly ["minsky"], got ${JSON.stringify(servers)}`);
  }

  // Check 2 — the tools actually resolve. At init the server reports
  // "pending": Claude Code connects MCP servers in the background and the wait
  // happens inside the ToolSearch call, so the server list alone does NOT
  // prove a tool is reachable. This is the check that reproduces the mt#3377
  // symptom directly ("No matching deferred tools found").
  const probe = parseLines(
    runTurn(
      'Call ToolSearch with query "select:mcp__minsky__tasks_status_get". Then reply with ' +
        "exactly LOADED if the tool schema came back, or MISSING if it returned no matching " +
        "deferred tools. Reply with one word only.",
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
    `${JSON.stringify({ status, workspace, servers, toolSearchProbe: answer, failures }, null, 2)}\n`
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
