/**
 * Declared identity survives the SDK v2 handler context (mt#5160).
 *
 * ## The defect this pins
 *
 * mt#4854 migrated the daemon to `@modelcontextprotocol/server` 2.0.0. In that SDK the
 * handler's second argument is a structured `ctx`, and a request's `_meta` lives at
 * `ctx.mcpReq._meta` — v1's flat `extra._meta` is gone (the SDK's own
 * `contextPropertyMap.ts`; `diagnostic-capture.ts` was corrected for exactly this in
 * the same PR). The Layer-2 reader (`agent-identity/declared.ts` → `readMeta`) kept
 * reading `extras._meta`, so from 2026-09-01 every declared identity — the shim's
 * `_meta["io.minsky/agent_id"]`, the stdio proxy's, a cooperating client's — arrived
 * at the daemon and was never read. Every connection resolved Layer 1 (`proc:`), the
 * daemon log carried zero `layerThatAnswered: 2` lines, and four verification runs
 * of mt#4667 failed on the receiving side while the shim stamped correctly.
 *
 * ## Why the existing tests did not catch it
 *
 * `agent-identity-integration.test.ts` hands the resolver a hand-built
 * `{ _meta: {...} }` — the v1 shape — so the reader and its fixture agreed with each
 * other and disagreed with the SDK. This test drives the REAL `Server` over the SDK's
 * supported `InMemoryTransport` seam (`MinskyMCPServer.connectTransport`), the same
 * class and the same ctx shape the daemon runs, so the fixture is the SDK, not a
 * guess about it.
 *
 * The observable is `callerActorId`: for the tools in `CALLER_ACTOR_ID_TOOL_NAMES`
 * the server overwrites that argument with the RESOLVED identity before the handler
 * runs, so a handler that records it sees exactly what the daemon attributed the
 * call to.
 *
 * Runs in its own process like every `src/mcp` suite (see CLAUDE.md §Tests).
 */
import { describe, expect, test } from "bun:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { AGENT_ID_META_KEY } from "@minsky/domain/agent-identity/layer2";
import { BAGGAGE_META_KEY } from "@minsky/domain/agent-identity/baggage";

/** One of `CALLER_ACTOR_ID_TOOL_NAMES` — the server injects the resolved id here. */
const RECORDING_TOOL = "tasks.dispatch-recover";

const DECLARED_CONVERSATION = "1b2c3d4e-0000-4000-8000-00000000abcd";
const DECLARED_AGENT_ID = `com.anthropic.claude-code:conv:${DECLARED_CONVERSATION}`;

async function connectedServer(): Promise<{
  client: Client;
  seenActorIds: unknown[];
  close: () => Promise<void>;
}> {
  const { MinskyMCPServer } = await import("./server");
  const server = new MinskyMCPServer({
    name: "Test Server",
    version: "1.0.0",
    transportType: "stdio",
    projectContext: { repositoryPath: "/mock/test-repo" },
  });

  const seenActorIds: unknown[] = [];
  server.addTool({
    name: RECORDING_TOOL,
    description: "records the callerActorId the server injected",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    handler: async (args: Record<string, unknown>) => {
      seenActorIds.push(args.callerActorId);
      return { ok: true };
    },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connectTransport(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  return {
    client,
    seenActorIds,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("declared identity is read from the SDK v2 handler context (mt#5160)", () => {
  test("a tools/call carrying _meta[io.minsky/agent_id] resolves to THAT id, not a Layer-1 proc hash", async () => {
    const { client, seenActorIds, close } = await connectedServer();

    await client.callTool({
      name: RECORDING_TOOL,
      arguments: { task: "mt#1" },
      _meta: { [AGENT_ID_META_KEY]: DECLARED_AGENT_ID },
    });

    // Pre-fix this recorded `com.anthropic.claude-code:proc:<hash>` — the daemon
    // received the declaration and read `ctx._meta`, which SDK v2 does not populate.
    expect(seenActorIds).toEqual([DECLARED_AGENT_ID]);

    await close();
  });

  test("the baggage form (gen_ai.conversation.id) is read from the same place", async () => {
    const { client, seenActorIds, close } = await connectedServer();

    await client.callTool({
      name: RECORDING_TOOL,
      arguments: { task: "mt#1" },
      _meta: { [BAGGAGE_META_KEY]: `gen_ai.conversation.id=${DECLARED_CONVERSATION}` },
    });

    // Baggage carries only the conversation id; the KIND is synthesized from the
    // client's `clientInfo.name` (`test-client` → `unknown`). The conversation
    // scope and id are what this reader must recover from the v2 ctx.
    expect(seenActorIds).toEqual([`unknown:conv:${DECLARED_CONVERSATION}`]);

    await close();
  });

  test("a call with no declaration still resolves — to Layer 1, the documented fallback", async () => {
    const { client, seenActorIds, close } = await connectedServer();

    await client.callTool({ name: RECORDING_TOOL, arguments: { task: "mt#1" } });

    expect(seenActorIds).toHaveLength(1);
    // Layer 1 is `<kind>:hash:<16 hex>` (the test client's kind is `unknown`); the
    // point is that it is NOT a `conv:` id — nothing was declared, so nothing is read.
    expect(String(seenActorIds[0])).toMatch(/:(hash|proc):[0-9a-f]{16}$/);
    expect(String(seenActorIds[0])).not.toContain(":conv:");

    await close();
  });
});
