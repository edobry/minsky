/**
 * mt#3529 — derived workspace -> conversation links.
 *
 * The two halves under test are the ADR-006 scope discrimination (which
 * agentIds name a conversation at all) and the existence check (which
 * candidates are safe to emit).
 */
import { describe, expect, test } from "bun:test";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  conversationIdFromAgentId,
  resolveDerivedConversationLinks,
} from "./derived-conversation-link";

/**
 * Minimal stand-in for the one query shape `resolveDerivedConversationLinks`
 * issues (`select().from().where()`). Returns `rows` regardless of the
 * predicate — the function's own filtering is what's under test, not drizzle's.
 */
function fakeDb(rows: Array<{ agentSessionId: string; startedAt: Date | null }>): {
  db: PostgresJsDatabase;
  queryCount: () => number;
} {
  let queries = 0;
  const db = {
    select: () => ({
      from: () => ({
        where: () => {
          queries += 1;
          return Promise.resolve(rows);
        },
      }),
    }),
  } as unknown as PostgresJsDatabase;
  return { db, queryCount: () => queries };
}

function throwingDb(): PostgresJsDatabase {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.reject(new Error("connection lost")),
      }),
    }),
  } as unknown as PostgresJsDatabase;
}

const CONV_A = "ac34711e-ad50-41dd-8e42-1af8828bf343";
const CONV_B = "984efc25-2e41-4e8a-ba56-6f5ff55220ac";

describe("conversationIdFromAgentId", () => {
  test("extracts the uuid from a claude-code conv identity", () => {
    expect(conversationIdFromAgentId(`com.anthropic.claude-code:conv:${CONV_A}`)).toBe(CONV_A);
  });

  test("strips an @parent delegation chain rather than carrying it into the id", () => {
    expect(
      conversationIdFromAgentId(
        `com.anthropic.claude-code:conv:${CONV_A}@com.anthropic.triggers:run:r-1`
      )
    ).toBe(CONV_A);
  });

  test("returns null for the unknown:hash ascribed identity", () => {
    // The mt#3529 guard case: a hash scope carries no conversation, so the
    // workspace must keep rendering its empty state.
    expect(conversationIdFromAgentId("unknown:hash:3defa5b5675196ca")).toBeNull();
  });

  test.each([
    ["proc scope", "com.openai.codex:proc:abc123/4242"],
    ["inst scope", "github-app:copilot-swe-agent:inst:99"],
    ["run scope", "minsky.native-subagent:run:mt%233529"],
  ])("returns null for a non-conv scope (%s)", (_label, agentId) => {
    expect(conversationIdFromAgentId(agentId)).toBeNull();
  });

  test("returns null for the compound subagent form rather than claiming the parent", () => {
    // `<parent>/task:<sub>` is not itself a conversation id. Resolving it to
    // the parent would assert a link this function has no provenance for.
    expect(
      conversationIdFromAgentId(`com.anthropic.claude-code:conv:${CONV_A}/task:sub-7`)
    ).toBeNull();
  });

  test.each([
    ["null", null],
    ["undefined", undefined],
    ["empty string", ""],
    ["unparseable", "not-an-agent-id"],
    ["missing scope", "com.anthropic.claude-code"],
  ])("returns null for %s", (_label, agentId) => {
    expect(conversationIdFromAgentId(agentId)).toBeNull();
  });
});

describe("resolveDerivedConversationLinks", () => {
  test("derives a link when the named conversation exists", async () => {
    const startedAt = new Date("2026-07-31T21:36:57.216Z");
    const { db } = fakeDb([{ agentSessionId: CONV_A, startedAt }]);

    const derived = await resolveDerivedConversationLinks(db, [
      { sessionId: "ws-1", agentId: `com.anthropic.claude-code:conv:${CONV_A}` },
    ]);

    expect(derived.get("ws-1")).toEqual({
      agentSessionId: CONV_A,
      startedAt: startedAt.toISOString(),
    });
  });

  test("emits nothing when the named conversation has no transcript row", async () => {
    // The dangling-reference guard: an agentId can name a conversation this
    // deployment never ingested, and pointing the tab at it would 404.
    const { db } = fakeDb([]);

    const derived = await resolveDerivedConversationLinks(db, [
      { sessionId: "ws-1", agentId: `com.anthropic.claude-code:conv:${CONV_A}` },
    ]);

    expect(derived.has("ws-1")).toBe(false);
  });

  test("omits an unlinkable workspace entirely rather than mapping it to null", async () => {
    const { db, queryCount } = fakeDb([{ agentSessionId: CONV_A, startedAt: null }]);

    const derived = await resolveDerivedConversationLinks(db, [
      { sessionId: "ws-hash", agentId: "unknown:hash:3defa5b5675196ca" },
      { sessionId: "ws-conv", agentId: `com.anthropic.claude-code:conv:${CONV_A}` },
    ]);

    expect(derived.has("ws-hash")).toBe(false);
    expect(derived.get("ws-conv")?.agentSessionId).toBe(CONV_A);
    // A null startedAt is a real value, not an absence.
    expect(derived.get("ws-conv")?.startedAt).toBeNull();
    expect(queryCount()).toBe(1);
  });

  test("issues no query when no workspace names a conversation", async () => {
    const { db, queryCount } = fakeDb([]);

    const derived = await resolveDerivedConversationLinks(db, [
      { sessionId: "ws-1", agentId: "unknown:hash:aaaa" },
      { sessionId: "ws-2", agentId: null },
    ]);

    expect(derived.size).toBe(0);
    expect(queryCount()).toBe(0);
  });

  test("resolves several workspaces in one query", async () => {
    const { db, queryCount } = fakeDb([
      { agentSessionId: CONV_A, startedAt: null },
      { agentSessionId: CONV_B, startedAt: null },
    ]);

    const derived = await resolveDerivedConversationLinks(db, [
      { sessionId: "ws-1", agentId: `com.anthropic.claude-code:conv:${CONV_A}` },
      { sessionId: "ws-2", agentId: `com.anthropic.claude-code:conv:${CONV_B}` },
    ]);

    expect(derived.get("ws-1")?.agentSessionId).toBe(CONV_A);
    expect(derived.get("ws-2")?.agentSessionId).toBe(CONV_B);
    expect(queryCount()).toBe(1);
  });

  test("degrades to an empty map when the query throws", async () => {
    const derived = await resolveDerivedConversationLinks(throwingDb(), [
      { sessionId: "ws-1", agentId: `com.anthropic.claude-code:conv:${CONV_A}` },
    ]);

    expect(derived.size).toBe(0);
  });
});
