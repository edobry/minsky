/**
 * Split a generated dispatch prompt into what a reader wants and what they don't
 * (mt#4354).
 *
 * A brief is ~6.6 KB and most of it is template: the operating envelope, the
 * embedded skill bodies, the tooling note, the commit instructions. The part
 * that is actually about THIS dispatch — the task, the scope, the instructions
 * — is a small fraction at the top. Rendering all of it flat is what makes the
 * block read as a wall.
 *
 * We can do better than guessing at it, because we GENERATE this text:
 * `packages/domain/src/session/prompt-generation.ts` assembles it from named
 * sections whose headings are exported constants. This module folds exactly
 * those and leaves everything else expanded.
 *
 * **Unrecognized sections stay in the body, deliberately.** The fold list is an
 * allow-list of things known to be boilerplate, not a deny-list of things known
 * to be interesting. If prompt generation grows a new section, the failure mode
 * is "a reader sees something they didn't need to" — recoverable. The inverse
 * default would silently hide new dispatch-specific instructions, which is the
 * failure this whole task exists to stop.
 *
 * @see packages/domain/src/session/prompt-generation.ts — the generator
 * @see @minsky/shared/dispatch-stamp — the marker stripper and stamp parser
 */
import { parseDispatchStamp, stripPromptMarkers } from "@minsky/shared/dispatch-stamp";

/**
 * Section headings that carry generated boilerplate rather than this dispatch's
 * own instructions.
 *
 * Kept as literal strings rather than imported from `prompt-generation.ts`:
 * `custom/no-node-import-in-cockpit-web` (mt#3239) bars `@minsky/domain` value
 * imports from the browser bundle. `dispatch-brief.drift.test.ts` pins these
 * against the generator's exported constants so the duplication cannot rot
 * silently — the same guard `harness-markup` needed for the same reason.
 */
export const FOLDED_SECTION_HEADINGS = [
  "## Operating Envelope",
  "## Recommended Skills",
  "## Embedded Skills",
] as const;

/**
 * The assignment facts the header shows without hover (`cockpit-design`
 * anti-pattern 5: critical state must not be hover-only).
 *
 * Parsed out of the brief's own text, because that is where they are: the
 * generator writes them as prose, not as structured fields, and the render path
 * has no other channel to them. Every field is OPTIONAL — a brief that does not
 * carry one renders without it rather than rendering a blank slot, since the
 * generator has several shapes and not all of them emit all three.
 *
 * **Deliberately absent: agent type and model.** The criterion asks for them and
 * they are genuinely not here — they live in `agent_spawns`, not in the prompt,
 * so parsing cannot reach them. The page already shows the agent kind in its
 * "Spawned by <kind> dispatch" chrome, which is the right home for a
 * conversation-grain fact; duplicating it into a turn-grain header would be the
 * same double-print that `d68f527c0` just removed.
 */
export interface DispatchBriefFacts {
  /** Minsky workspace session the dispatch runs in. */
  sessionId?: string;
  /** Task the dispatch is bound to, e.g. `mt#4248`. */
  taskId?: string;
  /** True when the prompt carries the mt#2865 read-only-bound section. */
  readOnly: boolean;
}

// Anchored on the generator's exact strings (`prompt-generation.ts`), pinned by
// `prompt-generation.dispatch-brief-headings.test.ts` alongside the fold
// headings — same duplication, same reason (mt#3239 bars the value import), same
// guard.
const SESSION_RE = /You are working in Minsky session `([^`]+)`/;
const TASK_RE = /^Task (mt#\d+):/m;
const READ_ONLY_MARKER = "This dispatch is declared **read-only**";

/** Pull the header facts out of a brief's text. */
export function extractDispatchBriefFacts(text: string): DispatchBriefFacts {
  const session = SESSION_RE.exec(text);
  const task = TASK_RE.exec(text);
  return {
    ...(session?.[1] ? { sessionId: session[1] } : {}),
    ...(task?.[1] ? { taskId: task[1] } : {}),
    readOnly: text.includes(READ_ONLY_MARKER),
  };
}

export interface DispatchBriefParts {
  /** The dispatch-specific instructions, markers stripped. */
  body: string;
  /** Generated sections, in the order they appeared. */
  sections: { heading: string; content: string }[];
  /** The mt#2292 dispatch stamp, when the prompt carries one. */
  stamp?: { parentAgentSessionId: string; parentToolUseId: string };
  /** Assignment facts for the header (mt#4354). */
  facts: DispatchBriefFacts;
}

/** True when a line opens one of the folded sections. */
function foldedHeadingOf(line: string): string | null {
  const trimmed = line.trimEnd();
  for (const heading of FOLDED_SECTION_HEADINGS) {
    // Exact match on the whole line: a heading is a heading, and a body line
    // that merely MENTIONS "## Operating Envelope" mid-sentence is prose.
    if (trimmed === heading) return heading;
  }
  return null;
}

/**
 * Split one dispatch prompt.
 *
 * Total by construction: every input line lands in either `body` or exactly one
 * section, so nothing is dropped. A prompt with no recognized headings returns
 * all of it as `body` with an empty `sections` — which is also what an
 * unstamped, unwatermarked turn produces, so this is safe to call on anything.
 */
export function splitDispatchBrief(text: string): DispatchBriefParts {
  const stamp = parseDispatchStamp(text) ?? undefined;
  const lines = stripPromptMarkers(text).split("\n");

  const bodyLines: string[] = [];
  const sections: { heading: string; content: string[] }[] = [];
  let current: { heading: string; content: string[] } | null = null;

  for (const line of lines) {
    const heading = foldedHeadingOf(line);
    if (heading !== null) {
      current = { heading, content: [] };
      sections.push(current);
      continue;
    }
    // A NEW top-level heading ends the folded section it follows — otherwise a
    // folded section would swallow every dispatch-specific section written
    // after it, which is the bug this branch exists to prevent.
    if (current !== null && line.startsWith("## ")) {
      current = null;
      bodyLines.push(line);
      continue;
    }
    (current === null ? bodyLines : current.content).push(line);
  }

  return {
    body: bodyLines.join("\n").trim(),
    sections: sections.map((s) => ({ heading: s.heading, content: s.content.join("\n").trim() })),
    ...(stamp ? { stamp } : {}),
    // Read from the ORIGINAL text, not from `body`: the read-only-bound section
    // and the task line can land in either half depending on which generator
    // shape produced the prompt, and a fact that disappears because it happened
    // to be folded is worse than no fact at all.
    facts: extractDispatchBriefFacts(text),
  };
}
