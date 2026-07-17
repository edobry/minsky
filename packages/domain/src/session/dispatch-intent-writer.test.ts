/**
 * Dispatch-Intent Writer unit tests (mt#2865)
 *
 * Uses real filesystem operations against a temp directory (MINSKY_STATE_DIR
 * override) — this tests the writer's actual on-disk write behavior, the
 * same rationale `src/mcp/guard-health-tracker.test.ts` documents for its
 * own real-fs suite (this module has no injectable-fs seam, unlike the
 * `.minsky/hooks/` sibling store, because its only consumer is a
 * best-effort dispatch-time side effect, not a security-critical guard
 * decision path).
 */
/* eslint-disable custom/no-real-fs-in-tests */

import { describe, test, expect, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  getDispatchIntentStorePath,
  appendDispatchIntentDeclaration,
  declareReadOnlyIntent,
  DEFAULT_DISPATCH_INTENT_TTL_MS,
  type DispatchIntentDeclaration,
} from "./dispatch-intent-writer";

const NOW = Date.parse("2026-07-17T20:00:00.000Z");
/** Shared env-var-name fixture — satisfies custom/no-magic-string-duplication. */
const STATE_DIR_ENV_VAR = "MINSKY_STATE_DIR";

function makeTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mt2865-dispatch-intent-writer-test-"));
}

const cleanupDirs: string[] = [];
let originalStateDir: string | undefined;

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  if (originalStateDir === undefined) delete process.env[STATE_DIR_ENV_VAR];
  else process.env[STATE_DIR_ENV_VAR] = originalStateDir;
});

function withTempStateDir(): string {
  originalStateDir = process.env[STATE_DIR_ENV_VAR];
  const dir = makeTempStateDir();
  cleanupDirs.push(dir);
  process.env[STATE_DIR_ENV_VAR] = dir;
  return dir;
}

function readStore(): { declarations: DispatchIntentDeclaration[] } {
  const raw = fs.readFileSync(getDispatchIntentStorePath(), "utf8");
  return JSON.parse(raw);
}

describe("getDispatchIntentStorePath", () => {
  test("honors MINSKY_STATE_DIR override", () => {
    const dir = withTempStateDir();
    expect(getDispatchIntentStorePath()).toBe(path.join(dir, "dispatch-intents.json"));
  });
});

describe("appendDispatchIntentDeclaration", () => {
  test("creates the store file with the new declaration when none exists", () => {
    withTempStateDir();
    const declaration: DispatchIntentDeclaration = {
      sessionId: "session-abc",
      intent: "read-only",
      issuedAt: new Date(NOW).toISOString(),
      ttlMs: 30 * 60 * 1000,
      reason: "bounded lookup",
    };
    appendDispatchIntentDeclaration(declaration, NOW);
    const written = readStore();
    expect(written.declarations).toHaveLength(1);
    expect(written.declarations[0]?.sessionId).toBe("session-abc");
    expect(written.declarations[0]?.intent).toBe("read-only");
  });

  test("appends to an existing store, preserving unexpired prior entries", () => {
    withTempStateDir();
    appendDispatchIntentDeclaration(
      {
        sessionId: "session-1",
        intent: "read-only",
        issuedAt: new Date(NOW).toISOString(),
        ttlMs: 30 * 60 * 1000,
      },
      NOW
    );
    appendDispatchIntentDeclaration(
      {
        sessionId: "session-2",
        intent: "implementation",
        issuedAt: new Date(NOW).toISOString(),
        ttlMs: 30 * 60 * 1000,
      },
      NOW
    );
    const written = readStore();
    expect(written.declarations).toHaveLength(2);
    expect(written.declarations.map((d) => d.sessionId).sort()).toEqual(["session-1", "session-2"]);
  });

  test("prunes already-expired declarations when appending", () => {
    withTempStateDir();
    appendDispatchIntentDeclaration(
      {
        sessionId: "old-session",
        intent: "read-only",
        issuedAt: new Date(NOW - 1000 * 60 * 60 * 24).toISOString(), // 24h before NOW
        ttlMs: 60 * 1000, // 1-minute TTL — long expired by NOW
      },
      NOW - 1000 * 60 * 60 * 24
    );
    appendDispatchIntentDeclaration(
      {
        sessionId: "new-session",
        intent: "read-only",
        issuedAt: new Date(NOW).toISOString(),
        ttlMs: 30 * 60 * 1000,
      },
      NOW
    );
    const written = readStore();
    expect(written.declarations).toHaveLength(1);
    expect(written.declarations[0]?.sessionId).toBe("new-session");
  });
});

describe("declareReadOnlyIntent", () => {
  test("writes a read-only declaration with the default TTL when none is supplied", () => {
    withTempStateDir();
    const ok = declareReadOnlyIntent("session-xyz", { nowMs: NOW });
    expect(ok).toBe(true);
    const written = readStore();
    expect(written.declarations).toHaveLength(1);
    expect(written.declarations[0]?.sessionId).toBe("session-xyz");
    expect(written.declarations[0]?.intent).toBe("read-only");
    expect(written.declarations[0]?.ttlMs).toBe(DEFAULT_DISPATCH_INTENT_TTL_MS);
  });

  test("honors an explicit ttlMs/issuedBy/reason override", () => {
    withTempStateDir();
    declareReadOnlyIntent("session-xyz", {
      nowMs: NOW,
      ttlMs: 5 * 60 * 1000,
      issuedBy: "tasks.dispatch:mt#2865",
      reason: "custom reason text",
    });
    const written = readStore();
    expect(written.declarations[0]?.ttlMs).toBe(5 * 60 * 1000);
    expect(written.declarations[0]?.issuedBy).toBe("tasks.dispatch:mt#2865");
    expect(written.declarations[0]?.reason).toBe("custom reason text");
  });

  test("returns false (never throws) when the state dir is unwritable", () => {
    // Point MINSKY_STATE_DIR at a path that cannot be created (a file, not a
    // directory, in its parent chain) to force a genuine write failure.
    originalStateDir = process.env[STATE_DIR_ENV_VAR];
    const parent = makeTempStateDir();
    cleanupDirs.push(parent);
    const blockingFile = path.join(parent, "blocking-file");
    fs.writeFileSync(blockingFile, "not a directory");
    process.env[STATE_DIR_ENV_VAR] = path.join(blockingFile, "nested", "state");

    const ok = declareReadOnlyIntent("session-xyz", { nowMs: NOW });
    expect(ok).toBe(false);
  });
});
