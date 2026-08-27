#!/usr/bin/env bun
/**
 * Replay artifact for the chained-verification-commands detector (mt#3910, AT5 / SC2).
 *
 * Runs the REAL detector over real `Bash` / `session_exec` commands from the transcript corpus and
 * reports the fire rate. This exists because SC2 makes the false-positive rate a precondition for
 * any enforcement decision, and because a SQL approximation cannot stand in for it: the detector's
 * split is quote-aware, so a `;` inside a quoted script body is NOT a separator — while a SQL
 * `split_part` shatters it and over-counts. A SQL estimate is an upper bound, not a measurement.
 *
 * Prints ONLY aggregate counts and the matched verification-command NAMES. Never prints a full
 * command string: this corpus contains commands with credentials in them, and the whole point of
 * the report is the shape, not the payload.
 *
 * Env-gated: skips gracefully when no DB is reachable.
 *
 * Usage:
 *   bun scripts/replay-chained-verification-detector.ts [limit]
 *
 * @see mt#3910
 */
import "reflect-metadata";
import { scanCommand } from "../.minsky/hooks/chained-verification-commands-detector";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

const DEFAULT_LIMIT = 20000;

/** One transcript row: the command string of a Bash / session_exec tool call. */
interface CommandRow {
  cmd: string | null;
}

/**
 * The database handle's shape, narrowed to what this script uses. Declared rather than asserted
 * through `unknown` so the driver-shape assumption below is visible and checkable.
 */
interface DbHandle {
  execute: (query: unknown) => Promise<CommandRow[] | { rows: CommandRow[] }>;
}

async function main(): Promise<void> {
  const limit = Number(process.argv[2] ?? DEFAULT_LIMIT);

  const { setupConfiguration } = await import("@minsky/domain/config-setup");
  await setupConfiguration();

  const { PersistenceService } = await import("@minsky/domain/persistence/service");
  const service = new PersistenceService();
  await service.initialize();
  const provider = service.getProvider();

  if (!provider.capabilities.sql || typeof provider.getDatabaseConnection !== "function") {
    console.log("SKIP: no SQL-capable persistence provider reachable.");
    process.exit(0);
  }

  const db = (await provider.getDatabaseConnection()) as DbHandle;
  const { sql } = await import("drizzle-orm");

  const result = await db.execute(sql`
    select tc->'input'->>'command' as cmd
    from agent_transcript_turns, lateral jsonb_array_elements(tool_calls) tc
    where jsonb_typeof(tool_calls) = 'array'
      and tc->>'name' in ('Bash', 'mcp__minsky__session_exec')
      and tc->'input'->>'command' is not null
    limit ${limit}
  `);

  // Drivers differ: postgres-js returns the rows array directly, node-postgres wraps them in
  // `{ rows }`. Handle both rather than binding this script to one driver.
  const list = Array.isArray(result) ? result : result.rows;

  let total = 0;
  let withAnyVerification = 0;
  let fired = 0;
  const shapes = new Map<string, number>();

  for (const row of list) {
    const cmd = row.cmd;
    if (typeof cmd !== "string" || cmd.length === 0) continue;
    total++;

    const result = scanCommand(cmd);
    if (result.verificationSegments.length >= 1) withAnyVerification++;
    if (!result.chained) continue;

    fired++;
    // Reduce each matched segment to its command NAME only — never the full segment, which can
    // carry arguments and credentials.
    const shape = result.verificationSegments
      .map((s) =>
        (s.match(/^(bun\s+test|bun\s+run\s+[\w:.-]+|bunx\s+\w+|tsgo)/)?.[1] ?? "?").replace(
          /\s+/g,
          " "
        )
      )
      .join(" + ");
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  }

  console.log(`commands scanned:                 ${total}`);
  console.log(`contained >=1 verification cmd:   ${withAnyVerification}`);
  console.log(`WOULD FIRE (>=2 chained):         ${fired}`);
  console.log(
    `fire rate:                        ${((fired / Math.max(total, 1)) * 100).toFixed(2)}% of all commands`
  );
  console.log("\ntop firing shapes (command names only):");
  for (const [shape, n] of [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    console.log(`  ${String(n).padStart(5)}  ${shape}`);
  }

  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(`FAIL: ${getLoggableErrorSummary(error)}`);
  process.exit(1);
});
