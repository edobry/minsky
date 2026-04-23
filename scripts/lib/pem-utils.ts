/**
 * PEM → PKCS#8 ArrayBuffer conversion for WebCrypto.
 *
 * Zero-dependency. Handles both PKCS#8 and PKCS#1 RSA private-key PEMs.
 * GitHub's App-manifest conversion endpoint returns PKCS#1 PEMs; WebCrypto's
 * `importKey("pkcs8", ...)` only accepts PKCS#8, so raw use of the GitHub-
 * returned key throws `DataError`. This module detects the input format
 * and wraps PKCS#1 bodies in a PKCS#8 envelope before returning bytes.
 *
 * @see mt#1093 — surfaced during mt#997 deployment when the minsky-reviewer
 *     installation-ID auto-lookup step threw DataError on the GitHub-returned
 *     PEM.
 */

/**
 * Parse a PEM private key and return PKCS#8 DER bytes as an ArrayBuffer.
 * Accepts either a PKCS#8 header or a PKCS#1 (RSA-specific) header.
 * PKCS#1 bodies are wrapped in a PKCS#8 envelope.
 */
export function pemToPkcs8ArrayBuffer(pem: string): ArrayBuffer {
  const isPkcs1 = pem.includes("-----BEGIN RSA PRIVATE KEY-----");
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const pkcs8 = isPkcs1 ? wrapPkcs1InPkcs8(bytes) : bytes;
  const out = new ArrayBuffer(pkcs8.byteLength);
  new Uint8Array(out).set(pkcs8);
  return out;
}

/**
 * Wrap a PKCS#1 RSA private key body in a PKCS#8 envelope.
 *
 * PKCS#8 structure:
 *   SEQUENCE {
 *     INTEGER 0                              -- version
 *     SEQUENCE {
 *       OID 1.2.840.113549.1.1.1             -- rsaEncryption
 *       NULL                                 -- parameters
 *     }
 *     OCTET STRING { <PKCS#1 body> }         -- privateKey
 *   }
 */
function wrapPkcs1InPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaAlgorithmIdentifier = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const octetStringHeader = concatBytes(new Uint8Array([0x04]), encodeDerLength(pkcs1.length));
  const payload = concatBytes(version, rsaAlgorithmIdentifier, octetStringHeader, pkcs1);
  const outerHeader = concatBytes(new Uint8Array([0x30]), encodeDerLength(payload.length));
  return concatBytes(outerHeader, payload);
}

function encodeDerLength(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  if (n < 0x100) return new Uint8Array([0x81, n]);
  if (n < 0x10000) return new Uint8Array([0x82, (n >> 8) & 0xff, n & 0xff]);
  throw new Error(`DER length exceeds 16-bit encoding: ${n}`);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
