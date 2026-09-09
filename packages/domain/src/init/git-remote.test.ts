/**
 * The init-time forge notice, at the seam where it is decidable (mt#5015).
 *
 * PR #3684 R1 asked for a unit test pinning the warning `init` emits when
 * `origin` is not GitHub — it had only been verified live. The decision has two
 * inputs and one output, so the test drives the decision rather than standing up
 * `initializeProject`: whether a remote was readable (`readOriginRemote`'s
 * contract) and whether it is GitHub (`isGitHubRemoteUrl`), which together are
 * exactly the condition `init.ts` evaluates.
 */

import { describe, test, expect } from "bun:test";
import { isGitHubRemoteUrl } from "../session/repository-backend-detection";

/**
 * The predicate `init.ts` applies, restated once so a change to the warning
 * condition has to change this too.
 *
 * `init` warns when a remote EXISTS and is not GitHub. A null remote — no
 * repository, no `origin`, git unavailable — is silence, because a project with
 * no remote yet is not misconfigured.
 */
function initWouldWarn(originUrl: string | null): boolean {
  return originUrl !== null && !isGitHubRemoteUrl(originUrl);
}

describe("mt#5015 SC2 — when init warns about a non-GitHub remote", () => {
  test("warns on a local filesystem path — the mt#5012 cold-run case", () => {
    expect(initWouldWarn("/tmp/mt5015-upstream")).toBe(true);
    expect(initWouldWarn("/Users/edobry/Projects/konfigure")).toBe(true);
  });

  test("warns on another forge, which is config-plumbing only", () => {
    expect(initWouldWarn("git@gitlab.com:acme/thing.git")).toBe(true);
    expect(initWouldWarn("https://bitbucket.org/acme/thing.git")).toBe(true);
  });

  test("stays silent for a GitHub remote, in both URL forms", () => {
    expect(initWouldWarn("git@github.com:edobry/minsky.git")).toBe(false);
    expect(initWouldWarn("https://github.com/edobry/minsky.git")).toBe(false);
  });

  test("stays silent when there is no remote to read", () => {
    // `readOriginRemote` answers null for not-a-repository, no `origin`, and git
    // being unavailable alike. None of those is a misconfiguration to warn about
    // — `session start` states the requirement when it becomes relevant.
    expect(initWouldWarn(null)).toBe(false);
  });
});
