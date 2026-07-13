/**
 * Railway API token provider (mt#2124).
 *
 * Validates Railway API tokens against the GraphQL API's `me` query.
 * Railway tokens are generated at https://railway.app/account/tokens
 * and authenticate as Bearer tokens against https://backboard.railway.com/graphql/v2.
 */
import type { CredentialProvider, CredentialCheckResult } from "../types";

const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";
const ME_QUERY = `query { me { name email } }`;

async function callMe(token: string): Promise<CredentialCheckResult> {
  let response: Response;
  try {
    response = await fetch(RAILWAY_GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: ME_QUERY }),
    });
  } catch (error) {
    return {
      ok: false,
      detail: `network error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (response.status === 401) {
    return { ok: false, detail: "401 Unauthorized — token invalid or revoked", unauthorized: true };
  }
  if (!response.ok) {
    return { ok: false, detail: `HTTP ${response.status} ${response.statusText}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, detail: "response was not valid JSON" };
  }

  const data = body as { data?: { me?: { name?: string; email?: string } }; errors?: unknown[] };
  if (data.errors) {
    return { ok: false, detail: `GraphQL error: ${JSON.stringify(data.errors[0])}` };
  }
  const me = data.data?.me;
  if (!me) {
    return { ok: false, detail: "unexpected response shape — no me field" };
  }
  return { ok: true, detail: `railway:${me.name ?? me.email ?? "authenticated"}` };
}

export const railwayProvider: CredentialProvider = {
  id: "railway",
  displayName: "Railway",
  configPath: "railway.apiToken",
  acquireUrl: "https://railway.app/account/tokens",
  scopeGuidance:
    "Account or workspace API token from the Railway dashboard. Used by Pulumi for IaC management.",
  validate: callMe,
  test: callMe,
};
