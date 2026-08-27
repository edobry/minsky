import { describe, test, expect, beforeEach } from "bun:test";
import {
  resolveConversationAgentId,
  resolveLiveConversationAgentId,
  injectAgentIdMeta,
  conversationIdFromAgentId,
  redactAgentId,
  AGENT_ID_META_KEY,
  BAGGAGE_META_KEY,
} from "./identity";
import {
  resolveConversationAgentId as proxyResolveConversationAgentId,
  resolveLiveConversationAgentId as proxyResolveLiveConversationAgentId,
  injectAgentIdMeta as proxyInjectAgentIdMeta,
  redactAgentId as proxyRedactAgentId,
  CONVERSATION_MAPPING_TTL_MS,
  resetConversationMappingCache,
} from "../stdio-proxy/conversation-identity";
import {
  GEN_AI_CONVERSATION_ID_KEY,
  MAX_BAGGAGE_MEMBERS,
} from "@minsky/domain/agent-identity/baggage";
import type { JsonRpcMessage } from "./protocol";

const VALID_UUID = "e2e0f1d2-3c4b-4a5d-9e8f-0123456789ab";
const EXPECTED_AGENT_ID = `com.anthropic.claude-code:conv:${VALID_UUID}`;

describe("resolveConversationAgentId", () => {
  test("resolves a valid UUID env var into the canonical agentId", () => {
    expect(resolveConversationAgentId({ CLAUDE_CODE_SESSION_ID: VALID_UUID })).toBe(
      EXPECTED_AGENT_ID
    );
  });

  test("is case-insensitive and lowercases the id segment", () => {
    expect(resolveConversationAgentId({ CLAUDE_CODE_SESSION_ID: VALID_UUID.toUpperCase() })).toBe(
      EXPECTED_AGENT_ID
    );
  });

  test("returns null when the env var is absent (AT3 fall-through)", () => {
    expect(resolveConversationAgentId({})).toBeNull();
  });

  test("returns null when the env var is not UUID-shaped (AT4 fall-through)", () => {
    expect(resolveConversationAgentId({ CLAUDE_CODE_SESSION_ID: "not-a-uuid" })).toBeNull();
  });

  test("returns null for an empty string", () => {
    expect(resolveConversationAgentId({ CLAUDE_CODE_SESSION_ID: "" })).toBeNull();
  });
});

describe("injectAgentIdMeta", () => {
  // Expectation updated in mt#3986: the writer now stamps BOTH the Minsky key
  // and the W3C `baggage` entry `gen_ai.conversation.id`, so every `_meta`
  // assertion below carries the second key. Previously: agent_id only.
  test("stamps _meta on a tools/call request with no existing _meta", () => {
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "tasks_get", arguments: { taskId: "mt#3812" } },
    };
    const result = injectAgentIdMeta(msg, EXPECTED_AGENT_ID);
    expect(result).not.toBeNull();
    expect((result?.params as Record<string, unknown>)["_meta"]).toEqual({
      [AGENT_ID_META_KEY]: EXPECTED_AGENT_ID,
      [BAGGAGE_META_KEY]: `${GEN_AI_CONVERSATION_ID_KEY}=${VALID_UUID}`,
    });
    // original untouched
    expect(msg.params?.["_meta"]).toBeUndefined();
  });

  test("does NOT overwrite an already-present agent_id (AT2), but still adds baggage", () => {
    // Expectation updated in mt#3986: the two keys are decided independently,
    // so a caller that declared its own agent_id keeps it AND gains baggage.
    // Previously this returned null (nothing written at all).
    const declared = "minsky.native-subagent:run:mt-1@parent";
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "tasks_get",
        _meta: { [AGENT_ID_META_KEY]: declared },
      },
    };
    const result = injectAgentIdMeta(msg, EXPECTED_AGENT_ID);
    expect(result).not.toBeNull();
    const meta = (result?.params as Record<string, unknown>)["_meta"] as Record<string, unknown>;
    expect(meta[AGENT_ID_META_KEY]).toBe(declared);
    expect(meta[BAGGAGE_META_KEY]).toBe(`${GEN_AI_CONVERSATION_ID_KEY}=${VALID_UUID}`);
  });

  test("preserves other _meta keys when stamping", () => {
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "x", _meta: { progressToken: "abc" } },
    };
    const result = injectAgentIdMeta(msg, EXPECTED_AGENT_ID);
    expect((result?.params as Record<string, unknown>)["_meta"]).toEqual({
      progressToken: "abc",
      [AGENT_ID_META_KEY]: EXPECTED_AGENT_ID,
      [BAGGAGE_META_KEY]: `${GEN_AI_CONVERSATION_ID_KEY}=${VALID_UUID}`,
    });
  });

  test("AT5: MERGES into a caller's existing baggage without clobbering it", () => {
    const existing = "userId=alice,tenant=acme";
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "x", _meta: { [BAGGAGE_META_KEY]: existing } },
    };
    const result = injectAgentIdMeta(msg, EXPECTED_AGENT_ID);
    const meta = (result?.params as Record<string, unknown>)["_meta"] as Record<string, unknown>;

    expect(meta[BAGGAGE_META_KEY]).toBe(`${existing},${GEN_AI_CONVERSATION_ID_KEY}=${VALID_UUID}`);
    // The caller's original members survive byte-identically.
    expect(meta[BAGGAGE_META_KEY]).toContain("userId=alice");
    expect(meta[BAGGAGE_META_KEY]).toContain("tenant=acme");
  });

  test("AT5: leaves a caller-declared gen_ai.conversation.id untouched", () => {
    const existing = `${GEN_AI_CONVERSATION_ID_KEY}=someone-elses-id`;
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "x",
        _meta: { [AGENT_ID_META_KEY]: EXPECTED_AGENT_ID, [BAGGAGE_META_KEY]: existing },
      },
    };
    // Both keys already declared by the caller — nothing left to write.
    expect(injectAgentIdMeta(msg, EXPECTED_AGENT_ID)).toBeNull();
  });

  test("AT6: writes no baggage when appending would exceed the W3C limits", () => {
    const full = Array.from({ length: MAX_BAGGAGE_MEMBERS }, (_, i) => `k${i}=v${i}`).join(",");
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "x", _meta: { [BAGGAGE_META_KEY]: full } },
    };
    const result = injectAgentIdMeta(msg, EXPECTED_AGENT_ID);
    const meta = (result?.params as Record<string, unknown>)["_meta"] as Record<string, unknown>;

    // agent_id still applies; baggage is left exactly as the caller sent it,
    // with no partial list-member appended.
    expect(meta[AGENT_ID_META_KEY]).toBe(EXPECTED_AGENT_ID);
    expect(meta[BAGGAGE_META_KEY]).toBe(full);
  });

  test("does not emit baggage for an agentId that is not conversation-scoped", () => {
    // A `proc`-scoped Layer 1 hash is not a conversation id; emitting it as
    // gen_ai.conversation.id would make baggage-resolved identity wrong rather
    // than absent.
    const procScoped = "com.anthropic.claude-code:proc:a1b2c3d4e5f6";
    expect(conversationIdFromAgentId(procScoped)).toBeNull();

    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "x" },
    };
    const result = injectAgentIdMeta(msg, procScoped);
    const meta = (result?.params as Record<string, unknown>)["_meta"] as Record<string, unknown>;
    expect(meta[AGENT_ID_META_KEY]).toBe(procScoped);
    expect(meta[BAGGAGE_META_KEY]).toBeUndefined();
  });

  test("returns null for non-tools/call methods (e.g. initialize)", () => {
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    };
    expect(injectAgentIdMeta(msg, EXPECTED_AGENT_ID)).toBeNull();
  });

  test("returns null when params is missing", () => {
    const msg: JsonRpcMessage = { jsonrpc: "2.0", id: 1, method: "tools/call" };
    expect(injectAgentIdMeta(msg, EXPECTED_AGENT_ID)).toBeNull();
  });

  test("returns null when params is an array", () => {
    const msg: JsonRpcMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: [] as unknown as Record<string, unknown>,
    };
    expect(injectAgentIdMeta(msg, EXPECTED_AGENT_ID)).toBeNull();
  });
});

describe("redactAgentId", () => {
  test("truncates the id segment to 8 chars, keeps kind:scope", () => {
    expect(redactAgentId(EXPECTED_AGENT_ID)).toBe("com.anthropic.claude-code:conv:e2e0f1d2…");
  });
});

/**
 * Behavioral parity with the stdio proxy (mt#3986).
 *
 * `identity.ts`'s docblock says its logic is duplicated from
 * `stdio-proxy/conversation-identity.ts` rather than imported, and that this
 * file catches drift mechanically. Until mt#3986 that claim was false — nothing
 * here referenced the proxy at all — which mattered because the two are the
 * ONLY two writers of conversation identity onto the wire. A divergence between
 * them is exactly the silent-degradation class this task exists to close, so
 * the parity assertion is now real.
 */
describe("parity with the stdio proxy writer", () => {
  const cases: Array<{ name: string; msg: JsonRpcMessage }> = [
    {
      name: "no existing _meta",
      msg: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "tasks_get" } },
    },
    {
      name: "existing unrelated _meta keys",
      msg: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "x", _meta: { progressToken: "abc" } },
      },
    },
    {
      name: "caller-declared agent_id",
      msg: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "x", _meta: { [AGENT_ID_META_KEY]: "minsky.native-subagent:run:mt-1" } },
      },
    },
    {
      name: "caller-supplied baggage",
      msg: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "x", _meta: { [BAGGAGE_META_KEY]: "userId=alice,tenant=acme" } },
      },
    },
    {
      name: "caller-supplied UNPARSEABLE baggage",
      msg: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "x", _meta: { [BAGGAGE_META_KEY]: "malformed-no-equals" } },
      },
    },
    {
      name: "baggage already at the member limit",
      msg: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "x",
          _meta: {
            [BAGGAGE_META_KEY]: Array.from(
              { length: MAX_BAGGAGE_MEMBERS },
              (_, i) => `k${i}=v${i}`
            ).join(","),
          },
        },
      },
    },
    {
      name: "non-tools/call method",
      msg: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "x" } },
    },
    {
      name: "missing params",
      msg: { jsonrpc: "2.0", id: 1, method: "tools/call" },
    },
  ];

  for (const { name, msg } of cases) {
    test(`injectAgentIdMeta agrees with the proxy: ${name}`, () => {
      const shimResult = injectAgentIdMeta(msg, EXPECTED_AGENT_ID);
      const proxyResult = proxyInjectAgentIdMeta(
        msg as Parameters<typeof proxyInjectAgentIdMeta>[0],
        EXPECTED_AGENT_ID
      );
      expect(shimResult).toEqual(proxyResult as typeof shimResult);
    });
  }

  test("resolveConversationAgentId agrees with the proxy on every env shape", () => {
    const envs = [
      { CLAUDE_CODE_SESSION_ID: VALID_UUID },
      { CLAUDE_CODE_SESSION_ID: VALID_UUID.toUpperCase() },
      { CLAUDE_CODE_SESSION_ID: "not-a-uuid" },
      { CLAUDE_CODE_SESSION_ID: "" },
      {},
    ];
    for (const env of envs) {
      expect(resolveConversationAgentId(env)).toBe(proxyResolveConversationAgentId(env));
    }
  });

  test("redactAgentId agrees with the proxy", () => {
    for (const id of [EXPECTED_AGENT_ID, "no-colons-at-all", "a:b:c"]) {
      expect(redactAgentId(id)).toBe(proxyRedactAgentId(id));
    }
  });

  /**
   * The strongest form this block can take (mt#4440).
   *
   * Every assertion above compares two implementations and passes when they
   * happen to agree today. For the LIVE resolution — the axis that actually
   * drifted, and drifted for five days undetected — the two writers now share
   * one function, so identity of reference is assertable directly. A future
   * edit that reintroduces a per-writer copy fails HERE, at the point of
   * divergence, rather than at whichever behavior the case list happens to
   * cover.
   */
  test("resolveLiveConversationAgentId IS the proxy's, not merely equivalent", () => {
    expect(resolveLiveConversationAgentId).toBe(proxyResolveLiveConversationAgentId);
  });
});

/**
 * Live conversation resolution at the shim seam (mt#4440).
 *
 * Every test here injects `readMapping` / `now` / `reresolvePid`, so nothing
 * touches the real filesystem or shells out to `ps` — the resolver takes them
 * as dependencies precisely so this layer is observable without patching a
 * collaborator it reaches itself.
 *
 * The module-global TTL cache is reset before each test: it is keyed by pid and
 * shared across the process, so a leftover entry from a sibling test would make
 * results depend on execution order.
 */
describe("resolveLiveConversationAgentId at the shim seam (mt#4440)", () => {
  const MAPPED_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const MAPPED_AGENT_ID = `com.anthropic.claude-code:conv:${MAPPED_UUID}`;
  const HARNESS_PID = 4440;

  beforeEach(() => {
    resetConversationMappingCache();
  });

  test("AT3: the mapping WINS over a disagreeing spawn-time env value", () => {
    // The exact production shape: the env holds the conversation that was live
    // when this process was spawned, the mapping holds the one live NOW, and
    // they disagree because a `/clear` happened in between.
    const resolved = resolveLiveConversationAgentId(HARNESS_PID, EXPECTED_AGENT_ID, {
      readMapping: () => MAPPED_UUID,
      now: () => 1_000,
      reresolvePid: () => null,
    });

    expect(resolved).toBe(MAPPED_AGENT_ID);
    expect(resolved).not.toBe(EXPECTED_AGENT_ID);
  });

  test("AT4: a conversation switch is picked up WITHOUT respawning the process", () => {
    // This is the property `main.ts`'s previous resolve-once-at-startup shape
    // structurally could not have, which is why it is the test that would have
    // caught the defect. One process, two resolutions, different answers.
    let mapped = MAPPED_UUID;
    const SWITCHED_UUID = "11111111-2222-4333-8444-555555555555";
    let clock = 1_000;

    const deps = {
      readMapping: () => mapped,
      now: () => clock,
      reresolvePid: () => null,
    };

    expect(resolveLiveConversationAgentId(HARNESS_PID, EXPECTED_AGENT_ID, deps)).toBe(
      MAPPED_AGENT_ID
    );

    mapped = SWITCHED_UUID;
    clock += CONVERSATION_MAPPING_TTL_MS + 1;

    expect(resolveLiveConversationAgentId(HARNESS_PID, EXPECTED_AGENT_ID, deps)).toBe(
      `com.anthropic.claude-code:conv:${SWITCHED_UUID}`
    );
  });

  test("AT5: falls back to the spawn-time env value when the mapping has no entry", () => {
    // Hookless environments and non-Claude-Code parents have no mapping at all.
    // Regressing them to NO identity would be a worse failure than the stale one
    // this task fixes, so the fallback is load-bearing rather than incidental.
    const resolved = resolveLiveConversationAgentId(HARNESS_PID, EXPECTED_AGENT_ID, {
      readMapping: () => null,
      now: () => 1_000,
      reresolvePid: () => null,
    });

    expect(resolved).toBe(EXPECTED_AGENT_ID);
  });

  test("returns null when neither source names a conversation", () => {
    // Never fabricate an identity — ADR-006 Layer-3 conservatism. The caller
    // stamps nothing and the reader falls through to Layer 1.
    expect(
      resolveLiveConversationAgentId(HARNESS_PID, null, {
        readMapping: () => null,
        now: () => 1_000,
        reresolvePid: () => null,
      })
    ).toBeNull();
  });

  test("a null harness pid short-circuits to the fallback without reading anything", () => {
    let reads = 0;
    const resolved = resolveLiveConversationAgentId(null, EXPECTED_AGENT_ID, {
      readMapping: () => {
        reads++;
        return MAPPED_UUID;
      },
      now: () => 1_000,
      reresolvePid: () => null,
    });

    expect(resolved).toBe(EXPECTED_AGENT_ID);
    expect(reads).toBe(0);
  });

  test("caches within the TTL, so a burst of frames pays one read", () => {
    // The cost side of the fix: this runs on every `tools/call` frame, so the
    // read has to be amortized or the shim's thinness case erodes.
    let reads = 0;
    const deps = {
      readMapping: () => {
        reads++;
        return MAPPED_UUID;
      },
      now: () => 1_000,
      reresolvePid: () => null,
    };

    for (let i = 0; i < 25; i++) {
      expect(resolveLiveConversationAgentId(HARNESS_PID, EXPECTED_AGENT_ID, deps)).toBe(
        MAPPED_AGENT_ID
      );
    }

    expect(reads).toBe(1);
  });

  test("re-walks the ancestor chain on a MISS, and never on a hit (mt#4378)", () => {
    // Carried through the move to the shared module. The seed pid can go stale
    // because the process outlives the harness that spawned it; a miss is the
    // only thing that pays for the `ps` walk.
    const LIVE_PID = 9999;
    let walks = 0;

    const resolvedOnMiss = resolveLiveConversationAgentId(HARNESS_PID, EXPECTED_AGENT_ID, {
      readMapping: (pid) => (pid === LIVE_PID ? MAPPED_UUID : null),
      now: () => 1_000,
      reresolvePid: () => {
        walks++;
        return LIVE_PID;
      },
    });
    expect(resolvedOnMiss).toBe(MAPPED_AGENT_ID);
    expect(walks).toBe(1);

    resetConversationMappingCache();
    walks = 0;

    const resolvedOnHit = resolveLiveConversationAgentId(HARNESS_PID, EXPECTED_AGENT_ID, {
      readMapping: () => MAPPED_UUID,
      now: () => 1_000,
      reresolvePid: () => {
        walks++;
        return LIVE_PID;
      },
    });
    expect(resolvedOnHit).toBe(MAPPED_AGENT_ID);
    expect(walks).toBe(0);
  });
});
