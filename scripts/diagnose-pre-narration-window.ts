#!/usr/bin/env bun
/**
 * Why does the pre-narration trailing window not suppress these fires? (mt#3864)
 *
 * mt#3864's 2026-08-13 amendment attributed its dominant false-positive class to
 * the detector "requiring the evidencing tool call in the SAME turn". That is
 * false: `TRAILING_WINDOW_TURNS = 12` and `extractWindowToolUseNames` have
 * implemented cross-turn suppression since mt#2671. So the real question — and
 * the one this script answers with a measurement rather than a hypothesis — is
 * why the existing window misses.
 *
 * For every INJECTED (unsuppressed) record it locates the fire in its session
 * transcript, walks backwards counting real-user-prompt boundaries exactly as
 * `extractWindowToolUseNames` does, and reports the boundary distance at which
 * the category's nearest `requiredTools` occurrence sits. That distance splits
 * the population into three causes with three different fixes:
 *
 *   - `within-window`  — a required tool IS inside 12 boundaries, so suppression
 *                        should have fired. A bug in the window path.
 *   - `beyond-window`  — the tool is present but further back than 12. The
 *                        window is too short; widening is the fix.
 *   - `tool-absent`    — no required tool anywhere before the fire. No window
 *                        change can reach this; it is the third-party /
 *                        observed-elsewhere class, and belongs to the
 *                        subject-attribution criterion instead.
 *
 * Read-only. Never writes to the calibration log.
 *
 * Usage:
 *   bun scripts/diagnose-pre-narration-window.ts
 *   bun scripts/diagnose-pre-narration-window.ts --since 2026-08-13
 *   bun scripts/diagnose-pre-narration-window.ts --json
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  OUTCOME_CATEGORIES,
  TRAILING_WINDOW_TURNS,
  extractClaimedPrNumber,
  extractPrNumbersForTools,
  windowSlice,
} from "../.minsky/hooks/pre-narration-detector";
import {
  extractToolUseNames,
  isRealUserPrompt,
  parseTranscript,
} from "../.minsky/hooks/transcript";
import type { TranscriptLine } from "../.minsky/hooks/transcript";

/**
 * Default resolves beside this script. Calibration logs are NOT tracked in git,
 * so a session workspace has none — pass `--log` pointing at the main checkout's
 * copy when running from a session.
 */
const DEFAULT_LOG = resolve(import.meta.dir, "..", ".minsky", "pre-narration-calibration.jsonl");
const PROJECTS_DIR = join(homedir(), ".claude", "projects");

interface CalibrationMatch {
  category: string;
  phrase: string;
  context?: string;
  hadMatchingTool?: boolean;
}
interface CalibrationRecord {
  timestamp: string;
  session_id?: string;
  suppressionReasons?: string[];
  matches?: CalibrationMatch[];
}

type Cause = "within-window" | "beyond-window" | "tool-absent" | "identity-backed" | "unreplayable";

interface Finding {
  timestamp: string;
  sessionId: string;
  category: string;
  phrase: string;
  /** Real-user-prompt boundaries between the fire and the nearest required tool. */
  boundariesBack: number | null;
  cause: Cause;
  detail?: string;
  /**
   * PR/review-related tool names that DO appear in the window, for a
   * `tool-absent` finding. This is what distinguishes "the agent had no
   * evidence" from "the agent had evidence via a tool this category does not
   * list" — two findings with opposite fixes.
   */
  nearbyTools?: string[];
}

/** Tool names worth reporting as candidate evidence for a PR-outcome claim. */
const PR_RELATED = /pr|review|merge|github|changeset|checks/i;

/** Distinct PR-related tool names within the trailing window, most recent first. */
function nearbyPrTools(lines: TranscriptLine[], fireIndex: number): string[] {
  const seen = new Set<string>();
  let boundaries = 0;
  for (let i = fireIndex; i >= 0 && boundaries < TRAILING_WINDOW_TURNS; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    for (const name of extractToolUseNames([line])) {
      if (PR_RELATED.test(name)) seen.add(name);
    }
    if (isRealUserPrompt(line)) boundaries++;
  }
  return [...seen];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Locate a session's transcript across the per-project directories. */
function findTranscript(sessionId: string): string | null {
  if (!existsSync(PROJECTS_DIR)) return null;
  for (const dir of readdirSync(PROJECTS_DIR)) {
    const candidate = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Index of the last line at or before the record's timestamp — the fire point.
 * Returns -1 when the transcript has no line that old (a rotated/truncated file).
 */
function findFireIndex(lines: TranscriptLine[], timestamp: string): number {
  const target = Date.parse(timestamp);
  let best = -1;
  for (let i = 0; i < lines.length; i++) {
    const ts = lines[i]?.timestamp;
    if (typeof ts !== "string") continue;
    if (Date.parse(ts) <= target) best = i;
    else break;
  }
  return best;
}

/**
 * Boundary distance from the fire back to the nearest occurrence of any tool in
 * `requiredTools`, counting real-user-prompt boundaries exactly as
 * `extractWindowToolUseNames` does. `null` when no such tool occurs at all.
 */
function boundaryDistanceToTool(
  lines: TranscriptLine[],
  fireIndex: number,
  requiredTools: readonly string[]
): number | null {
  const required = new Set(requiredTools);
  let boundaries = 0;
  for (let i = fireIndex; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    if (extractToolUseNames([line]).some((n) => required.has(n))) return boundaries;
    if (isRealUserPrompt(line)) boundaries++;
  }
  return null;
}

function main(): void {
  const since = arg("--since") ?? "";
  const asJson = process.argv.includes("--json");
  const logPath = arg("--log") ?? DEFAULT_LOG;

  if (!existsSync(logPath)) {
    console.log(`SKIP: no calibration log at ${logPath}`);
    console.log(
      "(Calibration logs are untracked; from a session pass --log <main-checkout>/.minsky/pre-narration-calibration.jsonl)"
    );
    process.exit(0);
  }

  const records: CalibrationRecord[] = readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as CalibrationRecord)
    .filter((r) => (r.suppressionReasons ?? []).length === 0)
    .filter((r) => (since ? r.timestamp >= since : true));

  const byCategory = new Map(OUTCOME_CATEGORIES.map((c) => [c.key, c]));
  const findings: Finding[] = [];
  const transcriptCache = new Map<string, TranscriptLine[] | null>();

  for (const record of records) {
    const sessionId = record.session_id ?? "";
    if (!transcriptCache.has(sessionId)) {
      const path = sessionId ? findTranscript(sessionId) : null;
      transcriptCache.set(sessionId, path ? parseTranscript(path) : null);
    }
    const lines = transcriptCache.get(sessionId) ?? null;

    for (const match of record.matches ?? []) {
      const category = byCategory.get(match.category);
      const base = {
        timestamp: record.timestamp,
        sessionId,
        category: match.category,
        phrase: match.phrase,
      };
      if (lines === null) {
        findings.push({
          ...base,
          boundariesBack: null,
          cause: "unreplayable",
          detail: "no transcript",
        });
        continue;
      }
      if (category === undefined) {
        findings.push({
          ...base,
          boundariesBack: null,
          cause: "unreplayable",
          detail: "unknown category",
        });
        continue;
      }
      const fireIndex = findFireIndex(lines, record.timestamp);
      if (fireIndex < 0) {
        findings.push({
          ...base,
          boundariesBack: null,
          cause: "unreplayable",
          detail: "fire predates transcript",
        });
        continue;
      }
      const distance = boundaryDistanceToTool(lines, fireIndex, category.requiredTools);

      // Identity-scoped evidence (PR #3096 R1) is not a name match, so boundary
      // distance cannot express it: it holds only when the PR the claim NAMES
      // was actually read. Evaluated on the same terms the detector uses —
      // otherwise this script's before/after would misreport the very fix it
      // exists to measure.
      // WINDOW-scoped, matching the detector after PR #3096 R2. Slicing to the
      // fire and then taking the window is what the detector sees; using the
      // full pre-fire history here would re-introduce, in the measurement, the
      // exact scope mismatch R2 removed from the code.
      const claimedPr = extractClaimedPrNumber(match.phrase);
      const identityBacked =
        claimedPr !== null &&
        extractPrNumbersForTools(
          windowSlice(lines.slice(0, fireIndex + 1), TRAILING_WINDOW_TURNS),
          category.identityScopedTools ?? []
        ).has(claimedPr);

      const cause: Cause = identityBacked
        ? "identity-backed"
        : distance === null
          ? "tool-absent"
          : distance < TRAILING_WINDOW_TURNS
            ? "within-window"
            : "beyond-window";
      findings.push({
        ...base,
        boundariesBack: distance,
        cause,
        ...(cause === "tool-absent" ? { nearbyTools: nearbyPrTools(lines, fireIndex) } : {}),
      });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ windowTurns: TRAILING_WINDOW_TURNS, findings }, null, 2));
    return;
  }

  const tally = new Map<string, number>();
  for (const f of findings) {
    const key = `${f.category}\t${f.cause}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }

  console.log(`Window = ${TRAILING_WINDOW_TURNS} real-user-prompt boundaries.`);
  console.log(`Injected matches examined: ${findings.length}${since ? ` (since ${since})` : ""}\n`);
  for (const [key, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    const [category, cause] = key.split("\t");
    console.log(`  ${String(count).padStart(3)}  ${category} — ${cause}`);
  }
  console.log("\nPer-match detail:");
  for (const f of findings) {
    const dist = f.boundariesBack === null ? "none" : `${f.boundariesBack} back`;
    console.log(
      `  [${f.cause}] ${f.category} (${dist}) "${f.phrase}"${f.detail ? ` — ${f.detail}` : ""}`
    );
    if (f.cause === "tool-absent" && f.nearbyTools !== undefined) {
      console.log(`        tools actually in window: ${f.nearbyTools.join(", ") || "(none)"}`);
    }
  }
}

main();
