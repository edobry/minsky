/**
 * Tests for opt-in gzip on large cockpit JSON responses (mt#4258).
 *
 * The response object is a hand-rolled recorder rather than a patched express
 * `Response`: the helper's contract is "which headers, and what bytes", both of
 * which a plain object can observe directly. Nothing here reaches for a
 * collaborator the code under test resolves itself.
 */

import { describe, expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";

import {
  acceptsGzip,
  COMPRESSION_MIN_BYTES,
  sendJsonMaybeCompressed,
  type CompressibleResponse,
} from "./compressed-json";

interface Recorded extends CompressibleResponse {
  headers: Record<string, string>;
  body: unknown;
}

function recorder(): Recorded {
  const rec: Recorded = {
    headers: {},
    body: undefined,
    setHeader(name: string, value: string) {
      rec.headers[name] = value;
      return undefined;
    },
    send(body?: unknown) {
      rec.body = body;
      return undefined;
    },
  };
  return rec;
}

describe("acceptsGzip", () => {
  test("accepts a plain gzip offer, alone or in a list", () => {
    expect(acceptsGzip("gzip")).toBe(true);
    expect(acceptsGzip("gzip, deflate, br")).toBe(true);
    expect(acceptsGzip("br, gzip")).toBe(true);
  });

  test("is case- and whitespace-insensitive", () => {
    expect(acceptsGzip("  GZip ")).toBe(true);
  });

  test("accepts a wildcard", () => {
    expect(acceptsGzip("*")).toBe(true);
  });

  test("declines when gzip is absent", () => {
    expect(acceptsGzip("br, deflate")).toBe(false);
  });

  test("declines an absent or empty header", () => {
    expect(acceptsGzip(undefined)).toBe(false);
    expect(acceptsGzip("")).toBe(false);
  });

  test("honors q=0 — an explicit REFUSAL, not an offer", () => {
    // Reading `gzip;q=0` as acceptance would send a body the client said it did
    // not want, which is the whole reason the q-value is parsed at all.
    expect(acceptsGzip("gzip;q=0")).toBe(false);
    expect(acceptsGzip("gzip;q=0, br")).toBe(false);
    expect(acceptsGzip("*;q=0")).toBe(false);
  });

  test("a non-zero q is still acceptance", () => {
    expect(acceptsGzip("gzip;q=0.5")).toBe(true);
    expect(acceptsGzip("gzip;q=1.0")).toBe(true);
  });
});

describe("sendJsonMaybeCompressed", () => {
  const big = {
    blocks: Array.from({ length: 4000 }, (_, i) => ({ i, text: `block ${i} payload` })),
  };

  test("compresses a large payload when the client accepts gzip", async () => {
    const res = recorder();
    const compressed = await sendJsonMaybeCompressed(res, big, { acceptEncoding: "gzip" });

    expect(compressed).toBe(true);
    expect(res.headers["Content-Encoding"]).toBe("gzip");
  });

  test("the compressed bytes round-trip to the identical JSON", async () => {
    const res = recorder();
    await sendJsonMaybeCompressed(res, big, { acceptEncoding: "gzip" });

    // TextDecoder rather than Buffer#toString(encoding): the ambient Buffer
    // type in this repo (src/types/node.d.ts) declares no encoding parameter.
    const restored = JSON.parse(new TextDecoder().decode(gunzipSync(res.body as Uint8Array)));
    expect(restored).toEqual(big);
  });

  test("compression actually shrinks the payload", async () => {
    const res = recorder();
    await sendJsonMaybeCompressed(res, big, { acceptEncoding: "gzip" });

    const raw = JSON.stringify(big).length;
    expect((res.body as Uint8Array).length).toBeLessThan(raw);
  });

  test("sends plain JSON when the client does not accept gzip", async () => {
    const res = recorder();
    const compressed = await sendJsonMaybeCompressed(res, big, { acceptEncoding: "br" });

    expect(compressed).toBe(false);
    expect(res.headers["Content-Encoding"]).toBeUndefined();
    expect(res.body).toBe(JSON.stringify(big));
  });

  test("sends plain JSON below the size threshold, even when gzip is offered", async () => {
    const res = recorder();
    const compressed = await sendJsonMaybeCompressed(res, { ok: true }, { acceptEncoding: "gzip" });

    expect(compressed).toBe(false);
    expect(res.body).toBe('{"ok":true}');
  });

  test("sets Vary: Accept-Encoding on the UNCOMPRESSED path too", async () => {
    // The classic form of this bug: declared only on the branch that obviously
    // varies, so an intermediary caches a plain body and serves it to a client
    // that would have taken gzip — or worse, the reverse.
    const res = recorder();
    await sendJsonMaybeCompressed(res, { ok: true }, { acceptEncoding: undefined });

    expect(res.headers["Vary"]).toBe("Accept-Encoding");
  });

  test("sets Vary: Accept-Encoding on the compressed path", async () => {
    const res = recorder();
    await sendJsonMaybeCompressed(res, big, { acceptEncoding: "gzip" });

    expect(res.headers["Vary"]).toBe("Accept-Encoding");
  });

  test("sets Content-Length itself on the compressed path, not leaving it to the framework", async () => {
    // PR #3104 R1 (BLOCKING). `CompressibleResponse` guarantees only setHeader
    // and send, so a response object using chunked transfer would satisfy the
    // type and emit no Content-Length — while callers quote Content-Length as a
    // measurement. The recorder here sets no headers of its own, so this
    // assertion passes only if the helper sets the header itself.
    const res = recorder();
    await sendJsonMaybeCompressed(res, big, { acceptEncoding: "gzip" });

    expect(res.headers["Content-Length"]).toBe(String((res.body as Uint8Array).length));
  });

  test("the declared Content-Length is the COMPRESSED byte count, not the raw one", async () => {
    const res = recorder();
    await sendJsonMaybeCompressed(res, big, { acceptEncoding: "gzip" });

    const declared = Number(res.headers["Content-Length"]);
    expect(declared).toBeLessThan(JSON.stringify(big).length);
  });

  test("a large payload compresses under an explicit byte ceiling", async () => {
    // Regression guard standing in for the windowing byte-ceiling test that was
    // scoped out with SQL windowing (see mt#4263). A shape test cannot express
    // "this response stays small", which is the property that would regress —
    // e.g. if GZIP_LEVEL were changed to 0 (store), or the threshold raised past
    // this payload so it shipped uncompressed.
    const CEILING_BYTES = 40 * 1024;
    const res = recorder();
    await sendJsonMaybeCompressed(res, big, { acceptEncoding: "gzip" });

    const raw = JSON.stringify(big).length;
    expect(raw).toBeGreaterThan(CEILING_BYTES);
    expect((res.body as Uint8Array).length).toBeLessThan(CEILING_BYTES);
  });

  test("always declares a JSON content type", async () => {
    const res = recorder();
    await sendJsonMaybeCompressed(res, big, { acceptEncoding: "gzip" });

    expect(res.headers["Content-Type"]).toBe("application/json; charset=utf-8");
  });

  test("the threshold is overridable, and the override is what decides", async () => {
    const small = { ok: true };
    const res = recorder();

    const compressed = await sendJsonMaybeCompressed(res, small, {
      acceptEncoding: "gzip",
      minBytes: 1,
    });

    expect(compressed).toBe(true);
    expect(COMPRESSION_MIN_BYTES).toBeGreaterThan(JSON.stringify(small).length);
  });
});
