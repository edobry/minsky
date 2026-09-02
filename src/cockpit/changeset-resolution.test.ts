/**
 * Tests for the changeset resolution rules (mt#4724).
 *
 * The two-project fixture below is the whole point: before this change the
 * session scan took the FIRST row whose `pullRequest.number` matched, so with
 * two projects each holding a PR #1 the detail page rendered whichever one the
 * store happened to return first.
 */
import { describe, test, expect } from "bun:test";
import type { SessionRecord } from "@minsky/domain/session/types";
import { resolveChangesetRepoSource, selectSessionForChangeset } from "./changeset-resolution";

const MINSKY_SESSION = "minsky-session";
const PEEZOMBIE_SESSION = "peezombie-session";
const MINSKY_REPO = { owner: "edobry", repo: "minsky" };
const PEEZOMBIE_REPO = { owner: "edobry", repo: "peezombie.me" };

function session(overrides: Partial<SessionRecord> & { sessionId: string }): SessionRecord {
  return {
    repoName: "repo",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: "2026-08-29T00:00:00.000Z",
    ...overrides,
  } as SessionRecord;
}

/** Two projects, each with a PR #1 — the collision this task exists to resolve. */
const TWO_PROJECT_SESSIONS: SessionRecord[] = [
  session({
    sessionId: MINSKY_SESSION,
    repoUrl: "https://github.com/edobry/minsky.git",
    pullRequest: { number: 1, state: "open" } as SessionRecord["pullRequest"],
  }),
  session({
    sessionId: PEEZOMBIE_SESSION,
    repoUrl: "https://github.com/edobry/peezombie.me.git",
    pullRequest: { number: 1, state: "open" } as SessionRecord["pullRequest"],
  }),
];

describe("resolveChangesetRepoSource", () => {
  test("a qualified id names its own repo and outranks both other qualifiers", () => {
    expect(
      resolveChangesetRepoSource({
        changesetId: "edobry/peezombie.me#1",
        projectRepo: MINSKY_REPO,
        defaultRepo: MINSKY_REPO,
      })
    ).toEqual({ prNumber: 1, repo: PEEZOMBIE_REPO, source: "qualified-id" });
  });

  test("a bare id with ?project= resolves against that project", () => {
    expect(
      resolveChangesetRepoSource({
        changesetId: "1",
        projectRepo: PEEZOMBIE_REPO,
        defaultRepo: MINSKY_REPO,
      })
    ).toEqual({ prNumber: 1, repo: PEEZOMBIE_REPO, source: "project-param" });
  });

  test("a bare id with no project qualifier resolves against the DEFAULT repo", () => {
    // The back-compat rule: this is what every already-emitted
    // `minsky://changeset/<n>` link has always meant.
    expect(
      resolveChangesetRepoSource({
        changesetId: "3423",
        projectRepo: null,
        defaultRepo: MINSKY_REPO,
      })
    ).toEqual({ prNumber: 3423, repo: MINSKY_REPO, source: "default" });
  });

  test("with no default configured the repo is UNKNOWN rather than invented", () => {
    expect(
      resolveChangesetRepoSource({ changesetId: "7", projectRepo: null, defaultRepo: null })
    ).toEqual({ prNumber: 7, repo: null, source: "default" });
  });

  test("a malformed id resolves to null (the route is the authoritative gate)", () => {
    for (const changesetId of ["abc", "0", "owner/repo", ""]) {
      expect(
        resolveChangesetRepoSource({ changesetId, projectRepo: null, defaultRepo: MINSKY_REPO })
      ).toBeNull();
    }
  });
});

describe("selectSessionForChangeset — two projects sharing PR #1", () => {
  test("picks the session in the NAMED repo, not the first match", () => {
    expect(selectSessionForChangeset(TWO_PROJECT_SESSIONS, 1, PEEZOMBIE_REPO)?.sessionId).toBe(
      PEEZOMBIE_SESSION
    );
    expect(selectSessionForChangeset(TWO_PROJECT_SESSIONS, 1, MINSKY_REPO)?.sessionId).toBe(
      MINSKY_SESSION
    );
  });

  test("order-independent — reversing the store's return order changes nothing", () => {
    const reversed = [...TWO_PROJECT_SESSIONS].reverse();
    expect(selectSessionForChangeset(reversed, 1, PEEZOMBIE_REPO)?.sessionId).toBe(
      PEEZOMBIE_SESSION
    );
  });

  test("a repo with no matching session yields null, never another project's row", () => {
    expect(
      selectSessionForChangeset(TWO_PROJECT_SESSIONS, 1, { owner: "someone", repo: "else" })
    ).toBeNull();
  });

  test("ssh remotes match the same repo as https ones", () => {
    const ssh = [
      session({
        sessionId: "ssh-session",
        repoUrl: "git@github.com:edobry/peezombie.me.git",
        pullRequest: { number: 1, state: "open" } as SessionRecord["pullRequest"],
      }),
    ];
    expect(selectSessionForChangeset(ssh, 1, PEEZOMBIE_REPO)?.sessionId).toBe("ssh-session");
  });
});

describe("selectSessionForChangeset — degradation", () => {
  test("no candidate at all yields null", () => {
    expect(selectSessionForChangeset(TWO_PROJECT_SESSIONS, 99, MINSKY_REPO)).toBeNull();
  });

  test("an UNKNOWN repo preserves the pre-mt#4724 first-match behavior", () => {
    expect(selectSessionForChangeset(TWO_PROJECT_SESSIONS, 1, null)?.sessionId).toBe(
      MINSKY_SESSION
    );
  });

  test("a lone candidate with an unparseable remote is still returned (no enrichment regression)", () => {
    const local = [
      session({
        sessionId: "local-session",
        repoUrl: "/Users/edobry/Projects/minsky",
        pullRequest: { number: 4, state: "open" } as SessionRecord["pullRequest"],
      }),
    ];
    expect(selectSessionForChangeset(local, 4, MINSKY_REPO)?.sessionId).toBe("local-session");
  });

  test("SEVERAL unparseable candidates are ambiguous — null, not a coin flip", () => {
    const local = [
      session({
        sessionId: "local-a",
        repoUrl: "/path/a",
        pullRequest: { number: 4, state: "open" } as SessionRecord["pullRequest"],
      }),
      session({
        sessionId: "local-b",
        repoUrl: "/path/b",
        pullRequest: { number: 4, state: "open" } as SessionRecord["pullRequest"],
      }),
    ];
    expect(selectSessionForChangeset(local, 4, MINSKY_REPO)).toBeNull();
  });
});
