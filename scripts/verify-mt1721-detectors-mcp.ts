#!/usr/bin/env bun
/**
 * Verification harness for mt#1721 — confirms that registerDetectorsTools
 * surfaces the four expected detector commands on the MCP tool surface.
 *
 * This is a unit-level harness: it stubs the MCP server's addTool sink and
 * captures the names registered when registerDetectorsTools is invoked
 * against a fully-populated shared command registry.
 *
 * Run:
 *   bun scripts/verify-mt1721-detectors-mcp.ts
 *
 * Exits 0 on success, non-zero if any expected detector tool is missing.
 */

import "reflect-metadata";
import { registerAllSharedCommands } from "../src/adapters/shared/commands/index";
import { CommandMapper } from "../src/mcp/command-mapper";
import { registerDetectorsTools } from "../src/adapters/mcp/detectors";

const EXPECTED = [
  "unasked-direction.list",
  "unasked-direction.mark-real",
  "unasked-direction.mark-false-positive",
  "epic-decomposition.audit",
];

async function main(): Promise<void> {
  await registerAllSharedCommands();

  const tools: string[] = [];
  const stubServer = {
    addTool: (def: { name: string }): void => {
      tools.push(def.name);
    },
    getProjectContext: (): undefined => undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const mapper = new CommandMapper(stubServer);
  registerDetectorsTools(mapper);

  const sorted = [...tools].sort();
  console.log("Registered detector tools:");
  for (const t of sorted) console.log(`  - ${t}`);

  const missing = EXPECTED.filter((e) => !tools.includes(e));
  console.log("");
  console.log(`Expected: ${EXPECTED.length}`);
  console.log(`Found   : ${tools.length}`);
  console.log(`Missing : ${JSON.stringify(missing)}`);

  if (missing.length > 0) {
    console.error("VERIFICATION FAILED: expected detector tools not surfaced");
    process.exit(1);
  }
  console.log("VERIFICATION PASSED: all expected detector tools surfaced");
}

main().catch((err) => {
  console.error("Verification error:", err);
  process.exit(1);
});
