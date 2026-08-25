#!/usr/bin/env bun
/**
 * Live verification that an IMAGE reaches the channel conversation (mt#3235).
 *
 * Sibling of `verify-conversation.ts`, which proves text gets an answer back.
 * This one proves the thing a unit test structurally cannot: that the real
 * `claude` binary accepts an `image` content block over `--input-format
 * stream-json` and that the model actually SEES the pixels.
 *
 * Why it cannot be a unit test: every test in this cluster stubs the session driver
 * seam or the fetch, so all of them would pass against a binary that silently
 * dropped the image block. The originating defect (mt#3235) was exactly that
 * class — a whole message shape vanishing with every gate green.
 *
 * The probe is self-contained: it generates a solid-colour PNG in memory rather
 * than reading a fixture or touching Telegram, so it needs no bot token and no
 * network beyond the model call. It then asks the model to name the colour. A
 * dropped image block cannot produce the right answer, which is what makes this
 * a probe that can actually FAIL.
 *
 * Usage (from the repo root):
 *
 *   bun scripts/principal-channel/verify-image-ingest.ts [--cwd <path>]
 *
 * Exit codes: 0 = the model named the colour, 1 = failure (reason printed).
 */

import { deflateSync } from "node:zlib";

import { createDrivenSessionDriver } from "../../src/cockpit/principal-channel-driver";
import { DrivenSessionRegistry } from "../../src/cockpit/driven-session-host";

/**
 * Magenta because it is unguessable: "white", "black", and "red" are all
 * plausible blind guesses for a test image, so any of them would let this probe
 * pass without the model having seen anything. Nothing in the prompt hints at
 * magenta.
 */
const MAGENTA: [number, number, number] = [255, 0, 255];

/** Big enough to be unambiguous to a vision model; small enough to stay tiny. */
const SIZE = 64;

/**
 * CRC-32 (the PNG chunk checksum), computed bitwise.
 *
 * No lookup table on purpose: a table needs an indexed read, which under this
 * project's `noUncheckedIndexedAccess` is `number | undefined` and would want
 * either a non-null assertion or a `?? 0` fallback that silently produces a
 * wrong checksum if it ever fired. The images here are a few hundred bytes, so
 * the table buys nothing worth that.
 */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function beUint32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = concat([typeBytes, data]);
  return concat([beUint32(data.length), body, beUint32(crc32(body))]);
}

/**
 * Encode a solid-colour truecolour PNG.
 *
 * Built rather than hardcoded as a base64 literal: the first version of this
 * probe carried a hand-written base64 string that turned out to be a malformed
 * PNG, and the model replied "the image couldn't be processed" — a failure that
 * looks exactly like the pipeline being broken. A fixture the probe constructs
 * itself cannot be wrong in a way that frames the code under test.
 */
function solidPng(size: number, [r, g, b]: [number, number, number]): string {
  const raw = new Uint8Array(size * (size * 3 + 1));
  let offset = 0;
  for (let row = 0; row < size; row += 1) {
    raw[offset] = 0; // filter type 0 (None) — required at the start of each scanline
    offset += 1;
    for (let column = 0; column < size; column += 1) {
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      offset += 3;
    }
  }

  const ihdr = concat([
    beUint32(size),
    beUint32(size),
    // bit depth 8, colour type 2 (truecolour), deflate, adaptive filtering, no interlace
    new Uint8Array([8, 2, 0, 0, 0]),
  ]);

  const png = concat([
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    // `node:zlib`, NOT `Bun.deflateSync`: PNG's IDAT must hold a ZLIB stream
    // (2-byte header + Adler-32), and Bun's helper emits a RAW deflate stream.
    // The difference is invisible to `file(1)` and `sips`, which only parse the
    // IHDR — the resulting file reports "PNG image data, 64 x 64" while being
    // undecodable. Verified: node:zlib starts 78 9c, Bun's starts 63 64.
    chunk("IDAT", new Uint8Array(deflateSync(Buffer.from(raw)))),
    chunk("IEND", new Uint8Array()),
  ]);

  let binary = "";
  for (const byte of png) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const MAGENTA_PNG_BASE64 = solidPng(SIZE, MAGENTA);

const PROMPT =
  "Name the single colour filling this image. Reply with one word and nothing else. " +
  "Do not use any tools.";

/** Colour words that count as recognizing magenta. */
const ACCEPTED = ["magenta", "pink", "fuchsia", "purple"];

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const cwd = argValue("--cwd") ?? process.cwd();
  const startedAt = Date.now();

  const sessionDriver = createDrivenSessionDriver({
    cwd,
    registry: new DrivenSessionRegistry(),
    respondToAsk: async () => "unused",
  });

  let reply: string;
  try {
    reply = await sessionDriver.converse(PROMPT, {
      images: [{ base64: MAGENTA_PNG_BASE64, mediaType: "image/png" }],
    });
  } catch (err) {
    console.error(
      `FAIL after ${Date.now() - startedAt}ms: ${err instanceof Error ? err.message : String(err)}`
    );
    await sessionDriver.reset();
    process.exit(1);
  }

  await sessionDriver.reset();

  const normalized = reply.trim().toLowerCase();
  const recognized = ACCEPTED.some((colour) => normalized.includes(colour));
  const durationMs = Date.now() - startedAt;

  if (!recognized) {
    // The most likely cause is the image block being dropped rather than the
    // model misreading a solid colour field, so say so.
    console.error(
      `FAIL after ${durationMs}ms: expected one of ${ACCEPTED.join("/")}, got ${JSON.stringify(reply.trim())}. ` +
        `The image block probably did not reach the model.`
    );
    process.exit(1);
  }

  console.log(JSON.stringify({ status: "PASS", reply: reply.trim(), durationMs }, null, 2));
}

await main();
