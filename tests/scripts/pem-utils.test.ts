/**
 * Tests for PEM → PKCS#8 conversion (mt#1093).
 *
 * Generates an RSA keypair in-test, exports it as PKCS#8, synthesizes the
 * matching PKCS#1 PEM, and verifies the conversion path produces bytes that
 * WebCrypto accepts via `importKey("pkcs8", ...)`. The signing round-trip
 * test confirms the converted private key is the same key as the original.
 */

import { describe, test, expect } from "bun:test";
import { pemToPkcs8ArrayBuffer } from "../../scripts/lib/pem-utils";

const RSA_ALGORITHM = "RSASSA-PKCS1-v1_5";
const RSA_HASH = "SHA-256";
const RSA_IMPORT_PARAMS = { name: RSA_ALGORITHM, hash: RSA_HASH };

async function generateTestRsaKey(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: RSA_ALGORITHM,
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: RSA_HASH,
    },
    true,
    ["sign", "verify"]
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function toPem(label: string, der: Uint8Array): string {
  const b64 = bytesToBase64(der);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

// Forward DER parser: extract PKCS#1 body (the OCTET STRING contents of the
// PKCS#8 envelope). Used only in tests to synthesize a PKCS#1 fixture from
// WebCrypto's PKCS#8 export.
function extractPkcs1FromPkcs8(pkcs8: Uint8Array): Uint8Array {
  let i = 0;
  const readTag = (expected: number) => {
    if (pkcs8[i] !== expected) {
      throw new Error(
        `expected tag 0x${expected.toString(16)} at offset ${i}, got 0x${pkcs8[i]?.toString(16)}`
      );
    }
    i++;
  };
  const readLen = () => {
    const first = pkcs8[i++];
    if (first === undefined) throw new Error("unexpected end of DER");
    if ((first & 0x80) === 0) return first;
    const nBytes = first & 0x7f;
    let v = 0;
    for (let j = 0; j < nBytes; j++) {
      const b = pkcs8[i++];
      if (b === undefined) throw new Error("unexpected end of DER");
      v = (v << 8) | b;
    }
    return v;
  };

  readTag(0x30);
  readLen();
  readTag(0x02);
  const versionLen = readLen();
  i += versionLen;
  readTag(0x30);
  const algIdLen = readLen();
  i += algIdLen;
  readTag(0x04);
  const bodyLen = readLen();
  return pkcs8.slice(i, i + bodyLen);
}

describe("pemToPkcs8ArrayBuffer", () => {
  test("round-trips a PKCS#8 PEM (BEGIN PRIVATE KEY)", async () => {
    const keyPair = await generateTestRsaKey();
    const pkcs8Der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
    const pkcs8Pem = toPem("PRIVATE KEY", pkcs8Der);

    const buf = pemToPkcs8ArrayBuffer(pkcs8Pem);
    const reimported = await crypto.subtle.importKey("pkcs8", buf, RSA_IMPORT_PARAMS, false, [
      "sign",
    ]);
    expect(reimported).toBeDefined();
  });

  test("converts a PKCS#1 PEM (BEGIN RSA PRIVATE KEY) to importable PKCS#8", async () => {
    const keyPair = await generateTestRsaKey();
    const pkcs8Der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
    const pkcs1Der = extractPkcs1FromPkcs8(pkcs8Der);
    const pkcs1Pem = toPem("RSA PRIVATE KEY", pkcs1Der);

    const buf = pemToPkcs8ArrayBuffer(pkcs1Pem);
    const reimported = await crypto.subtle.importKey("pkcs8", buf, RSA_IMPORT_PARAMS, false, [
      "sign",
    ]);
    expect(reimported).toBeDefined();
  });

  test("converted PKCS#1 key signs payloads that the original public key verifies", async () => {
    const keyPair = await generateTestRsaKey();
    const pkcs8Der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keyPair.privateKey));
    const pkcs1Der = extractPkcs1FromPkcs8(pkcs8Der);
    const pkcs1Pem = toPem("RSA PRIVATE KEY", pkcs1Der);

    const convertedPrivateKey = await crypto.subtle.importKey(
      "pkcs8",
      pemToPkcs8ArrayBuffer(pkcs1Pem),
      RSA_IMPORT_PARAMS,
      false,
      ["sign"]
    );
    const message = new TextEncoder().encode("jwt-signing-payload");
    const signature = await crypto.subtle.sign(RSA_ALGORITHM, convertedPrivateKey, message);

    const verified = await crypto.subtle.verify(
      RSA_ALGORITHM,
      keyPair.publicKey,
      signature,
      message
    );
    expect(verified).toBe(true);
  });
});
