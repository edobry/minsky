/**
 * Opt-in gzip for large cockpit JSON responses (mt#4258).
 *
 * The conversation-snapshot endpoint returns 6,107,990 bytes for a 1,593-turn
 * conversation, and returned them uncompressed even to a client that asked for
 * gzip: a request carrying `Accept-Encoding: gzip, br` came back with the full
 * 6.1 MB and no `Content-Encoding` header at all (measured 2026-08-18). No
 * compression middleware is registered on the cockpit app.
 *
 * This is a targeted helper rather than app-wide middleware, deliberately. The
 * cockpit daemon is bundled into a ~32 MB single-file CLI, and app-wide gzip
 * would mean a new runtime dependency for a benefit concentrated almost
 * entirely in one route — the rest of the cockpit's payloads are kilobytes.
 * `node:zlib` is already in the runtime, costs no dependency, and lets the
 * threshold and level be chosen for this workload rather than inherited.
 *
 * ## Why level 1
 *
 * On a loopback or tailnet daemon, compression CPU and transfer time are both on
 * the critical path — unlike a public server, where bandwidth dominates and a
 * slower, tighter level pays for itself. Measured on the real 6.1 MB payload:
 *
 *   level 1 → 2,261,191 bytes (2.70x) in  46ms
 *   level 6 → 2,020,350 bytes (3.02x) in 100ms
 *
 * Level 1 buys 89% of the ratio for 46% of the CPU, so it is the right point for
 * a daemon whose client is usually on the same machine and occasionally across a
 * tailnet.
 */

import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

/**
 * Below this, compressing is not worth the CPU or the latency it adds — a small
 * payload is already one packet and gzip would only make it slower.
 */
export const COMPRESSION_MIN_BYTES = 64 * 1024;

/** See the module docblock for the measurement behind this. */
export const GZIP_LEVEL = 1;

/**
 * Whether a client's `Accept-Encoding` actually permits gzip.
 *
 * Honors `q=0`, which is how a client says "explicitly NOT this encoding" —
 * treating a `gzip;q=0` as acceptance would send a body the client told us it
 * did not want. A bare `*` counts as acceptance unless it too is `q=0`.
 */
export function acceptsGzip(acceptEncoding: string | undefined): boolean {
  if (acceptEncoding === undefined || acceptEncoding === "") return false;
  for (const raw of acceptEncoding.split(",")) {
    const [rawName, ...params] = raw.trim().split(";");
    const name = (rawName ?? "").trim().toLowerCase();
    if (name !== "gzip" && name !== "*") continue;
    const q = params
      .map((p) => p.trim().toLowerCase())
      .find((p) => p.startsWith("q="))
      ?.slice(2);
    if (q !== undefined && Number.parseFloat(q) === 0) continue;
    return true;
  }
  return false;
}

/** The subset of an express `Response` this helper needs. */
export interface CompressibleResponse {
  setHeader(name: string, value: string): unknown;
  send: (body?: unknown) => unknown;
}

export interface SendJsonOptions {
  /** The request's raw `Accept-Encoding` header. */
  readonly acceptEncoding: string | undefined;
  /** Override the size threshold. Tests use this; callers should not need to. */
  readonly minBytes?: number;
}

/**
 * Send `body` as JSON, gzipped when the client accepts it and the payload is
 * large enough to be worth it.
 *
 * Always sets `Vary: Accept-Encoding`, including on the uncompressed path — a
 * response whose bytes depend on a request header MUST say so, or an
 * intermediary can serve a gzipped body to a client that never asked for one.
 * Getting this wrong on only the uncompressed branch is the classic form of the
 * bug, because that branch is the one that looks like it has nothing to declare.
 *
 * Returns whether the body was compressed, so a caller (or a test) can assert
 * the branch rather than inferring it from a byte count.
 */
export async function sendJsonMaybeCompressed(
  res: CompressibleResponse,
  body: unknown,
  options: SendJsonOptions
): Promise<boolean> {
  const json = JSON.stringify(body);
  const threshold = options.minBytes ?? COMPRESSION_MIN_BYTES;

  res.setHeader("Vary", "Accept-Encoding");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  // UTF-16 code units, not UTF-8 bytes. A transcript carries enough non-ASCII
  // (box drawing, emoji, CJK) that the two differ — but this number only picks
  // a branch, and it under-counts only for text that compresses especially well
  // anyway. Measuring the true byte length would mean encoding the whole 6 MB
  // string a second time purely to answer a yes/no question.
  if (json.length < threshold || !acceptsGzip(options.acceptEncoding)) {
    res.send(json);
    return false;
  }

  const compressed = (await gzipAsync(json, { level: GZIP_LEVEL })) as Uint8Array;
  res.setHeader("Content-Encoding", "gzip");
  // This function sets Content-Length on the compressed branch itself, rather
  // than depending on the response object to derive one (PR #3104 R1).
  //
  // The reason is the parameter type: `CompressibleResponse` promises
  // `setHeader` and `send`, and nothing about how a body becomes bytes. A
  // response object that used chunked transfer would satisfy that type and emit
  // no Content-Length at all — and callers of this helper quote Content-Length
  // as a measurement. Setting it makes the header a property of this function
  // instead of a property of whichever framework is passed in.
  //
  // `.length` on a Uint8Array/Buffer is a BYTE count, which is exactly what
  // Content-Length means — no encoding subtlety, unlike the identity branch
  // above, which passes a string and leaves the byte accounting to the response
  // object precisely because computing it here would mean encoding a
  // multi-megabyte string twice.
  res.setHeader("Content-Length", String(compressed.length));
  res.send(compressed);
  return true;
}
