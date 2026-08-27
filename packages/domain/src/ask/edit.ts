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
  /**
   * Prior values of the GRAPH fields a repair replaced (mt#4305). Absent on a
   * content edit.
   *
   * `fields` above records WHICH fields changed and not what they said — the
   * gap mem#1133 cost real work to discover, and which mt#4329 closed for
   * content fields via {@link AskOriginalContent}. That mechanism deliberately
   * captures the ORIGINAL only, once, because a question body is multi-KB and
   * `asks.list`'s body size is a live constraint (mt#2748).
   *
   * A graph field is not that. A task id and a routing target are short
   * strings, so recording the prior value on EVERY repair costs a few dozen
   * bytes per note and no growth argument applies. And for a reparent the prior
   * value is the whole point of the record: "this ask moved" without "from
   * where" cannot be audited or reversed.
   */
  previous?: AskGraphPrevious;
}

/**
 * Prior values of the graph fields a repair replaced (mt#4305).
 *
 * `parentTaskId` is the only member, and that follows from the repair rules
 * rather than being an oversight: a `routingTarget` repair only ever fills an
 * ABSENT target (see `repairAskGraph`), so there is never a prior value to
 * record. An earlier revision declared a `routingTarget` key here "for a future
 * widening"; PR #3263 R1 correctly flagged it as unpopulatable, and a field the
 * code can never set is not future-proofing — it is a claim the type makes and
 * the implementation does not honor. `repair.test.ts` pins the invariant
 * instead, so a future re-route verb has to come back here deliberately rather
 * than inherit a silently-empty slot.
 */
export interface AskGraphPrevious {
  parentTaskId?: string;
}

/** Reserved metadata key carrying the append-only edit provenance notes. */
export const EDIT_HISTORY_METADATA_KEY = "editHistory";

/**
 * The content an Ask carried when it was FIRST edited — the text that was
 * actually put in front of the principal (mt#4329).
 *
 * `AskEditNote` above records WHICH fields an edit touched. It does not record
 * WHAT they said, so an edited Ask's escalated text was unrecoverable from the
 * substrate: the record knew it had been edited and could not say to what. That
 * cost real work three times, each in a task building detector fixtures from the
 * ask corpus — `form-lint.test.ts`'s ask#6589 and `6807fb14` fixtures are
 * RECONSTRUCTIONS for exactly this reason, and mt#4315 only avoided a fourth
 * because the authoring harness transcript happened to still be on disk.
 *
 * ## Why the ORIGINAL only, and only once
 *
 * This is a size decision, not a taste one. `toAskSummary`
 * (`src/adapters/shared/commands/asks.ts`) deliberately omits `metadata` —
 * `editHistory` included — as part of the multi-KB "body" that made `asks.list`
 * unsafe to page at store size (mt#2748). A full revision log would grow that
 * body linearly in edit count and walk back toward that incident.
 *
 * Capturing the ORIGINAL only bounds the growth at **one extra copy of each
 * content field, ever**, no matter how many times the Ask is edited. It is also
 * exactly what the use case needs: the corpus is a MEASUREMENT corpus, and what
 * a measurement wants is the text that was escalated — not the intermediate
 * drafts of a correction.
 *
 * ## Per-field, not per-record
 *
 * Each field is captured the first time THAT field is edited, rather than all
 * fields on the first edit. An edit touching only `title` must not foreclose
 * capturing the original `question` when a later edit rewrites it — which is the
 * real shape of ask#9278, whose two edits touched title, question and
 * contextRefs together but need not have.
 *
 * `metadata` is deliberately NOT captured: it is shallow-MERGED rather than
 * replaced, so no metadata value is ever lost by an edit, and capturing it would
 * nest a copy of this record inside itself.
 */
export interface AskOriginalContent {
  /**
   * ISO-8601 timestamp of the first edit that captured ANY field here.
   *
   * Not per-field: a later field's capture does not move it. Read it as "this
   * Ask was first edited at", which is what a corpus sweep scoping to
   * originals actually asks.
   */
  capturedAt: string;
  /** The title as first escalated, if a later edit replaced it. */
  title?: string;
  /** The question body as first escalated, if a later edit replaced it. */
  question?: string;
  /** The options as first escalated, if a later edit replaced them. */
  options?: AskOption[];
  /** The context refs as first escalated, if a later edit replaced them. */
  contextRefs?: ContextRef[];
}

/**
 * Reserved metadata key carrying {@link AskOriginalContent}.
 *
 * Reserved in the same sense as {@link EDIT_HISTORY_METADATA_KEY}: a
 * caller-supplied value is ignored, because a mutable "original" is not an
 * original.
 */
export const ORIGINAL_CONTENT_METADATA_KEY = "originalContent";

/** The content fields whose pre-edit value is preserved. `metadata` is merged, so it is not one. */
const PRESERVED_CONTENT_FIELDS = ["title", "question", "options", "contextRefs"] as const;

/**
 * Metadata keys that are the SUBSTRATE's record, never a caller's input
 * (PR #3162 R1).
 *
 * Both are written exclusively by {@link editAskContent}. Accepting either from
 * a caller at create time would let a producer manufacture provenance it never
 * earned — a fabricated edit trail, or a planted "original" that pre-empts the
 * real capture on the first edit and destroys the text this whole mechanism
 * exists to keep.
 *
 * This is the same rule `principalPagedAt` already follows in `repository.ts`,
 * for the same reason stated there: *"Accepting it from a caller would let a
 * producer claim a page it never sent, which is exactly what the marker exists
 * to prevent (mt#3595)."* A reserved field defended only at the edit boundary is
 * not reserved — the create boundary is the other half.
 */
/**
 * Reserved metadata key carrying who cancelled an Ask and why (mt#3353).
 *
 * The `cancelled` terminal is reached through `repo.transition(id, "cancelled")`,
 * which writes `state` and `closedAt` and NOTHING ELSE — no responder, no
 * payload. So a cancelled Ask has historically carried no record of what retired
 * it: ask#5681 sits in `cancelled` with an intact edit history and no closure
 * record, and three independent channels (the suspended-only sweep's own state
 * filter, the `ask.policy_closed` event log, the elicitation transport) failed to
 * identify the actor. That is not an investigative gap; it is what the mechanism
 * records.
 *
 * Reserved rather than ordinary metadata for the same reason as the two keys
 * below it: `metadata` arrives from the MCP edit surface as untrusted input, and
 * an agent able to write this key could manufacture a cancellation record — or
 * forge a `system:` responder onto an Ask it answered itself, which is precisely
 * the provenance laundering mem#1122 documents.
 */
export const CANCELLATION_METADATA_KEY = "cancellation";

export const RESERVED_PROVENANCE_METADATA_KEYS = [
  EDIT_HISTORY_METADATA_KEY,
  ORIGINAL_CONTENT_METADATA_KEY,
  CANCELLATION_METADATA_KEY,
] as const;

/**
 * Return `metadata` without any {@link RESERVED_PROVENANCE_METADATA_KEYS} entry.
 *
 * Applied at CREATE by both repository backends. Deliberately separate from
 * {@link sanitizeMetadata}, which strips prototype-pollution vectors and runs on
 * both sides of the EDIT merge: these keys must survive that merge (they carry
 * the accumulated provenance) and must not survive a create.
 */
export function stripReservedProvenanceKeys(
  metadata: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if ((RESERVED_PROVENANCE_METADATA_KEYS as readonly string[]).includes(key)) continue;
    defineOwnKey(out, key, value);
  }
  return out;
}

/**
 * Assign `key` as a plain own data-property, never through a setter.
 *
 * `out[key] = value` looks inert and is not: for `key === "__proto__"` it invokes
 * the inherited prototype setter, so the assignment silently reparents `out`
 * instead of adding a key. This function does not filter anything — it makes the
 * COPY safe, so a filter's ordering stops being load-bearing (PR #3197 R1).
 *
 * Why it lives here rather than being solved by call-site ordering: the hazard
 * belongs to the copy, so every present and future caller inherits the fix, and
 * no caller has to know to sanitize first. Note the bug it prevents is invisible
 * to value-based assertions — a reparented object has no own `__proto__` key and
 * the same visible key set — so ordering could regress silently.
 */
function defineOwnKey(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

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
 * every {@link FORBIDDEN_METADATA_KEYS} entry is dropped.
 *
 * Applied at THREE points: both create paths (mt#4331) and both sides of the
 * edit merge (existing row metadata and caller-supplied metadata).
 *
 * The edit-side application is retained as genuine defense-in-depth even now
 * that create filters, because create-side filtering is **not retroactive**:
 * any row written before mt#4331 can still carry a forbidden key, and the edit
 * merge is where such a row gets scrubbed. Removing it would leave those rows
 * hostile indefinitely.
 *
 * Until mt#4331 this docblock read "a hostile key already persisted at create
 * time is scrubbed on the way through, not just blocked at the boundary" — a
 * sentence that named its own gap, since nothing was blocking at the create
 * boundary. It is now accurate rather than aspirational.
 */
export function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if ((FORBIDDEN_METADATA_KEYS as readonly string[]).includes(key)) continue;
    // Safe-copy here too, though this function's own filter means `__proto__`
    // never reaches it. That safety is a consequence of FORBIDDEN_METADATA_KEYS'
    // contents, so it would evaporate if that list were ever narrowed — the copy
    // should not depend on the filter to be correct.
    defineOwnKey(out, key, value);
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

  // mt#4329: preserve the pre-edit value of each content field the FIRST time
  // that field is replaced. Read from `existing`, so this captures what the Ask
  // actually carried — the text the principal saw — rather than anything the
  // caller supplies. Already-captured fields are never overwritten: that is what
  // makes it the ORIGINAL rather than the previous revision, and what bounds the
  // growth at one copy per field regardless of edit count.
  //
  // Only a PRIOR EDIT's capture is trusted (PR #3162 R1). `metadata` is
  // caller-supplied at CREATE time, so an Ask can be created already carrying an
  // `originalContent` key — and trusting that would let a caller pre-empt the
  // real capture and defeat the reservation this key is supposed to have, which
  // is the opposite of what it is for. `editHistory` is written ONLY by this
  // function, so a non-empty history is the evidence that a prior edit ran and
  // its capture is genuine; an empty one means this is the first edit and
  // anything under the key came in from outside.
  const priorOriginal =
    history.length > 0 ? existing.metadata[ORIGINAL_CONTENT_METADATA_KEY] : undefined;
  const captured: AskOriginalContent =
    typeof priorOriginal === "object" && priorOriginal !== null && !Array.isArray(priorOriginal)
      ? { ...(priorOriginal as AskOriginalContent) }
      : { capturedAt: note.editedAt };
  for (const field of PRESERVED_CONTENT_FIELDS) {
    if (params[field] === undefined) continue; // this edit does not replace it
    if (captured[field] !== undefined) continue; // already captured — keep the first
    // `as never` narrows the union write; each key's value type matches its
    // source on `Ask` by construction, and the loop cannot mix them.
    captured[field] = existing[field] as never;
  }

  // Written only when something was actually captured (PR #3162 R1). `metadata`
  // is itself an editable field, so a metadata-ONLY edit reaches here having
  // preserved nothing — and writing the key anyway would stamp a contentless
  // `{ capturedAt }` onto an Ask whose content was never touched, making it
  // indistinguishable from one that HAS a preserved original. An edit that does
  // capture nothing carries a prior capture forward unchanged via the spread.
  const capturedAnything = PRESERVED_CONTENT_FIELDS.some((f) => captured[f] !== undefined);

  const mergedMetadata: Record<string, unknown> = {
    // The EXISTING side keeps its reserved keys — that is how accumulated
    // provenance carries forward.
    ...sanitizeMetadata(existing.metadata),
    // The CALLER side never may (PR #3162 R2). Making the capture write
    // conditional in R1 opened this: on a metadata-only edit `capturedAnything`
    // is false, the conditional spread below contributes nothing, and a
    // caller-supplied `originalContent` would win the merge outright. Stripping
    // here makes the reservation hold on every path rather than only the ones
    // that happen to overwrite it afterwards.
    ...stripReservedProvenanceKeys(sanitizeMetadata(params.metadata ?? {})),
    [EDIT_HISTORY_METADATA_KEY]: [...history, note],
    // Set AFTER the caller spread, exactly like the history above — a
    // caller-supplied "original" is ignored, because a mutable original is not
    // one.
    ...(capturedAnything ? { [ORIGINAL_CONTENT_METADATA_KEY]: captured } : {}),
  };

  const write: EditAskFields = { metadata: mergedMetadata };
  if (params.title !== undefined) write.title = params.title;
  if (params.question !== undefined) write.question = params.question;
  if (params.options !== undefined) write.options = params.options;
  if (params.contextRefs !== undefined) write.contextRefs = params.contextRefs;

  const ask = await repo.updateContent(params.id, write);
  return { ask };
}
