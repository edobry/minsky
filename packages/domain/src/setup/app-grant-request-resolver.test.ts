/**
 * Tests for the App-grant resolver shell and its coverage oracle (mt#4693).
 *
 * The oracle is the piece with real logic — it batches per role, handles an
 * installation set to "all repositories" (which enumerates nothing), and must
 * report a probe FAILURE as silence rather than as absence. Deps are injected,
 * so these exercise the real orchestration against fakes: no network, no
 * database, no patched module.
 */
import { describe, it, expect } from "bun:test";

import type { AppGrantRequestPayload } from "@minsky/shared/app-grant-request";
import type { Ask } from "../ask/types";
import type { GitHubAppTokenProvider } from "../auth/github-app-token-provider";
import type { TokenRole } from "../auth/token-provider";
import { APP_GRANT_REQUEST_METADATA_KEY } from "./app-grant-request";
import {
  createAppCoverageOracle,
  resolveSatisfiedAppGrantRequests,
} from "./app-grant-request-resolver";

/** The originating ungranted repo (mt#4680). */
const UNGRANTED_REPO = "edobry/peezombie.me";

const IMPL: AppGrantRequestPayload = {
  repo: UNGRANTED_REPO,
  role: "implementer",
  slug: "minsky-ai",
};
const REVIEW: AppGrantRequestPayload = {
  repo: UNGRANTED_REPO,
  role: "reviewer",
  slug: "minsky-reviewer",
};

function fakeProvider(opts: {
  configured?: TokenRole[];
  coverage: Partial<
    Record<TokenRole, () => Promise<{ repositories: string[]; selection: "all" | "selected" }>>
  >;
  onFetch?: (role: TokenRole | undefined) => void;
}) {
  const configured = opts.configured ?? ["implementer", "reviewer"];
  return {
    isRoleConfigured: (role: TokenRole) => configured.includes(role),
    getInstallationCoverage: async (role?: TokenRole) => {
      opts.onFetch?.(role);
      const impl = opts.coverage[role ?? "implementer"];
      if (!impl) throw new Error(`no stub for ${role}`);
      return impl();
    },
  } as unknown as GitHubAppTokenProvider;
}

function grantAsk(id: string, payload: AppGrantRequestPayload, state: Ask["state"]): Ask {
  return {
    id,
    kind: "authorization.approve",
    classifierVersion: "v1.0.0",
    state,
    requestor: "test",
    title: "t",
    question: "q",
    createdAt: new Date("2026-08-27T00:00:00Z"),
    metadata: { [APP_GRANT_REQUEST_METADATA_KEY]: payload },
  } as unknown as Ask;
}

describe("createAppCoverageOracle (mt#4693)", () => {
  it("issues ONE coverage fetch per distinct role, not one per request", async () => {
    const fetches: (TokenRole | undefined)[] = [];
    const oracle = createAppCoverageOracle(
      fakeProvider({
        onFetch: (role) => fetches.push(role),
        coverage: {
          implementer: async () => ({ repositories: [], selection: "selected" }),
          reviewer: async () => ({ repositories: [], selection: "selected" }),
        },
      })
    );

    await oracle([IMPL, { ...IMPL, repo: "edobry/other" }, REVIEW]);

    expect(fetches).toHaveLength(2);
    expect(new Set(fetches)).toEqual(new Set(["implementer", "reviewer"]));
  });

  it("reports an 'all repositories' installation as covering — it enumerates nothing", async () => {
    // The case that shaped the oracle interface: a universe-listing oracle would
    // see an empty repository list and report the pending repo as absent.
    const oracle = createAppCoverageOracle(
      fakeProvider({
        coverage: { implementer: async () => ({ repositories: [], selection: "all" }) },
      })
    );

    const signals = await oracle([IMPL]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ present: true });
    expect(signals[0]?.detail).toContain("all repositories");
  });

  it("emits nothing for a repo that is still not covered", async () => {
    const oracle = createAppCoverageOracle(
      fakeProvider({
        coverage: {
          implementer: async () => ({ repositories: ["edobry/minsky"], selection: "selected" }),
        },
      })
    );
    expect(await oracle([IMPL])).toEqual([]);
  });

  it("matches the covered repo case-insensitively", async () => {
    const oracle = createAppCoverageOracle(
      fakeProvider({
        coverage: {
          implementer: async () => ({
            repositories: [UNGRANTED_REPO],
            selection: "selected",
          }),
        },
      })
    );
    const signals = await oracle([{ ...IMPL, repo: UNGRANTED_REPO.toUpperCase() }]);
    expect(signals).toHaveLength(1);
  });

  it("treats a probe FAILURE as silence, not as absence, and does not throw", async () => {
    // Reporting `present: false` would be indistinguishable from a genuine
    // un-granted tick. Emitting nothing keeps the failure in the log instead.
    const oracle = createAppCoverageOracle(
      fakeProvider({
        coverage: {
          implementer: async () => {
            throw new Error("503 Service Unavailable");
          },
        },
      })
    );
    expect(await oracle([IMPL])).toEqual([]);
  });

  it("skips a role the provider does not have configured", async () => {
    // Without this, `clientForRole` falls back to the implementer client and the
    // reviewer request would be satisfied by the implementer's coverage.
    const oracle = createAppCoverageOracle(
      fakeProvider({
        configured: ["implementer"],
        coverage: {
          implementer: async () => ({
            repositories: [UNGRANTED_REPO],
            selection: "selected",
          }),
        },
      })
    );
    expect(await oracle([REVIEW])).toEqual([]);
  });
});

describe("resolveSatisfiedAppGrantRequests (mt#4693)", () => {
  it("closes a request once the grant lands", async () => {
    const closed: string[] = [];
    const result = await resolveSatisfiedAppGrantRequests({
      listCandidateAsks: async () => [grantAsk("a", IMPL, "suspended")],
      listPresence: async (pending) =>
        pending.map((key) => ({ key, present: true, detail: "granted" })),
      satisfy: async (ask) => {
        closed.push(ask.id);
      },
    });

    expect(result).toEqual({ pending: 1, satisfied: ["a"], raced: [] });
    expect(closed).toEqual(["a"]);
  });

  it("leaves an un-granted request open for the next tick", async () => {
    const result = await resolveSatisfiedAppGrantRequests({
      listCandidateAsks: async () => [grantAsk("a", IMPL, "suspended")],
      listPresence: async () => [],
      satisfy: async () => {
        throw new Error("must not close an un-granted request");
      },
    });
    expect(result).toEqual({ pending: 1, satisfied: [], raced: [] });
  });

  it("does not consult the oracle at all when nothing is pending", async () => {
    // Matters here specifically: this oracle is a live GitHub call, and almost
    // every tick has no open request.
    let called = false;
    await resolveSatisfiedAppGrantRequests({
      listCandidateAsks: async () => [],
      listPresence: async () => {
        called = true;
        return [];
      },
      satisfy: async () => {},
    });
    expect(called).toBe(false);
  });

  it("keeps the two roles independent — granting one does not close the other", async () => {
    const closed: string[] = [];
    const result = await resolveSatisfiedAppGrantRequests({
      listCandidateAsks: async () => [
        grantAsk("impl", IMPL, "suspended"),
        grantAsk("rev", REVIEW, "suspended"),
      ],
      listPresence: async (pending) =>
        pending
          .filter((k) => k.role === "implementer")
          .map((key) => ({ key, present: true, detail: "granted" })),
      satisfy: async (ask) => {
        closed.push(ask.id);
      },
    });

    expect(closed).toEqual(["impl"]);
    expect(result).toMatchObject({ pending: 2, satisfied: ["impl"] });
  });
});
