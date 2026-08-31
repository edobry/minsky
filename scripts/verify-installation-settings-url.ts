#!/usr/bin/env bun
/**
 * Verify `installationSettingsUrl`'s form against GitHub itself (mt#4695 SC5).
 *
 * **Why this script exists.** `installationSettingsUrl` CONSTRUCTS
 * `https://github.com/settings/installations/<id>` by interpolation. mt#4680's PR
 * body asserted a claim about that URL without checking it, which is the defect
 * mt#4695 exists to correct — so shipping a second unverified claim about the
 * same URL would repeat it one layer down. GitHub publishes the answer: the
 * installation object returned by `GET /app/installations/{installation_id}`
 * carries a required `html_url`.
 *
 * **Why the obvious probe does not work.** An unauthenticated GET of any
 * `/settings/*` path redirects to the login page whether or not the path is
 * real, so it returns the same result for a valid and an invalid URL — a probe
 * that cannot fail is not verification. This one authenticates as the App, so
 * GitHub answers for the actual installation.
 *
 * **Secret handling.** The private key is read to sign a JWT and is never
 * printed, logged, or included in any output on any path — success or failure.
 * The only values emitted are GitHub's `html_url`, the account login, the
 * account type, and the comparison verdict.
 *
 * Exit codes: 0 = verified (or SKIP, when the App is not configured here),
 * 1 = the constructed form does not match GitHub's own answer.
 *
 * Usage: `bun scripts/verify-installation-settings-url.ts`
 */

// Must precede any import that reaches tsyringe (the config stack does).
import "../src/reflect-polyfill";

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setupConfiguration } from "@minsky/domain/config-setup";
import { getConfiguration } from "@minsky/domain/configuration";
import { installationSettingsUrl } from "@minsky/domain/setup/app-coverage";
import { createTokenProvider } from "@minsky/domain/auth";
import { GitHubAppTokenProvider } from "@minsky/domain/auth/github-app-token-provider";

const GITHUB_API_BASE = "https://api.github.com";

/** Expand a leading `~` the same way the token provider does. */
function resolveKeyPath(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function mintAppJwt(appId: number, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId })
  ).toString("base64url");
  const signingInput = `${header}.${body}`;

  const sign = createSign("RSA-SHA256");
  sign.update(signingInput);
  return `${signingInput}.${sign.sign(privateKey, "base64url")}`;
}

async function main(): Promise<void> {
  await setupConfiguration();
  const cfg = getConfiguration();
  const account = cfg.github?.serviceAccount;

  if (!account) {
    // Gate rather than fail: a checkout without the App configured is a normal
    // state, and a verification script must not fail a setup that succeeded.
    console.log("SKIP: no github.serviceAccount configured — nothing to verify against.");
    return;
  }

  const { appId, installationId } = account;
  const privateKey =
    account.privateKey ??
    (account.privateKeyFile
      ? readFileSync(resolveKeyPath(account.privateKeyFile), "utf-8")
      : undefined);

  if (!privateKey) {
    console.log("SKIP: no private key configured (neither privateKey nor privateKeyFile).");
    return;
  }

  const response = await fetch(`${GITHUB_API_BASE}/app/installations/${installationId}`, {
    headers: {
      Authorization: `Bearer ${mintAppJwt(appId, privateKey)}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    // Deliberately does NOT echo the body: an error body from an auth-bearing
    // request is not guaranteed to be free of request context.
    console.error(
      `FAIL: GET /app/installations/${installationId} returned ${response.status} ${response.statusText}`
    );
    process.exit(1);
  }

  const data = (await response.json()) as {
    html_url?: string;
    account?: { login?: string; type?: string };
    target_type?: string;
  };

  const constructed = installationSettingsUrl(installationId);
  const authoritative = data.html_url;

  console.log(`account:        ${data.account?.login ?? "<none>"} (${data.account?.type ?? "?"})`);
  console.log(`target_type:    ${data.target_type ?? "<none>"}`);
  console.log(`GitHub html_url: ${authoritative ?? "<absent>"}`);
  console.log(`constructed:     ${constructed ?? "<null>"}`);

  if (!authoritative) {
    console.error("FAIL: GitHub returned no html_url — the form cannot be verified from here.");
    process.exit(1);
  }

  if (authoritative !== constructed) {
    console.error(
      "FAIL: the constructed URL does not match GitHub's own html_url for this installation."
    );
    process.exit(1);
  }

  console.log("PASS: constructed URL matches GitHub's own html_url for this installation.");

  // mt#4764: the raw check above proves what GitHub ANSWERS. This proves the
  // PRODUCTION path reads it — `getInstallationHtmlUrl` is what
  // `checkAppRoleCoverage` now prefers over the constructed form, and a
  // seam-injected unit test says nothing about the real-wired binding.
  const provider = createTokenProvider(cfg.github ?? {}, cfg.github?.token ?? "");
  if (!(provider instanceof GitHubAppTokenProvider)) {
    console.log("SKIP: configured provider is not App-backed — production path not exercised.");
    return;
  }

  const viaProvider = await provider.getInstallationHtmlUrl();
  console.log(`via provider:    ${viaProvider ?? "<null>"}`);

  if (viaProvider !== authoritative) {
    console.error(
      "FAIL: GitHubAppTokenProvider.getInstallationHtmlUrl() did not return GitHub's html_url."
    );
    process.exit(1);
  }

  console.log("PASS: the production read path returns GitHub's own html_url.");
}

await main();
