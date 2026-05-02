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

  // mt#1265 R3 BLOCKING fix: any 2+-letter project prefix is supported, not just mt
  it("strips md#N: prefix (any 2+-letter project code)", () => {
    expect(stripTaskIdPrefix("md#409: foo")).toBe("foo");
  });

  it("strips gh#N: prefix", () => {
    expect(stripTaskIdPrefix("gh#42: foo")).toBe("foo");
  });

  it("strips uppercase variants (case-insensitive)", () => {
    expect(stripTaskIdPrefix("MT#1265: foo")).toBe("foo");
    expect(stripTaskIdPrefix("MD-409: foo")).toBe("foo");
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

  // PR #806 review BLOCKING fix: empty-description after stripping must be rejected
  it("rejects title that is just a task-ID prefix with no description", () => {
    let caught: unknown;
    try {
      composeConventionalTitle({ type: "feat", title: "mt#1265:", taskId: "mt#1265" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toContain("empty");
  });

  it("rejects title that is a task-ID prefix followed only by whitespace", () => {
    let caught: unknown;
    try {
      composeConventionalTitle({ type: "feat", title: "mt#1265:    ", taskId: "mt#1265" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toContain("empty");
  });

  // PR #806 review BLOCKING fix: mismatched task-ID prefix vs supplied taskId
  it("rejects title with mismatched task-ID prefix vs supplied taskId", () => {
    let caught: unknown;
    try {
      composeConventionalTitle({
        type: "feat",
        title: "#1266: foo",
        taskId: "mt#1265",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const msg = (caught as ValidationError).message;
    expect(msg).toContain("1266");
    expect(msg).toContain("mt#1265");
  });

  it("strips matching task-ID prefix even when forms differ (mt-1265 vs mt#1265)", () => {
    // Cross-form match: title uses `mt-1265:` and taskId is `mt#1265`. Digits match → strip silently.
    const result = composeConventionalTitle({
      type: "feat",
      title: "mt-1265: foo",
      taskId: "mt#1265",
    });
    expect(result).toBe(EXPECTED_MT1265_FEAT_FOO);
  });

  // PR #806 R2 BLOCKING fix: preserve user-supplied prefix when no taskId is given
  // (silent stripping in this case erases potentially intentional context)
  it("preserves title prefix when no taskId is supplied (no silent stripping)", () => {
    const result = composeConventionalTitle({
      type: "feat",
      title: "mt#1266: foo",
    });
    expect(result).toBe("feat: mt#1266: foo");
  });

  // PR #806 R2 BLOCKING fix: leading whitespace must not bypass strip + mismatch
  it("strips matching task-ID prefix even with leading whitespace", () => {
    const result = composeConventionalTitle({
      type: "feat",
      title: "  mt#1265: foo",
      taskId: "mt#1265",
    });
    expect(result).toBe(EXPECTED_MT1265_FEAT_FOO);
  });

  it("detects task-ID mismatch even when title has leading whitespace", () => {
    let caught: unknown;
    try {
      composeConventionalTitle({
        type: "feat",
        title: "  #1266: foo",
        taskId: "mt#1265",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const msg = (caught as ValidationError).message;
    expect(msg).toContain("1266");
    expect(msg).toContain("mt#1265");
  });

  // PR #806 review NON-BLOCKING gap: rejection of conventional-prefixed title without taskId
  it("rejects 'feat: description' prefix and names the auto-prefix when taskId is undefined", () => {
    let caught: unknown;
    try {
      composeConventionalTitle({ type: "feat", title: "feat: implement" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toContain("feat:");
  });

  // mt#1265 R3 BLOCKING fix: regex must support all repo task-ID prefix forms,
  // not just mt#. Previously md#409 titles slipped past stripping and produced
  // duplicated prefixes.
  it("strips md#N: prefix from title to avoid duplication (any 2+-letter project code)", () => {
    const result = composeConventionalTitle({
      type: "feat",
      title: "md#409: implement session pr open",
      taskId: "md#409",
    });
    expect(result).toBe("feat(md#409): implement session pr open");
  });

  it("rejects mismatched md# title prefix vs supplied taskId", () => {
    let caught: unknown;
    try {
      composeConventionalTitle({
        type: "feat",
        title: "md#1266: foo",
        taskId: "md#409",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const msg = (caught as ValidationError).message;
    expect(msg).toContain("1266");
    expect(msg).toContain("md#409");
  });

  // mt#1265 R3 NON-BLOCKING: error message should echo the user's original
  // prefix form (e.g. "mt-1265:"), not a normalized "#digits" rendering.
  it("mismatch error echoes the user's original prefix form", () => {
    let caught: unknown;
    try {
      composeConventionalTitle({
        type: "feat",
        title: "mt-9999: foo",
        taskId: "mt#1265",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const msg = (caught as ValidationError).message;
    expect(msg).toContain("mt-9999:");
  });

  // mt#1265 R3 NON-BLOCKING: empty-title error wording adapts to context
  it("empty-title error mentions trimming when no taskId is supplied", () => {
    let caught: unknown;
    try {
      composeConventionalTitle({ type: "feat", title: "   " });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const msg = (caught as ValidationError).message;
    expect(msg).toContain("trimming whitespace");
  });

  // PR #806 R4 BLOCKING fix: cross-project same-digits must reject
  // (the bot caught: "md#409" title vs "mt#409" taskId — different project,
  // same digits — was silently stripping and reassigning the project code).
  it("rejects cross-project same-digits mismatch (md# title vs mt# taskId)", () => {
    let caught: unknown;
    try {
      composeConventionalTitle({
        type: "feat",
        title: "md#409: foo",
        taskId: "mt#409",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const msg = (caught as ValidationError).message;
    expect(msg).toContain("md#409:");
    expect(msg).toContain("mt#409");
  });

  it("permissively matches bare #N: title against any project taskId", () => {
    // Bare "#N:" carries no project hint — match by digits only is intentional.
    const result = composeConventionalTitle({
      type: "feat",
      title: "#1265: foo",
      taskId: "mt#1265",
    });
    expect(result).toBe(EXPECTED_MT1265_FEAT_FOO);
  });

  it("rejects cross-project mismatch even when one side uses hyphen separator", () => {
    let caught: unknown;
    try {
      composeConventionalTitle({
        type: "feat",
        title: "md-409: foo",
        taskId: "mt#409",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toContain("md-409:");
  });
});
