#!/usr/bin/env bun
/**
 * Replay mt#4160's author-linked suppression over the REAL calibration record
 * and the REAL session transcripts.
 *
 * ## Why this exists rather than only unit tests
 *
 * Every acceptance test for this change is a NEGATIVE assertion ("this finding
 * is suppressed"), and mem#1020 records what that shape costs: a fixture that
 * reaches no matcher passes vacuously and survives its own negative control.
 * The unit tests answer that with hand-checked verbatim fixtures — but a
 * fixture is still text this session wrote down. This script answers the
 * question the fixtures cannot: does the suppression fire on the production
 * records, resolved through the production transcript shape, at the rate the
 * task measured?
 *
 * It is also the substrate check `/implement-task` §7a asks for: the binding
 * resolution reads a Claude Code transcript, and the only place that shape is
 * authoritative is a real one.
 *
 * ## What it does
 *
 * For every `bare-short-id` fire in `.minsky/bare-entity-ref-calibration.jsonl`,
 * recover the judged message from that session's transcript (the last assistant
 * text block at or before the fire timestamp), re-run the scan, and apply the
 * suppression using bindings harvested from the same transcript. Reports how
 * many fires the suppression removes and how many it leaves.
 *
 * Exit 0 = replay completed (with its counts). Exit 1 = replay could not run.
 *
 *   bun scripts/replay-bare-entity-ref-suppression.ts
 *   bun scripts/replay-bare-entity-ref-suppression.ts --json
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  partitionAuthorLinkedShortIds,
  scanMessage,
  shortIdsNeedingResolution,
} from "../.minsky/hooks/bare-entity-ref-scan";
import { collectShortIdBindings, type TranscriptLine } from "../.minsky/hooks/transcript";

const CALIBRATION_LOG = ".minsky/bare-entity-ref-calibration.jsonl";
const PROJECTS_ROOT = join(homedir(), ".claude", "projects");

interface CalibrationRecord {
  timestamp?: string;
  session_id?: string;
  matches?: Array<{ family?: string; phrase?: string }>;
}

interface Verdict {
  ref: string;
  firedAt: string;
  session: string;
  outcome: "suppressed" | "still-flagged" | "no-transcript" | "no-message" | "no-refire";
  matchedUuid?: string;
}

/** Every project directory under ~/.claude/projects that might hold a session. */
function transcriptPathFor(sessionId: string): string | undefined {
  if (!existsSync(PROJECTS_ROOT)) return undefined;
  for (const project of readdirSync(PROJECTS_ROOT)) {
    const candidate = join(PROJECTS_ROOT, project, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function parseLines(path: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (!raw) continue;
    try {
      lines.push(JSON.parse(raw) as TranscriptLine);
    } catch {
      // intentional-swallow: a torn trailing line in an append-only transcript
      // must not abort the replay over everything before it.
      continue;
    }
  }
  return lines;
}

/**
 * The assistant text the detector judged: the last assistant text block at or
 * before the fire. Matches how the guard reads `last_assistant_message`, for a
 * point in the past where that field is no longer available.
 */
function judgedMessageAt(lines: TranscriptLine[], firedAtMs: number): string {
  let latest = "";
  for (const line of lines) {
    const ts = line.timestamp ? Date.parse(line.timestamp) : NaN;
    if (!Number.isFinite(ts) || ts > firedAtMs) continue;
    if (line.type !== "assistant") continue;
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    const text = (content as Array<Record<string, unknown>>)
      .filter((b) => b && b["type"] === "text" && typeof b["text"] === "string")
      .map((b) => b["text"] as string)
      .join("\n");
    if (text.trim()) latest = text;
  }
  return latest;
}

function main(): number {
  const asJson = process.argv.includes("--json");

  if (!existsSync(CALIBRATION_LOG)) {
    console.log(`SKIP: ${CALIBRATION_LOG} not present — nothing to replay.`);
    return 0;
  }
  if (!existsSync(PROJECTS_ROOT)) {
    console.log(`SKIP: ${PROJECTS_ROOT} not present — transcripts unavailable.`);
    return 0;
  }

  const verdicts: Verdict[] = [];
  const transcriptCache = new Map<string, TranscriptLine[] | null>();

  for (const raw of readFileSync(CALIBRATION_LOG, "utf8").split("\n")) {
    if (!raw.trim()) continue;
    let record: CalibrationRecord;
    try {
      record = JSON.parse(raw) as CalibrationRecord;
    } catch {
      continue;
    }
    const shortIdFires = (record.matches ?? []).filter((m) => m.family === "bare-short-id");
    if (shortIdFires.length === 0) continue;

    const session = record.session_id ?? "";
    const firedAt = record.timestamp ?? "";
    const firedAtMs = Date.parse(firedAt);
    if (!session || !Number.isFinite(firedAtMs)) continue;

    if (!transcriptCache.has(session)) {
      const path = transcriptPathFor(session);
      transcriptCache.set(session, path ? parseLines(path) : null);
    }
    const lines = transcriptCache.get(session) ?? null;

    for (const fire of shortIdFires) {
      const ref = fire.phrase ?? "";
      if (!ref) continue;
      if (lines === null) {
        verdicts.push({ ref, firedAt, session, outcome: "no-transcript" });
        continue;
      }
      const message = judgedMessageAt(lines, firedAtMs);
      if (!message) {
        verdicts.push({ ref, firedAt, session, outcome: "no-message" });
        continue;
      }

      const scan = scanMessage(message);
      // The replay is only meaningful for a message the scanner still flags —
      // if the recovered text does not reproduce the fire, this record cannot
      // discriminate anything and must not be counted as a pass either way
      // (mem#1020: an inert input is silent under a negative assertion).
      if (!scan.flagged.some((f) => f.ref.toLowerCase() === ref.toLowerCase())) {
        verdicts.push({ ref, firedAt, session, outcome: "no-refire" });
        continue;
      }

      const candidates = shortIdsNeedingResolution(scan.flagged, scan.linkTargets);
      const { flagged, authorLinked } =
        candidates.length > 0
          ? partitionAuthorLinkedShortIds(
              scan.flagged,
              scan.linkTargets,
              collectShortIdBindings(lines)
            )
          : { flagged: scan.flagged, authorLinked: [] };

      const suppressed = authorLinked.find((f) => f.ref.toLowerCase() === ref.toLowerCase());
      if (suppressed) {
        verdicts.push({
          ref,
          firedAt,
          session,
          outcome: "suppressed",
          matchedUuid: /minsky:\/\/\w+\/([0-9a-f-]{36})/i.exec(suppressed.reason)?.[1],
        });
      } else if (flagged.some((f) => f.ref.toLowerCase() === ref.toLowerCase())) {
        verdicts.push({ ref, firedAt, session, outcome: "still-flagged" });
      }
    }
  }

  const tally = (outcome: Verdict["outcome"]): number =>
    verdicts.filter((v) => v.outcome === outcome).length;

  const summary = {
    totalShortIdFires: verdicts.length,
    reproduced: verdicts.length - tally("no-transcript") - tally("no-message") - tally("no-refire"),
    suppressed: tally("suppressed"),
    stillFlagged: tally("still-flagged"),
    noTranscript: tally("no-transcript"),
    noMessage: tally("no-message"),
    noRefire: tally("no-refire"),
  };

  if (asJson) {
    console.log(JSON.stringify({ summary, verdicts }, null, 2));
    return 0;
  }

  console.log("bare-entity-ref author-linked suppression — replay over real records\n");
  for (const v of verdicts) {
    const detail = v.matchedUuid ? `  (matched ${v.matchedUuid})` : "";
    console.log(`  ${v.outcome.padEnd(14)} ${v.ref.padEnd(10)} ${v.firedAt}${detail}`);
  }
  console.log(
    `\n  ${summary.totalShortIdFires} bare-short-id fires; ${summary.reproduced} reproduced from transcript.` +
      `\n  SUPPRESSED: ${summary.suppressed}   STILL FLAGGED: ${summary.stillFlagged}` +
      `\n  not replayable: ${summary.noTranscript} no-transcript, ${summary.noMessage} no-message, ${summary.noRefire} no-refire`
  );
  return 0;
}

process.exit(main());
