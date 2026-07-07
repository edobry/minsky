#!/usr/bin/env bun
import "reflect-metadata";
/**
 * Smoke: git_stats churn-by-path analytics (mt#2624)
 *
 * Verifies the acceptance test from the mt#2624 spec end-to-end against the
 * live repository (not mocked deps): a churn-by-file query over src/ since a
 * given date returns aggregated per-path commit/insertion/deletion data via
 * `gitStatsFromParams` — the same domain function the `git.stats` shared
 * command (MCP tool `git_stats`) calls. This exercises the real `git log
 * --numstat --no-renames` invocation and parser against actual repo history,
 * which the unit tests (mocked execAsync) do not cover.
 *
 * Also checks the `nameOnly` mode and confirms `registerGitCommands` wires
 * `git.stats` into the shared command registry under CommandCategory.GIT
 * (the path the MCP adapter walks to expose it as the `git_stats` tool).
 *
 * Runnable: `bun scripts/smoke-git-stats.ts`. Exit 0 = pass, non-zero = fail.
 */

async function main(): Promise<number> {
  const failures: string[] = [];

  // --- 1) Churn-by-file query over src/ since a fixed date (live repo) -----
  const { gitStatsFromParams } = await import("@minsky/domain/git");

  const since = "2020-01-01"; // wide enough to guarantee non-empty results
  const churnResult = await gitStatsFromParams({
    repo: process.cwd(),
    since,
    path: "src",
    limit: 5,
  });

  console.log("--- churn-by-file query (path=src, since=2020-01-01, limit=5) ---");
  console.log(JSON.stringify(churnResult, null, 2));

  if (churnResult.files.length === 0) {
    failures.push("Expected at least one file in churn results for src/ since 2020-01-01");
  }
  for (const f of churnResult.files) {
    if (!f.path.startsWith("src/")) {
      failures.push(`Expected path filter to scope results to src/, got: ${f.path}`);
    }
    if (f.commits < 1) {
      failures.push(`Expected commits >= 1 for ${f.path}, got ${f.commits}`);
    }
  }
  if (churnResult.totalCommits < 1) {
    failures.push(`Expected totalCommits >= 1, got ${churnResult.totalCommits}`);
  }

  // --- 2) nameOnly mode (lighter-weight listing) ----------------------------
  const nameOnlyResult = await gitStatsFromParams({
    repo: process.cwd(),
    since,
    path: "src",
    nameOnly: true,
    limit: 5,
  });

  console.log("\n--- nameOnly query (path=src, since=2020-01-01, limit=5) ---");
  console.log(JSON.stringify(nameOnlyResult, null, 2));

  if (!nameOnlyResult.nameOnly) {
    failures.push("Expected nameOnly=true to be reflected in the result");
  }
  if (nameOnlyResult.files.length === 0) {
    failures.push("Expected at least one file in nameOnly results for src/ since 2020-01-01");
  }
  for (const f of nameOnlyResult.files) {
    if (f.insertions !== 0 || f.deletions !== 0) {
      failures.push(`Expected zero insertions/deletions in nameOnly mode for ${f.path}`);
    }
  }

  // --- 3) Command registration wiring ---------------------------------------
  const { sharedCommandRegistry, CommandCategory } = await import(
    "../src/adapters/shared/command-registry"
  );
  const { registerGitCommands } = await import("../src/adapters/shared/commands/git");

  registerGitCommands();
  const statsCommand = sharedCommandRegistry.getCommand("git.stats");

  console.log("\n--- command registration ---");
  console.log(
    JSON.stringify(
      {
        found: !!statsCommand,
        category: statsCommand?.category,
        expectedCategory: CommandCategory.GIT,
      },
      null,
      2
    )
  );

  if (!statsCommand) {
    failures.push("Expected sharedCommandRegistry to contain 'git.stats' after registration");
  } else if (statsCommand.category !== CommandCategory.GIT) {
    failures.push(
      `Expected 'git.stats' category to be ${CommandCategory.GIT}, got ${statsCommand.category}`
    );
  }

  // --- Summary ---------------------------------------------------------------
  console.log("\n--- summary ---");
  if (failures.length > 0) {
    console.error(`FAIL: ${failures.length} check(s) failed:`);
    for (const f of failures) console.error(`  - ${f}`);
    return 1;
  }
  console.log("PASS: all git_stats smoke checks passed.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("FAIL: smoke-git-stats threw an unexpected error:", err);
    process.exit(1);
  });
