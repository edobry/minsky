// Tests for the branch-freshness CAS marker (mt#1522).
//
// Marker round-trip and cleanup tests use real fs in a temp dir (the
// established pattern in this project per session-commit-ask-emission.test.ts).
// `checkFreshnessCas` is exercised via the injectable `readMarker` dep + fake
// async git runners — no real fs or git for that suite.

import { describe, expect, test } from "bun:test";
/* eslint-disable custom/no-real-fs-in-tests */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
/* eslint-enable custom/no-real-fs-in-tests */
import { join } from "node:path";
import {
  checkFreshnessCas,
  cleanupFreshnessMarker,
  markerPath,
  readFreshnessMarker,
  writeFreshnessMarker,
  type FreshnessMarkerPayload,
} from "./freshness-marker";

// Shared fixtures
const FIXTURE_MAIN_REF = "origin/main";
const FIXTURE_SHA_A = "a".repeat(40);
const FIXTURE_SHA_B = "b".repeat(40);
const FIXTURE_TOOL = "mcp__minsky__session_commit";
const FIXTURE_TS = "2026-05-06T16:30:00.000Z";

const FIXTURE_PAYLOAD: FreshnessMarkerPayload = {
  mainRef: FIXTURE_MAIN_REF,
  sha: FIXTURE_SHA_A,
  toolName: FIXTURE_TOOL,
  ts: FIXTURE_TS,
};

/* eslint-disable custom/no-real-fs-in-tests */
function makeWorkdirWithGitDir(): string {
  // The marker lives at <workdir>/.git/.minsky-freshness-sha; the fs helpers
  // assume `.git/` exists. Tests create that explicitly.
  const root = mkdtempSync(join(tmpdir(), "minsky-freshness-marker-"));
  mkdirSync(join(root, ".git"));
  return root;
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}
/* eslint-enable custom/no-real-fs-in-tests */

// ---------------------------------------------------------------------------
// markerPath
// ---------------------------------------------------------------------------

describe("markerPath", () => {
  test("derives `.git/.minsky-freshness-sha` under the workdir", () => {
    expect(markerPath("/some/workdir")).toBe("/some/workdir/.git/.minsky-freshness-sha");
  });
});

// ---------------------------------------------------------------------------
// readFreshnessMarker / writeFreshnessMarker / cleanupFreshnessMarker
// (real-fs round-trip in temp dir)
// ---------------------------------------------------------------------------

describe("write + read freshness marker (round-trip)", () => {
  test("writes a payload and reads it back identically", () => {
    const root = makeWorkdirWithGitDir();
    try {
      const writeResult = writeFreshnessMarker(root, FIXTURE_PAYLOAD);
      expect(writeResult.ok).toBe(true);
      expect(writeResult.reason).toBeUndefined();

      const round = readFreshnessMarker(root);
      expect(round).toEqual(FIXTURE_PAYLOAD);
    } finally {
      cleanup(root);
    }
  });

  test("write returns ok=false with reason when target dir does not exist", () => {
    const root = "/does/not/exist/anywhere/in/the/filesystem";
    const result = writeFreshnessMarker(root, FIXTURE_PAYLOAD);
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });

  test("read returns null when the marker file is absent", () => {
    const root = makeWorkdirWithGitDir();
    try {
      expect(readFreshnessMarker(root)).toBeNull();
    } finally {
      cleanup(root);
    }
  });

  test("read returns null when the marker contains malformed JSON", () => {
    const root = makeWorkdirWithGitDir();
    try {
      /* eslint-disable custom/no-real-fs-in-tests */
      writeFileSync(markerPath(root), "{ this is not valid json", "utf8");
      /* eslint-enable custom/no-real-fs-in-tests */
      expect(readFreshnessMarker(root)).toBeNull();
    } finally {
      cleanup(root);
    }
  });

  test("read returns null when JSON is well-formed but missing required fields", () => {
    const root = makeWorkdirWithGitDir();
    try {
      /* eslint-disable custom/no-real-fs-in-tests */
      writeFileSync(
        markerPath(root),
        JSON.stringify({ mainRef: "origin/main" /* missing sha/toolName/ts */ }),
        "utf8"
      );
      /* eslint-enable custom/no-real-fs-in-tests */
      expect(readFreshnessMarker(root)).toBeNull();
    } finally {
      cleanup(root);
    }
  });

  // PR #963 R1 BLOCKING #1 fix: marker validation closes the
  // command-injection hole at the CAS callsite.
  test("read returns null when mainRef contains shell metacharacters (PR #963 R1 BLOCKING)", () => {
    const root = makeWorkdirWithGitDir();
    try {
      /* eslint-disable custom/no-real-fs-in-tests */
      writeFileSync(
        markerPath(root),
        JSON.stringify({
          mainRef: 'origin/main"; rm -rf /',
          sha: FIXTURE_SHA_A,
          toolName: FIXTURE_TOOL,
          ts: FIXTURE_TS,
        }),
        "utf8"
      );
      /* eslint-enable custom/no-real-fs-in-tests */
      expect(readFreshnessMarker(root)).toBeNull();
    } finally {
      cleanup(root);
    }
  });

  test("read returns null when mainRef contains shell-substitution syntax", () => {
    const root = makeWorkdirWithGitDir();
    try {
      /* eslint-disable custom/no-real-fs-in-tests */
      writeFileSync(
        markerPath(root),
        JSON.stringify({
          mainRef: "origin/$(touch pwn)",
          sha: FIXTURE_SHA_A,
          toolName: FIXTURE_TOOL,
          ts: FIXTURE_TS,
        }),
        "utf8"
      );
      /* eslint-enable custom/no-real-fs-in-tests */
      expect(readFreshnessMarker(root)).toBeNull();
    } finally {
      cleanup(root);
    }
  });

  test("read returns null when sha is not 40-hex (e.g., shorter, wrong charset)", () => {
    const root = makeWorkdirWithGitDir();
    try {
      /* eslint-disable custom/no-real-fs-in-tests */
      writeFileSync(
        markerPath(root),
        JSON.stringify({
          mainRef: FIXTURE_MAIN_REF,
          sha: "deadbeef", // too short
          toolName: FIXTURE_TOOL,
          ts: FIXTURE_TS,
        }),
        "utf8"
      );
      /* eslint-enable custom/no-real-fs-in-tests */
      expect(readFreshnessMarker(root)).toBeNull();
    } finally {
      cleanup(root);
    }
  });

  test("read accepts well-formed marker with origin/feature/branch ref", () => {
    const root = makeWorkdirWithGitDir();
    try {
      const validPayload = {
        ...FIXTURE_PAYLOAD,
        mainRef: "origin/feature/some-branch",
      };
      writeFreshnessMarker(root, validPayload);
      expect(readFreshnessMarker(root)).toEqual(validPayload);
    } finally {
      cleanup(root);
    }
  });

  test("cleanup removes the marker file", () => {
    const root = makeWorkdirWithGitDir();
    try {
      writeFreshnessMarker(root, FIXTURE_PAYLOAD);
      // After write, readFreshnessMarker should return the payload.
      expect(readFreshnessMarker(root)).toEqual(FIXTURE_PAYLOAD);
      cleanupFreshnessMarker(root);
      // After cleanup, readFreshnessMarker should return null.
      expect(readFreshnessMarker(root)).toBeNull();
    } finally {
      cleanup(root);
    }
  });

  test("cleanup is silent on missing marker", () => {
    const root = makeWorkdirWithGitDir();
    try {
      // No marker present — cleanup should not throw.
      expect(() => cleanupFreshnessMarker(root)).not.toThrow();
    } finally {
      cleanup(root);
    }
  });
});

// ---------------------------------------------------------------------------
// checkFreshnessCas — exercised via injected `readMarker` + fake git deps
// ---------------------------------------------------------------------------

describe("checkFreshnessCas", () => {
  const FAKE_DIR = "/fake/workdir";

  test("no marker → ok=true with bypass='no-marker'", async () => {
    const result = await checkFreshnessCas(FAKE_DIR, {
      readMarker: () => null,
      fetchOrigin: async () => true,
      resolveRefSha: async () => FIXTURE_SHA_A,
    });
    expect(result.ok).toBe(true);
    expect(result.bypass).toBe("no-marker");
  });

  test("marker present + fetch fails → ok=true with bypass='fetch-failed'", async () => {
    const result = await checkFreshnessCas(FAKE_DIR, {
      readMarker: () => FIXTURE_PAYLOAD,
      fetchOrigin: async () => false,
      resolveRefSha: async () => FIXTURE_SHA_B,
    });
    expect(result.ok).toBe(true);
    expect(result.bypass).toBe("fetch-failed");
    expect(result.capturedSha).toBe(FIXTURE_SHA_A);
  });

  test("marker present + ref unresolvable → ok=true with bypass='ref-unresolvable'", async () => {
    const result = await checkFreshnessCas(FAKE_DIR, {
      readMarker: () => FIXTURE_PAYLOAD,
      fetchOrigin: async () => true,
      resolveRefSha: async () => null,
    });
    expect(result.ok).toBe(true);
    expect(result.bypass).toBe("ref-unresolvable");
    expect(result.capturedSha).toBe(FIXTURE_SHA_A);
  });

  test("marker present + SHAs match → ok=true (no bypass)", async () => {
    const result = await checkFreshnessCas(FAKE_DIR, {
      readMarker: () => FIXTURE_PAYLOAD,
      fetchOrigin: async () => true,
      resolveRefSha: async () => FIXTURE_SHA_A,
    });
    expect(result.ok).toBe(true);
    expect(result.bypass).toBeUndefined();
    expect(result.capturedSha).toBe(FIXTURE_SHA_A);
    expect(result.currentSha).toBe(FIXTURE_SHA_A);
  });

  test("marker present + SHAs differ → ok=false with named SHAs in reason", async () => {
    const result = await checkFreshnessCas(FAKE_DIR, {
      readMarker: () => FIXTURE_PAYLOAD,
      fetchOrigin: async () => true,
      resolveRefSha: async () => FIXTURE_SHA_B,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain(FIXTURE_MAIN_REF);
    expect(result.reason).toContain(FIXTURE_SHA_A);
    expect(result.reason).toContain(FIXTURE_SHA_B);
    expect(result.reason).toContain("Re-run session_commit");
    expect(result.capturedSha).toBe(FIXTURE_SHA_A);
    expect(result.currentSha).toBe(FIXTURE_SHA_B);
  });

  test("acceptance test: hook allows at SHA_A, origin advances to SHA_B → CAS aborts", async () => {
    // Spec acceptance: "Hook allows at origin/main = SHA_A, marker is written.
    // Mock git fetch to advance origin/main = SHA_B. session_commit runs CAS
    // check, finds mismatch, aborts."
    let fetched = false;
    const result = await checkFreshnessCas(FAKE_DIR, {
      readMarker: () => FIXTURE_PAYLOAD, // captured SHA_A at allow time
      fetchOrigin: async () => {
        fetched = true;
        return true;
      },
      resolveRefSha: async () => FIXTURE_SHA_B, // origin advanced
    });
    expect(fetched).toBe(true); // CAS forced fresh fetch
    expect(result.ok).toBe(false); // CAS aborts the push
  });

  test("acceptance test: hook allows at SHA_A, no advance → CAS proceeds", async () => {
    // Spec acceptance: "Hook allows at SHA_A, marker is written. git fetch
    // returns SHA_A (unchanged). session_commit proceeds."
    const result = await checkFreshnessCas(FAKE_DIR, {
      readMarker: () => FIXTURE_PAYLOAD,
      fetchOrigin: async () => true,
      resolveRefSha: async () => FIXTURE_SHA_A,
    });
    expect(result.ok).toBe(true);
    expect(result.bypass).toBeUndefined(); // ran the full check, didn't bypass
  });

  test("acceptance test: MINSKY_SKIP_FRESHNESS=1 → no marker → CAS bypasses", async () => {
    // Spec acceptance: "MINSKY_SKIP_FRESHNESS=1 set: hook doesn't write marker.
    // session_commit doesn't find marker. Proceeds without CAS check."
    let fetched = false;
    const result = await checkFreshnessCas(FAKE_DIR, {
      readMarker: () => null, // hook didn't write
      fetchOrigin: async () => {
        fetched = true;
        return true;
      },
      resolveRefSha: async () => FIXTURE_SHA_B,
    });
    expect(fetched).toBe(false); // bypass short-circuits before fetch
    expect(result.ok).toBe(true);
    expect(result.bypass).toBe("no-marker");
  });
});
