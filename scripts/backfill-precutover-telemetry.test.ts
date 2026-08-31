/**
 * mt#4826 — the selection half of the pre-cutover backfill.
 *
 * The sweep itself is the shipped, already-tested pipeline; what is NEW here is WHICH streams get
 * pointed at the working tree and WHERE that path is built. Both are pure over injected deps, so
 * they are tested directly rather than through a filesystem.
 *
 * @see scripts/backfill-precutover-telemetry.ts
 */

import { describe, test, expect } from "bun:test";
import { legacyPathFor, parseArgs, selectLegacyStreams } from "./backfill-precutover-telemetry";
import type { GuardEventStreamSource } from "@minsky/domain/guard-events/stream-sources";

const ROOT = "/repo";

function source(over: Partial<GuardEventStreamSource> = {}): GuardEventStreamSource {
  return {
    stream: "silent-stretch",
    family: "calibration",
    location: "state-dir",
    relativePath: "silent-stretch-calibration.jsonl",
    format: "jsonl",
    ...over,
  } as GuardEventStreamSource;
}

/** A calibration source whose relativePath follows the manifest's own construction. */
const calibSource = (stream: string): GuardEventStreamSource =>
  source({ stream, relativePath: `${stream}-calibration.jsonl` });

const always = () => true;
const never = () => false;

describe("parseArgs — a value-less flag must not widen the scope (PR #3526 R1)", () => {
  test("--only as the last argument throws instead of selecting every stream", () => {
    // The dangerous shape: `undefined ?? null` read as "no --only given", which defaults to ALL
    // 60 streams. Paired with --execute that is a full 185k-record run the caller did not ask for.
    expect(() => parseArgs(["--execute", "--only"])).toThrow(/--only requires a value/);
  });

  test("--only immediately followed by another flag throws", () => {
    expect(() => parseArgs(["--only", "--execute"])).toThrow(/--only requires a value/);
  });

  test("--limit with no value throws — same shape, same refusal", () => {
    // Class-not-instance: the reviewer flagged --only, and --limit was parsed identically.
    expect(() => parseArgs(["--limit"])).toThrow(/--limit requires a value/);
    expect(() => parseArgs(["--limit", "--execute"])).toThrow(/--limit requires a value/);
  });

  test("a well-formed scoped invocation still parses", () => {
    expect(parseArgs(["--only", "coverage-claim-path", "--limit", "5", "--execute"])).toEqual({
      execute: true,
      only: "coverage-claim-path",
      limit: 5,
    });
  });

  test("no flags is a dry run over every stream", () => {
    expect(parseArgs([])).toEqual({ execute: false, only: null, limit: null });
  });

  test("--limit rejects a non-positive value", () => {
    expect(() => parseArgs(["--limit", "0"])).toThrow(/positive integer/);
  });

  test("--limit rejects a partial numeral parseInt would silently truncate (R2)", () => {
    // `Number.parseInt` stops at the first non-digit, so each of these yields a clean 5 that no
    // post-parse check can tell from a real 5. The validation has to precede the parse.
    for (const bad of ["5abc", "5.9", "5,000", " 5", "1e3", "-1", "abc"]) {
      expect(() => parseArgs(["--limit", bad])).toThrow(/positive integer/);
    }
  });

  test("--limit still accepts a plain positive integer", () => {
    expect(parseArgs(["--limit", "20000"]).limit).toBe(20000);
  });
});

describe("legacyPathFor", () => {
  test("builds the repo-rooted .minsky path from the manifest's relativePath", () => {
    expect(legacyPathFor(ROOT, source())).toBe("/repo/.minsky/silent-stretch-calibration.jsonl");
  });

  test("an evaluation stream's relativePath already carries its suffix", () => {
    // EVALUATION_STREAMS set `relativePath: `${stream}.jsonl``, where the stream name itself ends
    // in `-evaluations` — so nothing may append a second suffix here.
    const s = source({
      stream: "silent-stretch-evaluations",
      family: "evaluation",
      relativePath: "silent-stretch-evaluations.jsonl",
    });
    expect(legacyPathFor(ROOT, s)).toBe("/repo/.minsky/silent-stretch-evaluations.jsonl");
  });
});

describe("selectLegacyStreams", () => {
  test("selects calibration and evaluation streams that have a file", () => {
    const streams = [
      calibSource("a"),
      source({
        stream: "b-evaluations",
        family: "evaluation",
        relativePath: "b-evaluations.jsonl",
      }),
    ];
    expect(selectLegacyStreams(streams, ROOT, null, always).map((s) => s.stream)).toEqual([
      "a",
      "b-evaluations",
    ]);
  });

  test("excludes families that never lived in the working tree", () => {
    // `fire-log`, `guard-health` and `special` resolve flat under the state dir by deliberate
    // design (`resolveStreamPath` project-keys ONLY calibration and evaluation), so they have no
    // pre-cutover working-tree copy to recover and must not be pointed at one.
    const streams = [
      source({ stream: "fire-log", family: "fire-log", relativePath: "fire-log.jsonl" }),
      source({ stream: "guard-health-log", family: "guard-health", relativePath: "g.jsonl" }),
      source({ stream: "subagent-model-mismatch", family: "special", relativePath: "s.jsonl" }),
    ];
    expect(selectLegacyStreams(streams, ROOT, null, always)).toEqual([]);
  });

  test("excludes a stream whose pre-cutover file does not exist", () => {
    // The common case after this backfill runs once and the files are removed — and the case for
    // every stream that only ever wrote post-cutover.
    expect(selectLegacyStreams([source()], ROOT, null, never)).toEqual([]);
  });

  test("--only scopes to a single stream", () => {
    const streams = [calibSource("a"), calibSource("b")];
    expect(selectLegacyStreams(streams, ROOT, "b", always).map((s) => s.stream)).toEqual(["b"]);
  });

  test("--only naming an absent stream selects nothing rather than falling back to all", () => {
    const streams = [calibSource("a")];
    expect(selectLegacyStreams(streams, ROOT, "nope", always)).toEqual([]);
  });

  test("the existence check is consulted with the legacy path, not the state-dir path", () => {
    const seen: string[] = [];
    selectLegacyStreams([source()], ROOT, null, (p) => {
      seen.push(p);
      return true;
    });
    expect(seen).toEqual(["/repo/.minsky/silent-stretch-calibration.jsonl"]);
  });
});
