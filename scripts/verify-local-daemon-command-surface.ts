#!/usr/bin/env bun
/**
 * mt#4338 / mt#4342 — verify each deployment serves (or refuses) the command
 * surface it should.
 *
 * ## Why this script exists rather than a unit test
 *
 * `src/cli-discriminators.test.ts` asserts the predicate. That is necessary and
 * it is not sufficient: the defect mt#4338 fixed was invisible to every unit
 * test in the repo, because the guard's own tests set `setHostedMode(true)`
 * directly and asserted what the guard DOES — never how the flag gets its
 * value. A predicate test could drift out of alignment with the call site the
 * same way, so this exercises the real binding: a real daemon process, started
 * with real argv, answering a real `git.*` MCP call.
 *
 * ## Why a `git.*` call specifically
 *
 * The flip that surfaced mt#4338 was pre-flighted three separate times, and all
 * three probes passed while the daemon was broken. Every one of them used
 * METADATA calls (`tasks_status_get`, `refs_status`) — which are hosted-safe by
 * construction, so they return identical results whether or not the command
 * surface is amputated. A probe that cannot fail is not verification (mem#704).
 * `git.status` is on the refused list, so it discriminates.
 *
 * ## The four cases (mt#4342)
 *
 * mt#4338 covered one argv. mt#4342 made the discriminator a CAPABILITY — git
 * on PATH plus a work tree — so the cases are no longer one-per-flag:
 *
 *   1. `--local-daemon`             local     expects git_status SERVED
 *   2. `--http --port N` + repo     local     expects git_status SERVED  <- the mt#4342 fix
 *   3. `--http --port N` + NO repo  hosted    expects git_status REFUSED
 *   4. `--http --port N` + subdir   local     expects git_status SERVED  <- PR #3233 R1
 *
 * Case 4 is the reviewer's finding end-to-end: the capability probe ascends to
 * find the work tree, so a server started anywhere inside the repo is local. A
 * `<repoPath>/.git` check — the first draft — refuses git.* there.
 *
 * **Case 3 is not the hosted ARGV, and that is the point.** Running the
 * Dockerfile's own argv on a developer machine now classifies LOCAL — correctly,
 * because git and a repo are both right there. Hosted-ness is a property of the
 * environment, so the only way to exercise the hosted branch live is to remove
 * the capability, which is what pointing `--repo` at a directory with no `.git`
 * does. It is also the fail-closed direction under test: mt#1601 requires an
 * undetermined answer to land on refuse.
 *
 * Run: bun scripts/verify-local-daemon-command-surface.ts
 * Exit 0 = every case matched its expectation. Exit 1 = one did not.
 */

import { spawn, type ChildProcess } from "child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureLocalDaemonToken } from "../src/mcp/daemon/local-daemon";

const BASE_PORT = Number(process.env.MT4338_VERIFY_PORT ?? 48799);
const REPO = process.cwd();

// ADR-038 §Question 5: the local daemon is auth-required and mints its own
// token. Reading it through the same idempotent helper the daemon itself uses
// is what makes this probe reach the guard — the first draft of this script
// omitted it, got a 401, and PASSED anyway because it only checked that a
// refusal string was ABSENT. That is the same can't-fail shape the flip's three
// pre-flights had; the positive assertion below is the actual fix.
const AUTH_TOKEN = ensureLocalDaemonToken().token;

type Json = Record<string, unknown>;

interface Case {
  label: string;
  /** argv after `mcp start`. */
  args: string[];
  /** Working directory / `--repo` target. */
  repo: string;
  expect: "served" | "refused";
  why: string;
}

/** One JSON-RPC round trip over MCP streamable HTTP, scoped to one daemon. */
async function rpc(
  url: string,
  state: { sessionId?: string },
  method: string,
  params: Json = {},
  id?: number
): Promise<Json> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${AUTH_TOKEN}`,
  };
  if (state.sessionId) headers["Mcp-Session-Id"] = state.sessionId;

  const body: Json = { jsonrpc: "2.0", method, params };
  if (id !== undefined) body.id = id;

  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) state.sessionId = sid;

  const text = await res.text();
  if (!text.trim()) return {};

  // Streamable HTTP may answer as SSE; take the last `data:` frame.
  const dataLines = text
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim());
  const payload = dataLines.length > 0 ? dataLines[dataLines.length - 1] : text;
  try {
    return JSON.parse(payload as string) as Json;
  } catch {
    return { raw: text };
  }
}

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const body = (await res.json()) as { ready?: boolean };
        if (body.ready === true) return true;
      }
    } catch {
      // intentional-swallow: the daemon is still booting; the deadline governs.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function kill(child: ChildProcess): void {
  try {
    child.kill("SIGTERM");
  } catch {
    // intentional-swallow: best-effort teardown; the process may already be gone.
  }
}

/** Returns null on pass, or a failure message. */
async function runCase(c: Case, port: number): Promise<string | null> {
  const url = `http://127.0.0.1:${port}/mcp`;
  const state: { sessionId?: string } = {};

  console.log(`\n[mt#4342] CASE ${c.label}`);
  console.log(`[mt#4342]   argv: mcp start ${c.args.join(" ")}`);
  console.log(`[mt#4342]   repo: ${c.repo} (.git present: ${existsSync(join(c.repo, ".git"))})`);
  console.log(`[mt#4342]   expect: git_status ${c.expect} — ${c.why}`);

  const child = spawn("bun", ["run", "src/cli.ts", "mcp", "start", ...c.args], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  let daemonLog = "";
  child.stdout?.on("data", (d) => (daemonLog += d.toString()));
  child.stderr?.on("data", (d) => (daemonLog += d.toString()));

  try {
    if (!(await waitForHealth(port, 60_000))) {
      kill(child);
      return `${c.label}: daemon never reported ready:true within 60s\n${daemonLog.slice(-1500)}`;
    }

    await rpc(
      url,
      state,
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mt4342-verify", version: "1.0.0" },
      },
      1
    );
    await rpc(url, state, "notifications/initialized");

    const result = (await rpc(
      url,
      state,
      "tools/call",
      {
        name: "git_status",
        arguments: {},
      },
      2
    )) as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
      error?: { message?: string };
    };

    const rendered = JSON.stringify(result);
    const refused = rendered.includes("not supported on the hosted");

    // Assert POSITIVELY that a "served" call actually reached git and came back
    // with a real working-tree payload. Checking only for the absence of the
    // refusal string would also "pass" on a 401, a transport error, or an empty
    // body — none of which exercise the guard at all.
    // Substring checks, not a quoted-key regex: git_status's payload arrives as
    // JSON *inside* an MCP text block, so its own quotes are escaped
    // (`\"workdir\"`) and a `/"workdir"/` pattern does not match.
    const served =
      !refused &&
      !rendered.includes("unauthorized") &&
      result.error === undefined &&
      result.result?.isError !== true &&
      rendered.includes("workdir") &&
      rendered.includes("branch");

    kill(child);

    if (c.expect === "served") {
      if (served) {
        console.log(`[mt#4342]   PASS: served a real working-tree payload.`);
        return null;
      }
      return `${c.label}: expected git_status to be SERVED.\n${
        refused
          ? "  It was refused as if hosted — the regression this case exists to catch.\n"
          : "  It did not return a working-tree payload, so the probe never reached the " +
            "command surface and proves nothing either way.\n"
      }  ${rendered.slice(0, 600)}`;
    }

    // expect === "refused"
    if (refused) {
      console.log(`[mt#4342]   PASS: refused with the mt#1601 hosted message.`);
      return null;
    }
    return (
      `${c.label}: expected git_status to be REFUSED with the hosted message, but it was ` +
      `not. A capability-less server that serves git.* means the guard failed OPEN — the ` +
      `direction mt#1601 explicitly forbids.\n  ${rendered.slice(0, 600)}`
    );
  } catch (err) {
    kill(child);
    return `${c.label}: threw: ${String(err)}\n${daemonLog.slice(-1500)}`;
  }
}

// A directory that exists but is not a repo: the capability-less condition.
const NO_REPO = mkdtempSync(join(tmpdir(), "mt4342-norepo-"));

const CASES: Case[] = [
  {
    label: "1/4 --local-daemon (tray + setup local-http)",
    args: ["--local-daemon", "--port", String(BASE_PORT), "--repo", REPO],
    repo: REPO,
    expect: "served",
    why: "mt#4338's discriminator; must not regress",
  },
  {
    label: "2/4 plain --http --port N with a repo (mt#4342)",
    args: ["--http", "--host", "127.0.0.1", "--port", String(BASE_PORT + 1), "--repo", REPO],
    repo: REPO,
    expect: "served",
    why: "the deployment mt#4338 could not reach; refused git.* before this fix",
  },
  {
    label: "3/4 plain --http --port N with NO repo (hosted condition)",
    args: ["--http", "--host", "127.0.0.1", "--port", String(BASE_PORT + 2), "--repo", NO_REPO],
    repo: NO_REPO,
    expect: "refused",
    why: "no capability => hosted; the fail-closed direction mt#1601 requires",
  },
  {
    label: "4/4 plain --http --port N from a SUBDIRECTORY of the repo",
    args: [
      "--http",
      "--host",
      "127.0.0.1",
      "--port",
      String(BASE_PORT + 3),
      "--repo",
      join(REPO, "src"),
    ],
    repo: join(REPO, "src"),
    expect: "served",
    why: "PR #3233 R1: the probe ascends, so a subdir of a repo is still local",
  },
];

const failures: string[] = [];
for (const [i, c] of CASES.entries()) {
  const failure = await runCase(c, BASE_PORT + i);
  if (failure) failures.push(failure);
}

console.log("");
if (failures.length > 0) {
  console.error(`[mt#4342] FAIL: ${failures.length} of ${CASES.length} cases did not match.`);
  for (const f of failures) console.error(`\n  - ${f}`);
  process.exit(1);
}
console.log(`[mt#4342] PASS: all ${CASES.length} cases matched their expected command surface.`);
process.exit(0);
