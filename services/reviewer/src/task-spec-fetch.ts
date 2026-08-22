/**
 * Task-spec resolution for the reviewer service.
 *
 * Three responsibilities:
 *   1. Extract the task ID from a PR's branch name or title.
 *   2. Fetch the task spec content via the injected TaskServiceInterface and
 *      classify the outcome into a structured TaskSpecFetchResult the caller logs.
 *   3. Resolve `mt#NNNN` references appearing WITHIN a task spec's text (mt#3919)
 *      — e.g. a success criterion naming another task's spec as its artifact —
 *      so the reviewer can verify that criterion against the referenced spec's
 *      actual content instead of reporting it unmet solely because the artifact
 *      is absent from the diff.
 *
 * Previously called the hosted Minsky MCP via mcp-client.ts. Now uses the
 * domain TaskServiceInterface directly (mt#2121).
 *
 * Requires a running TaskService with a backend configured for the repo;
 * transport issues surface as `status: "error"`, missing service as
 * `status: "disabled"`, and operator visibility is preserved via logs.
 */

import type { TaskServiceInterface } from "@minsky/domain/tasks";
import { safeTruncate } from "@minsky/shared/safe-truncate";

/**
 * Matches task IDs in common branch/title forms: `task/mt-1109`, `mt#1109`,
 * `feat(mt#1109): ...`, `[mt-1109]`. Leading `\b` prevents mid-word matches
 * like `fmt-1234`.
 */
const TASK_ID_RE = /\bmt[#-](\d+)/i;

export function extractTaskId(input: {
  branchName?: string | null;
  prTitle?: string | null;
}): string | null {
  const candidates = [input.branchName, input.prTitle].filter(
    (s): s is string => typeof s === "string"
  );
  for (const s of candidates) {
    const m = TASK_ID_RE.exec(s);
    if (m) return `mt#${m[1]}`;
  }
  return null;
}

/**
 * Outcome of the task-spec fetch for a single review. Recorded in the result
 * so server logs can show whether the reviewer had spec access. Useful when
 * diagnosing calibration regressions (mt#1110).
 */
export interface TaskSpecFetchResult {
  status: "found" | "no-task-id" | "not-found" | "disabled" | "error";
  taskId?: string;
  specLength?: number;
  error?: string;
}

/**
 * Resolve the task spec for a PR. Extracts the task ID from branch + title,
 * then fetches the spec via the TaskService. Every non-success path returns
 * `taskSpec: null` with a structured `fetchResult` — the reviewer never
 * blocks on spec fetch.
 *
 * @param taskService Optional injected TaskService. When absent, returns
 *   `status: "disabled"` — the spec fetch is optional and the reviewer
 *   degrades gracefully without it.
 */
export async function resolveTaskSpec(input: {
  branchName: string;
  prTitle: string;
  taskService?: TaskServiceInterface | null;
}): Promise<{ taskSpec: string | null; fetchResult: TaskSpecFetchResult }> {
  if (!input.taskService) {
    return {
      taskSpec: null,
      fetchResult: { status: "disabled" },
    };
  }

  const taskId = extractTaskId({
    branchName: input.branchName,
    prTitle: input.prTitle,
  });
  if (!taskId) {
    return {
      taskSpec: null,
      fetchResult: { status: "no-task-id" },
    };
  }

  try {
    const result = await input.taskService.getTaskSpecContent(taskId);
    const content = result.content;
    if (!content) {
      return {
        taskSpec: null,
        fetchResult: { status: "not-found", taskId },
      };
    }
    return {
      taskSpec: content,
      fetchResult: { status: "found", taskId, specLength: content.length },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Treat "not found" errors as not-found, everything else as error.
    if (/not.found|does not exist|no such/i.test(message)) {
      return {
        taskSpec: null,
        fetchResult: { status: "not-found", taskId },
      };
    }
    return {
      taskSpec: null,
      fetchResult: { status: "error", taskId, error: message },
    };
  }
}

// ---------------------------------------------------------------------------
// mt#3919: referenced-task-spec resolution
// ---------------------------------------------------------------------------

/**
 * Matches every `mt#NNNN` / `mt-NNNN` occurrence in free text (global, so it
 * finds ALL references rather than just the first — unlike `TASK_ID_RE`,
 * which `extractTaskId` uses to find a single branch/title match).
 */
const REFERENCED_TASK_ID_RE = /\bmt[#-](\d+)/gi;

/**
 * Upper bound on distinct referenced-task-spec fetches per review (mt#3919).
 *
 * A spec that names more than this many other tasks is pathological — this
 * repo's specs typically reference 0-3. Bounding the fetch count avoids a
 * spec becoming a denial-of-context / denial-of-service vector (N sequential
 * TaskService calls before the review can proceed), mirroring the bound
 * `MAX_BATCHED_SPEC_VERIFICATIONS` already places on the batched submission
 * tool (output-tools.ts).
 */
export const MAX_REFERENCED_TASK_SPECS = 10;

/**
 * Per-referenced-task char budget, applied to whatever content is about to be
 * injected for ONE reference — a section-targeted extraction (see
 * `extractHintedSections` below) when one was found, otherwise the whole
 * spec as a fallback (mt#3919 PR #2841 R1 BLOCKING: "injected content is
 * unbounded — no truncation/cap risks prompt/token overflows").
 *
 * Grounded against two existing precedents in this file family rather than a
 * round number:
 *   - `MAX_READ_FILE_CHARS = 50_000` (providers.ts) budgets a single
 *     `read_file` result the MODEL explicitly requested — a much larger
 *     allowance is defensible there because the model self-selected the read.
 *   - `MAX_SYNTHESIZED_SUMMARY_CHARS = 1_500` (empty-findings-recovery.ts)
 *     budgets a single short synthesized field.
 * A referenced spec is injected UNCONDITIONALLY (the model never asked for
 * it), which argues for a tighter budget than the on-demand read; but a real
 * spec section in THIS repo (its own "## Success Criteria" / "## Acceptance
 * Tests" blocks) runs a few hundred to ~2,000 chars, which argues against
 * going as low as the synthesized-summary budget. 8,000 chars sits between
 * the two and is sized from a direct same-session measurement: mt#3919's own
 * spec (an above-average, heavily-annotated one) ran ~5,700 chars for
 * roughly 60% of its body — a section-targeted extraction fits comfortably
 * under this cap, while a whole-spec fallback on a spec this size is
 * truncated to roughly half rather than injected unbounded.
 */
export const MAX_REFERENCED_SPEC_CHARS_PER_TASK = 8_000;

/**
 * Total char budget across ALL referenced specs injected into one review
 * (mt#3919 R1 BLOCKING). Bounds the "## Referenced Task Specs" section as a
 * whole even when a criteria set names several tasks (up to
 * `MAX_REFERENCED_TASK_SPECS`) and several fall back to whole-spec content.
 *
 * Grounded against `MAX_SUMMARY_CHARS = 30_000` (prior-review-summary.ts) —
 * the closest existing precedent for "one auxiliary section injected into
 * every review, budgeted as a whole." Deliberately set BELOW that precedent
 * rather than at it: mt#3526 measured 83% of reviewer LLM calls already
 * exhausting `MAX_TOOL_ROUNDS` at 67% of reviewer spend, i.e. this prompt has
 * no headroom to spare — a new unconditional section should claim less
 * budget than an existing one, not the same amount. 20,000 chars (~6.7K
 * tokens at `chunked-review.ts`'s `CHARS_PER_TOKEN = 3` convention)
 * comfortably fits 2-3 section-targeted extractions at the per-task cap
 * above, or a smaller number of whole-spec fallbacks.
 */
export const MAX_REFERENCED_SPECS_TOTAL_CHARS = 20_000;

/**
 * Heading keywords scanned for in the text immediately surrounding an
 * `mt#NNNN` reference, to target section-level injection over whole-spec
 * injection (mt#3919 R1 BLOCKING: "prefer relevance to raw truncation").
 * Matched case-insensitively against `## <heading>` lines in the referenced
 * spec — same boundary rule `getTaskSpecContentFromParams`
 * (packages/domain/src/tasks/commands/query-commands.ts) uses, reimplemented
 * locally in `extractHintedSections` below rather than imported: that
 * function is a CLI/session-level orchestrator (repo-path resolution, DI
 * service construction) the reviewer has no reason to depend on for a
 * ~15-line slicing algorithm.
 */
const SECTION_HINT_KEYWORDS: ReadonlyArray<{ re: RegExp; heading: string }> = [
  { re: /success criteria/i, heading: "Success Criteria" },
  { re: /acceptance tests?/i, heading: "Acceptance Tests" },
  { re: /\bscope\b/i, heading: "Scope" },
  { re: /\bsummary\b/i, heading: "Summary" },
  { re: /\bcontext\b/i, heading: "Context" },
];

/** Characters of context scanned on each side of an `mt#NNNN` match for section-hint keywords. */
const SECTION_HINT_WINDOW_CHARS = 300;

/**
 * Heading prefix this repo's own spec-authoring convention uses to record an
 * override of earlier text (see this file's own "## AMENDED 2026-08-10"-style
 * sections in mt#3874/mt#3915, and `work-completion.mdc`/prompt.ts's
 * carve-out instructions, which cite the same "later text supersedes earlier
 * text" section-precedence hierarchy). Unioned into section-targeted
 * extraction unconditionally — see `extractHintedSections` — so that a
 * criterion satisfied entirely by an amendment section is not invisible to
 * targeted injection just because nothing in the criterion text happened to
 * name it explicitly.
 *
 * Exported for reuse by short-id-fetch.ts (mt#3964): memory bodies follow the
 * SAME "## Correction N" / "## AMENDED" convention (mem#648's own
 * "## CORRECTION 1/2/3" headings are a live example) — a live replay found
 * that without heading-targeted extraction, a large memory body truncates
 * from the head before reaching a late "## CORRECTION" section, making a
 * criterion depending on it render Unverifiable regardless of whether the
 * memory actually carries the change (see extractAmendmentSections there).
 */
export const AMENDMENT_HEADING_RE = /^(amend|correction|update)/i;

/** One resolved `mt#NNNN` reference, plus any section names its local context hinted at. */
export interface ReferencedTaskRef {
  taskId: string;
  /** Section headings named near this reference; [] when no keyword matched. */
  sectionHints: string[];
}

/**
 * Extract every distinct `mt#NNNN` reference from `text`, in first-occurrence
 * order, excluding `selfTaskId` (the bound task referencing its own id is not
 * a "referenced" spec — its content is already injected as the primary Task
 * Specification section), capped at `MAX_REFERENCED_TASK_SPECS`, and paired
 * with any section-hint keywords found within `SECTION_HINT_WINDOW_CHARS` of
 * the reference (mt#3919 R1 BLOCKING follow-up — section-targeted injection).
 *
 * Exported for tests; also used by `resolveReferencedTaskSpecs` below.
 */
export function extractReferencedTaskRefs(
  text: string,
  selfTaskId?: string | null
): ReferencedTaskRef[] {
  const selfNormalized = selfTaskId ? normalizeMtId(selfTaskId) : null;
  const hintsByTaskId = new Map<string, Set<string>>();
  const order: string[] = [];
  // Fresh RegExp instance per call: a module-scoped `g`-flagged regex is
  // stateful across calls via `lastIndex`, which would corrupt results under
  // concurrent or repeated invocations.
  const re = new RegExp(REFERENCED_TASK_ID_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const id = `mt#${m[1]}`;
    if (selfNormalized !== null && id === selfNormalized) continue;

    let hintSet = hintsByTaskId.get(id);
    if (!hintSet) {
      if (order.length >= MAX_REFERENCED_TASK_SPECS) continue;
      hintSet = new Set<string>();
      hintsByTaskId.set(id, hintSet);
      order.push(id);
    }

    const windowStart = Math.max(0, m.index - SECTION_HINT_WINDOW_CHARS);
    const windowEnd = Math.min(text.length, m.index + m[0].length + SECTION_HINT_WINDOW_CHARS);
    const window = text.slice(windowStart, windowEnd);
    for (const { re: hintRe, heading } of SECTION_HINT_KEYWORDS) {
      if (hintRe.test(window)) hintSet.add(heading);
    }
  }
  return order.map((taskId) => ({
    taskId,
    sectionHints: Array.from(hintsByTaskId.get(taskId) ?? []),
  }));
}

/**
 * Id-only view of `extractReferencedTaskRefs`, for callers that don't need
 * section hints.
 */
export function extractReferencedTaskIds(text: string, selfTaskId?: string | null): string[] {
  return extractReferencedTaskRefs(text, selfTaskId).map((r) => r.taskId);
}

/** Normalize an `mt#NNNN` / `mt-NNNN` string to the canonical `mt#NNNN` form. */
function normalizeMtId(taskId: string): string | null {
  const m = /\bmt[#-](\d+)/i.exec(taskId);
  return m ? `mt#${m[1]}` : null;
}

/**
 * Extract `## <heading>` sections from `specContent` matching `sectionHints`
 * (case-insensitive exact-heading match) OR `AMENDMENT_HEADING_RE` (always
 * unioned in — see that constant's doc comment). Sections are concatenated in
 * the order they appear in `specContent`, separated by a blank line.
 *
 * Returns `null` when `sectionHints` is empty (nothing to target) OR when
 * none of the hints matched any heading in this specific spec — either way
 * the caller falls back to the whole spec, which is the safer default: an
 * empty/no-match result must never be mistaken for "the section exists and
 * is empty."
 */
function extractHintedSections(specContent: string, sectionHints: string[]): string | null {
  if (sectionHints.length === 0) return null;

  const lines = specContent.split("\n");
  const wantedHeadings = new Set(sectionHints.map((h) => h.toLowerCase()));

  const matches: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line !== undefined && line.startsWith("## ")) {
      const heading = line.slice(3).trim();
      const isWanted =
        wantedHeadings.has(heading.toLowerCase()) || AMENDMENT_HEADING_RE.test(heading);
      if (isWanted) {
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

/** Result of applying a char cap: whether it fired, and how much was cut. */
export interface CappedContent {
  content: string;
  truncated: boolean;
  omittedChars: number;
}

/**
 * Cap `content` at `maxChars`, truncating from the tail (`safeTruncate`, not
 * a raw slice, so a cut cannot land between a high/low surrogate pair and
 * hand the model a broken character — mt#1615's fix, reused here).
 *
 * Exported for reuse by `short-id-fetch.ts` (mt#3964), which applies the same
 * size-cap discipline to `mem#N`/`ask#N`/`ws#N` reference content — a memory
 * body is unbounded in the same way a task spec is (PR #2841's blocking
 * finding was exactly that), so the two callers share one truncation rule
 * rather than risking it drifting between them.
 */
export function capContent(content: string, maxChars: number): CappedContent {
  if (content.length <= maxChars) {
    return { content, truncated: false, omittedChars: 0 };
  }
  const truncatedText = safeTruncate(content, maxChars, "head");
  return {
    content: truncatedText,
    truncated: true,
    omittedChars: content.length - truncatedText.length,
  };
}

/**
 * Outcome of resolving one `mt#NNNN` reference found inside a task spec's
 * text (mt#3919). Distinct from `TaskSpecFetchResult` in that it always
 * carries `taskId` (every entry originates from a successfully-extracted
 * reference), records the referenced task's `updatedAt` — gate (h)'s
 * auditability requirement, a criterion verified against another task's spec
 * depends on mutable DB state, so the verdict should record *when* the
 * evidence was read — and records whether/how much of the fetched content
 * was cut by the size caps (mt#3919 R1 BLOCKING).
 */
export interface ReferencedTaskSpecResult {
  taskId: string;
  /**
   * Injected content, or null when either (a) the fetch did not succeed
   * (`fetchResult.status !== "found"`), or (b) the fetch succeeded but the
   * TOTAL budget across all references was already exhausted before this
   * one's turn — in case (b), `fetchResult.status` is still `"found"` and
   * `truncated` is `true`, which is how the two are told apart.
   */
  content: string | null;
  /**
   * ISO-8601 timestamp of the referenced task's SPEC CONTENT
   * (`task_specs.updated_at`), or null when the backend tracks none.
   *
   * Deliberately not the task row's `updatedAt`, which a status transition
   * bumps — see mt#4415 and the note at the assignment site.
   */
  updatedAt: string | null;
  fetchResult: TaskSpecFetchResult;
  /**
   * True when the content shown is NOT the complete picture — either
   * shortened by the per-task cap, or entirely omitted by the total-budget
   * cap (case (b) on `content` above). The prompt renderer surfaces this
   * explicitly and instructs `Unverifiable`, never `Not Met`, when the
   * criterion's evidence might live in the cut portion.
   */
  truncated: boolean;
  /** Characters cut by truncation, or the full length when `content` is null due to the total budget; 0 when `truncated` is false. */
  omittedChars: number;
  /** Section heading(s) actually targeted, when section-targeted extraction fired. Undefined = whole-spec (fallback or no content). */
  sectionsInjected?: string[];
}

/**
 * Resolve every `mt#NNNN` reference appearing in `taskSpec`'s text (mt#3919).
 *
 * This is the mechanism the mt#3919 Decision section names: the reviewer
 * already calls `taskService.getTaskSpecContent(taskId)` for the BOUND task
 * (via `resolveTaskSpec` above); this function reuses the same injected
 * service to additionally fetch any OTHER task specs a success criterion
 * names as its artifact, so the reviewer can verify that criterion against
 * real content rather than reporting it unmet purely because the artifact is
 * outside the diff.
 *
 * Bounded on three axes (mt#3919 PR #2841 R1 BLOCKING): the NUMBER of specs
 * resolved (`MAX_REFERENCED_TASK_SPECS`), the bytes injected per spec
 * (`MAX_REFERENCED_SPEC_CHARS_PER_TASK`, applied to a section-targeted
 * extraction when one was found, else the whole spec), and the TOTAL bytes
 * across all specs in one review (`MAX_REFERENCED_SPECS_TOTAL_CHARS`).
 *
 * Never blocks and never throws: a fetch failure for one reference (missing
 * task, disabled service, transport error) produces a `content: null` entry
 * with the failure's `fetchResult` — the caller renders this so the model can
 * report the criterion `Unverifiable` (never `Met`, never silently dropped).
 * The same `Unverifiable` contract extends to truncated/budget-omitted
 * content — see `ReferencedTaskSpecResult.truncated`.
 *
 * @param input.taskSpec The bound task's spec text to scan for references.
 *   Null/empty → returns [].
 * @param input.boundTaskId The bound task's own id (from `resolveTaskSpec`'s
 *   `fetchResult.taskId`), excluded from the results — see
 *   `extractReferencedTaskRefs`.
 * @param input.taskService Optional injected TaskService. When absent, every
 *   extracted reference is returned with `fetchResult.status: "disabled"` —
 *   the reviewer still SEES that a reference exists (so the model can report
 *   it `Unverifiable` rather than silently ignoring it), it just cannot fetch it.
 */
export async function resolveReferencedTaskSpecs(input: {
  taskSpec: string | null;
  boundTaskId?: string | null;
  taskService?: TaskServiceInterface | null;
}): Promise<ReferencedTaskSpecResult[]> {
  if (!input.taskSpec) return [];

  const refs = extractReferencedTaskRefs(input.taskSpec, input.boundTaskId);
  if (refs.length === 0) return [];

  if (!input.taskService) {
    return refs.map(({ taskId }) => ({
      taskId,
      content: null,
      updatedAt: null,
      fetchResult: { status: "disabled", taskId },
      truncated: false,
      omittedChars: 0,
    }));
  }

  const results: ReferencedTaskSpecResult[] = [];
  let totalCharsUsed = 0;

  for (const { taskId, sectionHints } of refs) {
    try {
      const result = await input.taskService.getTaskSpecContent(taskId);
      const fullContent = result.content;
      if (!fullContent) {
        results.push({
          taskId,
          content: null,
          updatedAt: null,
          fetchResult: { status: "not-found", taskId },
          truncated: false,
          omittedChars: 0,
        });
        continue;
      }

      const hinted = extractHintedSections(fullContent, sectionHints);
      const rawContent = hinted ?? fullContent;
      // The spec-CONTENT timestamp, not the task row's (mt#4415). The prompt
      // renders this as "(spec last updated X)" and the field below documents
      // it as the spec's — but it was `result.task?.updatedAt`, which any
      // status transition bumps, so a spec untouched for weeks could be
      // presented to the reviewer as edited moments ago. Null when the backend
      // tracks none, which drops the suffix rather than printing a wrong one.
      const updatedAt = result.specUpdatedAt;
      const updatedAtIso = updatedAt instanceof Date ? updatedAt.toISOString() : null;

      // Total-budget check FIRST: if there is no room left at all, omit this
      // spec's content entirely rather than injecting a sliver that reads as
      // more complete than it is (mt#3919 R1 BLOCKING).
      if (totalCharsUsed >= MAX_REFERENCED_SPECS_TOTAL_CHARS) {
        results.push({
          taskId,
          content: null,
          updatedAt: updatedAtIso,
          fetchResult: { status: "found", taskId, specLength: fullContent.length },
          truncated: true,
          omittedChars: rawContent.length,
          ...(hinted !== null ? { sectionsInjected: sectionHints } : {}),
        });
        continue;
      }

      const remainingTotalBudget = MAX_REFERENCED_SPECS_TOTAL_CHARS - totalCharsUsed;
      const perTaskCap = Math.min(MAX_REFERENCED_SPEC_CHARS_PER_TASK, remainingTotalBudget);
      const capped = capContent(rawContent, perTaskCap);
      totalCharsUsed += capped.content.length;

      results.push({
        taskId,
        content: capped.content,
        updatedAt: updatedAtIso,
        fetchResult: { status: "found", taskId, specLength: fullContent.length },
        truncated: capped.truncated,
        omittedChars: capped.omittedChars,
        ...(hinted !== null ? { sectionsInjected: sectionHints } : {}),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not.found|does not exist|no such/i.test(message)) {
        results.push({
          taskId,
          content: null,
          updatedAt: null,
          fetchResult: { status: "not-found", taskId },
          truncated: false,
          omittedChars: 0,
        });
      } else {
        results.push({
          taskId,
          content: null,
          updatedAt: null,
          fetchResult: { status: "error", taskId, error: message },
          truncated: false,
          omittedChars: 0,
        });
      }
    }
  }
  return results;
}
