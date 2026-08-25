#!/usr/bin/env bun
// PreToolUse hook on mcp__minsky__tasks_status_set: when a task transitions to
// DONE, surface the decision records that described its deliverable as FUTURE
// WORK, so they can be reconciled instead of silently going stale (mt#4535).
//
// The decay this catches is not a claim that was WRONG when written. ADR-006's
// Layer 3 paragraph said the `<claude-pid> -> sessionId` mapping was an "upgrade
// path if that bites"; that was accurate the day it was written. mt#3900 then
// shipped exactly that mapping, and nothing reconciled the ADR — so for weeks it
// presented shipped work as pending, to every agent that read it. There is no
// error to notice on a careful re-read, which is why it survives review and why
// five per-instance repairs (mt#4326, mt#4282, mt#4501, plus ADR-006 and mem#706
// repaired by hand) exist with no mechanism owner.
//
// The moment with the most information is task COMPLETION, and nothing ran there.
//
// ## Why the id alone is not the match
//
// The obvious mechanism — grep the corpus for the task id — would have MISSED
// this hook's own originating instance. ADR-006 named no task: it described the
// mechanism in prose ("a SessionStart hook writing a `<claude-pid> -> sessionId`
// mapping the proxy re-reads per request"). An id-only reverse index is
// therefore accurate about the artifacts that happen to cite a task and silent
// about exactly the class that matters most.
//
// So a candidate needs a FORWARD-LOOKING marker plus EITHER the task id OR
// enough distinctive tokens from the task's own title. The title is the only
// description of the deliverable available at transition time, which is what
// makes the descriptive path reachable at all.
//
// ## Why this is advisory and log-only
//
// The false-positive rate of title-token matching against a 44-ADR / ~50-rule
// corpus is unmeasured, and nothing is yet known about how often a DONE
// transition has any forward-reference at all. Per ADR-024's calibration ladder
// -- cited here for its LADDER, not as governance; that ADR's own scope is the
// guidance-hook family matching phrases in the agent's output, and this is a
// cross-reference check over artifacts -- ship the measurement before the
// enforcement. Every invocation writes a fire-log record, fired or not, so the
// miss rate has a denominator.
//
// Reporting rather than acting is also what the accepted task-state-machine RFC
// already does at this seam: "a DONE-reopen records a divergence and routes to
// operator attention instead of silently un-finishing merged work"
// (Notion 3a4937f0, Accepted 2026-07-21). This is a second check in that shape.
//
// ## CLOSED is deliberately not covered in v1
//
// SC1 asks to "consider CLOSED". A CLOSED task's forward references are stale
// too, but differently: the work is abandoned, so the reconciliation is "this
// will never come" rather than "this already shipped", and the advisory would
// need to say something different. Firing the shipped-it text on an abandoned
// task would be worse than silence. Left to a follow-up once the DONE case has
// calibration data.
//
// @see mt#4535 — this hook
// @see mt#4326, mt#4282, mt#4501 — the per-instance repairs this exists to retire
// @see mem#706 — the assertion-without-verification family root
// @see docs/architecture/adr-006-agent-identity.md — the originating instance

import { readInput, writeOutput, deriveHookRepoRoot } from "./types";
import type { ToolHookInput } from "./types";
import { describeProviderResolutionFailure, ensureHookDomainBootstrap } from "./domain-bootstrap";
import type { SqlCapablePersistenceProvider } from "../../packages/domain/src/persistence/types";
import { recordFireLogEntry } from "./fire-log";
import { resolveMergeGateTaskId } from "./merge-gate-task-resolution";
import { normalizeTaskId } from "./gate-walk-provenance";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

/** This guard's fire-log identifier. */
const GUARD_NAME = "warn-stale-forward-reference";

/**
 * The EXPLICIT surface: an agent calling `tasks_status_set` with `status: DONE`.
 *
 * Rare by policy — `task-status-workflow-protocol.mdc` says "never manually set
 * DONE from a session; DONE is set only at PR merge." Kept because an agent that
 * DOES set it explicitly should still be covered (mt#4545 SC2), not because it is
 * the common case.
 */
export const TARGET_TOOL = "mcp__minsky__tasks_status_set";

/**
 * The REAL surface: the merge, which is where DONE is actually written.
 *
 * mt#4535 registered on `TARGET_TOOL` alone and therefore never fired on a real
 * transition: at merge, `session-merge-status-sync.ts:239` calls
 * `taskService.setTaskStatus()` — a DIRECT domain-service call that no
 * tool-level hook can observe. Verified by fire log (one record, `guardOutcome`
 * unset) against 249 for the sibling on the same matcher.
 *
 * This is ADR-042's own discriminator applied to an observer: "each backstop
 * fires at the seam where that trace first exists." For a DONE transition that
 * seam is the merge tool call, not the status-set tool call.
 *
 * PostToolUse rather than PreToolUse, so it fires on a transition that actually
 * HAPPENED — `deploy-verification-after-merge.ts` is the precedent for both the
 * event and the `tool_result.success` check.
 */
export const MERGE_TOOL = "mcp__minsky__session_pr_merge";

/**
 * The status this fires on at the explicit surface. DONE only — see the CLOSED
 * note in the file header. The merge surface needs no status check: a successful
 * merge IS the DONE transition.
 */
export const TRIGGER_STATUS = "DONE";

/**
 * Overall deadline for the title read.
 *
 * ADR-042: "a registration's `timeoutMs` is declarative and unenforced ... bound
 * it yourself." Sized against `domain-bootstrap.ts`'s measurement of a cold
 * hook-shaped `resolvePersistenceProvider()` — 4.3-5.5s cold, 3.3-3.7s warmed —
 * so this admits a cold resolve plus a small query and still fails open inside
 * the registration's 15s. A CEILING over a measured maximum, not a typical
 * (`decision-defaults.mdc §Thresholds`, CEILING case).
 */
const READ_DEADLINE_MS = 8000;

/**
 * Phrases that mark prose as describing something as NOT YET DONE.
 *
 * Deliberately a closed, small list of the shapes that actually appear in this
 * corpus's decision records rather than an open-ended "future-ish" matcher: the
 * precision lever here is the CONJUNCTION with a task reference, so this half
 * can afford to be literal.
 */
export const FORWARD_MARKERS: readonly string[] = [
  "upgrade path",
  "future work",
  "not yet",
  "notyet",
  "would require",
  "will require",
  "when that ships",
  "once that ships",
  "until that ships",
  "when it ships",
  "if that bites",
  "deferred",
  "planned",
  "proposed",
  "still open",
  "to be built",
  "not implemented",
  "no current owner",
  "tracked separately",
];

/** Words carrying no discriminating power in a task title. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "then",
  "than",
  "that",
  "this",
  "these",
  "those",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "it",
  "its",
  "so",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "to",
  "with",
  "without",
  "not",
  "no",
  "never",
  "every",
  "any",
  "all",
  "one",
  "two",
  "can",
  "cannot",
  "does",
  "do",
  "did",
  "has",
  "have",
  "had",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "while",
  "because",
  "since",
  "after",
  "before",
  "task",
  "minsky",
  "implement",
  "implements",
  "add",
  "adds",
  "fix",
  "fixes",
  "make",
  "makes",
  "use",
  "uses",
  "using",
  "new",
  "old",
  "now",
  "still",
  "only",
  "just",
  "also",
  "more",
  "most",
]);

/**
 * Distinctive lowercase tokens from a task title.
 *
 * PURE. Length >= 4 and not a stopword — short tokens and lifecycle vocabulary
 * are what make a title-token matcher fire on everything.
 */
export function extractTitleTokens(title: string): string[] {
  const seen = new Set<string>();
  for (const raw of title.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4) continue;
    if (STOPWORDS.has(raw)) continue;
    seen.add(raw);
  }
  return [...seen];
}

/** Minimum distinct title tokens in a paragraph for the descriptive path. */
export const MIN_TITLE_TOKEN_HITS = 2;

/** One artifact paragraph that looks like a stale forward reference. */
export interface ForwardReferenceHit {
  /** Repo-relative path of the artifact. */
  file: string;
  /** 1-indexed line number the paragraph starts on. */
  line: number;
  /** The forward-looking marker that matched. */
  marker: string;
  /** "id" when the task id appears; "description" when title tokens matched. */
  via: "id" | "description";
  /** The matched text, trimmed and truncated for rendering. */
  excerpt: string;
}

/** An artifact's text, as the scanner consumes it. */
export interface CorpusDoc {
  file: string;
  text: string;
}

const EXCERPT_MAX = 240;

function truncate(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= EXCERPT_MAX ? flat : `${flat.slice(0, EXCERPT_MAX - 1)}…`;
}

/**
 * PURE scan: which paragraphs describe this task's deliverable as pending?
 *
 * Extracted from the IO so the rule is testable without patching a collaborator
 * the hook reaches itself (`testing-standards.mdc §Testable Design`) — the
 * corpus arrives as values.
 *
 * A paragraph qualifies when it carries a forward-looking marker AND either the
 * task id or `MIN_TITLE_TOKEN_HITS` distinct title tokens. The id path is exact;
 * the description path is the heuristic, and is why this ships log-only.
 */
export function findForwardReferences(
  taskId: string,
  titleTokens: readonly string[],
  docs: readonly CorpusDoc[]
): ForwardReferenceHit[] {
  const hits: ForwardReferenceHit[] = [];
  // `mt#3900` -> matches the literal id anywhere in the paragraph.
  const idNeedle = taskId.toLowerCase();

  for (const doc of docs) {
    const lines = doc.text.split("\n");
    // Paragraph = run of non-blank lines. Tracked with its starting line so the
    // advisory can point the reader at the text, not just the file — a file path
    // is not an answer when the whole failure is that the sentence reads fine.
    let start = 0;
    let buf: string[] = [];

    const flush = (): void => {
      if (buf.length === 0) return;
      const para = buf.join(" ");
      const lower = para.toLowerCase();
      buf = [];

      const marker = FORWARD_MARKERS.find((m) => lower.includes(m));
      if (!marker) return;

      if (lower.includes(idNeedle)) {
        hits.push({ file: doc.file, line: start + 1, marker, via: "id", excerpt: truncate(para) });
        return;
      }

      let tokenHits = 0;
      for (const t of titleTokens) {
        if (lower.includes(t)) tokenHits += 1;
        if (tokenHits >= MIN_TITLE_TOKEN_HITS) break;
      }
      if (tokenHits >= MIN_TITLE_TOKEN_HITS) {
        hits.push({
          file: doc.file,
          line: start + 1,
          marker,
          via: "description",
          excerpt: truncate(para),
        });
      }
    };

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      if (line.trim() === "") {
        flush();
        start = i + 1;
      } else {
        if (buf.length === 0) start = i;
        buf.push(line);
      }
    }
    flush();
  }
  return hits;
}

export interface ForwardReferenceDecision {
  fired: boolean;
  message?: string;
  /**
   * Guard-health marker, per the `tasks-status-set-guard.ts` convention:
   * - "decided" — the corpus was scanned and evaluated.
   * - "crashed" — the title read or the scan failed. A degraded probe failing
   *   open must never read as clean: without this, a broken path is silently
   *   quiet and indistinguishable from "no stale references".
   * - UNSET — the guard did not run (different tool, or a non-DONE transition).
   */
  outcome?: "decided" | "crashed";
}

/** Cap on rendered hits, so one noisy task cannot bury the turn. */
export const MAX_RENDERED_HITS = 8;

/** PURE: render the advisory for a set of hits. */
export function decideStaleForwardReference(
  taskId: string,
  hits: readonly ForwardReferenceHit[]
): ForwardReferenceDecision {
  if (hits.length === 0) return { fired: false, outcome: "decided" };

  const shown = hits.slice(0, MAX_RENDERED_HITS);
  const lines: string[] = [
    `[${GUARD_NAME}] ${taskId} is going DONE. These decision records may describe its work as still pending.`,
    "",
  ];
  for (const h of shown) {
    lines.push(`  - ${h.file}:${h.line} — matched "${h.marker}" (${h.via})`);
    lines.push(`      ${h.excerpt}`);
  }
  if (hits.length > shown.length) {
    lines.push(`  … and ${hits.length - shown.length} more not shown.`);
  }
  lines.push(
    "",
    "Reconcile the ones that are genuinely stale — an accepted decision record that",
    "still calls shipped work 'future work' is read as current by the next agent, and",
    "there is no error in it to notice. This is advisory: nothing is blocked, and a",
    "match is a CANDIDATE, not a verdict. Matches marked (description) are heuristic —",
    "they matched the task's title tokens, not its id.",
    "",
    "If none of these are stale, that is the expected common case and needs nothing."
  );

  return { fired: true, message: lines.join("\n"), outcome: "decided" };
}

/**
 * Corpus roots, repo-relative. Decision records plus the always-loaded rule
 * corpus — the two artifact classes whose staleness is inherited by every agent
 * that reads them. NOT task specs: a spec describing its own work as pending is
 * the normal state, not a defect.
 */
export const CORPUS_ROOTS: readonly { dir: string; match: RegExp }[] = [
  { dir: "docs/architecture", match: /^adr-.*\.md$/ },
  { dir: ".minsky/rules", match: /\.mdc$/ },
];

/** Read the corpus. Returns [] on any failure (fail open). */
export function readCorpus(repoRoot: string): CorpusDoc[] {
  const docs: CorpusDoc[] = [];
  for (const root of CORPUS_ROOTS) {
    const dir = join(repoRoot, root.dir);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      // A missing corpus dir is not an error worth failing the write over —
      // this guard is advisory. Recorded as a crash by the caller only when the
      // whole read throws.
      continue;
    }
    for (const name of names) {
      if (!root.match.test(name)) continue;
      try {
        docs.push({ file: `${root.dir}/${name}`, text: readFileSync(join(dir, name), "utf8") });
      } catch {
        // intentional-swallow: one unreadable artifact must not blind the scan
        // to the other 90. The fire-log records the invocation regardless.
        continue;
      }
    }
  }
  return docs;
}

/** Read this task's title. Returns null on any failure (fail open). */
async function readTaskTitle(taskId: string): Promise<string | null> {
  const bootstrap = await ensureHookDomainBootstrap();
  if (!bootstrap.ok) return null;

  const { resolvePersistenceProviderOrError } = await import(
    "../../packages/domain/src/persistence/factory"
  );
  const resolution = await resolvePersistenceProviderOrError();
  if (!resolution.ok) {
    process.stderr.write(
      `[${GUARD_NAME}] ${describeProviderResolutionFailure(resolution)} — failing open\n`
    );
    return null;
  }
  const provider = resolution.provider;
  if (!provider.capabilities.sql || typeof provider.getDatabaseConnection !== "function") {
    return null;
  }
  const db = await (provider as SqlCapablePersistenceProvider).getDatabaseConnection();
  // A SQL-capable provider can still hand back null (ADR-035: "configured but
  // failing" is not "not configured").
  if (!db) return null;
  // Queried directly rather than through a helper: no title-lookup accessor
  // exists in the domain layer, and adding one for a single advisory read would
  // be a wider change than this task's scope. Dynamic imports mirror the
  // template guard's shape (domain-bootstrap layer 1 requires the polyfill to be
  // installed before any domain module loads).
  const { eq } = await import("drizzle-orm");
  const { tasksTable } = await import("../../packages/domain/src/storage/schemas/task-embeddings");
  const rows = await db
    .select({ title: tasksTable.title })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId))
    .limit(1);
  return rows[0]?.title ?? null;
}

/** Which surface a hook invocation came in on, and the task it names. */
export interface Trigger {
  /** The task whose DONE transition this is, or null when the guard should not run. */
  taskId: string | null;
  /** Which lifecycle event to echo back in the injection envelope. */
  event: "PreToolUse" | "PostToolUse";
}

/**
 * PURE: does this invocation represent a task reaching DONE, and on which surface?
 *
 * Extracted so BOTH surfaces are testable without a live hook process — the gap
 * that let mt#4535 ship unreachable was precisely that nothing tested the
 * trigger, only the matching logic downstream of it.
 *
 * `mergeTaskId` is passed IN rather than resolved here so this stays pure;
 * the caller supplies `resolveMergeGateTaskId`'s answer.
 */
export function resolveTrigger(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  toolResult: Record<string, unknown> | undefined,
  mergeTaskId: string | null,
  eventPhase: "PreToolUse" | "PostToolUse"
): Trigger {
  if (toolName === TARGET_TOOL) {
    const taskId = (toolInput?.["taskId"] as string | undefined)?.trim();
    const status = (toolInput?.["status"] as string | undefined)?.trim();
    return {
      taskId: taskId && status === TRIGGER_STATUS ? taskId : null,
      event: eventPhase,
    };
  }
  if (toolName === MERGE_TOOL) {
    // A FAILED merge is not a DONE transition. Checking this is what keeps the
    // guard's own claim ("this task is going DONE") true — the same accuracy
    // the advisory asks its reader to restore in the corpus.
    const succeeded = toolResult?.["success"] === true;
    return { taskId: succeeded ? mergeTaskId : null, event: eventPhase };
  }

  // Any OTHER tool this hook is registered on: do not fire, but report the
  // lifecycle point HONESTLY (PR #3316 R1).
  //
  // This is not hypothetical. The PostToolUse block's matcher is
  // `mcp__minsky__session_pr_merge|mcp__github__merge_pull_request`, so the
  // bypass-merge tool reaches here — and hardcoding `"PreToolUse"` logged a
  // PostToolUse invocation as PreToolUse, corrupting the very fire-log this
  // task depends on for its coverage receipt.
  //
  // Not firing on `mcp__github__merge_pull_request` is CORRECT, not a second
  // coverage gap: the raw-bypass path does not set DONE at the merge call. It
  // reaches DONE later through `/verify-task`'s explicit `tasks_status_set`,
  // which the PreToolUse surface above already covers.
  //
  // Deriving the phase from the input rather than branching per tool also means
  // a future widening of either matcher cannot reintroduce this mislabel.
  return { taskId: null, event: eventPhase };
}

/** Narrow the harness's `hook_event_name` to the two phases this guard runs at. */
export function toEventPhase(hookEventName: string | undefined): "PreToolUse" | "PostToolUse" {
  return hookEventName === "PostToolUse" ? "PostToolUse" : "PreToolUse";
}

if (import.meta.main) {
  const startMs = Date.now();
  const input = await readInput<ToolHookInput>();

  // Resolved for the merge surface only — three channels (tool_input.task, the
  // cwd branch, a sessionId workspace), reusing the merge-gate resolver rather
  // than re-deriving them.
  const mergeTaskId =
    input.tool_name === MERGE_TOOL
      ? (() => {
          const r = resolveMergeGateTaskId(input);
          return r.taskId ? normalizeTaskId(r.taskId) : null;
        })()
      : null;

  const trigger = resolveTrigger(
    input.tool_name,
    input.tool_input,
    input.tool_result as Record<string, unknown> | undefined,
    mergeTaskId,
    toEventPhase(input.hook_event_name)
  );
  const taskId = trigger.taskId;

  let result: ForwardReferenceDecision = { fired: false };

  if (taskId) {
    try {
      const title = await Promise.race([
        readTaskTitle(taskId),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), READ_DEADLINE_MS)),
      ]);
      // A missing title degrades to the ID-ONLY path rather than failing: the
      // exact half still works, and reporting the exact matches beats reporting
      // nothing. Recorded as "crashed" so a persistently dead title read is not
      // mistaken for a clean corpus.
      const tokens = title ? extractTitleTokens(title) : [];
      // No argument: `deriveHookRepoRoot` defaults to `import.meta.dir`, which
      // resolves the repo containing THIS HOOK FILE. That is the corpus we want
      // and the only one guaranteed to exist — PR #3313 R1. `input.cwd` is the
      // caller's shell directory, which can be any subdirectory, a session
      // workspace, or a path outside a repo entirely; resolving from it risks a
      // silently EMPTY corpus, and an empty corpus reports "no stale references"
      // for every task, indistinguishable from a clean result (mem#704).
      const docs = readCorpus(deriveHookRepoRoot());
      const hits = findForwardReferences(taskId, tokens, docs);
      result = decideStaleForwardReference(taskId, hits);
      if (title === null) result.outcome = "crashed";
    } catch (err) {
      // Fail open — an advisory guard must never block a lifecycle write.
      process.stderr.write(
        `[${GUARD_NAME}] scan threw: ${err instanceof Error ? err.message : String(err)}\n`
      );
      result = { fired: false, outcome: "crashed" };
    }
  }

  if (result.fired && result.message) {
    writeOutput({
      hookSpecificOutput: {
        // Echoes the surface this invocation actually arrived on — a PostToolUse
        // injection labelled PreToolUse is not delivered.
        hookEventName: trigger.event,
        additionalContext: result.message,
      },
    });
  }

  recordFireLogEntry({
    guardName: GUARD_NAME,
    event: trigger.event,
    decision: "allow",
    ...(result.outcome !== undefined ? { guardOutcome: result.outcome } : {}),
    durationMs: Date.now() - startMs,
    toolName: input.tool_name,
    sessionId: input.session_id,
  });
  process.exit(0);
}
