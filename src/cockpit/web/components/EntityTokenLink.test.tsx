/**
 * EntityTokenLink — the two branches keep their own typography (mt#4630).
 *
 * These pin PR #3375 R1. Extracting `JsonView`'s local `TokenLink` looked like a
 * pure move, and the first draft gave the new `mono` prop a `true` default on
 * the reasoning that "JsonView never consulted `token.mono`". That was true of
 * the RESOLVED branch and false of the FALLBACK branch, which had always used
 * `token.mono` — so the default silently forced monospace on every unresolved
 * token. Nothing failed: the fallback is defensive, every token `tokenizeEntities`
 * produces resolves in practice, and no existing test rendered an unresolvable
 * one. A reviewer read the diff and caught it.
 *
 * Hence a token built BY HAND rather than through `tokenizeEntities`: the whole
 * point is a `to` path the inverse cannot resolve, which the tokenizer cannot
 * produce (`/activity` names no entity — the same path `Prose.peek.test.tsx`
 * uses for its no-entity case).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, cleanup, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EntityTokenLink } from "./EntityTokenLink";
import type { EntityToken } from "../lib/entity-linkifier";

afterEach(cleanup);

type LinkToken = Extract<EntityToken, { kind: "link" }>;

/** A link token whose path names no routable entity — takes the fallback. */
function unresolvableToken(mono: boolean): LinkToken {
  return { kind: "link", text: "see the activity feed", to: "/activity", mono };
}

/** A link token whose path DOES resolve — takes the EntityRef branch. */
function resolvableToken(mono: boolean): LinkToken {
  return { kind: "link", text: "mt#2370", to: "/tasks/mt%232370", mono };
}

function renderToken(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

function theLink(): HTMLElement {
  return screen.getAllByRole("link")[0]!;
}

describe("EntityTokenLink — fallback branch honors token.mono (PR #3375 R1)", () => {
  test("mono omitted + token.mono false: NOT monospace", () => {
    renderToken(<EntityTokenLink token={unresolvableToken(false)} />);
    expect(theLink().className).not.toContain("font-mono");
  });

  test("mono omitted + token.mono true: monospace", () => {
    renderToken(<EntityTokenLink token={unresolvableToken(true)} />);
    expect(theLink().className).toContain("font-mono");
  });

  test("an explicit mono overrides the token, in both directions", () => {
    const { unmount } = renderToken(
      <EntityTokenLink token={unresolvableToken(true)} mono={false} />
    );
    expect(theLink().className).not.toContain("font-mono");
    unmount();

    renderToken(<EntityTokenLink token={unresolvableToken(false)} mono />);
    expect(theLink().className).toContain("font-mono");
  });
});

describe("EntityTokenLink — resolved branch keeps EntityRef's own default", () => {
  test("mono omitted + token.mono false: still monospace, as JsonView always rendered it", () => {
    // The asymmetry with the fallback above is deliberate and pre-existing —
    // this branch never read token.mono. Preserving it is the whole reason
    // `mono` is optional rather than defaulted.
    renderToken(<EntityTokenLink token={resolvableToken(false)} />);
    expect(theLink().className).toContain("font-mono");
  });

  test("an explicit mono={false} reaches the resolved branch too", () => {
    renderToken(<EntityTokenLink token={resolvableToken(false)} mono={false} />);
    expect(theLink().className).not.toContain("font-mono");
  });
});
