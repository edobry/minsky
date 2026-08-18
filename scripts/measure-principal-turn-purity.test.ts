/**
 * Tests for scripts/measure-principal-turn-purity.ts (mt#4264).
 *
 * Three reviewer findings on PR #3100, fixed here:
 *  1. Default `--files` (25) now matches the sample size behind the published 99.0% figure in
 *     `docs/rules-rationale/principal-context.md`.
 *  2. `--files` is validated, and a zero-sample run fails loudly (non-zero exit) instead of
 *     printing the same SKIP text as a legitimately absent transcript store.
 *  3. `INJECTED_MARKERS` carries a pinning test so an accidental edit produces a red test
 *     rather than a silently higher (falsely clean) purity number.
 *
 * Plus PR #3110 review 4966109841 R1 (BLOCKING): `--files`/`--dir` present but given NO value
 * (trailing, or immediately followed by another flag) fell through to the "flag omitted"
 * default instead of failing — the same silent-wrong-answer shape finding 2 exists to close,
 * surviving inside finding 2's own fix. `readFlag`/`parseArgs` now distinguish "absent" from
 * "present without a value" and fail loudly on the latter, for both flags.
 *
 * The CLI-level tests spawn the real script as a subprocess (mirrors
 * scripts/rationalization-review.test.ts's identical rationale) because `process.exit()`
 * cannot be observed in-process without killing the test runner.
 *
 * @see mt#4264 — this task
 * @see mt#4248 — the script's origin; its PR body records the first run's 0.0%-contamination
 *      false-clean result that motivates finding 2's "fail loudly, not quietly" requirement.
 */

/* eslint-disable custom/no-real-fs-in-tests -- the CLI-level tests below spawn the real script
   as a subprocess against a real scratch directory (mirrors
   scripts/rationalization-review.test.ts's identical rationale): the exit code and stderr text
   on invalid input, an empty transcript store, and an absent transcript store are the actual
   behavior under test — mocking the filesystem would test the mock, not the script. */

import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  INJECTED_MARKERS,
  InvalidDirArgError,
  InvalidFilesArgError,
  markersIn,
  parseArgs,
  parseFilesArg,
} from "./measure-principal-turn-purity";

const SCRIPT_PATH = join(import.meta.dir, "measure-principal-turn-purity.ts");

/** One pinned marker, reused across tests below instead of repeating the literal (avoids
 * `custom/no-magic-string-duplication`) — the pinning test above is the single source of truth
 * for the full set. */
const SAMPLE_MARKER = "<system-reminder>";

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runScript(args: string[]): Promise<RunResult> {
  const proc = Bun.spawn([process.execPath, SCRIPT_PATH, ...args], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

/** A `user`-role transcript line carrying plain typed prose (no marker, under the size ceiling). */
function typedLine(text: string): string {
  return JSON.stringify({ message: { role: "user", content: [{ type: "text", text }] } });
}

/** A `user`-role transcript line carrying an injected marker. */
function injectedLine(marker: string): string {
  return JSON.stringify({
    message: { role: "user", content: [{ type: "text", text: `${marker} filler content` }] },
  });
}

describe("INJECTED_MARKERS pinning (mt#4264 finding 3)", () => {
  // Negative-control verified by hand during authoring (per the task's ask): temporarily
  // renaming one entry in the source list (e.g. "<system-reminder>" -> "<system-reminde>")
  // makes this assertion fail. It is intentionally NOT re-mutated on every run — that would
  // defeat the guard rather than demonstrate it.
  test("the marker set is exactly what the script currently recognizes", () => {
    expect(INJECTED_MARKERS).toEqual([
      "minsky:prompt:v1",
      "minsky:dispatch:v1",
      "<system-reminder>",
      "<command-message>",
      "<command-name>",
      "<local-command-stdout>",
      "Base directory for this skill:",
    ]);
  });
});

describe("markersIn", () => {
  test("recognizes each pinned marker", () => {
    for (const marker of INJECTED_MARKERS) {
      expect(markersIn(`prefix ${marker} suffix`)).toContain(marker);
    }
  });

  test("plain typed prose matches no marker", () => {
    expect(markersIn("just some ordinary typed text with no injected markers")).toEqual([]);
  });

  test("a marker that is not present is not reported", () => {
    expect(markersIn(`${SAMPLE_MARKER} present, but not this one`)).toEqual([SAMPLE_MARKER]);
  });
});

describe("parseFilesArg (mt#4264 finding 1 + finding 2)", () => {
  test("undefined (flag omitted) returns the default", () => {
    // Finding 1: the default now matches the sample size behind the published 99.0% figure —
    // see docs/rules-rationale/principal-context.md ("over the 25 most-recently-modified
    // transcripts") and the re-verification run recorded in this task's PR body.
    expect(parseFilesArg(undefined)).toBe(25);
  });

  test("a valid positive integer passes through unchanged", () => {
    expect(parseFilesArg("10")).toBe(10);
  });

  test.each(["notanumber", "0", "-5", "", "NaN", "3.5", "Infinity", "-0.5"])(
    "rejects %p and names the offending value",
    (bad) => {
      expect(() => parseFilesArg(bad)).toThrow(InvalidFilesArgError);
      expect(() => parseFilesArg(bad)).toThrow(bad === "" ? /got: ""/ : bad);
    }
  );
});

describe("parseArgs — flag present but given no value (PR #3110 review R1, BLOCKING)", () => {
  test("--files as the trailing argument throws InvalidFilesArgError, not the default", () => {
    expect(() => parseArgs(["--files"])).toThrow(InvalidFilesArgError);
  });

  test("--files immediately followed by another flag throws, not the default", () => {
    expect(() => parseArgs(["--files", "--dir", "/x"])).toThrow(InvalidFilesArgError);
  });

  test("--dir as the trailing argument throws InvalidDirArgError, not SKIP", () => {
    expect(() => parseArgs(["--dir"])).toThrow(InvalidDirArgError);
  });

  test("--dir immediately followed by another flag throws, not SKIP", () => {
    expect(() => parseArgs(["--dir", "--files", "10"])).toThrow(InvalidDirArgError);
  });

  test("a flag that is truly omitted still uses the default — the counter-case", () => {
    expect(parseArgs([]).files).toBe(25);
    expect(parseArgs(["--files", "10"]).dir).toContain(".claude");
  });

  test("a real value for --files still works when --dir follows it", () => {
    expect(parseArgs(["--files", "10", "--dir", "/x"])).toEqual({ dir: "/x", files: 10 });
  });
});

describe("CLI: invalid --files exits non-zero and names the value (mt#4264 finding 2)", () => {
  test.each(["notanumber", "0", "-5"])("--files %s", async (bad) => {
    const result = await runScript(["--files", bad, "--dir", "/nonexistent-does-not-matter"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(bad);
    expect(result.stderr.toUpperCase()).toContain("FAIL");
  });
});

describe("CLI: a flag given with no value exits non-zero (PR #3110 review R1, BLOCKING)", () => {
  test("--files as the trailing argument exits non-zero, not a 25-sample run", async () => {
    const result = await runScript(["--files"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toUpperCase()).toContain("FAIL");
  });

  test("--dir as the trailing argument exits non-zero, not SKIP", async () => {
    const result = await runScript(["--dir"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("SKIP");
    expect(result.stderr.toUpperCase()).toContain("FAIL");
  });
});

describe("CLI: zero-sample runs fail loudly instead of printing SKIP (mt#4264 finding 2)", () => {
  test("an existing but empty --dir exits non-zero, not SKIP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mt4264-empty-"));
    try {
      const result = await runScript(["--dir", dir]);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).not.toContain("SKIP");
      expect(result.stderr).toContain("FAIL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a --dir that does not exist exits 0 with SKIP (unchanged, legitimate case)", async () => {
    const dir = join(tmpdir(), `mt4264-does-not-exist-${Date.now()}`);
    const result = await runScript(["--dir", dir]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("SKIP");
  });
});

describe("CLI: a valid run still succeeds and prints the purity breakdown (counter-case)", () => {
  test("ordinary path is unchanged by the fix", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mt4264-valid-"));
    const projectDir = join(dir, "some-project");
    mkdirSync(projectDir);
    const lines = [
      typedLine("hello, this is some ordinary typed text from the principal"),
      injectedLine(SAMPLE_MARKER),
      injectedLine("minsky:prompt:v1"),
    ];
    writeFileSync(join(projectDir, "transcript.jsonl"), `${lines.join("\n")}\n`);

    try {
      const result = await runScript(["--dir", dir, "--files", "5"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("user-role turns with text: 3");
      expect(result.stdout).toContain("agent/harness-authored turns: 2");
      // Whitespace between the label and the count is a formatting detail, not the behavior
      // under test — match loosely rather than pinning the exact column alignment.
      expect(result.stdout).toMatch(/plausibly typed turns:\s+1\s/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
