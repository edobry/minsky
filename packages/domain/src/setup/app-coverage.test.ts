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

/**
 * The on-page control the operator has to find once they arrive — named the
 * same way on both the linked and the prose path, so it is asserted from one
 * place rather than retyped per test.
 */
const REPOSITORY_ACCESS = "Repository access";

/** The navigation path the deep link replaces (mt#4695). */
const NAVIGATION_PATH_MARKER = "Installed GitHub Apps";

/** A coverage-probe failure, shared by the two tests that induce one. */
const PROBE_FAILURE = "503 Service Unavailable";

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
        throw new Error(PROBE_FAILURE);
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
    expect(out).toContain(REPOSITORY_ACCESS);
  });

  it("does not tell the operator to grant anything when the check merely failed", () => {
    const out = formatAppCoverage({ state: "unknown", reason: "503" });
    expect(out).toContain("could not be verified");
    expect(out).not.toContain(REPOSITORY_ACCESS);
  });

  // mt#4695: the prose form is the FALLBACK, not the remedy. The principal
  // could not act on it — "there was no link".
  it("emits the settings link instead of navigation prose when one is supplied", () => {
    const out = formatAppCoverage(
      { state: "not-covered", repo: UNGRANTED_REPO, coveredCount: 1 },
      "minsky-ai",
      "https://github.com/settings/installations/125403046"
    );

    expect(out).toContain("https://github.com/settings/installations/125403046");
    // The navigation path the link replaces must be GONE, not merely joined —
    // an operator handed both still has to decide which one to follow.
    expect(out).not.toContain(NAVIGATION_PATH_MARKER);
    // Still actionable once they land: which repo, and where on the page.
    expect(out).toContain(UNGRANTED_REPO);
    expect(out).toContain(REPOSITORY_ACCESS);
  });

  it("still names the app slug on the linked path, so two uncovered roles stay distinct", () => {
    // Both roles render a block headed `does NOT cover <repo>`; the slug is the
    // only thing separating them, so it must survive the switch to a link.
    const implementer = formatAppCoverage(
      { state: "not-covered", repo: UNGRANTED_REPO, coveredCount: 1 },
      "minsky-ai",
      "https://github.com/settings/installations/125403046"
    );
    const reviewer = formatAppCoverage(
      { state: "not-covered", repo: UNGRANTED_REPO, coveredCount: 1 },
      "minsky-reviewer",
      "https://github.com/settings/installations/987654321"
    );

    expect(implementer).toContain("minsky-ai");
    expect(reviewer).toContain("minsky-reviewer");
    expect(implementer).not.toBe(reviewer);
  });

  it("falls back to the navigation path when no link is available", () => {
    // SC3: a missing installation id degrades to prose rather than emitting a
    // guessed or half-built URL. Exercised, not assumed.
    const out = formatAppCoverage(
      { state: "not-covered", repo: UNGRANTED_REPO, coveredCount: 1 },
      "minsky-ai"
    );

    expect(out).not.toContain("https://");
    expect(out).toContain(NAVIGATION_PATH_MARKER);
    expect(out).toContain(REPOSITORY_ACCESS);
  });
});

/** A provider that answers per-role, and knows which roles are configured. */
function fakeRoleProvider(opts: {
  configured: TokenRole[];
  coverage: Partial<
    Record<TokenRole, () => Promise<{ repositories: string[]; selection: "all" | "selected" }>>
  >;
  /**
   * mt#4764: when omitted the fake has NO `getInstallationHtmlUrl` at all —
   * which is the pre-mt#4764 provider shape, and the exact runtime hazard the
   * production `typeof` guard exists for. `as unknown as` means the compiler
   * cannot see it, so leaving this optional keeps that case under test.
   */
  htmlUrl?: Partial<Record<TokenRole, () => Promise<string | null>>>;
}) {
  return {
    isRoleConfigured: (role: TokenRole) => opts.configured.includes(role),
    getInstallationCoverage: async (role?: TokenRole) => {
      const impl = opts.coverage[role ?? "implementer"];
      if (!impl) throw new Error(`no coverage stub for role ${role}`);
      return impl();
    },
    ...(opts.htmlUrl === undefined
      ? {}
      : {
          getInstallationHtmlUrl: async (role?: TokenRole) => {
            const impl = opts.htmlUrl?.[role ?? "implementer"];
            return impl ? impl() : null;
          },
        }),
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

  it("returns null for a malformed id rather than rendering a broken link", () => {
    // A misconfigured value would otherwise reach an operator-facing link as
    // `.../NaN` or `.../-1`. `null` is the same answer as "no id configured",
    // which every caller already handles by omitting the link (PR #3418 R1).
    expect(installationSettingsUrl(Number.NaN)).toBeNull();
    expect(installationSettingsUrl(0)).toBeNull();
    expect(installationSettingsUrl(-1)).toBeNull();
    expect(installationSettingsUrl(1.5)).toBeNull();
    expect(installationSettingsUrl(Number.POSITIVE_INFINITY)).toBeNull();
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
            throw new Error(PROBE_FAILURE);
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

/**
 * mt#4764 — the settings link is READ from GitHub, not constructed.
 *
 * The behaviour under test is a preference with a fallback, and the fallback is
 * the interesting half: an org-owned installation lives on a settings page the
 * constructed path cannot express, and this project has no org installation to
 * verify against — so correctness here comes from deferring to `html_url`
 * rather than from having checked both account types.
 */
describe("checkAppRoleCoverage settings link (mt#4764)", () => {
  /** An org-shaped URL: NOT derivable from the installation id alone. */
  const ORG_HTML_URL = "https://github.com/organizations/acme/settings/installations/125403046";

  it("AT1: uses GitHub's html_url rather than the constructed path", async () => {
    const result = await checkAppRoleCoverage(UNGRANTED_REPO, [IMPLEMENTER], {
      provider: fakeRoleProvider({
        configured: ["implementer"],
        coverage: {
          implementer: async () => ({ repositories: ["edobry/minsky"], selection: "selected" }),
        },
        htmlUrl: { implementer: async () => ORG_HTML_URL },
      }),
    });

    expect(result[0]?.status.state).toBe("not-covered");
    // The whole point: this value is NOT reachable by interpolating the id.
    expect(result[0]?.settingsUrl).toBe(ORG_HTML_URL);
    // Asserted as inequality, not as an absent substring: a real org URL
    // CONTAINS the constructed path (`/organizations/acme` is a prefix segment),
    // so a `not.toContain` check would fail against correct behaviour.
    expect(result[0]?.settingsUrl).not.toBe(installationSettingsUrl(125403046));
  });

  it("AT2: falls back to the constructed path when the read returns null", async () => {
    const result = await checkAppRoleCoverage(UNGRANTED_REPO, [IMPLEMENTER], {
      provider: fakeRoleProvider({
        configured: ["implementer"],
        coverage: {
          implementer: async () => ({ repositories: ["edobry/minsky"], selection: "selected" }),
        },
        htmlUrl: { implementer: async () => null },
      }),
    });

    expect(result[0]?.settingsUrl).toBe("https://github.com/settings/installations/125403046");
  });

  it("AT2: falls back when the provider has no getInstallationHtmlUrl at all", async () => {
    // The runtime hazard the `typeof` guard exists for — `as unknown as` hides a
    // missing method from the compiler, so only a test can catch it.
    const result = await checkAppRoleCoverage(UNGRANTED_REPO, [IMPLEMENTER], {
      provider: fakeRoleProvider({
        configured: ["implementer"],
        coverage: {
          implementer: async () => ({ repositories: ["edobry/minsky"], selection: "selected" }),
        },
      }),
    });

    expect(result[0]?.settingsUrl).toBe("https://github.com/settings/installations/125403046");
  });

  it("AT2: emits no link at all when there is no installation id to fall back to", async () => {
    const noId: AppRoleDescriptor = { role: "implementer", slug: "minsky-ai" };
    const result = await checkAppRoleCoverage(UNGRANTED_REPO, [noId], {
      provider: fakeRoleProvider({
        configured: ["implementer"],
        coverage: {
          implementer: async () => ({ repositories: ["edobry/minsky"], selection: "selected" }),
        },
        htmlUrl: { implementer: async () => null },
      }),
    });

    expect(result[0]?.settingsUrl).toBeUndefined();
  });

  it("does not spend an API call when the coverage probe itself failed", async () => {
    // PR #3511 R1. `unknown` means the first call already failed; its rendered
    // line carries no link at all, so a second call is waste that amplifies
    // whatever transient failure or rate limit produced the first.
    let calls = 0;
    const result = await checkAppRoleCoverage(UNGRANTED_REPO, [IMPLEMENTER], {
      provider: fakeRoleProvider({
        configured: ["implementer"],
        coverage: {
          implementer: async () => {
            throw new Error(PROBE_FAILURE);
          },
        },
        htmlUrl: {
          implementer: async () => {
            calls += 1;
            return ORG_HTML_URL;
          },
        },
      }),
    });

    expect(result[0]?.status.state).toBe("unknown");
    expect(calls).toBe(0);
  });

  it("does not spend an API call on a COVERED role, which renders no link", async () => {
    let calls = 0;
    const result = await checkAppRoleCoverage("edobry/minsky", [IMPLEMENTER], {
      provider: fakeRoleProvider({
        configured: ["implementer"],
        coverage: {
          implementer: async () => ({ repositories: ["edobry/minsky"], selection: "selected" }),
        },
        htmlUrl: {
          implementer: async () => {
            calls += 1;
            return ORG_HTML_URL;
          },
        },
      }),
    });

    expect(result[0]?.status.state).toBe("covered");
    expect(calls).toBe(0);
    // Still carries the constructed link, unchanged from before mt#4764.
    expect(result[0]?.settingsUrl).toBe("https://github.com/settings/installations/125403046");
  });
});
