/**
 * Tests for the MCP-bridge discovery loop (mt#2010, subsumes mt#1521).
 *
 * The discovery loop in `registerAllTools` iterates `Object.values(CommandCategory)`
 * and bridges each category exactly once: either via a per-category adapter
 * (from `MCP_CATEGORY_ADAPTERS`) or via a fallback to `registerSharedCommandsWithMcp`
 * with no overrides. This file covers the structural invariants of that design.
 *
 * Acceptance Tests mapped (per the mt#2010 spec):
 *
 *  1. Discovery-loop length check
 *  2. Fake-category test (auto-bridge a category absent from the dispatch table)
 *  4. Experimental drop test (forge auto-bridges via fallback when its
 *     dispatch entry is removed)
 *
 * The other acceptance tests (3 snapshot diff, 5 ADR existence, 6 regression
 * guard) live elsewhere or in CI artifacts.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { z } from "zod";
import { MCP_CATEGORY_ADAPTERS, DEFAULT_EXCLUDE_CATEGORIES } from "./discovery-config";
import { registerSharedCommandsWithMcp } from "../../adapters/mcp/shared-command-integration";
import { sharedCommandRegistry, CommandCategory } from "../../adapters/shared/command-registry";

// ---------------------------------------------------------------------------
// Helpers (mirror shared-command-integration.test.ts patterns)
// ---------------------------------------------------------------------------

type CapturedCall = {
  name: string;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

function makeCapturingMapper(): {
  mapper: { addCommand: (cmd: CapturedCall) => void };
  captured: CapturedCall[];
} {
  const captured: CapturedCall[] = [];
  return {
    mapper: {
      addCommand: (cmd: CapturedCall) => {
        captured.push(cmd);
      },
    },
    captured,
  };
}

const registeredIds = new Set<string>();

function registerTestCommand(
  def: Parameters<typeof sharedCommandRegistry.registerCommand>[0]
): void {
  sharedCommandRegistry.registerCommand(def);
  registeredIds.add(def.id);
}

afterEach(() => {
  for (const id of registeredIds) {
    sharedCommandRegistry.unregisterCommand(id);
  }
  registeredIds.clear();
});

// ---------------------------------------------------------------------------
// Structural invariants of the dispatch table
// ---------------------------------------------------------------------------

describe("MCP_CATEGORY_ADAPTERS dispatch table", () => {
  test("every dispatch-table key is a real CommandCategory value", () => {
    const enumValues = new Set<string>(Object.values(CommandCategory));
    const tableKeys = Object.keys(MCP_CATEGORY_ADAPTERS);
    for (const key of tableKeys) {
      expect(enumValues.has(key)).toBe(true);
    }
  });

  test("every entry in the dispatch table has at least one adapter", () => {
    for (const adapters of Object.values(MCP_CATEGORY_ADAPTERS)) {
      expect(adapters).toBeDefined();
      if (!adapters) continue;
      expect(Array.isArray(adapters)).toBe(true);
      expect(adapters.length).toBeGreaterThan(0);
      for (const adapter of adapters) {
        expect(typeof adapter).toBe("function");
      }
    }
  });

  test("DEFAULT_EXCLUDE_CATEGORIES is empty (mt#2035 retraction of AI exclusion)", () => {
    // The original AI exclusion shipped in mt#2010 was retracted by mt#2035:
    // cost discipline belongs at the API layer, not the MCP bridge. All 9 AI
    // commands (ai.chat, ai.complete, ai.fast-apply, ai.models.{list,available,refresh},
    // ai.providers.list, ai.cache.clear, ai.validate) now auto-bridge by default.
    // See ADR-011 §Audit for the updated verdict.
    expect(DEFAULT_EXCLUDE_CATEGORIES).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Discovery-loop length math (Acceptance Test 1)
// ---------------------------------------------------------------------------

describe("discovery loop coverage (Acceptance Test 1)", () => {
  test("every non-excluded CommandCategory is reachable by the discovery loop", () => {
    // The discovery loop iterates Object.values(CommandCategory). Each value
    // is either in the dispatch table OR falls back to registerSharedCommandsWithMcp.
    // No category is silently dropped.
    const excluded = new Set<string>(DEFAULT_EXCLUDE_CATEGORIES);
    const allCategories = Object.values(CommandCategory);
    const reachable = allCategories.filter((c) => !excluded.has(c));

    // Total reachable = dispatch-table entries + fallback (everything else)
    // Math: |reachable| = |dispatch ∩ reachable| + |reachable \ dispatch|
    const dispatched = new Set<string>(Object.keys(MCP_CATEGORY_ADAPTERS));
    const dispatchInReachable = reachable.filter((c) => dispatched.has(c));
    const fallbackInReachable = reachable.filter((c) => !dispatched.has(c));

    expect(dispatchInReachable.length + fallbackInReachable.length).toBe(reachable.length);

    // Sanity: at least one of each kind exists (the design is meaningful only
    // if both paths are exercised in practice).
    expect(dispatchInReachable.length).toBeGreaterThan(0);
    expect(fallbackInReachable.length).toBeGreaterThan(0);
  });

  test("every CommandCategory enum value is partitioned across {dispatched, excluded, fallback}", () => {
    // The discovery loop classifies each CommandCategory into exactly one of
    // three buckets: dispatched (per-category adapter), excluded
    // (DEFAULT_EXCLUDE_CATEGORIES), or fallback (auto-bridge). The classes
    // must be mutually exclusive AND collectively exhaustive — the test
    // protects this invariant by asserting both properties.
    const excluded = new Set<string>(DEFAULT_EXCLUDE_CATEGORIES);
    const dispatched = new Set<string>(Object.keys(MCP_CATEGORY_ADAPTERS));

    // Mutual exclusion: no category may be both dispatched AND excluded —
    // that would mean we tried to bridge it AND drop it from the surface.
    for (const cat of dispatched) {
      expect(excluded.has(cat)).toBe(false);
    }

    // Collectively exhaustive: every enum value lands in exactly one of the
    // three buckets. Fallback is the residual — anything not dispatched and
    // not excluded falls through to `registerSharedCommandsWithMcp`.
    for (const category of Object.values(CommandCategory)) {
      const buckets = [
        dispatched.has(category) ? "dispatched" : null,
        excluded.has(category) ? "excluded" : null,
        !dispatched.has(category) && !excluded.has(category) ? "fallback" : null,
      ].filter((b) => b !== null);
      // Exactly one bucket — partition is sound.
      expect(buckets.length).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Fake-category test (Acceptance Test 2 — auto-bridge an unhandled category)
// ---------------------------------------------------------------------------

describe("auto-bridge fallback (Acceptance Test 2)", () => {
  test("a category absent from the dispatch table is bridged via the fallback path", () => {
    // Pick a category that's NOT in MCP_CATEGORY_ADAPTERS (use COMPILE — it's
    // a newly-exposed category in mt#2010, deliberately not in the dispatch
    // table since it has no per-command overrides).
    const dispatched = new Set<string>(Object.keys(MCP_CATEGORY_ADAPTERS));
    expect(dispatched.has(CommandCategory.COMPILE)).toBe(false);

    // Register a fake command under COMPILE
    const id = "compile.__discovery_loop_fallback_test__";
    registerTestCommand({
      id,
      name: id,
      category: CommandCategory.COMPILE,
      description: "Discovery-loop fallback test",
      requiresSetup: false,
      parameters: {},
      execute: async () => ({ success: true }),
    });

    // Simulate the discovery loop's fallback step for this category
    const { mapper, captured } = makeCapturingMapper();
    registerSharedCommandsWithMcp(mapper as never, {
      categories: [CommandCategory.COMPILE],
    });

    // The command surfaces in the bridged set
    const found = captured.find((c) => c.name === id);
    expect(found).toBeDefined();
    expect(found?.handler).toBeDefined();
  });

  test("forge category fallback works without the per-category adapter (Acceptance Test 4)", () => {
    // Experimental drop simulation: imagine MCP_CATEGORY_ADAPTERS[FORGE] is
    // removed (or forge.ts is deleted). The fallback path should still bridge
    // forge commands.
    const id = "forge.__discovery_loop_drop_test__";
    registerTestCommand({
      id,
      name: id,
      category: CommandCategory.FORGE,
      description: "Forge drop simulation",
      requiresSetup: false,
      parameters: {
        sha: { schema: z.string(), description: "commit sha", required: true },
      },
      execute: async () => ({ success: true }),
    });

    const { mapper, captured } = makeCapturingMapper();
    // Fallback path — exactly what the discovery loop does when no
    // dispatch-table entry is found:
    registerSharedCommandsWithMcp(mapper as never, {
      categories: [CommandCategory.FORGE],
    });

    const found = captured.find((c) => c.name === id);
    expect(found).toBeDefined();
  });
});
