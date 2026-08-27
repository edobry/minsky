/**
 * EntityTokenLink — render one resolved entity token from `tokenizeEntities`
 * as a reference with the shared affordances (mt#4630).
 *
 * Extracted from `JsonView.tsx`, where this was a local `TokenLink` (mt#3175).
 * It is here because `LinkifiedText` needs the identical branch: a token's `to`
 * path is inverted back to `(type, id)` via the ONE shared inverse
 * (`tokenEntity`), and the reference renders through `<EntityRef>` so it carries
 * the hover card and the click-to-peek gesture. Two call sites hand-rolling that
 * branch is how the two prose paths drifted apart in the first place.
 *
 * The `<Link>` fallback is defensive rather than expected — every `kind: "link"`
 * token is built by `entityToPath`, so the inverse resolves in practice — and it
 * preserves the failure-tolerance guarantee `EntityRef`'s module doc describes:
 * a resolution gap degrades to plain linked text, never to a dead span.
 *
 * ## `mono` is optional, and omitting it is NOT the same as passing `true`
 *
 * The two branches did not agree on typography before this component existed,
 * and the seam has to preserve that rather than tidy it away (PR #3375 R1 —
 * an earlier draft defaulted the prop to `true`, which silently made the
 * fallback branch always monospace):
 *
 * | branch | `JsonView`'s prior behavior |
 * | --- | --- |
 * | resolved → `<EntityRef>` | always mono — it passed no `mono`, taking `EntityRef`'s own default, and never consulted `token.mono` |
 * | unresolved → `<Link>` | mono IFF `token.mono` |
 *
 * So `mono` left UNDEFINED reproduces exactly that split: the entity branch
 * falls through to `EntityRef`'s default, the fallback honors `token.mono`.
 * Passing it EXPLICITLY overrides both branches together, which is what
 * `LinkifiedText` does with `token.mono` — prose distinguishes an id (mono) from
 * a `minsky://` link's label (not mono) on both branches alike, and did so
 * before this component existed.
 */
import { Link } from "react-router-dom";
import { cn } from "../lib/utils";
import { tokenEntity, type EntityToken } from "../lib/entity-linkifier";
import { EntityRef } from "./EntityRef";

export interface EntityTokenLinkProps {
  token: Extract<EntityToken, { kind: "link" }>;
  /**
   * Force the monospace face on BOTH branches. Omit to keep each branch's own
   * prior default — see the table in the module doc; omitting is not `true`.
   */
  mono?: boolean;
}

export function EntityTokenLink({ token, mono }: EntityTokenLinkProps) {
  const entity = tokenEntity(token);
  if (entity) {
    // `mono` undefined falls through to EntityRef's own `mono = true` default,
    // which is what this branch has always rendered.
    return (
      <EntityRef type={entity.type} id={entity.id} mono={mono}>
        {token.text}
      </EntityRef>
    );
  }
  return (
    <Link
      to={token.to}
      className={cn(
        "text-primary underline-offset-2 hover:underline",
        (mono ?? token.mono) && "font-mono"
      )}
    >
      {token.text}
    </Link>
  );
}
