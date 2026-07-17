/**
 * Tests for the credential-scrub counted-signal log (mt#2763).
 *
 * Uses injected fakes for `appendLog`/`resolveLogPath`/`now` — no real
 * filesystem access, matching this codebase's dependency-injection test
 * pattern (see e.g. `.claude/hooks/transcript-ingest-on-session-end.ts`'s
 * `IngestDeps`).
 */

import { describe, test, expect } from "bun:test";

import {
  recordCredentialScrub,
  resolveCredentialScrubLogPath,
  CREDENTIAL_SCRUB_LOG_FILENAME,
  type CredentialScrubLogDeps,
} from "./credential-scrub-log";
import type { RedactionHit } from "./credential-scrubber";

function makeFakeDeps(): CredentialScrubLogDeps & { lines: string[]; paths: string[] } {
  const lines: string[] = [];
  const paths: string[] = [];
  return {
    lines,
    paths,
    appendLog: (logPath: string, line: string) => {
      paths.push(logPath);
      lines.push(line);
    },
    resolveLogPath: () => "/fake/state/credential-scrub-log.jsonl",
    now: () => new Date("2026-07-16T12:00:00.000Z"),
  };
}

describe("credential-scrub-log", () => {
  describe("recordCredentialScrub", () => {
    test("no-ops and writes nothing when there are zero redactions", () => {
      const deps = makeFakeDeps();
      const result = recordCredentialScrub("session-1", [], deps);
      expect(result).toBeNull();
      expect(deps.lines).toHaveLength(0);
    });

    test("appends one JSON line with the total count and per-shape breakdown", () => {
      const AWS_SHAPE = "aws-access-key-id";
      const deps = makeFakeDeps();
      const hits: RedactionHit[] = [
        { shape: AWS_SHAPE, prefix8: "AKIAABCD" },
        { shape: AWS_SHAPE, prefix8: "AKIAWXYZ" },
        { shape: "pulumi-token", prefix8: "pul-a1b2" },
      ];

      const result = recordCredentialScrub("session-42", hits, deps);
      const expectedByShape = { [AWS_SHAPE]: 2, "pulumi-token": 1 };

      expect(result).not.toBeNull();
      expect(result?.agentSessionId).toBe("session-42");
      expect(result?.redactionCount).toBe(3);
      expect(result?.byShape).toEqual(expectedByShape);
      expect(result?.timestamp).toBe("2026-07-16T12:00:00.000Z");

      expect(deps.lines).toHaveLength(1);
      const parsed = JSON.parse(deps.lines[0] ?? "{}");
      expect(parsed.agentSessionId).toBe("session-42");
      expect(parsed.redactionCount).toBe(3);
      expect(parsed.byShape).toEqual(expectedByShape);
    });

    test("appended line is newline-terminated for JSONL append-only semantics", () => {
      const deps = makeFakeDeps();
      recordCredentialScrub("session-1", [{ shape: "jwt", prefix8: "eyJhbGci" }], deps);
      expect(deps.lines[0]?.endsWith("\n")).toBe(true);
    });

    test("swallows an appendLog throw rather than propagating it", () => {
      const deps: CredentialScrubLogDeps = {
        appendLog: () => {
          throw new Error("disk full");
        },
        resolveLogPath: () => "/fake/path.jsonl",
        now: () => new Date(),
      };
      expect(() =>
        recordCredentialScrub("session-1", [{ shape: "jwt", prefix8: "x" }], deps)
      ).not.toThrow();
    });
  });

  describe("resolveCredentialScrubLogPath", () => {
    test("honors MINSKY_STATE_DIR when set", () => {
      const path = resolveCredentialScrubLogPath({ MINSKY_STATE_DIR: "/custom/state" });
      expect(path).toBe(`/custom/state/${CREDENTIAL_SCRUB_LOG_FILENAME}`);
    });

    test("falls back to the default state dir when MINSKY_STATE_DIR is unset", () => {
      const path = resolveCredentialScrubLogPath({});
      expect(path.endsWith(`/.local/state/minsky/${CREDENTIAL_SCRUB_LOG_FILENAME}`)).toBe(true);
    });

    test("falls back when MINSKY_STATE_DIR is set but blank", () => {
      const path = resolveCredentialScrubLogPath({ MINSKY_STATE_DIR: "   " });
      expect(path.endsWith(`/.local/state/minsky/${CREDENTIAL_SCRUB_LOG_FILENAME}`)).toBe(true);
    });
  });
});
