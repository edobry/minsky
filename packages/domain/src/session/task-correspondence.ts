/**
 * PR-task correspondence detector (mt#2514, Seam 2 of mt#2511).
 *
 * Blocks a `session_pr_merge` when the PR's commits reference a task DIFFERENT
 * from the one the session is bound to — the "task-hijack" cross-bind case
 * (originating incident: mt#2191, where a deck shipped under an unrelated task).
 *
 * Conservative by construction — only a STRONG cross-task signal flags a
 * mismatch (see {@link detectTaskCorrespondenceMismatch}). The pure functions
 * here carry the logic; the GitHub-API commit fetch is injected by the caller
 * (`mergeSessionPr`) so this module stays unit-testable without a network mock.
 *
 * Catches Case 1 (commits reference task B != bound task A). Case 2 (commits
 * labeled with the bound task A while doing unrelated work) is NOT detectable
 * from commit refs — Seam 1 (mt#2515, the bind/advance spec-read guard) covers it.
 */

/** Override env var: set to "1"/"true"/"yes" to skip the correspondence check. */
export const TASK_HIJACK_OVERRIDE_ENV = "MINSKY_ACK_TASK_HIJACK";

/**
 * Task-reference pattern: a known backend prefix (`mt`/`md`/`gh`) + separator
 * (`#` or `-`) + digits. Restricting to known backends avoids false matches on
 * incidental `xx-1234` tokens (e.g. `co-2024`) in commit subjects.
 */
const TASK_REF_RE = /\b(mt|md|gh)[#-](\d+)\b/gi;

/**
 * Normalise a task id for comparison: lowercase, strip every non-alphanumeric.
 * `mt#2514` / `MT#2514` / `mt-2514` / `mt2514` all collapse to `mt2514`.
 * Returns "" for a non-string / empty id.
 */
export function normalizeTaskId(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Extract NORMALISED task references from one commit subject. */
export function extractTaskRefs(subject: unknown): string[] {
  if (typeof subject !== "string") return [];
  const refs: string[] = [];
  const re = new RegExp(TASK_REF_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(subject)) !== null) {
    refs.push(normalizeTaskId(`${m[1]}${m[2]}`));
  }
  return refs;
}

export interface CorrespondenceVerdict {
  /** True iff a strong cross-task mismatch was detected. */
  mismatch: boolean;
  /** Distinct normalised task-ids referenced across all subjects. */
  referencedTasks: string[];
  /** The normalised bound task id. */
  boundTask: string;
}

/**
 * Strong cross-task mismatch: ≥1 subject references a task != the bound task,
 * AND no subject references the bound task. Conservative:
 *   - empty bound task → no mismatch (can't compare)
 *   - no refs at all → no mismatch (terse commits)
 *   - any ref to the bound task → no mismatch (work plausibly touches it)
 */
export function detectTaskCorrespondenceMismatch(
  commitSubjects: readonly string[],
  boundTaskId: unknown
): CorrespondenceVerdict {
  const boundTask = normalizeTaskId(boundTaskId);
  const referenced = new Set<string>();
  for (const subject of commitSubjects ?? []) {
    for (const ref of extractTaskRefs(subject)) referenced.add(ref);
  }
  const referencedTasks = [...referenced];
  if (!boundTask || referencedTasks.length === 0 || referenced.has(boundTask)) {
    return { mismatch: false, referencedTasks, boundTask };
  }
  return { mismatch: true, referencedTasks, boundTask };
}

/** Whether the override env-var is set (truthy "1"/"true"/"yes"). */
export function isTaskHijackOverride(
  env: Record<string, string | undefined> = process.env
): boolean {
  const v = env[TASK_HIJACK_OVERRIDE_ENV];
  return v === "1" || v?.toLowerCase() === "true" || v?.toLowerCase() === "yes";
}

/** Build the block message naming the bound task, the referenced task(s), and the override. */
export function buildHijackBlockMessage(
  verdict: CorrespondenceVerdict,
  rawBoundTaskId: string
): string {
  const refs = verdict.referencedTasks.join(", ");
  return [
    `Refusing to merge: this session is bound to ${rawBoundTaskId}, but the PR's commits`,
    `reference a different task (${refs}) and none reference ${rawBoundTaskId}. This is the`,
    `"task-hijack" cross-bind case (mt#2511 Seam 2): merging would auto-complete`,
    `${rawBoundTaskId} with work that belongs to ${refs}.`,
    "",
    `Re-bind this work to the correct task (start a session on the right task, or move the`,
    `commits there), or — if this binding is genuinely intentional — set`,
    `${TASK_HIJACK_OVERRIDE_ENV}=1 to override (audit-logged).`,
  ].join("\n");
}

export interface CorrespondenceCheckDeps {
  /** The task id the session is bound to. */
  boundTaskId: unknown;
  /** Fetch the PR's commit subjects (first line of each commit message). Injected. */
  listCommitSubjects: () => Promise<string[]>;
  env?: Record<string, string | undefined>;
  log?: { debug?: (m: string) => void; warn?: (m: string) => void };
  /** Sink for the override audit line (default: stdout). */
  onOverrideAudit?: (line: string) => void;
  /** ISO timestamp for the override audit line (injected for testability). */
  nowIso?: string;
}

/**
 * Evaluate PR-task correspondence. Returns a block-message string when the
 * merge MUST be blocked, or `null` when it may proceed.
 *
 * Fail-open: override set, no bound task, or any error fetching commits → null
 * (proceed). Only a confirmed strong cross-task mismatch returns a message.
 */
export async function evaluateTaskCorrespondence(
  deps: CorrespondenceCheckDeps
): Promise<string | null> {
  const env = deps.env ?? process.env;
  if (isTaskHijackOverride(env)) {
    const ts = deps.nowIso ?? new Date().toISOString();
    const line = `[task-correspondence] OVERRIDE ${TASK_HIJACK_OVERRIDE_ENV}=${env[TASK_HIJACK_OVERRIDE_ENV]} boundTask=${String(deps.boundTaskId)} ts=${ts}`;
    (deps.onOverrideAudit ?? ((l: string) => process.stdout.write(`${l}\n`)))(line);
    return null;
  }
  if (!normalizeTaskId(deps.boundTaskId)) return null; // no bound task → can't compare
  let subjects: string[];
  try {
    subjects = await deps.listCommitSubjects();
  } catch (err) {
    deps.log?.warn?.(
      `task-correspondence: could not list PR commits (fail-open, allowing merge): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }
  const verdict = detectTaskCorrespondenceMismatch(subjects, deps.boundTaskId);
  return verdict.mismatch ? buildHijackBlockMessage(verdict, String(deps.boundTaskId)) : null;
}
