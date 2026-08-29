import { describe, it, expect } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  listProjects,
  ensureProjectRow,
  setProjectDisplayNameIfUnset,
  type ProjectsRepositoryDb,
  type ProjectsUpdateDb,
} from "./projects-repository";
import { resolveProjectScope } from "./scope-resolver";
import { ALL_PROJECTS } from "./scope";
import type { ProjectIdentity } from "./identity";
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
    // `listProjects` never inserts; fail loudly if a future test path does.
    insert() {
      throw new Error("insert is not exercised by these tests");
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
      // `listProjects` never inserts; fail loudly if a future test path does.
      insert() {
        throw new Error("insert is not exercised by these tests");
      },
    };
    await expect(listProjects(failingDb)).rejects.toThrow("connection lost");
  });
});

// ---------------------------------------------------------------------------
// ensureProjectRow (mt#2934) — idempotent provisioning + round-trip into
// resolveProjectScope, per the mt#2934 spec's Acceptance Tests:
//   - fresh slug, no row → ensureProjectRow creates it → resolveProjectScope
//     resolves to that row (not ALL_PROJECTS)
//   - running the provisioning path twice → exactly one row
// ---------------------------------------------------------------------------

const pgDialect = new PgDialect();

/**
 * Stateful in-memory fake DB that actually enforces `slug`'s UNIQUE
 * constraint — unlike `makeFakeDb` above (read-only, pre-seeded), this backs
 * BOTH `ensureProjectRow`'s `insert().values().onConflictDoNothing()` chain
 * and `resolveProjectScope`'s `select().from().where().limit()` chain, so
 * the tests below exercise the real round trip: provision → resolve, and
 * provision-twice → no duplicate row.
 */
function makeStatefulFakeDb(): ProjectsRepositoryDb &
  ProjectsUpdateDb & { rows: () => ProjectRecord[] } {
  const rowsBySlug = new Map<string, ProjectRecord>();
  let idCounter = 1;

  function evalSlugEquality(cond: unknown): ProjectRecord[] {
    // resolveProjectScope always builds `eq(projectsTable.slug, slug)` —
    // render it via the real Drizzle dialect and match the rendered
    // "projects"."slug" = $1 pattern, mirroring the fake-DB pattern used by
    // tests/domain/project-scope-acceptance.test.ts for sibling tables.

    const { sql, params } = pgDialect.sqlToQuery(cond as any);
    const match = /^"projects"\."slug" = \$1$/.exec(sql.trim());
    if (!match) {
      throw new Error(`evalSlugEquality: unrecognized WHERE pattern: ${sql}`);
    }
    const slug = params[0] as string;
    const row = rowsBySlug.get(slug);
    return row ? [row] : [];
  }

  // mt#4729: renders setProjectDisplayNameIfUnset's
  // `and(eq(slug, ...), isNull(displayName))` condition and extracts the
  // slug param — mirrors evalSlugEquality's real-dialect-render approach.
  function evalUnsetDisplayNameCondition(cond: unknown): string {
    const { sql, params } = pgDialect.sqlToQuery(cond as any);
    const normalized = sql.trim().toLowerCase();
    if (
      !normalized.includes('"projects"."slug" = $1') ||
      !normalized.includes('"projects"."display_name" is null')
    ) {
      throw new Error(`evalUnsetDisplayNameCondition: unrecognized WHERE pattern: ${sql}`);
    }
    return params[0] as string;
  }

  const db: ProjectsRepositoryDb & ProjectsUpdateDb = {
    select() {
      return {
        from() {
          return {
            where(cond: unknown) {
              const matched = evalSlugEquality(cond);
              return { limit: (n: number) => Promise.resolve(matched.slice(0, n)) };
            },
            orderBy() {
              return Promise.resolve(
                Array.from(rowsBySlug.values()).sort((a, b) => a.slug.localeCompare(b.slug))
              );
            },
          };
        },
      };
    },
    insert() {
      return {
        values(v: { slug: string; repoUrl?: string | null; displayName?: string | null }) {
          return {
            onConflictDoNothing() {
              // ON CONFLICT (slug) DO NOTHING — a pre-existing row for this
              // slug is left untouched; only an absent slug gets a new row.
              if (!rowsBySlug.has(v.slug)) {
                rowsBySlug.set(v.slug, {
                  id: `id-${idCounter++}`,
                  slug: v.slug,
                  repoUrl: v.repoUrl ?? null,
                  displayName: v.displayName ?? null,
                  createdAt: new Date(),
                });
              }
              return Promise.resolve([]);
            },
          };
        },
      };
    },
    update() {
      return {
        set(values: { displayName: string }) {
          return {
            where(cond: unknown) {
              return {
                returning() {
                  const slug = evalUnsetDisplayNameCondition(cond);
                  const row = rowsBySlug.get(slug);
                  if (row && row.displayName === null) {
                    const updated = { ...row, displayName: values.displayName };
                    rowsBySlug.set(slug, updated);
                    return Promise.resolve([{ id: updated.id }]);
                  }
                  return Promise.resolve([]);
                },
              };
            },
          };
        },
      };
    },
  };

  return Object.assign(db, { rows: () => Array.from(rowsBySlug.values()) });
}

describe("ensureProjectRow — idempotent provisioning (mt#2934)", () => {
  it("creates a row for a fresh slug with no existing row", async () => {
    const db = makeStatefulFakeDb();
    await ensureProjectRow("acme/widgets", { repoUrl: "https://github.com/acme/widgets.git" }, db);

    const rows = db.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.slug).toBe("acme/widgets");
    expect(rows[0]?.repoUrl).toBe("https://github.com/acme/widgets.git");
  });

  it("running the provisioning path twice results in exactly one row", async () => {
    const db = makeStatefulFakeDb();
    const input = { repoUrl: "https://github.com/acme/widgets.git" };

    await ensureProjectRow("acme/widgets", input, db);
    await ensureProjectRow("acme/widgets", input, db);

    expect(db.rows()).toHaveLength(1);
  });

  it("re-running with a different repoUrl for the same slug still leaves exactly one row (ON CONFLICT DO NOTHING preserves the first write)", async () => {
    const db = makeStatefulFakeDb();
    await ensureProjectRow("acme/widgets", { repoUrl: "https://github.com/acme/widgets.git" }, db);
    await ensureProjectRow(
      "acme/widgets",
      { repoUrl: "https://github.com/acme/widgets-renamed.git" },
      db
    );

    const rows = db.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.repoUrl).toBe("https://github.com/acme/widgets.git");
  });

  it("a different slug creates a second, independent row", async () => {
    const db = makeStatefulFakeDb();
    await ensureProjectRow("acme/widgets", {}, db);
    await ensureProjectRow("acme/gadgets", {}, db);

    expect(
      db
        .rows()
        .map((r) => r.slug)
        .sort()
    ).toEqual(["acme/gadgets", "acme/widgets"]);
  });

  it("omitting repoUrl stores null, matching the nullable schema column", async () => {
    const db = makeStatefulFakeDb();
    await ensureProjectRow("acme/widgets", {}, db);

    expect(db.rows()[0]?.repoUrl).toBeNull();
  });

  it("seeds displayName on first insert (mt#4729)", async () => {
    const db = makeStatefulFakeDb();
    await ensureProjectRow("acme/widgets", { displayName: "Widgets" }, db);

    expect(db.rows()[0]?.displayName).toBe("Widgets");
  });

  it("a conflict (existing row) never touches displayName, even a differing one (mt#4729)", async () => {
    const db = makeStatefulFakeDb();
    await ensureProjectRow("acme/widgets", { displayName: "Widgets" }, db);
    await ensureProjectRow("acme/widgets", { displayName: "Something Else" }, db);

    const rows = db.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.displayName).toBe("Widgets");
  });

  it("omitting displayName stores null, matching the nullable schema column", async () => {
    const db = makeStatefulFakeDb();
    await ensureProjectRow("acme/widgets", {}, db);

    expect(db.rows()[0]?.displayName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setProjectDisplayNameIfUnset (mt#4729 SC4) — the sanctioned backfill path
// for a project row that predates ensureProjectRow's auto-derived default.
// ---------------------------------------------------------------------------

describe("setProjectDisplayNameIfUnset", () => {
  it("sets displayName and returns true when the column is currently null", async () => {
    const db = makeStatefulFakeDb();
    await ensureProjectRow("edobry/peezombie", {}, db);

    const updated = await setProjectDisplayNameIfUnset("edobry/peezombie", "Peezombie", db);

    expect(updated).toBe(true);
    expect(db.rows()[0]?.displayName).toBe("Peezombie");
  });

  it("does not clobber an already-set displayName, and returns false", async () => {
    const db = makeStatefulFakeDb();
    await ensureProjectRow("edobry/minsky", { displayName: "Minsky" }, db);

    const updated = await setProjectDisplayNameIfUnset("edobry/minsky", "Some Other Name", db);

    expect(updated).toBe(false);
    expect(db.rows()[0]?.displayName).toBe("Minsky");
  });

  it("returns false for a slug naming no known project", async () => {
    const db = makeStatefulFakeDb();

    const updated = await setProjectDisplayNameIfUnset("no/such-project", "Anything", db);

    expect(updated).toBe(false);
    expect(db.rows()).toHaveLength(0);
  });
});

describe("ensureProjectRow -> resolveProjectScope round trip (mt#2934 acceptance)", () => {
  it("fresh slug resolves to ALL_PROJECTS before provisioning, then to its own row after", async () => {
    const db = makeStatefulFakeDb();
    const identity: ProjectIdentity = {
      kind: "resolved",
      slug: "acme/widgets",
      source: "config-slug",
    };

    const before = await resolveProjectScope(identity, db);
    expect(before).toBe(ALL_PROJECTS);

    await ensureProjectRow("acme/widgets", { repoUrl: "https://github.com/acme/widgets.git" }, db);

    const after = await resolveProjectScope(identity, db);
    expect(after).not.toBe(ALL_PROJECTS);
    const insertedId = db.rows()[0]?.id;
    // Assert presence separately — `toBe(undefined)` would pass vacuously if
    // `ensureProjectRow` had inserted nothing at all.
    if (insertedId === undefined) throw new Error("expected ensureProjectRow to insert a row");
    expect(after).toBe(insertedId);
  });

  it("provisioning a different slug does not affect this project's scope resolution", async () => {
    const db = makeStatefulFakeDb();
    await ensureProjectRow("other/repo", {}, db);

    const identity: ProjectIdentity = {
      kind: "resolved",
      slug: "acme/widgets",
      source: "config-slug",
    };
    expect(await resolveProjectScope(identity, db)).toBe(ALL_PROJECTS);
  });

  it("re-provisioning (idempotent re-run) resolves to the SAME project id, not a new row", async () => {
    const db = makeStatefulFakeDb();
    const identity: ProjectIdentity = {
      kind: "resolved",
      slug: "acme/widgets",
      source: "config-slug",
    };

    await ensureProjectRow("acme/widgets", {}, db);
    const firstResolved = await resolveProjectScope(identity, db);

    await ensureProjectRow("acme/widgets", {}, db);
    const secondResolved = await resolveProjectScope(identity, db);

    expect(secondResolved).toBe(firstResolved);
    expect(db.rows()).toHaveLength(1);
  });
});
