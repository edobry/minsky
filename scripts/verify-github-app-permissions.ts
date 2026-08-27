#!/usr/bin/env bun
/**
 * Reads the configured GitHub App's LIVE permission set and compares it against
 * `REQUIRED_APP_PERMISSIONS` (mt#3264).
 *
 * Why this exists as a script. mt#3264 sat open for three weeks across three
 * sessions, each of which recorded "check the App's permission set first" as the
 * next step and none of which did it — the answer took one API read and settled
 * the task's central question in the opposite direction from the spec's premise.
 * The check was cheap; having nowhere to run it was the friction. So it lives
 * here now.
 *
 * It reads BOTH views, because they can disagree and only one governs:
 *   - `GET /app`                      — what the App DECLARES it wants.
 *   - `GET /app/installations/{id}`   — what the installation has ACCEPTED.
 * A permission change is a *request* each installation must separately accept,
 * so the App declaring `workflows: write` while the installation has not
 * accepted it still produces rejected pushes. The installation view is the one
 * that decides.
 *
 * Output discipline: prints permission scopes and levels only. The private key
 * is used to sign a short-lived JWT and is never written to stdout, stderr, a
 * file, or a subprocess argument.
 *
 * Exit codes: **0 only ever means "checked, and no drift"**; 1 = checked, drift
 * found; 2 = could not check — including the not-configured and no-private-key
 * cases, which are unchecked rather than healthy.
 *
 * That last part is the whole point and it is deliberately NOT the usual
 * skip-gracefully-with-0 convention (PR #3174 R1). This script exists because a
 * question went unasked for three weeks; a wrapper that reads exit 0 as
 * "permissions match" when nothing was read would recreate exactly that, and a
 * probe that returns the healthy answer whether or not it ran is not a probe.
 * Anything gating on this should treat 2 as "go find out why", not as a pass.
 */
import "reflect-metadata";
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";

const GITHUB_API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 15_000;

async function main(): Promise<number> {
  const { setupConfiguration } = await import("@minsky/domain/config-setup");
  await setupConfiguration();
  const { getConfigurationProvider } = await import("@minsky/domain/configuration/index");
  const { detectPermissionDrift, formatPermissionDriftMessage, REQUIRED_APP_PERMISSIONS } =
    await import("@minsky/domain/setup/github-app");

  const serviceAccount = getConfigurationProvider().getConfig().github?.serviceAccount;
  if (!serviceAccount) {
    console.error(
      "COULD NOT CHECK: no github.serviceAccount configured. This is not a pass — " +
        "no permission was read."
    );
    return 2;
  }

  const { appId, installationId } = serviceAccount;
  let privateKey: string;
  try {
    privateKey = resolvePrivateKey(serviceAccount);
  } catch (err) {
    console.error(`COULD NOT CHECK: ${getLoggableErrorSummary(err)}`);
    return 2;
  }

  const jwt = mintAppJwt(appId, privateKey);

  let app: { slug?: string; permissions?: Record<string, string> };
  let installation: { permissions?: Record<string, string> };
  try {
    app = await getJson(`${GITHUB_API_BASE}/app`, jwt);
    installation = await getJson(`${GITHUB_API_BASE}/app/installations/${installationId}`, jwt);
  } catch (err) {
    // Exit 2, never 1: a failed read is "could not check", which must not be
    // reported as either a clean pass or a real drift.
    console.error(`FAILED TO CHECK: ${getLoggableErrorSummary(err)}`);
    return 2;
  }

  const slug = app.slug ?? `app-${appId}`;
  const declared = app.permissions ?? {};
  const accepted = installation.permissions ?? {};

  console.log(`App:          ${slug} (appId ${appId})`);
  console.log(`Installation: ${installationId}`);
  console.log("");
  console.log(`  declared (GET /app):                ${render(declared)}`);
  console.log(`  accepted (GET /app/installations):  ${render(accepted)}`);
  console.log("");
  console.log(
    `  required by shipped code:           ${render(requiredAsMap(REQUIRED_APP_PERMISSIONS))}`
  );
  console.log("");

  // The installation's accepted set is what actually governs a request.
  const drift = detectPermissionDrift(accepted);
  console.log(formatPermissionDriftMessage(slug, drift));

  const declaredButUnaccepted = Object.keys(declared).filter(
    (scope) => rank(accepted[scope]) < rank(declared[scope])
  );
  if (declaredButUnaccepted.length > 0) {
    console.log("");
    console.log(
      `NOTE: the App declares ${declaredButUnaccepted.join(", ")} at a higher level than the ` +
        "installation has accepted. A permission change must be accepted per-installation " +
        "before it takes effect."
    );
  }

  return drift.hasDrift ? 1 : 0;
}

function requiredAsMap(required: ReadonlyArray<{ scope: string; level: string }>) {
  return Object.fromEntries(required.map((entry) => [entry.scope, entry.level]));
}

function rank(level: string | undefined): number {
  return level ? ({ read: 1, write: 2, admin: 3 }[level] ?? 0) : 0;
}

function render(permissions: Record<string, string>): string {
  const entries = Object.entries(permissions).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? "(none)" : entries.map(([k, v]) => `${k}:${v}`).join(", ");
}

function resolvePrivateKey(serviceAccount: {
  privateKey?: string;
  privateKeyFile?: string;
}): string {
  if (serviceAccount.privateKey) return serviceAccount.privateKey.replace(/\\n/g, "\n");
  if (serviceAccount.privateKeyFile) {
    const path = serviceAccount.privateKeyFile.startsWith("~/")
      ? join(homedir(), serviceAccount.privateKeyFile.slice(2))
      : serviceAccount.privateKeyFile;
    return readFileSync(path, "utf8");
  }
  throw new Error(
    "no App private key configured (set MINSKY_GITHUB_APP_PRIVATE_KEY or " +
      "github.serviceAccount.privateKeyFile)"
  );
}

function mintAppJwt(appId: number, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  // 9 minutes: GitHub caps App JWT lifetime at 10, and `iat` is backdated 60s
  // for clock skew.
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: appId })
  ).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const sign = createSign("RSA-SHA256");
  sign.update(signingInput);
  return `${signingInput}.${sign.sign(privateKey, "base64url")}`;
}

async function getJson<T>(url: string, jwt: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    // Body deliberately not included: an error body from the App endpoints
    // carries no credential, but this keeps the no-secret-in-output property
    // independent of what GitHub decides to echo back.
    throw new Error(`${url} returned ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

process.exit(await main());
