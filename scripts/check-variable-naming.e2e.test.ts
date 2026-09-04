/**
 * End-to-end exit-code tests for the variable-naming gate (PR #3454 R1 BLOCKING).
 *
 * The pre-commit step decides pass/fail purely from this script's EXIT CODE:
 * `runVariableNamingCheck` (`src/hooks/pre-commit.ts`) awaits `execAsync`, which
 * rejects only on a non-zero exit, and its catch reports the failure.
 *
 * Before PR #3454 `main()` returned without ever calling `process.exit`, so the
 * script exited 0 on every path — the gate was INERT. Verified on `main` with
 * four reported violations present: `execAsync` RESOLVED and the hook reported a
 * pass. That is the defect these tests exist to keep fixed, and it is invisible
 * to unit tests of the predicate, which is why the helper-level suite did not
 * catch it.
 *
 * These spawn the real script against a temp fixture tree, because the exit code
 * is a property of the PROCESS and cannot be asserted any other way.
 */

/* eslint-disable custom/no-real-fs-in-tests */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = join(import.meta.dir, "check-variable-naming.ts");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mt4719-e2e-"));
  mkdirSync(join(dir, "src"), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runChecker(): { exitCode: number; stdout: string } {
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", SCRIPT],
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString() };
}

describe("exit code (the signal the pre-commit hook actually reads)", () => {
  test("exits NON-ZERO when a genuine violation is present", () => {
    writeFileSync(
      join(dir, "src", "bad.ts"),
      ["export const a = (_value: string) => {", "  return value.length;", "};", ""].join("\n")
    );

    const { exitCode, stdout } = runChecker();
    expect(stdout).toContain("Total issues:");
    expect(exitCode).not.toBe(0);
  });

  test("exits ZERO when the tree is clean", () => {
    writeFileSync(
      join(dir, "src", "good.ts"),
      "export const a = (value: string) => value.length;\n"
    );

    const { exitCode, stdout } = runChecker();
    expect(stdout).toContain("No variable naming issues found");
    expect(exitCode).toBe(0);
  });

  test("exits ZERO for the false-positive shapes that took main red", () => {
    // All three are non-references; none may produce a non-zero exit.
    writeFileSync(
      join(dir, "src", "shapes.ts"),
      [
        'export const c = (_type?: string) => ({ type: "depends" });',
        "export const d = (_text: string) => {",
        "  // Defaults to a text that EXTENDS what streamed, which is the",
        "  return 1;",
        "};",
        "export const e = (flag: boolean) =>",
        "  flag",
        '    ? async (_provider: string) => "x"',
        "    : async (provider: string) => ({ provider });",
        "",
      ].join("\n")
    );

    const { exitCode, stdout } = runChecker();
    expect(stdout).toContain("No variable naming issues found");
    expect(exitCode).toBe(0);
  });
});
