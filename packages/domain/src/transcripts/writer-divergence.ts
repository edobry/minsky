/**
 * Writer-divergence detection over `last-prompt` sidecar records (mt#3656).
 *
 * ## What this detects, and why nothing else can
 *
 * Claude Code seeds its tip ONCE at resume and never re-reads the transcript
 * file; every subsequent `parentUuid` comes from that private in-memory field
 * (mem#805). So two processes resuming one conversation both append from their
 * own cached tip, forking the tree. Neither errors, neither warns, and a later
 * resume picks one leaf and orphans the other's whole branch.
 *
 * The tree alone cannot always tell that apart from a supersede-before-answer
 * (the operator sending a second prompt before the first is answered), because
 * a supersede leaves the abandoned branch with zero assistant descendants only
 * *usually* — a second writer interrupted before any reply produces the same
 * shape (the blind spot mt#3513 documents and accepts).
 *
 * The one signal the format offers is the `last-prompt` sidecar: each completed
 * turn appends `{"type":"last-prompt","leafUuid":"<uuid>"}` naming the writer's
 * own leaf. Two of those naming leaves on DIFFERENT branches means two writers
 * each believed they held the tip. That is independent of whether a reply
 * landed, so it discriminates the case the tree cannot.
 *
 * ## Why this runs at ingest and not at read time
 *
 * `last-prompt` rows never reach Minsky's durable store. `ingestSession`
 * retains only `user`/`assistant` lines (into `agent_transcripts.transcript`)
 * and `attachment`/`system` lines (into the attachments table) — and a
 * `last-prompt` row would be dropped before the type check anyway, because it
 * carries no `timestamp` and the incremental high-water-mark gate skips any
 * line without one. The signal exists only in the raw file, so detection has to
 * happen where the raw bytes are read, and only the verdict is persisted.
 *
 * A convenient consequence of that same missing timestamp: `last-prompt` rows
 * are never high-water-mark filtered, so every ingest pass sees the file's
 * COMPLETE set rather than an incremental slice — which is what a whole-file
 * property needs.
 *
 * @see mt#3656 — this module
 * @see mem#805 — the write model, verified by live race + binary read
 * @see ./rewind-detection.ts — the tree-side sibling signal (mt#3323/mt#3513)
 */

/** How deep a parent walk may go before we treat the chain as adversarial. */
const MAX_ANCESTOR_WALK = 100_000;

/**
 * A transcript's `parentUuid` edges: node uuid → its parent's uuid, or `null`
 * for a root. Membership in this map is what makes a node KNOWN — a leaf uuid
 * absent from it cannot be placed on any branch, and is reported separately
 * rather than guessed at.
 */
export type ParentByUuid = ReadonlyMap<string, string | null>;

export interface WriterDivergenceVerdict {
  /**
   * `last-prompt` leaves lying on mutually-exclusive branches — no one of them
   * is an ancestor of any other. Empty when the writers agreed. Two or more
   * entries is the divergence signature; the array never has exactly one.
   */
  divergentTips: string[];
  /**
   * Leaves named by a `last-prompt` record that do not appear in the tree at
   * all. Reported rather than dropped: an incomplete tree must not be allowed
   * to manufacture a divergence verdict (two unplaceable leaves are not
   * evidence of two branches), and it must not silently mask one either.
   */
  unresolvedLeaves: string[];
}

/**
 * Pull `last-prompt` leaf uuids out of a raw JSONL line stream, in file order,
 * de-duplicated.
 *
 * Order is preserved because the vendor's own fork-choice rule is "physically
 * last in the file wins" (mem#805) — a caller reporting WHICH branch would have
 * won needs the original order, not a sorted set.
 */
export function collectLastPromptLeaves(lines: Iterable<unknown>): string[] {
  const seen = new Set<string>();
  const leaves: string[] = [];
  for (const line of lines) {
    if (line === null || typeof line !== "object") continue;
    const row = line as Record<string, unknown>;
    if (row["type"] !== "last-prompt") continue;
    const leafUuid = row["leafUuid"];
    if (typeof leafUuid !== "string" || leafUuid.length === 0) continue;
    if (seen.has(leafUuid)) continue;
    seen.add(leafUuid);
    leaves.push(leafUuid);
  }
  return leaves;
}

/**
 * Build the `parentUuid` edge map from a raw JSONL line stream.
 *
 * Only rows carrying their own `uuid` become nodes — a row without one (an
 * attachment) can never be a parent, so it cannot participate in an
 * ancestor test.
 */
export function buildParentByUuid(lines: Iterable<unknown>): ParentByUuid {
  const parents = new Map<string, string | null>();
  for (const line of lines) {
    if (line === null || typeof line !== "object") continue;
    const row = line as Record<string, unknown>;
    const uuid = row["uuid"];
    if (typeof uuid !== "string" || uuid.length === 0) continue;
    const parentUuid = row["parentUuid"];
    parents.set(uuid, typeof parentUuid === "string" ? parentUuid : null);
  }
  return parents;
}

/**
 * Every ancestor of `uuid`, inclusive of `uuid` itself.
 *
 * Cycle-safe: a `visited` set plus a hard depth bound means a corrupted or
 * adversarial `parentUuid` cycle terminates instead of hanging the ingest.
 */
function ancestorsOf(uuid: string, parentByUuid: ParentByUuid): Set<string> {
  const chain = new Set<string>();
  let cursor: string | null | undefined = uuid;
  let steps = 0;
  while (typeof cursor === "string" && !chain.has(cursor) && steps < MAX_ANCESTOR_WALK) {
    chain.add(cursor);
    cursor = parentByUuid.get(cursor) ?? null;
    steps++;
  }
  return chain;
}

/**
 * Decide whether the `last-prompt` leaves disagree about which branch is live.
 *
 * A leaf is a TIP when no other leaf is its descendant. Tips are pairwise
 * incomparable by construction — if one were an ancestor of another it would
 * not be a tip — so two or more tips means two writers each extended a branch
 * the other never saw.
 *
 * Leaves absent from the tree are excluded from the comparison and returned as
 * `unresolvedLeaves`. This is deliberate: including them would let a truncated
 * or partially-ingested tree report a divergence purely from its own gaps,
 * which is the falsely-confident-derived-field failure this codebase already
 * refuses elsewhere (`presence.ts` returns `UNKNOWN` rather than guessing).
 */
export function detectWriterDivergence(
  leaves: readonly string[],
  parentByUuid: ParentByUuid
): WriterDivergenceVerdict {
  const known: string[] = [];
  const unresolvedLeaves: string[] = [];
  for (const leaf of leaves) {
    if (parentByUuid.has(leaf)) known.push(leaf);
    else unresolvedLeaves.push(leaf);
  }

  if (known.length < 2) return { divergentTips: [], unresolvedLeaves };

  const ancestry = new Map<string, Set<string>>();
  for (const leaf of known) ancestry.set(leaf, ancestorsOf(leaf, parentByUuid));

  const tips = known.filter(
    (leaf) =>
      !known.some((other) => other !== leaf && (ancestry.get(other) as Set<string>).has(leaf))
  );

  return { divergentTips: tips.length >= 2 ? tips : [], unresolvedLeaves };
}

/**
 * Single-pass accumulator for the ingest loop.
 *
 * Both inputs the verdict needs — the `last-prompt` leaves and the
 * `parentUuid` edges — must come from the SAME raw pass over the file, and
 * specifically NOT from the stored transcript. `agent_transcripts.transcript`
 * holds only `user`/`assistant` lines, while `attachment` rows carry their own
 * `uuid` and sit MID-CHAIN between them; a parent map built from stored rows
 * therefore has holes exactly where an attachment was, which truncates an
 * ancestor walk and can make two leaves on one branch look incomparable — a
 * fabricated divergence. Reading the raw stream avoids the hole entirely.
 *
 * Feed every line, including ones the caller's high-water-mark gate will skip
 * for storage: the verdict is a whole-file property, not an incremental one.
 */
export class WriterDivergenceScanner {
  private readonly leaves: string[] = [];
  private readonly seenLeaves = new Set<string>();
  private readonly parents = new Map<string, string | null>();

  observe(line: unknown): void {
    if (line === null || typeof line !== "object") return;
    const row = line as Record<string, unknown>;

    if (row["type"] === "last-prompt") {
      const leafUuid = row["leafUuid"];
      if (typeof leafUuid === "string" && leafUuid.length > 0 && !this.seenLeaves.has(leafUuid)) {
        this.seenLeaves.add(leafUuid);
        this.leaves.push(leafUuid);
      }
      return;
    }

    const uuid = row["uuid"];
    if (typeof uuid !== "string" || uuid.length === 0) return;
    const parentUuid = row["parentUuid"];
    this.parents.set(uuid, typeof parentUuid === "string" ? parentUuid : null);
  }

  verdict(): WriterDivergenceVerdict {
    return detectWriterDivergence(this.leaves, this.parents);
  }

  /** How many distinct `last-prompt` records were seen — for observability. */
  get leafCount(): number {
    return this.leaves.length;
  }
}
