/**
 * Which entity kinds have a discussion thread (mt#3364, widened by mt#3366).
 *
 * ## Why this is ONE declaration
 *
 * Three places need to agree on this set: the server's request validation
 * (`parseEntityType` in `src/cockpit/routes/entity-threads.ts`), the seed-adapter
 * dispatch beside it, and the browser panel's prop type
 * (`src/cockpit/web/widgets/EntityThreadPanel.tsx`). PR #2467 R1 found the cost
 * of splitting them: a runtime `Set` on the server and a hand-written union in
 * the panel drift silently, and widening the set meant editing the panel too —
 * which violated this task's own success criterion that adding an entity type
 * requires no panel change.
 *
 * Derive both the type and the runtime check from the array below, and adding a
 * kind is a ONE-LINE edit here. The panel, its prop type, and the validator all
 * follow automatically.
 *
 * ## Adding a kind is still not free
 *
 * Widening this array is necessary but NOT sufficient: `buildSeedForEntity` must
 * also grow an adapter for the new kind. Without one, every request for it 404s,
 * which reads to a caller as "your id is wrong" rather than "this is not built
 * yet". Add the adapter in the same change.
 *
 * ## Browser-safe by construction
 *
 * Imports nothing. It is loaded into the browser bundle, and the persistence-layer
 * type it mirrors (`EntityThreadEntityType` in
 * `packages/domain/src/transcripts/entity-thread-store.ts`) cannot be imported here
 * or there — that module pulls in Drizzle. The route asserts the two stay
 * compatible at compile time; see `assertSupportedTypesArePersistable` there.
 *
 * @see mt#3366 — the widening that motivated a single declaration
 */

/**
 * The entity kinds a thread can be opened on, in the order they are reported to
 * a caller. Order is deliberate and load-bearing for the error message's
 * stability (PR #2467 R1 non-blocking) — a `Set`'s iteration order is its
 * insertion order, but nothing was pinning that; this array is.
 */
export const ENTITY_THREAD_SUPPORTED_TYPES = ["ask", "task"] as const;

/** The union of supported kinds, derived — never hand-written. */
export type EntityThreadSupportedType = (typeof ENTITY_THREAD_SUPPORTED_TYPES)[number];

/** Human-readable list for an error message, in the declared order. */
export function formatSupportedEntityTypes(): string {
  return ENTITY_THREAD_SUPPORTED_TYPES.join(", ");
}

/** Runtime narrowing for an untrusted path segment. */
export function isEntityThreadSupportedType(value: unknown): value is EntityThreadSupportedType {
  return (
    typeof value === "string" &&
    (ENTITY_THREAD_SUPPORTED_TYPES as readonly string[]).includes(value)
  );
}
