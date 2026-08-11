/**
 * Unit tests for agentId format parser/serializer (ADR-006).
 */
import { describe, test, expect } from "bun:test";
import {
  parseAgentId,
  serializeAgentId,
  isValidAgentId,
  redactAgentId,
  type ParsedAgentId,
} from "./format";

// Shared test constants — extracted to avoid magic-string-duplication warnings
const CLAUDE_CODE_KIND = "com.anthropic.claude-code";
const PROC_ID = "a1b2c3d4";
const CLAUDE_PROC_ID = `${CLAUDE_CODE_KIND}:proc:${PROC_ID}`;
const SUBAGENT_WITH_PARENT = `minsky.native-subagent:run:task-mt123@${CLAUDE_PROC_ID}`;

describe("parseAgentId", () => {
  test("parses a basic Layer 1 id", () => {
    const result = parseAgentId(CLAUDE_PROC_ID);
    expect(result).toEqual({
      kind: CLAUDE_CODE_KIND,
      scope: "proc",
      id: PROC_ID,
      parent: undefined,
    });
  });

  test("returns null for unknown scope 'task' (not in valid scopes)", () => {
    // "task" is not a valid scope — confirmed null fallback
    const result = parseAgentId(`minsky.native-subagent:task:mt#123@${CLAUDE_PROC_ID}`);
    expect(result).toBeNull();
  });

  test("parses an id with run scope and parent", () => {
    const result = parseAgentId(SUBAGENT_WITH_PARENT);
    expect(result).toEqual({
      kind: "minsky.native-subagent",
      scope: "run",
      id: "task-mt123",
      parent: CLAUDE_PROC_ID,
    });
  });

  test("parses hash scope", () => {
    const result = parseAgentId("unknown:hash:a1b2c3d4e5f6g7h8");
    expect(result).toEqual({
      kind: "unknown",
      scope: "hash",
      id: "a1b2c3d4e5f6g7h8",
      parent: undefined,
    });
  });

  test("parses conv scope", () => {
    const convId = `${CLAUDE_CODE_KIND}:conv:8f3a2d1b-0000-0000-0000-000000000001`;
    const result = parseAgentId(convId);
    expect(result).toEqual({
      kind: CLAUDE_CODE_KIND,
      scope: "conv",
      id: "8f3a2d1b-0000-0000-0000-000000000001",
      parent: undefined,
    });
  });

  describe("malformed inputs return null", () => {
    test("empty string", () => expect(parseAgentId("")).toBeNull());
    test("no colons", () => expect(parseAgentId("nocolons")).toBeNull());
    test("only one colon", () => expect(parseAgentId("kind:scope")).toBeNull());
    // "bad:kind:proc:id" → kind=bad, rest="kind:proc:id" → scope=kind → invalid scope
    test("four-segment string: scope=kind is invalid", () =>
      expect(parseAgentId("bad:kind:proc:id")).toBeNull());
    test("invalid scope", () => expect(parseAgentId("com.foo:invalid-scope:id")).toBeNull());
    test("empty id", () => expect(parseAgentId("com.foo:proc:")).toBeNull());
    test("@ with empty parent", () => expect(parseAgentId("com.foo:proc:id@")).toBeNull());
    test("kind with whitespace", () => expect(parseAgentId("bad kind:proc:id")).toBeNull());
  });
});

describe("serializeAgentId", () => {
  test("serializes a basic id", () => {
    const parsed: ParsedAgentId = {
      kind: CLAUDE_CODE_KIND,
      scope: "proc",
      id: PROC_ID,
    };
    expect(serializeAgentId(parsed)).toBe(CLAUDE_PROC_ID);
  });

  test("serializes id with parent", () => {
    const parsed: ParsedAgentId = {
      kind: "minsky.native-subagent",
      scope: "run",
      id: "task-mt123",
      parent: CLAUDE_PROC_ID,
    };
    expect(serializeAgentId(parsed)).toBe(SUBAGENT_WITH_PARENT);
  });

  test("returns null for empty parent", () => {
    const parsed: ParsedAgentId = {
      kind: "com.foo",
      scope: "proc",
      id: "id1",
      parent: "",
    };
    expect(serializeAgentId(parsed)).toBeNull();
  });

  test("returns null for invalid kind", () => {
    const parsed: ParsedAgentId = {
      kind: "bad:kind",
      scope: "proc",
      id: "id1",
    };
    expect(serializeAgentId(parsed)).toBeNull();
  });
});

describe("round-trip", () => {
  const CONV_ID = `${CLAUDE_CODE_KIND}:conv:8f3a2d1b-0000-0000-0000-000000000001`;
  const inputs = [
    CLAUDE_PROC_ID,
    "unknown:hash:a1b2c3d4e5f6g7h8",
    SUBAGENT_WITH_PARENT,
    CONV_ID,
    "com.openai.codex:proc:e5f6a7b8",
  ];

  test.each(inputs)("round-trips: %s", (input) => {
    const parsed = parseAgentId(input);
    expect(parsed).not.toBeNull();
    // Using type assertion: we've already asserted non-null above
    const parsed2 = parsed as ParsedAgentId;
    const serialized = serializeAgentId(parsed2);
    expect(serialized).toBe(input);
    // Parse again and verify structural equality
    const reparsed = parseAgentId(serialized as string);
    expect(reparsed).toEqual(parsed);
  });
});

describe("isValidAgentId", () => {
  test("returns true for valid ids", () => {
    expect(isValidAgentId(CLAUDE_PROC_ID)).toBe(true);
    expect(isValidAgentId("unknown:hash:a1b2c3d4")).toBe(true);
  });

  test("returns false for invalid ids", () => {
    expect(isValidAgentId("")).toBe(false);
    expect(isValidAgentId("bad")).toBe(false);
    expect(isValidAgentId("bad:invalid-scope:id")).toBe(false);
  });
});

describe("redactAgentId (mt#3986)", () => {
  const CONVERSATION_UUID = "2154425b-1c30-4f0e-9d51-0b73b9a2f5a1";

  test("keeps kind and scope, truncates the id segment to 8 chars", () => {
    expect(redactAgentId(`${CLAUDE_CODE_KIND}:conv:${CONVERSATION_UUID}`)).toBe(
      `${CLAUDE_CODE_KIND}:conv:2154425b…`
    );
  });

  test("does NOT leak the full conversation id", () => {
    // A conversation id is an attribution key: logging it verbatim would link
    // transcripts to infrastructure log sinks (PR #2390 R1). This is the
    // property the mt#3986 fallback log line depends on.
    const redacted = redactAgentId(`${CLAUDE_CODE_KIND}:conv:${CONVERSATION_UUID}`);
    expect(redacted).not.toContain(CONVERSATION_UUID);
    expect(redacted.length).toBeLessThan(`${CLAUDE_CODE_KIND}:conv:${CONVERSATION_UUID}`.length);
  });

  test("truncates a colon-less input rather than passing it through whole", () => {
    expect(redactAgentId("no-colons-at-all-and-quite-long")).toBe("no-colon…");
  });

  test("appends the ellipsis even when the id was already short enough", () => {
    // The stdio proxy and the shim each keep their own copy of this for bundle
    // reasons; their parity is asserted in src/mcp/shim/identity.test.ts. The
    // marker is unconditional in all three, so a redacted id is always
    // distinguishable from a verbatim one in a log line.
    expect(redactAgentId(CLAUDE_PROC_ID)).toBe(`${CLAUDE_CODE_KIND}:proc:${PROC_ID}…`);
  });
});
