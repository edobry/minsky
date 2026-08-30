/**
 * Machine-provenance tag namespaces (mt#4763, PR #3500 R1 non-blocking fix).
 *
 * Single source of truth for which `<namespace>:<value>` tag namespaces on a
 * memory record are machine-provenance metadata (how a record entered the
 * system, a dedup fingerprint) rather than operator-meaningful semantic
 * structure — `family:`, `theme:`, `tracking:`, etc. are NOT in this list
 * and render expanded by default.
 *
 * Before this module existed, the backend `memories-facets` widget
 * (`src/cockpit/widgets/memories-facets.ts`) and the cockpit frontend's
 * facet rail (`src/cockpit/web/pages/MemoriesPage.tsx`) each declared their
 * own copy of this exact list — the reviewer flagged the drift risk
 * (PR #3500 R1): if a new provenance namespace is added on one side and
 * not the other, the rail would start showing it as semantic structure (or
 * vice versa). `@minsky/shared` is the existing cross-boundary-safe home
 * for exactly this shape of constant — both cockpit-web (browser bundle)
 * and cockpit backend widgets already import from it (`logger`,
 * `changeset-id`), so this file adds no new dependency class to either
 * side.
 */
export const PROVENANCE_TAG_NAMESPACES = ["imported-from", "content-hash"] as const;

export type ProvenanceTagNamespace = (typeof PROVENANCE_TAG_NAMESPACES)[number];
