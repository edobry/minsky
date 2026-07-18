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
    const db = makeScopeResolverDb([]);
    const scope = await resolveCockpitProjectScope(undefined, db);
    expect(isAllProjects(scope)).toBe(true);
    expect(scope).toBe(ALL_PROJECTS);
  });

  it("returns ALL_PROJECTS when projectParam is the empty string", async () => {
    const db = makeScopeResolverDb([]);
    const scope = await resolveCockpitProjectScope("", db);
    expect(isAllProjects(scope)).toBe(true);
  });

  it(`returns ALL_PROJECTS when projectParam is the "${ALL_PROJECTS_PARAM}" sentinel`, async () => {
    const db = makeScopeResolverDb([]);
    const scope = await resolveCockpitProjectScope(ALL_PROJECTS_PARAM, db);
    expect(isAllProjects(scope)).toBe(true);
  });

  it("returns ALL_PROJECTS (fail-open) when no db handle is available", async () => {
    const scope = await resolveCockpitProjectScope("edobry/minsky", null);
    expect(isAllProjects(scope)).toBe(true);
  });

  it("resolves a known slug to its project uuid via resolveProjectScope", async () => {
    const db = makeScopeResolverDb([{ id: PROJECT_A_ID, slug: "edobry/minsky" }]);
    const scope = await resolveCockpitProjectScope("edobry/minsky", db);
    expect(scope).toBe(PROJECT_A_ID);
  });

  it("falls back to ALL_PROJECTS when the slug has no matching project row", async () => {
    const db = makeScopeResolverDb([]);
    const scope = await resolveCockpitProjectScope("unknown/repo", db);
    expect(isAllProjects(scope)).toBe(true);
  });
});
