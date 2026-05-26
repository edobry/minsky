/**
 * Unit tests for Layer 2 declared reader (ADR-006).
 */
import { describe, test, expect } from "bun:test";
import { readLayer2, AGENT_ID_META_KEY, type RequestExtras } from "./layer2";

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
