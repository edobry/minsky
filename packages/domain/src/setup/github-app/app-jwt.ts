/**
 * Shared App-level JWT builder for GitHub App authentication.
 *
 * Extracted from the duplicated inline patterns in manifest-flow-provisioner.ts
 * and guided-wizard-provisioner.ts. Used by any operation that requires
 * App-level auth (installation lookup, PATCH /app, delivery log queries).
 *
 * @see mt#2167
 */

import { pemToPkcs8ArrayBuffer } from "./pem-utils";

/**
 * Build a short-lived RS256 JWT for GitHub App authentication.
 *
 * The JWT is valid for ~6 minutes (iat-60 to iat+300) per GitHub's
 * App authentication spec.
 */
export async function buildAppJwt(appId: number, pem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" })).replace(/=/g, "");
  const payload = btoa(
    JSON.stringify({ iat: now - 60, exp: now + 300, iss: String(appId) })
  ).replace(/=/g, "");
  const signingInput = `${header}.${payload}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8ArrayBuffer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  );
  const bytes = new Uint8Array(sig);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `${signingInput}.${btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")}`;
}
