#!/usr/bin/env bun
/**
 * How often is a skill actually INVOKED? (mt#4191)
 *
 * ## Why this exists
 *
 * `mt#2544`'s escalation asks two questions about the `check-premise` cue
 * backlog, and the second one — **is INVOCATION rather than cue COUNT the
 * binding constraint?** — had never been measured. A cue nobody invokes and a
 * cue too weak to help fail identically from the outside; only the second is
 * fixed by better cue text, so adding cues without knowing which one is
 * happening is unfalsifiable work.
 *
 * Two incidents on 2026-08-13 put the question on the table qualitatively:
 * mem#1011 found cue (b) "present, correctly scoped, and uninvoked", and a
 * second the same day found `/impeccable` and `/cockpit-design` both scoped to
 * the surface and neither invoked across an entire UI feature. This counts.
 *
 * ## Why not the transcripts store
 *
 * `transcripts_search-text` indexes turn TEXT, so it finds assistant PROSE
 * mentioning a skill and cannot see a `Skill` tool call at all — the two are
 * nearly disjoint populations, and the prose one is the wrong question. The
 * local Claude Code JSONL store carries the actual `tool_use` blocks, which is
 * why this reads there instead.
 *
 * ## What leaves this machine
 *
 * Enumerated per channel, because a claim like this scoped to one channel is
 * the exact failure `claim-confidence.mdc` records for mem#1056:
 *
 * - **stdout** — counts, rates and ISO dates. Never transcript text, never a
 *   prompt, never a file path from inside a conversation.
 * - **the network** — nothing. No embedding, no upload, no fetch; this script
 *   opens no socket on any path.
 * - **files written** — none. It is read-only over the store.
 * - **subprocess argv** — none. It spawns nothing.
 *
 * Usage:
 *   bun scripts/measure-skill-invocation.ts
 *   bun scripts/measure-skill-invocation.ts --skill impeccable --since 2026-07-01
 *   bun scripts/measure-skill-invocation.ts --transcripts <dir> --daily
 *
 * Exit 0 when it completes, including a clean SKIP when the store is absent
 * (CI has no local transcripts).
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parseTranscript, type TranscriptLine } from "../.minsky/hooks/transcript";

const ARGV = process.argv.slice(2);

function flag(name: string): string | undefined {
  const at = ARGV.indexOf(name);
  const value = at >= 0 ? ARGV[at + 1] : undefined;
  return value !== undefined && value !== "" ? value : undefined;
}

const SKILL = flag("--skill") ?? "check-premise";
const SINCE = flag("--since");
const UNTIL = flag("--until");
const DAILY = ARGV.includes("--daily");

/**
 * Claude Code derives its per-project transcript directory from the checkout
 * path with separators replaced by `-`. This script usually runs from a SESSION
 * workspace, whose path is NOT that key, so deriving from `cwd` would silently
 * take the SKIP branch. Resolve by explicit flag, then by unique `*-minsky`
 * match, and report rather than guess when neither settles it.
 */
function resolveTranscriptDir(): string | null {
  const explicit = flag("--transcripts") ?? process.env["MINSKY_TRANSCRIPTS_DIR"];
  if (explicit !== undefined && explicit !== "") return explicit;

  const projects = join(homedir(), ".claude", "projects");
  if (!existsSync(projects)) return null;
  try {
    const matches = readdirSync(projects).filter((n) => n.endsWith("-minsky"));
    if (matches.length === 1) return join(projects, matches[0] as string);
    process.stderr.write(
      `Ambiguous transcript store: ${matches.length} candidates under ${projects}.\n` +
        `Pass --transcripts <dir> to choose one.\n`
    );
    return null;
  } catch {
    // intentional-swallow: an unreadable projects dir is the same as an absent
    // one here, and the caller reports it as a SKIP either way.
    return null;
  }
}

const day = (iso: string): string => iso.slice(0, 10);

function inWindow(iso: string | undefined): boolean {
  if (iso === undefined) return false;
  const d = day(iso);
  if (SINCE !== undefined && d < SINCE) return false;
  if (UNTIL !== undefined && d > UNTIL) return false;
  return true;
}

/**
 * Invocations of `SKILL` in one conversation, as ISO dates.
 *
 * Two shapes count, because both are the skill actually running:
 *
 * - an assistant `tool_use` block named `Skill` whose `input.skill` matches —
 *   the agent invoking it;
 * - a user line carrying `<command-name>/<skill></command-name>` — the operator
 *   typing the slash command.
 *
 * A mention of the skill's NAME in prose does NOT count, which is the whole
 * distinction this script exists to draw.
 */
function invocationDates(lines: readonly TranscriptLine[]): string[] {
  const dates: string[] = [];
  const commandMarker = `<command-name>/${SKILL}</command-name>`;

  for (const line of lines) {
    const ts = line.timestamp;
    if (ts === undefined) continue;

    const content = line.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block === null || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b["type"] !== "tool_use") continue;
        if (b["name"] !== "Skill") continue;
        const input = b["input"];
        const named = (input as Record<string, unknown> | undefined)?.["skill"];
        if (typeof named === "string" && named === SKILL) dates.push(ts);
      }
    }

    // The operator's own slash invocation. Claude Code records it as a user
    // line whose text carries the command marker; `isMeta` lines are the
    // harness's own echo of the skill body and would double-count.
    if (line.isMeta !== true && typeof content === "string" && content.includes(commandMarker)) {
      dates.push(ts);
    }
  }
  return dates;
}

function main(): void {
  const dir = resolveTranscriptDir();
  if (dir === null || !existsSync(dir)) {
    process.stdout.write(
      "SKIP: local Claude Code transcript store not found — this measures invocations from it.\n" +
        "Pass --transcripts <dir> or set MINSKY_TRANSCRIPTS_DIR.\n"
    );
    return;
  }

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch (err) {
    process.stderr.write(`FAIL: cannot read ${dir}: ${String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  const perDay = new Map<string, number>();
  let invocations = 0;
  let conversationsWithInvocation = 0;
  let conversationsInWindow = 0;
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const file of files) {
    const path = join(dir, file);
    let lines: TranscriptLine[];
    try {
      lines = parseTranscript(path);
    } catch {
      // intentional-swallow: one unreadable transcript must not abort the sweep;
      // parseTranscript already returns [] for the ordinary read-error case, so
      // reaching here means something rarer and the file is simply skipped.
      continue;
    }
    if (lines.length === 0) continue;

    // A conversation counts toward the denominator when any of its lines falls
    // in the window — the same test the numerator uses, so the rate compares
    // like with like rather than a windowed numerator over a whole-store total.
    let touchesWindow = false;
    for (const line of lines) {
      if (inWindow(line.timestamp)) {
        touchesWindow = true;
        break;
      }
    }
    if (!touchesWindow) continue;
    conversationsInWindow += 1;

    const dates = invocationDates(lines).filter(inWindow);
    if (dates.length === 0) continue;

    conversationsWithInvocation += 1;
    invocations += dates.length;
    for (const iso of dates) {
      const d = day(iso);
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
      if (earliest === null || d < earliest) earliest = d;
      if (latest === null || d > latest) latest = d;
    }
  }

  const rate =
    conversationsInWindow === 0
      ? 0
      : Math.round((conversationsWithInvocation / conversationsInWindow) * 1000) / 10;

  const window = `${SINCE ?? "store start"} .. ${UNTIL ?? "store end"}`;
  process.stdout.write(
    `skill: /${SKILL}\n` +
      `window: ${window}\n` +
      `transcript files scanned: ${files.length}\n` +
      `conversations in window: ${conversationsInWindow}\n` +
      `conversations invoking it: ${conversationsWithInvocation}  (${rate}%)\n` +
      `total invocations: ${invocations}\n` +
      `first / last invocation: ${earliest ?? "n/a"} / ${latest ?? "n/a"}\n`
  );

  if (DAILY && perDay.size > 0) {
    process.stdout.write("\nper day:\n");
    for (const d of [...perDay.keys()].sort()) {
      process.stdout.write(`  ${d}  ${perDay.get(d)}\n`);
    }
  }
}

main();
