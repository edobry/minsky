/**
 * Tests for the push credential-resolution path in sessionCommit (mt#2897).
 *
 * Acceptance tests from mt#2897:
 *   1. Token-resolution failure → structured warning emitted
 *      (event: "session.commit.push_credential_fallback" + failure reason) AND
 *      the commit result marks credentialPath="keychain-fallback"; the success
 *      path is unchanged (credentialPath="app-token", token used for push).
 *   2. No service account configured → credentialPath="keychain-unconfigured"
 *      with NO warning — keychain is the expected path there, not a failure.
 *
 * Strategy mirrors session-commit-no-files.test.ts: the sessionCommit
 * integration tests use real temp git repos with a local bare remote, because
 * sessionCommit shells out to git. The resolvePushCredential unit tests are
 * pure and need no git.
 */

import { describe, test, expect, afterAll } from "bun:test";
// Real FS imports below are required because we need a genuine git repository
// for the integration tests to exercise the actual commit+push paths.
/* eslint-disable custom/no-real-fs-in-tests */
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
/* eslint-enable custom/no-real-fs-in-tests */
import { join } from "path";
import { execSync } from "child_process";
import { sessionCommit, resolvePushCredential } from "./session-commands";
import { FakeSessionProvider } from "./fake-session-provider";
import type { SessionRecord } from "./types";
import type { TokenProvider } from "../auth/token-provider";

// Shared expectation constants (template-literal pattern — single source of
// truth for strings asserted in more than one test).
const PATH_KEYCHAIN_UNCONFIGURED = "keychain-unconfigured";
const FALLBACK_REASON = "installation token exchange failed: 502";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Explicit-mock TokenProvider stub (all interface methods defined). */
function makeStubTokenProvider(opts: {
  configured: boolean;
  getTokenImpl?: () => Promise<string>;
}): TokenProvider {
  return {
    getToken: opts.getTokenImpl ?? (async () => "stub-app-token"),
    getServiceToken: async () => "stub-app-token",
    getUserToken: async () => "stub-user-token",
    getServiceIdentity: async () => null,
    isServiceAccountConfigured: () => opts.configured,
    isRoleConfigured: () => opts.configured,
  };
}

/** Recording warn spy — captures (message, context) pairs. */
function makeWarnSpy(): {
  warn: (message: string, context?: Record<string, unknown>) => void;
  calls: Array<{ message: string; context?: Record<string, unknown> }>;
} {
  const calls: Array<{ message: string; context?: Record<string, unknown> }> = [];
  return {
    warn: (message, context) => {
      calls.push({ message, context });
    },
    calls,
  };
}

function makeSessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    sessionId: "push-credential-test-session",
    repoName: "test-repo",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: new Date().toISOString(),
    taskId: "mt#2897",
    agentId: "com.anthropic.claude-code:proc:test-agent",
    ...overrides,
  };
}

function makeSessionProvider(record: SessionRecord, workdir: string): FakeSessionProvider {
  return new FakeSessionProvider({
    initialSessions: [record],
    sessionWorkdir: workdir,
  });
}

/** Create a temp git repo with one initial commit and a staged pending change. */
async function makeTmpDirtyGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "minsky-push-credential-test-"));
  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync("git config user.email test@example.com", { cwd: dir, stdio: "ignore" });
  execSync("git config user.name Test", { cwd: dir, stdio: "ignore" });
  execSync("git commit --allow-empty -m init", { cwd: dir, stdio: "ignore" });
  await writeFile(join(dir, "pending.txt"), "pending change"); // eslint-disable-line custom/no-real-fs-in-tests
  execSync("git add pending.txt", { cwd: dir, stdio: "ignore" });
  return dir;
}

/** Bare-clone the repo as its own origin so push succeeds locally. */
function addLocalRemote(repoDir: string): string {
  const bareDir = `${repoDir}.bare`;
  execSync(`git clone --bare "${repoDir}" "${bareDir}"`, { stdio: "ignore" });
  execSync(`git remote add origin "${bareDir}"`, { cwd: repoDir, stdio: "ignore" });
  return bareDir;
}

const tmpDirs: string[] = [];

afterAll(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {}); // eslint-disable-line custom/no-real-fs-in-tests -- cleanup for real tmp git repos created above
  }
});

// ---------------------------------------------------------------------------
// resolvePushCredential unit tests (pure — no git)
// ---------------------------------------------------------------------------

describe("resolvePushCredential", () => {
  test("no provider → keychain-unconfigured, no token, no warning", async () => {
    const spy = makeWarnSpy();
    const result = await resolvePushCredential(undefined, { warn: spy.warn });

    expect(result.credentialPath).toBe(PATH_KEYCHAIN_UNCONFIGURED);
    expect(result.authToken).toBeUndefined();
    expect(result.failureReason).toBeUndefined();
    expect(spy.calls.length).toBe(0);
  });

  test("provider present but unconfigured → keychain-unconfigured, no warning", async () => {
    const spy = makeWarnSpy();
    const result = await resolvePushCredential(makeStubTokenProvider({ configured: false }), {
      warn: spy.warn,
    });

    expect(result.credentialPath).toBe(PATH_KEYCHAIN_UNCONFIGURED);
    expect(result.authToken).toBeUndefined();
    expect(spy.calls.length).toBe(0);
  });

  test("configured provider resolves token → app-token, no warning", async () => {
    const spy = makeWarnSpy();
    const result = await resolvePushCredential(
      makeStubTokenProvider({ configured: true, getTokenImpl: async () => "ghs_live_token" }),
      { warn: spy.warn }
    );

    expect(result.credentialPath).toBe("app-token");
    expect(result.authToken).toBe("ghs_live_token");
    expect(result.failureReason).toBeUndefined();
    expect(spy.calls.length).toBe(0);
  });

  test("configured provider whose getToken throws → keychain-fallback + structured warning", async () => {
    const spy = makeWarnSpy();
    const result = await resolvePushCredential(
      makeStubTokenProvider({
        configured: true,
        getTokenImpl: async () => {
          throw new Error(FALLBACK_REASON);
        },
      }),
      { session: "warn-test-session", warn: spy.warn }
    );

    // Result marks the fallback and carries the failure reason.
    expect(result.credentialPath).toBe("keychain-fallback");
    expect(result.authToken).toBeUndefined();
    expect(result.failureReason).toBe(FALLBACK_REASON);

    // The warning is structured: stable event name + failure reason + session.
    expect(spy.calls.length).toBe(1);
    const call = spy.calls[0];
    expect(call?.message).toContain("App-token resolution failed");
    expect(call?.context?.event).toBe("session.commit.push_credential_fallback");
    expect(call?.context?.reason).toBe(FALLBACK_REASON);
    expect(call?.context?.session).toBe("warn-test-session");
  });
});

// ---------------------------------------------------------------------------
// sessionCommit integration tests (real temp git repos)
// ---------------------------------------------------------------------------

describe("sessionCommit push credential surfacing", () => {
  test("token-resolution failure → commit succeeds via keychain fallback and result marks credentialPath", async () => {
    const repoDir = await makeTmpDirtyGitRepo();
    const bareDir = addLocalRemote(repoDir);
    tmpDirs.push(repoDir, bareDir);

    const record = makeSessionRecord({ sessionId: "fallback-session" });
    const sessionProvider = makeSessionProvider(record, repoDir);
    const failingProvider = makeStubTokenProvider({
      configured: true,
      getTokenImpl: async () => {
        throw new Error("simulated token-resolution failure");
      },
    });

    const result = await sessionCommit(
      { session: "fallback-session", message: "test: fallback push", all: true },
      sessionProvider,
      undefined,
      failingProvider
    );

    expect(result.success).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.credentialPath).toBe("keychain-fallback");
  });

  test("no token provider → result marks credentialPath keychain-unconfigured (expected path)", async () => {
    const repoDir = await makeTmpDirtyGitRepo();
    const bareDir = addLocalRemote(repoDir);
    tmpDirs.push(repoDir, bareDir);

    const record = makeSessionRecord({ sessionId: "unconfigured-session" });
    const sessionProvider = makeSessionProvider(record, repoDir);

    const result = await sessionCommit(
      { session: "unconfigured-session", message: "test: keychain push", all: true },
      sessionProvider
    );

    expect(result.success).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.credentialPath).toBe(PATH_KEYCHAIN_UNCONFIGURED);
  });

  test("configured provider resolves token → success path unchanged, credentialPath app-token", async () => {
    const repoDir = await makeTmpDirtyGitRepo();
    const bareDir = addLocalRemote(repoDir);
    tmpDirs.push(repoDir, bareDir);

    const record = makeSessionRecord({ sessionId: "app-token-session" });
    const sessionProvider = makeSessionProvider(record, repoDir);
    // The auth header the token injects is scoped to github.com URLs
    // (http.https://github.com/.extraheader), so pushing to the local bare
    // remote is unaffected by the configured token.
    const workingProvider = makeStubTokenProvider({ configured: true });

    const result = await sessionCommit(
      { session: "app-token-session", message: "test: app-token push", all: true },
      sessionProvider,
      undefined,
      workingProvider
    );

    expect(result.success).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.credentialPath).toBe("app-token");
  });
});
