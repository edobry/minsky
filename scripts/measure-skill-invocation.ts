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

/** Does this tool call name `skill`? */
function callsThisSkill(name: unknown, input: unknown, skill: string): boolean {
  if (name !== "Skill") return false;
  const named = (input as Record<string, unknown> | undefined)?.["skill"];
  return typeof named === "string" && named === skill;
}

/**
 * Invocations of `SKILL` in one conversation, as ISO dates.
 *
 * A mention of the skill's NAME in prose does NOT count — that distinction is
 * the whole point of reading tool calls rather than searching turn text.
 *
 * **Four line shapes count, and reading only one of them is how this
 * undercounts to zero (PR #3052 R1).** The reviewer caught the agent's tool
 * call in only its nested form; the same miss applies to the operator's slash
 * command, so both are handled in both shapes:
 *
 * | Who | Nested in `message.content` | Top-level on the line |
 * | --- | --- | --- |
 * | agent | `{type:"tool_use", name:"Skill"}` block | `type === "tool_use"` + `name`/`tool_name` |
 * | operator | `{type:"text"}` block carrying the marker | string `content` carrying the marker |
 *
 * The top-level tool_use form is not hypothetical: `extractToolUseNames` and
 * `findToolUseInputs` in `.minsky/hooks/transcript.ts` both handle it, and
 * `TranscriptLine`'s own comment records it ("tool_use lines may carry
 * name/input at top level OR inside message.content"). A counter that reads one
 * shape is biased toward zero — the direction that would have CONFIRMED this
 * script's headline finding, which is why it needed catching.
 */
export function invocationDates(lines: readonly TranscriptLine[], skill: string): string[] {
  const dates: string[] = [];
  const commandMarker = `<command-name>/${skill}</command-name>`;

  for (const line of lines) {
    const ts = line.timestamp;
    if (ts === undefined) continue;

    // Shape 1 — agent call, top-level line form.
    if (
      line.type === "tool_use" &&
      callsThisSkill(line.name ?? line.tool_name, line.input, skill)
    ) {
      dates.push(ts);
      continue;
    }

    const content = line.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block === null || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        // Shape 2 — agent call, nested block form.
        if (b["type"] === "tool_use" && callsThisSkill(b["name"], b["input"], skill))
          dates.push(ts);
        // Shape 3 — operator slash command, nested text-block form.
        const text = b["text"];
        if (
          line.isMeta !== true &&
          b["type"] === "text" &&
          typeof text === "string" &&
          text.includes(commandMarker)
        ) {
          dates.push(ts);
        }
      }
    }

    // Shape 4 — operator slash command, string-content form. Claude Code
    // records it as a user
    // line whose text carries the command marker; `isMeta` lines are the
    // harness's own echo of the skill body and would double-count.
    if (line.isMeta !== true && typeof content === "string" && content.includes(commandMarker)) {
      dates.push(ts);
    }
  }
  return dates;
}

/**
 * Every transcript in the store, grouped by the CONVERSATION it belongs to.
 *
 * A parent conversation is `<store>/<conversation-id>.jsonl`. Its dispatched
 * subagents write to `<store>/<conversation-id>/subagents/agent-<id>.jsonl` —
 * a nested directory a flat `readdirSync` of the store never reaches, which is
 * PR #3052 R2. Measured on this store when the finding landed: **558 parent
 * transcripts against 927 subagent transcripts**, so a top-level-only sweep
 * reads under 38% of the files and reports a number bounded to a population it
 * never names.
 *
 * Subagent files are attributed to their PARENT conversation rather than
 * counted as conversations of their own: a subagent is work dispatched inside a
 * conversation, so "did this conversation invoke the skill" is true when the
 * parent or any of its subagents did.
 */
function collectTranscripts(dir: string): Map<string, string[]> {
  const byConversation = new Map<string, string[]>();
  const add = (conversation: string, path: string): void => {
    const paths = byConversation.get(conversation);
    if (paths === undefined) byConversation.set(conversation, [path]);
    else paths.push(path);
  };

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      add(entry.name.replace(/\.jsonl$/, ""), join(dir, entry.name));
      continue;
    }
    if (!entry.isDirectory()) continue;
    const subagents = join(dir, entry.name, "subagents");
    if (!existsSync(subagents)) continue;
    try {
      // Recursive: workflow runs nest one level deeper again, at
      // `subagents/workflows/<wf-id>/agent-*.jsonl`. Measured on this store, a
      // one-level read finds 870 of the 927 subagent transcripts and misses 57.
      for (const file of readdirSync(subagents, { recursive: true })) {
        const name = String(file);
        if (name.endsWith(".jsonl")) add(entry.name, join(subagents, name));
      }
    } catch {
      // intentional-swallow: an unreadable subagents dir costs coverage for one
      // conversation and must not abort the sweep over the other 557.
    }
  }
  return byConversation;
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

  let byConversation: Map<string, string[]>;
  try {
    byConversation = collectTranscripts(dir);
  } catch (err) {
    process.stderr.write(`FAIL: cannot read ${dir}: ${String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  const perDay = new Map<string, number>();
  let invocations = 0;
  let conversationsWithInvocation = 0;
  let conversationsInWindow = 0;
  let parentFiles = 0;
  let subagentFiles = 0;
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const paths of byConversation.values()) {
    const lines: TranscriptLine[] = [];
    for (const path of paths) {
      if (path.includes("/subagents/")) subagentFiles += 1;
      else parentFiles += 1;
      try {
        lines.push(...parseTranscript(path));
      } catch {
        // intentional-swallow: one unreadable transcript must not abort the
        // sweep; parseTranscript already returns [] for the ordinary read-error
        // case, so reaching here means something rarer and the file is skipped.
        continue;
      }
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

    const dates = invocationDates(lines, SKILL).filter(inWindow);
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
      `transcript files scanned: ${parentFiles + subagentFiles} ` +
      `(${parentFiles} parent + ${subagentFiles} subagent)\n` +
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

// Guarded so the shape-matching above can be imported and tested without the
// sweep running as a side effect of the import.
if (import.meta.main) main();
