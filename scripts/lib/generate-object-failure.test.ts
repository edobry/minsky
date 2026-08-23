import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { classifyGenerateObjectFailure, extractSchemaIssuePaths } from "./generate-object-failure";
import { transformError } from "../../packages/domain/src/ai/completion-transforms";

/**
 * The real wrapping path, not a hand-built stand-in: a genuine `ZodError` from a genuine
 * rejected parse, passed through the same `transformError` the completion service calls.
 * A fixture shaped by hand would pin this classifier to what we BELIEVE the wrapper emits,
 * which is exactly the assumption the classifier exists to survive.
 */
const outputSchema = z.object({
  findings: z.array(z.object({ label: z.string() })),
  summary: z.string(),
});

function wrappedRejection(value: unknown): Error {
  try {
    outputSchema.parse(value);
  } catch (raw) {
    return transformError(raw, "anthropic", "claude-haiku-4-5-20251001");
  }
  throw new Error("expected the parse to reject");
}

describe("extractSchemaIssuePaths", () => {
  test("names the absent field for the dominant failure — summary missing", () => {
    const paths = extractSchemaIssuePaths(wrappedRejection({ findings: [] }));
    expect(paths).toEqual(["summary"]);
  });

  test("names findings when the FIRST declared property is the absent one", () => {
    const paths = extractSchemaIssuePaths(wrappedRejection({ summary: "ok" }));
    expect(paths).toEqual(["findings"]);
  });

  test("reports both when both are absent, so a row cannot be filed under one field", () => {
    const paths = extractSchemaIssuePaths(wrappedRejection({}));
    expect(paths).toEqual(expect.arrayContaining(["findings", "summary"]));
    expect(paths).toHaveLength(2);
  });

  test("renders a nested path through the findings array", () => {
    const paths = extractSchemaIssuePaths(wrappedRejection({ findings: [{}], summary: "ok" }));
    expect(paths).toEqual(["findings.0.label"]);
  });

  test("returns null for a transport failure, which is not a compliance datum", () => {
    expect(
      extractSchemaIssuePaths(new Error("The socket connection was closed unexpectedly"))
    ).toBeNull();
  });

  test("returns null for a rate-limit error even though it is wrapped the same way", () => {
    const wrapped = transformError(new Error("rate limit exceeded"), "anthropic", "haiku");
    expect(extractSchemaIssuePaths(wrapped)).toBeNull();
  });

  test("does not mistake an unrelated JSON array in the message for issues", () => {
    expect(extractSchemaIssuePaths(new Error("upstream returned [1, 2, 3]"))).toBeNull();
  });

  test("reads issues out of the message when the wrapper chain is unrecognized", () => {
    // The `details.originalError` walk cannot reach this one — only the message fallback can.
    const body = JSON.stringify([{ path: ["summary"], code: "invalid_type" }]);
    expect(extractSchemaIssuePaths(new Error(`AI completion failed: ${body}`))).toEqual([
      "summary",
    ]);
  });

  test("survives a self-referential cause chain rather than looping", () => {
    const err = new Error("boom") as Error & { cause?: unknown };
    err.cause = err;
    expect(extractSchemaIssuePaths(err)).toBeNull();
  });
});

describe("classifyGenerateObjectFailure", () => {
  test("a rejected parse classifies as a schema violation carrying its field", () => {
    expect(classifyGenerateObjectFailure(wrappedRejection({ findings: [] }))).toEqual({
      kind: "schema-violation",
      paths: ["summary"],
    });
  });

  test("a transport failure classifies as a call error, never as a violation", () => {
    expect(classifyGenerateObjectFailure(new Error("ECONNRESET"))).toEqual({ kind: "call-error" });
  });
});
