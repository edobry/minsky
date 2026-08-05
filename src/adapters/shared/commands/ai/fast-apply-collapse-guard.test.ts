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
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
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
    expect(message).toContain("1 line,");
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

/**
 * PR #2650 R1 (BLOCKING): "no command-level test verifies non-zero exit and file unchanged per
 * spec AT1/AT4." Correct — asserting the DECISION does not demonstrate the file survives.
 *
 * These exercise the ACT half against a REAL file with the REAL `fs.writeFile`, so
 * "byte-for-byte unchanged after a refusal" is observed rather than argued. The exit-code half
 * belongs to the shared-command layer, which maps a thrown error to a non-zero exit; what this
 * code owns is the throw, asserted below.
 */
/* eslint-disable custom/no-real-fs-in-tests -- the point of this suite is a real filesystem
   round-trip: the criterion is about the bytes on disk after a refusal, which an in-memory
   fake cannot evidence. Mirrors the rationale in require-execution-evidence-before-merge.test.ts. */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { writeFile as realWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFastApplyOutcome } from "./completion-commands";

describe("applyFastApplyOutcome — real-file behavior (PR #2650 R1)", () => {
  let dir: string;
  let filePath: string;
  const ORIGINAL = `${makeLines(400)}\n`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mt3741-"));
    filePath = join(dir, "example.ts");
    writeFileSync(filePath, ORIGINAL, "utf-8");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("a refusal throws AND leaves the file byte-for-byte unchanged", async () => {
    const outcome = decideFastApplyOutcome({
      filePath,
      originalContent: ORIGINAL,
      editedContent: "export {};",
      allowShrink: false,
      dryRun: false,
      detect: detectSuspiciousCollapse,
    });

    await expect(
      applyFastApplyOutcome({
        outcome,
        filePath,
        editedContent: "export {};",
        writeFile: realWriteFile,
      })
    ).rejects.toThrow(/Refusing to apply fast-apply result/);

    expect(readFileSync(filePath, "utf-8")).toBe(ORIGINAL);
  });

  test("a dry-run on a collapsed result also leaves the file unchanged", async () => {
    // AT4: dryRun must not launder a collapse into a clean preview. It refuses, and the file
    // is untouched either way — both halves asserted here.
    const outcome = decideFastApplyOutcome({
      filePath,
      originalContent: ORIGINAL,
      editedContent: "export {};",
      allowShrink: false,
      dryRun: true,
      detect: detectSuspiciousCollapse,
    });
    expect(outcome.kind).toBe("refuse");

    await expect(
      applyFastApplyOutcome({
        outcome,
        filePath,
        editedContent: "export {};",
        writeFile: realWriteFile,
      })
    ).rejects.toThrow();

    expect(readFileSync(filePath, "utf-8")).toBe(ORIGINAL);
  });

  test("an ordinary edit is written through to disk", async () => {
    // The positive control: without it, a guard that refused EVERYTHING would pass the two
    // tests above.
    const edited = `${makeLines(398)}\n`;
    const outcome = decideFastApplyOutcome({
      filePath,
      originalContent: ORIGINAL,
      editedContent: edited,
      allowShrink: false,
      dryRun: false,
      detect: detectSuspiciousCollapse,
    });
    expect(outcome.kind).toBe("write");

    await applyFastApplyOutcome({
      outcome,
      filePath,
      editedContent: edited,
      writeFile: realWriteFile,
    });

    expect(readFileSync(filePath, "utf-8")).toBe(edited);
  });

  test("a dry-run on an ordinary edit previews without writing", async () => {
    const edited = `${makeLines(398)}\n`;
    const outcome = decideFastApplyOutcome({
      filePath,
      originalContent: ORIGINAL,
      editedContent: edited,
      allowShrink: false,
      dryRun: true,
      detect: detectSuspiciousCollapse,
    });
    expect(outcome.kind).toBe("preview");

    await applyFastApplyOutcome({
      outcome,
      filePath,
      editedContent: edited,
      writeFile: realWriteFile,
    });

    expect(readFileSync(filePath, "utf-8")).toBe(ORIGINAL);
  });

  test("the refusal message pluralizes a single line correctly", async () => {
    // R1 non-blocking: "1 lines". Shared with the sibling surfaces via formatLineCount.
    const outcome = decideFastApplyOutcome({
      filePath,
      originalContent: ORIGINAL,
      editedContent: "x",
      allowShrink: false,
      dryRun: false,
      detect: detectSuspiciousCollapse,
    });
    const message = outcome.kind === "refuse" ? outcome.message : "";

    expect(message).toContain("400 lines -> 1 line,");
    expect(message).not.toContain("1 lines");
  });
});

/* eslint-enable custom/no-real-fs-in-tests */
