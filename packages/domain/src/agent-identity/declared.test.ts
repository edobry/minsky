/**
 * Unit tests for ordered declared-identity resolution (mt#3986).
 */
import { describe, test, expect } from "bun:test";
import {
  DEFAULT_DECLARED_IDENTITY_KEYS,
  buildDeclaredIdentityKeys,
  isReservedMcpKey,
  readDeclaredIdentity,
} from "./declared";
import { AGENT_ID_META_KEY } from "./layer2";
import { BAGGAGE_META_KEY, GEN_AI_CONVERSATION_ID_KEY } from "./baggage";
import type { DeclaredIdentityHit } from "./declared";
import { KNOWN_KINDS } from "./kinds";
import { serializeAgentId } from "./format";

const UUID = "2154425b-1c30-4f0e-9d51-0b73b9a2f5a1";
const OTHER_UUID = "9f8e7d6c-5b4a-4392-8271-605f4e3d2c1b";
const DECLARED_AGENT_ID = `${KNOWN_KINDS.CLAUDE_CODE}:conv:${UUID}`;

/** A hypothetical protocol-native key — MCP defines none today (see declared.ts). */
const PROTOCOL_KEY = "io.modelcontextprotocol/conversationId";

function metaExtras(meta: Record<string, unknown>) {
  return { _meta: meta };
}

function expectHit(hit: DeclaredIdentityHit | null): DeclaredIdentityHit {
  if (!hit) throw new Error("expected a declared-identity hit");
  return hit;
}

describe("DEFAULT_DECLARED_IDENTITY_KEYS", () => {
  test("is data, in the documented order", () => {
    expect(DEFAULT_DECLARED_IDENTITY_KEYS.map((k) => k.key)).toEqual([
      AGENT_ID_META_KEY,
      BAGGAGE_META_KEY,
    ]);
  });
});

describe("buildDeclaredIdentityKeys", () => {
  test("appends a key under a reserved MCP prefix", () => {
    const keys = buildDeclaredIdentityKeys(PROTOCOL_KEY);
    expect(keys.map((k) => k.key)).toEqual([AGENT_ID_META_KEY, BAGGAGE_META_KEY, PROTOCOL_KEY]);
    expect(keys[2]?.form).toBe("conversation-id");
  });

  test("ignores a key that is not under a reserved MCP prefix", () => {
    // Accepting an arbitrary key would let a caller-controlled `_meta` field
    // name identity — a different threat model from the reserved-prefix one.
    expect(buildDeclaredIdentityKeys("com.evil/agent_id")).toEqual(DEFAULT_DECLARED_IDENTITY_KEYS);
  });

  test("accepts every prefix form the MCP spec names as reserved (PR #2877 R1)", () => {
    // The spec's rule is "the SECOND label is `modelcontextprotocol` or `mcp`",
    // not a list of two literal prefixes. These four are its own examples.
    for (const key of [
      "io.modelcontextprotocol/conversationId",
      "dev.mcp/conversationId",
      "org.modelcontextprotocol.api/conversationId",
      "com.mcp.tools/conversationId",
    ]) {
      expect(isReservedMcpKey(key)).toBe(true);
      expect(buildDeclaredIdentityKeys(key).map((k) => k.key)).toContain(key);
    }
  });

  test("rejects the spec's own counter-example and other near-misses", () => {
    for (const key of [
      // The spec names this one explicitly: second label is `example`.
      "com.example.mcp/conversationId",
      // A single label is not a prefix.
      "mcp/conversationId",
      // Merely PREFIXED by a reserved string is not the same as reserved.
      "io.modelcontextprotocol.evil.com/conversationId".replace("io.", "com.evil."),
      // No prefix at all.
      "conversationId",
      "/conversationId",
    ]) {
      expect(isReservedMcpKey(key)).toBe(false);
      expect(buildDeclaredIdentityKeys(key)).toEqual(DEFAULT_DECLARED_IDENTITY_KEYS);
    }
  });

  test("returns the default list when no key is configured", () => {
    expect(buildDeclaredIdentityKeys()).toEqual(DEFAULT_DECLARED_IDENTITY_KEYS);
    expect(buildDeclaredIdentityKeys("")).toEqual(DEFAULT_DECLARED_IDENTITY_KEYS);
  });
});

describe("readDeclaredIdentity", () => {
  test("resolves from io.minsky/agent_id", () => {
    const hit = expectHit(
      readDeclaredIdentity(metaExtras({ [AGENT_ID_META_KEY]: DECLARED_AGENT_ID }))
    );
    expect(serializeAgentId(hit.parsed)).toBe(DECLARED_AGENT_ID);
    expect(hit.key).toBe(AGENT_ID_META_KEY);
  });

  test("resolves from W3C baggage when agent_id is absent", () => {
    const hit = expectHit(
      readDeclaredIdentity(
        metaExtras({ [BAGGAGE_META_KEY]: `${GEN_AI_CONVERSATION_ID_KEY}=${UUID}` }),
        DEFAULT_DECLARED_IDENTITY_KEYS,
        "claude-code"
      )
    );
    expect(serializeAgentId(hit.parsed)).toBe(`${KNOWN_KINDS.CLAUDE_CODE}:conv:${UUID}`);
    expect(hit.key).toBe(BAGGAGE_META_KEY);
    expect(hit.parsed.scope).toBe("conv");
  });

  test("honors ORDER when both keys are present with DIFFERENT ids", () => {
    // Asserts precedence, not merely that something resolved: the two keys
    // carry different conversation ids, so only the ordered read can pass.
    const hit = readDeclaredIdentity(
      metaExtras({
        [AGENT_ID_META_KEY]: `${KNOWN_KINDS.CLAUDE_CODE}:conv:${UUID}`,
        [BAGGAGE_META_KEY]: `${GEN_AI_CONVERSATION_ID_KEY}=${OTHER_UUID}`,
      }),
      DEFAULT_DECLARED_IDENTITY_KEYS,
      "claude-code"
    );
    expect(hit?.key).toBe(AGENT_ID_META_KEY);
    expect(hit?.parsed.id).toBe(UUID);
  });

  test("degrades the KIND to unknown when clientInfo is absent, keeping conversation scope", () => {
    // The 2026-07-28 revision makes `io.modelcontextprotocol/clientInfo`
    // optional per request, so this is a real wire state, not a hypothetical.
    const hit = readDeclaredIdentity(
      metaExtras({ [BAGGAGE_META_KEY]: `${GEN_AI_CONVERSATION_ID_KEY}=${UUID}` })
    );
    expect(hit?.parsed.kind).toBe(KNOWN_KINDS.UNKNOWN);
    expect(hit?.parsed.scope).toBe("conv");
    expect(hit?.parsed.id).toBe(UUID);
  });

  test("resolves from a configured protocol key when the earlier keys are absent", () => {
    const keys = buildDeclaredIdentityKeys(PROTOCOL_KEY);
    const hit = expectHit(
      readDeclaredIdentity(metaExtras({ [PROTOCOL_KEY]: UUID }), keys, "claude-code")
    );
    expect(hit.key).toBe(PROTOCOL_KEY);
    expect(serializeAgentId(hit.parsed)).toBe(`${KNOWN_KINDS.CLAUDE_CODE}:conv:${UUID}`);
  });

  test("falls THROUGH a malformed earlier key to a later one", () => {
    const hit = readDeclaredIdentity(
      metaExtras({
        [AGENT_ID_META_KEY]: "not a valid agent id",
        [BAGGAGE_META_KEY]: `${GEN_AI_CONVERSATION_ID_KEY}=${UUID}`,
      }),
      DEFAULT_DECLARED_IDENTITY_KEYS,
      "claude-code"
    );
    expect(hit?.key).toBe(BAGGAGE_META_KEY);
  });

  test("returns null when no key answers", () => {
    expect(readDeclaredIdentity(metaExtras({ unrelated: "x" }))).toBeNull();
    expect(readDeclaredIdentity(metaExtras({}))).toBeNull();
    expect(readDeclaredIdentity(undefined)).toBeNull();
    expect(readDeclaredIdentity({})).toBeNull();
  });

  test("does not throw on hostile or malformed input", () => {
    const hostile = [
      metaExtras({ [BAGGAGE_META_KEY]: "100%" }),
      metaExtras({ [BAGGAGE_META_KEY]: 42 }),
      metaExtras({ [BAGGAGE_META_KEY]: { nested: true } }),
      metaExtras({ [AGENT_ID_META_KEY]: 42 }),
      metaExtras({ [AGENT_ID_META_KEY]: "" }),
      { _meta: "not an object" },
      { _meta: [1, 2, 3] },
    ];
    for (const extras of hostile) {
      expect(() => readDeclaredIdentity(extras as never)).not.toThrow();
      expect(readDeclaredIdentity(extras as never)).toBeNull();
    }
  });

  test("cannot smuggle a different kind or parent through a conversation id", () => {
    // The baggage path synthesizes `kind:conv:<id>`; a value containing `:` or
    // `@` must not be able to rewrite the kind, scope or parent chain.
    const hit = readDeclaredIdentity(
      metaExtras({
        [BAGGAGE_META_KEY]: `${GEN_AI_CONVERSATION_ID_KEY}=${encodeURIComponent("evil:conv:x@parent")}`,
      }),
      DEFAULT_DECLARED_IDENTITY_KEYS,
      "claude-code"
    );
    if (hit) {
      expect(hit.parsed.kind).toBe(KNOWN_KINDS.CLAUDE_CODE);
      expect(hit.parsed.scope).toBe("conv");
    }
  });
});
