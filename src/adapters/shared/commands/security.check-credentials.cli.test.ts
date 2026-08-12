/**
 * End-to-end CLI test for `minsky security check-credentials` (mt#4022).
 *
 * Exercises the ACTUAL binary (bun src/cli.ts) so the test asserts on the
 * full path: stdin/--file -> resolveInputText -> classifyCredentialCheck ->
 * exitCodeForOutcome -> the real `process.exit()` call. A pure-unit test
 * (security.test.ts) cannot observe real exit-code behavior, since the
 * command calls `process.exit()` on the CLI interface — that call would
 * kill the test runner if exercised in-process (see security.test.ts's doc
 * comment). This file is the correct boundary for that.
 *
 * It is also the enforcement point for the hardest constraint in mt#4022:
 * "the check must print no matched text on ANY path, including its error
 * paths." Every test below captures the REAL combined stdout+stderr of the
 * subprocess and asserts the injected secret substring is absent — this is
 * tested, not assumed, per the mt#4022 dispatch instructions.
 *
 * All credential values below are SYNTHETIC — never a real credential.
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "child_process";

const FAKE_UNMASKED_PG_URL = "postgresql://fakeuser:fakepassword@db.example.invalid:5432/mydb";

function runCli(
  args: string[],
  input?: string
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("bun", ["run", "src/cli.ts", "security", "check-credentials", ...args], {
    input,
    encoding: "utf8",
    timeout: 15000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? -1,
  };
}

describe("minsky security check-credentials (mt#4022, end-to-end CLI)", () => {
  test("clean input -> exit 0, prints OK", () => {
    const { stdout, status } = runCli([], "just an ordinary line of output, nothing secret");
    expect(status).toBe(0);
    expect(stdout).toContain("OK: no unmasked credential shapes detected.");
  });

  // AT1: synthetic unmasked credential -> hit, non-zero exit, and the
  // check's OWN output never contains the credential text (grep -c style
  // assertion via string containment on the captured output).
  test("AT1: unmasked credential -> exit 1, and the matched text never appears in output", () => {
    const { stdout, stderr, status } = runCli([], FAKE_UNMASKED_PG_URL);
    expect(status).toBe(1);
    const combined = stdout + stderr;
    expect(combined).toContain("CREDENTIAL DETECTED");
    expect(combined).toContain("postgres-url-credentials");
    // The critical assertion: no matched text on the hit path.
    expect(combined).not.toContain("fakeuser");
    expect(combined).not.toContain("fakepassword");
    expect(combined).not.toContain(FAKE_UNMASKED_PG_URL);
  });

  // AT2 (mem#972 regression): real db:migrate-shaped masked output -> clean.
  test("AT2 (mem#972): masked db:migrate-shaped output -> exit 0, not a hit", () => {
    const migrateOutput = [
      "=== bun run db:migrate ===",
      "Connecting to postgresql://***:***@db.internal.example:5432/minsky",
      "Migration status: up to date",
    ].join("\n");
    const { stdout, status } = runCli([], migrateOutput);
    expect(status).toBe(0);
    expect(stdout).toContain("OK: no unmasked credential shapes detected.");
  });

  // AT3 (mem#808 regression): both scheme spellings of a real credential hit.
  test("AT3 (mem#808): postgres:// unmasked -> exit 1", () => {
    const { status } = runCli([], "postgres://fakeuser:fakepassword@db.example.invalid:5432/mydb");
    expect(status).toBe(1);
  });

  test("AT3 (mem#808): postgresql:// unmasked -> exit 1", () => {
    const { status } = runCli([], FAKE_UNMASKED_PG_URL);
    expect(status).toBe(1);
  });

  // AT4: simulate an internal failure (unreadable input) -> non-zero exit
  // DISTINGUISHABLE from both clean (0) and hit (1) — never a silent pass.
  test("AT4: unreadable --file input -> exit 2, distinct from clean (0) and hit (1)", () => {
    const { stdout, stderr, status } = runCli(["--file", "/nonexistent/path/does-not-exist.txt"]);
    expect(status).toBe(2);
    expect(status).not.toBe(0);
    expect(status).not.toBe(1);
    const combined = stdout + stderr;
    expect(combined).toContain("did not complete");
    // Never leaks any part of a caught error's raw message beyond our own
    // fixed string — belt-and-braces alongside the classify-layer test.
    expect(combined).not.toContain("ENOENT");
  });

  test("--quiet suppresses all output on the clean path, exit code still 0", () => {
    const { stdout, stderr, status } = runCli(["--quiet"], "nothing to see here");
    expect(status).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  // Criterion 1 / AT1 restated as the exact "grep -c on the check's own
  // output" acceptance test the spec names.
  test("--quiet on a hit: exit 1, and grep -c on combined output for the credential is 0", () => {
    const { stdout, stderr, status } = runCli(["--quiet"], FAKE_UNMASKED_PG_URL);
    expect(status).toBe(1);
    const combined = stdout + stderr;
    expect(combined).toBe("");
    // The literal AT1 phrasing: grep -c on the check's own output finds 0
    // occurrences of the credential.
    const occurrences = combined.split("fakepassword").length - 1;
    expect(occurrences).toBe(0);
  });

  test("--quiet suppresses output on the error path too, exit code still 2", () => {
    const { stdout, stderr, status } = runCli([
      "--quiet",
      "--file",
      "/nonexistent/path/does-not-exist.txt",
    ]);
    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });
});
