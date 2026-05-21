#!/usr/bin/env bun
import "reflect-metadata";
/**
 * Smoke probe for mt#2010 MCP-bridge discovery loop.
 *
 * Boots an in-process MCP command-mapper, runs the same registration sequence
 * as `registerAllTools` against it (without the network or DI container), and
 * reports the set of tool names bridged. Verifies the 7 newly-exposed
 * categories from the mt#2010 audit appear in the bridged set.
 *
 * Usage:
 *   bun scripts/smoke-mcp-discovery.ts
 *
 * Exit codes:
 *   0 — all expected categories surfaced; no AI surfacing
 *   1 — at least one expected new category missing OR AI leaked
 */
import { CommandCategory } from "../src/adapters/shared/command-registry";
import { registerSharedCommandsWithMcp } from "../src/adapters/mcp/shared-command-integration";
import {
  MCP_CATEGORY_ADAPTERS,
  DEFAULT_EXCLUDE_CATEGORIES,
} from "../src/commands/mcp/start-command";
import { registerSessionWorkspaceTools } from "../src/adapters/mcp/session-workspace";
import { registerSessionFileTools } from "../src/adapters/mcp/session-files";
import { registerSessionEditTools } from "../src/adapters/mcp/session-edit-tools";
import { registerAllSharedCommands } from "../src/adapters/shared/commands/index";

// Minimal CommandMapper-shaped stub: captures the .name of every command
// registered via .addCommand(...). Mirrors the unit-test pattern in
// `shared-command-integration.test.ts`'s `makeMockMapper`. Structural typing
// avoids `as unknown` while still satisfying the adapters' parameter contract.
type CapturingMapper = {
  addCommand: (cmd: { name: string }) => void;
};

async function main() {
  await registerAllSharedCommands();

  const captured: string[] = [];
  const mapper: CapturingMapper = {
    addCommand: (cmd: { name: string }) => {
      captured.push(cmd.name);
    },
  };

  // Native tools (mirror start-command.ts ordering)
  registerSessionWorkspaceTools(mapper);
  registerSessionFileTools(mapper);
  registerSessionEditTools(mapper);

  // Discovery loop (mirror start-command.ts logic)
  const excluded = new Set<CommandCategory>(DEFAULT_EXCLUDE_CATEGORIES);
  for (const category of Object.values(CommandCategory)) {
    if (excluded.has(category)) continue;
    const adapters = MCP_CATEGORY_ADAPTERS[category];
    if (adapters && adapters.length > 0) {
      for (const adapter of adapters) adapter(mapper);
    } else {
      registerSharedCommandsWithMcp(mapper, { categories: [category] });
    }
  }

  const tools = [...new Set(captured)].sort();
  console.log(`Total tools registered: ${tools.length}`);

  // Newly-exposed categories per ADR-011 audit
  const expectedNewCategories: ReadonlyArray<{ prefix: string; minCount: number }> = [
    { prefix: "knowledge.", minCount: 1 },
    { prefix: "provenance.", minCount: 1 },
    { prefix: "authorship.", minCount: 1 },
    { prefix: "compile", minCount: 1 },
    { prefix: "workspace.", minCount: 1 },
    { prefix: "transcripts.", minCount: 1 },
    { prefix: "observability.", minCount: 1 },
  ];

  let allOk = true;
  console.log("\nNewly-exposed categories check:");
  for (const { prefix, minCount } of expectedNewCategories) {
    const matches = tools.filter((t) => t === prefix || t.startsWith(prefix));
    const ok = matches.length >= minCount;
    console.log(
      `  ${prefix}* : ${matches.length} tools ${ok ? "OK" : "MISSING"} — ${matches.slice(0, 5).join(", ")}${matches.length > 5 ? "…" : ""}`
    );
    if (!ok) allOk = false;
  }

  // AI exclusion check
  const aiTools = tools.filter((t) => t.startsWith("ai."));
  console.log(`\nAI exclusion check: ${aiTools.length} tools (expect 0)`);
  if (aiTools.length > 0) {
    console.log(`  LEAKED: ${aiTools.join(", ")}`);
    allOk = false;
  }

  // Existing categories — sample check that core surfaces didn't disappear
  console.log("\nPre-existing categories (regression check):");
  for (const prefix of ["tasks.", "session.", "git.", "memory.", "forge."]) {
    const count = tools.filter((t) => t.startsWith(prefix)).length;
    console.log(`  ${prefix}* : ${count} tools`);
    if (count === 0) {
      console.log(`  REGRESSION: ${prefix} surface is empty`);
      allOk = false;
    }
  }

  if (allOk) {
    console.log("\nSMOKE PASS");
    process.exit(0);
  } else {
    console.log("\nSMOKE FAIL");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Smoke crashed:", err);
  process.exit(2);
});
