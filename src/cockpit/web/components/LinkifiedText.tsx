/**
 * LinkifiedText — inline entity linkification for single-line render sites
 * (mt#2518, moved here and given the shared affordances by mt#4630).
 *
 * This is mt#3165's "Shape 2" path: sites that render a truncated single line
 * (an ask option label or description, a memory list row's snippet) and cannot
 * use `<Prose>`, because `<Prose>` renders block Markdown and a `<p>` breaks the
 * row. mt#3165 diagnosed the avoidance as correct and the conclusion as too
 * strong — what these sites need is *inline-only linkification without Markdown
 * block rendering*, which is exactly this component.
 *
 * **Why it moved out of `lib/entity-linkifier.tsx` (mt#4630).** It renders
 * through `<EntityRef>` now, and `EntityRef` → `use-entity-index` →
 * `entity-linkifier` is a cycle. `lib/` holds the framework-agnostic tokenizer;
 * a React component that composes other React components belongs in
 * `components/`, next to `<Prose>` and `<JsonView>`, which already import from
 * `lib/` in that direction. The tokenizer's own `linkifyText` is untouched — it
 * still returns bare `<Link>` elements, which is the contract
 * `entity-linkifier.test.ts` exercises without rendering React.
 *
 * **What changed for the reader.** Before mt#4630 these sites produced a bare
 * anchor: linked, but with no hover card and no peek, while the SAME reference
 * one line above — inside the ask's question, rendered by `<Prose>` — carried
 * both. The affordance is now identical on both paths.
 *
 * **What deliberately did NOT change: line height.** `EntityRef`'s `appendLabel`
 * is NOT set here. These are dense, truncated rows, and mt#3165 states the
 * constraint plainly ("density is a feature"; the Shape-2 criterion is that each
 * site's single-line layout is *visually unchanged*). The resolved title reaches
 * a keyboard or screen-reader user through `EntityRef`'s `aria-label` instead
 * (mt#3187), which costs zero pixels — hover is additive, never the only path to
 * an identity (mt#3165 §"Hover is supplementary").
 */
import { Fragment } from "react";
import { tokenizeEntities, type EntityIndex } from "../lib/entity-linkifier";
import { EntityTokenLink } from "./EntityTokenLink";

/**
 * Render `text` with entity references converted to in-SPA references.
 *
 * Usage: replace `{element.text}` in a `<p>` with
 * `<LinkifiedText text={element.text} index={entityIndex} />`.
 */
export function LinkifiedText({
  text,
  index,
}: {
  text: string;
  index: EntityIndex;
}): React.ReactElement {
  return (
    <>
      {tokenizeEntities(text, index).map((token, i) =>
        token.kind === "text" ? (
          <Fragment key={`text-${i}`}>{token.value}</Fragment>
        ) : (
          <EntityTokenLink key={`link-${i}`} token={token} mono={token.mono} />
        )
      )}
    </>
  );
}
