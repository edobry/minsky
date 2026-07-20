import { describe, it, expect } from "bun:test";
import { listProjects, type ProjectsRepositoryDb } from "./projects-repository";
import type { ProjectRecord } from "../storage/schemas/projects-schema";

/**
 * Minimal fake satisfying `ProjectsRepositoryDb` — mirrors the
 * chainable-query fake pattern used by `tests/domain/project-scope-acceptance.test.ts`
 * for the sibling `scope-resolver.ts` module.
 */
function makeFakeDb(rows: ProjectRecord[]): ProjectsRepositoryDb {
  return {
    select() {
      return {
        from() {
          return {
            orderBy() {
              // orderBy is asc(slug) in production; the fake just returns the
              // rows pre-sorted by the test so we don't need to reimplement
              // drizzle's ORDER BY here.
              return Promise.resolve(rows);
            },
          };
        },
      };
    },
  };
}

const PROJECT_A: ProjectRecord = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "edobry/minsky",
  repoUrl: "https://github.com/edobry/minsky",
  displayName: "Minsky",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

const PROJECT_B: ProjectRecord = {
  id: "22222222-2222-2222-2222-222222222222",
  slug: "edobry/other-repo",
  repoUrl: null,
  displayName: null,
  createdAt: new Date("2026-02-01T00:00:00Z"),
};

describe("listProjects", () => {
  it("returns every project row from the db", async () => {
    const db = makeFakeDb([PROJECT_A, PROJECT_B]);
    const result = await listProjects(db);
    expect(result).toEqual([PROJECT_A, PROJECT_B]);
  });

  it("returns an empty array when no projects exist", async () => {
    const db = makeFakeDb([]);
    const result = await listProjects(db);
    expect(result).toEqual([]);
  });

  it("propagates a query failure rather than swallowing it", async () => {
    const failingDb: ProjectsRepositoryDb = {
      select() {
        return {
          from() {
            return {
              orderBy() {
                return Promise.reject(new Error("connection lost"));
              },
            };
          },
        };
      },
    };
    await expect(listProjects(failingDb)).rejects.toThrow("connection lost");
  });
});
