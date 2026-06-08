/**
 * Regression tests for mt#1430 — `changeset_list`/`changeset_search`/`get`/`info`
 * threw "GitHubChangesetAdapter requires sessionProvider in deps" because the
 * adapter required `deps.sessionProvider` EAGERLY at construction, while the
 * factory (`GitHubChangesetAdapterFactory.createAdapter`) constructs it with no
 * deps. Read operations (list/search/get) use Octokit directly and never need a
 * sessionProvider; only the mutation methods do. The fix makes the dependency
 * lazy: construction succeeds without a provider, and the "requires sessionProvider"
 * error is raised only if a session-dependent operation actually runs.
 *
 * These tests avoid the network (Octokit) by exercising construction and the
 * private session-provider resolver directly.
 */

import { describe, expect, test } from "bun:test";

import { GitHubChangesetAdapter, GitHubChangesetAdapterFactory } from "./github-adapter";
import type { SessionProviderInterface } from "../../session/index";
import { MinskyError } from "../../errors/index";

const REPO_URL = "https://github.com/edobry/minsky";

/** Minimal stand-in; only stored/returned by the resolver, never invoked here. */
const FAKE_SESSION_PROVIDER = { __brand: "fake" } as unknown as SessionProviderInterface;

describe("GitHubChangesetAdapter sessionProvider (mt#1430)", () => {
  test("constructs WITHOUT a sessionProvider (regression — previously threw)", () => {
    expect(() => new GitHubChangesetAdapter(REPO_URL)).not.toThrow();
    expect(() => new GitHubChangesetAdapter(REPO_URL, {})).not.toThrow();
  });

  test("constructs WITH a sessionProvider", () => {
    expect(
      () => new GitHubChangesetAdapter(REPO_URL, {}, { sessionProvider: FAKE_SESSION_PROVIDER })
    ).not.toThrow();
  });

  test("the factory's createAdapter no longer throws (the actual broken path)", async () => {
    const factory = new GitHubChangesetAdapterFactory();
    const adapter = await factory.createAdapter(REPO_URL);
    expect(adapter.platform).toBe("github-pr");
  });

  test("a session-dependent operation errors clearly when no provider was given", async () => {
    const adapter = new GitHubChangesetAdapter(REPO_URL, {});
    // White-box: reach the private resolver a mutation method would call.
    const getSessionProvider = (
      adapter as unknown as { getSessionProvider: () => Promise<SessionProviderInterface> }
    ).getSessionProvider.bind(adapter);
    await expect(getSessionProvider()).rejects.toThrow(MinskyError);
    await expect(getSessionProvider()).rejects.toThrow(/requires a sessionProvider/i);
  });

  test("a session-dependent operation resolves the injected provider", async () => {
    const adapter = new GitHubChangesetAdapter(
      REPO_URL,
      {},
      { sessionProvider: FAKE_SESSION_PROVIDER }
    );
    const getSessionProvider = (
      adapter as unknown as { getSessionProvider: () => Promise<SessionProviderInterface> }
    ).getSessionProvider.bind(adapter);
    await expect(getSessionProvider()).resolves.toBe(FAKE_SESSION_PROVIDER);
  });
});
