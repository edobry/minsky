import { describe, expect, it } from "bun:test";
import {
  normalizeScope,
  normalizeGuardName,
  parseGuardGrantStoreContent,
  readGuardGrantStore,
  isGuardGrantValid,
  findValidGuardGrant,
  appendGuardGrant,
  getStateDir,
  getGuardGrantStorePath,
  type GuardGrant,
  type GuardGrantStoreFsDeps,
} from "./guard-grant-store";

const NOW = Date.parse("2026-07-08T20:00:00.000Z");
const MOCK_STORE_PATH = "/mock/state/minsky/guard-grants.json";
const STATE_DIR_ENV_VAR = "MINSKY_STATE_DIR";
/** Shared guard-name fixture — extracted to satisfy custom/no-magic-string-duplication. */
const GUARD_NAME = "duplicate-child-matcher";

function makeGrant(overrides: Partial<GuardGrant> = {}): GuardGrant {
  return {
    guardName: GUARD_NAME,
    scope: "mt#2581",
    issuedAt: new Date(NOW).toISOString(),
    ttlMs: 30 * 60 * 1000,
    reason: "concurrent decomposition — distinct sibling",
    ...overrides,
  };
}

/**
 * In-memory fake fs — per the `custom/no-real-fs-in-tests` ESLint rule,
 * tests must not touch the real filesystem. Mirrors merge-grant-store.test.ts's
 * fake exactly.
 */
function makeFakeFs(initialFiles: Record<string, string> = {}): GuardGrantStoreFsDeps & {
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
// normalizeScope / normalizeGuardName
// ---------------------------------------------------------------------------

describe("normalizeScope", () => {
  it("normalizes mt#2581 / MT#2581 / mt2581 / whitespace to the same value", () => {
    expect(normalizeScope("mt#2581")).toBe("mt2581");
    expect(normalizeScope("MT#2581")).toBe("mt2581");
    expect(normalizeScope("mt2581")).toBe("mt2581");
    expect(normalizeScope("  mt#2581  ")).toBe("mt2581");
  });
});

describe("normalizeGuardName", () => {
  it("lowercases and trims", () => {
    expect(normalizeGuardName("Duplicate-Child-Matcher")).toBe(GUARD_NAME);
    expect(normalizeGuardName("  duplicate-child-matcher  ")).toBe(GUARD_NAME);
  });
});

// ---------------------------------------------------------------------------
// getStateDir / getGuardGrantStorePath
// ---------------------------------------------------------------------------

describe("getStateDir / getGuardGrantStorePath", () => {
  it("honors MINSKY_STATE_DIR override", () => {
    const original = process.env[STATE_DIR_ENV_VAR];
    process.env[STATE_DIR_ENV_VAR] = "/tmp/mock-state";
    try {
      expect(getStateDir()).toBe("/tmp/mock-state");
      expect(getGuardGrantStorePath()).toBe("/tmp/mock-state/guard-grants.json");
    } finally {
      if (original === undefined) delete process.env[STATE_DIR_ENV_VAR];
      else process.env[STATE_DIR_ENV_VAR] = original;
    }
  });
});

// ---------------------------------------------------------------------------
// parseGuardGrantStoreContent
// ---------------------------------------------------------------------------

describe("parseGuardGrantStoreContent", () => {
  it("parses a valid single-grant store", () => {
    const raw = JSON.stringify({ grants: [makeGrant()] });
    const grants = parseGuardGrantStoreContent(raw);
    expect(grants).not.toBeNull();
    expect(grants).toHaveLength(1);
    expect(grants?.[0]?.guardName).toBe(GUARD_NAME);
    expect(grants?.[0]?.reason).toBe("concurrent decomposition — distinct sibling");
  });

  it("returns an empty array for an empty grants list", () => {
    expect(parseGuardGrantStoreContent(JSON.stringify({ grants: [] }))).toEqual([]);
  });

  it("returns null on malformed JSON", () => {
    expect(parseGuardGrantStoreContent("{not json")).toBeNull();
  });

  it("returns null when the top-level shape has no grants array", () => {
    expect(parseGuardGrantStoreContent(JSON.stringify({ notGrants: [] }))).toBeNull();
    expect(parseGuardGrantStoreContent(JSON.stringify({}))).toBeNull();
    expect(parseGuardGrantStoreContent(JSON.stringify([]))).toBeNull();
  });

  it("filters out entries missing a mandatory reason but keeps valid ones", () => {
    const raw = JSON.stringify({
      grants: [
        makeGrant(),
        { ...makeGrant(), reason: undefined },
        { ...makeGrant(), reason: "" },
        { ...makeGrant(), scope: "mt#9999", reason: "second valid grant" },
      ],
    });
    const grants = parseGuardGrantStoreContent(raw);
    expect(grants).toHaveLength(2);
    expect(grants?.map((g) => g.scope).sort()).toEqual(["mt#2581", "mt#9999"]);
  });

  it("filters out entries with missing/invalid required fields", () => {
    const raw = JSON.stringify({
      grants: [
        makeGrant(),
        { ...makeGrant(), guardName: "" },
        { ...makeGrant(), scope: "" },
        { ...makeGrant(), issuedAt: "not-a-date" },
        { ...makeGrant(), ttlMs: -5 },
        { ...makeGrant(), ttlMs: "thirty" },
        "not an object",
        null,
      ],
    });
    const grants = parseGuardGrantStoreContent(raw);
    expect(grants).toHaveLength(1);
  });

  it("preserves optional issuedBy when present", () => {
    const raw = JSON.stringify({ grants: [makeGrant({ issuedBy: "main-agent session abc" })] });
    const grants = parseGuardGrantStoreContent(raw);
    expect(grants?.[0]?.issuedBy).toBe("main-agent session abc");
  });
});

// ---------------------------------------------------------------------------
// readGuardGrantStore
// ---------------------------------------------------------------------------

describe("readGuardGrantStore", () => {
  it("returns ok with empty grants when the store file does not exist (ENOENT)", () => {
    const fakeFs = makeFakeFs();
    const result = readGuardGrantStore(MOCK_STORE_PATH, fakeFs);
    expect(result).toEqual({ status: "ok", grants: [] });
  });

  it("returns ok with parsed grants when the store file exists and is valid", () => {
    const grant = makeGrant();
    const fakeFs = makeFakeFs({ [MOCK_STORE_PATH]: JSON.stringify({ grants: [grant] }) });
    const result = readGuardGrantStore(MOCK_STORE_PATH, fakeFs);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.grants).toHaveLength(1);
      expect(result.grants[0]?.guardName).toBe(GUARD_NAME);
    }
  });

  it("returns error for malformed JSON content", () => {
    const fakeFs = makeFakeFs({ [MOCK_STORE_PATH]: "{not json" });
    const result = readGuardGrantStore(MOCK_STORE_PATH, fakeFs);
    expect(result.status).toBe("error");
  });

  it("returns error for a genuine read failure (non-ENOENT)", () => {
    const fakeFs: GuardGrantStoreFsDeps = {
      readFileSync: () => {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      },
      writeFileSync: () => {},
      mkdirSync: () => {},
    };
    const result = readGuardGrantStore(MOCK_STORE_PATH, fakeFs);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("permission denied");
    }
  });
});

// ---------------------------------------------------------------------------
// isGuardGrantValid / findValidGuardGrant
// ---------------------------------------------------------------------------

describe("isGuardGrantValid", () => {
  it("matches on exact guardName + scope, within TTL", () => {
    const grant = makeGrant();
    expect(isGuardGrantValid(grant, { guardName: GUARD_NAME, scope: "mt#2581" }, NOW + 1000)).toBe(
      true
    );
  });

  it("matches case-insensitively and ignoring # / whitespace in scope", () => {
    const grant = makeGrant({ guardName: "Duplicate-Child-Matcher", scope: "MT#2581" });
    expect(isGuardGrantValid(grant, { guardName: GUARD_NAME, scope: "mt2581" }, NOW + 1000)).toBe(
      true
    );
  });

  it("does not match a different guardName", () => {
    const grant = makeGrant();
    expect(
      isGuardGrantValid(grant, { guardName: "some-other-guard", scope: "mt#2581" }, NOW + 1000)
    ).toBe(false);
  });

  it("does not match a different scope", () => {
    const grant = makeGrant();
    expect(isGuardGrantValid(grant, { guardName: GUARD_NAME, scope: "mt#9999" }, NOW + 1000)).toBe(
      false
    );
  });

  it("expires exactly at issuedAt + ttlMs (boundary is expired, not valid)", () => {
    const grant = makeGrant();
    const expiryMs = NOW + grant.ttlMs;
    expect(isGuardGrantValid(grant, { guardName: GUARD_NAME, scope: "mt#2581" }, expiryMs)).toBe(
      false
    );
    expect(
      isGuardGrantValid(grant, { guardName: GUARD_NAME, scope: "mt#2581" }, expiryMs - 1)
    ).toBe(true);
  });

  it("treats an unparseable issuedAt as invalid", () => {
    const grant = makeGrant({ issuedAt: "not-a-date" });
    expect(isGuardGrantValid(grant, { guardName: GUARD_NAME, scope: "mt#2581" }, NOW)).toBe(false);
  });
});

describe("findValidGuardGrant", () => {
  it("returns the first matching, unexpired grant", () => {
    const grants = [
      makeGrant({ guardName: "other-guard" }),
      makeGrant({ reason: "the real match" }),
    ];
    const match = findValidGuardGrant(
      grants,
      { guardName: GUARD_NAME, scope: "mt#2581" },
      NOW + 1000
    );
    expect(match?.reason).toBe("the real match");
  });

  it("returns null when no grant matches", () => {
    const match = findValidGuardGrant(
      [makeGrant()],
      { guardName: GUARD_NAME, scope: "mt#9999" },
      NOW + 1000
    );
    expect(match).toBeNull();
  });

  it("returns null when the only match is expired", () => {
    const grant = makeGrant();
    const match = findValidGuardGrant(
      [grant],
      { guardName: GUARD_NAME, scope: "mt#2581" },
      NOW + grant.ttlMs + 1
    );
    expect(match).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// appendGuardGrant
// ---------------------------------------------------------------------------

describe("appendGuardGrant", () => {
  it("creates the store with the new grant when no file exists", () => {
    const fakeFs = makeFakeFs();
    appendGuardGrant(MOCK_STORE_PATH, makeGrant(), fakeFs);
    const written = JSON.parse(fakeFs.files[MOCK_STORE_PATH] as string);
    expect(written.grants).toHaveLength(1);
    expect(written.grants[0].guardName).toBe(GUARD_NAME);
  });

  it("appends to existing grants, preserving prior entries", () => {
    // Both grants are issued at fixture NOW with the default 30-minute TTL, so
    // passing NOW as the injectable clock (mt#2839) keeps neither expired —
    // deterministic regardless of when this suite actually runs. Without an
    // injectable clock this test silently time-bombed: appendGuardGrant used
    // to prune with real Date.now(), so `existing` (issued at fixture NOW)
    // read as expired the moment the real wall clock passed NOW + 30min.
    const existing = makeGrant({ scope: "mt#1" });
    const fakeFs = makeFakeFs({
      [MOCK_STORE_PATH]: JSON.stringify({ grants: [existing] }),
    });
    appendGuardGrant(MOCK_STORE_PATH, makeGrant({ scope: "mt#2" }), fakeFs, NOW);
    const written = JSON.parse(fakeFs.files[MOCK_STORE_PATH] as string);
    expect(written.grants).toHaveLength(2);
    expect(written.grants.map((g: GuardGrant) => g.scope).sort()).toEqual(["mt#1", "mt#2"]);
  });

  it("prunes already-expired grants when appending", () => {
    // Expired relative to fixture NOW (not the real wall clock, mt#2839): issued
    // 24h before NOW with a 1-minute TTL, so it is well past its expiry at NOW
    // regardless of when this suite actually runs.
    const longExpired = makeGrant({
      scope: "mt#old",
      issuedAt: new Date(NOW - 1000 * 60 * 60 * 24).toISOString(), // 24h before fixture NOW
      ttlMs: 60 * 1000, // 1 minute TTL — expired well before fixture NOW
    });
    const fakeFs = makeFakeFs({
      [MOCK_STORE_PATH]: JSON.stringify({ grants: [longExpired] }),
    });
    appendGuardGrant(MOCK_STORE_PATH, makeGrant({ scope: "mt#new" }), fakeFs, NOW);
    const written = JSON.parse(fakeFs.files[MOCK_STORE_PATH] as string);
    expect(written.grants).toHaveLength(1);
    expect(written.grants[0].scope).toBe("mt#new");
  });

  it("starts fresh when the existing store is malformed", () => {
    const fakeFs = makeFakeFs({ [MOCK_STORE_PATH]: "{not json" });
    appendGuardGrant(MOCK_STORE_PATH, makeGrant(), fakeFs);
    const written = JSON.parse(fakeFs.files[MOCK_STORE_PATH] as string);
    expect(written.grants).toHaveLength(1);
  });
});
