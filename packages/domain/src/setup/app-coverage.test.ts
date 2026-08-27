/**
 * Tests for the onboarding App-coverage check (mt#4680).
 *
 * The behaviour under test is a distinction, not a lookup: "not covered" and
 * "could not check" must never collapse into each other, because the first
 * tells an operator to grant access and the second tells them nothing is known.
 */
import { describe, it, expect } from "bun:test";
import {
  checkAppCoverage,
  checkAppRoleCoverage,
  formatAppCoverage,
  installationSettingsUrl,
  type AppRoleDescriptor,
} from "./app-coverage";
import type { GitHubAppTokenProvider } from "../auth/github-app-token-provider";
import type { TokenRole } from "../auth/token-provider";

/** The originating ungranted repo (mt#4680). */
const UNGRANTED_REPO = "edobry/peezombie.me";

function fakeProvider(
  impl: () => Promise<{ repositories: string[]; selection: "all" | "selected" }>
) {
  return { getInstallationCoverage: impl } as unknown as GitHubAppTokenProvider;
}

describe("checkAppCoverage (mt#4680)", () => {
  it("reports covered when the installation lists the repo", async () => {
    const status = await checkAppCoverage("edobry/minsky", {
      provider: fakeProvider(async () => ({
        repositories: ["edobry/minsky"],
        selection: "selected",
      })),
    });
    expect(status).toEqual({ state: "covered", repo: "edobry/minsky" });
  });

  it("reports NOT covered for the originating case — the repo absent from the list", async () => {
    const status = await checkAppCoverage(UNGRANTED_REPO, {
      provider: fakeProvider(async () => ({
        repositories: ["edobry/minsky"],
        selection: "selected",
      })),
    });
    expect(status).toEqual({ state: "not-covered", repo: UNGRANTED_REPO, coveredCount: 1 });
  });

  it("treats selection 'all' as covering any repo, without needing it enumerated", async () => {
    const status = await checkAppCoverage("edobry/anything", {
      provider: fakeProvider(async () => ({ repositories: [], selection: "all" })),
    });
    expect(status.state).toBe("covered");
  });

  it("matches case-insensitively", async () => {
    const status = await checkAppCoverage("EDOBRY/Minsky", {
      provider: fakeProvider(async () => ({
        repositories: ["edobry/minsky"],
        selection: "selected",
      })),
    });
    expect(status.state).toBe("covered");
  });

  it("returns no-app-configured when no App provider exists — not 'not covered'", async () => {
    expect(await checkAppCoverage("edobry/minsky", { provider: null })).toEqual({
      state: "no-app-configured",
    });
  });

  it("a failed probe is 'unknown', NEVER 'not-covered'", async () => {
    // The distinction this whole module exists to preserve: reporting a failed
    // check as a missing grant would send an operator to grant access they
    // already have.
    const status = await checkAppCoverage("edobry/minsky", {
      provider: fakeProvider(async () => {
        throw new Error("503 Service Unavailable");
      }),
    });
    expect(status.state).toBe("unknown");
    expect(status).toMatchObject({ reason: expect.stringContaining("503") });
  });

  it("never throws, so onboarding cannot fail because the probe did", async () => {
    const status = await checkAppCoverage("edobry/minsky", {
      provider: fakeProvider(async () => {
        throw new Error("boom");
      }),
    });
    expect(status.state).toBe("unknown");
  });
});

describe("formatAppCoverage (mt#4680)", () => {
  it("names the concrete remedy when not covered", () => {
    const out = formatAppCoverage(
      { state: "not-covered", repo: UNGRANTED_REPO, coveredCount: 1 },
      "minsky-ai"
    );
    expect(out).toContain(`does NOT cover ${UNGRANTED_REPO}`);
    expect(out).toContain("404");
    expect(out).toContain("minsky-ai");
    expect(out).toContain("Repository access");
  });

  it("does not tell the operator to grant anything when the check merely failed", () => {
    const out = formatAppCoverage({ state: "unknown", reason: "503" });
    expect(out).toContain("could not be verified");
    expect(out).not.toContain("Repository access");
  });
});

/** A provider that answers per-role, and knows which roles are configured. */
function fakeRoleProvider(opts: {
  configured: TokenRole[];
  coverage: Partial<
    Record<TokenRole, () => Promise<{ repositories: string[]; selection: "all" | "selected" }>>
  >;
}) {
  return {
    isRoleConfigured: (role: TokenRole) => opts.configured.includes(role),
    getInstallationCoverage: async (role?: TokenRole) => {
      const impl = opts.coverage[role ?? "implementer"];
      if (!impl) throw new Error(`no coverage stub for role ${role}`);
      return impl();
    },
  } as unknown as GitHubAppTokenProvider;
}

const IMPLEMENTER: AppRoleDescriptor = {
  role: "implementer",
  slug: "minsky-ai",
  installationId: 125403046,
};
const REVIEWER: AppRoleDescriptor = {
  role: "reviewer",
  slug: "minsky-reviewer",
  installationId: 987654321,
};

describe("installationSettingsUrl (mt#4693)", () => {
  it("builds the per-installation settings page from the id", () => {
    expect(installationSettingsUrl(125403046)).toBe(
      "https://github.com/settings/installations/125403046"
    );
  });
});

describe("checkAppRoleCoverage (mt#4693 D6)", () => {
  it("returns a verdict per CONFIGURED role, carrying each role's deep link", async () => {
    const result = await checkAppRoleCoverage("edobry/minsky", [IMPLEMENTER, REVIEWER], {
      provider: fakeRoleProvider({
        configured: ["implementer", "reviewer"],
        coverage: {
          implementer: async () => ({ repositories: ["edobry/minsky"], selection: "selected" }),
          reviewer: async () => ({ repositories: ["edobry/minsky"], selection: "selected" }),
        },
      }),
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      role: "implementer",
      slug: "minsky-ai",
      settingsUrl: "https://github.com/settings/installations/125403046",
      status: { state: "covered" },
    });
    expect(result[1]).toMatchObject({
      role: "reviewer",
      settingsUrl: "https://github.com/settings/installations/987654321",
      status: { state: "covered" },
    });
  });

  it("catches the originating D6 case: implementer covered, reviewer NOT", async () => {
    // The gap the single-role check could not see. In this project the reviewer
    // bot's APPROVE is a merge gate, so an uncovered reviewer App breaks the
    // loop with no onboarding signal at all.
    const result = await checkAppRoleCoverage(UNGRANTED_REPO, [IMPLEMENTER, REVIEWER], {
      provider: fakeRoleProvider({
        configured: ["implementer", "reviewer"],
        coverage: {
          implementer: async () => ({
            repositories: [UNGRANTED_REPO],
            selection: "selected",
          }),
          reviewer: async () => ({ repositories: ["edobry/minsky"], selection: "selected" }),
        },
      }),
    });

    expect(result[0]?.status.state).toBe("covered");
    expect(result[1]?.status).toEqual({
      state: "not-covered",
      repo: UNGRANTED_REPO,
      coveredCount: 1,
    });
  });

  it("SKIPS an unconfigured role rather than reporting the implementer's coverage twice", async () => {
    // The trap: `clientForRole` falls back to the implementer client when the
    // reviewer App is absent, so asking unconditionally would yield two
    // identical verdicts with one of them mislabelled "reviewer". If this ever
    // returns 2, the isRoleConfigured filter has been dropped.
    const result = await checkAppRoleCoverage("edobry/minsky", [IMPLEMENTER, REVIEWER], {
      provider: fakeRoleProvider({
        configured: ["implementer"],
        coverage: {
          implementer: async () => ({ repositories: ["edobry/minsky"], selection: "selected" }),
        },
      }),
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("implementer");
  });

  it("omits settingsUrl when the installation id is not configured", async () => {
    const result = await checkAppRoleCoverage(
      "edobry/minsky",
      [{ role: "implementer", slug: "minsky-ai" }],
      {
        provider: fakeRoleProvider({
          configured: ["implementer"],
          coverage: {
            implementer: async () => ({ repositories: [], selection: "selected" }),
          },
        }),
      }
    );

    expect(result[0]?.settingsUrl).toBeUndefined();
    expect(result[0]?.status.state).toBe("not-covered");
  });

  it("a per-role probe failure is 'unknown', NEVER 'not-covered'", async () => {
    const result = await checkAppRoleCoverage("edobry/minsky", [IMPLEMENTER], {
      provider: fakeRoleProvider({
        configured: ["implementer"],
        coverage: {
          implementer: async () => {
            throw new Error("503 Service Unavailable");
          },
        },
      }),
    });

    expect(result[0]?.status.state).toBe("unknown");
    expect(result[0]?.status).toMatchObject({ reason: expect.stringContaining("503") });
  });

  it("reports no-app-configured for every role when there is no provider", async () => {
    const result = await checkAppRoleCoverage("edobry/minsky", [IMPLEMENTER, REVIEWER], {
      provider: null,
    });
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.status.state === "no-app-configured")).toBe(true);
  });
});
