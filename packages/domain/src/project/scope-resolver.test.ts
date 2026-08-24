/**
 * Tests for the project-scope resolver's failure discrimination (mt#4509).
 *
 * The defect this file exists for was not a wrong VALUE — the resolver returned exactly what
 * ADR-021 says it should (`ALL_PROJECTS`) on every path. It was that four different situations
 * rendered as one indistinguishable line, so a `TypeError` in the caller looked identical to
 * the routine "this repo has no project row" miss and ran unobserved for two months.
 *
 * So the assertions below are about TELLING THEM APART, not about the return value — though
 * the return value is pinned too, since preserving fail-open is the constraint the fix works
 * under (changing that posture is Out of scope for mt#4509).
 *
 * No logger is captured anywhere here: `describeScopeResolution` is a pure function of
 * (outcome, caller), which is the mt#3628 pattern (`logPostgresNotice`'s injected sink) applied
 * to a module whose observable IS its log line.
 */

import { describe, test, expect } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  isScopeResolverDb,
  describeHandle,
  describeScopeResolution,
  scopeFromOutcome,
  resolveProjectScope,
  resolveScopeOutcome,
  type ScopeResolutionOutcome,
  type ScopeResolverDb,
} from "./scope-resolver";
import { ALL_PROJECTS } from "./scope";

const SLUG = "edobry/minsky";
const INVALID_DB_HANDLE = "invalid-db-handle";
const QUERY_FAILED = "query-failed";
const CONNECTION_ERROR = "connection terminated";
const RECEIVED_STUB = "Object with own keys [query]";

/** A drizzle handle built without opening a socket — construction alone needs no database. */
function makeDrizzleHandle() {
  return drizzle(postgres("postgres://u:p@127.0.0.1:1/none", { max: 1 }));
}

/** A fluent stub whose terminal `limit()` resolves to `rows`. */
function makeQueryingDb(rows: Array<{ id: string }>): ScopeResolverDb {
  return {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
    }),
  };
}

/** A handle whose `select()` throws, standing in for a connection/query failure. */
function makeThrowingDb(): ScopeResolverDb {
  return {
    select: () => {
      throw new Error(CONNECTION_ERROR);
    },
  };
}

/**
 * A handle carrying no `select` — the shape a stripped drizzle handle has.
 *
 * Returns `unknown` deliberately. `resolveProjectScope` takes `unknown` and validates the handle
 * itself (PR #3288 R1), so a caller needs no cast — and callers must NOT narrow before calling,
 * because narrowing at the call site skips the resolver and suppresses the very
 * `invalid-db-handle` log this task added. The absence of a cast here is the assertion.
 */
function makeHandleWithoutSelect(): unknown {
  return { query: {}, dialect: {} };
}

describe("isScopeResolverDb", () => {
  test("accepts a real drizzle handle", () => {
    expect(isScopeResolverDb(makeDrizzleHandle())).toBe(true);
  });

  test("REJECTS a drizzle handle flattened by an object rest-spread", () => {
    // The exact mt#4509 defect. `select` is a prototype method, so a spread copies the
    // handle's data fields and drops every method — the copy is type-valid and unusable.
    const db = makeDrizzleHandle();
    const { ...flattened } = db;

    expect(isScopeResolverDb(db)).toBe(true);
    expect(isScopeResolverDb(flattened)).toBe(false);
  });

  test("rejects null, undefined, primitives, and an object without select", () => {
    expect(isScopeResolverDb(null)).toBe(false);
    expect(isScopeResolverDb(undefined)).toBe(false);
    expect(isScopeResolverDb("db")).toBe(false);
    expect(isScopeResolverDb({})).toBe(false);
    expect(isScopeResolverDb({ select: "not a function" })).toBe(false);
  });
});

describe("describeHandle", () => {
  test("names the constructor and the own keys, and no values", () => {
    class Handle {
      readonly authToken = "s3cr3t-value-that-must-not-appear";
      readonly dialect = {};
    }
    const described = describeHandle(new Handle());

    expect(described).toContain("Handle");
    expect(described).toContain("authToken");
    expect(described).toContain("dialect");
    expect(described).not.toContain("s3cr3t");
  });

  test("handles null and primitives without throwing", () => {
    expect(describeHandle(null)).toBe("null");
    expect(describeHandle(undefined)).toBe("undefined");
    expect(describeHandle(7)).toBe("number");
  });
});

describe("describeScopeResolution", () => {
  const badHandleOutcome: ScopeResolutionOutcome = {
    kind: INVALID_DB_HANDLE,
    slug: SLUG,
    received: RECEIVED_STUB,
  };
  const queryFailedOutcome: ScopeResolutionOutcome = {
    kind: QUERY_FAILED,
    slug: SLUG,
    error: CONNECTION_ERROR,
  };
  const missOutcome: ScopeResolutionOutcome = { kind: "no-row", slug: SLUG };

  test("a bad handle and an expected miss are NOT the same line", () => {
    // This is the assertion the whole task is about. Before mt#4509 both of these produced
    // the identical `Failed to resolve slug ... defaulting to ALL_PROJECTS` warning.
    const badHandle = describeScopeResolution(badHandleOutcome, "memory");
    const miss = describeScopeResolution(missOutcome, "memory");

    expect(badHandle.level).toBe("error");
    expect(miss.level).toBe("debug");
    expect(badHandle.message).not.toBe(miss.message);
    expect(badHandle.context?.failureKind).toBe(INVALID_DB_HANDLE);
    expect(miss.context).toBeUndefined();
  });

  test("a query failure is distinct from BOTH of those", () => {
    const queryFailed = describeScopeResolution(queryFailedOutcome, "memory");
    const badHandle = describeScopeResolution(badHandleOutcome, "memory");
    const miss = describeScopeResolution(missOutcome, "memory");

    expect(queryFailed.level).toBe("warn");
    expect(queryFailed.context?.failureKind).toBe(QUERY_FAILED);
    expect(new Set([queryFailed.level, badHandle.level, miss.level]).size).toBe(3);
    expect(new Set([queryFailed.message, badHandle.message, miss.message]).size).toBe(3);
  });

  test("every failure line names its caller, so a log identifies its own call site", () => {
    for (const outcome of [badHandleOutcome, queryFailedOutcome]) {
      const line = describeScopeResolution(outcome, "transcripts");
      expect(line.context?.caller).toBe("transcripts");
      expect(line.message).toContain("transcripts");
    }
  });
});

describe("scopeFromOutcome — fail-open is preserved", () => {
  test("only a resolved outcome yields a project id; every failure yields ALL_PROJECTS", () => {
    expect(scopeFromOutcome({ kind: "resolved", slug: SLUG, projectId: "uuid-1" })).toBe("uuid-1");

    const failures: ScopeResolutionOutcome[] = [
      { kind: "unidentified", reason: "no git remote" },
      { kind: "no-row", slug: SLUG },
      { kind: INVALID_DB_HANDLE, slug: SLUG, received: RECEIVED_STUB },
      { kind: QUERY_FAILED, slug: SLUG, error: CONNECTION_ERROR },
    ];

    for (const outcome of failures) {
      expect(scopeFromOutcome(outcome)).toBe(ALL_PROJECTS);
    }
  });
});

describe("resolveScopeOutcome — the classification the guard exists for", () => {
  const identity = { kind: "resolved", slug: SLUG, source: "git-remote" } as const;

  test("classifies a bad handle as invalid-db-handle, NOT as a query failure", () => {
    // This is the assertion that fails if the shape guard is deleted. Without the guard the
    // missing `select` throws inside the try and lands as a query failure — same return value,
    // same fail-open, wrong diagnosis, and the wrong log level for a programming error.
    return resolveScopeOutcome(identity, makeHandleWithoutSelect()).then((outcome) => {
      expect(outcome.kind).toBe(INVALID_DB_HANDLE);
      if (outcome.kind === INVALID_DB_HANDLE) {
        expect(outcome.received).toContain("query");
      }
    });
  });

  test("classifies a throwing select as a query failure, keeping the two apart", async () => {
    const outcome = await resolveScopeOutcome(identity, makeThrowingDb());
    expect(outcome.kind).toBe(QUERY_FAILED);
  });

  test("classifies an empty result as a miss", async () => {
    const outcome = await resolveScopeOutcome(identity, makeQueryingDb([]));
    expect(outcome.kind).toBe("no-row");
  });
});

describe("resolveProjectScope", () => {
  const identity = { kind: "resolved", slug: SLUG, source: "git-remote" } as const;

  test("returns the uuid on a hit", async () => {
    expect(await resolveProjectScope(identity, makeQueryingDb([{ id: "uuid-1" }]), "test")).toBe(
      "uuid-1"
    );
  });

  test("fails open to ALL_PROJECTS on a miss, a bad handle, and a query failure alike", async () => {
    expect(await resolveProjectScope(identity, makeQueryingDb([]), "test")).toBe(ALL_PROJECTS);
    expect(await resolveProjectScope(identity, makeThrowingDb(), "test")).toBe(ALL_PROJECTS);
    expect(await resolveProjectScope(identity, makeHandleWithoutSelect(), "test")).toBe(
      ALL_PROJECTS
    );
  });

  test("does not throw on a handle that is missing select entirely", async () => {
    // The pre-fix behaviour was a TypeError, caught and flattened into the same shape as a
    // miss. The guard now short-circuits before the call, so `select` is never reached.
    await expect(resolveProjectScope(identity, makeHandleWithoutSelect(), "test")).resolves.toBe(
      ALL_PROJECTS
    );
  });
});
