/**
 * mt#3741 — the `ai fast-apply` collapse guard.
 *
 * `executeFastApply` returns a MODEL's output, and this command was the last surface in the
 * repo that persisted such output with no post-condition. It is agent-reachable, not just
 * operator-invoked: ADR-011 auto-bridges the `AI` category to MCP.
 *
 * The DECISION (is this delta suspicious?) is pinned in
 * `packages/domain/src/ai/edit-pattern-utils.test.ts`, shared with the other two surfaces.
 * These pin the FILE-SURFACE refusal and, critically, the ORDERING — that a collapse never
 * yields `write` and never degrades into an ordinary `preview`.
 *
 * The detector is injected rather than module-mocked so this stays a pure decision over
 * strings; same shape as `task-edit-tools.collapse-guard.test.ts`.
 */
import { describe, test, expect } from "bun:test";
import { decideFastApplyOutcome } from "./completion-commands";
import { detectSuspiciousCollapse } from "@minsky/domain/ai/edit-pattern-utils";

const makeLines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");

const COLLAPSED = {
  filePath: "src/example.ts",
  originalContent: makeLines(400),
  editedContent: "export {};",
  detect: detectSuspiciousCollapse,
};

describe("decideFastApplyOutcome — collapse guard (mt#3741)", () => {
  test("a collapse never yields write — this is what leaves the file on disk unchanged", () => {
    // `write` is the handler's only path to fs.writeFile, so proving a collapse cannot reach
    // it proves the file survives.
    const outcome = decideFastApplyOutcome({ ...COLLAPSED, allowShrink: false, dryRun: false });
    expect(outcome.kind).toBe("refuse");
  });

  test("a collapse outranks dryRun — it refuses rather than rendering an ordinary preview", () => {
    const outcome = decideFastApplyOutcome({ ...COLLAPSED, allowShrink: false, dryRun: true });
    expect(outcome.kind).toBe("refuse");
  });

  test("the refusal names the file, both line counts, the drop, and the override", () => {
    const outcome = decideFastApplyOutcome({ ...COLLAPSED, allowShrink: false, dryRun: false });
    const message = outcome.kind === "refuse" ? outcome.message : "";

    expect(message).toContain("src/example.ts");
    expect(message).toContain("400");
    expect(message).toContain("1 lines");
    expect(message).toContain("100% drop");
    expect(message).toContain("allowShrink=true");
  });

  test("allowShrink restores normal precedence: write, or preview under dryRun", () => {
    expect(decideFastApplyOutcome({ ...COLLAPSED, allowShrink: true, dryRun: false }).kind).toBe(
      "write"
    );
    expect(decideFastApplyOutcome({ ...COLLAPSED, allowShrink: true, dryRun: true }).kind).toBe(
      "preview"
    );
  });

  test("an ordinary edit writes, and previews under dryRun", () => {
    const ordinary = {
      filePath: "src/example.ts",
      originalContent: makeLines(200),
      editedContent: makeLines(198),
      detect: detectSuspiciousCollapse,
    };
    expect(decideFastApplyOutcome({ ...ordinary, allowShrink: false, dryRun: false }).kind).toBe(
      "write"
    );
    expect(decideFastApplyOutcome({ ...ordinary, allowShrink: false, dryRun: true }).kind).toBe(
      "preview"
    );
  });

  test("a growing edit is untouched", () => {
    const grown = {
      filePath: "src/example.ts",
      originalContent: makeLines(100),
      editedContent: makeLines(300),
      detect: detectSuspiciousCollapse,
    };
    expect(decideFastApplyOutcome({ ...grown, allowShrink: false, dryRun: false }).kind).toBe(
      "write"
    );
  });

  test("a file below the 40-line floor is never refused", () => {
    // Consistent with the sibling surfaces: a ratio on a tiny file is noise. Stated as a test
    // so the shared floor's effect here is visible rather than inherited silently.
    const tiny = {
      filePath: "src/tiny.ts",
      originalContent: makeLines(20),
      editedContent: "x",
      detect: detectSuspiciousCollapse,
    };
    expect(decideFastApplyOutcome({ ...tiny, allowShrink: false, dryRun: false }).kind).toBe(
      "write"
    );
  });
});
