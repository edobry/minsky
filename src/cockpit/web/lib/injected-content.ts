/**
 * Injected-content detector (mt#2791).
 *
 * Harness-injected content — slash-command wrappers, skill-body preambles,
 * and `<system-reminder>` blocks — currently renders as full-weight USER
 * prose in the cockpit conversation view: a `/plan-task` invocation injects
 * the entire skill body (~20 screens of Markdown) before any real work
 * appears, burying the conversation's real signal.
 *
 * `splitInjectedContent` classifies one user turn's raw text into an ordered
 * list of {@link TextSegment}s — genuine operator PROSE, and INJECTED spans
 * labeled by origin — so the renderer (`ConversationView.tsx`) can collapse
 * the injected spans behind a muted, expandable header while leaving prose
 * untouched. Pure, dependency-free (mirrors the shared-parser precedent of
 * `packages/domain/src/transcripts/conversation-elements.ts`).
 *
 * Detection is deliberately conservative — anchored patterns, not
 * substring-anywhere matching:
 *   - Command wrapper (`<command-message>`/`<command-name>`) and skill-body
 *     preamble ("Base directory for this skill:") are anchored to the START
 *     of the turn's remaining text only — that mirrors how the harness
 *     actually injects them (as the first thing in a user turn). Genuine
 *     prose that happens to mention either mid-sentence is NOT matched: the
 *     anchor is turn-start, not "found anywhere."
 *   - `<system-reminder>...</system-reminder>` blocks are matched WHEREVER
 *     they appear in the remaining text — the harness can interleave several
 *     reminders with real content in one turn — but the tag itself is a
 *     highly distinctive token vanishingly unlikely to appear in
 *     operator-authored prose, so a non-anchored match stays conservative in
 *     practice.
 *
 * Unrecognized content is untouched: when nothing matches, `splitInjectedContent`
 * returns a single `{ type: "prose", text }` segment carrying the ORIGINAL
 * string verbatim — the "renders exactly as today" success criterion. A turn
 * that mixes an injected prefix with genuine prose (e.g. a slash-command
 * wrapper followed by operator-typed continuation text) splits into an
 * injected segment plus a separate prose segment — the injected span
 * collapses, the prose does not.
 *
 * @see mt#2791 — this module
 * @see src/cockpit/text-snippet.ts (mt#2784) — sibling detector for the
 *   conversation-LABEL surface (discards harness markup entirely rather than
 *   preserving it for an expandable view); this module's tag tolerance
 *   (attribute-bearing / whitespace-padded opening tags, case-insensitive)
 *   mirrors that precedent (PR #1919 R1).
 * @see src/cockpit/web/widgets/ConversationView.tsx — the consumer
 */

/** Origin classification for one injected span. */
export type InjectedContentKind = "command" | "skill-body" | "system-reminder";

/** One detected injected span: a muted collapsed header + its full content. */
export interface InjectedSpan {
  kind: InjectedContentKind;
  /** One-line muted header label, e.g. "command: error-handling". */
  label: string;
  /** Full content of the span, rendered on expand (harness wrapper tags stripped). */
  content: string;
}

/** One segment of a turn's text after injected-content classification. */
export type TextSegment =
  | { type: "prose"; text: string }
  | { type: "injected"; span: InjectedSpan };

// Tag-matching helpers tolerate an attribute-bearing or whitespace-padded
// opening tag and are case-insensitive — the harness's exact tag casing/
// attributes are not a guaranteed contract (mirrors text-snippet.ts's
// stripHarnessMarkup precedent, PR #1919 R1).
function tagOpen(name: string): string {
  return `<${name}(?:\\s[^>]*)?>`;
}
function tagClose(name: string): string {
  return `<\\/${name}>`;
}
function tagBlock(name: string, group = false): string {
  const inner = group ? "([\\s\\S]*?)" : "[\\s\\S]*?";
  return `${tagOpen(name)}${inner}${tagClose(name)}`;
}

// Anchored to turn-start (`^`) only — see module docblock. The command
// wrapper (message/name/args) and the `<skill-format>` marker are all
// optional, so this also matches a bare "Base directory for this skill:"
// preamble with no preceding wrapper.
const SKILL_BODY_PREFIX_RE = new RegExp(
  `^(?:${tagBlock("command-message")}\\s*` +
    `(?:${tagBlock("command-name")}\\s*)?` +
    `(?:${tagBlock("command-args")}\\s*)?` +
    `(?:${tagBlock("skill-format")}\\s*)?` +
    `)?Base directory for this skill:\\s*(\\S+)`,
  "i"
);

// Anchored to turn-start (`^`) only. Tried AFTER SKILL_BODY_PREFIX_RE fails —
// a skill invocation also starts with `<command-message>`, so priority order
// matters (see matchTurnStartInjection).
const COMMAND_PREFIX_RE = new RegExp(
  `^${tagBlock("command-message", true)}\\s*` +
    `(?:${tagBlock("command-name", true)}\\s*)?` +
    `(?:${tagBlock("command-args")}\\s*)?`,
  "i"
);

// NOT anchored — matched wherever it appears (see module docblock). Built
// fresh per call in splitSystemReminderBlocks (global-flagged regexes carry
// mutable `lastIndex` state across `.exec()` calls; a shared module-level
// instance would leak state between the many turns this runs over per render).
function systemReminderRegex(): RegExp {
  return new RegExp(tagBlock("system-reminder", true), "gi");
}

// Boundary marker for a multi-skill-concatenated turn: once a skill-body
// span is detected, its content stops at the NEXT recognized turn-start
// anchor (another skill's `<command-message>`, or a `<system-reminder>`)
// rather than swallowing the rest of the turn.
const NEXT_BOUNDARY_RE = new RegExp(
  `(?:${tagOpen("command-message")}|${tagOpen("system-reminder")})`,
  "i"
);

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

function matchSkillBodyPrefix(text: string): PrefixMatch | null {
  const match = SKILL_BODY_PREFIX_RE.exec(text);
  if (!match) return null;
  const path = match[1] ?? "";
  const wrapperEnd = match[0].length;
  const end = findNextBoundary(text, wrapperEnd);
  return {
    consumedLength: end,
    span: {
      kind: "skill-body",
      label: `skill body: ${skillNameFromPath(path)}`,
      // Body only — the raw wrapper tags (command-message/name/args,
      // skill-format, the "Base directory..." line) are stripped from the
      // expand view, matching the "expanding shows the full Markdown"
      // acceptance criterion rather than raw XML + Markdown.
      content: text.slice(wrapperEnd, end).trim(),
    },
  };
}

function matchCommandOnlyPrefix(text: string): PrefixMatch | null {
  const match = COMMAND_PREFIX_RE.exec(text);
  if (!match) return null;
  const commandNameContent = match[2]?.trim();
  const commandMessageContent = match[1]?.trim();
  const name = commandNameContent || commandMessageContent || "unknown";
  return {
    consumedLength: match[0].length,
    span: {
      kind: "command",
      label: `command: ${name}`,
      content: match[0].trim(),
    },
  };
}

function matchTurnStartInjection(text: string): PrefixMatch | null {
  return matchSkillBodyPrefix(text) ?? matchCommandOnlyPrefix(text);
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
      span: { kind: "system-reminder", label: "system reminder", content: (match[1] ?? "").trim() },
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
