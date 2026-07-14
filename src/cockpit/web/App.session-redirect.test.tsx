/**
 * Legacy `/session/:id` → `/conversation/:id` redirect tests (mt#2769).
 *
 * `/session/:id` was the pre-mt#2686 route path; the route registration
 * itself is gone (App.tsx only registers `/conversation/:id` now), but old
 * deep links and localStorage-persisted tabs still carry the old path.
 * `SessionIdRedirect` covers the fresh-navigation case (a bookmarked or
 * externally-shared `/session/:id` URL); `lib/tabs.tsx`'s
 * `migrateLegacySessionPath` (see `lib/tabs.test.tsx`) covers the persisted-tab
 * rewrite. This file isolates the redirect component from App.tsx's full
 * lazy-loaded route tree (which pulls in every page component).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import { SessionIdRedirect } from "./App";

afterEach(() => {
  cleanup();
});

/** Renders the current pathname so the redirect's target is observable. */
function LocationProbe() {
  const { pathname } = useLocation();
  return <div data-testid="pathname">{pathname}</div>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/session/:id" element={<SessionIdRedirect />} />
        <Route path="/conversation/:id" element={<LocationProbe />} />
        <Route path="/agents" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

describe("SessionIdRedirect (mt#2769)", () => {
  test("redirects /session/:id to /conversation/:id, preserving the id", async () => {
    const { getByTestId } = renderAt("/session/4d44d12b-58f0-433e-95b3-8b914693fa39");

    await waitFor(() => {
      expect(getByTestId("pathname").textContent).toBe(
        "/conversation/4d44d12b-58f0-433e-95b3-8b914693fa39"
      );
    });
  });

  test("re-encodes an id containing characters requiring percent-encoding", async () => {
    // useParams decodes the URL segment; the redirect must re-encode it so the
    // resulting /conversation/:id path is well-formed (mirrors entityToPath's encoding).
    const { getByTestId } = renderAt("/session/foo%20bar");

    await waitFor(() => {
      expect(getByTestId("pathname").textContent).toBe("/conversation/foo%20bar");
    });
  });

  test("falls back to /agents when no id is present (mt#2767 — /conversations retired)", async () => {
    const { getByTestId } = render(
      <MemoryRouter initialEntries={["/session/"]}>
        <Routes>
          <Route path="/session/*" element={<SessionIdRedirect />} />
          <Route path="/agents" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(getByTestId("pathname").textContent).toBe("/agents");
    });
  });
});
