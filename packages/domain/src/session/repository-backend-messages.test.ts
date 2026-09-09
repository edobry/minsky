/**
 * The forge-support errors must name an ACTION, not a config key (mt#5015 SC4).
 *
 * The originating defect was not only unhelpfulness: a user with a local remote
 * got a doubled sentence whose outer half was false, because the
 * not-a-GitHub-remote error was thrown inside the `try` that wraps the remote
 * lookup and its own `catch` re-wrapped it. These assert both halves — that the
 * text is actionable, and that the two cases are no longer conflated.
 */

import { describe, test, expect } from "bun:test";
import { isGitHubRemoteUrl, resolveRepositoryAndBackend } from "./repository-backend-detection";

/** A representative GitHub origin, shared so the assertions cannot drift apart. */
const GITHUB_ORIGIN = "git@github.com:edobry/minsky.git";

/** Deps driving the "remote exists and is X" branch. */
function depsWithRemote(remoteUrl: string, defaultBackend = "github") {
  return {
    isInsideGitWorkTree: () => true,
    execGit: () => remoteUrl,
    getConfiguration: () => ({ repository: { default_repo_backend: defaultBackend } }),
  } as never;
}

/** Deps driving the "the remote lookup itself failed" branch. */
function depsWithNoRemote() {
  return {
    isInsideGitWorkTree: () => true,
    execGit: () => {
      throw new Error("fatal: No such remote 'origin'");
    },
    getConfiguration: () => ({ repository: { default_repo_backend: "github" } }),
  } as never;
}

async function messageFrom(deps: never): Promise<string> {
  try {
    await resolveRepositoryAndBackend({}, deps);
    throw new Error("expected resolveRepositoryAndBackend to throw, but it resolved");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("isGitHubRemoteUrl", () => {
  test("accepts the GitHub forms a real origin takes", () => {
    expect(isGitHubRemoteUrl(GITHUB_ORIGIN)).toBe(true);
    expect(isGitHubRemoteUrl("https://github.com/edobry/minsky.git")).toBe(true);
  });

  test("rejects a local filesystem path — the mt#5012 cold-run case", () => {
    expect(isGitHubRemoteUrl("/Users/edobry/Projects/konfigure")).toBe(false);
  });

  test("rejects other forges, which are config-plumbing only", () => {
    expect(isGitHubRemoteUrl("git@gitlab.com:acme/thing.git")).toBe(false);
    expect(isGitHubRemoteUrl("https://bitbucket.org/acme/thing.git")).toBe(false);
  });
});

describe("mt#5015 SC4 — a non-GitHub remote gets one true, actionable sentence", () => {
  const LOCAL = "/Users/edobry/Projects/konfigure";

  test("names the offending remote", async () => {
    expect(await messageFrom(depsWithRemote(LOCAL))).toContain(LOCAL);
  });

  test("names an action the user can take, not just a config key", async () => {
    const message = await messageFrom(depsWithRemote(LOCAL));
    expect(message).toContain("git remote set-url origin");
    expect(message).not.toContain("repository.default_repo_backend=github");
  });

  test("says what still works, so the user knows the tool is not simply broken", async () => {
    expect(await messageFrom(depsWithRemote(LOCAL))).toContain("tracking tasks works");
  });

  test("no longer claims detection FAILED, because it succeeded", async () => {
    // The pre-fix text was "could not detect GitHub remote: ..." — false here.
    expect(await messageFrom(depsWithRemote(LOCAL))).not.toContain("could not detect");
  });

  test("is not the doubled sentence the catch used to produce", async () => {
    const message = await messageFrom(depsWithRemote(LOCAL));
    const occurrences = message.split("Minsky sessions need a GitHub remote").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("mt#5015 SC4 — a missing remote is a DIFFERENT message from a non-GitHub one", () => {
  test("names adding a remote, which is the action for this case", async () => {
    const message = await messageFrom(depsWithNoRemote());
    expect(message).toContain("git remote add origin");
    expect(message).toContain("no 'origin' remote");
  });

  test("does not tell the user to re-point a remote they do not have", async () => {
    expect(await messageFrom(depsWithNoRemote())).not.toContain("git remote set-url");
  });
});

describe("mt#5015 SC4 — the non-GitHub default backend names the setting truthfully", () => {
  test("reports the value actually configured and says to remove it", async () => {
    const message = await messageFrom(depsWithRemote("git@github.com:a/b.git", "gitlab"));
    expect(message).toContain("'gitlab'");
    expect(message).toContain("Remove that setting");
  });

  test("no longer instructs setting the key to github as if that were the fix", async () => {
    const message = await messageFrom(depsWithRemote("git@github.com:a/b.git", "gitlab"));
    expect(message).not.toContain("Configure repository.default_repo_backend=github");
  });
});

describe("mt#5015 AT3 — a GitHub remote is unaffected", () => {
  test("resolves normally with no error", async () => {
    const result = await resolveRepositoryAndBackend({}, depsWithRemote(GITHUB_ORIGIN));
    expect(result.repoUrl).toBe(GITHUB_ORIGIN);
  });
});
