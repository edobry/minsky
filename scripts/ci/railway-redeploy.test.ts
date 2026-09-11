/**
 * Tests for `railway-redeploy.sh` (mt#4959).
 *
 * The script is exercised end to end by putting a FAKE `railway` on
 * `RAILWAY_BIN` — the same reason `docker-push-with-retry.test.ts` puts a
 * fake `docker` on `DOCKER_BIN`: the retry/classification logic has to be
 * driven into a chosen failure, which workflow YAML cannot do.
 *
 * The fake records every invocation (the subcommand, the full argv, and
 * which of RAILWAY_TOKEN / RAILWAY_API_TOKEN was set) to a call log, and pops
 * scripted exit codes off a queue in invocation order — one queued result per
 * `railway link` or `railway redeploy` call. `railway --version` and
 * `railway whoami` always succeed without consuming the queue, since neither
 * is part of the classification under test.
 *
 * Covers the task's acceptance tests directly:
 *   AT1 — a transport timeout on the first attempt retries the SAME scope and
 *         succeeds, with zero fallback-scope calls.
 *   AT2 — a rejected link is never retried on that scope; the project-scope
 *         fallback runs exactly once (it succeeds on its own first try here).
 *   AT3 — one service succeeds, the other's redeploy call times out on every
 *         attempt in its (only reachable) scope; the run exits non-zero and
 *         the split-state line names both correctly.
 *   AT5 — a helper exit code outside {2, 3} is bucketed "unclassified" and
 *         is not retried, preserving the three PR #3138 R1 buckets.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
// eslint-disable-next-line custom/no-real-fs-in-tests -- the subject is a shell script run as a subprocess; its fake `railway` must be a real executable on a real path, which a child process cannot get from an in-memory fs
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
// eslint-disable-next-line custom/no-real-fs-in-tests -- see above; mkdtempSync under the real tmpdir guarantees per-run uniqueness, so there is no cross-test race for the fixed-path rule to prevent
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT_RELATIVE_PATH = "scripts/ci/railway-redeploy.sh";
const SCRIPT_PATH = join(import.meta.dir, "railway-redeploy.sh");
const REPO_ROOT = join(import.meta.dir, "..", "..");

/** The single-service stdin line most tests below feed the script. */
const MCP_LINE = "minsky-mcp svc-mcp-1";

/**
 * A stand-in for `railway` that records every invocation and returns
 * scripted results IN ORDER — one result per `link`/`redeploy` call.
 * `--version` and `whoami` always succeed and do not consume the queue.
 */
const FAKE_RAILWAY = `#!/usr/bin/env bash
STATE="\${FAKE_RAILWAY_STATE}"
CALLS="\${STATE}/calls.log"
RESULTS="\${STATE}/results"

tok=""
if [ -n "\${RAILWAY_API_TOKEN:-}" ]; then tok="RAILWAY_API_TOKEN"; fi
if [ -n "\${RAILWAY_TOKEN:-}" ]; then tok="\${tok:+\${tok},}RAILWAY_TOKEN"; fi
echo "$1|\${tok}|$*" >> "\${CALLS}"

if [ "$1" = "--version" ]; then
  echo "railway 4.44.0"
  exit 0
fi
if [ "$1" = "whoami" ]; then
  exit 0
fi

next="$(head -n1 "\${RESULTS}" 2>/dev/null)"
tail -n +2 "\${RESULTS}" > "\${RESULTS}.tmp" 2>/dev/null && mv "\${RESULTS}.tmp" "\${RESULTS}"
exit "\${next:-0}"
`;

let workDir: string;
let fakeRailwayPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "railway-redeploy-"));
  fakeRailwayPath = join(workDir, "fake-railway.sh");
  // eslint-disable-next-line custom/no-real-fs-in-tests -- see file header
  writeFileSync(fakeRailwayPath, FAKE_RAILWAY);
  chmodSync(fakeRailwayPath, 0o755);
});

afterEach(() => {
  // eslint-disable-next-line custom/no-real-fs-in-tests -- tears down the per-test temp dir created above
  rmSync(workDir, { recursive: true, force: true });
});

interface RunOpts {
  /** Exit codes consumed in invocation order, one per link/redeploy call. */
  results: number[];
  attempts?: number;
  delay?: number;
  /** TEST-ONLY override; see the script header. Forces mktemp to fail. */
  attemptDir?: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  calls: string[];
}

async function run(serviceLines: string[], opts: RunOpts): Promise<RunResult> {
  const state = mkdtempSync(join(workDir, "state-"));
  // eslint-disable-next-line custom/no-real-fs-in-tests -- the fake `railway` (a spawned subprocess) reads its scripted results back from this file; an in-memory fs is invisible to it
  writeFileSync(join(state, "results"), `${opts.results.map((n) => String(n)).join("\n")}\n`);

  const inputPath = join(state, "input.txt");
  // eslint-disable-next-line custom/no-real-fs-in-tests -- fed to the spawned script as stdin via Bun.file(), which needs a real path
  writeFileSync(inputPath, serviceLines.length ? `${serviceLines.join("\n")}\n` : "");

  const proc = Bun.spawn([SCRIPT_PATH], {
    stdin: Bun.file(inputPath),
    env: {
      ...process.env,
      RAILWAY_BIN: fakeRailwayPath,
      RAILWAY_REDEPLOY_ATTEMPTS: String(opts.attempts ?? 3),
      // Keep the suite fast: the behaviour under test is "there is a bounded
      // delay", not its wall-clock duration.
      RAILWAY_REDEPLOY_RETRY_DELAY: String(opts.delay ?? 0),
      ...(opts.attemptDir !== undefined ? { RAILWAY_REDEPLOY_ATTEMPT_DIR: opts.attemptDir } : {}),
      DEPLOY_TOKEN: "fake-token-not-a-real-credential",
      DEPLOY_TOKEN_SOURCE: "RAILWAY_MCP_TOKEN",
      PROJECT_ID: "proj-1111-1111",
      ENVIRONMENT_ID: "env-2222-2222",
      FAKE_RAILWAY_STATE: state,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  const callsRaw = (() => {
    try {
      // eslint-disable-next-line custom/no-real-fs-in-tests -- reads back the fake railway's call log for this run's own state dir
      return readFileSync(join(state, "calls.log"), "utf8");
    } catch {
      return "";
    }
  })();

  return {
    stdout,
    stderr,
    exitCode,
    calls: callsRaw.split("\n").filter(Boolean),
  };
}

function callsMatching(calls: string[], cmd: string, tokenVar?: string): string[] {
  return calls.filter((line) => {
    const [c, tok] = line.split("|");
    if (c !== cmd) return false;
    if (tokenVar !== undefined && tok !== tokenVar) return false;
    return true;
  });
}

describe("railway-redeploy.sh (mt#4959)", () => {
  it("is committed executable — the workflow invokes it directly, not via `bash`", () => {
    // eslint-disable-next-line custom/no-real-fs-in-tests -- asserts the committed file mode, which only the real fs carries
    const mode = statSync(SCRIPT_PATH).mode;
    expect(mode & 0o111).toBeGreaterThan(0);
  });

  it("keeps the env -u RAILWAY_TOKEN -u RAILWAY_API_TOKEN invocation shape for both link and redeploy", () => {
    // eslint-disable-next-line custom/no-real-fs-in-tests -- reads the committed script to assert its own invocation shape, which is the thing under test
    const source = readFileSync(SCRIPT_PATH, "utf8");
    const shapeOccurrences = source.match(/env -u RAILWAY_TOKEN -u RAILWAY_API_TOKEN/g) ?? [];
    // One each for `railway link`, `railway redeploy`, and the diagnostic
    // `railway whoami` — losing any of the three means a stale env var from
    // an earlier attempt (or scope) could leak into this one.
    expect(shapeOccurrences.length).toBe(3);
  });

  it("AT1: retries the SAME scope on a transport timeout and succeeds, with zero fallback-scope calls", async () => {
    // link(ok) redeploy(fails once) link(ok) redeploy(ok)
    const result = await run([MCP_LINE], { results: [0, 1, 0, 0] });

    expect(result.exitCode).toBe(0);
    expect(callsMatching(result.calls, "redeploy", "RAILWAY_API_TOKEN")).toHaveLength(2);
    expect(callsMatching(result.calls, "redeploy", "RAILWAY_TOKEN")).toHaveLength(0);
    expect(callsMatching(result.calls, "link", "RAILWAY_TOKEN")).toHaveLength(0);
    expect(result.stdout).toContain(
      "Scope 1/2 try 1/3 for minsky-mcp (account/workspace scope): redeploy call failed after a successful link — retrying in 0s."
    );
    expect(result.stdout).toContain(
      "Railway redeploy triggered successfully for minsky-mcp via the CLI (RAILWAY_MCP_TOKEN, account/workspace scope)."
    );
    expect(result.stdout).toContain("redeployed: minsky-mcp");
  });

  it("AT2: a rejected link is not retried on that scope; exactly one project-scope attempt follows", async () => {
    // link(rejected) redeploy(ok, project scope)
    const result = await run([MCP_LINE], { results: [1, 0] });

    expect(result.exitCode).toBe(0);
    expect(callsMatching(result.calls, "link")).toHaveLength(1);
    expect(callsMatching(result.calls, "redeploy", "RAILWAY_API_TOKEN")).toHaveLength(0);
    expect(callsMatching(result.calls, "redeploy", "RAILWAY_TOKEN")).toHaveLength(1);
    expect(result.stdout).not.toContain("retrying in");
    expect(result.stdout).toContain(
      "Attempt 1 for minsky-mcp: 'railway link' was rejected — the token could not authenticate or resolve the target under account/workspace scope."
    );
    expect(result.stdout).toContain(
      "Railway redeploy triggered successfully for minsky-mcp via the CLI (RAILWAY_MCP_TOKEN, project scope)."
    );
  });

  it("AT3: the second service's redeploy call exhausts its bound while the first succeeds — split state names both", async () => {
    // minsky-mcp: link(ok) redeploy(ok)
    // minsky-ops: link(rejected) — falls to project scope, which times out on
    // all 3 bounded attempts (redeploy call count for minsky-ops == the bound).
    const result = await run([MCP_LINE, "minsky-ops svc-ops-1"], {
      results: [0, 0, 1, 1, 1, 1],
      attempts: 3,
    });

    expect(result.exitCode).not.toBe(0);
    const opsRedeploys = result.calls.filter(
      (line) => line.startsWith("redeploy|") && line.includes("svc-ops-1")
    );
    expect(opsRedeploys).toHaveLength(3);
    expect(result.stdout).toContain(
      "::error::redeploy split state — redeployed: minsky-mcp; NOT redeployed: minsky-ops"
    );
    expect(result.stdout).toContain(
      "::error::railway redeploy failed under BOTH token scopes for minsky-ops (svc-ops-1)."
    );
  });

  it("AT5: a helper exit code outside {2, 3} is unclassified and not retried, preserving the three buckets", async () => {
    // Forcing the per-attempt mktemp to fail (RAILWAY_REDEPLOY_ATTEMPT_DIR
    // pointed at a path that cannot exist) makes `redeploy_with` return 1 —
    // an exit code neither link (2) nor redeploy (3) produces — without
    // needing a single `railway` invocation to be scripted.
    const result = await run([MCP_LINE], {
      results: [],
      attemptDir: "/definitely/does/not/exist/mt4959",
    });

    expect(result.exitCode).not.toBe(0);
    // whoami is the only call that ever reaches the fake binary; link/redeploy
    // never run because mktemp fails before either is invoked.
    expect(callsMatching(result.calls, "link")).toHaveLength(0);
    expect(callsMatching(result.calls, "redeploy")).toHaveLength(0);
    expect(result.stdout).not.toContain("retrying in");
    // CI R1: pins the explicit mktemp-result guard so the exit-1 outcome
    // depends on this message, not on a shell's `cd ""` behaviour (Ubuntu's
    // bash treats `cd ""` as a silent no-op success; macOS's does not — the
    // guard makes the two platforms agree). The exact mktemp diagnostic text
    // differs between GNU and BSD mktemp, so only the fixed prefix is
    // asserted, once per scope attempt (account/workspace, then project).
    const guardOccurrences =
      result.stdout.split(
        "redeploy helper: could not create the per-attempt working directory under /definitely/does/not/exist/mt4959; exiting 1:"
      ).length - 1;
    expect(guardOccurrences).toBe(2);
    expect(result.stdout).toContain(
      "the redeploy helper exited 1, which is neither the link-failed (2) nor the redeploy-failed (3) signal — cause not determined from this attempt."
    );
    expect(result.stdout).toContain(
      "::error::  CAUSE NOT DETERMINED for: minsky-mcp — the redeploy helper exited outside the instrumented failure points, so this run does not say whether the credential or the redeploy call was at fault. Read the per-attempt output above rather than acting on a guess."
    );
    expect(result.stdout).toContain(
      "::error::redeploy split state — redeployed: (none); NOT redeployed: minsky-mcp"
    );
  });

  it("prints a single success line naming every redeployed service when both succeed", async () => {
    const state1Results = [0, 0]; // mcp link+redeploy
    // Two services, both succeed on the first attempt: mcp(link,redeploy) then ops(link,redeploy).
    const result = await run([MCP_LINE, "minsky-ops svc-ops-1"], {
      results: [...state1Results, 0, 0],
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("redeployed: minsky-mcp minsky-ops");
    expect(result.stdout).not.toContain("::error::");
  });

  it("skips blank lines in the stdin service list", async () => {
    const result = await run(["", MCP_LINE, ""], { results: [0, 0] });

    expect(result.exitCode).toBe(0);
    expect(callsMatching(result.calls, "link")).toHaveLength(1);
  });

  it("requires DEPLOY_TOKEN, PROJECT_ID and ENVIRONMENT_ID to be set", async () => {
    const state = mkdtempSync(join(workDir, "state-"));
    // eslint-disable-next-line custom/no-real-fs-in-tests -- fed to the spawned script as stdin via Bun.file(), which needs a real path
    writeFileSync(join(state, "input.txt"), `${MCP_LINE}\n`);
    const proc = Bun.spawn([SCRIPT_PATH], {
      stdin: Bun.file(join(state, "input.txt")),
      env: {
        ...process.env,
        RAILWAY_BIN: fakeRailwayPath,
        DEPLOY_TOKEN_SOURCE: "RAILWAY_MCP_TOKEN",
        PROJECT_ID: "proj-1",
        ENVIRONMENT_ID: "env-1",
        FAKE_RAILWAY_STATE: state,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("DEPLOY_TOKEN must be set");
  });
});

describe("deploy-minsky-mcp.yml wires the redeploy step to the script (mt#4959)", () => {
  const workflowLines = (): string[] =>
    // eslint-disable-next-line custom/no-real-fs-in-tests -- reads the committed workflow to assert it is wired to the script; the workflow's content IS the thing under test
    readFileSync(join(REPO_ROOT, ".github/workflows/deploy-minsky-mcp.yml"), "utf8").split("\n");

  it("invokes the script exactly once, piping REDEPLOY_SERVICES into it", () => {
    const invocations = workflowLines().filter(
      (line) => line.includes(SCRIPT_RELATIVE_PATH) && !line.trimStart().startsWith("#")
    );
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toContain("printf '%s\\n' \"${REDEPLOY_SERVICES}\" |");
  });

  it("exports all four required env vars before invoking the script", () => {
    const exportLine = workflowLines().find((line) => line.trim().startsWith("export "));
    expect(exportLine).toBeDefined();
    for (const name of ["DEPLOY_TOKEN", "DEPLOY_TOKEN_SOURCE", "PROJECT_ID", "ENVIRONMENT_ID"]) {
      expect(exportLine ?? "").toContain(name);
    }
  });

  it("no longer defines redeploy_with inline — the workflow only points at the extracted script", () => {
    const inlineDefinition = workflowLines().some((line) => line.includes("redeploy_with()"));
    expect(inlineDefinition).toBe(false);
  });
});
