/**
 * Tests for classifyToolPayload (mt#2552) — the deterministic 2-way classifier.
 * Pure function; no DOM.
 */
import { describe, test, expect } from "bun:test";
import { classifyToolPayload } from "./tool-payload";

describe("classifyToolPayload (mt#2552)", () => {
  test("structured object → json", () => {
    const r = classifyToolPayload({ a: 1, b: "x" });
    expect(r.kind).toBe("json");
    if (r.kind === "json") expect(r.data).toEqual({ a: 1, b: "x" });
  });

  test("data array (non-text-block) → json", () => {
    const r = classifyToolPayload([{ id: "mt#1" }, { id: "mt#2" }]);
    expect(r.kind).toBe("json");
  });

  test("JSON string → json (parsed)", () => {
    const r = classifyToolPayload('{"x": 5}');
    expect(r.kind).toBe("json");
    if (r.kind === "json") expect(r.data).toEqual({ x: 5 });
  });

  test("text-block array → unwrapped to its text (non-JSON)", () => {
    const r = classifyToolPayload([{ type: "text", text: "hello world" }]);
    expect(r).toEqual({ kind: "text", text: "hello world" });
  });

  test("text-block array whose text IS json → json", () => {
    const r = classifyToolPayload([{ type: "text", text: '{"ok":true}' }]);
    expect(r.kind).toBe("json");
    if (r.kind === "json") expect(r.data).toEqual({ ok: true });
  });

  test("plain string → text", () => {
    expect(classifyToolPayload("just a log line")).toEqual({
      kind: "text",
      text: "just a log line",
    });
  });

  test("markdown/raw text is NOT routed to json (deterministic 2-way, no prose branch)", () => {
    const md = "# Heading\n- bullet\n\n```code```";
    expect(classifyToolPayload(md)).toEqual({ kind: "text", text: md });
  });

  test("non-JSON string containing braces mid-text stays text", () => {
    expect(classifyToolPayload("error at {line 5}: boom")).toEqual({
      kind: "text",
      text: "error at {line 5}: boom",
    });
  });

  test("null / undefined → empty text", () => {
    expect(classifyToolPayload(null)).toEqual({ kind: "text", text: "" });
    expect(classifyToolPayload(undefined)).toEqual({ kind: "text", text: "" });
  });

  test("mixed array (not all text blocks) → json (structured data)", () => {
    const r = classifyToolPayload([{ type: "text", text: "a" }, { id: 1 }]);
    expect(r.kind).toBe("json");
  });
});
