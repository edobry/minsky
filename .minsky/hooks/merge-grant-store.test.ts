import { describe, expect, it, afterEach } from "bun:test";
import {
  normalizeTaskId,
  parseGrantStoreContent,
  readGrantStore,
  isGrantValid,
  findValidGrant,
  appendGrant,
  getStateDir,
  getMergeGrantStorePath,
  type MergeGrant,
  type GrantStoreFsDeps,
} from "./merge-grant-store";

const NOW = Date.parse("2026-07-07T20:00:00.000Z");
const MOCK_STORE_PATH = "/mock/state/minsky/merge-grants.json";
const STATE_DIR_ENV_VAR = "MINSKY_STATE_DIR";

function makeGrant(overrides: Partial<MergeGrant> = {}): MergeGrant {
  return {
    taskId: "mt#2651",
    agentScope: "any",
    issuedAt: new Date(NOW).toISOString(),
    ttlMs: 30 * 60 * 1000,
    ...overrides,
  };
}

/**
 * In-memory fake fs — per the `custom/no-real-fs-in-tests` ESLint rule,
 * tests must not touch the real filesystem (no `fs.*`, no `os.tmpdir()`).
 * This fake is a plain object-backed map satisfying `GrantStoreFsDeps`.
 */
function makeFakeFs(initialFiles: Record<string, string> = {}): GrantStoreFsDeps & {
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

// ---------------------------------------------------------------------------
// normalizeTaskId
// ---------------------------------------------------------------------------

describe("normalizeTaskId", () => {
  it("normalizes mt#2651 / MT#2651 / mt2651 / whitespace to the same value", () => {
    expect(normalizeTaskId("mt#2651")).toBe("mt2651");
    expect(normalizeTaskId("MT#2651")).toBe("mt2651");
    expect(normalizeTaskId("mt2651")).toBe("mt2651");
    expect(normalizeTaskId("  mt#2651  ")).toBe("mt2651");
  });
});

// ---------------------------------------------------------------------------
// parseGrantStoreContent
// ---------------------------------------------------------------------------

describe("parseGrantStoreContent", () => {
  it("parses a valid single-grant store", () => {
    const raw = JSON.stringify({ grants: [makeGrant()] });
    const grants = parseGrantStoreContent(raw);
    expect(grants).not.toBeNull();
    expect(grants).toHaveLength(1);
    expect(grants?.[0]?.taskId).toBe("mt#2651");
  });

  it("returns an empty array for an empty grants list", () => {
    expect(parseGrantStoreContent(JSON.stringify({ grants: [] }))).toEqual([]);
  });

  it("returns null on malformed JSON", () => {
    expect(parseGrantStoreContent("{not json")).toBeNull();
  });

  it("returns null when the top-level shape has no grants array", () => {
    expect(parseGrantStoreContent(JSON.stringify({ notGrants: [] }))).toBeNull();
    expect(parseGrantStoreContent(JSON.stringify({}))).toBeNull();
    expect(parseGrantStoreContent(JSON.stringify([]))).toBeNull();
  });

  it("filters out malformed individual grant entries but keeps valid ones", () => {
    const raw = JSON.stringify({
      grants: [
        makeGrant(),
        { taskId: "mt#9999" }, // missing issuedAt/ttlMs -> invalid
        null,
        "not-an-object",
      ],
    });
    const grants = parseGrantStoreContent(raw);
    expect(grants).toHaveLength(1);
    expect(grants?.[0]?.taskId).toBe("mt#2651");
  });

  it("defaults agentScope to 'any' when omitted", () => {
    const raw = JSON.stringify({
      grants: [{ taskId: "mt#1", issuedAt: new Date(NOW).toISOString(), ttlMs: 1000 }],
    });
    const grants = parseGrantStoreContent(raw);
    expect(grants?.[0]?.agentScope).toBe("any");
  });

  it("rejects a grant with non-positive ttlMs", () => {
    const raw = JSON.stringify({
      grants: [{ taskId: "mt#1", issuedAt: new Date(NOW).toISOString(), ttlMs: 0 }],
    });
    expect(parseGrantStoreContent(raw)).toEqual([]);
  });

  it("rejects a grant with an unparseable issuedAt", () => {
    const raw = JSON.stringify({
      grants: [{ taskId: "mt#1", issuedAt: "not-a-date", ttlMs: 1000 }],
    });
    expect(parseGrantStoreContent(raw)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// isGrantValid / findValidGrant
// ---------------------------------------------------------------------------

describe("isGrantValid", () => {
  it("valid: matching taskId, any agentScope, not expired", () => {
    const grant = makeGrant();
    expect(isGrantValid(grant, { taskId: "mt#2651", agentId: "agent-123" }, NOW)).toBe(true);
  });

  it("valid: taskId matches after normalization (case/hash differences)", () => {
    const grant = makeGrant({ taskId: "MT#2651" });
    expect(isGrantValid(grant, { taskId: "mt2651", agentId: "agent-123" }, NOW)).toBe(true);
  });

  it("invalid: expired grant (now >= issuedAt + ttlMs)", () => {
    const grant = makeGrant({ ttlMs: 60_000 });
    const later = NOW + 61_000;
    expect(isGrantValid(grant, { taskId: "mt#2651", agentId: "agent-123" }, later)).toBe(false);
  });

  it("valid: exactly at the TTL boundary is still expired (>=, not >)", () => {
    const grant = makeGrant({ ttlMs: 60_000 });
    const atBoundary = NOW + 60_000;
    expect(isGrantValid(grant, { taskId: "mt#2651", agentId: "agent-123" }, atBoundary)).toBe(
      false
    );
  });

  it("invalid: mismatched taskId", () => {
    const grant = makeGrant({ taskId: "mt#1111" });
    expect(isGrantValid(grant, { taskId: "mt#2651", agentId: "agent-123" }, NOW)).toBe(false);
  });

  it("invalid: unresolvable ctx.taskId (null) never matches", () => {
    const grant = makeGrant();
    expect(isGrantValid(grant, { taskId: null, agentId: "agent-123" }, NOW)).toBe(false);
  });

  it("invalid: agentScope restricted to a different specific agent_id", () => {
    const grant = makeGrant({ agentScope: "agent-999" });
    expect(isGrantValid(grant, { taskId: "mt#2651", agentId: "agent-123" }, NOW)).toBe(false);
  });

  it("valid: agentScope restricted to the matching specific agent_id", () => {
    const grant = makeGrant({ agentScope: "agent-123" });
    expect(isGrantValid(grant, { taskId: "mt#2651", agentId: "agent-123" }, NOW)).toBe(true);
  });

  it("invalid: unparseable issuedAt on the grant object never matches", () => {
    const grant = makeGrant({ issuedAt: "not-a-date" });
    expect(isGrantValid(grant, { taskId: "mt#2651", agentId: "agent-123" }, NOW)).toBe(false);
  });
});

describe("findValidGrant", () => {
  it("returns the first matching valid grant among several", () => {
    const grants = [
      makeGrant({ taskId: "mt#1111" }),
      makeGrant({ taskId: "mt#2651" }),
      makeGrant({ taskId: "mt#3333" }),
    ];
    const found = findValidGrant(grants, { taskId: "mt#2651", agentId: "a" }, NOW);
    expect(found?.taskId).toBe("mt#2651");
  });

  it("returns null when no grant matches", () => {
    const grants = [makeGrant({ taskId: "mt#1111" })];
    expect(findValidGrant(grants, { taskId: "mt#2651", agentId: "a" }, NOW)).toBeNull();
  });

  it("returns null for an empty grants array", () => {
    expect(findValidGrant([], { taskId: "mt#2651", agentId: "a" }, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readGrantStore / appendGrant (in-memory fake fs — no real fs/os touched)
// ---------------------------------------------------------------------------

describe("readGrantStore + appendGrant (in-memory fake fs)", () => {
  it("readGrantStore on a nonexistent path returns ok with an empty array (confirmed zero grants)", () => {
    const fakeFs = makeFakeFs();
    const result = readGrantStore(MOCK_STORE_PATH, fakeFs);
    expect(result).toEqual({ status: "ok", grants: [] });
  });

  it("readGrantStore on malformed content returns an error (fail-open signal)", () => {
    const fakeFs = makeFakeFs({ [MOCK_STORE_PATH]: "{not valid json" });
    const result = readGrantStore(MOCK_STORE_PATH, fakeFs);
    expect(result.status).toBe("error");
  });

  it("appendGrant writes a fresh store when none exists, then readGrantStore finds it", () => {
    const fakeFs = makeFakeFs();
    const grant = makeGrant();
    appendGrant(MOCK_STORE_PATH, grant, fakeFs);

    const result = readGrantStore(MOCK_STORE_PATH, fakeFs);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.grants).toHaveLength(1);
      expect(result.grants[0]?.taskId).toBe("mt#2651");
    }
  });

  it("appendGrant prunes already-expired grants while keeping unexpired ones", () => {
    const expired = makeGrant({
      taskId: "mt#1111",
      issuedAt: new Date(NOW - 10 * 60 * 1000).toISOString(),
      ttlMs: 60 * 1000, // expired long before "now" (real Date.now())
    });
    const fakeFs = makeFakeFs({ [MOCK_STORE_PATH]: JSON.stringify({ grants: [expired] }) });

    // appendGrant uses Date.now() internally for pruning, so we can't force
    // "NOW" — instead assert the real-world-fresh grant survives and the
    // clearly-long-expired one (relative to the real current time) is pruned.
    const freshGrant = makeGrant({ taskId: "mt#2651", issuedAt: new Date().toISOString() });
    appendGrant(MOCK_STORE_PATH, freshGrant, fakeFs);

    const result = readGrantStore(MOCK_STORE_PATH, fakeFs);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const taskIds = result.grants.map((g) => g.taskId);
      expect(taskIds).toContain("mt#2651");
      expect(taskIds).not.toContain("mt#1111");
    }
  });

  it("appendGrant starts fresh (rather than failing) when the existing store is malformed", () => {
    const fakeFs = makeFakeFs({ [MOCK_STORE_PATH]: "{not valid json" });
    appendGrant(MOCK_STORE_PATH, makeGrant(), fakeFs);

    const result = readGrantStore(MOCK_STORE_PATH, fakeFs);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.grants).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// getStateDir / getMergeGrantStorePath (env override behavior)
// ---------------------------------------------------------------------------

describe("getStateDir + getMergeGrantStorePath", () => {
  const originalStateDir = process.env[STATE_DIR_ENV_VAR];

  afterEach(() => {
    if (originalStateDir === undefined) {
      delete process.env[STATE_DIR_ENV_VAR];
    } else {
      process.env[STATE_DIR_ENV_VAR] = originalStateDir;
    }
  });

  it("honors the state-dir override env var", () => {
    process.env[STATE_DIR_ENV_VAR] = "/mock/custom-state-dir";
    expect(getStateDir()).toBe("/mock/custom-state-dir");
    expect(getMergeGrantStorePath()).toBe("/mock/custom-state-dir/merge-grants.json");
  });
});
