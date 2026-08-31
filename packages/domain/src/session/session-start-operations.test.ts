import { describe, it, expect, mock } from "bun:test";
const vi = { fn: mock };
import { startSessionImpl, type StartSessionDependencies } from "./start-session-operations";
import type { SessionStartParameters } from "../schemas";
import type { SessionRecord } from "../session";
import { SessionStatus } from "./types";
import { FakeSessionProvider } from "./fake-session-provider";
import { FakeGitService } from "../git/fake-git-service";
import { FakeTaskService } from "../tasks/fake-task-service";
import { FakeWorkspaceUtils } from "../workspace/fake-workspace-utils";
import { first } from "@minsky/shared/array-safety";
import type { ScopeResolverDb } from "../project/scope-resolver";
import { tasksTable } from "../storage/schemas/task-embeddings";
import { projectsTable } from "../storage/schemas/projects-schema";

// mt#3106: the --recover path now routes through the guarded delete, whose
// live-actor gate would fail-closed in these provider-less fixtures. Existing
// tests stub it not-live so they exercise their own concern; the mt#3106
// describe block below overrides it per-case.
const notLiveActor = async () => ({
  verdict: "not-live" as const,
  reason: "test: nobody live",
});

function createDeps(repoUrl: string): StartSessionDependencies & {
  addSessionSpy: ReturnType<typeof mock>;
} {
  const sessionDB = new FakeSessionProvider();
  // Wrap (call-through), don't replace: preserve FakeSessionProvider's real
  // persistence behavior (the record actually lands in the in-memory store)
  // while still letting tests assert on calls via addSessionSpy.mock.calls.
  // Replacing addSession outright silently breaks any assertion — present or
  // future — that depends on the session actually being retrievable after
  // startSessionImpl() returns (e.g. via sessionDB.getSession/listSessions).
  const originalAddSession = sessionDB.addSession.bind(sessionDB);
  const addSessionSpy = vi.fn(async (record: SessionRecord) => originalAddSession(record));
  sessionDB.addSession = addSessionSpy;

  const gitService = new FakeGitService();
  gitService.clone = vi.fn(async () => ({ workdir: "/tmp/work", session: "test-uuid-session" }));
  gitService.branchWithoutSession = vi.fn(async () => ({
    workdir: "/tmp/work",
    branch: "task/md-x",
  }));

  const taskService = new FakeTaskService();
  taskService.getTaskStatus = vi.fn(async () => "READY");
  taskService.setTaskStatus = vi.fn(async () => ({ recordsAffected: 1 }));
  taskService.createTaskFromTitleAndSpec = vi.fn(async (t: string, d: string) => ({
    id: "md#999",
    title: t,
    description: d,
  })) as any;
  taskService.getTask = vi.fn(async () => ({ id: "md#999" })) as any;

  const workspaceUtils = new FakeWorkspaceUtils();

  const getRepositoryBackend = vi.fn(async () => {
    const backendType = repoUrl.includes("github.com") ? "github" : "github";
    return { repoUrl, backendType };
  });
  return {
    sessionDB,
    gitService,
    taskService,
    workspaceUtils,
    getRepositoryBackend,
    resolveActor: notLiveActor,
    addSessionSpy,
  } as unknown as StartSessionDependencies & { addSessionSpy: ReturnType<typeof mock> };
}

describe("startSessionImpl - backendType", () => {
  it("sets backendType=github for GitHub URLs", async () => {
    const deps = createDeps("https://github.com/owner/repo.git");
    const params = { task: "md#999" } as unknown as SessionStartParameters;
    await startSessionImpl(params, deps);
    const added = first(deps.addSessionSpy.mock.calls as unknown[][])[0] as SessionRecord;
    expect(added.backendType).toBe("github");
  });

  it("sets backendType=github for non-GitHub URLs (only github is supported)", async () => {
    const deps = createDeps("https://example.com/owner/repo.git");
    const params = { task: "md#999" } as unknown as SessionStartParameters;
    await startSessionImpl(params, deps);
    const added = first(deps.addSessionSpy.mock.calls as unknown[][])[0] as SessionRecord;
    expect(added.backendType).toBe("github");
  });
});

// mt#2697: session_list task filter returns empty for CREATED sessions that
// dispatch reports "actively in use" — the "actively in use" precondition
// check and session.list's task-filtered query must consult the same
// predicate. This suite pins the "actively in use" side: it must find a
// pre-existing session for the task REGARDLESS of that session's project_id
// (dispatch-created sessions shipped with project_id NULL — see
// fake-session-provider.test.ts and basic-commands.test.ts for the
// session.list side of the same predicate).
const EXISTING_SESSION_ID = "existing-session-id-mt2697";

function buildExistingSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: EXISTING_SESSION_ID,
    repoName: "owner-repo",
    repoUrl: "https://github.com/owner/repo.git",
    createdAt: new Date().toISOString(),
    taskId: "md#999",
    status: SessionStatus.CREATED,
    lastActivityAt: new Date().toISOString(),
    // Deliberately unset by default — mirrors the incident rows
    // (mt#2665/2677/2678), all of which had projectId: null.
    projectId: undefined,
    ...overrides,
  };
}

describe("startSessionImpl - actively-in-use check (mt#2697)", () => {
  it("blocks starting a new session when an unstamped (project_id undefined) CREATED session already exists for the task", async () => {
    const sessionDB = new FakeSessionProvider({ initialSessions: [buildExistingSession()] });
    const deps: StartSessionDependencies = {
      ...createDeps("https://github.com/owner/repo.git"),
      sessionDB,
    };
    const params = { task: "md#999" } as unknown as SessionStartParameters;

    await expect(startSessionImpl(params, deps)).rejects.toThrow(/actively in use/);
  });

  it("still blocks when the existing session IS project-stamped (predicate stays unscoped either way)", async () => {
    const sessionDB = new FakeSessionProvider({
      initialSessions: [
        buildExistingSession({ projectId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }),
      ],
    });
    const deps: StartSessionDependencies = {
      ...createDeps("https://github.com/owner/repo.git"),
      sessionDB,
    };
    const params = { task: "md#999" } as unknown as SessionStartParameters;

    await expect(startSessionImpl(params, deps)).rejects.toThrow(/actively in use/);
  });

  it("does not block starting a session for an unrelated task", async () => {
    const sessionDB = new FakeSessionProvider({
      initialSessions: [buildExistingSession({ taskId: "md#111" })],
    });
    const deps: StartSessionDependencies = {
      ...createDeps("https://github.com/owner/repo.git"),
      sessionDB,
    };
    const params = { task: "md#999" } as unknown as SessionStartParameters;

    await startSessionImpl(params, deps);
    // No throw — succeeded, session for md#999 was created (not blocked by md#111's row).
  });
});

// mt#2697 acceptance test (spec §Acceptance Tests, "Repro first"): a session
// created via the SAME code path tasks.dispatch uses (SessionService
// constructed without deps.db) must be visible to session.list's
// task-filtered query. This chains startSessionImpl (dispatch shape) directly
// into a session.list-equivalent listSessions({ taskId }) call against the
// SAME FakeSessionProvider instance — reproducing the incident's exact
// create-then-list flow end to end.
describe("startSessionImpl -> session.list integration (mt#2697 acceptance test)", () => {
  it("a session created via the dispatch code path (no deps.db) is visible to a task-filtered session.list query", async () => {
    // Real FakeSessionProvider, untouched addSession (createDeps() normally
    // overrides addSession with a non-persisting spy — that's fine for the
    // backendType suite above, but this test needs the record to actually
    // land in the shared store so the follow-up listSessions() call can see it).
    const sessionDB = new FakeSessionProvider();
    const deps: StartSessionDependencies = {
      ...createDeps("https://github.com/owner/repo.git"),
      sessionDB,
    };
    const params = { task: "md#999" } as unknown as SessionStartParameters;

    await startSessionImpl(params, deps);

    // Mirrors session.list's task-filtered query (basic-commands.ts, mt#2697):
    // unscoped when a task filter is present — the same predicate pinned by
    // the "actively-in-use check" suite above, now exercised end to end.
    const found = await sessionDB.listSessions({ taskId: "md#999" });
    expect(found).toHaveLength(1);
    expect(found[0]?.taskId).toBe("md#999");
  });
});

// mt#2895: an interrupted `session_start` leaves a CREATED-state session with no
// workspace activity. The non-recover error tells the operator to re-run with
// `--recover`; the report was that doing so returned the IDENTICAL error.
//
// `deriveSessionLiveness` falls back to `createdAt` when `lastActivityAt` is
// absent, so a CREATED record older than the 2h stale threshold does classify as
// `stale` — which is the branch `--recover` acts on. These tests pin that the
// suggestion the error prints is actually true.
const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
const ABANDONED_SESSION_ID = "abandoned-created-session-mt2895";

function buildAbandonedCreatedSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  // Not a path: liveness is time-derived (deriveSessionLiveness compares against
  // now), so the fixture must express an age relative to the current clock rather
  // than a fixed literal.
  // eslint-disable-next-line custom/no-real-fs-in-tests
  const longAgo = new Date(Date.now() - THREE_HOURS_MS).toISOString();
  return {
    sessionId: ABANDONED_SESSION_ID,
    repoName: "owner-repo",
    repoUrl: "https://github.com/owner/repo.git",
    createdAt: longAgo,
    taskId: "md#999",
    status: SessionStatus.CREATED,
    // The defining shape of the incident: the interrupted start created the
    // record but never recorded any activity against it.
    lastActivityAt: undefined,
    projectId: undefined,
    ...overrides,
  };
}

describe("startSessionImpl - recover on an abandoned CREATED-state session (mt#2895)", () => {
  it("without --recover, reports the session as abandoned and suggests --recover", async () => {
    const sessionDB = new FakeSessionProvider({
      initialSessions: [buildAbandonedCreatedSession()],
    });
    const deps: StartSessionDependencies = {
      ...createDeps("https://github.com/owner/repo.git"),
      sessionDB,
    };
    const params = { task: "md#999" } as unknown as SessionStartParameters;

    await expect(startSessionImpl(params, deps)).rejects.toThrow(/appears abandoned/);
    await expect(startSessionImpl(params, deps)).rejects.toThrow(/--recover/);
  });

  it("with --recover, succeeds in ONE call: the stale record is gone and a NEW session exists", async () => {
    const sessionDB = new FakeSessionProvider({
      initialSessions: [buildAbandonedCreatedSession()],
    });
    const deps: StartSessionDependencies = {
      ...createDeps("https://github.com/owner/repo.git"),
      sessionDB,
    };
    const params = { task: "md#999", recover: true } as unknown as SessionStartParameters;

    const result = await startSessionImpl(params, deps);

    // A NEW session, not the abandoned one.
    expect(result.sessionId).not.toBe(ABANDONED_SESSION_ID);

    // Exactly one session for the task, and it is the new one — the abandoned
    // record was removed rather than left alongside it.
    const found = await sessionDB.listSessions({ taskId: "md#999" });
    expect(found).toHaveLength(1);
    expect(found[0]?.sessionId).toBe(result.sessionId);
  });

  it("the suggestion the non-recover error prints is the call that actually works", async () => {
    // Pins the two branches against each other: whatever the error tells the
    // operator to run must not itself fail. This is the criterion mt#2895
    // named ("the non-recover error's suggested command remains accurate").
    const sessionDB = new FakeSessionProvider({
      initialSessions: [buildAbandonedCreatedSession()],
    });
    const deps: StartSessionDependencies = {
      ...createDeps("https://github.com/owner/repo.git"),
      sessionDB,
    };

    let suggested = "";
    try {
      await startSessionImpl({ task: "md#999" } as unknown as SessionStartParameters, deps);
    } catch (err) {
      suggested = err instanceof Error ? err.message : String(err);
    }
    expect(suggested).toContain("--recover");

    await startSessionImpl(
      { task: "md#999", recover: true } as unknown as SessionStartParameters,
      deps
    );
  });
});

// mt#3166: `--recover` used to be read ONLY inside the "a session record exists"
// branch. For a task with no record it was silently ignored, and the call
// degraded into an ordinary fresh session branched off main — wearing the name
// of a recovery. These tests pin the three-case contract:
//   no record + no branch  -> refuse
//   no record + branch     -> recover FROM the branch
//   stale record + branch  -> recover FROM the branch (not main)
const REMOTE_BRANCH_LS_OUTPUT = "abc123\trefs/heads/task/md-999\n";
const ORIGIN_TRACKING_REF = "origin/task/md-999";

/**
 * Wire a git service whose `execInRepository` answers the remote probe the way
 * the test wants and records every command, so assertions can check WHICH git
 * commands the recovery path actually ran.
 */
function createDepsWithRemote(options: {
  branchOnRemote: boolean;
  probeThrows?: boolean;
}): StartSessionDependencies & { commands: string[] } {
  const deps = createDeps("https://github.com/owner/repo.git");
  const commands: string[] = [];

  (deps.gitService as { execInRepository: unknown }).execInRepository = vi.fn(
    async (_workdir: string, command: string) => {
      commands.push(command);
      if (command.includes("ls-remote")) {
        if (options.probeThrows) throw new Error("fatal: could not read from remote repository");
        return options.branchOnRemote ? REMOTE_BRANCH_LS_OUTPUT : "";
      }
      // Keep the reference-clone auto-detect from binding a referenceRepo.
      return "";
    }
  );

  return Object.assign(deps, { commands });
}

describe("startSessionImpl - --recover honors or refuses on every path (mt#3166)", () => {
  it("refuses when there is NEITHER a session record NOR a remote branch", async () => {
    const deps = createDepsWithRemote({ branchOnRemote: false });
    const params = { task: "md#999", recover: true } as unknown as SessionStartParameters;

    await expect(startSessionImpl(params, deps)).rejects.toThrow(/Nothing to recover/);
    // The refusal names the likeliest real cause rather than implying a fault.
    await expect(startSessionImpl(params, deps)).rejects.toThrow(/already be merged/);
  });

  it("creates NO session when it refuses", async () => {
    const sessionDB = new FakeSessionProvider();
    const deps: StartSessionDependencies = {
      ...createDepsWithRemote({ branchOnRemote: false }),
      sessionDB,
    };
    const params = { task: "md#999", recover: true } as unknown as SessionStartParameters;

    await expect(startSessionImpl(params, deps)).rejects.toThrow(/Nothing to recover/);
    expect(await sessionDB.listSessions({ taskId: "md#999" })).toHaveLength(0);
  });

  it("recovers FROM the remote branch when one exists (fetch from origin + checkout, not a fresh branch)", async () => {
    const deps = createDepsWithRemote({ branchOnRemote: true });
    const params = { task: "md#999", recover: true } as unknown as SessionStartParameters;

    await startSessionImpl(params, deps);

    const fetched = deps.commands.find((c) => c.startsWith("git fetch"));
    const checkedOut = deps.commands.find((c) => c.includes("checkout -b"));
    expect(fetched).toBeDefined();
    expect(fetched).toContain("refs/heads/task/md-999");
    // Fetch goes through `origin`, which carries the clone's credentials — a
    // bare-URL fetch would re-authenticate from scratch and fail on a private
    // repo (PR #2299 R1).
    expect(fetched).toContain("origin");
    expect(fetched).not.toContain("https://");
    expect(checkedOut).toContain(ORIGIN_TRACKING_REF);

    // Upstream is configured, so a later push/PR from this session targets the
    // branch it was recovered from instead of erroring on a missing upstream.
    // Matched in two parts because the ref is shell-quoted.
    const upstream = deps.commands.find((c) => c.includes("--set-upstream-to="));
    expect(upstream).toBeDefined();
    expect(upstream).toContain(ORIGIN_TRACKING_REF);

    // The plain "branch off whatever the clone landed on" path is NOT used —
    // that is precisely the silent substitution this task removes.
    expect(
      (deps.gitService.branchWithoutSession as ReturnType<typeof mock>).mock.calls
    ).toHaveLength(0);
  });

  it("recovers from the remote branch even when a stale session record also exists", async () => {
    const sessionDB = new FakeSessionProvider({
      initialSessions: [buildAbandonedCreatedSession()],
    });
    const deps: StartSessionDependencies & { commands: string[] } = Object.assign(
      createDepsWithRemote({ branchOnRemote: true }),
      { sessionDB }
    );
    const params = { task: "md#999", recover: true } as unknown as SessionStartParameters;

    await startSessionImpl(params, deps);

    expect(deps.commands.some((c) => c.includes(ORIGIN_TRACKING_REF))).toBe(true);
    // The abandoned record was cleared, not left beside the new session.
    const found = await sessionDB.listSessions({ taskId: "md#999" });
    expect(found).toHaveLength(1);
    expect(found[0]?.sessionId).not.toBe(ABANDONED_SESSION_ID);
  });

  it("branches off main (no fetch) when a record exists but the branch does not — the mt#2895 shape", async () => {
    const sessionDB = new FakeSessionProvider({
      initialSessions: [buildAbandonedCreatedSession()],
    });
    const deps: StartSessionDependencies & { commands: string[] } = Object.assign(
      createDepsWithRemote({ branchOnRemote: false }),
      { sessionDB }
    );
    const params = { task: "md#999", recover: true } as unknown as SessionStartParameters;

    await startSessionImpl(params, deps);

    // Nothing to fetch — this is "clear the abandoned record and start over".
    expect(deps.commands.some((c) => c.startsWith("git fetch"))).toBe(false);
    expect(
      (deps.gitService.branchWithoutSession as ReturnType<typeof mock>).mock.calls.length
    ).toBeGreaterThan(0);
  });

  it("refuses --recover without a task, rather than silently ignoring it", async () => {
    const deps = createDepsWithRemote({ branchOnRemote: false });
    const params = {
      sessionId: "some-session",
      recover: true,
    } as unknown as SessionStartParameters;

    await expect(startSessionImpl(params, deps)).rejects.toThrow(/--recover requires --task/);
  });

  it("a FAILED probe refuses distinctly — it is not reported as 'nothing to recover'", async () => {
    // Treating an unreachable remote as "branch absent" would refuse a recovery
    // that should have succeeded, so the probe fails closed with its own message.
    const deps = createDepsWithRemote({ branchOnRemote: false, probeThrows: true });
    const params = { task: "md#999", recover: true } as unknown as SessionStartParameters;

    await expect(startSessionImpl(params, deps)).rejects.toThrow(/Could not determine whether/);
    await expect(startSessionImpl(params, deps)).rejects.not.toThrow(/Nothing to recover/);
  });

  it("does not probe the remote at all when --recover is absent", async () => {
    const deps = createDepsWithRemote({ branchOnRemote: true });
    const params = { task: "md#999" } as unknown as SessionStartParameters;

    await startSessionImpl(params, deps);

    expect(deps.commands.some((c) => c.includes("ls-remote"))).toBe(false);
  });
});

// mt#3106: the recover-path delete is GUARDED — it inherits mt#3105's
// live-actor gate (ask#6273 four-branch semantics) and mt#3021's git-state
// guard by routing through deleteSessionImpl instead of the raw
// sessionDB.deleteSession. deriveSessionLiveness (which classified the record
// stale) is a pre-filter only, never the authorizer.
describe("startSessionImpl - --recover routes through the guarded delete (mt#3106)", () => {
  const liveActor = async () => ({
    verdict: "live" as const,
    reason: "actor live-actor-3 (pid 555, alive) refreshed recently at 2026-07-29T04:00:00.000Z",
    actorId: "live-actor-3",
    lastRefreshedAt: "2026-07-29T04:00:00.000Z",
  });

  it("AT1: refuses recovery when the stale-by-lastActivityAt session has a LIVE actor; the record survives and the raw delete is never reached", async () => {
    const sessionDB = new FakeSessionProvider({
      initialSessions: [buildAbandonedCreatedSession()],
    });
    const deleteSpy = mock(sessionDB.deleteSession.bind(sessionDB));
    sessionDB.deleteSession = deleteSpy;
    const deps: StartSessionDependencies & { commands: string[] } = Object.assign(
      createDepsWithRemote({ branchOnRemote: true }),
      { sessionDB, resolveActor: liveActor }
    );
    const params = { task: "md#999", recover: true } as unknown as SessionStartParameters;

    await expect(startSessionImpl(params, deps)).rejects.toThrow(/Cannot recover session/);
    await expect(startSessionImpl(params, deps)).rejects.toThrow(/live-actor-3/);
    await expect(startSessionImpl(params, deps)).rejects.toThrow(/--override-reason/);

    // The abandoned-looking record was NOT deleted — neither via the guarded
    // route (it refused) nor via the removed raw call (AT3).
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(await sessionDB.getSession(ABANDONED_SESSION_ID)).not.toBeNull();
  });

  it("fail-closed default: with no resolveActor seam and no db, recovery of a non-terminal record refuses (store-unavailable)", async () => {
    const sessionDB = new FakeSessionProvider({
      initialSessions: [buildAbandonedCreatedSession()],
    });
    const base = createDepsWithRemote({ branchOnRemote: true });
    // Remove the fixture-level stub so the REAL primitive path runs with no
    // presence access at all.
    const { resolveActor: _omitted, ...withoutActor } = base as StartSessionDependencies & {
      commands: string[];
    };
    const deps = { ...withoutActor, sessionDB } as unknown as StartSessionDependencies;
    const params = { task: "md#999", recover: true } as unknown as SessionStartParameters;

    await expect(startSessionImpl(params, deps)).rejects.toThrow(/presence store unavailable/);
    expect(await sessionDB.getSession(ABANDONED_SESSION_ID)).not.toBeNull();
  });

  it("production shape (R1): with persistence WIRED and no claims on record, the gate abstains (no-claim) and legacy recovery proceeds without an override", async () => {
    const sessionDB = new FakeSessionProvider({
      initialSessions: [buildAbandonedCreatedSession()],
    });
    const base = createDepsWithRemote({ branchOnRemote: true });
    const { resolveActor: _omitted, ...withoutActor } = base as StartSessionDependencies & {
      commands: string[];
    };
    // A drizzle-shaped fake whose claims query returns ZERO rows — the
    // dominant legacy population (claim mechanism began 2026-07-16). Wired
    // through the SAME provider carrier the production session.start command
    // resolves its db from (basic-commands.ts, mt#2416).
    const emptyClaimsDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: async () => [],
          }),
        }),
      }),
    };
    const deps = {
      ...withoutActor,
      sessionDB,
      persistenceProvider: { getDatabaseConnection: async () => emptyClaimsDb },
    } as unknown as StartSessionDependencies;
    const params = { task: "md#999", recover: true } as unknown as SessionStartParameters;

    const result = await startSessionImpl(params, deps);

    // ask#6273 branch 3: no claim on record → abstain → the recovery proceeds.
    expect(result.sessionId).not.toBe(ABANDONED_SESSION_ID);
    expect(await sessionDB.getSession(ABANDONED_SESSION_ID)).toBeNull();
  });
});

// mt#4734: session.start's ADR-021 project_id stamping resolved identity via
// resolveProjectIdentity({ repoPath: sessionDir }) BEFORE the clone happens —
// sessionDir has no .git yet at that point, so git-remote auto-detect always
// missed and every session (not just a foreign-repo one) stamped project_id
// NULL. The fix threads `remoteUrl: repoUrl` through so identity resolves
// from the URL string directly, with no dependency on the clone having
// happened yet. This suite exercises the REAL default resolveProjectIdentity
// deps (no injected execSync/existsSync) through the full startSessionImpl
// path — the same shape production runs — rather than unit-testing the
// resolver in isolation (identity.test.ts already covers that).
//
// A fluent stub whose terminal `limit()` resolves with `rows` — mirrors the
// established ADR-021 fake-DB pattern (scope-resolver.test.ts's
// makeQueryingDb / session-start-recover-guarded-delete's emptyClaimsDb).
function makeProjectDb(rows: Array<{ id: string }>): ScopeResolverDb {
  return {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
    }),
  };
}

describe("startSessionImpl - project_id stamping resolves from repoUrl before the session dir is cloned (mt#4734)", () => {
  // A NON-DEFAULT project — the exact shape of the originating incident
  // (ws#815, edobry/peezombie.me): the spec explicitly calls for a
  // non-default-project regression, since a fix that only worked for the
  // repo Minsky happens to run in would have hidden this exact bug.
  const FOREIGN_REPO_URL = "https://github.com/edobry/peezombie.me.git";
  const FOREIGN_PROJECT_ID = "2ef29b41-413e-4ecf-a61b-e695697e7d82";

  it("stamps project_id for a foreign (non-default) project even though the session directory has not been cloned yet", async () => {
    const db = makeProjectDb([{ id: FOREIGN_PROJECT_ID }]);
    const deps: StartSessionDependencies & { addSessionSpy: ReturnType<typeof mock> } = {
      ...createDeps(FOREIGN_REPO_URL),
      db,
    };
    const params = { task: "md#999" } as unknown as SessionStartParameters;

    await startSessionImpl(params, deps);

    const added = first(deps.addSessionSpy.mock.calls as unknown[][])[0] as SessionRecord;
    expect(added.projectId).toBe(FOREIGN_PROJECT_ID);
    expect(added.repoName).toContain("peezombie");
  });

  it("leaves project_id undefined (fail-open) when no project row matches the repo's slug", async () => {
    const db = makeProjectDb([]); // no matching project row
    const deps: StartSessionDependencies & { addSessionSpy: ReturnType<typeof mock> } = {
      ...createDeps(FOREIGN_REPO_URL),
      db,
    };
    const params = { task: "md#999" } as unknown as SessionStartParameters;

    await startSessionImpl(params, deps);

    const added = first(deps.addSessionSpy.mock.calls as unknown[][])[0] as SessionRecord;
    expect(added.projectId).toBeUndefined();
  });
});

// mt#4758: the CROSS-PROJECT case — the task's project and the server's config
// name DIFFERENT repositories. The mt#4734 suite above cannot reach this: it
// points `createDeps` at the foreign URL, so config and project AGREE and the
// resolution is consistent either way. Here they disagree, which is the
// condition under which session_start used to succeed and produce a session
// whose files were one repository and whose record was another.
describe("startSessionImpl - identity comes from the task's project, not the server's config (mt#4758)", () => {
  const MINSKY_URL = "https://github.com/edobry/minsky.git";
  const PEEZOMBIE_URL = "https://github.com/edobry/peezombie.me.git";
  const PEEZOMBIE_ID = "2ef29b41-413e-4ecf-a61b-e695697e7d82";
  const PEEZOMBIE_PATH = "/Users/edobry/Projects/peezombie.me";

  /**
   * Table-keyed fake: the task read and the two project reads (by id, from the
   * identity resolver; by slug, from the scope resolver) hit different tables.
   */
  function crossProjectDb(taskRows: unknown[], projectRows: unknown[]): ScopeResolverDb {
    const byTable = new Map<unknown, unknown[]>([
      [tasksTable, taskRows],
      [projectsTable, projectRows],
    ]);
    return {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({ limit: () => Promise.resolve(byTable.get(table) ?? []) }),
        }),
      }),
    } as unknown as ScopeResolverDb;
  }

  function peezombieTaskDb(): ScopeResolverDb {
    return crossProjectDb(
      [{ id: "mt#4678", projectId: PEEZOMBIE_ID }],
      [{ id: PEEZOMBIE_ID, slug: "edobry/peezombie.me", repoUrl: PEEZOMBIE_URL }]
    );
  }

  /** Make the repo argument classifiable as a local checkout of `originUrl`. */
  function withOrigin(deps: StartSessionDependencies, originUrl: string): void {
    (deps.gitService as { execInRepository: unknown }).execInRepository = vi.fn(
      async (_dir: string, command: string) =>
        command.includes("remote get-url") ? `${originUrl}\n` : ""
    );
  }

  it("stamps the TASK's project repository on the record, not the server's (AT2)", async () => {
    // Server rooted at minsky; task mt#4678 belongs to peezombie.
    const deps = { ...createDeps(MINSKY_URL), db: peezombieTaskDb() };
    const params = { task: "mt#4678" } as unknown as SessionStartParameters;

    await startSessionImpl(params, deps);

    const added = first(deps.addSessionSpy.mock.calls as unknown[][])[0] as SessionRecord;
    // All three of AT2's assertions: record url, derived name, and project id.
    expect(added.repoUrl).toBe(PEEZOMBIE_URL);
    expect(added.repoName).toContain("peezombie");
    expect(added.projectId).toBe(PEEZOMBIE_ID);
  });

  it("clones from the forge URL, so origin is never a local path (SC3)", async () => {
    const deps = { ...createDeps(MINSKY_URL), db: peezombieTaskDb() };
    withOrigin(deps, PEEZOMBIE_URL);
    const params = {
      task: "mt#4678",
      repo: PEEZOMBIE_PATH,
    } as unknown as SessionStartParameters;

    await startSessionImpl(params, deps);

    const cloneArgs = first(
      (deps.gitService.clone as ReturnType<typeof mock>).mock.calls as unknown[][]
    )[0] as { repoUrl: string; referenceRepo?: string };

    // The local path is a FETCH source, not the origin.
    expect(cloneArgs.repoUrl).toBe(PEEZOMBIE_URL);
    expect(cloneArgs.referenceRepo).toBe(PEEZOMBIE_PATH);
  });

  it("REFUSES when the repo argument contradicts the task's project (SC1b)", async () => {
    const deps = { ...createDeps(MINSKY_URL), db: peezombieTaskDb() };
    // A local checkout of minsky, passed for a peezombie task.
    withOrigin(deps, MINSKY_URL);
    const params = {
      task: "mt#4678",
      repo: "/Users/edobry/Projects/minsky",
    } as unknown as SessionStartParameters;

    await expect(startSessionImpl(params, deps)).rejects.toThrow(/edobry\/peezombie\.me/);
    // Nothing half-built: the refusal happens in the precondition phase.
    expect(deps.addSessionSpy.mock.calls.length).toBe(0);
  });

  it("leaves the same-project case unchanged, with and without an explicit repo (AT4)", async () => {
    const minskyId = "3ac3d147-2b6f-4cf9-a52a-2b6e32d3c5fe";
    const sameProjectDb = () =>
      crossProjectDb(
        [{ id: "mt#4758", projectId: minskyId }],
        [{ id: minskyId, slug: "edobry/minsky", repoUrl: MINSKY_URL }]
      );

    const bare = { ...createDeps(MINSKY_URL), db: sameProjectDb() };
    await startSessionImpl({ task: "mt#4758" } as unknown as SessionStartParameters, bare);
    const bareAdded = first(bare.addSessionSpy.mock.calls as unknown[][])[0] as SessionRecord;
    expect(bareAdded.repoUrl).toBe(MINSKY_URL);
    expect(bareAdded.projectId).toBe(minskyId);

    const withRepo = { ...createDeps(MINSKY_URL), db: sameProjectDb() };
    withOrigin(withRepo, MINSKY_URL);
    await startSessionImpl(
      {
        task: "mt#4758",
        repo: "/Users/edobry/Projects/minsky",
      } as unknown as SessionStartParameters,
      withRepo
    );
    const repoAdded = first(withRepo.addSessionSpy.mock.calls as unknown[][])[0] as SessionRecord;
    expect(repoAdded.repoUrl).toBe(MINSKY_URL);
    expect(repoAdded.projectId).toBe(minskyId);
  });

  it("falls back to config identity when the task carries no project (fail-open)", async () => {
    const deps = {
      ...createDeps(MINSKY_URL),
      db: crossProjectDb([{ id: "mt#4758", projectId: null }], []),
    };

    await startSessionImpl({ task: "mt#4758" } as unknown as SessionStartParameters, deps);

    const added = first(deps.addSessionSpy.mock.calls as unknown[][])[0] as SessionRecord;
    expect(added.repoUrl).toBe(MINSKY_URL);
  });
});
