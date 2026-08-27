/**
 * Tests for the onboarding App-coverage check (mt#4680).
 *
 * The behaviour under test is a distinction, not a lookup: "not covered" and
 * "could not check" must never collapse into each other, because the first
 * tells an operator to grant access and the second tells them nothing is known.
 */
import { describe, it, expect } from "bun:test";
import { checkAppCoverage, formatAppCoverage } from "./app-coverage";
import type { GitHubAppTokenProvider } from "../auth/github-app-token-provider";

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
