/**
 * editAskContent — content-update surface for a non-terminal Ask (mt#2668).
 *
 * The Ask substrate previously had no content-update path: `respondAndClose`
 * CONSUMES a suspended Ask (the answering path), and the field-level updates
 * (`updateWindowMissedCount` / `updateForceImmediate` / `updateRoutingTarget`)
 * are mechanism-owned, not content-bearing. Long-lived direction.decide Asks
 * (weeks in the suspended state) accumulate stale context as the underlying
 * investigation advances; without this primitive, agents must either file
 * duplicate Asks (queue noise, splits the decision thread) or leave stale
 * content in front of the operator.
 *
 * Shape mirrors `respondAndCloseAsk` (mt#2615): a domain-level function that
 * takes the repository plus params, applies the friendly precondition checks,
 * and delegates the atomic write to the repository. Editing MUST NOT change
 * `state` — a suspended Ask stays suspended and stays in the operator queue.
 *
 * Provenance: every edit appends an {@link AskEditNote} to the
 * `metadata.editHistory` array (append-only; caller-supplied metadata cannot
 * clobber it) so the operator can see the question changed since routing.
 * The asks table has no `updated_at` column; the note's `editedAt` timestamp
 * is the edit-recency record.
 */

import type { AskRepository, EditAskFields } from "./repository";
import type { Ask, AskOption, ContextRef } from "./types";

/**
 * Append-only provenance note recorded in `metadata.editHistory` on every
 * content edit (mt#2668).
 */
export interface AskEditNote {
  /** ISO-8601 timestamp of the edit. */
  editedAt: string;
  /** Who edited — AgentId or "operator"; defaults to "minsky.agent:unknown". */
  editor: string;
  /** Which content fields the edit touched (param names, e.g. "question"). */
  fields: string[];
}

/** Reserved metadata key carrying the append-only edit provenance notes. */
export const EDIT_HISTORY_METADATA_KEY = "editHistory";

/**
 * Keys that must never enter the metadata merge — prototype-pollution
 * hardening (PR #1831 review). `metadata` arrives from the MCP surface as
 * untrusted input; merging a literal `__proto__` / `constructor` /
 * `prototype` own-key into a plain object is the classic pollution vector,
 * and even under spread semantics (which define rather than set) a persisted
 * `__proto__` own-property is a hazard for downstream consumers. The shared
 * command layer's parameter validator enforces the same list at the
 * boundary; this constant is the single policy both layers align on.
 */
export const FORBIDDEN_METADATA_KEYS = ["__proto__", "prototype", "constructor"] as const;

/**
 * Return a fresh object containing only the safe own-keys of `metadata` —
 * every {@link FORBIDDEN_METADATA_KEYS} entry is dropped. Applied to BOTH
 * sides of the edit merge (existing row metadata and caller-supplied
 * metadata) as defense-in-depth: a hostile key already persisted at create
 * time is scrubbed on the way through, not just blocked at the boundary.
 */
export function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if ((FORBIDDEN_METADATA_KEYS as readonly string[]).includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Params accepted by {@link editAskContent}. */
export interface EditAskContentParams {
  /** Primary key of the Ask to edit. */
  id: string;
  /** Replacement title (list rendering / notifications). */
  title?: string;
  /** Replacement question body. */
  question?: string;
  /** Replacement decision-frame options (wholesale replace, not merge). */
  options?: AskOption[];
  /** Replacement context refs (wholesale replace, not merge). */
  contextRefs?: ContextRef[];
  /**
   * Metadata keys to shallow-merge over the existing metadata. Existing keys
   * not named here are preserved. The `editHistory` key is reserved — a
   * caller-supplied value for it is ignored in favor of the appended note.
   */
  metadata?: Record<string, unknown>;
  /** Editor identity recorded in the provenance note; defaults to "minsky.agent:unknown". */
  editor?: string;
}

/** Names of the content-bearing params an edit may touch. */
const EDITABLE_FIELDS = ["title", "question", "options", "contextRefs", "metadata"] as const;

/**
 * Collect the names of the editable fields actually provided on the params.
 * Exported for the parameter-boundary validator in the shared command layer.
 */
export function providedEditableFields(
  params: Pick<EditAskContentParams, (typeof EDITABLE_FIELDS)[number]>
): string[] {
  return EDITABLE_FIELDS.filter((f) => params[f] !== undefined);
}

/**
 * Edit the content of a non-terminal Ask in place.
 *
 * Preconditions (validated up front; throw clear errors on violation):
 *   - `params.id` is a non-empty string.
 *   - At least one editable field (title / question / options / contextRefs /
 *     metadata) is provided.
 *   - Ask exists (`repo.getById` returns non-null).
 *   - Ask is NOT in a terminal state (closed / cancelled / expired). All
 *     non-terminal states are editable — including `suspended`, the primary
 *     use case (refreshing a long-lived operator-queued Ask), which stays
 *     suspended and stays in the operator queue.
 *
 * The terminal-state guard is enforced twice: the friendly pre-check here,
 * and atomically inside `repo.updateContent` (optimistic-concurrency WHERE
 * clause), so a concurrent close between read and write cannot slip an edit
 * onto a terminal row.
 */
export async function editAskContent(
  repo: AskRepository,
  params: EditAskContentParams
): Promise<{ ask: Ask }> {
  if (!params.id || params.id.trim() === "") {
    throw new Error("editAskContent: id is required and must not be empty");
  }

  const fields = providedEditableFields(params);
  if (fields.length === 0) {
    throw new Error(
      "editAskContent: at least one editable field (title, question, options, contextRefs, metadata) must be provided"
    );
  }

  const existing = await repo.getById(params.id);
  if (!existing) {
    throw new Error(`editAskContent: Ask not found: ${params.id}`);
  }
  if (
    existing.state === "closed" ||
    existing.state === "cancelled" ||
    existing.state === "expired"
  ) {
    throw new Error(
      `editAskContent: Ask is in terminal state "${existing.state}" — only non-terminal Asks can be edited. ` +
        `Editing never changes state; a suspended Ask stays suspended.`
    );
  }

  const editor = params.editor?.trim() || "minsky.agent:unknown";
  const note: AskEditNote = {
    editedAt: new Date().toISOString(),
    editor,
    fields,
  };

  // Shallow-merge caller metadata over the existing metadata, then append the
  // provenance note. The note always wins over a caller-supplied editHistory —
  // the history is append-only by construction. Both sides pass through
  // sanitizeMetadata so forbidden keys (prototype-pollution vectors) never
  // enter the merge, whatever their origin.
  const existingHistory = existing.metadata[EDIT_HISTORY_METADATA_KEY];
  const history = Array.isArray(existingHistory) ? existingHistory : [];
  const mergedMetadata: Record<string, unknown> = {
    ...sanitizeMetadata(existing.metadata),
    ...sanitizeMetadata(params.metadata ?? {}),
    [EDIT_HISTORY_METADATA_KEY]: [...history, note],
  };

  const write: EditAskFields = { metadata: mergedMetadata };
  if (params.title !== undefined) write.title = params.title;
  if (params.question !== undefined) write.question = params.question;
  if (params.options !== undefined) write.options = params.options;
  if (params.contextRefs !== undefined) write.contextRefs = params.contextRefs;

  const ask = await repo.updateContent(params.id, write);
  return { ask };
}
