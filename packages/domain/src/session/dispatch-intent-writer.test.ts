/**
 * Dispatch-Intent Writer unit tests (mt#2865)
 *
 * PR #2033 R1 NON-BLOCKING #5: rewritten against the module's now-unified
 * injectable `DispatchIntentWriterFsDeps` (+ `DispatchIntentWriterLockDeps`)
 * shapes — in-memory fakes throughout, per `custom/no-real-fs-in-tests`,
 * mirroring `.minsky/hooks/dispatch-intent-store.test.ts`'s fake-fs/
 * fake-lock pattern exactly. A prior version of this suite used real
 * temp-directory filesystem operations because the module had no
 * injectable seam at all; that gap is what NON-BLOCKING #5 closed.
 */

import { describe, test, expect } from "bun:test";
import path from "path";
import {
  getDispatchIntentStorePath,
  appendDispatchIntentDeclaration,
  declareReadOnlyIntent,
  sanitizeReason,
  withDispatchIntentWriterLock,
  DEFAULT_DISPATCH_INTENT_TTL_MS,
  MAX_REASON_LENGTH,
  type DispatchIntentDeclaration,
  type DispatchIntentWriterFsDeps,
  type DispatchIntentWriterLockDeps,
} from "./dispatch-intent-writer";

const NOW = Date.parse("2026-07-17T20:00:00.000Z");
/** Shared env-var-name fixture — satisfies custom/no-magic-string-duplication. */
const STATE_DIR_ENV_VAR = "MINSKY_STATE_DIR";
const MOCK_STORE_PATH = "/mock/state/minsky/dispatch-intents.json";

/** In-memory fake fs — mirrors dispatch-intent-store.test.ts's makeFakeFs exactly. */
function makeFakeFs(initialFiles: Record<string, string> = {}): DispatchIntentWriterFsDeps & {
  files: Record<string, string>;
} {
  const files: Record<string, string> = { ...initialFiles };
  return {
    files,
    readFileSync: (p: string): string => {
      if (!(p in files)) {
        const err = new Error(`ENOENT: no such file, ${p}`) as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      return files[p] as string;
    },
    writeFileSync: (p: string, content: string): void => {
      files[p] = content;
    },
    mkdirSync: (): void => {
      // In-memory store has no real directory tree to create.
    },
  };
}

/** Always-available in-memory lock — mirrors dispatch-intent-store.test.ts's passthroughLock exactly. */
const passthroughLock: DispatchIntentWriterLockDeps = {
  tryExclusiveCreate: () => true,
  unlinkSync: () => {},
  lockAgeMs: () => null,
  sleepMs: () => {},
};

function readStore(fakeFs: { files: Record<string, string> }): {
  declarations: DispatchIntentDeclaration[];
} {
  return JSON.parse(fakeFs.files[getDispatchIntentStorePath()] as string);
}

describe("getDispatchIntentStorePath", () => {
  test("honors MINSKY_STATE_DIR override", () => {
    const original = process.env[STATE_DIR_ENV_VAR];
    process.env[STATE_DIR_ENV_VAR] = "/tmp/mock-state";
    try {
      expect(getDispatchIntentStorePath()).toBe(
        path.join("/tmp/mock-state", "dispatch-intents.json")
      );
    } finally {
      if (original === undefined) delete process.env[STATE_DIR_ENV_VAR];
      else process.env[STATE_DIR_ENV_VAR] = original;
    }
  });
});

describe("appendDispatchIntentDeclaration", () => {
  test("creates the store file with the new declaration when none exists", () => {
    const fakeFs = makeFakeFs();
    const declaration: DispatchIntentDeclaration = {
      sessionId: "session-abc",
      intent: "read-only",
      issuedAt: new Date(NOW).toISOString(),
      ttlMs: 30 * 60 * 1000,
      reason: "bounded lookup",
    };
    appendDispatchIntentDeclaration(declaration, NOW, fakeFs, passthroughLock);
    const written = readStore(fakeFs);
    expect(written.declarations).toHaveLength(1);
    expect(written.declarations[0]?.sessionId).toBe("session-abc");
    expect(written.declarations[0]?.intent).toBe("read-only");
  });

  test("appends to an existing store, preserving unexpired prior entries", () => {
    const fakeFs = makeFakeFs();
    appendDispatchIntentDeclaration(
      {
        sessionId: "session-1",
        intent: "read-only",
        issuedAt: new Date(NOW).toISOString(),
        ttlMs: 30 * 60 * 1000,
      },
      NOW,
      fakeFs,
      passthroughLock
    );
    appendDispatchIntentDeclaration(
      {
        sessionId: "session-2",
        intent: "implementation",
        issuedAt: new Date(NOW).toISOString(),
        ttlMs: 30 * 60 * 1000,
      },
      NOW,
      fakeFs,
      passthroughLock
    );
    const written = readStore(fakeFs);
    expect(written.declarations).toHaveLength(2);
    expect(written.declarations.map((d) => d.sessionId).sort()).toEqual(["session-1", "session-2"]);
  });

  test("prunes already-expired declarations when appending", () => {
    const fakeFs = makeFakeFs();
    appendDispatchIntentDeclaration(
      {
        sessionId: "old-session",
        intent: "read-only",
        issuedAt: new Date(NOW - 1000 * 60 * 60 * 24).toISOString(), // 24h before NOW
        ttlMs: 60 * 1000, // 1-minute TTL — long expired by NOW
      },
      NOW - 1000 * 60 * 60 * 24,
      fakeFs,
      passthroughLock
    );
    appendDispatchIntentDeclaration(
      {
        sessionId: "new-session",
        intent: "read-only",
        issuedAt: new Date(NOW).toISOString(),
        ttlMs: 30 * 60 * 1000,
      },
      NOW,
      fakeFs,
      passthroughLock
    );
    const written = readStore(fakeFs);
    expect(written.declarations).toHaveLength(1);
    expect(written.declarations[0]?.sessionId).toBe("new-session");
  });

  test("sanitizes reason at write time — strips newlines and caps length regardless of caller input", () => {
    const fakeFs = makeFakeFs();
    const longReason = `line one\nline two\r\nline three ${"x".repeat(400)}`;
    appendDispatchIntentDeclaration(
      {
        sessionId: "session-abc",
        intent: "read-only",
        issuedAt: new Date(NOW).toISOString(),
        ttlMs: 30 * 60 * 1000,
        reason: longReason,
      },
      NOW,
      fakeFs,
      passthroughLock
    );
    const written = readStore(fakeFs);
    const persisted = written.declarations[0]?.reason ?? "";
    expect(persisted).not.toContain("\n");
    expect(persisted).not.toContain("\r");
    expect(persisted.length).toBeLessThanOrEqual(MAX_REASON_LENGTH);
  });
});

describe("sanitizeReason", () => {
  test("returns undefined for undefined/empty/whitespace-only input", () => {
    expect(sanitizeReason(undefined)).toBeUndefined();
    expect(sanitizeReason("")).toBeUndefined();
    expect(sanitizeReason("   \n  ")).toBeUndefined();
  });

  test("strips embedded newlines, collapsing to a single space", () => {
    expect(sanitizeReason("line one\nline two\r\nline three")).toBe("line one line two line three");
  });

  test("caps length at MAX_REASON_LENGTH", () => {
    expect(sanitizeReason("x".repeat(MAX_REASON_LENGTH + 100))).toHaveLength(MAX_REASON_LENGTH);
  });
});

describe("declareReadOnlyIntent", () => {
  test("writes a read-only declaration with the default TTL when none is supplied", () => {
    const fakeFs = makeFakeFs();
    const ok = declareReadOnlyIntent("session-xyz", {
      nowMs: NOW,
      fsDeps: fakeFs,
      lockDeps: passthroughLock,
    });
    expect(ok).toBe(true);
    const written = readStore(fakeFs);
    expect(written.declarations).toHaveLength(1);
    expect(written.declarations[0]?.sessionId).toBe("session-xyz");
    expect(written.declarations[0]?.intent).toBe("read-only");
    expect(written.declarations[0]?.ttlMs).toBe(DEFAULT_DISPATCH_INTENT_TTL_MS);
  });

  test("honors an explicit ttlMs/issuedBy/reason override", () => {
    const fakeFs = makeFakeFs();
    declareReadOnlyIntent("session-xyz", {
      nowMs: NOW,
      ttlMs: 5 * 60 * 1000,
      issuedBy: "tasks.dispatch:mt#2865",
      reason: "custom reason text",
      fsDeps: fakeFs,
      lockDeps: passthroughLock,
    });
    const written = readStore(fakeFs);
    expect(written.declarations[0]?.ttlMs).toBe(5 * 60 * 1000);
    expect(written.declarations[0]?.issuedBy).toBe("tasks.dispatch:mt#2865");
    expect(written.declarations[0]?.reason).toBe("custom reason text");
  });

  test("returns false (never throws) when the fs write fails", () => {
    const throwingFs: DispatchIntentWriterFsDeps = {
      readFileSync: () => {
        const err = new Error("ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      },
      writeFileSync: () => {
        throw new Error("EROFS: read-only file system");
      },
      mkdirSync: () => {},
    };
    const ok = declareReadOnlyIntent("session-xyz", {
      nowMs: NOW,
      fsDeps: throwingFs,
      lockDeps: passthroughLock,
    });
    expect(ok).toBe(false);
  });

  test("returns false (never throws) when the lock cannot be acquired", () => {
    const fakeFs = makeFakeFs();
    const alwaysHeldLock: DispatchIntentWriterLockDeps = {
      tryExclusiveCreate: () => false,
      unlinkSync: () => {},
      lockAgeMs: () => 0, // fresh, non-stale — never reclaimed
      sleepMs: () => {},
    };
    const ok = declareReadOnlyIntent("session-xyz", {
      nowMs: NOW,
      fsDeps: fakeFs,
      lockDeps: alwaysHeldLock,
    });
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// withDispatchIntentWriterLock (PR #2033 R1 NON-BLOCKING #6 — mirrors
// ask-grant-store.ts's / dispatch-intent-store.ts's lock test blocks)
// ---------------------------------------------------------------------------

describe("withDispatchIntentWriterLock", () => {
  function makeLock(initiallyHeld = false): {
    deps: DispatchIntentWriterLockDeps;
    state: { held: boolean };
  } {
    const state = { held: initiallyHeld };
    return {
      state,
      deps: {
        tryExclusiveCreate: () => {
          if (state.held) return false;
          state.held = true;
          return true;
        },
        unlinkSync: () => {
          state.held = false;
        },
        lockAgeMs: () => (state.held ? 0 : null),
        sleepMs: () => {},
      },
    };
  }

  test("runs the critical section holding the lock and releases it after", () => {
    const { deps, state } = makeLock();
    let heldDuring = false;
    const result = withDispatchIntentWriterLock(
      MOCK_STORE_PATH,
      () => {
        heldDuring = state.held;
        return 42;
      },
      deps
    );
    expect(result).toBe(42);
    expect(heldDuring).toBe(true);
    expect(state.held).toBe(false);
  });

  test("releases the lock even when the critical section throws", () => {
    const { deps, state } = makeLock();
    expect(() =>
      withDispatchIntentWriterLock(
        MOCK_STORE_PATH,
        () => {
          throw new Error("boom");
        },
        deps
      )
    ).toThrow("boom");
    expect(state.held).toBe(false);
  });

  test("a fresh (non-stale) held lock exhausts retries and throws", () => {
    const { deps } = makeLock(true);
    expect(() => withDispatchIntentWriterLock(MOCK_STORE_PATH, () => 1, deps)).toThrow(
      /could not acquire/
    );
  });

  test("a stale lock is reclaimed", () => {
    const state = { held: true };
    const deps: DispatchIntentWriterLockDeps = {
      tryExclusiveCreate: () => {
        if (state.held) return false;
        state.held = true;
        return true;
      },
      unlinkSync: () => {
        state.held = false;
      },
      lockAgeMs: () => (state.held ? 60_000 : null),
      sleepMs: () => {},
    };
    expect(withDispatchIntentWriterLock(MOCK_STORE_PATH, () => "ran", deps)).toBe("ran");
    expect(state.held).toBe(false);
  });
});
