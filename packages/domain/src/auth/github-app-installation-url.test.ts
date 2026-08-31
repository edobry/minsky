/**
 * `GitHubAppTokenProvider.getInstallationHtmlUrl()` wiring (mt#4764, PR #3511 R1).
 *
 * `trusted-url.test.ts` covers the validator in isolation. This covers the
 * thing the reviewer's finding was actually about: that the PROVIDER applies it
 * to what the API returned. A helper that rejects a hostile URL is worth nothing
 * if the call path does not run it, and the two are separate claims.
 *
 * Uses the provider's own `fetchImpl` / `privateKeyLoader` seams and a keypair
 * generated in-test, so no network and no key material on disk.
 */
import { describe, it, expect } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { GitHubAppTokenProvider } from "./github-app-token-provider";

/** A real RSA key, so `generateJwt()` signs rather than throwing. */
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const INSTALLATION_ID = 125403046;

/** A provider whose installation lookup returns exactly `body`. */
function providerReturning(body: unknown, ok = true): GitHubAppTokenProvider {
  return new GitHubAppTokenProvider({
    appId: 1234,
    installationId: INSTALLATION_ID,
    userToken: "unused",
    privateKeyLoader: () => privateKey as string,
    fetchImpl: (async () =>
      new Response(JSON.stringify(body), {
        status: ok ? 200 : 404,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch,
  });
}

describe("GitHubAppTokenProvider.getInstallationHtmlUrl (mt#4764)", () => {
  it("returns the html_url GitHub reports", async () => {
    const url = `https://github.com/settings/installations/${INSTALLATION_ID}`;
    expect(await providerReturning({ html_url: url }).getInstallationHtmlUrl()).toBe(url);
  });

  it("returns the ORG form unchanged — the case the constructed path cannot express", async () => {
    const url = "https://github.com/organizations/acme/settings/installations/125403046";
    expect(await providerReturning({ html_url: url }).getInstallationHtmlUrl()).toBe(url);
  });

  it("REJECTS a non-github.com html_url rather than surfacing it to an operator", async () => {
    // The finding this test exists for (PR #3511 R1): the value crosses a trust
    // boundary and is rendered as something to click. The caller then falls back
    // to the constructed, known-safe form.
    expect(
      await providerReturning({
        html_url: "https://github.com.evil.com/settings/installations/125403046",
      }).getInstallationHtmlUrl()
    ).toBeNull();

    expect(
      await providerReturning({
        html_url: "https://github.com@evil.com/x",
      }).getInstallationHtmlUrl()
    ).toBeNull();

    expect(
      await providerReturning({ html_url: "javascript:alert(1)" }).getInstallationHtmlUrl()
    ).toBeNull();
  });

  it("returns null for a missing, empty or non-string html_url", async () => {
    expect(await providerReturning({}).getInstallationHtmlUrl()).toBeNull();
    expect(await providerReturning({ html_url: "" }).getInstallationHtmlUrl()).toBeNull();
    expect(await providerReturning({ html_url: 42 }).getInstallationHtmlUrl()).toBeNull();
  });

  it("returns null on a non-ok response rather than throwing", async () => {
    // The coverage probe must not fail because the prettier link 404'd.
    expect(
      await providerReturning({ message: "Not Found" }, false).getInstallationHtmlUrl()
    ).toBeNull();
  });
});
