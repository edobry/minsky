import { describe, expect, it } from "bun:test";
import {
  normalizeSessionId,
  parseDispatchIntentStoreContent,
  readDispatchIntentStore,
  isDeclarationValid,
  findLiveReadOnlyDeclaration,
  appendDispatchIntentDeclaration,
  getStateDir,
  getDispatchIntentStorePath,
  type DispatchIntentDeclaration,
  type DispatchIntentStoreFsDeps,
} from "./dispatch-intent-store";

const NOW = Date.parse("2026-07-17T20:00:00.000Z");
const MOCK_STORE_PATH = "/mock/state/minsky/dispatch-intents.json";
const STATE_DIR_ENV_VAR = "MINSKY_STATE_DIR";
const SESSION_ID = "6b71e8fb-0c8e-4543-8347-3c3ade427e71";

function makeDeclaration(
  overrides: Partial<DispatchIntentDeclaration> = {}
): DispatchIntentDeclaration {
  return {
    sessionId: SESSION_ID,
    intent: "read-only",
    issuedAt: new Date(NOW).toISOString(),
    ttlMs: 30 * 60 * 1000,
    reason: "bounded memory-search lookup",
    ...overrides,
  };
}

/**
 * In-memory fake fs — per the `custom/no-real-fs-in-tests` ESLint rule,
 * tests must not touch the real filesystem. Mirrors guard-grant-store.test.ts's
 * fake exactly.
 */
function makeFakeFs(initialFiles: Record<string, string> = {}): DispatchIntentStoreFsDeps & {
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
// normalizeSessionId
// ---------------------------------------------------------------------------

describe("normalizeSessionId", () => {
  it("lowercases and trims", () => {
    expect(normalizeSessionId(SESSION_ID.toUpperCase())).toBe(SESSION_ID.toLowerCase());
    expect(normalizeSessionId(`  ${SESSION_ID}  `)).toBe(SESSION_ID);
  });
});

// ---------------------------------------------------------------------------
// getStateDir / getDispatchIntentStorePath
// ---------------------------------------------------------------------------

describe("getStateDir / getDispatchIntentStorePath", () => {
  it("honors MINSKY_STATE_DIR override", () => {
    const original = process.env[STATE_DIR_ENV_VAR];
    process.env[STATE_DIR_ENV_VAR] = "/tmp/mock-state";
    try {
      expect(getStateDir()).toBe("/tmp/mock-state");
      expect(getDispatchIntentStorePath()).toBe("/tmp/mock-state/dispatch-intents.json");
    } finally {
      if (original === undefined) delete process.env[STATE_DIR_ENV_VAR];
      else process.env[STATE_DIR_ENV_VAR] = original;
    }
  });
});

// ---------------------------------------------------------------------------
// parseDispatchIntentStoreContent
// ---------------------------------------------------------------------------

describe("parseDispatchIntentStoreContent", () => {
  it("parses a valid single-declaration store", () => {
    const raw = JSON.stringify({ declarations: [makeDeclaration()] });
    const declarations = parseDispatchIntentStoreContent(raw);
    expect(declarations).not.toBeNull();
    expect(declarations).toHaveLength(1);
    expect(declarations?.[0]?.sessionId).toBe(SESSION_ID);
    expect(declarations?.[0]?.intent).toBe("read-only");
  });

  it("returns an empty array for an empty declarations list", () => {
    expect(parseDispatchIntentStoreContent(JSON.stringify({ declarations: [] }))).toEqual([]);
  });

  it("returns null on malformed JSON", () => {
    expect(parseDispatchIntentStoreContent("{not json")).toBeNull();
  });

  it("returns null when the top-level shape has no declarations array", () => {
    expect(parseDispatchIntentStoreContent(JSON.stringify({ notDeclarations: [] }))).toBeNull();
    expect(parseDispatchIntentStoreContent(JSON.stringify({}))).toBeNull();
    expect(parseDispatchIntentStoreContent(JSON.stringify([]))).toBeNull();
  });

  it("filters out entries with an invalid intent but keeps valid ones", () => {
    const raw = JSON.stringify({
      declarations: [
        makeDeclaration(),
        { ...makeDeclaration(), intent: "not-a-real-intent" },
        { ...makeDeclaration(), sessionId: "other-session", intent: "implementation" },
      ],
    });
    const declarations = parseDispatchIntentStoreContent(raw);
    expect(declarations).toHaveLength(2);
    expect(declarations?.map((d) => d.intent).sort()).toEqual(["implementation", "read-only"]);
  });

  it("filters out entries with missing/invalid required fields", () => {
    const raw = JSON.stringify({
      declarations: [
        makeDeclaration(),
        { ...makeDeclaration(), sessionId: "" },
        { ...makeDeclaration(), issuedAt: "not-a-date" },
        { ...makeDeclaration(), ttlMs: -5 },
        { ...makeDeclaration(), ttlMs: "thirty" },
        "not an object",
        null,
      ],
    });
    const declarations = parseDispatchIntentStoreContent(raw);
    expect(declarations).toHaveLength(1);
  });

  it("preserves optional issuedBy and reason when present", () => {
    const raw = JSON.stringify({
      declarations: [makeDeclaration({ issuedBy: "session.generate_prompt:mt#2828" })],
    });
    const declarations = parseDispatchIntentStoreContent(raw);
    expect(declarations?.[0]?.issuedBy).toBe("session.generate_prompt:mt#2828");
    expect(declarations?.[0]?.reason).toBe("bounded memory-search lookup");
  });
});

// ---------------------------------------------------------------------------
// readDispatchIntentStore
// ---------------------------------------------------------------------------

describe("readDispatchIntentStore", () => {
  it("returns ok with empty declarations when the store file does not exist (ENOENT)", () => {
    const fakeFs = makeFakeFs();
    const result = readDispatchIntentStore(MOCK_STORE_PATH, fakeFs);
    expect(result).toEqual({ status: "ok", declarations: [] });
  });

  it("returns ok with parsed declarations when the store file exists and is valid", () => {
    const declaration = makeDeclaration();
    const fakeFs = makeFakeFs({
      [MOCK_STORE_PATH]: JSON.stringify({ declarations: [declaration] }),
    });
    const result = readDispatchIntentStore(MOCK_STORE_PATH, fakeFs);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.declarations).toHaveLength(1);
      expect(result.declarations[0]?.sessionId).toBe(SESSION_ID);
    }
  });

  it("returns error for malformed JSON content", () => {
    const fakeFs = makeFakeFs({ [MOCK_STORE_PATH]: "{not json" });
    const result = readDispatchIntentStore(MOCK_STORE_PATH, fakeFs);
    expect(result.status).toBe("error");
  });

  it("returns error for a genuine read failure (non-ENOENT)", () => {
    const fakeFs: DispatchIntentStoreFsDeps = {
      readFileSync: () => {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      },
      writeFileSync: () => {},
      mkdirSync: () => {},
    };
    const result = readDispatchIntentStore(MOCK_STORE_PATH, fakeFs);
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("permission denied");
    }
  });
});

// ---------------------------------------------------------------------------
// isDeclarationValid / findLiveReadOnlyDeclaration
// ---------------------------------------------------------------------------

describe("isDeclarationValid", () => {
  it("matches on exact sessionId, within TTL", () => {
    const declaration = makeDeclaration();
    expect(isDeclarationValid(declaration, { sessionId: SESSION_ID }, NOW + 1000)).toBe(true);
  });

  it("matches case-insensitively and ignoring whitespace in sessionId", () => {
    const declaration = makeDeclaration({ sessionId: SESSION_ID.toUpperCase() });
    expect(isDeclarationValid(declaration, { sessionId: `  ${SESSION_ID}  ` }, NOW + 1000)).toBe(
      true
    );
  });

  it("does not match a different sessionId", () => {
    const declaration = makeDeclaration();
    expect(isDeclarationValid(declaration, { sessionId: "some-other-session" }, NOW + 1000)).toBe(
      false
    );
  });

  it("does not match a null (unresolvable) sessionId", () => {
    const declaration = makeDeclaration();
    expect(isDeclarationValid(declaration, { sessionId: null }, NOW + 1000)).toBe(false);
  });

  it("expires exactly at issuedAt + ttlMs (boundary is expired, not valid)", () => {
    const declaration = makeDeclaration();
    const expiryMs = NOW + declaration.ttlMs;
    expect(isDeclarationValid(declaration, { sessionId: SESSION_ID }, expiryMs)).toBe(false);
    expect(isDeclarationValid(declaration, { sessionId: SESSION_ID }, expiryMs - 1)).toBe(true);
  });

  it("treats an unparseable issuedAt as invalid", () => {
    const declaration = makeDeclaration({ issuedAt: "not-a-date" });
    expect(isDeclarationValid(declaration, { sessionId: SESSION_ID }, NOW)).toBe(false);
  });
});

describe("findLiveReadOnlyDeclaration", () => {
  it("returns the first live read-only declaration matching the session", () => {
    const declarations = [
      makeDeclaration({ sessionId: "other-session" }),
      makeDeclaration({ reason: "the real match" }),
    ];
    const match = findLiveReadOnlyDeclaration(declarations, { sessionId: SESSION_ID }, NOW + 1000);
    expect(match?.reason).toBe("the real match");
  });

  it("does NOT match an 'implementation' declaration for the same session", () => {
    const declarations = [makeDeclaration({ intent: "implementation" })];
    const match = findLiveReadOnlyDeclaration(declarations, { sessionId: SESSION_ID }, NOW + 1000);
    expect(match).toBeNull();
  });

  it("returns null when no declaration matches the session", () => {
    const match = findLiveReadOnlyDeclaration(
      [makeDeclaration()],
      { sessionId: "some-other-session" },
      NOW + 1000
    );
    expect(match).toBeNull();
  });

  it("returns null when the only match is expired", () => {
    const declaration = makeDeclaration();
    const match = findLiveReadOnlyDeclaration(
      [declaration],
      { sessionId: SESSION_ID },
      NOW + declaration.ttlMs + 1
    );
    expect(match).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// appendDispatchIntentDeclaration
// ---------------------------------------------------------------------------

describe("appendDispatchIntentDeclaration", () => {
  it("creates the store with the new declaration when no file exists", () => {
    const fakeFs = makeFakeFs();
    appendDispatchIntentDeclaration(MOCK_STORE_PATH, makeDeclaration(), fakeFs, NOW);
    const written = JSON.parse(fakeFs.files[MOCK_STORE_PATH] as string);
    expect(written.declarations).toHaveLength(1);
    expect(written.declarations[0].sessionId).toBe(SESSION_ID);
  });

  it("appends to existing declarations, preserving prior entries", () => {
    // Both declarations are issued at fixture NOW with the default 30-minute
    // TTL, so passing NOW as the injectable clock keeps neither expired —
    // deterministic regardless of when this suite actually runs (mirrors
    // guard-grant-store.test.ts's appendGuardGrant test rationale).
    const existing = makeDeclaration({ sessionId: "session-1" });
    const fakeFs = makeFakeFs({
      [MOCK_STORE_PATH]: JSON.stringify({ declarations: [existing] }),
    });
    appendDispatchIntentDeclaration(
      MOCK_STORE_PATH,
      makeDeclaration({ sessionId: "session-2" }),
      fakeFs,
      NOW
    );
    const written = JSON.parse(fakeFs.files[MOCK_STORE_PATH] as string);
    expect(written.declarations).toHaveLength(2);
    expect(written.declarations.map((d: DispatchIntentDeclaration) => d.sessionId).sort()).toEqual([
      "session-1",
      "session-2",
    ]);
  });

  it("prunes already-expired declarations when appending", () => {
    const longExpired = makeDeclaration({
      sessionId: "old-session",
      issuedAt: new Date(NOW - 1000 * 60 * 60 * 24).toISOString(), // 24h before fixture NOW
      ttlMs: 60 * 1000, // 1 minute TTL — expired well before fixture NOW
    });
    const fakeFs = makeFakeFs({
      [MOCK_STORE_PATH]: JSON.stringify({ declarations: [longExpired] }),
    });
    appendDispatchIntentDeclaration(
      MOCK_STORE_PATH,
      makeDeclaration({ sessionId: "new-session" }),
      fakeFs,
      NOW
    );
    const written = JSON.parse(fakeFs.files[MOCK_STORE_PATH] as string);
    expect(written.declarations).toHaveLength(1);
    expect(written.declarations[0].sessionId).toBe("new-session");
  });

  it("starts fresh when the existing store is malformed", () => {
    const fakeFs = makeFakeFs({ [MOCK_STORE_PATH]: "{not json" });
    appendDispatchIntentDeclaration(MOCK_STORE_PATH, makeDeclaration(), fakeFs, NOW);
    const written = JSON.parse(fakeFs.files[MOCK_STORE_PATH] as string);
    expect(written.declarations).toHaveLength(1);
  });
});
