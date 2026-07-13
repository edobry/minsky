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
  const header = toBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = toBase64Url(
    JSON.stringify({ iat: now - 60, exp: now + 300, iss: String(appId) })
  );
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
  return `${signingInput}.${arrayBufferToBase64Url(sig)}`;
}

function toBase64Url(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function arrayBufferToBase64Url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
