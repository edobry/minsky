import { describe, test, expect } from "bun:test";
import { parseSseEventData } from "./sse";

describe("parseSseEventData", () => {
  test("parses a single event with one data: line (the common MCP case)", () => {
    const body = 'data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';
    expect(parseSseEventData(body)).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}']);
  });

  test("parses multiple events in one response body", () => {
    const body =
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n' +
      'data: {"jsonrpc":"2.0","id":1,"result":{}}\n\n';
    expect(parseSseEventData(body)).toEqual([
      '{"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
      '{"jsonrpc":"2.0","id":1,"result":{}}',
    ]);
  });

  test("joins multiple data: lines within ONE event with a literal newline (spec-correct — the mt#3884 spike's known-unsafe simplification)", () => {
    const body = "data: line one\ndata: line two\ndata: line three\n\n";
    const result = parseSseEventData(body);
    expect(result).toEqual(["line one\nline two\nline three"]);
    // The reconstructed buffer legitimately contains embedded newlines here —
    // it is the CALLER's job (client.ts) to JSON.parse + re-stringify this
    // before ever writing it to stdout as a single JSON-RPC line.
    expect(result[0]?.includes("\n")).toBe(true);
  });

  test("strips exactly one leading space after the colon, per spec", () => {
    // "data:  x" (two spaces) should keep the second space as part of the value.
    const body = "data:  x\n\n";
    expect(parseSseEventData(body)).toEqual([" x"]);
  });

  test("handles a data: line with no leading space", () => {
    const body = "data:x\n\n";
    expect(parseSseEventData(body)).toEqual(["x"]);
  });

  test("ignores non-data fields (event:, id:, retry:)", () => {
    const body = "event: message\nid: 42\nretry: 1000\ndata: hello\n\n";
    expect(parseSseEventData(body)).toEqual(["hello"]);
  });

  test("skips events with no data: field at all", () => {
    const body = "event: ping\n\ndata: real\n\n";
    expect(parseSseEventData(body)).toEqual(["real"]);
  });

  test("normalizes CRLF line endings", () => {
    const body = 'data: {"a":1}\r\n\r\n';
    expect(parseSseEventData(body)).toEqual(['{"a":1}']);
  });

  test("returns an empty array for an empty body", () => {
    expect(parseSseEventData("")).toEqual([]);
  });

  test("returns an empty array for whitespace-only body", () => {
    expect(parseSseEventData("\n\n\n")).toEqual([]);
  });
});
