/**
 * SessionFilmRedirect tests (mt#3461, SC 5 / SC 6 — AT 4).
 *
 * `/session-film` stopped being a page when the film became the conversation's
 * Film tab. These pin the compatibility contract that keeps already-published
 * links resolving: `?session=` becomes the path, `?t=` rides along, and a
 * param-less arrival lands somewhere useful instead of nowhere.
 *
 * The film BODY's own tests moved with the body — see
 * `components/session-film/SessionFilm.test.tsx`.
 *
 * Run via: bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts \
 *   src/cockpit/web/pages/SessionFilmPage.test.tsx
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionFilmRedirect, legacyFilmRedirectTarget } from "./SessionFilmPage";

const CONVERSATION_ID = "12345678-1234-1234-1234-123456789012";

afterEach(cleanup);

/** Renders the shim plus a stub at every route it can land on, and reports where it went. */
function renderRedirect(initialPath: string) {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/session-film" element={<SessionFilmRedirect />} />
        <Route path="/conversation/:id/film" element={<div data-testid="film-tab" />} />
        <Route path="/agents" element={<div data-testid="agents-list" />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("legacyFilmRedirectTarget (mt#3461 SC 5/6)", () => {
  test("maps ?session= to the conversation's film tab", () => {
    const params = new URLSearchParams({ session: CONVERSATION_ID });
    expect(legacyFilmRedirectTarget(params)).toBe(`/conversation/${CONVERSATION_ID}/film`);
  });

  test("carries ?t= through, so a published playhead link still lands on its moment", () => {
    const params = new URLSearchParams({ session: CONVERSATION_ID, t: "4" });
    expect(legacyFilmRedirectTarget(params)).toBe(`/conversation/${CONVERSATION_ID}/film?t=4`);
  });

  test("falls back to the conversation list when there is no session to redirect to", () => {
    expect(legacyFilmRedirectTarget(new URLSearchParams())).toBe("/agents");
  });

  test("percent-encodes an id containing URL metacharacters", () => {
    const params = new URLSearchParams({ session: "a/b?c" });
    expect(legacyFilmRedirectTarget(params)).toBe("/conversation/a%2Fb%3Fc/film");
  });
});

describe("SessionFilmRedirect — rendered navigation", () => {
  test("a legacy deep link lands on the film tab, not a 404", () => {
    renderRedirect(`/session-film?session=${CONVERSATION_ID}&t=4`);
    expect(screen.getByTestId("film-tab")).toBeDefined();
  });

  test("a bare /session-film lands on the conversation list", () => {
    renderRedirect("/session-film");
    expect(screen.getByTestId("agents-list")).toBeDefined();
  });
});
