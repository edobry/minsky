/**
 * Deterministic markdown-section splice for `memory.patch` (mt#3602).
 *
 * Pure string manipulation: no model, no persistence, no I/O. That is a
 * requirement rather than an implementation detail. The alternative shape —
 * mirroring `tasks_spec_patch`, which resolves `// ... existing code ...`
 * markers through `packages/domain/src/ai/edit-pattern-service.ts` — cannot
 * promise the untouched bytes survive; its own tool description warns "the
 * model may inadvertently delete those sections", and mt#1653 tracks that
 * failure occurring for real in `session_edit_file`. Since the entire point of
 * this primitive is to make appending to a large, heavily-cited memory SAFER
 * than a wholesale rewrite, an apply model would relocate the silent-drop risk
 * rather than remove it.
 *
 * Line handling is split/join on "\n" and never regex-rewrites the whole
 * document, so every byte outside the target section is preserved verbatim —
 * including CRLF endings, which survive as trailing "\r" on each element.
 */

export type SectionPatchMode = "append" | "prepend" | "replace";

export interface SectionPatchInput {
  /** The record's current markdown content. */
  content: string;
  /** Section heading to target, with or without leading `#` (e.g. "## Recurrences"). */
  section: string;
  /** Text to insert (append/prepend) or to become the new section body (replace). */
  text: string;
  mode: SectionPatchMode;
}

/** `## Heading text` → captures the hashes and the title. */
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;

/**
 * Compare heading titles case-insensitively with `#` and surrounding space
 * stripped, so a caller may pass "Recurrences" or "## Recurrences"
 * interchangeably. Case-insensitive because a heading's capitalization is
 * presentation, and a caller who gets it slightly wrong should hit the section
 * they obviously meant rather than a not-found error.
 */
function normalizeHeadingTitle(raw: string): string {
  return raw
    .replace(/^#+\s*/, "")
    .trim()
    .toLowerCase();
}

interface HeadingMatch {
  lineIndex: number;
  depth: number;
}

function findHeadings(lines: string[], section: string): HeadingMatch[] {
  const target = normalizeHeadingTitle(section);
  const matches: HeadingMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i] as string);
    if (!m) continue;
    if (normalizeHeadingTitle(m[2] as string) !== target) continue;
    matches.push({ lineIndex: i, depth: (m[1] as string).length });
  }
  return matches;
}

/** Every heading title present, for a not-found error that can be acted on. */
function listHeadings(lines: string[]): string[] {
  const titles: string[] = [];
  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) titles.push(`${m[1] as string} ${m[2] as string}`);
  }
  return titles;
}

/**
 * Exclusive end index of the section body: the first following heading at the
 * SAME or SHALLOWER depth. A deeper heading (`###` under `##`) is part of the
 * section, so appending to `## Recurrences` lands after its subsections rather
 * than in the middle of them.
 */
function findSectionEnd(lines: string[], start: number, depth: number): number {
  for (let i = start; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i] as string);
    if (m && (m[1] as string).length <= depth) return i;
  }
  return lines.length;
}

/**
 * Splice `text` into the named section.
 *
 * Throws — never falls back to a wholesale write and never silently no-ops —
 * when the section is missing or appears more than once. Both are the cases
 * where a "best effort" write would put content somewhere the caller did not
 * intend, which for a heavily-cited memory is worse than a failed call.
 */
export function patchSection(input: SectionPatchInput): string {
  const { content, section, text, mode } = input;
  const lines = content.split("\n");
  const matches = findHeadings(lines, section);

  if (matches.length === 0) {
    const available = listHeadings(lines);
    throw new Error(
      `Section "${section}" not found in memory content. ${
        available.length > 0
          ? `Available headings: ${available.join(", ")}`
          : "The record contains no markdown headings."
      }`
    );
  }

  if (matches.length > 1) {
    const at = matches.map((m) => `line ${m.lineIndex + 1}`).join(", ");
    throw new Error(
      `Section "${section}" is ambiguous — it appears ${matches.length} times (${at}). ` +
        "Refusing to patch: disambiguate the heading text first."
    );
  }

  const { lineIndex: headingIdx, depth } = matches[0] as HeadingMatch;
  const bodyStart = headingIdx + 1;
  const bodyEnd = findSectionEnd(lines, bodyStart, depth);
  const textLines = text.split("\n");

  if (mode === "replace") {
    return [...lines.slice(0, bodyStart), ...textLines, ...lines.slice(bodyEnd)].join("\n");
  }

  if (mode === "prepend") {
    // Directly under the heading, with a blank line after so the inserted block
    // does not run into the body that follows it.
    const insert = lines[bodyStart] === "" ? textLines : [...textLines, ""];
    return [...lines.slice(0, bodyStart), ...insert, ...lines.slice(bodyStart)].join("\n");
  }

  // append: after the section's last non-blank line, so any blank lines that
  // separated the section from the next heading stay where they were.
  let insertAt = bodyStart;
  for (let i = bodyEnd - 1; i >= bodyStart; i--) {
    if ((lines[i] as string).trim() !== "") {
      insertAt = i + 1;
      break;
    }
  }

  // One blank separator, unless the insertion point already follows a blank
  // line (an empty section body).
  const needsSeparator = insertAt > bodyStart;
  const insert = needsSeparator ? ["", ...textLines] : textLines;

  return [...lines.slice(0, insertAt), ...insert, ...lines.slice(insertAt)].join("\n");
}
