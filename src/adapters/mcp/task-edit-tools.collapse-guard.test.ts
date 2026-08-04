/**
 * mt#3674 — the `tasks_spec_patch` collapse guard.
 *
 * The DECISION (is this delta suspicious?) is pinned in
 * `packages/domain/src/ai/edit-pattern-utils.test.ts`, shared with
 * `session_edit_file`. These tests pin the SPEC-SURFACE refusal: that it fires, that
 * `allowShrink` overrides it, and that the message carries what an operator needs to
 * recover — the two line counts and the actionable cause.
 *
 * Why the detector is injected rather than module-mocked: the handler resolves its
 * domain imports dynamically (mt#1792 lazy-import), so patching the module would test
 * the mock. Injecting keeps this a pure decision over strings.
 */
import { describe, test, expect } from "bun:test";
import { assertNoSuspiciousSpecCollapse } from "./task-edit-tools";
import { detectSuspiciousCollapse } from "@minsky/domain/ai/edit-pattern-utils";

const makeLines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

describe("assertNoSuspiciousSpecCollapse", () => {
  test("refuses the mt#3339 shape: a long spec collapsed to a single token", () => {
    // The originating incident, verbatim in shape: a ~380-line spec whose merge result
    // was the 7-character string `mt#3672`.
    expect(() =>
      assertNoSuspiciousSpecCollapse(
        "mt#3339",
        makeLines(380),
        "mt#3672",
        false,
        detectSuspiciousCollapse
      )
    ).toThrow(/Refusing to patch task mt#3339/);
  });

  test("the refusal names both line counts, the drop, and the override", () => {
    // An operator reading this must be able to tell a collapse from an ordinary failure
    // WITHOUT re-reading the source — and must not be sent to `tasks_edit`, which is the
    // destructive path.
    let message = "";
    try {
      assertNoSuspiciousSpecCollapse(
        "mt#3339",
        makeLines(380),
        "mt#3672",
        false,
        detectSuspiciousCollapse
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("380");
    expect(message).toContain("1 lines");
    expect(message).toContain("100% drop");
    expect(message).toContain("allowShrink=true");
    expect(message).toContain("no version history");
  });

  test("allowShrink=true permits an intentional large deletion", () => {
    expect(() =>
      assertNoSuspiciousSpecCollapse(
        "mt#3339",
        makeLines(380),
        "mt#3672",
        true,
        detectSuspiciousCollapse
      )
    ).not.toThrow();
  });

  test("an ordinary append-a-section patch is untouched", () => {
    const original = makeLines(200);
    const grown = `${original}\n${makeLines(40)}`;
    expect(() =>
      assertNoSuspiciousSpecCollapse("mt#1", original, grown, false, detectSuspiciousCollapse)
    ).not.toThrow();
  });

  test("an ordinary small correction is untouched", () => {
    const original = makeLines(200);
    const corrected = makeLines(198);
    expect(() =>
      assertNoSuspiciousSpecCollapse("mt#1", original, corrected, false, detectSuspiciousCollapse)
    ).not.toThrow();
  });

  test("a short spec is below the floor and never refused", () => {
    // Deliberate: a ratio on a tiny document is noise. The guard trades this coverage gap
    // for not blocking legitimate edits to short specs.
    expect(() =>
      assertNoSuspiciousSpecCollapse("mt#1", makeLines(20), "x", false, detectSuspiciousCollapse)
    ).not.toThrow();
  });
});
