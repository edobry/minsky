/**
 * Injected-content detector (mt#2791; coverage widened mt#3322).
 *
 * Harness-injected content — slash-command wrappers, local-command output,
 * skill-body preambles, and `<system-reminder>` blocks — would otherwise
 * render as full-weight USER prose in the cockpit conversation view: a
 * `/plan-task` invocation injects the entire skill body (~20 screens of
 * Markdown) before any real work appears, and a bare `/model` injects three
 * separate turns of raw XML, burying the conversation's real signal.
 *
 * `splitInjectedContent` classifies one user turn's raw text into an ordered
 * list of {@link TextSegment}s — genuine operator PROSE, and INJECTED spans
 * labeled by origin — so the renderer (`ConversationView.tsx`) can collapse
 * the injected spans behind a muted, expandable header while leaving prose
 * untouched. Pure, dependency-free apart from the shared tag inventory and
 * the ANSI stripper.
 *
 * Detection is deliberately conservative — anchored patterns, not
 * substring-anywhere matching:
 *   - The command wrapper, local-command blocks, and the skill-body preamble
 *     ("Base directory for this skill:") are anchored to the START of the
 *     turn's remaining text only — that mirrors how the harness actually
 *     injects them. Genuine prose that happens to mention either mid-sentence
 *     is NOT matched: the anchor is turn-start, not "found anywhere."
 *   - `<system-reminder>...</system-reminder>` blocks are matched WHEREVER
 *     they appear in the remaining text — the harness can interleave several
 *     reminders with real content in one turn — but the tag itself is a
 *     highly distinctive token vanishingly unlikely to appear in
 *     operator-authored prose, so a non-anchored match stays conservative in
 *     practice.
 *
 * **Why the wrapper match is order-tolerant (mt#3322).** The original
 * implementation encoded the wrapper as a FIXED sequence beginning with
 * `<command-message>`. The harness emits both orderings, and the far more
 * common one leads with `<command-name>` — so the anchored pattern silently
 * failed on it and the raw XML fell through to the prose path. Measured over
 * the local transcript corpus before the fix: of 134 turn-start command
 * wrappers, 124 led with `command-name` and NONE of those were detected; all
 * 118 `local-command-stdout` and 125 `local-command-caveat` turns were
 * likewise undetected. This module now consumes wrapper blocks in whatever
 * order they arrive, from the shared inventory in
 * `@minsky/shared/harness-markup`.
 *
 * Unrecognized content is untouched: when nothing matches, `splitInjectedContent`
 * returns a single `{ type: "prose", text }` segment carrying the ORIGINAL
 * string verbatim — the "renders exactly as today" success criterion. ANSI
 * stripping is applied ONLY to injected-span content, never to prose, so that
 * verbatim guarantee is unaffected. A turn that mixes an injected prefix with
 * genuine prose (e.g. a slash-command wrapper followed by operator-typed
 * continuation text) splits into an injected segment plus a separate prose
 * segment — the injected span collapses, the prose does not.
 *
 * @see mt#2791 — this module
 * @see mt#3322 — order-tolerant wrapper matching, local-command kinds, ANSI stripping
 * @see packages/shared/src/harness-markup.ts — the shared tag inventory
 * @see packages/domain/src/transcripts/text-snippet.ts (mt#2784) — sibling detector
 *   for the conversation-LABEL surface (discards harness markup entirely rather
 *   than preserving it for an expandable view); it consumes the same inventory.
 * @see src/cockpit/web/widgets/ConversationView.tsx — the consumer
 */
import {
  COMMAND_WRAPPER_TAGS,
  LOCAL_COMMAND_TAGS,
  TASK_NOTIFICATION_TAGS,
  tagBlockSource,
  tagOpenSource,
} from "@minsky/shared/harness-markup";
import { INTERRUPTION_NOTICE_PREFIX } from "@minsky/shared/minsky-notices";
import { stripAnsi } from "@minsky/shared/strip-ansi";

/** Origin classification for one injected span. */
export type InjectedContentKind =
  | "command"
  | "skill-body"
  | "system-reminder"
  | "local-command-output"
  | "local-command-caveat"
  | "task-notification"
  | "session-notice";

/** Defensive bound on how many wrapper blocks one turn-start run may consume.
 * The harness emits at most four (`command-name` / `command-message` /
 * `command-args` / `skill-format`); the cap keeps a pathological input from
 * driving an unbounded scan. Every iteration consumes at least one character,
 * so this is a belt-and-braces limit, not a termination requirement.
 */
const MAX_WRAPPER_BLOCKS = 8;

// The skill-body preamble, anchored to whatever remains after the (optional)
// wrapper run. Kept separate from the wrapper match so a bare preamble with no
// wrapper still matches — the pre-mt#3322 behavior.
const SKILL_PREAMBLE_RE = /^\s*Base directory for this skill:\s*(\S+)/i;

// NOT anchored — matched wherever it appears (see module docblock). Built
// fresh per call in splitSystemReminderBlocks (global-flagged regexes carry
// mutable `lastIndex` state across `.exec()` calls; a shared module-level
// instance would leak state between the many turns this runs over per render).
function systemReminderRegex(): RegExp {
  return new RegExp(tagBlockSource("system-reminder", true), "gi");
}

// Boundary marker for a multi-skill-concatenated turn: once a skill-body span
// is detected, its content stops at the NEXT recognized turn-start anchor
// rather than swallowing the rest of the turn. Deliberately narrower than the
// full wrapper inventory — only the two tags that actually LEAD a wrapper run
// (plus `<system-reminder>`) are boundaries, so a skill body mentioning
// `<command-args>` in prose is not cut short.
const NEXT_BOUNDARY_RE = new RegExp(
  `(?:${tagOpenSource("command-name")}|${tagOpenSource("command-message")}|${tagOpenSource("system-reminder")})`,
  "i"
);

/** One detected injected span: a muted collapsed header + its full content. */
export interface InjectedSpan {
  kind: InjectedContentKind;
  /** One-line muted header label, e.g. "command: /model". */
  label: string;
  /** Full content of the span, rendered on expand (harness wrapper tags stripped). */
  content: string;
}

/** One segment of a turn's text after injected-content classification. */
export type TextSegment =
  | { type: "prose"; text: string }
  | { type: "injected"; span: InjectedSpan };

/**
 * The generic noun for each injected kind — the vocabulary of harness origins,
 * in ONE place (mt#3374).
 *
 * Two surfaces name these: the collapsed span's own header (built below, which
 * appends the specific command or skill name where it has one), and the turn's
 * origin label (`./turn-origin.ts`, which wants the bare noun). PR #2442 R1
 * caught them drifting — a caveat span read `harness caveat` while its turn
 * header read `command caveat`, two names for one thing. Deriving both from
 * here is what makes that drift impossible rather than merely fixed.
 */
export const INJECTED_KIND_NOUN: Record<InjectedContentKind, string> = {
  command: "command",
  "skill-body": "skill body",
  "system-reminder": "system reminder",
  "local-command-output": "command output",
  "local-command-caveat": "harness caveat",
  "task-notification": "task notification",
  // NOT "harness notice" (mt#3396): this text is MINSKY's own
  // (`INTERRUPTION_NOTICE_TEXT`), not the harness's. Naming it "harness" would
  // layer a second misattribution on top of the one this task removes — the
  // whole point is that a notice Minsky wrote must not be presented as someone
  // else's words, whether that someone is the operator or the harness.
  "session-notice": "session notice",
};

/**
 * Per-tag presentation for a whole-block tag at turn start.
 *
 * Covers the local-command pair and, since mt#3396, `task-notification` — one
 * table and one matcher rather than a parallel path per tag family, because
 * they are the same shape (a paired tag whose entire block leads the turn) and
 * a second code path is how the two tag lists this module consumes drifted
 * apart in the first place.
 */
const TURN_START_TAG_PRESENTATION: Record<string, { kind: InjectedContentKind; label: string }> = {
  "local-command-stdout": {
    kind: "local-command-output",
    label: INJECTED_KIND_NOUN["local-command-output"],
  },
  "local-command-caveat": {
    kind: "local-command-caveat",
    label: INJECTED_KIND_NOUN["local-command-caveat"],
  },
  "task-notification": {
    kind: "task-notification",
    label: INJECTED_KIND_NOUN["task-notification"],
  },
};

function skillNameFromPath(path: string): string {
  const segments = path.split(/[\\/]/).filter((s) => s.length > 0);
  return segments[segments.length - 1] || path;
}

function findNextBoundary(text: string, fromIndex: number): number {
  const tail = text.slice(fromIndex);
  const match = NEXT_BOUNDARY_RE.exec(tail);
  return match ? fromIndex + match.index : text.length;
}

interface PrefixMatch {
  consumedLength: number;
  span: InjectedSpan;
}

// Turn-start matchers, compiled ONCE at module load rather than per call
// (PR #2403 R1, non-blocking): `splitInjectedContent` runs over every user
// turn on every render, and the wrapper scan loops over all four tags per
// block consumed. These are safe to share because none carries the `g` flag —
// only global-flagged regexes hold mutable `lastIndex` state between calls
// (which is why `systemReminderRegex()` above is still built per call).
const WRAPPER_BLOCK_MATCHERS: ReadonlyArray<{ tag: string; re: RegExp }> = COMMAND_WRAPPER_TAGS.map(
  (tag) => ({ tag, re: new RegExp(`^${tagBlockSource(tag, true)}`, "i") })
);

const TURN_START_TAG_MATCHERS: ReadonlyArray<{ tag: string; re: RegExp }> = [
  ...LOCAL_COMMAND_TAGS,
  ...TASK_NOTIFICATION_TAGS,
].map((tag) => ({ tag, re: new RegExp(`^\\s*${tagBlockSource(tag, true)}`, "i") }));

/** One wrapper block matched at the head of `text`, whichever tag it is. */
function matchOneWrapperBlock(text: string): { tag: string; body: string; length: number } | null {
  for (const { tag, re } of WRAPPER_BLOCK_MATCHERS) {
    const match = re.exec(text);
    if (match) return { tag, body: (match[1] ?? "").trim(), length: match[0].length };
  }
  return null;
}

interface WrapperRun {
  consumed: number;
  /** First-seen body per wrapper tag, e.g. `command-name` -> "/model". */
  parts: Map<string, string>;
}

/**
 * Consume a run of consecutive command-wrapper blocks at the head of `text`,
 * in ANY order (see module docblock). Returns null when the text does not
 * start with one.
 */
function consumeWrapperRun(text: string): WrapperRun | null {
  const parts = new Map<string, string>();
  let consumed = 0;

  for (let i = 0; i < MAX_WRAPPER_BLOCKS; i++) {
    const rest = text.slice(consumed);
    const leadingWhitespace = /^\s*/.exec(rest)?.[0].length ?? 0;
    const block = matchOneWrapperBlock(rest.slice(leadingWhitespace));
    if (!block) break;
    // First occurrence wins — a duplicated tag in one run is malformed input,
    // and preferring the first keeps the label stable.
    if (!parts.has(block.tag)) parts.set(block.tag, block.body);
    consumed += leadingWhitespace + block.length;
  }

  return consumed > 0 ? { consumed, parts } : null;
}

/**
 * A whole-block harness tag at turn start — `<local-command-stdout>`,
 * `<local-command-caveat>`, or `<task-notification>`.
 */
function matchTurnStartTagBlock(text: string): PrefixMatch | null {
  for (const { tag, re } of TURN_START_TAG_MATCHERS) {
    const match = re.exec(text);
    if (!match) continue;
    const presentation = TURN_START_TAG_PRESENTATION[tag];
    if (!presentation) continue;
    return {
      consumedLength: match[0].length,
      span: {
        kind: presentation.kind,
        label: presentation.label,
        // Terminal control bytes are captured verbatim by the harness; strip
        // them so they don't reach the DOM as replacement glyphs.
        content: stripAnsi((match[1] ?? "").trim()),
      },
    };
  }
  return null;
}

function matchTurnStartInjection(text: string): PrefixMatch | null {
  const run = consumeWrapperRun(text);
  const afterWrapper = run ? text.slice(run.consumed) : text;

  // A skill invocation is a wrapper run FOLLOWED BY the "Base directory..."
  // preamble; a bare slash command is the wrapper run alone. Checking the
  // preamble after consuming the run (rather than encoding both in one
  // pattern) is what lets the run stay order-tolerant.
  const skill = SKILL_PREAMBLE_RE.exec(afterWrapper);
  if (skill) {
    const preambleEnd = (run?.consumed ?? 0) + skill[0].length;
    const end = findNextBoundary(text, preambleEnd);
    return {
      consumedLength: end,
      span: {
        kind: "skill-body",
        label: `skill body: ${skillNameFromPath(skill[1] ?? "")}`,
        // Body only — the raw wrapper tags and the "Base directory..." line
        // are stripped from the expand view, matching the "expanding shows
        // the full Markdown" acceptance criterion rather than raw XML.
        content: stripAnsi(text.slice(preambleEnd, end).trim()),
      },
    };
  }

  if (run) {
    const name = run.parts.get("command-name") || run.parts.get("command-message") || "unknown";
    return {
      consumedLength: run.consumed,
      span: {
        kind: "command",
        label: `command: ${name}`,
        // Not a truncation: `run.consumed` is the exact end offset of the
        // wrapper run, summed from regex match lengths whose boundaries are
        // ASCII tag delimiters (`<`/`>`/`/`). It can never land mid-character,
        // so there is no surrogate pair to split.
        // eslint-disable-next-line custom/no-unsafe-string-truncation
        content: stripAnsi(text.slice(0, run.consumed).trim()),
      },
    };
  }

  const notice = matchSessionNotice(text);
  if (notice) return notice;

  return matchTurnStartTagBlock(text);
}

/**
 * Minsky's own resume-interruption notice, delivered through the input channel
 * and therefore recorded as a `user` turn (mt#3396).
 *
 * Anchored at turn start against the shared prefix constant, so operator prose
 * that quotes the notice mid-sentence is not matched — the same conservatism
 * the tag detectors above apply.
 *
 * **Bounded to the notice's own line, NOT the whole turn** (PR #2515 R1). The
 * notice is a single line — `INTERRUPTION_NOTICE_TEXT` is concatenated string
 * literals with no newline — and it is sent as its own input
 * (`sendDrivenSessionInput(record, INTERRUPTION_NOTICE_TEXT)` in
 * `driven-session-host.ts`), so in practice the turn IS the notice.
 *
 * The first cut consumed `text.length` on that reasoning, which made the
 * detector's correctness depend on an ASSUMPTION about the sender rather than
 * on the text in front of it: any trailing operator prose would have been
 * swallowed into the span and the whole turn relabeled harness-origin —
 * violating the prose-wins rule (SC5) for the one case that rule most needs to
 * hold, since the operator's words would vanish under Minsky's label. Bounding
 * to the line makes SC5 true by construction and costs nothing when the
 * assumption holds.
 */
function matchSessionNotice(text: string): PrefixMatch | null {
  if (!text.trimStart().startsWith(INTERRUPTION_NOTICE_PREFIX)) return null;
  const newline = text.indexOf("\n");
  const consumedLength = newline === -1 ? text.length : newline;
  return {
    consumedLength,
    span: {
      kind: "session-notice",
      label: INJECTED_KIND_NOUN["session-notice"],
      // Not a truncation hazard: the cut is at a `\n` (or the end of the
      // string), never mid-character, so no surrogate pair can be split.
      // eslint-disable-next-line custom/no-unsafe-string-truncation
      content: stripAnsi(text.slice(0, consumedLength).trim()),
    },
  };
}

/**
 * Split `text` on `<system-reminder>` blocks wherever they occur, preserving
 * any surrounding prose as separate segments. Returns a single verbatim
 * `{ type: "prose", text }` segment when no reminder block is present — the
 * "renders exactly as today" fallback for the fully-unrecognized case.
 */
function splitSystemReminderBlocks(text: string): TextSegment[] {
  const re = systemReminderRegex();
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    matches.push(m);
    // A tag-pair match always consumes at least the tag markers, so this
    // can't zero-length-loop in practice — kept as a cheap safety net.
    if (m[0].length === 0) re.lastIndex += 1;
  }
  if (matches.length === 0) return [{ type: "prose", text }];

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.index > cursor) {
      const prose = text.slice(cursor, match.index);
      if (prose.trim().length > 0) segments.push({ type: "prose", text: prose });
    }
    segments.push({
      type: "injected",
      span: {
        kind: "system-reminder",
        label: "system reminder",
        content: stripAnsi((match[1] ?? "").trim()),
      },
    });
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    segments.push({ type: "prose", text: text.slice(cursor) });
  }
  return segments;
}

/**
 * Classify one user turn's raw text into an ordered list of prose/injected
 * segments. See module docblock for the detection rules and the "renders
 * exactly as today" fallback for unrecognized content.
 */
export function splitInjectedContent(text: string): TextSegment[] {
  if (!text) return [];

  const prefixSegments: TextSegment[] = [];
  let rest = text;
  let consumedAny = false;
  while (rest.length > 0) {
    const prefix = matchTurnStartInjection(rest);
    if (!prefix || prefix.consumedLength <= 0) break;
    prefixSegments.push({ type: "injected", span: prefix.span });
    rest = rest.slice(prefix.consumedLength);
    consumedAny = true;
  }

  if (!consumedAny) {
    // Fast path: nothing turn-start-anchored matched. Hand the ENTIRE
    // original text to the system-reminder scan, which itself returns it
    // verbatim (single segment) when no reminder is present either.
    return splitSystemReminderBlocks(text);
  }
  if (rest.length > 0) {
    prefixSegments.push(...splitSystemReminderBlocks(rest));
  }
  return prefixSegments;
}
