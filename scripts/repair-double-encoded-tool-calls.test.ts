/**
 * Unit tests for `repair-double-encoded-tool-calls.ts` (mt#3360).
 *
 * `classifyStringRows` is exercised directly — no DB, no I/O. This is the
 * guard the repair's UPDATE relies on: it decides which string-typed
 * `tool_calls` rows are safe to unwrap (parse to a JSON array) versus
 * residue that must be left untouched. Fixture rows below mirror the real
 * shape verified live against prod (2026-07-30): 1,948 rows across 6
 * sessions, every one of which unwraps cleanly to a `tool_use` array — plus
 * synthetic residue cases (invalid JSON syntax, valid JSON that isn't an
 * array) the live corpus does NOT currently contain but the guard must still
 * handle without throwing.
 */

import { describe, it, expect } from "bun:test";
import { classifyStringRows, type StringTypedRow } from "./repair-double-encoded-tool-calls";

function stringRow(agentSessionId: string, turnIndex: number, toolCalls: unknown): StringTypedRow {
  return { agentSessionId, turnIndex, toolCalls };
}

describe("classifyStringRows (mt#3360)", () => {
  it("classifies a double-encoded tool_use array as a candidate", () => {
    const raw = JSON.stringify([
      { id: "toolu_01", name: "Bash", type: "tool_use", input: { command: "bun test" } },
    ]);
    const rows = [stringRow("s1", 5, raw)];

    const result = classifyStringRows(rows);

    expect(result).toEqual([{ agentSessionId: "s1", turnIndex: 5, outcome: "candidate" }]);
  });

  it("classifies a double-encoded EMPTY array as a candidate too", () => {
    const rows = [stringRow("s1", 6, JSON.stringify([]))];

    const result = classifyStringRows(rows);

    expect(result[0]?.outcome).toBe("candidate");
  });

  it("classifies syntactically invalid JSON as residue, with a reason, and does not throw", () => {
    const rows = [stringRow("s1", 7, "not valid json at all")];

    const result = classifyStringRows(rows);

    expect(result).toHaveLength(1);
    expect(result[0]?.outcome).toBe("residue");
    expect(result[0]?.reason).toMatch(/JSON\.parse failed/);
  });

  it("classifies valid JSON that unwraps to an object (not an array) as residue", () => {
    const rows = [stringRow("s1", 8, JSON.stringify({ not: "an array" }))];

    const result = classifyStringRows(rows);

    expect(result[0]?.outcome).toBe("residue");
    expect(result[0]?.reason).toMatch(/unwraps to object, not an array/);
  });

  it("classifies valid JSON that unwraps to a scalar (string/number) as residue", () => {
    const rows = [
      stringRow("s1", 9, JSON.stringify("just a string")),
      stringRow("s1", 10, JSON.stringify(42)),
    ];

    const result = classifyStringRows(rows);

    expect(result[0]?.outcome).toBe("residue");
    expect(result[0]?.reason).toMatch(/unwraps to string, not an array/);
    expect(result[1]?.outcome).toBe("residue");
    expect(result[1]?.reason).toMatch(/unwraps to number, not an array/);
  });

  it("classifies a non-string value at read time as residue rather than throwing", () => {
    // Defensive path: fetchStringTypedRows already filters on
    // jsonb_typeof = 'string', so this shouldn't happen in practice — but
    // the classifier must never crash if it does.
    const rows = [stringRow("s1", 11, { already: "an object" })];

    const result = classifyStringRows(rows);

    expect(result[0]?.outcome).toBe("residue");
    expect(result[0]?.reason).toMatch(/expected a string value/);
  });

  it("mixed batch: candidates and residue are both reported, independently, in order", () => {
    const rows = [
      stringRow("s1", 1, JSON.stringify([{ type: "tool_use", name: "Bash" }])),
      stringRow("s1", 2, "garbage"),
      stringRow("s2", 3, JSON.stringify([{ type: "tool_use", name: "Read" }])),
    ];

    const result = classifyStringRows(rows);

    expect(result.map((r) => r.outcome)).toEqual(["candidate", "residue", "candidate"]);
  });

  it("matches the live-verified shape: a real multi-tool-use array with MCP tool names", () => {
    // Drawn from the live prod sample verified during this task's design
    // (session 05385ada-4ceb-4d8e-8ee6-43b91ca8dded, turn 288).
    const raw = JSON.stringify([
      {
        id: "toolu_012LhJEvrStsKcY2uciwFgzS",
        name: "ToolSearch",
        type: "tool_use",
        input: {
          query: "select:mcp__minsky__tasks_get,mcp__minsky__tasks_spec_get",
          max_results: 2,
        },
        caller: { type: "direct" },
      },
    ]);
    const rows = [stringRow("05385ada-4ceb-4d8e-8ee6-43b91ca8dded", 288, raw)];

    const result = classifyStringRows(rows);

    expect(result[0]?.outcome).toBe("candidate");
  });
});
