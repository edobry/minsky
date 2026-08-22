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

export interface DispatchBriefParts {
  /** The dispatch-specific instructions, markers stripped. */
  body: string;
  /** Generated sections, in the order they appeared. */
  sections: { heading: string; content: string }[];
  /** The mt#2292 dispatch stamp, when the prompt carries one. */
  stamp?: { parentAgentSessionId: string; parentToolUseId: string };
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
  };
}
