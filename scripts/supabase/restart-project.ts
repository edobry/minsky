#!/usr/bin/env bun
/**
 * Supabase project restart helper (mt#2574).
 *
 * Wraps the Supabase Management API restart endpoint:
 *   POST /v1/projects/{ref}/restart
 *
 * !! DESTRUCTIVE OPERATION — DRY-RUN BY DEFAULT !!
 * Without --execute this script only prints what it would do and exits.
 * Pass --execute to actually send the restart request.
 *
 * --- FAST REBOOT vs. FULL RESTART (READ THIS FIRST) ---
 *
 * The Supabase dashboard offers two distinct restart actions:
 *
 *   (a) "Restart DB" (fast database reboot) — POST /v1/projects/{ref}/database/restart
 *       Restarts only the Postgres postmaster. Does NOT touch Supavisor
 *       (the shared connection pooler).
 *
 *   (b) Full project restart — POST /v1/projects/{ref}/restart  [THIS SCRIPT]
 *       Restarts all project components including Supavisor. This is the
 *       only self-serve path that resets Supavisor's auth-failure circuit
 *       breaker (ECIRCUITBREAKER: too many authentication failures, new
 *       connections are temporarily blocked).
 *
 * IMPORTANT: If the pooler breaker is tripped, a fast database reboot (a)
 * is INSUFFICIENT. The breaker lives in Supavisor, not in Postgres, so
 * only path (b) — a full project restart — or a pause→resume cycle will
 * reset it. Attempting a fast reboot first wastes a ~30-minute window.
 *
 * Incident reference: docs/incidents/2026-06-28-supabase-connectivity-breaker.md
 * Memory: a436cdba (Supabase incident diagnostics)
 *
 * Token resolution (in priority order):
 *   1. SUPABASE_ACCESS_TOKEN env var (Supabase CLI convention, same as justfile)
 *   2. MINSKY_SUPABASE_ACCESS_TOKEN env var (Minsky-namespaced variant)
 *   3. supabase.accessToken key in ~/.config/minsky/config.yaml
 *
 *   Generate a token at https://supabase.com/dashboard/account/tokens
 *   Persist it in ~/.config/minsky/config.yaml (supabase.accessToken)
 *   or via: MINSKY_SUPABASE_ACCESS_TOKEN=sbp_... bun scripts/supabase/restart-project.ts
 *
 * Project ref resolution (in priority order):
 *   1. --ref <ref> command-line argument
 *   2. SUPABASE_PROJECT_REF env var
 *   3. Default: yvkkrpyjhoiilmizlnac  (minsky dev 2 — public constant, also in justfile)
 *
 * Usage:
 *   # Preview what would happen (safe — default):
 *   bun scripts/supabase/restart-project.ts
 *
 *   # Actually restart the project (DESTRUCTIVE):
 *   bun scripts/supabase/restart-project.ts --execute
 *
 *   # Restart a different project ref:
 *   bun scripts/supabase/restart-project.ts --ref <project_ref> --execute
 *
 *   # Use env var for token:
 *   SUPABASE_ACCESS_TOKEN="sbp_..." bun scripts/supabase/restart-project.ts --execute
 */

import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default Supabase project ref for Minsky (dev 2).
 * This is a non-secret project identifier — also declared in justfile:
 *   PROJECT_REF := "yvkkrpyjhoiilmizlnac"  # minsky (dev 2)
 */
const DEFAULT_PROJECT_REF = "yvkkrpyjhoiilmizlnac";

const MANAGEMENT_API_BASE = "https://api.supabase.com";

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const refArg = (() => {
  const idx = args.indexOf("--ref");
  return idx !== -1 ? args[idx + 1] : undefined;
})();
const helpRequested = args.includes("--help") || args.includes("-h");

if (helpRequested) {
  console.log(`
Usage: bun scripts/supabase/restart-project.ts [options]

Options:
  --execute        Actually perform the restart (default: dry-run/preview only)
  --ref <ref>      Supabase project ref (default: ${DEFAULT_PROJECT_REF})
  -h, --help       Show this help

Environment variables:
  SUPABASE_ACCESS_TOKEN        Management API personal access token
  MINSKY_SUPABASE_ACCESS_TOKEN Same but Minsky-namespaced (also via minsky config)
  SUPABASE_PROJECT_REF         Project ref override (same as --ref)

IMPORTANT: A full project restart is required to reset the Supavisor
auth-failure circuit breaker. A fast DB reboot is NOT sufficient.
See docs/incidents/2026-06-28-supabase-connectivity-breaker.md for details.
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Project ref resolution
// ---------------------------------------------------------------------------

const projectRef = refArg ?? process.env["SUPABASE_PROJECT_REF"] ?? DEFAULT_PROJECT_REF;

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

async function resolveToken(): Promise<string | null> {
  // 1. SUPABASE_ACCESS_TOKEN env var (Supabase CLI convention)
  const envToken = process.env["SUPABASE_ACCESS_TOKEN"];
  if (envToken) {
    return envToken;
  }

  // 2. MINSKY_SUPABASE_ACCESS_TOKEN env var (Minsky-namespaced variant)
  const minskyEnvToken = process.env["MINSKY_SUPABASE_ACCESS_TOKEN"];
  if (minskyEnvToken) {
    return minskyEnvToken;
  }

  // 3. supabase.accessToken from ~/.config/minsky/config.yaml
  const configPath = join(homedir(), ".config", "minsky", "config.yaml");
  try {
    const raw = await readFile(configPath, "utf-8");
    // Parse YAML using a minimal regex approach to avoid a dependency on js-yaml
    // in a standalone script. Only handles simple key: value at the supabase block.
    const match = raw.match(/^supabase:\s*\n\s+accessToken:\s*["']?([^"'\n]+)["']?\s*$/m);
    if (match?.[1]) {
      return match[1].trim();
    }
  } catch {
    // Config file not found or unreadable — try next source
  }

  return null;
}

// ---------------------------------------------------------------------------
// Management API helpers
// ---------------------------------------------------------------------------

interface RestartResponse {
  message?: string;
  status?: string;
}

async function triggerProjectRestart(
  token: string,
  ref: string
): Promise<{ success: boolean; status: number; body: string }> {
  const url = `${MANAGEMENT_API_BASE}/v1/projects/${ref}/restart`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Network error calling Management API: ${msg}`);
  }

  const bodyText = await response.text().catch(() => "(unreadable body)");
  return { success: response.ok, status: response.status, body: bodyText };
}

async function verifyTokenAndProject(
  token: string,
  ref: string
): Promise<{ ok: boolean; detail: string }> {
  const url = `${MANAGEMENT_API_BASE}/v1/projects/${ref}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: `Network error: ${msg}` };
  }

  if (response.status === 401) {
    return { ok: false, detail: "401 Unauthorized — token invalid or revoked" };
  }
  if (response.status === 403) {
    return { ok: false, detail: "403 Forbidden — token lacks Management API permissions" };
  }
  if (response.status === 404) {
    return {
      ok: false,
      detail: `404 Not Found — project ref '${ref}' not found or not accessible`,
    };
  }
  if (!response.ok) {
    return { ok: false, detail: `HTTP ${response.status} ${response.statusText}` };
  }

  let project: { name?: string; status?: string; region?: string };
  try {
    project = (await response.json()) as typeof project;
  } catch {
    return { ok: false, detail: "Response was not valid JSON" };
  }

  const name = project.name ?? "(unknown)";
  const status = project.status ?? "(unknown)";
  const region = project.region ?? "(unknown)";
  return { ok: true, detail: `name="${name}", status=${status}, region=${region}` };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Supabase Project Restart Helper (mt#2574)");
  console.log("=".repeat(60));
  console.log();

  // Resolve token
  const token = await resolveToken();
  if (!token) {
    console.error(
      "ERROR: No Supabase access token found.\n\n" +
        "Set one of:\n" +
        "  SUPABASE_ACCESS_TOKEN=sbp_... (env var)\n" +
        "  MINSKY_SUPABASE_ACCESS_TOKEN=sbp_... (env var)\n" +
        "  supabase.accessToken in ~/.config/minsky/config.yaml\n\n" +
        "Generate a token at: https://supabase.com/dashboard/account/tokens"
    );
    process.exit(1);
  }

  const tokenPreview = `${token.slice(0, 8)}...${token.slice(-4)}`;
  console.log(`Token:       ${tokenPreview} (resolved from env/config)`);
  console.log(`Project ref: ${projectRef}`);
  console.log();

  // Verify token and project (probe before acting)
  process.stdout.write("Verifying token and project ref... ");
  const verify = await verifyTokenAndProject(token, projectRef);
  if (!verify.ok) {
    console.log("FAILED");
    console.error(`\nERROR: ${verify.detail}`);
    process.exit(1);
  }
  console.log("OK");
  console.log(`  Project: ${verify.detail}`);
  console.log();

  if (!execute) {
    // DRY-RUN mode
    console.log("--- DRY-RUN (preview) ---");
    console.log();
    console.log("Would execute:");
    console.log(`  POST ${MANAGEMENT_API_BASE}/v1/projects/${projectRef}/restart`);
    console.log();
    console.log("Effect:");
    console.log("  - All project components will be restarted (Postgres + Supavisor pooler)");
    console.log("  - The Supavisor auth-failure circuit breaker will be reset");
    console.log("  - Active connections will be dropped");
    console.log("  - Expect 1-3 minutes of downtime while the project restarts");
    console.log();
    console.log(
      "REMINDER: A fast DB reboot (database/restart) is NOT sufficient to reset\n" +
        "the Supavisor auth-failure breaker. This full project restart is required."
    );
    console.log();
    console.log(
      "To actually restart, re-run with --execute:\n" +
        `  bun scripts/supabase/restart-project.ts --execute`
    );
    return;
  }

  // EXECUTE mode
  console.log("--- EXECUTING full project restart ---");
  console.log();
  console.log("WARNING: This will restart all project components and drop active connections.");
  console.log(`  POST ${MANAGEMENT_API_BASE}/v1/projects/${projectRef}/restart`);
  console.log();

  const result = await triggerProjectRestart(token, projectRef);

  if (result.success) {
    console.log(`SUCCESS (HTTP ${result.status})`);
    if (result.body && result.body !== "null" && result.body !== "") {
      try {
        const parsed = JSON.parse(result.body) as RestartResponse;
        if (parsed.message ?? parsed.status) {
          console.log(`  Response: ${JSON.stringify(parsed)}`);
        }
      } catch {
        console.log(`  Response body: ${result.body}`);
      }
    }
    console.log();
    console.log("Next steps:");
    console.log("  1. Wait 1-3 minutes for the project to fully restart");
    console.log("  2. Verify connectivity: minsky debug systemInfo (check persistence)");
    console.log("  3. Or via psql: psql $MINSKY_POSTGRES_URL -c 'SELECT 1'");
    console.log();
    console.log(
      "NOTE: The Supavisor auth-failure circuit breaker should now be reset.\n" +
        "If connections are still failing after restart, check for an ongoing\n" +
        "connection storm (leaked processes, crash-looping services) — killing\n" +
        "the storm source may be needed before the breaker stays reset."
    );
  } else {
    console.log(`FAILED (HTTP ${result.status})`);
    console.log(`  Response: ${result.body}`);
    console.log();
    console.error(
      "ERROR: The restart request was rejected by the Management API.\n" +
        "Check the token permissions and project ref, then retry."
    );
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  console.error(`\nUnhandled error: ${msg}`);
  process.exit(1);
});
