/**
 * Tests for the chained-verification-commands detector (mt#3910).
 *
 * The load-bearing property is NOT "does it fire" — it is the narrowness of the trigger. A
 * detector that fired on `echo '=== tests ==='; bun test …` would be wrong on the single most
 * common shape in real transcripts, and per mem#719 that noise erodes trust in its true
 * positives. So the no-fire cases carry as much weight here as the fire case.
 */

import { describe, expect, test } from "bun:test";

import {
  isVerificationCommand,
  leadingCommandOf,
  scanCommand,
  splitTopLevel,
} from "./chained-verification-commands-detector";

describe("splitTopLevel", () => {
  test("splits on ;, && and ||", () => {
    expect(splitTopLevel("a; b && c || d")).toEqual(["a", "b", "c", "d"]);
  });

  test("does not split on a separator inside quotes", () => {
    // Without quote handling this yields a phantom segment and can manufacture a false fire.
    expect(splitTopLevel("echo 'a; b'; bun test")).toEqual(["echo 'a; b'", "bun test"]);
    expect(splitTopLevel('echo "x && y"; bun test')).toEqual(['echo "x && y"', "bun test"]);
  });

  test("drops empty segments from trailing or doubled separators", () => {
    expect(splitTopLevel("bun test;")).toEqual(["bun test"]);
    expect(splitTopLevel("a;; b")).toEqual(["a", "b"]);
  });

  test("keeps a single command intact", () => {
    expect(splitTopLevel("bun test --preload ./tests/setup.ts")).toEqual([
      "bun test --preload ./tests/setup.ts",
    ]);
  });
});

describe("leadingCommandOf", () => {
  test("takes the first stage of a pipeline — that is the command being verified", () => {
    expect(leadingCommandOf("bun test path/ 2>&1 | tail -6")).toBe("bun test path/ 2>&1");
  });

  test("strips env-var prefixes", () => {
    expect(leadingCommandOf("MINSKY_X=1 bun test")).toBe("bun test");
    expect(leadingCommandOf("A=1 B=2 bun run lint")).toBe("bun run lint");
  });
});

describe("isVerificationCommand", () => {
  test("recognizes the verification commands whose pass/fail is the point", () => {
    expect(isVerificationCommand("bun test path/")).toBe(true);
    expect(isVerificationCommand("bun run lint")).toBe(true);
    expect(isVerificationCommand("bun run format:all")).toBe(true);
    expect(isVerificationCommand("bun run typecheck")).toBe(true);
    expect(isVerificationCommand("bunx eslint .")).toBe(true);
  });

  test("does not treat exploratory or labelling commands as verification", () => {
    expect(isVerificationCommand("echo '=== tests ==='")).toBe(false);
    expect(isVerificationCommand("grep -n foo a.ts")).toBe(false);
    expect(isVerificationCommand("cd sub")).toBe(false);
    expect(isVerificationCommand("ls -la")).toBe(false);
  });

  test("sees through a pipeline, which is how these are usually written", () => {
    expect(isVerificationCommand("bun test path/ 2>&1 | tail -6")).toBe(true);
  });
});

describe("scanCommand — the trigger", () => {
  // AT1: two chained verification commands fire.
  test("AT1: fires on two chained verification commands", () => {
    const result = scanCommand("bun run format:all; bun test path/");
    expect(result.chained).toBe(true);
    expect(result.verificationSegments).toHaveLength(2);
  });

  test("AT1: fires on the exact command from mt#3910's originating incident", () => {
    const result = scanCommand(
      "bun run format:all 2>&1 | tail -4; echo '=== tests ==='; bun test --preload ./tests/setup.ts | tail -6"
    );
    expect(result.chained).toBe(true);
    // The interposed `echo` must not prevent the fire — it is not a verification command, so the
    // two that remain are still chained.
    expect(result.verificationSegments).toHaveLength(2);
  });

  // AT2: a single verification command with echo labels does NOT fire.
  test("AT2: does not fire on one verification command wrapped in echo labels", () => {
    const result = scanCommand("echo '=== tests ==='; bun test path/");
    expect(result.chained).toBe(false);
    expect(result.verificationSegments).toEqual(["bun test path/"]);
  });

  // AT3: chained non-verification commands do NOT fire.
  test("AT3: does not fire on chained exploratory commands", () => {
    expect(scanCommand("grep -n foo a.ts; grep -n bar b.ts").chained).toBe(false);
    expect(scanCommand("ls; pwd; git status --short").chained).toBe(false);
  });

  // AT4: a cd prefix does NOT fire.
  test("AT4: does not fire on a cd prefix before one verification command", () => {
    expect(scanCommand("cd sub && bun test").chained).toBe(false);
  });

  test("does not fire on a single verification command alone", () => {
    expect(scanCommand("bun test --preload ./tests/setup.ts packages/").chained).toBe(false);
  });

  test("fires on three, and reports all of them", () => {
    const result = scanCommand("bun run lint && bun run typecheck && bun test");
    expect(result.chained).toBe(true);
    expect(result.verificationSegments).toHaveLength(3);
  });

  // PR #2765 R1 (BLOCKING): a build is a PREREQUISITE, not an independent check. `build && test`
  // expresses ordering, not two verdicts to disambiguate — firing there flags a correct idiom.
  test("does not fire on a build-then-test dependency sequence", () => {
    expect(scanCommand("bun run build && bun test").chained).toBe(false);
    expect(scanCommand("bun run build; bun run typecheck").chained).toBe(false);
  });

  test("still fires on two genuine checks that merely include a build-adjacent name", () => {
    // Guards the fix against over-correction: removing `build` must not silence real pairs.
    expect(scanCommand("bun run typecheck && bun test").chained).toBe(true);
  });

  // PR #2765 R1 (NON-BLOCKING): the pipeline split was not quote-aware, so a `|` inside quotes
  // truncated the segment. Same defect class the separator split already handled.
  test("a quoted pipe does not truncate the classified command", () => {
    const quotedPipe = "bun test --filter 'a|b'";
    expect(leadingCommandOf(quotedPipe)).toBe(quotedPipe);
    // The quoted `|` is text; the UNQUOTED one is a real pipeline boundary.
    expect(leadingCommandOf(`${quotedPipe} | tail -3`)).toBe(quotedPipe);
  });

  test("a quoted separator cannot manufacture a fire", () => {
    // One real verification command; the `;` inside the quotes is text, not a separator.
    expect(scanCommand("echo 'run bun test; then bun run lint'; bun test").chained).toBe(false);
  });
});
