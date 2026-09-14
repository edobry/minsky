/**
 * Unit tests for Layer 2 declared reader (ADR-006).
 */
import { describe, test, expect } from "bun:test";
import { readLayer2, requestMetaOf, AGENT_ID_META_KEY, type RequestExtras } from "./layer2";

// Shared test constants
const VALID_AGENT_ID = "com.anthropic.claude-code:proc:a1b2c3d4e5f6g7h8";
const SUBAGENT_WITH_PARENT =
  "minsky.native-subagent:run:task-mt123@com.anthropic.claude-code:proc:a1b2c3d4";

describe("readLayer2", () => {
  test("returns parsed id for a well-formed _meta value", () => {
    const extras: RequestExtras = {
      _meta: { [AGENT_ID_META_KEY]: VALID_AGENT_ID },
    };
    const result = readLayer2(extras);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("com.anthropic.claude-code");
    expect(result?.scope).toBe("proc");
    expect(result?.id).toBe("a1b2c3d4e5f6g7h8");
  });

  test("returns parsed id with parent chain", () => {
    const extras: RequestExtras = {
      _meta: { [AGENT_ID_META_KEY]: SUBAGENT_WITH_PARENT },
    };
    const result = readLayer2(extras);
    expect(result).not.toBeNull();
    expect(result?.kind).toBe("minsky.native-subagent");
    expect(result?.parent).toBe("com.anthropic.claude-code:proc:a1b2c3d4");
  });

  describe("returns null for missing or malformed input", () => {
    test("no extras", () => expect(readLayer2(undefined)).toBeNull());
    test("no _meta", () => expect(readLayer2({})).toBeNull());
    test("_meta is null", () => {
      const extras = { _meta: null } as unknown as RequestExtras;
      expect(readLayer2(extras)).toBeNull();
    });
    test("_meta is array", () => {
      const extras = { _meta: [] } as unknown as RequestExtras;
      expect(readLayer2(extras)).toBeNull();
    });
    test("_meta missing agent_id key", () => {
      expect(readLayer2({ _meta: { progressToken: 42 } })).toBeNull();
    });
    test("_meta agent_id is number", () => {
      const extras = { _meta: { [AGENT_ID_META_KEY]: 42 } } as unknown as RequestExtras;
      expect(readLayer2(extras)).toBeNull();
    });
    test("_meta agent_id is empty string", () => {
      expect(readLayer2({ _meta: { [AGENT_ID_META_KEY]: "" } })).toBeNull();
    });
    test("_meta agent_id is malformed (missing scope)", () => {
      expect(readLayer2({ _meta: { [AGENT_ID_META_KEY]: "kind:id-only" } })).toBeNull();
    });
    test("_meta agent_id has invalid scope", () => {
      expect(readLayer2({ _meta: { [AGENT_ID_META_KEY]: "com.foo:invalid-scope:id" } })).toBeNull();
    });
  });

  test("does not throw for any input", () => {
    const oddInputs = [
      undefined,
      {},
      { _meta: "string" },
      { _meta: 42 },
      { _meta: { [AGENT_ID_META_KEY]: {} } },
      { _meta: { [AGENT_ID_META_KEY]: "malformed" } },
    ];
    for (const input of oddInputs) {
      expect(() => readLayer2(input as RequestExtras | undefined)).not.toThrow();
    }
  });
});

describe("requestMetaOf — both SDK context shapes (mt#5160)", () => {
  const VALID = "com.anthropic.claude-code:conv:1b2c3d4e-0000-4000-8000-00000000abcd";

  test("reads the SDK v2 shape: ctx.mcpReq._meta", () => {
    const extras: RequestExtras = { mcpReq: { _meta: { [AGENT_ID_META_KEY]: VALID } } };
    expect(requestMetaOf(extras)?.[AGENT_ID_META_KEY]).toBe(VALID);
    expect(readLayer2(extras)?.scope).toBe("conv");
  });

  test("still reads the SDK v1 flat shape: extra._meta", () => {
    const extras: RequestExtras = { _meta: { [AGENT_ID_META_KEY]: VALID } };
    expect(requestMetaOf(extras)?.[AGENT_ID_META_KEY]).toBe(VALID);
    expect(readLayer2(extras)?.scope).toBe("conv");
  });

  test("v2 wins when both are present — the flat field on a v2 ctx can only be a fixture's", () => {
    const extras: RequestExtras = {
      mcpReq: { _meta: { [AGENT_ID_META_KEY]: VALID } },
      _meta: { [AGENT_ID_META_KEY]: "unknown:conv:00000000-0000-4000-8000-000000000000" },
    };
    expect(requestMetaOf(extras)?.[AGENT_ID_META_KEY]).toBe(VALID);
  });

  test("a v2 ctx whose mcpReq carries no _meta falls through to the flat field, then to null", () => {
    expect(requestMetaOf({ mcpReq: { id: 1, method: "tools/call" } })).toBeNull();
    expect(
      requestMetaOf({ mcpReq: { id: 1 }, _meta: { [AGENT_ID_META_KEY]: VALID } })?.[
        AGENT_ID_META_KEY
      ]
    ).toBe(VALID);
  });

  test("non-object _meta in either position is ignored, never thrown on", () => {
    expect(requestMetaOf({ mcpReq: { _meta: "string" } })).toBeNull();
    expect(requestMetaOf({ mcpReq: { _meta: [1, 2] } })).toBeNull();
    expect(requestMetaOf({ _meta: 42 })).toBeNull();
    expect(requestMetaOf(undefined)).toBeNull();
  });
});
