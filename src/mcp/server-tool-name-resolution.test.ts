/**
 * Regression suite for mt#4827 — name-keyed gates on the CallTool path must match the
 * RESOLVED `tool.name`, never `request.params.name` (the raw wire name).
 *
 * The defect: `WAKE_ENRICHMENT_ALLOWLIST` and `ENRICHMENT_ALLOWLIST` hold DOTTED names,
 * and the dispatch handler fed them the wire name — which is UNDERSCORED for every
 * client, because `tools/list` advertises the Claude-Desktop alias by default. So the
 * session-keyed wake leg never fired.
 *
 * These tests assert the WIRING, not the allowlist. `shouldEnrichWake` keeps a
 * dotted-only Set on purpose (the chosen idiom is to resolve at the call site, never to
 * teach every Set two spellings), so a unit test of the predicate alone would pass
 * identically before and after the fix and prove nothing.
 *
 * Driven through the SDK's SUPPORTED client/transport surface (`InMemoryTransport` +
 * `Client`) rather than its private `_requestHandlers` map — PR #3532 R1 flagged that
 * reach as brittle. `MinskyMCPServer.connectTransport` is the seam that makes this
 * possible; see its docblock.
 */

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

function buildToolDef(name: string): {
  name: string;
  description: string;
  inputSchema: object;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
} {
  return {
    name,
    description: `Test tool ${name}`,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    handler: async () => ({ ok: true, name }),
  };
}

/** Records every `drainedForTool` the wake middleware passes down. */
function recordingWakeService(seen: string[]) {
  return {
    drainBySession: async (_sessionId: string, drainedForTool: string) => {
      seen.push(drainedForTool);
      return [];
    },
    drainByAgent: async (_agentId: string, drainedForTool: string) => {
      seen.push(drainedForTool);
      return [];
    },
  };
}

/**
 * Stand up a server with one registered tool and a recording wake service, connected to
 * a real in-memory client. Returns the client plus the recording array.
 */
async function connectedServerWithTool(canonicalName: string): Promise<{
  client: Client;
  seen: string[];
  close: () => Promise<void>;
}> {
  const { MinskyMCPServer } = await import("./server");
  const server = new MinskyMCPServer({
    name: "Test Server",
    version: "1.0.0",
    transportType: "stdio",
    projectContext: { repositoryPath: "/mock/test-repo" },
  });

  const seen: string[] = [];
  server.addTool(buildToolDef(canonicalName));
  server.setWakeService(
    recordingWakeService(seen) as never,
    {
      resolveParentSessionId: async () => "session-uuid",
    } as never
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connectTransport(serverTransport);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  return {
    client,
    seen,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("CallTool name-keyed gates match the RESOLVED name, not the wire name (mt#4827)", () => {
  test("invoking an allowlisted tool via its UNDERSCORED alias reaches wake enrichment under the canonical name", async () => {
    const { client, seen, close } = await connectedServerWithTool("tasks.get");

    await client.callTool({ name: "tasks_get", arguments: { session: "some-session" } });

    // The session-keyed leg is gated by `shouldEnrichWake(toolName)`, whose Set holds
    // "tasks.get". On the pre-fix code `toolName` was "tasks_get", the gate returned
    // false, and this array stayed EMPTY — that is the negative control.
    expect(seen).toContain("tasks.get");
    expect(seen).not.toContain("tasks_get");

    await close();
  });

  test("invoking the same tool via its DOTTED canonical name still works (no regression)", async () => {
    const { client, seen, close } = await connectedServerWithTool("tasks.get");

    await client.callTool({ name: "tasks.get", arguments: { session: "some-session" } });

    expect(seen).toContain("tasks.get");

    await close();
  });

  test("the load-bearing invariant, enforced: a tool resolved via its ALIAS still reports the REGISTERED name", async () => {
    // PR #3532 R1 blocking (1) observed that the comments asserted an invariant nothing
    // checked. This is the check. `addTool` maps both spellings to the SAME object, so
    // `.name` is the registered name on either lookup — that, and not "the name is always
    // dotted", is what makes a one-spelling allowlist match an alias-calling client.
    const { MinskyMCPServer } = await import("./server");
    const server = new MinskyMCPServer({
      name: "Test Server",
      version: "1.0.0",
      transportType: "stdio",
      projectContext: { repositoryPath: "/mock/test-repo" },
    });
    server.addTool(buildToolDef("session.pr.get"));

    const tools = (server as unknown as { tools: Map<string, { name: string }> }).tools;
    expect(tools.get("session_pr_get")?.name).toBe("session.pr.get");
    expect(tools.get("session.pr.get")?.name).toBe("session.pr.get");

    // And the half that is NOT guaranteed: a registered name need not contain a dot.
    // The comments must not claim otherwise.
    server.addTool(buildToolDef("plain_name"));
    expect(tools.get("plain_name")?.name).toBe("plain_name");

    await server.close();
  });

  test("widening the match does not widen the allowlist: a non-allowlisted tool still drains nothing", async () => {
    const { client, seen, close } = await connectedServerWithTool("tasks.search");

    await client.callTool({ name: "tasks_search", arguments: { session: "some-session" } });

    // Neither spelling is on the allowlist, so the session leg must stay closed.
    expect(seen).toEqual([]);

    await close();
  });
});
