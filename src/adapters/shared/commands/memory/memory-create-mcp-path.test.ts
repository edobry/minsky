/**
 * memory.create — MCP-path missing-content regression (mt#2705 / mt#3144).
 *
 * Verified live 2026-07-24 during the mt#2708 closeout: calling `memory.create`
 * over MCP with `content` omitted produced
 * `MCP error -32603: Tool execution failed: undefined is not an object
 * (evaluating '$.trimStart')` — a raw TypeError from
 * `checkDerivation`'s `content.trimStart()`, because the MCP boundary
 * (`convertMcpArgsToParameters`) let a missing `required: true` parameter
 * reach `execute()` as `undefined` with no enforcement.
 *
 * This test exercises the REAL `memory.create` command definition
 * (registered via the production `registerMemoryCommands`) through the REAL
 * MCP bridge (`registerSharedCommandsWithMcp`) — not a synthetic stand-in —
 * so it fails against pre-fix `main` and passes after the shared-layer fix
 * in `shared-command-integration.ts`.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { registerMemoryCommands, type MemoryCommandsDeps } from "./index";
import { registerSharedCommandsWithMcp } from "../../../mcp/shared-command-integration";
import { sharedCommandRegistry, CommandCategory } from "../../command-registry";
import type { MemoryServiceSurface } from "@minsky/domain/memory/memory-service";
import type { MemoryRecord } from "@minsky/domain/memory/types";

// registerMemoryCommands registers all 9 memory.* commands each call; track
// every id so a clean slate can be guaranteed regardless of registration
// order or prior test-file state (allowOverwrite: true is not part of the
// production registration call, so a stale duplicate would throw).
const MEMORY_COMMAND_IDS = [
  "memory.search",
  "memory.get",
  "memory.list",
  "memory.create",
  "memory.update",
  "memory.delete",
  "memory.similar",
  "memory.supersede",
  "memory.lineage",
];

function resetMemoryCommands(): void {
  for (const id of MEMORY_COMMAND_IDS) {
    sharedCommandRegistry.unregisterCommand(id);
  }
}

afterEach(resetMemoryCommands);

function makeMockMapper(nameFilter: string) {
  const captured: { handler?: (args: Record<string, unknown>) => Promise<unknown> } = {};
  const mapper = {
    addCommand: (cmd: {
      name: string;
      handler: (args: Record<string, unknown>) => Promise<unknown>;
    }) => {
      if (cmd.name === nameFilter) {
        captured.handler = cmd.handler;
      }
    },
  };
  return { mapper, captured };
}

describe("memory.create — MCP-path missing-content regression (mt#2705 / mt#3144)", () => {
  test("omitting content is rejected with a field-naming validation error, not a raw TypeError", async () => {
    resetMemoryCommands();
    // No deps needed: the fix rejects at the boundary before execute() ever
    // resolves the memory service, so `{}` deps never gets exercised for
    // this omitted-content case.
    registerMemoryCommands(sharedCommandRegistry, {});

    const { mapper, captured } = makeMockMapper("memory.create");
    registerSharedCommandsWithMcp(mapper as never, { categories: [CommandCategory.MEMORY] });
    const handler = captured.handler;
    expect(handler).toBeDefined();
    if (!handler) return;

    // type/name/description supplied (also required:true) so the failure is
    // unambiguously about `content` — not the first required field the
    // conversion loop happens to reach.
    await expect(handler({ type: "user", name: "n", description: "d" })).rejects.toThrow(
      /Required parameter 'content' is missing/
    );
  });

  test("supplying content resolves normally through the MCP path (control)", async () => {
    resetMemoryCommands();

    const fakeRecord: MemoryRecord = {
      id: "mem-test",
      type: "user",
      name: "n",
      description: "d",
      content: "some content",
      scope: "project",
      projectId: null,
      tags: [],
      sourceAgentId: null,
      sourceSessionId: null,
      confidence: null,
      supersededBy: null,
      metadata: null,
      associations: {},
      createdAt: new Date("2025-01-01"),
      updatedAt: new Date("2025-01-01"),
      lastAccessedAt: null,
      accessCount: 0,
    };
    // Pre-built service instance (highest resolveMemoryService precedence) —
    // only `create` is exercised by this path, the rest are unused stubs.
    const fakeMemoryService = {
      create: async () => fakeRecord,
    } as unknown as MemoryServiceSurface;
    const deps: MemoryCommandsDeps = { memoryService: fakeMemoryService };

    registerMemoryCommands(sharedCommandRegistry, deps);

    const { mapper, captured } = makeMockMapper("memory.create");
    registerSharedCommandsWithMcp(mapper as never, { categories: [CommandCategory.MEMORY] });
    const handler = captured.handler;
    expect(handler).toBeDefined();
    if (!handler) return;

    // Fully-populated call must resolve normally — the boundary rejects only
    // the omitted-content case above, not a well-formed call.
    const result = (await handler({
      type: "user",
      name: "n",
      description: "d",
      content: "some content",
    })) as MemoryRecord;
    expect(result.id).toBe("mem-test");
  });
});
