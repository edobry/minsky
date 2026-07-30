/**
 * Tests for the entity-thread route validators (mt#3364).
 *
 * These cover the request-shape contract the panel (mt#3365) will code
 * against: which entity types are accepted today, and what a rejected request
 * gets told.
 */

import { describe, expect, test } from "bun:test";

import { parseEntityType, parseMessageBody } from "./entity-threads";

describe("parseEntityType", () => {
  test("accepts the ask type this task ships", () => {
    expect(parseEntityType("ask")).toBe("ask");
  });

  test("refuses an entity type with no seed adapter yet, and names what IS supported", () => {
    // Silently accepting these would seed an agent with an empty body — an
    // agent confidently discussing nothing. mt#3366 adds the adapters and
    // widens this. The error names the supported set so a caller isn't left
    // guessing whether the type, the id, or the feature is the problem.
    const result = parseEntityType("task");
    expect(typeof result).toBe("object");
    expect((result as { error: string }).error).toContain("task");
    expect((result as { error: string }).error).toContain("ask");
  });

  test("refuses an unknown type", () => {
    expect(typeof parseEntityType("banana")).toBe("object");
  });

  test("refuses a missing or non-string type", () => {
    expect((parseEntityType(undefined) as { error: string }).error).toContain("required");
    expect((parseEntityType("") as { error: string }).error).toContain("required");
    expect(typeof parseEntityType(42)).toBe("object");
  });
});

describe("parseMessageBody", () => {
  test("accepts a message and trims it", () => {
    expect(parseMessageBody({ text: "  what is this?  " })).toEqual({ text: "what is this?" });
  });

  test("refuses an empty or whitespace-only message", () => {
    // An empty message would still spawn an agent and burn a turn on nothing.
    expect((parseMessageBody({ text: "" }) as { error: string }).error).toContain("empty");
    expect((parseMessageBody({ text: "   " }) as { error: string }).error).toContain("empty");
  });

  test("refuses a body with no text field, or a non-string one", () => {
    expect((parseMessageBody({}) as { error: string }).error).toContain("required");
    expect((parseMessageBody({ text: 42 }) as { error: string }).error).toContain("required");
  });

  test("refuses a non-object body", () => {
    expect((parseMessageBody(null) as { error: string }).error).toContain("object");
    expect((parseMessageBody("hi") as { error: string }).error).toContain("object");
  });
});
