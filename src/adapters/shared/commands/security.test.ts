/**
 * Unit tests for the security.check-credentials command's PURE helpers
 * (mt#4022) — classification, exit-code mapping, and input resolution.
 *
 * Deliberately does NOT exercise `execute()` directly: on the CLI interface
 * it calls `process.exit()`, which would kill the test runner. The real
 * end-to-end exit-code + no-leaked-text behavior is covered by
 * `security.check-credentials.cli.test.ts`, which spawns the actual CLI as
 * a subprocess — the correct boundary for testing process-exit behavior.
 *
 * All credential values below are SYNTHETIC — never a real credential.
 */

/* eslint-disable custom/no-real-fs-in-tests -- resolveInputText's --file path is a thin wrapper
   around readTextFile (fs.readFile); the "prefers --file" and cleanup below verify the real
   file-priority + read integration, which a mocked fs would not exercise. */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  classifyCredentialCheck,
  computeCredentialCheckOutcome,
  exitCodeForOutcome,
  resolveInputText,
  EXIT_CLEAN,
  EXIT_HIT,
  EXIT_ERROR,
} from "./security";

const FAKE_UNMASKED_PG_URL = "postgresql://fakeuser:fakepassword@db.example.invalid:5432/mydb";
const POSTGRES_URL_SHAPE = "postgres-url-credentials";

describe("classifyCredentialCheck (mt#4022)", () => {
  test("clean text -> status clean", () => {
    expect(classifyCredentialCheck("nothing to see here")).toEqual({ status: "clean" });
  });

  test("AT1: unmasked credential -> status hit, shape names only", () => {
    const outcome = classifyCredentialCheck(FAKE_UNMASKED_PG_URL);
    expect(outcome).toEqual({ status: "hit", matchedShapes: [POSTGRES_URL_SHAPE] });
  });

  test("AT2 (mem#972): masked db:migrate-shaped output -> status clean", () => {
    const outcome = classifyCredentialCheck(
      "Connecting to postgresql://***:***@db.internal.example:5432/minsky"
    );
    expect(outcome).toEqual({ status: "clean" });
  });

  test("AT3 (mem#808): both postgres:// and postgresql:// unmasked -> status hit", () => {
    expect(
      classifyCredentialCheck("postgres://fakeuser:fakepassword@db.example.invalid:5432/mydb")
    ).toEqual({ status: "hit", matchedShapes: [POSTGRES_URL_SHAPE] });
    expect(classifyCredentialCheck(FAKE_UNMASKED_PG_URL)).toEqual({
      status: "hit",
      matchedShapes: [POSTGRES_URL_SHAPE],
    });
  });
});

describe("exitCodeForOutcome (mt#4022 criterion 3)", () => {
  test("clean -> 0, hit -> 1, error -> 2 — all three mutually distinct", () => {
    expect(exitCodeForOutcome({ status: "clean" })).toBe(EXIT_CLEAN);
    expect(exitCodeForOutcome({ status: "hit", matchedShapes: ["x"] })).toBe(EXIT_HIT);
    expect(exitCodeForOutcome({ status: "error", reason: "x" })).toBe(EXIT_ERROR);
    expect(new Set([EXIT_CLEAN, EXIT_HIT, EXIT_ERROR]).size).toBe(3);
  });
});

describe("resolveInputText (mt#4022)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test("prefers --file over --text when both given", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "mt4022-test-"));
    const filePath = join(tmpDir, "input.txt");
    writeFileSync(filePath, "from-file");
    const text = await resolveInputText({ file: filePath, text: "from-text" });
    expect(text).toBe("from-file");
  });

  test("uses --text when no file given", async () => {
    const text = await resolveInputText({ text: "direct-text" });
    expect(text).toBe("direct-text");
  });

  // AT4: simulate an internal failure via an unreadable (nonexistent) file.
  test("AT4: unreadable file throws — the internal-failure path", async () => {
    await expect(
      resolveInputText({ file: "/nonexistent/path/does-not-exist.txt" })
    ).rejects.toBeTruthy();
  });
});

describe("computeCredentialCheckOutcome (mt#4022)", () => {
  test("AT1 end-to-end via --text: unmasked credential -> hit", async () => {
    const outcome = await computeCredentialCheckOutcome({ text: FAKE_UNMASKED_PG_URL });
    expect(outcome).toEqual({ status: "hit", matchedShapes: [POSTGRES_URL_SHAPE] });
  });

  // AT4 end-to-end: unreadable input -> status error, distinguishable from
  // both clean and hit — never a silent pass.
  test("AT4 end-to-end: unreadable file -> status error (not clean, not hit)", async () => {
    const outcome = await computeCredentialCheckOutcome({
      file: "/nonexistent/path/does-not-exist.txt",
    });
    expect(outcome.status).toBe("error");
    if (outcome.status === "error") {
      // The reason string must never echo the underlying error's message —
      // see the module doc's "Never prints matched text, on any path".
      expect(outcome.reason).toBe("input file could not be read");
    }
  });
});
