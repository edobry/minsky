#!/usr/bin/env bun
/**
 * Live verification for the short-id -> UUID map (mt#3914).
 *
 * The producer's unit tests inject a stub `sql`, which proves the SHAPE handling
 * and nothing about the real binding — the R3 failure mode (`78a6043e`): a
 * seam-tested cache whose live query never worked would render as "no entries",
 * indistinguishable from "nothing to map". This script exercises the REAL
 * persistence provider end-to-end and then runs the resulting map through the
 * REAL display transform, so a broken binding cannot pass as an empty one.
 *
 * What it asserts:
 *   1. The live read produces a non-empty map for at least one family.
 *   2. Every emitted UUID is a syntactically valid uuid — a short id echoed back
 *      as its own target (the ADR-029 violation) fails here.
 *   3. Feeding that map to `linkifyDelta` renders a real `ask#N` clickable, and
 *      the emitted target round-trips through `parseMinskyUri`.
 *   4. Control: the SAME line against an empty map stays bare, so (3) cannot
 *      pass for a reason unrelated to the map.
 *
 * Skips cleanly (exit 0) when no database is reachable, so an unattended run is
 * safe. Writes to a temp path, never the real cache.
 *
 * Usage: bun scripts/verify-short-id-map.ts
 */
import "reflect-metadata";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { linkifyDelta } from "../.minsky/hooks/entity-linkify";
import { parseMinskyUri } from "../src/cockpit/web/lib/entity-codec";
import {
  buildShortIdEntries,
  type ShortIdEntries,
  type UnsafeSql,
} from "../src/cockpit/short-id-map-cache";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string): never {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

async function resolveRawSql(): Promise<UnsafeSql | null> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");

  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });
  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  const provider = (persistence as { getProvider?: () => unknown } | undefined)?.getProvider?.();
  const candidate = provider ?? persistence;
  const getRawSqlConnection = (candidate as { getRawSqlConnection?: () => Promise<unknown> })
    ?.getRawSqlConnection;
  if (typeof getRawSqlConnection !== "function") return null;
  const sql = await getRawSqlConnection.call(candidate);
  return (sql as UnsafeSql) ?? null;
}

function countEntries(entries: ShortIdEntries): number {
  return Object.values(entries).reduce((sum, family) => sum + Object.keys(family ?? {}).length, 0);
}

async function main(): Promise<void> {
  let sql: UnsafeSql | null = null;
  try {
    sql = await resolveRawSql();
  } catch (err) {
    process.stdout.write(
      `SKIP: no raw-SQL connection (${err instanceof Error ? err.message : String(err)})\n`
    );
    return;
  }
  if (!sql) {
    process.stdout.write("SKIP: persistence provider has no raw-SQL capability\n");
    return;
  }

  const entries = await buildShortIdEntries(sql);
  if (!entries) fail("live read returned null — every family query failed");

  const total = countEntries(entries);
  process.stdout.write(
    `live map: ask=${Object.keys(entries.ask ?? {}).length} ` +
      `memory=${Object.keys(entries.memory ?? {}).length} ` +
      `session=${Object.keys(entries.session ?? {}).length} (total ${total})\n`
  );
  if (total === 0) fail("live read produced an EMPTY map — the binding is not working");

  // (2) every target is a real uuid, never the short id echoed back.
  for (const [kind, family] of Object.entries(entries)) {
    for (const [key, uuid] of Object.entries(family ?? {})) {
      if (!UUID_RE.test(uuid)) fail(`${kind}#${key} maps to a non-uuid target: ${uuid}`);
    }
  }

  // Size the on-disk record the hook will read, since that is the hot-path cost.
  const cachePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "verify-short-id-map-")),
    "short-id-map.json"
  );
  const { writeShortIdMapCache } = await import("../src/cockpit/short-id-map-cache");
  if (!writeShortIdMapCache(entries, Date.now(), cachePath)) fail("cache write failed");
  const bytes = fs.statSync(cachePath).size;

  const started = performance.now();
  const parsed = JSON.parse(String(fs.readFileSync(cachePath, "utf8"))) as {
    entries: ShortIdEntries;
  };
  const readMs = performance.now() - started;
  process.stdout.write(`cache: ${bytes} bytes, read+parse ${readMs.toFixed(2)}ms\n`);

  // (3) the real transform renders a real id clickable.
  const askKey = Object.keys(parsed.entries.ask ?? {})[0];
  if (!askKey) fail("no ask entries to exercise the transform with");
  const askUuid = parsed.entries.ask?.[askKey] ?? "";
  const line = `handing you ask#${askKey} for decision\n`;

  const linked = linkifyDelta(line, { inFence: false }, { shortIdMap: parsed.entries }).text;
  const expected = `handing you [ask#${askKey}](minsky://ask/${askUuid}) for decision\n`;
  if (linked !== expected) fail(`transform output mismatch\n  got:      ${linked}`);

  const uri = linked.slice(linked.indexOf("(") + 1, linked.lastIndexOf(")"));
  const roundTripped = parseMinskyUri(uri);
  if (roundTripped?.type !== "ask" || roundTripped.id !== askUuid) {
    fail(`emitted target does not round-trip: ${uri}`);
  }

  // (4) control — the same line with no map must stay bare.
  const control = linkifyDelta(line, { inFence: false }, { shortIdMap: {} }).text;
  if (control !== line) fail(`control did not stay bare: ${control}`);

  process.stdout.write(`linked:  ${linked.trim()}\n`);
  process.stdout.write(`control: ${control.trim()}\n`);
  process.stdout.write("PASS: live short-id map read, rendered, and round-tripped\n");
  fs.rmSync(path.dirname(cachePath), { recursive: true, force: true });
}

await main();
