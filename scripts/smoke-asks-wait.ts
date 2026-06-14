#!/usr/bin/env bun
/**
 * Live end-to-end smoke for `asks_wait-for-response` (mt#2266).
 *
 * Boots the real persistence provider, builds a DrizzleAskRepository, and runs
 * `askWaitForResponse` against a real ask id — proving the polling primitive
 * works against production Postgres, not just the Fake repository the unit
 * tests use. Read-only: never mutates any ask.
 *
 * Usage:
 *   bun scripts/smoke-asks-wait.ts --id <ask-uuid> [--timeout-seconds 2] [--interval-seconds 5]
 *
 * Env-gated: requires a SQL-capable persistence provider (Postgres). Exits 0
 * with a SKIP message when persistence is unavailable, so it is safe in CI /
 * env-less contexts (matches the implement-task §7a artifact contract).
 *
 * Exit codes: 0 = ran (resolved / terminal / timeout all count as a successful
 * run of the primitive); non-zero only on a structural failure (bad args,
 * persistence error, ask-not-found).
 *
 * @see mt#2266, packages/domain/src/ask/wait-for-response.ts
 */

import "reflect-metadata";

import type { AskRepository } from "@minsky/domain/ask/repository";

/**
 * Build the repo via the SAME canonical path the MCP tool uses
 * (`buildAskRepository` in the asks adapter — duck-typed on
 * `getDatabaseConnection`), so the smoke exercises the production
 * construction logic rather than a parallel re-implementation.
 */
async function buildRepo(): Promise<AskRepository | null> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  const { buildAskRepository } = await import("../src/adapters/shared/commands/asks");

  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

  const container = await createCliContainer();
  await container.initialize();

  return buildAskRepository(container);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const idIdx = argv.indexOf("--id");
  const id = idIdx >= 0 ? argv[idIdx + 1] : undefined;
  if (!id) {
    console.error("smoke-asks-wait: --id <ask-uuid> is required");
    process.exit(1);
  }
  const toIdx = argv.indexOf("--timeout-seconds");
  const ivIdx = argv.indexOf("--interval-seconds");
  const timeoutSeconds = toIdx >= 0 ? parseInt(argv[toIdx + 1] as string, 10) : 2;
  const intervalSeconds = ivIdx >= 0 ? parseInt(argv[ivIdx + 1] as string, 10) : 5;

  const repo = await buildRepo();
  if (!repo) {
    console.log("SKIP: no SQL-capable persistence provider available");
    process.exit(0);
  }

  const { askWaitForResponse } = await import("@minsky/domain/ask/wait-for-response");
  const result = await askWaitForResponse({ id, timeoutSeconds, intervalSeconds }, { repo });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  console.error(`smoke-asks-wait failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
