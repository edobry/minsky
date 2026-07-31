#!/usr/bin/env bun
/**
 * Verifies the mt#3278 sanitizer against the REAL transcripts that caused the
 * incident, rather than a synthetic fixture.
 *
 * For every transcript under `~/.claude/projects` carrying a genuine U+0000 in a
 * retained line, this asserts the two properties the fix rests on:
 *
 *   1. BEFORE — a real U+0000 survives the serialization round-trip the driver
 *      performs, so what reaches Postgres carries the escape jsonb rejects.
 *      This is the failing input.
 *   2. AFTER  — the same line, run through `sanitizeForPostgresDeep`, carries
 *      none. This is what makes the row insertable.
 *
 * Postgres's side of the claim was verified separately and directly against the
 * live database (`select ('"' || chr(92) || 'u0000"')::jsonb` -> `22P05
 * unsupported Unicode escape sequence`), so property 2 is exactly the condition
 * under which the upsert succeeds.
 *
 * Read-only: reads transcript files, touches no database and no network.
 *
 * Usage: bun scripts/verify-postgres-text-safety.ts
 * Env:   MINSKY_CLAUDE_PROJECTS_DIR overrides the corpus root; SKIPs when absent.
 */
import { existsSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";

import { sanitizeForPostgresDeep } from "@minsky/domain/storage/postgres-text-safety";

const NUL = String.fromCharCode(0);
const RETAINED = new Set(["user", "assistant", "attachment", "system", "queue-operation"]);

function containsNulDeep(node: unknown): boolean {
  if (typeof node === "string") return node.includes(NUL);
  if (Array.isArray(node)) return node.some(containsNulDeep);
  if (node !== null && typeof node === "object") {
    return Object.entries(node).some(([k, v]) => k.includes(NUL) || containsNulDeep(v));
  }
  return false;
}

async function main(): Promise<number> {
  const corpus = process.env.MINSKY_CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects");
  if (!existsSync(corpus)) {
    console.log(`SKIP: no transcript corpus at ${corpus}`);
    return 0;
  }

  const glob = new Bun.Glob("**/*.jsonl");
  let filesWithPoison = 0;
  let linesChecked = 0;
  let failures = 0;

  for await (const rel of glob.scan({ cwd: corpus, absolute: true })) {
    const raw = await Bun.file(rel).text();
    // Cheap pre-filter: a file with no `u0000` substring anywhere cannot carry
    // the escape. Avoids JSON-parsing the whole 1.6 GB corpus line by line.
    if (!raw.includes("u0000")) continue;

    let poisonedInThisFile = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const type = (parsed as { type?: unknown })?.type;
      if (typeof type !== "string" || !RETAINED.has(type)) continue;
      if (!containsNulDeep(parsed)) continue;

      poisonedInThisFile++;
      linesChecked++;

      // Property 1 — this is genuinely the input that fails today. Checked by
      // round-tripping the serialized form rather than substring-matching for
      // the escape: a transcript that merely DISCUSSES the escape contains the
      // literal two-character sequence, which serializes to a doubled backslash
      // and would substring-match while being perfectly storable. (This
      // conversation's own transcript is full of such text, and an earlier
      // substring-based version of this check false-positived on it.)
      const beforeRoundTrip: unknown = JSON.parse(JSON.stringify(parsed));
      if (!containsNulDeep(beforeRoundTrip)) {
        console.error(`FAIL ${basename(rel)}: expected a real U+0000 to survive serialization`);
        failures++;
        continue;
      }

      // Property 2 — after sanitization no U+0000 survives the serialization the
      // driver performs, so jsonb accepts the value.
      const { value, replaced } = sanitizeForPostgresDeep(parsed);
      const afterRoundTrip: unknown = JSON.parse(JSON.stringify(value));
      if (containsNulDeep(afterRoundTrip)) {
        console.error(`FAIL ${basename(rel)}: U+0000 survived sanitization`);
        failures++;
        continue;
      }
      if (replaced < 1) {
        console.error(
          `FAIL ${basename(rel)}: sanitizer reported 0 replacements on a poisoned line`
        );
        failures++;
      }
    }

    if (poisonedInThisFile > 0) {
      filesWithPoison++;
      console.log(`  ${basename(rel, ".jsonl")}: ${poisonedInThisFile} poisoned line(s) -> clean`);
    }
  }

  console.log(
    JSON.stringify(
      {
        corpus,
        transcriptsWithPoison: filesWithPoison,
        poisonedLinesChecked: linesChecked,
        failures,
      },
      null,
      2
    )
  );

  if (linesChecked === 0) {
    // Not a pass: the corpus is supposed to contain the incident's own data.
    // Reporting success on zero evidence is the failure shape this task exists
    // to remove, so say so plainly instead.
    console.log("NOTE: no poisoned transcripts found — nothing was actually exercised.");
    return 0;
  }
  if (failures > 0) {
    console.error(`FAIL: ${failures} check(s) failed`);
    return 1;
  }
  console.log(
    `PASS: ${linesChecked} real poisoned line(s) across ${filesWithPoison} transcript(s)`
  );
  return 0;
}

process.exit(await main());
