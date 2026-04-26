import { describe, it, expect } from "bun:test";
import { composeConventionalTitle, stripTaskIdPrefix } from "./pr-conventional-title";
import { ValidationError } from "../../../../errors";

// Shared expected output for the mt#1265 stripping tests
const EXPECTED_MT1265_FEAT_FOO = "feat(mt#1265): foo";

describe("stripTaskIdPrefix", () => {
  it("strips mt#N: prefix", () => {
    expect(stripTaskIdPrefix("mt#1265: foo")).toBe("foo");
  });

  it("strips #N: prefix", () => {
    expect(stripTaskIdPrefix("#1265: foo")).toBe("foo");
  });

  it("strips mt-N: prefix", () => {
    expect(stripTaskIdPrefix("mt-1265: foo")).toBe("foo");
  });

  it("leaves bare descriptions unchanged", () => {
    expect(stripTaskIdPrefix("foo")).toBe("foo");
  });

  it("leaves conventional commit prefixes unchanged", () => {
    expect(stripTaskIdPrefix(EXPECTED_MT1265_FEAT_FOO)).toBe(EXPECTED_MT1265_FEAT_FOO);
  });
});

describe("composeConventionalTitle", () => {
  // Existing regression tests
  it("requires --type and throws if missing", () => {
    expect(() =>
      composeConventionalTitle({
        type: undefined as any,
        title: "implement something",
        taskId: "md#413",
      })
    ).toThrow(ValidationError);
  });

  it("generates 'type(taskId): title' for bare description with taskId", () => {
    const result = composeConventionalTitle({
      type: "feat",
      title: "implement session pr open",
      taskId: "md#409",
    });
    expect(result).toBe("feat(md#409): implement session pr open");
  });

  // Spec-required cases: duplicate prefix stripping
  it("strips mt#N: prefix from title to avoid duplication", () => {
    const result = composeConventionalTitle({
      type: "feat",
      title: "mt#1265: foo",
      taskId: "mt#1265",
    });
    expect(result).toBe(EXPECTED_MT1265_FEAT_FOO);
  });

  it("strips #N: prefix from title to avoid duplication", () => {
    const result = composeConventionalTitle({
      type: "feat",
      title: "#1265: foo",
      taskId: "mt#1265",
    });
    expect(result).toBe(EXPECTED_MT1265_FEAT_FOO);
  });

  it("strips mt-N: prefix from title to avoid duplication", () => {
    const result = composeConventionalTitle({
      type: "feat",
      title: "mt-1265: foo",
      taskId: "mt#1265",
    });
    expect(result).toBe(EXPECTED_MT1265_FEAT_FOO);
  });

  // Spec-required: rejection names the exact prefix
  it("rejects title with conventional prefix and names the auto-prefix in the error", () => {
    let caught: unknown;
    try {
      composeConventionalTitle({
        type: "feat",
        title: EXPECTED_MT1265_FEAT_FOO,
        taskId: "mt#1265",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toContain("feat(mt#1265):");
  });

  // Spec-required: no taskId still works
  it("generates 'type: title' when no taskId is provided", () => {
    const result = composeConventionalTitle({
      type: "feat",
      title: "foo",
    });
    expect(result).toBe("feat: foo");
  });

  // Regression: bare description with taskId still works
  it("does not modify bare descriptions", () => {
    const result = composeConventionalTitle({
      type: "feat",
      title: "foo",
      taskId: "mt#1265",
    });
    expect(result).toBe(EXPECTED_MT1265_FEAT_FOO);
  });

  // Rejection without scope in prefix
  it("rejects 'feat: description' prefix and names the auto-prefix in the error", () => {
    let caught: unknown;
    try {
      composeConventionalTitle({ type: "feat", title: "feat: implement", taskId: "md#413" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toContain("feat(md#413):");
  });
});
