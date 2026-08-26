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
 * Falls back to a bare `<Link>` when the path names no routable entity. That is
 * defensive rather than expected — every `kind: "link"` token is built by
 * `entityToPath`, so the inverse resolves in practice — and it preserves the
 * failure-tolerance guarantee `EntityRef`'s module doc describes: a resolution
 * gap degrades to today's plain linked text, never to a dead span.
 *
 * `mono` defaults to TRUE, which is `JsonView`'s pre-existing behavior: it
 * rendered every token through `EntityRef`'s own mono default and did not
 * consult `token.mono`. Callers that DO care pass it explicitly — `LinkifiedText`
 * does, because prose distinguishes an id (mono) from a `minsky://` URI's label
 * (not mono), and it did so before this component existed.
 */
import { Link } from "react-router-dom";
import { cn } from "../lib/utils";
import { tokenEntity, type EntityToken } from "../lib/entity-linkifier";
import { EntityRef } from "./EntityRef";

export interface EntityTokenLinkProps {
  token: Extract<EntityToken, { kind: "link" }>;
  /** Render in the monospace face. Defaults to true — see the module doc. */
  mono?: boolean;
}

export function EntityTokenLink({ token, mono = true }: EntityTokenLinkProps) {
  const entity = tokenEntity(token);
  if (entity) {
    return (
      <EntityRef type={entity.type} id={entity.id} mono={mono}>
        {token.text}
      </EntityRef>
    );
  }
  return (
    <Link
      to={token.to}
      className={cn("text-primary underline-offset-2 hover:underline", mono && "font-mono")}
    >
      {token.text}
    </Link>
  );
}
