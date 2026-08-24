/**
 * The ADR-012 association vocabulary, as a CLOSED set enforced in code.
 *
 * ## Why this module exists
 *
 * ADR-012 §Convention defines eight association type strings and states that the convention
 * is "documented in this ADR and **enforced by code review, not by schema constraints**."
 *
 * That enforcement was measured on 2026-08-24 (mt#4448) against the live corpus and had a
 * **0% success rate**: of 28 memories carrying a non-empty `associations` map, **26 used keys
 * no ADR defines** — `tasks` (25), `memories` (10), `prs` (8), `changesets` (2), `docs` (1),
 * and a singular `task` (1). Only 2 carried `tracksTask`. No code wrote any of them: the
 * column's Zod schema is `z.record(z.string(), z.array(z.string()))`, so every key was
 * invented at a `memory_create` call site by an agent who had not read the ADR.
 *
 * The failure is not that agents were careless. A `Record<string, string[]>` with no
 * constraint has no way to say "that is not a key", so the first plausible-looking spelling
 * wins and nothing ever contradicts it. Code review cannot hold a vocabulary that the type
 * system does not — which is what the 26 records measure.
 *
 * ## What is enforced, and what deliberately is not
 *
 * KEYS are closed: an unknown key is REJECTED, with the nearest valid alternative named.
 * VALUES are checked for ID SHAPE only (ADR-012 §ID normalization), because a wrong-shaped
 * id silently fails containment queries — `prs: ["3200"]` can never match a query for
 * `PR#3200`, and the caller sees an empty result rather than an error.
 *
 * Not enforced: whether the association is TRUE. Whether this memory really does retire when
 * mt#X ships is not decidable here, and pretending otherwise would be the mistake this module
 * exists to correct one level up.
 *
 * ## No `force` escape
 *
 * `memory_create`'s existing `force` flag bypasses `checkDerivation` (mt#960) and does NOT
 * bypass this check. That asymmetry is deliberate. Derivation discipline is a judgment call
 * about content, so a human override is appropriate; the vocabulary is a fixed set, and an
 * override would restore exactly the "agent picks a spelling" condition the 26 records
 * document. Adding a type means editing `ASSOCIATION_TYPES` below and amending ADR-012 §Convention
 * — a code change with a review, which is the discipline ADR-012 intended and could not enforce.
 *
 * @see docs/architecture/adr-012-memory-entity-associations.md §Convention
 * @see mt#4448 — the census that measured the divergence, and this enforcement
 * @see ./validation.ts — the sibling content-side validator at the same write seam
 */

/** The entity kind an association's values point at. Drives the id-shape check. */
export type AssociationTargetKind =
  | "task"
  | "rule"
  | "skill"
  | "ask"
  | "session"
  | "transcript"
  | "pr";

export interface AssociationTypeSpec {
  /** What the association asserts, in ADR-012's own words. */
  readonly semantics: string;
  readonly targetKind: AssociationTargetKind;
}

/**
 * The closed vocabulary. Keys are exactly ADR-012 §Convention's table, in its order.
 *
 * Adding an entry here is the ONLY way to add an association type, and it must be paired with
 * an ADR-012 amendment — see the module docblock.
 */
export const ASSOCIATION_TYPES = {
  tracksTask: {
    semantics: "This memory is a bridge that retires when the named task ships",
    targetKind: "task",
  },
  relatedTask: {
    semantics: "This memory is related to (but not bridged on) the named task",
    targetKind: "task",
  },
  originatesRule: {
    semantics: "This memory originated the named rule file",
    targetKind: "rule",
  },
  originatesSkill: {
    semantics: "This memory originated the named skill",
    targetKind: "skill",
  },
  informsAsk: {
    semantics: "This memory was cited as evidence for the named ask",
    targetKind: "ask",
  },
  extractedFromSession: {
    semantics: "This memory was extracted from the named session",
    targetKind: "session",
  },
  extractedFromTranscript: {
    semantics: "This memory was extracted from a specific transcript turn",
    targetKind: "transcript",
  },
  citedInReview: {
    semantics: "This memory was cited in a PR review",
    targetKind: "pr",
  },
} as const satisfies Record<string, AssociationTypeSpec>;

export type AssociationType = keyof typeof ASSOCIATION_TYPES;

/** The association key ADR-012 assigns to memory -> tracking-task links. */
export const TRACKS_TASK_ASSOCIATION: AssociationType = "tracksTask";

export const ASSOCIATION_TYPE_NAMES = Object.keys(ASSOCIATION_TYPES) as AssociationType[];

export function isKnownAssociationType(key: string): key is AssociationType {
  return Object.hasOwn(ASSOCIATION_TYPES, key);
}

/**
 * Keys observed in the live corpus that are NOT vocabulary, mapped to what the author most
 * likely meant. Drives the actionable half of the rejection message.
 *
 * `tasks`/`task` map to `relatedTask` rather than `tracksTask` on purpose: the entity-keyed
 * form records only THAT a task is linked, never that this memory retires when it ships, so
 * upgrading it to `tracksTask` would assert a relationship the author never expressed. The
 * suggestion is the weaker, truthful one; a caller who does mean the retirement link can say so.
 */
const LIKELY_INTENT: Readonly<Record<string, AssociationType>> = {
  tasks: "relatedTask",
  task: "relatedTask",
  relatedTasks: "relatedTask",
  tracksTasks: "tracksTask",
  memories: "relatedTask",
  prs: "citedInReview",
  pullRequests: "citedInReview",
  changesets: "citedInReview",
  rules: "originatesRule",
  skills: "originatesSkill",
  asks: "informsAsk",
  sessions: "extractedFromSession",
};

/**
 * ID shapes, per ADR-012 §ID normalization.
 *
 * `docs` has no entry anywhere because ADR-012 defines no memory->doc association; a doc path
 * belongs in the memory's body text. That absence is load-bearing rather than an oversight —
 * see `LIKELY_INTENT`, which deliberately omits it too, so a caller passing `docs` is told the
 * relationship has no key rather than being pointed at a near-miss.
 */
const ID_SHAPES: Readonly<Record<AssociationTargetKind, { re: RegExp; expected: string }>> = {
  task: {
    re: /^(?:mt|md|gh)#\d+$/,
    expected: "mt#NNNN (the prefix is required, not a bare number)",
  },
  pr: { re: /^PR#\d+$/, expected: "PR#NNNN (the PR# prefix distinguishes it from a task id)" },
  rule: {
    re: /^[\w.-]+\.mdc$/,
    expected: "a rule filename with its extension, e.g. hook-files.mdc",
  },
  skill: { re: /^[a-z0-9-]+$/, expected: "the skill name as invoked, e.g. retrospective" },
  ask: {
    re: /^(?:ask#\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
    expected: "ask#N or the ask uuid",
  },
  session: {
    re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    expected: "the full session uuid",
  },
  transcript: { re: /^\S+:turn-\d+$/, expected: "<sessionId>:turn-N" },
};

/**
 * Which write seam is being validated.
 *
 * The two differ in exactly one respect: on `update`, an empty value array is a REMOVAL
 * rather than a write, so it is exempt from the key check. See `validateAssociations`.
 */
export type AssociationWriteMode = "create" | "update";

export interface AssociationIssue {
  /** `unknown-key` — the key is not vocabulary. `malformed-id` — the key is fine, a value is not. */
  kind: "unknown-key" | "malformed-id";
  key: string;
  /** Present only for `malformed-id`. */
  value?: string;
  message: string;
}

function unknownKeyMessage(key: string): string {
  const suggestion = LIKELY_INTENT[key];
  const head = `"${key}" is not an ADR-012 association type.`;
  const fix = suggestion
    ? ` Did you mean "${suggestion}" (${ASSOCIATION_TYPES[suggestion].semantics.toLowerCase()})?`
    : "";
  return (
    `${head}${fix} Valid types: ${ASSOCIATION_TYPE_NAMES.join(", ")}. ` +
    "The vocabulary is closed and is not bypassable with force — adding a type means editing " +
    "ASSOCIATION_TYPES and amending ADR-012 §Convention. See mt#4448 for why."
  );
}

/**
 * Validate an associations map against the closed vocabulary and ADR-012's id shapes.
 *
 * Returns EVERY issue found, not the first — a caller passing three invented keys should learn
 * about three, not discover them one rejected write at a time.
 *
 * An empty or absent map is valid: most memories legitimately carry no associations (1198 of
 * 1226 at the time of the mt#4448 census).
 */
export function validateAssociations(
  associations: Record<string, string[]> | null | undefined,
  mode: AssociationWriteMode = "create"
): AssociationIssue[] {
  if (associations === null || associations === undefined) return [];

  const issues: AssociationIssue[] = [];

  for (const [key, values] of Object.entries(associations)) {
    // On UPDATE, an empty array REMOVES the key (`memory.update`'s documented merge
    // semantics; `MemoryService.update` turns it into a jsonb `- key`). Removing an
    // out-of-vocabulary key must stay legal, or the vocabulary becomes unenforceable in
    // exactly the direction that matters: the 26 divergent records could never be cleaned
    // up through the supported write path, and mt#4448's own migration would need raw SQL.
    // A NON-EMPTY value under an unknown key is still a write of invented vocabulary.
    if (mode === "update" && (values?.length ?? 0) === 0) {
      continue;
    }

    if (!isKnownAssociationType(key)) {
      issues.push({ kind: "unknown-key", key, message: unknownKeyMessage(key) });
      // Do not shape-check values under a key whose target kind is unknown — the id shape is
      // a property of what the key POINTS AT, and an unknown key points at nothing.
      continue;
    }

    const shape = ID_SHAPES[ASSOCIATION_TYPES[key].targetKind];
    for (const value of values ?? []) {
      if (!shape.re.test(value)) {
        issues.push({
          kind: "malformed-id",
          key,
          value,
          message:
            `"${value}" is not a valid ${ASSOCIATION_TYPES[key].targetKind} id for "${key}". ` +
            `Expected ${shape.expected}. A wrong-shaped id never matches a containment query, ` +
            "so it fails silently as an empty result rather than as an error.",
        });
      }
    }
  }

  return issues;
}

/** One-line summary suitable for a thrown error, or `null` when the map is clean. */
export function summarizeAssociationIssues(issues: AssociationIssue[]): string | null {
  if (issues.length === 0) return null;
  return issues.map((i) => i.message).join("\n");
}
