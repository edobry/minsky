import { describe, test, expect } from "bun:test";
import {
  parseAskGrantStoreContent,
  readAskGrantStore,
  appendAskGrant,
  consumeAskGrant,
  findValidAskGrant,
  isAskGrantValid,
  isOverbroadPattern,
  withAskGrantStoreLock,
  type AskGrant,
  type AskGrantStoreFsDeps,
  type AskGrantLockDeps,
} from "./ask-grant-store";

const NOW = Date.parse("2026-07-17T10:00:00.000Z");

const TOKEN_PATTERN = "--token abc123def456";

const grant = (overrides: Partial<AskGrant> = {}): AskGrant => ({
  askId: "38b1c0de-1234-4abc-8def-000000000001",
  tool: "Bash",
  commandPattern: "^minsky tasks bulk-edit .* --execute --token abc123def456$",
  issuedAt: new Date(NOW - 60_000).toISOString(),
  ttlMs: 15 * 60 * 1000,
  reason: "approved via ask 38b1c0de",
  ...overrides,
});

/** In-memory fs fake (per custom/no-real-fs-in-tests). */
function makeFs(initial: Record<string, string> = {}): {
  deps: AskGrantStoreFsDeps;
  files: Record<string, string>;
} {
  const files = { ...initial };
  return {
    files,
    deps: {
      readFileSync: (p) => {
        if (!(p in files)) {
          const err = new Error("ENOENT") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return files[p] as string;
      },
      writeFileSync: (p, content) => {
        files[p] = content;
      },
      mkdirSync: () => {},
    },
  };
}

/** Always-available in-memory lock (per custom/no-real-fs-in-tests). */
const passthroughLock: AskGrantLockDeps = {
  tryExclusiveCreate: () => true,
  unlinkSync: () => {},
  lockAgeMs: () => null,
  sleepMs: () => {},
};

describe("isOverbroadPattern", () => {
  test("refuses wildcard-only and short patterns", () => {
    expect(isOverbroadPattern(".*")).toBe(true);
    expect(isOverbroadPattern("^.*$")).toBe(true);
    expect(isOverbroadPattern("^rm .*$")).toBe(true);
  });

  test("accepts a concrete command pattern", () => {
    expect(isOverbroadPattern("^minsky tasks bulk-edit mt#1 --execute$")).toBe(false);
  });
});

describe("parse + read", () => {
  test("round-trips a valid store and skips malformed entries", () => {
    const good = grant();
    const raw = JSON.stringify({ grants: [good, { junk: true }, 42] });
    expect(parseAskGrantStoreContent(raw)).toEqual([good]);
  });

  test("top-level malformed JSON is a read error, absent file is empty-ok", () => {
    const { deps } = makeFs({ "/store.json": "not json" });
    expect(readAskGrantStore("/store.json", deps).status).toBe("error");
    expect(readAskGrantStore("/absent.json", deps)).toEqual({ status: "ok", grants: [] });
  });
});

describe("matching", () => {
  const ctx = {
    tool: "Bash",
    command: "minsky tasks bulk-edit mt#1,mt#2 --execute --token abc123def456",
  };

  test("matches an unconsumed, unexpired grant whose pattern matches", () => {
    const g = grant({ commandPattern: TOKEN_PATTERN });
    expect(isAskGrantValid(g, ctx, NOW)).toBe(true);
  });

  test("consumed grants never match", () => {
    const g = grant({
      commandPattern: TOKEN_PATTERN,
      consumedAt: new Date(NOW - 1000).toISOString(),
    });
    expect(isAskGrantValid(g, ctx, NOW)).toBe(false);
  });

  test("expired grants never match", () => {
    const g = grant({
      commandPattern: TOKEN_PATTERN,
      issuedAt: new Date(NOW - 16 * 60 * 1000).toISOString(),
    });
    expect(isAskGrantValid(g, ctx, NOW)).toBe(false);
  });

  test("tool mismatch never matches", () => {
    const g = grant({ commandPattern: TOKEN_PATTERN });
    expect(isAskGrantValid(g, { ...ctx, tool: "mcp__minsky__session_exec" }, NOW)).toBe(false);
  });

  test("a non-compiling pattern never matches", () => {
    const g = grant({ commandPattern: "([" });
    expect(isAskGrantValid(g, ctx, NOW)).toBe(false);
  });

  test("a non-matching command never matches", () => {
    const g = grant({ commandPattern: "--token DIFFERENT" });
    expect(findValidAskGrant([g], ctx, NOW)).toBeNull();
  });
});

describe("append + consume", () => {
  test("append prunes expired grants and keeps consumed unexpired ones (audit trace)", () => {
    const { deps, files } = makeFs();
    const expired = grant({ issuedAt: new Date(NOW - 60 * 60 * 1000).toISOString() });
    appendAskGrant("/store.json", expired, deps, NOW - 50 * 60 * 1000, passthroughLock);

    const consumed = grant({
      askId: "38b1c0de-1234-4abc-8def-000000000002",
      consumedAt: new Date(NOW - 1000).toISOString(),
    });
    appendAskGrant("/store.json", consumed, deps, NOW, passthroughLock);

    const parsed = parseAskGrantStoreContent(files["/store.json"] as string);
    expect(parsed?.map((g) => g.askId)).toEqual(["38b1c0de-1234-4abc-8def-000000000002"]);
  });

  test("consume marks exactly one matching unconsumed grant; second consume returns false", () => {
    const { deps } = makeFs();
    const g = grant();
    appendAskGrant("/store.json", g, deps, NOW, passthroughLock);

    expect(consumeAskGrant("/store.json", g, deps, NOW, passthroughLock)).toBe(true);
    const after = readAskGrantStore("/store.json", deps);
    expect(after.status).toBe("ok");
    if (after.status === "ok") {
      expect(after.grants[0]?.consumedAt).toBeDefined();
    }
    expect(consumeAskGrant("/store.json", g, deps, NOW, passthroughLock)).toBe(false);
  });
});

describe("store lock (PR #2015 R1 — one-shot under concurrency)", () => {
  function makeLock(initiallyHeld = false): { deps: AskGrantLockDeps; state: { held: boolean } } {
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
    const result = withAskGrantStoreLock(
      "/store.json",
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
      withAskGrantStoreLock(
        "/store.json",
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
    expect(() => withAskGrantStoreLock("/store.json", () => 1, deps)).toThrow(/could not acquire/);
  });

  test("a stale lock is reclaimed", () => {
    const state = { held: true };
    const deps: AskGrantLockDeps = {
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
    expect(withAskGrantStoreLock("/store.json", () => "ran", deps)).toBe("ran");
    expect(state.held).toBe(false);
  });

  test("consumeAskGrant returns false (defers) when the lock cannot be acquired", () => {
    const { deps: fsDeps } = makeFs();
    const g = grant();
    appendAskGrant("/store.json", g, fsDeps, NOW, passthroughLock);
    const { deps: lockDeps } = makeLock(true);
    expect(consumeAskGrant("/store.json", g, fsDeps, NOW, lockDeps)).toBe(false);
  });
});
