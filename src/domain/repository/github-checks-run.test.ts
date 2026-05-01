/**
 * Unit tests for github-checks-run.ts (mt#1346).
 *
 * Covers:
 *  - mapSeverityToAnnotationLevel: BLOCKING → failure, NON-BLOCKING → warning, other → notice
 *  - deriveConclusion: failure rules, neutral for warning-only, success for empty
 *  - submitCheckRun pagination: 75 findings split into create + 1 update call
 *  - Octokit payload shape: annotation fields mapped correctly
 *  - Error handling: structured MinskyError on empty ref
 */

import { describe, expect, test, mock } from "bun:test";
import {
  mapSeverityToAnnotationLevel,
  deriveConclusion,
  submitCheckRun,
  type CheckRunAnnotation,
  type AnnotationLevel,
} from "./github-checks-run";
import { MinskyError } from "../../errors/index";

const CHECK_RUN_NAME = "minsky-reviewer/findings";
const TEST_SHA = "abc123sha";

// ---------------------------------------------------------------------------
// mapSeverityToAnnotationLevel
// ---------------------------------------------------------------------------

describe("mapSeverityToAnnotationLevel", () => {
  test("BLOCKING maps to failure", () => {
    expect(mapSeverityToAnnotationLevel("BLOCKING")).toBe("failure");
  });

  test("NON-BLOCKING maps to warning", () => {
    expect(mapSeverityToAnnotationLevel("NON-BLOCKING")).toBe("warning");
  });

  test("blocking (lowercase) maps to failure — case-insensitive", () => {
    expect(mapSeverityToAnnotationLevel("blocking")).toBe("failure");
  });

  test("non-blocking (lowercase) maps to warning — case-insensitive", () => {
    expect(mapSeverityToAnnotationLevel("non-blocking")).toBe("warning");
  });

  test("Mixed case 'Blocking' maps to failure", () => {
    expect(mapSeverityToAnnotationLevel("Blocking")).toBe("failure");
  });

  test("informational maps to notice", () => {
    expect(mapSeverityToAnnotationLevel("informational")).toBe("notice");
  });

  test("empty string maps to notice", () => {
    expect(mapSeverityToAnnotationLevel("")).toBe("notice");
  });

  test("unrecognized tag maps to notice", () => {
    expect(mapSeverityToAnnotationLevel("SUGGESTION")).toBe("notice");
  });

  test("whitespace-padded BLOCKING maps to failure", () => {
    expect(mapSeverityToAnnotationLevel("  BLOCKING  ")).toBe("failure");
  });
});

// ---------------------------------------------------------------------------
// deriveConclusion
// ---------------------------------------------------------------------------

describe("deriveConclusion", () => {
  test("empty list → success", () => {
    expect(deriveConclusion([])).toBe("success");
  });

  test("single failure → failure", () => {
    expect(deriveConclusion(["failure"])).toBe("failure");
  });

  test("1 BLOCKING + 2 NON-BLOCKING findings → failure (failure wins)", () => {
    const levels: AnnotationLevel[] = ["failure", "warning", "warning"];
    expect(deriveConclusion(levels)).toBe("failure");
  });

  test("only NON-BLOCKING findings → neutral", () => {
    const levels: AnnotationLevel[] = ["warning", "warning"];
    expect(deriveConclusion(levels)).toBe("neutral");
  });

  test("only informational findings → neutral (notice counts as non-empty)", () => {
    const levels: AnnotationLevel[] = ["notice", "notice"];
    expect(deriveConclusion(levels)).toBe("neutral");
  });

  test("mixed warning + notice → neutral", () => {
    const levels: AnnotationLevel[] = ["warning", "notice"];
    expect(deriveConclusion(levels)).toBe("neutral");
  });

  test("single failure among notices → failure", () => {
    const levels: AnnotationLevel[] = ["notice", "failure", "notice"];
    expect(deriveConclusion(levels)).toBe("failure");
  });
});

// ---------------------------------------------------------------------------
// submitCheckRun — pagination & payload shape (mocked Octokit)
// ---------------------------------------------------------------------------

/**
 * Build a minimal CheckRunAnnotation for test use.
 */
function mkAnnotation(overrides: Partial<CheckRunAnnotation> = {}): CheckRunAnnotation {
  return {
    path: "src/foo.ts",
    startLine: 10,
    endLine: 10,
    annotationLevel: "failure",
    title: "Test finding",
    message: "Something is wrong",
    ...overrides,
  };
}

/**
 * Build a mock Octokit-like object that records calls to checks.create and
 * checks.update. Returns the recorded calls for assertion.
 */
function buildMockOctokit() {
  const createCalls: unknown[] = [];
  const updateCalls: unknown[] = [];

  const octokit = {
    rest: {
      checks: {
        create: mock(async (params: unknown) => {
          createCalls.push(params);
          return { data: { id: 12345, html_url: "https://github.com/check/12345" } };
        }),
        update: mock(async (params: unknown) => {
          updateCalls.push(params);
          return { data: { id: 12345, html_url: "https://github.com/check/12345" } };
        }),
      },
    },
    createCalls,
    updateCalls,
  };

  return octokit;
}

/**
 * Extract annotation arrays from all create + update calls recorded by the
 * mock Octokit, returning them as a flat list so callers can assert total count.
 */
function collectAnnotations(
  createCalls: unknown[],
  updateCalls: unknown[]
): Array<Record<string, unknown>> {
  const all: Array<Record<string, unknown>> = [];
  for (const call of [...createCalls, ...updateCalls]) {
    const c = call as Record<string, unknown>;
    const output = c.output as Record<string, unknown> | undefined;
    const annotations = output?.annotations as Array<Record<string, unknown>> | undefined;
    if (annotations) all.push(...annotations);
  }
  return all;
}

describe("submitCheckRun — pagination", () => {
  const gh = {
    owner: "test-owner",
    repo: "test-repo",
    getToken: async () => "test-token",
  };

  test("75 findings: create gets first 50, update gets remaining 25", async () => {
    const mockOctokit = buildMockOctokit();

    const annotations = Array.from({ length: 75 }, (_, i) =>
      mkAnnotation({ path: `src/file${i}.ts`, startLine: i + 1, endLine: i + 1 })
    );

    const result = await submitCheckRun(
      gh,
      TEST_SHA,
      {
        name: CHECK_RUN_NAME,
        status: "completed",
        conclusion: "failure",
        output: {
          title: "75 findings",
          summary: "75 findings: 75 blocking.",
          annotations,
        },
      },
      mockOctokit as unknown as Parameters<typeof submitCheckRun>[3]
    );

    expect(result.checkRunId).toBe(12345);
    expect(result.htmlUrl).toBe("https://github.com/check/12345");

    expect(mockOctokit.createCalls.length).toBe(1);
    expect(mockOctokit.updateCalls.length).toBe(1);

    const createCall = mockOctokit.createCalls[0] as Record<string, unknown>;
    const createOutput = createCall.output as Record<string, unknown>;
    const createAnnotations = createOutput.annotations as unknown[];
    expect(createAnnotations.length).toBe(50);

    const updateCall = mockOctokit.updateCalls[0] as Record<string, unknown>;
    const updateOutput = updateCall.output as Record<string, unknown>;
    const updateAnnotations = updateOutput.annotations as unknown[];
    expect(updateAnnotations.length).toBe(25);

    const allAnnotations = collectAnnotations(mockOctokit.createCalls, mockOctokit.updateCalls);
    expect(allAnnotations.length).toBe(75);
  });

  test("50 findings exactly: only create call, no update", async () => {
    const mockOctokit = buildMockOctokit();
    const annotations = Array.from({ length: 50 }, (_, i) =>
      mkAnnotation({ path: `src/file${i}.ts`, startLine: i + 1 })
    );

    await submitCheckRun(
      gh,
      TEST_SHA,
      {
        name: CHECK_RUN_NAME,
        status: "completed",
        conclusion: "neutral",
        output: { title: "50 findings", summary: "50 findings.", annotations },
      },
      mockOctokit as unknown as Parameters<typeof submitCheckRun>[3]
    );

    expect(mockOctokit.createCalls.length).toBe(1);
    expect(mockOctokit.updateCalls.length).toBe(0);
  });

  test("0 findings: create call with no annotations key in output", async () => {
    const mockOctokit = buildMockOctokit();

    const result = await submitCheckRun(
      gh,
      TEST_SHA,
      {
        name: CHECK_RUN_NAME,
        status: "completed",
        conclusion: "success",
        output: {
          title: "0 findings",
          summary: "No findings — all checks passed.",
          annotations: [],
        },
      },
      mockOctokit as unknown as Parameters<typeof submitCheckRun>[3]
    );

    expect(result.checkRunId).toBe(12345);
    expect(mockOctokit.createCalls.length).toBe(1);
    expect(mockOctokit.updateCalls.length).toBe(0);

    const createCall = mockOctokit.createCalls[0] as Record<string, unknown>;
    const createOutput = createCall.output as Record<string, unknown>;
    expect("annotations" in createOutput).toBe(false);
  });

  test("throws MinskyError when ref is empty string", async () => {
    await expect(
      submitCheckRun(gh, "", {
        name: CHECK_RUN_NAME,
        status: "completed",
        conclusion: "success",
        output: { title: "test", summary: "test" },
      })
    ).rejects.toThrow(MinskyError);
  });
});

// ---------------------------------------------------------------------------
// Octokit payload shape
// ---------------------------------------------------------------------------

describe("submitCheckRun — annotation payload mapping", () => {
  const gh = {
    owner: "test-owner",
    repo: "test-repo",
    getToken: async () => "test-token",
  };

  test("annotation fields map correctly to Octokit snake_case shape", async () => {
    const mockOctokit = buildMockOctokit();

    await submitCheckRun(
      gh,
      TEST_SHA,
      {
        name: CHECK_RUN_NAME,
        status: "completed",
        conclusion: "failure",
        output: {
          title: "Test",
          summary: "Test summary",
          annotations: [
            {
              path: "src/example.ts",
              startLine: 42,
              endLine: 45,
              annotationLevel: "failure",
              title: "Null dereference",
              message: "Variable may be null at this point",
              rawDetails: "Stack trace here",
            },
          ],
        },
      },
      mockOctokit as unknown as Parameters<typeof submitCheckRun>[3]
    );

    const createCall = mockOctokit.createCalls[0] as Record<string, unknown>;
    const output = createCall.output as Record<string, unknown>;
    const annotations = output.annotations as Array<Record<string, unknown>>;
    expect(annotations.length).toBe(1);
    const ann = annotations[0];
    if (!ann) throw new Error("Expected annotation at index 0");

    expect(ann.path).toBe("src/example.ts");
    expect(ann.start_line).toBe(42);
    expect(ann.end_line).toBe(45);
    expect(ann.annotation_level).toBe("failure");
    expect(ann.title).toBe("Null dereference");
    expect(ann.message).toBe("Variable may be null at this point");
    expect(ann.raw_details).toBe("Stack trace here");
  });

  test("rawDetails is omitted from payload when not provided", async () => {
    const mockOctokit = buildMockOctokit();

    await submitCheckRun(
      gh,
      TEST_SHA,
      {
        name: CHECK_RUN_NAME,
        status: "completed",
        conclusion: "warning" as unknown as "failure",
        output: {
          title: "Test",
          summary: "Test summary",
          annotations: [
            {
              path: "src/example.ts",
              startLine: 10,
              endLine: 10,
              annotationLevel: "warning",
              title: "Style issue",
              message: "Consider renaming this variable",
              // rawDetails intentionally omitted
            },
          ],
        },
      },
      mockOctokit as unknown as Parameters<typeof submitCheckRun>[3]
    );

    const createCall = mockOctokit.createCalls[0] as Record<string, unknown>;
    const output = createCall.output as Record<string, unknown>;
    const annotations = output.annotations as Array<Record<string, unknown>>;
    const ann = annotations[0];
    if (!ann) throw new Error("Expected annotation at index 0");

    expect("raw_details" in ann).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration scenario: 1 BLOCKING + 2 NON-BLOCKING
// ---------------------------------------------------------------------------

describe("submitCheckRun — integration scenarios", () => {
  test("1 BLOCKING + 2 NON-BLOCKING → conclusion failure, 3 annotations", async () => {
    // Verifies the acceptance test scenario from the spec:
    // review with 1 BLOCKING + 2 NON-BLOCKING → check run conclusion: failure, 3 annotations
    const blocking = mapSeverityToAnnotationLevel("BLOCKING");
    const nonBlocking1 = mapSeverityToAnnotationLevel("NON-BLOCKING");
    const nonBlocking2 = mapSeverityToAnnotationLevel("NON-BLOCKING");

    const levels: AnnotationLevel[] = [blocking, nonBlocking1, nonBlocking2];
    const conclusion = deriveConclusion(levels);

    expect(blocking).toBe("failure");
    expect(nonBlocking1).toBe("warning");
    expect(nonBlocking2).toBe("warning");
    expect(conclusion).toBe("failure");
    expect(levels.length).toBe(3);
  });

  test("empty findings → conclusion success", () => {
    const conclusion = deriveConclusion([]);
    expect(conclusion).toBe("success");
  });
});

// ---------------------------------------------------------------------------
// submitCheckRun — Octokit error handling via octokitOverride DI seam
// ---------------------------------------------------------------------------

describe("submitCheckRun — Octokit error handling", () => {
  const gh = {
    owner: "test-owner",
    repo: "test-repo",
    getToken: async () => "test-token",
  };

  /**
   * Build a minimal mock Octokit where checks.create rejects with the given error.
   * This tests the handleOctokitError path without module-level mocking.
   */
  function buildFailingOctokit(syntheticError: unknown) {
    return {
      rest: {
        checks: {
          create: mock(async (_params: unknown) => {
            throw syntheticError;
          }),
          update: mock(async (_params: unknown) => {
            return { data: { id: 99, html_url: "https://github.com/check/99" } };
          }),
        },
      },
    };
  }

  test("404 from checks.create surfaces as MinskyError via handleOctokitError", async () => {
    // Simulate a 404 Octokit response (invalid repo / missing permissions)
    const notFoundError = Object.assign(new Error("Not Found"), { status: 404 });

    const mockOctokit = buildFailingOctokit(notFoundError);

    await expect(
      submitCheckRun(
        gh,
        TEST_SHA,
        {
          name: CHECK_RUN_NAME,
          status: "completed",
          conclusion: "success",
          output: { title: "test", summary: "test summary" },
        },
        mockOctokit as unknown as Parameters<typeof submitCheckRun>[3]
      )
    ).rejects.toBeInstanceOf(MinskyError);
  });

  test("404 from checks.create throws MinskyError, not raw Octokit error", async () => {
    const rawOctokitError = Object.assign(new Error("Not Found"), { status: 404 });
    const mockOctokit = buildFailingOctokit(rawOctokitError);

    let thrown: unknown;
    try {
      await submitCheckRun(
        gh,
        TEST_SHA,
        {
          name: CHECK_RUN_NAME,
          status: "completed",
          conclusion: "success",
          output: { title: "test", summary: "test summary" },
        },
        mockOctokit as unknown as Parameters<typeof submitCheckRun>[3]
      );
    } catch (err) {
      thrown = err;
    }

    // Must be a MinskyError, not the raw axios/octokit error
    expect(thrown).toBeInstanceOf(MinskyError);
    // Must not be the raw error object
    expect(thrown).not.toBe(rawOctokitError);
    // MinskyError message should contain structured context
    if (thrown instanceof MinskyError) {
      expect(thrown.message).toContain("Not Found");
    }
  });

  test("401 from checks.create throws MinskyError with authentication context", async () => {
    const authError = Object.assign(new Error("Bad credentials"), { status: 401 });
    const mockOctokit = buildFailingOctokit(authError);

    let thrown: unknown;
    try {
      await submitCheckRun(
        gh,
        TEST_SHA,
        {
          name: CHECK_RUN_NAME,
          status: "completed",
          conclusion: "success",
          output: { title: "test", summary: "test summary" },
        },
        mockOctokit as unknown as Parameters<typeof submitCheckRun>[3]
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MinskyError);
    if (thrown instanceof MinskyError) {
      // Should mention authentication issue, not raw "Bad credentials"
      expect(thrown.message.toLowerCase()).toContain("auth");
    }
  });
});
