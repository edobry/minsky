/**
 * `resolveReadScope` (mt#5155): a read's project scope comes from the caller's
 * argument before the process cwd.
 *
 * The fixture is the incident's shape — a daemon whose cwd is project A and a
 * caller asking about project B. Every pre-mt#5155 site answered "A" for that;
 * this pins that it answers "B", and that a named argument which resolves to
 * nothing yields `unresolved` (nothing) instead of ADR-021's `ALL` (everything).
 */

import { describe, test, expect } from "bun:test";
import {
  NO_PROJECT_SCOPE,
  readScopeToProjectScope,
  repoLooksLikePath,
  resolveReadScope,
  slugFromRepoArgument,
  type ReadScopeDeps,
} from "./read-scope";
import type { ProjectIdentity } from "./identity";
import { ALL_PROJECTS } from "./scope";

const DAEMON_CWD = "/daemon/minsky";
const OTHER_WORKSPACE = "/caller/flotato";
const UNIDENTIFIED_DIR = "/caller/scratch";

const MINSKY_ID = "11111111-1111-4111-8111-111111111111";
const FLOTATO_ID = "22222222-2222-4222-8222-222222222222";
const PROJECTS: Record<string, string> = {
  "edobry/minsky": MINSKY_ID,
  "edobry/flotato": FLOTATO_ID,
};

/** A `projects`-table stub keyed on the slug `resolveScopeOutcome` queries. */
function dbWith(rows: Record<string, string>): unknown {
  let requestedSlug: string | undefined;
  return {
    select: () => ({
      from: () => ({
        where: (clause: unknown) => {
          // drizzle's `eq()` output is opaque; the stub reads the slug the
          // helper handed it by resolving lazily from the identity instead.
          void clause;
          return {
            limit: () => {
              const id = requestedSlug ? rows[requestedSlug] : undefined;
              return Promise.resolve(id ? [{ id }] : []);
            },
          };
        },
      }),
    }),
    /** Test seam: the identity stub records which slug the next query is for. */
    __expectSlug(slug: string) {
      requestedSlug = slug;
    },
  };
}

/** Identity resolver over a fixed path→slug map; records the slug for the db stub. */
function identityFor(
  db: unknown,
  byPath: Record<string, string>
): NonNullable<ReadScopeDeps["resolveIdentity"]> {
  return (repoPath: string): ProjectIdentity => {
    const slug = byPath[repoPath];
    if (!slug) return { kind: "unidentified", reason: `no remote at ${repoPath}` };
    (db as { __expectSlug: (s: string) => void }).__expectSlug(slug);
    return { kind: "resolved", slug, source: "git-remote" };
  };
}

function deps(db: unknown, byPath: Record<string, string>): ReadScopeDeps {
  return {
    resolveIdentity: identityFor(db, byPath),
    cwd: () => DAEMON_CWD,
  };
}

const BY_PATH: Record<string, string> = {
  [DAEMON_CWD]: "edobry/minsky",
  [OTHER_WORKSPACE]: "edobry/flotato",
};

describe("resolveReadScope — the explicit argument outranks the process cwd", () => {
  test("no argument: the cwd's project (the pre-mt#5155 behaviour, unchanged)", async () => {
    const db = dbWith(PROJECTS);
    const r = await resolveReadScope({}, db, "test", deps(db, BY_PATH));
    expect(r).toEqual({ kind: "scoped", scope: MINSKY_ID, source: "cwd" });
  });

  test("workspace names another project: that project's id, not the cwd's", async () => {
    const db = dbWith(PROJECTS);
    const r = await resolveReadScope({ workspace: OTHER_WORKSPACE }, db, "test", deps(db, BY_PATH));
    expect(r).toEqual({ kind: "scoped", scope: FLOTATO_ID, source: "workspace" });
  });

  test("repo as a path resolves like workspace", async () => {
    const db = dbWith(PROJECTS);
    const r = await resolveReadScope({ repo: OTHER_WORKSPACE }, db, "test", deps(db, BY_PATH));
    expect(r).toEqual({ kind: "scoped", scope: FLOTATO_ID, source: "repo-path" });
  });

  test("repo as an owner/name slug resolves through projects.slug", async () => {
    const db = dbWith(PROJECTS);
    (db as { __expectSlug: (s: string) => void }).__expectSlug("edobry/flotato");
    const r = await resolveReadScope({ repo: "edobry/flotato" }, db, "test", deps(db, BY_PATH));
    expect(r).toEqual({ kind: "scoped", scope: FLOTATO_ID, source: "repo-slug" });
  });

  test("workspace wins over repo when both are given", async () => {
    const db = dbWith(PROJECTS);
    const r = await resolveReadScope(
      { workspace: OTHER_WORKSPACE, repo: "edobry/minsky" },
      db,
      "test",
      deps(db, BY_PATH)
    );
    expect(r).toMatchObject({ scope: FLOTATO_ID, source: "workspace" });
  });

  test("allProjects is the opt-out and outranks everything", async () => {
    const db = dbWith(PROJECTS);
    const r = await resolveReadScope(
      { allProjects: true, workspace: OTHER_WORKSPACE },
      db,
      "test",
      deps(db, BY_PATH)
    );
    expect(r).toEqual({ kind: "all", source: "all-projects" });
  });

  test("input.cwd replaces process.cwd on the fallback rung (the mt#5168 seam)", async () => {
    const db = dbWith(PROJECTS);
    const r = await resolveReadScope({ cwd: OTHER_WORKSPACE }, db, "test", deps(db, BY_PATH));
    expect(r).toEqual({ kind: "scoped", scope: FLOTATO_ID, source: "cwd" });
  });
});

describe("resolveReadScope — a named argument that resolves to nothing is `unresolved`, never ALL", () => {
  test("workspace with no identity: unresolved with the reason", async () => {
    const db = dbWith(PROJECTS);
    const r = await resolveReadScope(
      { workspace: UNIDENTIFIED_DIR },
      db,
      "test",
      deps(db, BY_PATH)
    );
    expect(r).toMatchObject({ kind: "unresolved", source: "workspace", value: UNIDENTIFIED_DIR });
    expect((r as { reason: string }).reason).toContain("not an identified Minsky project");
  });

  test("workspace identified but with no projects row: unresolved, names the slug", async () => {
    // The 20:44Z incident shape: flotato had a remote but no row yet.
    const db = dbWith({ "edobry/minsky": MINSKY_ID });
    const r = await resolveReadScope({ workspace: OTHER_WORKSPACE }, db, "test", deps(db, BY_PATH));
    expect(r).toMatchObject({ kind: "unresolved", source: "workspace" });
    expect((r as { reason: string }).reason).toContain('"edobry/flotato"');
    expect((r as { reason: string }).reason).toContain("no projects row");
  });

  test("repo slug with no row: unresolved", async () => {
    const db = dbWith(PROJECTS);
    (db as { __expectSlug: (s: string) => void }).__expectSlug("nobody/nothing");
    const r = await resolveReadScope({ repo: "nobody/nothing" }, db, "test", deps(db, BY_PATH));
    expect(r).toMatchObject({ kind: "unresolved", source: "repo-slug", value: "nobody/nothing" });
  });

  test("repo that is neither a path nor a slug: unresolved", async () => {
    const db = dbWith(PROJECTS);
    const r = await resolveReadScope({ repo: "just-a-word" }, db, "test", deps(db, BY_PATH));
    expect(r).toMatchObject({ kind: "unresolved", source: "repo-slug" });
  });

  test("the cwd rung keeps ADR-021's fail-open default", async () => {
    const db = dbWith(PROJECTS);
    const r = await resolveReadScope({}, db, "test", {
      ...deps(db, BY_PATH),
      cwd: () => UNIDENTIFIED_DIR,
    });
    expect(r).toMatchObject({ kind: "all", source: "cwd-unscoped" });
  });

  test("the cwd rung with a bad db handle also fails open (pre-mt#5155 mapping kept)", async () => {
    const r = await resolveReadScope(
      {},
      { notADb: true },
      "test",
      deps({ __expectSlug() {} }, BY_PATH)
    );
    expect(r).toMatchObject({ kind: "all", source: "cwd-unscoped" });
  });

  test("a NULL db handle (provider not ready) follows the same split (PR #3763 R1)", async () => {
    // Sites hand the handle through unchecked so this classification is the
    // helper's, not eight local `if (db)` guards that widened to ALL.
    const explicit = await resolveReadScope(
      { workspace: OTHER_WORKSPACE },
      null,
      "test",
      deps({ __expectSlug() {} }, BY_PATH)
    );
    expect(explicit).toMatchObject({ kind: "unresolved", source: "workspace" });
    const ambient = await resolveReadScope({}, null, "test", deps({ __expectSlug() {} }, BY_PATH));
    expect(ambient).toMatchObject({ kind: "all", source: "cwd-unscoped" });
  });

  test("an explicit workspace with a bad db handle is unresolved, not ALL", async () => {
    const r = await resolveReadScope(
      { workspace: OTHER_WORKSPACE },
      { notADb: true },
      "test",
      deps({ __expectSlug() {} }, BY_PATH)
    );
    expect(r).toMatchObject({ kind: "unresolved", source: "workspace" });
    expect((r as { reason: string }).reason).toContain("project lookup unavailable");
  });
});

describe("readScopeToProjectScope", () => {
  test("scoped → the id; all → ALL_PROJECTS; unresolved → the nil uuid no row carries", () => {
    expect(readScopeToProjectScope({ kind: "scoped", scope: "abc", source: "workspace" })).toBe(
      "abc"
    );
    expect(readScopeToProjectScope({ kind: "all", source: "all-projects" })).toBe(ALL_PROJECTS);
    expect(
      readScopeToProjectScope({ kind: "unresolved", source: "workspace", value: "x", reason: "r" })
    ).toBe(NO_PROJECT_SCOPE);
    expect(NO_PROJECT_SCOPE).toBe("00000000-0000-0000-0000-000000000000");
  });
});

describe("repo argument classification", () => {
  test("absolute, dot-relative and tilde paths are paths", () => {
    expect(repoLooksLikePath("/abs/path")).toBe(true);
    expect(repoLooksLikePath("./rel")).toBe(true);
    expect(repoLooksLikePath("../rel")).toBe(true);
    expect(repoLooksLikePath("~/rel")).toBe(true);
  });

  test("a bare owner/name is always a slug, never probed as a relative directory", () => {
    // PR #3763 R1: a relative directory under the DAEMON's cwd must not turn a
    // caller's slug into a path; `./owner/name` is how a relative dir is spelled.
    expect(repoLooksLikePath("edobry/minsky")).toBe(false);
    expect(repoLooksLikePath("src/adapters")).toBe(false);
  });

  test("slugFromRepoArgument accepts bare slugs and remote URLs", () => {
    expect(slugFromRepoArgument("edobry/minsky")).toBe("edobry/minsky");
    expect(slugFromRepoArgument("edobry/minsky.git")).toBe("edobry/minsky");
    expect(slugFromRepoArgument("git@github.com:edobry/minsky.git")).toBe("edobry/minsky");
    expect(slugFromRepoArgument("https://github.com/edobry/minsky")).toBe("edobry/minsky");
    expect(slugFromRepoArgument("just-a-word")).toBeNull();
    expect(slugFromRepoArgument("a/b/c")).toBeNull();
  });
});
