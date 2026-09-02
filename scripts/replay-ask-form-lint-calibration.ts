#!/usr/bin/env bun
/**
 * Replay the `ask-form-lint` calibration corpus against the CURRENT matchers
 * (mt#4901 AT5 / SC4).
 *
 * Read-only. No `--execute` branch, because it mutates nothing.
 *
 * ## Why a fetch, not a log read
 *
 * `ask-form-lint-calibration.jsonl` carries no judged text — every record holds
 * `askId`, `kind`, the fired `matches`, and `acknowledged`. The judged text is
 * recoverable from the PRIMARY artifact instead: the ask body is exactly what
 * the lint read, so this script fetches each subject ask and re-runs the
 * matcher over it.
 *
 * ## The honesty caveat this prints rather than hides
 *
 * An ask body is MUTABLE. Re-running the matcher answers "what would the check
 * say TODAY", never "what was it judging when it fired" — and mt#3584 lost a
 * real false positive to exactly that conflation. So each row is labelled with
 * whether the body has been edited since the record was written
 * (`metadata.editHistory`), and where a pre-edit body was preserved
 * (`metadata.originalContent`, mt#4329) the replay uses THAT instead and says
 * so. A row marked `edited-since, original unavailable` is a replay against a
 * body the recorded fire never saw; it is reported, not silently averaged in.
 */
import "reflect-metadata";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { AskRepository } from "@minsky/domain/ask/repository";
import type { Ask, AskKind } from "@minsky/domain/ask/types";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";

const { resolveCalibrationLogDir } = await import("../.minsky/hooks/coverage-receipt");
const { computeFormLintMatches } = await import("@minsky/domain/ask/form-lint");
const { normalizeQuestionForLint } = await import("../src/adapters/shared/commands/asks");

const LOG_NAME = "ask-form-lint-calibration.jsonl";

interface CalibrationRecord {
  timestamp: string;
  askId: string;
  kind: string;
  acknowledged?: boolean;
  matches: Array<{ class: string; phrase: string }>;
}

/** Body provenance for one replayed record — see the docblock's honesty caveat. */
type BodySource = "as-filed" | "original-content" | "edited-since";

async function buildAskRepository(): Promise<AskRepository> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
  const { DrizzleAskRepository } = await import("@minsky/domain/ask/repository");

  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (!persistence || !(persistence instanceof PersistenceProvider)) {
    throw new Error("Replay requires a SQL-capable persistence provider (Postgres).");
  }
  const sqlProvider = persistence as SqlCapablePersistenceProvider;
  const connection = await sqlProvider.getDatabaseConnection?.();
  if (!connection) {
    throw new Error("Replay requires an initialized Postgres database connection.");
  }
  return new DrizzleAskRepository(connection);
}

/**
 * Resolve the corpus path.
 *
 * `--log <path>` exists because `resolveCalibrationLogDir` keys on the CURRENT
 * WORKING DIRECTORY, so running this from a session workspace resolves to that
 * workspace's own (empty) project key rather than the project's — mt#4885,
 * which owns the general fix. Without the override the script would read an
 * empty directory and report a clean zero, which is the silent-zero shape
 * mt#4784 already had to repair once in this family.
 */
function resolveLogPath(cwd: string): string {
  const flag = process.argv.indexOf("--log");
  if (flag !== -1) {
    const value = process.argv[flag + 1];
    if (!value) throw new Error("--log requires a path argument");
    return value;
  }
  return join(resolveCalibrationLogDir(cwd), LOG_NAME);
}

function readRecords(cwd: string): CalibrationRecord[] {
  const path = resolveLogPath(cwd);
  console.log(`Log: ${path}`);
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CalibrationRecord);
}

/**
 * Pick the body to replay, preferring the text the fire actually judged.
 *
 * `metadata.originalContent` (mt#4329) preserves the pre-edit body, so when the
 * ask was edited after the record was written and that snapshot exists, it is
 * the faithful input. Otherwise the current body is used and labelled.
 */
function selectBody(ask: Ask, recordedAt: string): { question: string; source: BodySource } {
  const metadata = (ask.metadata ?? {}) as {
    editHistory?: Array<{ editedAt?: string }>;
    originalContent?: { question?: string };
  };
  const editedSince = (metadata.editHistory ?? []).some(
    (e) => typeof e.editedAt === "string" && e.editedAt > recordedAt
  );
  if (!editedSince) return { question: ask.question, source: "as-filed" };
  const original = metadata.originalContent?.question;
  if (typeof original === "string" && original.length > 0) {
    return { question: original, source: "original-content" };
  }
  return { question: ask.question, source: "edited-since" };
}

function classesNow(ask: Ask, question: string): string[] {
  // Normalize exactly as the create path does, contextRefs included — the lint
  // reads the PERSISTED text, never the caller's raw input (mt#2918).
  const { question: normalized } = normalizeQuestionForLint({
    question,
    contextRefs: ask.contextRefs,
  });
  return computeFormLintMatches({
    kind: ask.kind as AskKind,
    question: normalized ?? question,
    options: ask.options,
    forceImmediate: ask.forceImmediate,
    severity: ask.severity,
  }).map((m) => m.check);
}

async function main(): Promise<void> {
  // Drop `--log` AND the path that follows it, so an override path is never
  // mistaken for a match-class filter.
  const argv = process.argv.slice(2);
  const logFlagAt = argv.indexOf("--log");
  const only = argv.filter(
    (a, i) => !a.startsWith("--") && !(logFlagAt !== -1 && i === logFlagAt + 1)
  );
  const records = readRecords(process.cwd());
  const repo = await buildAskRepository();

  const targeted = only.length > 0 ? only : ["domain-jargon", "unlinkified-reference"];
  const subject = records.filter((r) => r.matches.some((m) => targeted.includes(m.class)));

  console.log(`Corpus: ${records.length} records; ${subject.length} carry ${targeted.join(" / ")}`);
  console.log("");

  let cleared = 0;
  let retained = 0;
  let unfetchable = 0;

  for (const record of subject) {
    const ask = await repo.getById(record.askId);
    if (!ask) {
      unfetchable++;
      console.log(`${record.timestamp}  ${record.askId}  UNFETCHABLE (ask not in store)`);
      continue;
    }
    const { question, source } = selectBody(ask, record.timestamp);
    const before = record.matches.map((m) => m.class);
    const after = classesNow(ask, question);

    for (const cls of before.filter((c) => targeted.includes(c))) {
      if (after.includes(cls)) retained++;
      else cleared++;
    }

    const label = ask.shortId ?? record.askId.slice(0, 8);
    const delta = before
      .filter((c) => targeted.includes(c))
      .map((c) => `${c}: ${after.includes(c) ? "STILL FIRES" : "cleared"}`)
      .join("; ");
    console.log(`${record.timestamp}  ${label.padEnd(12)}  [${source}]  ${delta}`);
    console.log(`    before: ${before.join(", ") || "(none)"}`);
    console.log(`    after:  ${after.join(", ") || "(none)"}`);
  }

  console.log("");
  console.log(`cleared: ${cleared}   still fires: ${retained}   unfetchable: ${unfetchable}`);
  if (unfetchable > 0) {
    console.log("NOTE: an unfetchable ask is not a pass — its record could not be re-judged.");
  }
}

await main();
