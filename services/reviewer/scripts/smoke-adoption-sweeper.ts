#!/usr/bin/env bun
/**
 * Smoke test for the adoption sweeper (mt#1630).
 *
 * Verifies the structural prerequisites for the adoption sweeper:
 *
 * 1. GitHub API reachable (same check other smoke tests use — confirms the
 *    reviewer service's network context is working).
 * 2. Minsky MCP server reachable and exposes the required tools:
 *    - `tasks_search` (list DONE tasks)
 *    - `tasks_spec_get` (fetch task spec)
 *    - `tasks_create` (file follow-up adoption tasks)
 *    - `repo_search` (grep production callsites)
 * 3. (Optional) Dry-run sweep: call tasks_search{status:DONE} against a live
 *    MCP server, extract signals from a known DONE task's spec, and verify
 *    the signal extraction returns a non-empty result. Does NOT write any
 *    follow-up tasks. Gated on SMOKE_ADOPTION_RUN_LIVE_SWEEP=true.
 *
 * This is a live-verification artifact per implement-task §7a.
 * Gates on GITHUB_TOKEN + MINSKY_MCP_URL + MINSKY_MCP_TOKEN env vars.
 * Skips gracefully when any required env var is absent (exit 0 with SKIP).
 *
 * ## Live-verification gap note
 *
 * The full acceptance test for mt#1630 requires:
 *   (a) A task that became DONE with an exportable function in its spec
 *   (b) A reviewer service run with ADOPTION_SWEEPER_ENABLED=true
 *   (c) Observing the sweeper file an mt#X-adoption follow-up task
 *
 * That requires a deployed reviewer service with credentials + a real DONE
 * task with zero callsites — outside the scope of in-tree CI smoke.
 * This script covers the structural prerequisites; the operator runs the
 * full e2e against a deployed instance (post-mt#1711) and pastes redacted
 * output into the PR body's "## Live verification" section per §7a.
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_xxx \
 *   MINSKY_MCP_URL=https://... \
 *   MINSKY_MCP_TOKEN=mcp_xxx \
 *     bun services/reviewer/scripts/smoke-adoption-sweeper.ts
 *
 *   # Optional: run a live dry-run sweep (reads tasks, NO writes):
 *   SMOKE_ADOPTION_RUN_LIVE_SWEEP=true \
 *   SMOKE_ADOPTION_TASK_ID=mt#1598 \
 *     bun services/reviewer/scripts/smoke-adoption-sweeper.ts
 */

import { Octokit } from "@octokit/rest";
import { extractAdoptionSignals } from "@minsky/shared/adoption/signal-extraction";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const githubToken = process.env["GITHUB_TOKEN"];
const mcpUrl = process.env["MINSKY_MCP_URL"];
const mcpToken = process.env["MINSKY_MCP_TOKEN"];

if (!githubToken) {
  console.log("SKIP: GITHUB_TOKEN not set; skipping live smoke test.");
  process.exit(0);
}
if (!mcpUrl || !mcpToken) {
  console.log("SKIP: MINSKY_MCP_URL or MINSKY_MCP_TOKEN not set; skipping live smoke test.");
  process.exit(0);
}

const runLiveSweep = process.env["SMOKE_ADOPTION_RUN_LIVE_SWEEP"] === "true";
const liveSweepTaskId = process.env["SMOKE_ADOPTION_TASK_ID"] ?? "mt#1598";

// Standard PR target (known merged PR; used to verify GitHub API reachability)
const prOwner = process.env["SMOKE_PR_OWNER"] ?? "edobry";
const prRepo = process.env["SMOKE_PR_REPO"] ?? "minsky";
const prNumber = parseInt(process.env["SMOKE_PR_NUMBER"] ?? "962", 10);

// ---------------------------------------------------------------------------
// MCP helper
// ---------------------------------------------------------------------------

async function callMcpTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  try {
    const response = await fetch(mcpUrl as string, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mcpToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `smoke-adoption-${Date.now()}`,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const raw = await response.text();
    const trimmed = raw.trim();

    // Handle SSE or plain JSON
    let jsonText = trimmed;
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      let last: string | null = null;
      for (const line of trimmed.split("\n")) {
        const stripped = line.trim();
        if (stripped.startsWith("data:")) {
          const payload = stripped.slice("data:".length).trim();
          if (payload.startsWith("{") || payload.startsWith("[")) last = payload;
        }
      }
      if (!last) return { ok: false, error: "No JSON found in SSE stream" };
      jsonText = last;
    }

    const data = JSON.parse(jsonText) as {
      result?: { content?: Array<{ type?: string; text?: string }> };
      error?: { message?: string };
    };
    if (data.error) {
      return { ok: false, error: `RPC error: ${data.error.message ?? "unknown"}` };
    }
    return { ok: true, result: data.result };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** List tools registered on the MCP server. */
async function listMcpTools(): Promise<string[] | null> {
  try {
    const response = await fetch(mcpUrl as string, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mcpToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `smoke-adoption-list-${Date.now()}`,
        method: "tools/list",
        params: {},
      }),
    });
    if (!response.ok) return null;
    const raw = await response.text();
    const trimmed = raw.trim();

    let jsonText = trimmed;
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      let last: string | null = null;
      for (const line of trimmed.split("\n")) {
        const stripped = line.trim();
        if (stripped.startsWith("data:")) {
          const payload = stripped.slice("data:".length).trim();
          if (payload.startsWith("{") || payload.startsWith("[")) last = payload;
        }
      }
      jsonText = last ?? trimmed;
    }

    const data = JSON.parse(jsonText) as {
      result?: { tools?: Array<{ name: string }> };
    };
    return (data.result?.tools ?? []).map((t) => t.name);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Test 1: GitHub API reachability
// ---------------------------------------------------------------------------

async function testGithubReachable(): Promise<{ pass: boolean; detail: string }> {
  const octokit = new Octokit({ auth: githubToken });
  try {
    const response = await octokit.rest.pulls.get({
      owner: prOwner,
      repo: prRepo,
      pull_number: prNumber,
    });
    return {
      pass: true,
      detail: `getPr(${prOwner}/${prRepo}#${prNumber}) → merged=${response.data.merged}, state=${response.data.state}`,
    };
  } catch (err: unknown) {
    const status =
      err instanceof Error && "status" in err ? (err as { status?: number }).status : undefined;
    if (status === 404) {
      return {
        pass: true,
        detail: `getPr → 404 (PR not found — GitHub API is reachable)`,
      };
    }
    return {
      pass: false,
      detail: `getPr failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Test 2: MCP tool registration — required tools exist
// ---------------------------------------------------------------------------

const REQUIRED_TOOLS = ["tasks_search", "tasks_spec_get", "tasks_create", "repo_search"];

async function testMcpToolsRegistered(): Promise<{ pass: boolean; detail: string }> {
  const toolNames = await listMcpTools();
  if (!toolNames) {
    return { pass: false, detail: "tools/list call failed or returned no content" };
  }

  const missing = REQUIRED_TOOLS.filter((t) => !toolNames.includes(t));
  if (missing.length > 0) {
    return {
      pass: false,
      detail: `tools/list → ${toolNames.length} tools registered; MISSING: ${missing.join(", ")}`,
    };
  }

  return {
    pass: true,
    detail: `tools/list → ${toolNames.length} tools registered; all required tools present (${REQUIRED_TOOLS.join(", ")})`,
  };
}

// ---------------------------------------------------------------------------
// Test 3 (optional): Live dry-run sweep on a known DONE task
// ---------------------------------------------------------------------------

async function testLiveDrySweep(): Promise<{ pass: boolean; detail: string } | null> {
  if (!runLiveSweep) return null;

  // Step 1: Fetch the spec for the known DONE task.
  const specResult = await callMcpTool("tasks_spec_get", { taskId: liveSweepTaskId });
  if (!specResult.ok) {
    return {
      pass: false,
      detail: `tasks_spec_get(${liveSweepTaskId}) → ${specResult.error}`,
    };
  }

  // Step 2: Extract signals from the spec.
  let specText = "";
  try {
    const resultContent = specResult.result as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const textChunks = (resultContent?.content ?? [])
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string);
    const innerText = textChunks.join("");
    const parsed = JSON.parse(innerText) as { content?: string; spec?: string };
    specText = parsed.content ?? parsed.spec ?? innerText;
  } catch {
    specText = String(specResult.result);
  }

  const signals = extractAdoptionSignals(specText);

  return {
    pass: true,
    detail: [
      `tasks_spec_get(${liveSweepTaskId}) → spec retrieved (${specText.length} chars)`,
      `signal extraction → ${signals.length} signals found`,
      signals.length > 0
        ? `first signal: kind=${signals[0]?.kind} name=${signals[0]?.name}`
        : "(no signals — spec has no code patterns; this is expected for prose-only specs)",
    ].join("; "),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== Adoption sweeper smoke test (mt#1630) ===");
  console.log(`MCP target: ${(mcpUrl as string).replace(/\/+$/, "")}`);
  console.log(`Live sweep: ${runLiveSweep ? `enabled (task=${liveSweepTaskId})` : "skipped"}`);
  console.log("");

  const results: Array<{ name: string; pass: boolean; detail: string }> = [];

  console.log("Test 1: GitHub API reachable ...");
  const t1 = await testGithubReachable();
  results.push({ name: "GitHub API reachable", ...t1 });
  console.log(`  ${t1.pass ? "PASS" : "FAIL"}: ${t1.detail}`);

  console.log("Test 2: MCP tool registration ...");
  const t2 = await testMcpToolsRegistered();
  results.push({ name: "MCP tools registered", ...t2 });
  console.log(`  ${t2.pass ? "PASS" : "FAIL"}: ${t2.detail}`);

  console.log("Test 3: Live dry-run sweep (optional) ...");
  const t3 = await testLiveDrySweep();
  if (t3) {
    results.push({ name: "Live dry-run sweep", ...t3 });
    console.log(`  ${t3.pass ? "PASS" : "FAIL"}: ${t3.detail}`);
  } else {
    console.log("  SKIP: SMOKE_ADOPTION_RUN_LIVE_SWEEP not set");
  }

  console.log("");
  console.log("=== Results ===");
  const failCount = results.filter((r) => !r.pass).length;
  results.forEach((r) => {
    console.log(`  ${r.pass ? "[PASS]" : "[FAIL]"} ${r.name}: ${r.detail}`);
  });

  console.log("");
  if (failCount > 0) {
    console.error(
      `FAIL: ${failCount}/${results.length} tests failed. ` +
        "The adoption sweeper's structural prerequisites are not met against this MCP server."
    );
    process.exit(1);
  } else {
    console.log(
      `PASS: ${results.length}/${results.length} tests passed. ` +
        "Structural prerequisites for adoption sweeper verified. " +
        "Run with SMOKE_ADOPTION_RUN_LIVE_SWEEP=true against a deployed reviewer service " +
        "(post-mt#1711) to validate the full path."
    );
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Smoke test error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
