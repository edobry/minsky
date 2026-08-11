/**
 * Short-id (`mem#N` / `ask#N` / `ws#N`) resolution for the reviewer service
 * (mt#3964).
 *
 * mt#3919 gave the reviewer a channel for `mt#NNNN` references appearing
 * inside a task spec — see `task-spec-fetch.ts`. That channel is scoped to
 * `mt#NNNN` (the reviewer's own bound-task-spec fetch mechanism) and does not
 * reach the other three ADR-029 numeric short-id families: memories, asks,
 * and workspaces (sessions). A success criterion naming one of those — e.g.
 * "mem#648's CORRECTION 1 is amended: ..." (mt#3729's criterion 4) — faced
 * the same unsatisfiable-from-the-diff problem mt#3919 fixed for task specs,
 * and mt#3919's fix does not extend to it.
 *
 * This module mirrors `task-spec-fetch.ts`'s `resolveReferencedTaskSpecs`
 * shape (extraction, per-item + total size caps, three-state fetch-status
 * reporting) but resolves through THREE different injected lookups instead
 * of one `TaskServiceInterface`, because `mem#N` / `ask#N` / `ws#N` are short
 * ids: per ADR-029 the uuid is the sole deeplink target and the short id is
 * a label form, so resolving one requires a lookup against the entity's own
 * table (`memories`, `asks`, session records) rather than a direct id fetch.
 *
 * Per the mt#3964 spec's "Reuse investigation" section: the short-id RESOLVER
 * logic in `.minsky/hooks/entity-linkify.ts` is not importable here (it lives
 * under `.minsky/hooks/`, not a package) and its backing MAP is built and
 * cached by the cockpit daemon (`src/cockpit/short-id-map-cache.ts`) — a
 * separately deployed process the reviewer cannot read and must not depend
 * on being up. Instead, each lookup here goes through the reviewer's own
 * DB-backed injected-service seam, the same shape `resolveTaskSpec` already
 * uses for `TaskServiceInterface`: `MemoryService.get` / `getMemoryRecordById`
 * and `AskRepository.getById` already accept EITHER id form directly (the
 * short-id branch lives in `memoryIdWhere`/`askIdWhere`), and
 * `SessionProviderInterface.getSession` already resolves `ws#N` via
 * `resolveEntityIdPrefix`. No second short-id map is built.
 */

import type { MemoryRecord } from "@minsky/domain/memory";
import type { Ask } from "@minsky/domain/ask/types";
import type { SessionRecord } from "@minsky/domain/session";
import { capContent, AMENDMENT_HEADING_RE, type CappedContent } from "./task-spec-fetch";

// ---------------------------------------------------------------------------
// Injected-lookup seams (mt#3964)
// ---------------------------------------------------------------------------

/**
 * Narrow lookup interface for `mem#N` resolution — only the single method
 * this module calls, not the full `MemoryServiceSurface` (which additionally
 * requires `search`/`list`/`create`/`update`/`delete`/`similar`/`supersede`/
 * `lineage`, none of which a by-id content read needs). Satisfied
 * structurally by `MemoryService` and, in production, by a thin wrapper over
 * `getMemoryRecordById` (see `domain-container.ts`) that avoids standing up
 * the full `MemoryService` (and its `embeddingService`/`vectorStorage` deps)
 * just to answer one id lookup.
 */
export interface MemoryLookup {
  get(id: string): Promise<MemoryRecord | null>;
}

/**
 * Narrow lookup interface for `ask#N` resolution — only `getById`, not the
 * full `AskRepository` (create/transition/close/etc.). Satisfied structurally
 * by `DrizzleAskRepository` and any test fake implementing just this method.
 */
export interface AskLookup {
  getById(id: string): Promise<Ask | null>;
}

/**
 * Narrow lookup interface for `ws#N` resolution — only `getSession`, not the
 * full `SessionProviderInterface`. Satisfied structurally by the reviewer's
 * already-injected `sessionProvider` (`domain-container.ts`), so no new
 * production wiring is needed beyond passing it through to this module.
 */
export interface SessionLookup {
  getSession(id: string): Promise<SessionRecord | null>;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export type ShortIdRefKind = "memory" | "ask" | "workspace";

const KIND_BY_PREFIX: Record<string, ShortIdRefKind> = {
  mem: "memory",
  ask: "ask",
  ws: "workspace",
};

/**
 * Matches every `mem#N` / `ask#N` / `ws#N` occurrence in free text (global,
 * case-insensitive prefix). Mirrors `task-spec-fetch.ts`'s
 * `REFERENCED_TASK_ID_RE` shape — leading `\b` prevents mid-word matches.
 */
const SHORT_ID_REF_RE = /\b(mem|ask|ws)#(\d+)/gi;

/** Upper bound on distinct short-id fetches per review (mirrors `MAX_REFERENCED_TASK_SPECS`). */
export const MAX_REFERENCED_SHORT_IDS = 10;

/**
 * Per-reference char budget (mt#3964). A memory/ask/session record is
 * typically much shorter than a full task spec — task-spec-fetch.ts's own
 * measurement put a real spec section at a few hundred to ~2,000 chars, and
 * a memory body (this task's own live instance, mem#648) is in that same
 * range — so this budget is set BELOW `MAX_REFERENCED_SPEC_CHARS_PER_TASK`
 * (8,000) rather than matching it, on the same "a new unconditional section
 * should claim less budget than an existing one" reasoning mt#3919 used
 * against `mt#3526`'s reviewer-cost-headroom finding (83% of calls already
 * exhausting `MAX_TOOL_ROUNDS` at 67% of spend).
 */
export const MAX_REFERENCED_SHORT_ID_CHARS_PER_ITEM = 4_000;

/**
 * Total char budget across ALL short-id references injected into one review
 * (mt#3964). Set below `MAX_REFERENCED_SPECS_TOTAL_CHARS` (20,000) for the
 * same reason as the per-item cap above — this is a SECOND unconditional
 * section on top of mt#3919's, so it must claim materially less of the
 * reviewer's already-tight context budget, not an equal share.
 */
export const MAX_REFERENCED_SHORT_IDS_TOTAL_CHARS = 12_000;

/**
 * Extract every distinct `mem#N` / `ask#N` / `ws#N` reference from `text`, in
 * first-occurrence order, capped at `MAX_REFERENCED_SHORT_IDS`. Exported for
 * tests; also used by `resolveReferencedShortIds` below.
 */
export function extractReferencedShortIdRefs(
  text: string
): Array<{ ref: string; kind: ShortIdRefKind }> {
  const seen = new Set<string>();
  const results: Array<{ ref: string; kind: ShortIdRefKind }> = [];
  // Fresh RegExp instance per call — see task-spec-fetch.ts's identical
  // rationale (a module-scoped `g`-flagged regex is stateful via `lastIndex`).
  const re = new RegExp(SHORT_ID_REF_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const prefix = (m[1] ?? "").toLowerCase();
    const num = m[2];
    const kind = KIND_BY_PREFIX[prefix];
    if (!kind || !num) continue;
    const ref = `${prefix}#${num}`;
    if (seen.has(ref)) continue;
    if (results.length >= MAX_REFERENCED_SHORT_IDS) continue;
    seen.add(ref);
    results.push({ ref, kind });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ShortIdFetchResult {
  status: "found" | "not-found" | "ambiguous" | "disabled" | "error";
  ref: string;
  error?: string;
}

/**
 * Outcome of resolving one `mem#N` / `ask#N` / `ws#N` reference (mt#3964).
 * Mirrors `ReferencedTaskSpecResult`'s three-state contract (content shown
 * complete / content shown truncated / content unavailable) — see that
 * type's doc comment in `task-spec-fetch.ts` for the full rationale; the
 * shape here is identical so `buildReferencedShortIdsSection` in `prompt.ts`
 * can render it the same way.
 */
export interface ReferencedShortIdResult {
  ref: string;
  kind: ShortIdRefKind;
  content: string | null;
  updatedAt: string | null;
  fetchResult: ShortIdFetchResult;
  truncated: boolean;
  omittedChars: number;
}

function isoOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

/**
 * Extract every "## <heading>" section of a memory body whose heading matches
 * `AMENDMENT_HEADING_RE` ("## Correction N", "## AMENDED ...", "## Update
 * ..."), concatenated in the order they appear. Returns `null` when none
 * match, so the caller falls back to the whole body.
 *
 * Mirrors task-spec-fetch.ts's `extractHintedSections`, narrowed to ONLY the
 * amendment-heading union (that function requires a non-empty `sectionHints`
 * array before it even checks `AMENDMENT_HEADING_RE`, which this module has
 * no equivalent hint source for — a short-id reference is a bare `mem#N`
 * token with no section-hint keywords the way an `mt#NNNN` reference's
 * surrounding text can carry "Success Criteria"/"Scope"/etc.).
 *
 * Load-bearing, not cosmetic (mt#3964 live replay finding): mem#648, this
 * task's own live acceptance-test fixture, is ~7.6KB — well over
 * `MAX_REFERENCED_SHORT_ID_CHARS_PER_ITEM` — and its relevant content
 * ("## CORRECTION 3", the section mt#3729's criterion 4 depends on) sits near
 * the END. Head-truncating the whole body (this file's `capContent`) cuts
 * CORRECTION 3 before it is ever shown, so a criterion naming CORRECTION 1's
 * amendment would render `Unverifiable` regardless of whether the memory
 * actually carries the amendment — the SAME evidence for the met and unmet
 * case, which is exactly the suppression this task's negative-control
 * Success Criterion exists to catch. Extracting by heading rather than by
 * position sidesteps this: all three "## CORRECTION N" sections match
 * `AMENDMENT_HEADING_RE` and are pulled in regardless of where they sit in
 * the body.
 */
export function extractAmendmentSections(content: string): string | null {
  const lines = content.split("\n");
  const matches: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line !== undefined && line.startsWith("## ")) {
      const heading = line.slice(3).trim();
      if (AMENDMENT_HEADING_RE.test(heading)) {
        let end = i + 1;
        while (end < lines.length && !(lines[end]?.startsWith("## ") ?? false)) end++;
        matches.push(lines.slice(i, end).join("\n").trim());
        i = end;
        continue;
      }
    }
    i++;
  }
  return matches.length > 0 ? matches.join("\n\n") : null;
}

/**
 * Render a memory record's injected content: the amendment sections
 * (`## Correction N` / `## AMENDED` / `## Update`) when the body has any,
 * otherwise the body verbatim.
 */
function renderMemoryContent(record: MemoryRecord): { content: string; updatedAt: string | null } {
  const targeted = extractAmendmentSections(record.content);
  return { content: targeted ?? record.content, updatedAt: isoOrNull(record.updatedAt) };
}

/** Render an ask's injected content: the question plus its response, when resolved. */
function renderAskContent(ask: Ask): { content: string; updatedAt: string | null } {
  const lines = [`**Question:** ${ask.question}`, `**State:** ${ask.state}`];
  if (ask.response) {
    lines.push(
      `**Response (by ${ask.response.responder}):** ${JSON.stringify(ask.response.payload)}`
    );
  }
  const updatedAt = ask.closedAt ?? ask.respondedAt ?? ask.routedAt ?? ask.createdAt;
  return { content: lines.join("\n\n"), updatedAt };
}

/** Render a session (workspace) record's injected content: a compact status summary. */
function renderSessionContent(record: SessionRecord): {
  content: string;
  updatedAt: string | null;
} {
  const fields: string[] = [
    `- Task: ${record.taskId ?? "(none)"}`,
    `- Status: ${record.status ?? "(unknown)"}`,
    `- Branch: ${record.branch ?? "(none)"}`,
  ];
  if (record.lastCommitMessage) fields.push(`- Last commit: ${record.lastCommitMessage}`);
  if (record.pullRequest) {
    fields.push(`- Pull request: #${record.pullRequest.number} (${record.pullRequest.state})`);
  }
  const content = fields.join("\n");
  const updatedAt = record.lastActivityAt ?? record.createdAt;
  return { content, updatedAt };
}

function classifySessionError(err: unknown): ShortIdFetchResult["status"] {
  const message = err instanceof Error ? err.message : String(err);
  return /^ambiguous/i.test(message) ? "ambiguous" : "error";
}

/**
 * Resolve every `mem#N` / `ask#N` / `ws#N` reference appearing in `taskSpec`'s
 * text (mt#3964). Mirrors `resolveReferencedTaskSpecs`'s bounding (per-item +
 * total char caps) and never-throws contract: a fetch failure, an
 * unresolvable id, or an ambiguous prefix match produces a `content: null`
 * entry with a structured `fetchResult` — the caller renders this so the
 * model reports the depending criterion `Unverifiable` (never `Met`, never
 * `Not Met`, never silently dropped).
 *
 * @param input.taskSpec The bound task's spec text to scan for references.
 *   Null/empty → returns [].
 * @param input.memoryLookup / askLookup / sessionLookup Optional injected
 *   lookups. When a given lookup is absent, every reference of that kind is
 *   returned with `fetchResult.status: "disabled"` — the reviewer still SEES
 *   the reference (so the model can report it `Unverifiable`), it just cannot
 *   fetch it.
 */
export async function resolveReferencedShortIds(input: {
  taskSpec: string | null;
  memoryLookup?: MemoryLookup | null;
  askLookup?: AskLookup | null;
  sessionLookup?: SessionLookup | null;
}): Promise<ReferencedShortIdResult[]> {
  if (!input.taskSpec) return [];

  const refs = extractReferencedShortIdRefs(input.taskSpec);
  if (refs.length === 0) return [];

  const results: ReferencedShortIdResult[] = [];
  let totalCharsUsed = 0;

  for (const { ref, kind } of refs) {
    let rendered: { content: string; updatedAt: string | null } | null = null;
    let status: ShortIdFetchResult["status"] = "not-found";
    let errorMessage: string | undefined;

    try {
      if (kind === "memory") {
        if (!input.memoryLookup) {
          status = "disabled";
        } else {
          const record = await input.memoryLookup.get(ref);
          if (record) {
            rendered = renderMemoryContent(record);
            status = "found";
          }
        }
      } else if (kind === "ask") {
        if (!input.askLookup) {
          status = "disabled";
        } else {
          const ask = await input.askLookup.getById(ref);
          if (ask) {
            rendered = renderAskContent(ask);
            status = "found";
          }
        }
      } else {
        if (!input.sessionLookup) {
          status = "disabled";
        } else {
          const record = await input.sessionLookup.getSession(ref);
          if (record) {
            rendered = renderSessionContent(record);
            status = "found";
          }
        }
      }
    } catch (err: unknown) {
      status = kind === "workspace" ? classifySessionError(err) : "error";
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    if (!rendered) {
      results.push({
        ref,
        kind,
        content: null,
        updatedAt: null,
        fetchResult: { status, ref, ...(errorMessage ? { error: errorMessage } : {}) },
        truncated: false,
        omittedChars: 0,
      });
      continue;
    }

    // Total-budget check FIRST — same ordering rationale as
    // `resolveReferencedTaskSpecs`: an entry the budget has no room left for
    // is omitted entirely rather than injected as a sliver that reads as more
    // complete than it is.
    if (totalCharsUsed >= MAX_REFERENCED_SHORT_IDS_TOTAL_CHARS) {
      results.push({
        ref,
        kind,
        content: null,
        updatedAt: rendered.updatedAt,
        fetchResult: { status: "found", ref },
        truncated: true,
        omittedChars: rendered.content.length,
      });
      continue;
    }

    const remainingTotalBudget = MAX_REFERENCED_SHORT_IDS_TOTAL_CHARS - totalCharsUsed;
    const perItemCap = Math.min(MAX_REFERENCED_SHORT_ID_CHARS_PER_ITEM, remainingTotalBudget);
    const capped: CappedContent = capContent(rendered.content, perItemCap);
    totalCharsUsed += capped.content.length;

    results.push({
      ref,
      kind,
      content: capped.content,
      updatedAt: rendered.updatedAt,
      fetchResult: { status: "found", ref },
      truncated: capped.truncated,
      omittedChars: capped.omittedChars,
    });
  }

  return results;
}
