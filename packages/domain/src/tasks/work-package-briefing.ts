/**
 * Work-package briefing parsing + per-origin validation (ADR-046, mt#2911).
 *
 * The briefing IS the task spec of a kind:"work-package" task — no parallel
 * document. Everything here is pure: the create seam (crud-commands) feeds it
 * the spec text and acts on the verdicts, so every surface that can create a
 * task (CLI, MCP, /handoff's terminal step) gets the same refusals, not just
 * the one harness a PreToolUse hook can see.
 *
 * Per-origin contract (spec §Validation at create/claim):
 *  - groomed     — a curator bundled open tasks: requires the member set
 *                  (## Members, ordered, each entry a real task ref), and
 *                  ## Grouping rationale. Ordering is the list order.
 *  - succession  — a finishing conversation packaged its in-flight work:
 *                  requires ## Situation, ## Decisions (with rationale), and
 *                  ## Provenance. Members are welcome but not demanded.
 * Neither origin demands the other's sections.
 */

/** Origins legal at CREATE time — "release" is minted only by the release path. */
export const WORK_PACKAGE_CREATE_ORIGINS = ["groomed", "succession"] as const;
export type WorkPackageCreateOrigin = (typeof WORK_PACKAGE_CREATE_ORIGINS)[number];

export interface ParsedMember {
  /** The task ref as written (e.g. "mt#123"). */
  taskId: string;
  /** 1-based position in the briefing's list. */
  rank: number;
  /** Text after the ref on the same list line, dash-separators trimmed. */
  rationale: string | null;
}

export interface ParsedBriefing {
  origin: WorkPackageCreateOrigin | null;
  /** The raw Origin: value when present but not a legal create origin. */
  rawOrigin: string | null;
  members: ParsedMember[];
  /** Section headings present at any depth (##+), lower-cased. */
  sections: Set<string>;
  /** Every entity ref cited anywhere in the briefing (deduped, order kept). */
  citedRefs: string[];
}

export interface BriefingValidationFailure {
  code: "missing-origin" | "invalid-origin" | "missing-section" | "empty-members";
  detail: string;
}

const ORIGIN_LINE_RE = /^Origin:\s*(\S+)\s*$/m;
const HEADING_RE = /^#{2,}\s+(.+?)\s*$/gm;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/gm;
const TASK_REF_RE = /\b(?:mt|md|gh)#\d+\b/g;
/**
 * Cited-entity forms the create-time sweep resolves: task ids and short-id
 * entities — the kinds answerable from the local store. PR/changeset refs are
 * deliberately NOT swept in v1: resolving one needs the network, and a network
 * flake surfacing as `found: false` would refuse a legitimate create.
 */
const CITED_REF_RE = /\b(?:(?:mt|md|gh)#\d+|(?:ask|mem|ws)#\d+)\b/g;

/** Sections each origin requires, as lower-cased heading text. */
export const REQUIRED_SECTIONS_BY_ORIGIN: Record<WorkPackageCreateOrigin, string[]> = {
  groomed: ["members", "grouping rationale"],
  succession: ["situation", "decisions", "provenance"],
};

export function parseWorkPackageBriefing(spec: string): ParsedBriefing {
  const originMatch = spec.match(ORIGIN_LINE_RE);
  const rawOrigin = originMatch?.[1] ?? null;
  const origin = (WORK_PACKAGE_CREATE_ORIGINS as readonly string[]).includes(rawOrigin ?? "")
    ? (rawOrigin as WorkPackageCreateOrigin)
    : null;

  const sections = new Set<string>();
  for (const m of spec.matchAll(HEADING_RE)) {
    if (m[1]) sections.add(m[1].toLowerCase());
  }

  const members = parseMembersSection(spec);

  const citedRefs: string[] = [];
  const seen = new Set<string>();
  for (const m of spec.matchAll(CITED_REF_RE)) {
    const ref = m[0];
    if (!seen.has(ref)) {
      seen.add(ref);
      citedRefs.push(ref);
    }
  }

  return { origin, rawOrigin, members, sections, citedRefs };
}

/**
 * Extract the ordered member list from the `## Members` section: list items
 * whose text leads with a task ref; rank is list order; the remainder of the
 * line (after a dash/em-dash/colon separator) is the per-member rationale.
 */
function parseMembersSection(spec: string): ParsedMember[] {
  const sectionMatch = spec.match(/^#{2,}\s+Members\s*$([\s\S]*?)(?=^#{2,}\s|\s*$(?![\s\S]))/im);
  const body = sectionMatch?.[1];
  if (!body) return [];

  const members: ParsedMember[] = [];
  for (const item of body.matchAll(LIST_ITEM_RE)) {
    const line = item[1] ?? "";
    const refMatch = line.match(TASK_REF_RE);
    if (!refMatch) continue;
    const ref = refMatch[0];
    const afterRef = line.slice(line.indexOf(ref) + ref.length);
    // A ref written as `**mt#N**` or `` `mt#N` `` closes its emphasis right after
    // the ref; that marker is not the rationale's first word (seen on mt#5125).
    const rationale =
      afterRef
        .replace(/^(?:\*\*|__|\*|_|`)/, "")
        .replace(/^[\s—–:-]+/, "")
        .trim() || null;
    members.push({ taskId: ref, rank: members.length + 1, rationale });
  }
  return members;
}

/**
 * Per-origin structural validation. Returns every failure at once so a refusal
 * names the complete fix, not the first missing piece of it.
 */
export function validateWorkPackageBriefing(parsed: ParsedBriefing): BriefingValidationFailure[] {
  const failures: BriefingValidationFailure[] = [];

  if (!parsed.origin) {
    if (parsed.rawOrigin) {
      failures.push({
        code: "invalid-origin",
        detail:
          `Origin "${parsed.rawOrigin}" is not a create origin — a work-package briefing ` +
          `declares "Origin: groomed" or "Origin: succession" ("release" entries are minted ` +
          `only by the release path).`,
      });
    } else {
      failures.push({
        code: "missing-origin",
        detail:
          'The briefing must declare its origin on its own line: "Origin: groomed" ' +
          '(a curator bundled open tasks) or "Origin: succession" (a finishing ' +
          "conversation packaged its in-flight work).",
      });
    }
    return failures;
  }

  for (const section of REQUIRED_SECTIONS_BY_ORIGIN[parsed.origin]) {
    if (!parsed.sections.has(section)) {
      failures.push({
        code: "missing-section",
        detail: `A ${parsed.origin} briefing requires a "## ${titleCase(section)}" section.`,
      });
    }
  }

  if (
    parsed.origin === "groomed" &&
    parsed.sections.has("members") &&
    parsed.members.length === 0
  ) {
    failures.push({
      code: "empty-members",
      detail:
        "The ## Members section names no task refs — a groomed package is an ordered " +
        "bundle of existing tasks, each listed as a task ref (mt#N) with its rationale.",
    });
  }

  return failures;
}

function titleCase(heading: string): string {
  return heading.charAt(0).toUpperCase() + heading.slice(1);
}

// ---------------------------------------------------------------------------
// Rendering back INTO the briefing (mt#5133)
// ---------------------------------------------------------------------------

export const MEMBERS_HEADING = "## Members";
export const TRANSFERS_HEADING = "## Transfers";

/** One `work_package_transfers` row, as the renderer needs it. */
export interface TransferLogEntry {
  seq: number;
  origin: string;
  byConversation: string | null;
  notes: string | null;
  createdAt: Date | null;
}

const SECTION_SEPARATOR = " — ";

/**
 * Render the transfer log as the `## Transfers` section a succeeded package
 * carries in its spec. The spec is the one surface a successor reads
 * (`tasks_spec_get`, the cockpit task page) and nothing renders
 * `work_package_transfers` directly, so the history has to live here to be
 * seen. One list item per transfer in seq order — seq, origin, time, writer,
 * notes — with the notes collapsed onto the line; the table stays the source
 * of truth. Parser-inert: `parseWorkPackageBriefing` reads `Origin:` and
 * `## Members` only, and validation ignores sections it does not require.
 */
export function renderTransferLog(transfers: TransferLogEntry[]): string {
  const lines = [...transfers]
    .sort((a, b) => a.seq - b.seq)
    .map((t) => {
      const when = t.createdAt ? t.createdAt.toISOString() : "time unrecorded";
      const by = `by ${t.byConversation ?? "unrecorded"}`;
      const notes = t.notes?.trim() ? `${SECTION_SEPARATOR}${collapseLines(t.notes)}` : "";
      return `- #${t.seq} ${t.origin}${SECTION_SEPARATOR}${when}${SECTION_SEPARATOR}${by}${notes}`;
    });
  return [TRANSFERS_HEADING, "", ...(lines.length > 0 ? lines : ["- none recorded"])].join("\n");
}

/** Render a member set as the `## Members` section `parseMembersSection` reads back. */
export function renderMembersSection(
  members: Array<{ taskId: string; rationale: string | null }>
): string {
  const lines = members.map((m) =>
    m.rationale?.trim()
      ? `- ${m.taskId}${SECTION_SEPARATOR}${collapseLines(m.rationale)}`
      : `- ${m.taskId}`
  );
  return [MEMBERS_HEADING, "", ...lines].join("\n");
}

/**
 * Replace the section whose heading matches `section`'s first line, or append
 * it when the briefing has none. A section runs from its heading to the next
 * `##`-or-deeper heading — the same extent `parseMembersSection` reads — so a
 * rewrite never swallows a neighbour. Pure.
 */
export function upsertBriefingSection(spec: string, section: string): string {
  const rendered = `${section.trimEnd()}\n`;
  const headingLine = rendered.split("\n")[0] ?? "";
  const headingText = headingLine.replace(/^#{2,}\s+/, "").trim();
  const range = findSectionRange(spec, headingText);
  if (!range) {
    const base = spec.trimEnd();
    return base.length === 0 ? rendered : `${base}\n\n${rendered}`;
  }
  const after = spec.slice(range.end);
  // eslint-disable-next-line custom/no-unsafe-string-truncation -- range.start is the index of a `#` at line start, never inside a surrogate pair
  const before = spec.slice(0, range.start);
  return `${before}${rendered}${after.length > 0 ? `\n${after}` : ""}`;
}

function findSectionRange(
  spec: string,
  headingText: string
): { start: number; end: number } | null {
  const headingRe = new RegExp(`^#{2,}\\s+${escapeRegExp(headingText)}\\s*$`, "im");
  const match = headingRe.exec(spec);
  if (!match) return null;
  const start = match.index;
  const afterHeading = start + match[0].length;
  const next = /^#{2,}\s/m.exec(spec.slice(afterHeading));
  return { start, end: next ? afterHeading + next.index : spec.length };
}

function collapseLines(text: string): string {
  return text.replace(/\s*\n+\s*/g, " ").trim();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
