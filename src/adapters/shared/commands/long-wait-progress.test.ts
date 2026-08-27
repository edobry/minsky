/**
 * Census: every long-waiting shared command must emit MCP transport progress.
 *
 * ## Why a census rather than two unit tests (mt#1576)
 *
 * The transport underneath the MCP shim applies an IDLE timeout, so a command
 * that holds a request open while emitting nothing is killed at roughly three
 * minutes regardless of the `timeoutSeconds` it was given. `context.onProgress`
 * (mt#2677) defeats it, because a progress notification is transport activity.
 *
 * mt#1576 accumulated 9+ occurrences of this over three months. The defect is
 * not the interesting part; the GENERATOR is. Nothing connected "declares a long
 * wait" to "must emit progress", so each new long-waiting command silently
 * reacquired it and the fix was applied per-command, after the fact, twice.
 * Fixing only `deployment.wait-for-latest` and `asks.wait-for-response` would
 * have left that generator running. This is the fix for the generator.
 *
 * The scan itself lives in `command-source-scan.ts` alongside the two other
 * shared-command source scans — that module's own docblock records what
 * duplicating a scan across test files cost the last time (a pattern fixed in
 * one copy and left broken in the other, blind to 23 commands).
 */
import { describe, test, expect } from "bun:test";
import {
  scanLongWaitCommands,
  scanSilentLongWaitCommands,
  stripComments,
} from "../../../utils/test-utils/command-source-scan";

/**
 * Files that name `timeoutSeconds` but do no waiting of their own. Each needs a
 * reason — an unexplained exemption is how a census stops measuring anything.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    "session/session-parameters.ts",
    "Shared parameter DEFINITIONS with no execute handler. It declares the " +
      "timeoutSeconds schema the waiting commands import; it does no waiting itself.",
  ],
]);

describe("mt#1576 — long-waiting commands emit MCP transport progress", () => {
  test("the census is looking at a real population", () => {
    // Guards against the scan silently matching nothing, which would make every
    // assertion below pass for the wrong reason.
    const found = scanLongWaitCommands();
    expect(found).toContain("deployment.ts");
    expect(found).toContain("asks.ts");
    expect(found).toContain("session/pr-checks-command.ts");
    expect(found).toContain("session/pr-wait-for-review-command.ts");
  });

  test("every long-wait command threads onProgress, or is exempt with a reason", () => {
    const unexplained = scanSilentLongWaitCommands().filter((f) => !EXEMPT.has(f));
    expect(unexplained).toEqual([]);
  });

  test("each exemption carries a non-empty reason", () => {
    for (const [file, reason] of EXEMPT) {
      expect(reason.length, `exemption for ${file} needs a reason`).toBeGreaterThan(0);
    }
  });

  test("a comment mentioning onProgress does NOT count as wiring", () => {
    // The exact shape that fooled a plain grep twice while implementing this.
    const docblockOnly = `
      /**
       * This command emits no progress notifications. context.onProgress?.()
       * exists so a long-running command produces transport activity.
       */
      const params = { timeoutSeconds: 600 };
    `;
    expect(stripComments(docblockOnly)).not.toContain("onProgress");

    const lineCommentOnly = `const x = 1; // onProgress is not wired here`;
    expect(stripComments(lineCommentOnly)).not.toContain("onProgress");

    // ...and real wiring survives the strip.
    const wired = `execute: async (p, ctx) => wait(p, { onProgress: ctx?.onProgress })`;
    expect(stripComments(wired)).toContain("onProgress");
  });

  test("stripComments leaves a URL's double slash alone", () => {
    // `https://` must not read as a line comment, or stripping would eat the
    // rest of any line carrying a URL and could hide real wiring after it.
    const withUrl = `const doc = "https://example.com/x"; const w = { onProgress };`;
    expect(stripComments(withUrl)).toContain("onProgress");
  });
});
