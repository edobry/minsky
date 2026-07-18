import { describe, it, expect } from "bun:test";
import { resolveCockpitProjectScope, ALL_PROJECTS_PARAM } from "./project-scope";
import { ALL_PROJECTS, isAllProjects } from "@minsky/domain/project/scope";
import type { ScopeResolverDb } from "@minsky/domain/project/scope-resolver";

const PROJECT_A_ID = "11111111-1111-1111-1111-111111111111";

/**
 * Fake db shaped exactly as `scope-resolver.ts`'s query expects
 * (`select().from().where().limit()`), resolving to `rows`.
 */
function makeScopeResolverDb(rows: Array<{ id: string; slug: string }>): ScopeResolverDb {
  return {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  return Promise.resolve(rows);
                },
              };
            },
          };
        },
      };
    },
  };
}

describe("resolveCockpitProjectScope", () => {
  it("returns ALL_PROJECTS when projectParam is undefined", async () => {
    const scope = await resolveCockpitProjectScope(undefined);
    expect(isAllProjects(scope)).toBe(true);
    expect(scope).toBe(ALL_PROJECTS);
  });

  it("returns ALL_PROJECTS when projectParam is the empty string", async () => {
    const scope = await resolveCockpitProjectScope("");
    expect(isAllProjects(scope)).toBe(true);
  });

  it(`returns ALL_PROJECTS when projectParam is the "${ALL_PROJECTS_PARAM}" sentinel`, async () => {
    const scope = await resolveCockpitProjectScope(ALL_PROJECTS_PARAM);
    expect(isAllProjects(scope)).toBe(true);
  });

  it("returns ALL_PROJECTS (fail-open) when the db getter resolves to null", async () => {
    const scope = await resolveCockpitProjectScope("edobry/minsky", {
      getDb: async () => null,
    });
    expect(isAllProjects(scope)).toBe(true);
  });

  it("resolves a known slug to its project uuid via resolveProjectScope", async () => {
    const db = makeScopeResolverDb([{ id: PROJECT_A_ID, slug: "edobry/minsky" }]);
    const scope = await resolveCockpitProjectScope("edobry/minsky", { getDb: async () => db });
    expect(scope).toBe(PROJECT_A_ID);
  });

  it("falls back to ALL_PROJECTS when the slug has no matching project row", async () => {
    const db = makeScopeResolverDb([]);
    const scope = await resolveCockpitProjectScope("unknown/repo", { getDb: async () => db });
    expect(isAllProjects(scope)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Fail-open on thrown errors (PR #2056 R1 — BLOCKING 1/2, NON-BLOCKING 1/2)
  //
  // Project scoping is a view convenience layered on top of already-working
  // unscoped reads. A failure ANYWHERE in the resolution chain — a thrown db
  // getter, a dynamic-import failure, an unexpected throw from the domain
  // resolver — must degrade to ALL_PROJECTS rather than propagate up to the
  // widget's outer try/catch (which would mark the WHOLE widget degraded,
  // losing unrelated data the scoping failure has nothing to do with).
  // -------------------------------------------------------------------------

  it("returns ALL_PROJECTS (fail-open) when the db getter throws synchronously", async () => {
    const scope = await resolveCockpitProjectScope("edobry/minsky", {
      getDb: () => {
        throw new Error("boom: getContextInspectorDb import failed");
      },
    });
    expect(isAllProjects(scope)).toBe(true);
  });

  it("returns ALL_PROJECTS (fail-open) when the db getter's promise rejects", async () => {
    const scope = await resolveCockpitProjectScope("edobry/minsky", {
      getDb: async () => {
        throw new Error("boom: db connection lost");
      },
    });
    expect(isAllProjects(scope)).toBe(true);
  });

  it("returns ALL_PROJECTS (fail-open) when the resolved db's query throws", async () => {
    const throwingDb: ScopeResolverDb = {
      select() {
        throw new Error("boom: unexpected query-builder failure");
      },
    };
    const scope = await resolveCockpitProjectScope("edobry/minsky", {
      getDb: async () => throwingDb,
    });
    expect(isAllProjects(scope)).toBe(true);
  });

  it("never throws — the sentinel/absent-param short-circuit bypasses the db getter entirely", async () => {
    // Even a getDb that always throws must not be reached when the param is
    // absent/"all" — the short-circuit above returns before any db access.
    const scope = await resolveCockpitProjectScope(undefined, {
      getDb: () => {
        throw new Error("should never be called");
      },
    });
    expect(isAllProjects(scope)).toBe(true);
  });
});
