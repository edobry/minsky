/**
 * Tests for the App-token-push-denied (403) automatic-fallback path
 * (mt#3210).
 *
 * Root cause established via a live `GET /app` read against the
 * `minsky-ai[bot]` App (`setup_github-app --update --name minsky-app
 * --permissions ... ` dry-run, 2026-07-25): the installation's `contents`
 * permission resolves to `"read"`, not `"write"` — so every App-token push
 * is denied (403) regardless of token freshness, matching the 8-of-8
 * observed rate in the task spec and mem#721's finding that a freshly-minted
 * token is denied identically to a stale one.
 *
 * This differs from mt#2897's `resolvePushCredential` fallback (covered in
 * session-commit-push-credential.test.ts): that fallback fires when token
 * *minting* throws. Here, minting succeeds — the push attempt itself is
 * denied — a failure mode `resolvePushCredential` alone cannot see, since it
 * never attempts a push. `pushSessionCommitWithFallback` wraps both credential
 * resolution AND the push attempt so it can catch this class too.
 *
 * Acceptance tests exercised here (mt#3210):
 *   - A forced App-token failure results in a successful push via fallback,
 *     not a returned error, and logs which path was taken.
 *   - The `session.commit.push_credential_fallback` warning path is
 *     exercised by a test (extended to the push-denied case).
 */

import { describe, test, expect } from "bun:test";
import { isPermissionDeniedPushError, pushSessionCommitWithFallback } from "./session-commands";
import type { TokenProvider } from "../auth/token-provider";
import type { PushWithConfirmationResult } from "../git/push-operations";

// Real 403 denial text observed in the field (task spec + mem#721).
const REAL_403_MESSAGE =
  "remote: Permission to edobry/minsky.git denied to minsky-ai[bot].\n" +
  "fatal: unable to access 'https://github.com/edobry/minsky.git/': " +
  "The requested URL returned error: 403";

// The real server-side rejection text from mt#3264's originating incident
// (2026-07-26). Structurally unlike REAL_403_MESSAGE: a REF rejection, not an
// HTTP auth failure — no 403, no "denied".
const WORKFLOWS_REJECTION_MESSAGE =
  "! [remote rejected]  task/mt-3223 -> task/mt-3223\n" +
  "   (refusing to allow a GitHub App to create or update workflow " +
  "`.github/workflows/deploy-reviewer.yml` without `workflows` permission)\n" +
  "error: failed to push some refs to 'https://github.com/edobry/minsky.git'";

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

// ---------------------------------------------------------------------------
// isPermissionDeniedPushError
// ---------------------------------------------------------------------------

describe("isPermissionDeniedPushError", () => {
  test("matches the real observed 403 denial text", () => {
    expect(isPermissionDeniedPushError(REAL_403_MESSAGE)).toBe(true);
  });

  test("does NOT match a bare 403 status line without the permission-denial phrase (R1)", () => {
    // A 403 alone can mean an INTENTIONAL denial unrelated to the missing
    // contents:write gap (branch protection, another repo-level restriction).
    // Falling back to keychain credentials on a bare 403 would silently
    // convert a deliberate block into a successful push under a different
    // identity — see the dedicated branch-protection test below.
    expect(isPermissionDeniedPushError("The requested URL returned error: 403")).toBe(false);
  });

  test("does NOT match a 403 that is a DIFFERENT, intentional denial — e.g. branch protection (R1)", () => {
    const branchProtection403 =
      "remote: error: GH006: Protected branch update failed for refs/heads/main.\n" +
      "remote: Cannot push to this branch — required status checks have not passed.\n" +
      "fatal: unable to access 'https://github.com/edobry/minsky.git/': The requested URL returned error: 403";
    expect(isPermissionDeniedPushError(branchProtection403)).toBe(false);
  });

  test("does NOT match a bare permission-denied phrase without a 403 status code", () => {
    // e.g. an SSH-key denial ("Permission denied (publickey).") is a
    // different failure class entirely (auth transport, not the App's
    // contents:write gap) and correctly falls outside this detector.
    expect(isPermissionDeniedPushError("Permission to owner/repo.git denied to some-bot")).toBe(
      false
    );
  });

  test("does not match an unrelated push failure (non-fast-forward)", () => {
    expect(
      isPermissionDeniedPushError(
        "Push was rejected by the remote. You may need to pull or use --force."
      )
    ).toBe(false);
  });

  test("does not match a network error", () => {
    expect(isPermissionDeniedPushError("fatal: unable to access: Could not resolve host")).toBe(
      false
    );
  });

  test("returns false for undefined", () => {
    expect(isPermissionDeniedPushError(undefined)).toBe(false);
  });

  test("does NOT match the workflows-permission rejection (mt#3264)", () => {
    // The rejection mt#3264 is named for. It carries the word "permission" but
    // neither "denied" nor a 403, because it is a server-side REF rejection
    // rather than an HTTP auth failure. Not matching is CORRECT — see the
    // fallback test below for why widening this would be the wrong fix.
    expect(isPermissionDeniedPushError(WORKFLOWS_REJECTION_MESSAGE)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pushSessionCommitWithFallback
// ---------------------------------------------------------------------------

describe("pushSessionCommitWithFallback", () => {
  test("app-token push denied (403) → retries via keychain, succeeds, logs which path was taken", async () => {
    const spy = makeWarnSpy();
    const calls: Array<{ authToken?: string }> = [];

    const pushFromParamsWithConfirmation = async (params: {
      repo?: string;
      authToken?: string;
    }): Promise<PushWithConfirmationResult> => {
      calls.push({ authToken: params.authToken });
      if (params.authToken) {
        // First attempt: app-token path — denied.
        return { workdir: params.repo ?? "", pushed: false, pushError: REAL_403_MESSAGE };
      }
      // Retry: no authToken — keychain path — succeeds.
      return { workdir: params.repo ?? "", pushed: true };
    };

    const result = await pushSessionCommitWithFallback(
      makeStubTokenProvider({ configured: true }),
      { repo: "/tmp/fake-repo", branch: "task/mt-3210" },
      { pushTimeoutMs: 5000, session: "fallback-test-session" },
      { pushFromParamsWithConfirmation, warn: spy.warn }
    );

    // Two attempts: app-token (denied), then keychain (succeeded).
    expect(calls.length).toBe(2);
    expect(calls[0]?.authToken).toBe("stub-app-token");
    expect(calls[1]?.authToken).toBeUndefined();

    // Not a returned error — a successful push via fallback.
    expect(result.pushed).toBe(true);
    expect(result.credentialPath).toBe("keychain-fallback");
    expect(result.appTokenPushError).toBe(REAL_403_MESSAGE);

    // Logs which path was taken: structured warning, same event vocabulary
    // as mt#2897's token-resolution-failure fallback.
    expect(spy.calls.length).toBe(1);
    const call = spy.calls[0];
    expect(call?.context?.event).toBe("session.commit.push_credential_fallback");
    expect(call?.context?.session).toBe("fallback-test-session");
    expect(call?.context?.reason).toBe(REAL_403_MESSAGE);
  });

  test("app-token push denied AND keychain retry also fails → reports the retry's outcome, preserves original denial", async () => {
    const spy = makeWarnSpy();

    const pushFromParamsWithConfirmation = async (params: {
      authToken?: string;
    }): Promise<PushWithConfirmationResult> => {
      if (params.authToken) {
        return { workdir: "", pushed: false, pushError: REAL_403_MESSAGE };
      }
      return { workdir: "", pushed: false, pushError: "keychain also failed: no credentials" };
    };

    const result = await pushSessionCommitWithFallback(
      makeStubTokenProvider({ configured: true }),
      { repo: "/tmp/fake-repo" },
      { pushTimeoutMs: 5000 },
      { pushFromParamsWithConfirmation, warn: spy.warn }
    );

    expect(result.pushed).toBe(false);
    expect(result.pushError).toBe("keychain also failed: no credentials");
    expect(result.appTokenPushError).toBe(REAL_403_MESSAGE);
    expect(result.credentialPath).toBe("keychain-fallback");
    expect(spy.calls.length).toBe(1);
  });

  test("app-token push fails for a NON-permission reason → no retry, original outcome surfaced as-is", async () => {
    const spy = makeWarnSpy();
    const calls: Array<{ authToken?: string }> = [];

    const pushFromParamsWithConfirmation = async (params: {
      authToken?: string;
    }): Promise<PushWithConfirmationResult> => {
      calls.push({ authToken: params.authToken });
      return {
        workdir: "",
        pushed: false,
        pushError: "Push was rejected by the remote. You may need to pull or use --force.",
      };
    };

    const result = await pushSessionCommitWithFallback(
      makeStubTokenProvider({ configured: true }),
      { repo: "/tmp/fake-repo" },
      { pushTimeoutMs: 5000 },
      { pushFromParamsWithConfirmation, warn: spy.warn }
    );

    // Only ONE attempt — no blind retry on an unrelated failure.
    expect(calls.length).toBe(1);
    expect(result.pushed).toBe(false);
    expect(result.credentialPath).toBe("app-token");
    expect(result.appTokenPushError).toBeUndefined();

    // mt#3264 changed this deliberately: the declined fallback used to be
    // SILENT, which read the same in the logs as a fallback that never ran.
    // The behavior under test — one attempt, outcome surfaced as-is — is
    // unchanged; only its observability is new.
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0]?.context?.event).toBe("session.commit.push_fallback_declined");
  });

  test("app-token push TIMES OUT (ambiguous) → no retry, mt#3177's own remote-check handling is left alone", async () => {
    const spy = makeWarnSpy();
    const calls: Array<{ authToken?: string }> = [];

    const pushFromParamsWithConfirmation = async (params: {
      authToken?: string;
    }): Promise<PushWithConfirmationResult> => {
      calls.push({ authToken: params.authToken });
      return { workdir: "", pushed: false, pushTimedOut: true, pushUnconfirmed: true };
    };

    const result = await pushSessionCommitWithFallback(
      makeStubTokenProvider({ configured: true }),
      { repo: "/tmp/fake-repo" },
      { pushTimeoutMs: 5000 },
      { pushFromParamsWithConfirmation, warn: spy.warn }
    );

    expect(calls.length).toBe(1);
    expect(result.pushTimedOut).toBe(true);
    expect(result.pushUnconfirmed).toBe(true);
    expect(result.credentialPath).toBe("app-token");
    expect(spy.calls.length).toBe(0);
  });

  test("no service account configured (keychain-unconfigured) → no retry logic engages even on a 403-shaped failure", async () => {
    const spy = makeWarnSpy();
    const calls: Array<{ authToken?: string }> = [];

    const pushFromParamsWithConfirmation = async (params: {
      authToken?: string;
    }): Promise<PushWithConfirmationResult> => {
      calls.push({ authToken: params.authToken });
      return { workdir: "", pushed: false, pushError: REAL_403_MESSAGE };
    };

    const result = await pushSessionCommitWithFallback(
      undefined,
      { repo: "/tmp/fake-repo" },
      { pushTimeoutMs: 5000 },
      { pushFromParamsWithConfirmation, warn: spy.warn }
    );

    // No token was ever available to retry away from — one attempt only.
    expect(calls.length).toBe(1);
    expect(result.credentialPath).toBe("keychain-unconfigured");
    expect(result.pushed).toBe(false);
    expect(spy.calls.length).toBe(0);
  });

  test("app-token push succeeds on the first attempt → no retry, no warning", async () => {
    const spy = makeWarnSpy();
    const calls: Array<{ authToken?: string }> = [];

    const pushFromParamsWithConfirmation = async (params: {
      authToken?: string;
    }): Promise<PushWithConfirmationResult> => {
      calls.push({ authToken: params.authToken });
      return { workdir: "", pushed: true };
    };

    const result = await pushSessionCommitWithFallback(
      makeStubTokenProvider({ configured: true }),
      { repo: "/tmp/fake-repo" },
      { pushTimeoutMs: 5000 },
      { pushFromParamsWithConfirmation, warn: spy.warn }
    );

    expect(calls.length).toBe(1);
    expect(result.pushed).toBe(true);
    expect(result.credentialPath).toBe("app-token");
    expect(result.appTokenPushError).toBeUndefined();
    expect(spy.calls.length).toBe(0);
  });

  test("workflows-permission rejection → NO keychain retry, reason surfaced, decision logged (mt#3264)", async () => {
    // A regression guard on a deliberate design decision, not just on behavior.
    // mt#3264's spec originally proposed WIDENING the fallback trigger to cover
    // rejections like this one. That would swap the pushing identity from the
    // App to the local keychain on any server-side block — the conflation the
    // accepted dual-identity decision record rules out, and the same reason
    // mem#721 gives for keeping the detector narrow. If someone widens the
    // trigger, `calls.length` becomes 2 and this fails.
    const spy = makeWarnSpy();
    const calls: Array<{ authToken?: string }> = [];

    const pushFromParamsWithConfirmation = async (params: {
      repo?: string;
      authToken?: string;
    }): Promise<PushWithConfirmationResult> => {
      calls.push({ authToken: params.authToken });
      return {
        workdir: params.repo ?? "",
        pushed: false,
        pushError: WORKFLOWS_REJECTION_MESSAGE,
      };
    };

    const result = await pushSessionCommitWithFallback(
      makeStubTokenProvider({ configured: true }),
      { repo: "/tmp/fake-repo" },
      { pushTimeoutMs: 5000 },
      { pushFromParamsWithConfirmation, warn: spy.warn }
    );

    // Exactly one attempt: no silent retry under a different identity.
    expect(calls.length).toBe(1);
    expect(calls[0]?.authToken).toBe("stub-app-token");

    // The caller can see WHY, and which credential produced it.
    expect(result.pushed).toBe(false);
    expect(result.credentialPath).toBe("app-token");
    expect(result.pushError).toContain("without `workflows` permission");

    // The declined fallback is legible rather than silent.
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0]?.context?.event).toBe("session.commit.push_fallback_declined");
    expect(spy.calls[0]?.context?.reason).toContain("without `workflows` permission");
  });

  test("a timed-out app-token push does not log the declined-fallback decision (mt#3264)", async () => {
    // A timeout is not a rejection — there is no reason to report and nothing
    // was declined. Keeps the new log from firing on mt#3556's failure mode,
    // where the pre-push gate outruns the push budget.
    const spy = makeWarnSpy();

    const pushFromParamsWithConfirmation = async (params: {
      repo?: string;
    }): Promise<PushWithConfirmationResult> => ({
      workdir: params.repo ?? "",
      pushed: false,
      pushTimedOut: true,
      pushUnconfirmed: true,
    });

    const result = await pushSessionCommitWithFallback(
      makeStubTokenProvider({ configured: true }),
      { repo: "/tmp/fake-repo" },
      { pushTimeoutMs: 5000 },
      { pushFromParamsWithConfirmation, warn: spy.warn }
    );

    expect(result.pushUnconfirmed).toBe(true);
    expect(result.credentialPath).toBe("app-token");
    expect(spy.calls.length).toBe(0);
  });
});
