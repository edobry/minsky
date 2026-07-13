#!/usr/bin/env bun
/**
 * Live smoke test for the hosted MCP-server status widget (mt#2077).
 *
 * The widget's correctness depends on live external behavior no unit test can
 * fully cover: (a) the hosted `/health` endpoint actually answers, and (b) the
 * first-party deployment domain resolves the `minsky-mcp` service and returns a
 * deployment record + logs. This script exercises the real-wired widget against
 * those live systems and prints the resulting payload.
 *
 * Run from the repo root (the deployment domain reads
 * `services/minsky-mcp/deploy.config.ts` relative to cwd):
 *
 *   bun scripts/smoke-mcp-server-status.ts
 *
 * Requirements (degrade gracefully, never crash):
 *   - Network access for the HTTPS /health probe.
 *   - Railway auth (`~/.railway/config.json`) for the deploy half. Absent →
 *     `deploy` is null in the payload (the widget's documented degraded path).
 *
 * Exit code: 0 when the widget returns a non-crashing `ok` payload; 1 when it
 * returns `degraded` (an unexpected internal error).
 */

// The deployment domain transitively pulls in tsyringe, which requires the
// reflect-metadata polyfill at the entry point (the real cockpit boots via
// src/cli.ts, which imports it first). This script is its own entry point, so
// it must load the polyfill before importing widget code.
import "reflect-metadata";
import { mcpServerStatusWidget } from "../src/cockpit/widgets/mcp-server-status";

async function main(): Promise<number> {
  const data = await mcpServerStatusWidget.fetch({ id: "mcp-server-status" });

  if (data.state !== "ok") {
    console.error("FAIL: widget returned degraded:", data.reason);
    return 1;
  }

  const payload = data.payload as Record<string, unknown>;
  console.log(JSON.stringify(payload, null, 2));

  const health = payload["health"] as { ok: boolean } | undefined;
  const deploy = payload["deploy"];
  console.log("");
  console.log(`health probe reached 200: ${health?.ok ? "yes" : "no"}`);
  console.log(`deploy data resolved:     ${deploy !== null ? "yes" : "no (Railway auth/cwd?)"}`);
  console.log("PASS: widget returned a non-crashing ok payload.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("FAIL: smoke threw unexpectedly:", err);
    process.exit(1);
  });
