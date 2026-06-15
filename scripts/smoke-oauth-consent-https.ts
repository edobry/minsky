#!/usr/bin/env bun
/**
 * Smoke test for mt#1780 — OAuth consent flow renders HTTPS behind a TLS proxy.
 *
 * Drives the real claude.ai-style connector OAuth handshake against a deployed
 * minsky-mcp server and asserts the observable fix:
 *
 *   1. Discovery (`/.well-known/oauth-authorization-server`) advertises https endpoints.
 *   2. Dynamic Client Registration (`POST /register`) succeeds.
 *   3. `GET /oauth/authorize` (valid S256 PKCE) → 303 → `/interaction/<uid>`.
 *   4. The rendered interaction (consent/login) form action is `https://` — NOT `http://`.
 *   5. The `_interaction` session cookie set during the flow carries `Secure`.
 *
 * Steps 4 + 5 are exactly what `provider.proxy = true` fixes (mt#1780): without it,
 * oidc-provider's Koa layer derives the request protocol from the raw socket
 * (`http` behind a TLS-terminating edge) and renders an `http://` form action +
 * non-Secure cookie, which the claude.ai web connector's strict-HTTPS browser
 * context blocks as active mixed content — so OAuth never completes.
 *
 * The unit test (`in-process-unit.test.ts` → "proxy-trust regression (mt#1780)")
 * locks `provider.proxy === true` with no DB/HTTP. THIS script verifies the
 * observable end-to-end behavior against a live, TLS-fronted deployment — the
 * part no unit test can reach.
 *
 * Env-gated (Step 7a convention): set `OAUTH_SMOKE_BASE_URL` to the deployed
 * origin (e.g. https://minsky-mcp-production.up.railway.app). Skips gracefully
 * (exit 0) when unset so default CI does not depend on a live deployment.
 *
 *   OAUTH_SMOKE_BASE_URL=https://minsky-mcp-production.up.railway.app \
 *     bun scripts/smoke-oauth-consent-https.ts
 *
 * Exit codes: 0 = pass or skip; non-zero = at least one assertion failed.
 */

import { createHash, randomBytes } from "node:crypto";

const BASE_URL = process.env.OAUTH_SMOKE_BASE_URL;
// A redirect_uri shaped like claude.ai's real connector callback; the server
// only needs it to match between DCR and authorize.
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<number> {
  if (!BASE_URL) {
    console.log(
      JSON.stringify(
        {
          status: "skip",
          reason: "OAUTH_SMOKE_BASE_URL not set — live deployment target required",
        },
        null,
        2
      )
    );
    return 0;
  }

  const base = BASE_URL.replace(/\/+$/, "");
  const results: CheckResult[] = [];

  // ---- 1. Discovery advertises https endpoints --------------------------------
  const discoveryUrl = `${base}/.well-known/oauth-authorization-server`;
  const discoveryResp = await fetch(discoveryUrl, { headers: { Accept: "application/json" } });
  const discovery = (await discoveryResp.json()) as Record<string, string>;
  const endpointFields = [
    "issuer",
    "authorization_endpoint",
    "token_endpoint",
    "registration_endpoint",
  ];
  const nonHttps = endpointFields.filter(
    (f) => typeof discovery[f] === "string" && !discovery[f].startsWith("https://")
  );
  results.push({
    name: "discovery endpoints are https",
    ok: discoveryResp.status === 200 && nonHttps.length === 0,
    detail:
      discoveryResp.status === 200
        ? nonHttps.length === 0
          ? "all advertised endpoints https"
          : `non-https endpoints: ${nonHttps.join(", ")}`
        : `discovery HTTP ${discoveryResp.status}`,
  });

  // ---- 2. Dynamic Client Registration -----------------------------------------
  const regResp = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "mt1780-consent-https-smoke",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const reg = (await regResp.json()) as { client_id?: string };
  const clientId = reg.client_id;
  results.push({
    name: "dynamic client registration",
    ok: regResp.status === 201 && Boolean(clientId),
    detail: regResp.status === 201 ? `client_id=${clientId}` : `register HTTP ${regResp.status}`,
  });

  if (!clientId) {
    return report(results);
  }

  // ---- 3. Authorize (valid S256 PKCE) → 303 → /interaction/<uid> --------------
  const verifier = base64url(randomBytes(64)); // >= 43 chars after encoding
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const authorizeUrl =
    `${base}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256` +
    `&resource=${encodeURIComponent(`${base}/mcp`)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=mcp&state=smoke-mt1780`;

  const authResp = await fetch(authorizeUrl, { redirect: "manual" });
  const location = authResp.headers.get("location") ?? "";
  // node/bun expose multiple Set-Cookie via getSetCookie(); fall back to single.
  const authCookies: string[] =
    typeof authResp.headers.getSetCookie === "function"
      ? authResp.headers.getSetCookie()
      : [authResp.headers.get("set-cookie") ?? ""].filter(Boolean);
  const isInteractionRedirect = authResp.status === 303 && location.includes("/interaction/");
  results.push({
    name: "authorize redirects to interaction",
    ok: isInteractionRedirect,
    detail: `HTTP ${authResp.status} location=${location || "(none)"}`,
  });

  // ---- 5. The interaction session cookie carries Secure ------------------------
  const interactionCookie = authCookies.find((c) => c.startsWith("_interaction="));
  results.push({
    name: "_interaction cookie is Secure",
    ok: Boolean(interactionCookie) && /;\s*secure/i.test(interactionCookie ?? ""),
    detail: interactionCookie
      ? `cookie attrs: ${
          interactionCookie
            .split(";")
            .slice(1)
            .map((s) => s.trim())
            .join(", ") || "(none)"
        }`
      : "no _interaction cookie set on authorize response",
  });

  if (!isInteractionRedirect) {
    return report(results);
  }

  // ---- 4. The rendered consent form action is https:// -------------------------
  const interactionUrl = location.startsWith("http") ? location : `${base}${location}`;
  const cookieHeader = authCookies.map((c) => c.split(";")[0]).join("; ");
  const pageResp = await fetch(interactionUrl, { headers: { Cookie: cookieHeader } });
  const html = await pageResp.text();
  const actionMatch = html.match(/<form[^>]*\baction="([^"]+)"/i);
  const formAction = actionMatch?.[1] ?? "";
  results.push({
    name: "consent form action is https",
    ok: formAction.startsWith("https://"),
    detail: formAction ? `form action=${formAction}` : "no <form action> found in interaction page",
  });

  return report(results);
}

function report(results: CheckResult[]): number {
  const failed = results.filter((r) => !r.ok);

  console.log(
    JSON.stringify({ status: failed.length === 0 ? "pass" : "fail", checks: results }, null, 2)
  );
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("smoke-oauth-consent-https: unexpected error", err);
    process.exit(2);
  });
