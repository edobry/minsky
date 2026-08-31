/**
 * Tests for the session-identity resolution introduced by mt#4758.
 *
 * The decision half is pure, so it is asserted directly rather than through a
 * db or a patched collaborator — the mt#3628 pattern the sibling
 * `scope-resolver.test.ts` uses for `describeScopeResolution`.
 */

import { describe, expect, it } from "bun:test";
import { tasksTable } from "../storage/schemas/task-embeddings";
import { projectsTable } from "../storage/schemas/projects-schema";
import {
  decideSessionIdentity,
  describeTaskProjectRepo,
  isTaskProjectDb,
  resolveTaskProjectRepoOutcome,
  type TaskProject,
  type TaskProjectDb,
} from "./task-project-repo";

const MINSKY_URL = "https://github.com/edobry/minsky.git";
const PEEZOMBIE_URL = "https://github.com/edobry/peezombie.me.git";
const MINSKY_SLUG = "edobry/minsky";
const PEEZOMBIE_SLUG = "edobry/peezombie.me";

const PEEZOMBIE: TaskProject = {
  projectId: "2ef29b41-413e-4ecf-a61b-e695697e7d82",
  slug: PEEZOMBIE_SLUG,
  repoUrl: PEEZOMBIE_URL,
};

/**
 * A fluent stub keyed by TABLE, so the two sequential single-table reads can
 * return different rows. Mirrors `scope-resolver.test.ts`'s `makeQueryingDb`.
 */
function makeDb(rowsByTable: Map<unknown, unknown[]>): TaskProjectDb {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({ limit: () => Promise.resolve(rowsByTable.get(table) ?? []) }),
      }),
    }),
  };
}

function dbWith(taskRows: unknown[], projectRows: unknown[]): TaskProjectDb {
  return makeDb(
    new Map<unknown, unknown[]>([
      [tasksTable, taskRows],
      [projectsTable, projectRows],
    ])
  );
}

describe("decideSessionIdentity — the pure decision (mt#4758)", () => {
  it("prefers the task's project over server config", () => {
    const decision = decideSessionIdentity({
      configRepoUrl: MINSKY_URL,
      taskProject: PEEZOMBIE,
      configSlug: MINSKY_SLUG,
    });

    expect(decision.kind).toBe("project");
    if (decision.kind !== "project") throw new Error("unreachable");
    expect(decision.repoUrl).toBe(PEEZOMBIE_URL);
    expect(decision.project.projectId).toBe(PEEZOMBIE.projectId);
  });

  it("keeps config when no project resolved (fail-open, the single-project status quo)", () => {
    const decision = decideSessionIdentity({
      configRepoUrl: MINSKY_URL,
      configSlug: MINSKY_SLUG,
    });

    expect(decision.kind).toBe("config");
    if (decision.kind !== "config") throw new Error("unreachable");
    expect(decision.repoUrl).toBe(MINSKY_URL);
  });

  it("keeps config when the task's project names the SAME repository", () => {
    const decision = decideSessionIdentity({
      configRepoUrl: MINSKY_URL,
      taskProject: {
        projectId: "3ac3d147-2b6f-4cf9-a52a-2b6e32d3c5fe",
        slug: MINSKY_SLUG,
        repoUrl: MINSKY_URL,
      },
      configSlug: MINSKY_SLUG,
    });

    expect(decision.kind).toBe("config");
  });

  it("REFUSES when an explicit repo contradicts the task's project", () => {
    const decision = decideSessionIdentity({
      configRepoUrl: PEEZOMBIE_URL,
      taskProject: PEEZOMBIE,
      explicitRepo: "/Users/edobry/Projects/minsky",
      explicitRepoSlug: MINSKY_SLUG,
    });

    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") throw new Error("unreachable");
    // The message must name BOTH sides — the whole defect is that the caller
    // got no signal about the disagreement.
    expect(decision.message).toContain(MINSKY_SLUG);
    expect(decision.message).toContain(PEEZOMBIE_SLUG);
  });

  it("REFUSES when an explicit repo contradicts config and no project resolved", () => {
    // The originating mt#4678 shape: a minsky-rooted server, a repo argument
    // naming peezombie, and (pre-backfill) no project on the task.
    const decision = decideSessionIdentity({
      configRepoUrl: MINSKY_URL,
      explicitRepo: "/Users/edobry/Projects/peezombie.me",
      explicitRepoSlug: PEEZOMBIE_SLUG,
      configSlug: MINSKY_SLUG,
    });

    expect(decision.kind).toBe("refuse");
  });

  it("does NOT refuse when the explicit repo names the same repository", () => {
    const decision = decideSessionIdentity({
      configRepoUrl: MINSKY_URL,
      explicitRepo: "/Users/edobry/Projects/minsky",
      explicitRepoSlug: MINSKY_SLUG,
      configSlug: MINSKY_SLUG,
    });

    expect(decision.kind).toBe("config");
  });

  it("does NOT refuse on an unclassifiable repo argument", () => {
    // A git read that failed leaves no slug. Refusing on "I could not tell"
    // would break every legitimate local-path caller.
    const decision = decideSessionIdentity({
      configRepoUrl: MINSKY_URL,
      taskProject: PEEZOMBIE,
      explicitRepo: "/some/unreadable/path",
      explicitRepoSlug: undefined,
      configSlug: MINSKY_SLUG,
    });

    expect(decision.kind).toBe("project");
  });
});

describe("resolveTaskProjectRepoOutcome — the IO half (mt#4758)", () => {
  it("resolves a task through its project row to a repo url", async () => {
    const outcome = await resolveTaskProjectRepoOutcome(
      "mt#4678",
      dbWith(
        [{ id: "mt#4678", projectId: PEEZOMBIE.projectId }],
        [{ id: PEEZOMBIE.projectId, slug: PEEZOMBIE_SLUG, repoUrl: PEEZOMBIE_URL }]
      )
    );

    expect(outcome.kind).toBe("resolved");
    if (outcome.kind !== "resolved") throw new Error("unreachable");
    expect(outcome.project.repoUrl).toBe(PEEZOMBIE_URL);
    expect(outcome.project.slug).toBe(PEEZOMBIE.slug);
  });

  it("reports no-task when no task id is supplied", async () => {
    const outcome = await resolveTaskProjectRepoOutcome(undefined, dbWith([], []));
    expect(outcome.kind).toBe("no-task");
  });

  it("reports task-unscoped for a task whose project_id is null", async () => {
    const outcome = await resolveTaskProjectRepoOutcome(
      "mt#1",
      dbWith([{ id: "mt#1", projectId: null }], [])
    );
    expect(outcome.kind).toBe("task-unscoped");
  });

  it("reports task-not-found when no row matches", async () => {
    const outcome = await resolveTaskProjectRepoOutcome("mt#404", dbWith([], []));
    expect(outcome.kind).toBe("task-not-found");
  });

  it("reports project-not-found when the referenced project row is missing", async () => {
    const outcome = await resolveTaskProjectRepoOutcome(
      "mt#4678",
      dbWith([{ id: "mt#4678", projectId: PEEZOMBIE.projectId }], [])
    );
    expect(outcome.kind).toBe("project-not-found");
  });

  it("reports no-repo-url when the project row carries a null repo_url", async () => {
    const outcome = await resolveTaskProjectRepoOutcome(
      "mt#4678",
      dbWith(
        [{ id: "mt#4678", projectId: PEEZOMBIE.projectId }],
        [{ id: PEEZOMBIE.projectId, slug: PEEZOMBIE_SLUG, repoUrl: null }]
      )
    );
    expect(outcome.kind).toBe("no-repo-url");
  });

  it("reports invalid-db-handle rather than throwing on a spread-stripped handle", async () => {
    // The mt#4509 shape: an object rest-spread over a drizzle handle keeps every
    // data field and drops `select`, which lives on the prototype.
    const outcome = await resolveTaskProjectRepoOutcome("mt#1", { notADb: true });
    expect(outcome.kind).toBe("invalid-db-handle");
  });

  it("reports query-failed rather than throwing when the query rejects", async () => {
    const exploding: TaskProjectDb = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.reject(new Error("connection lost")) }),
        }),
      }),
    };

    const outcome = await resolveTaskProjectRepoOutcome("mt#1", exploding);
    expect(outcome.kind).toBe("query-failed");
    if (outcome.kind !== "query-failed") throw new Error("unreachable");
    expect(outcome.error).toContain("connection lost");
  });
});

describe("describeTaskProjectRepo — failures are told apart (mt#4509's lesson)", () => {
  it("logs a broken handle at error and a failed query at warn", () => {
    const handle = describeTaskProjectRepo(
      { kind: "invalid-db-handle", taskId: "mt#1", received: "object" },
      "session.start"
    );
    const query = describeTaskProjectRepo(
      { kind: "query-failed", taskId: "mt#1", error: "boom" },
      "session.start"
    );

    expect(handle.level).toBe("error");
    expect(query.level).toBe("warn");
    // Both must name the caller — mt#4509 was filed against the wrong file
    // because the log line named none.
    expect(handle.context?.caller).toBe("session.start");
    expect(query.context?.caller).toBe("session.start");
  });

  it("logs the routine misses at debug, not as failures", () => {
    for (const outcome of [
      { kind: "no-task" as const },
      { kind: "task-unscoped" as const, taskId: "mt#1" },
      { kind: "task-not-found" as const, taskId: "mt#1" },
    ]) {
      expect(describeTaskProjectRepo(outcome, "session.start").level).toBe("debug");
    }
  });
});

describe("isTaskProjectDb", () => {
  it("accepts a handle with select and rejects one without", () => {
    expect(isTaskProjectDb({ select: () => ({}) })).toBe(true);
    expect(isTaskProjectDb({})).toBe(false);
    expect(isTaskProjectDb(null)).toBe(false);
    expect(isTaskProjectDb(undefined)).toBe(false);
  });
});
