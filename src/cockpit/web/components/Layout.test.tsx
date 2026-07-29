/**
 * Layout shell tests (mt#3335).
 *
 * Pins the shell's scroll invariant: the workspace column between the root and
 * <main> MUST carry `min-h-0`. Below `md` the root is `flex-col`, which makes
 * that column a COLUMN-flex item whose automatic minimum size is its content
 * height — without `min-h-0` it cannot shrink, <main> is handed full content
 * height instead of the leftover space, never becomes a scroller, and the
 * root's `overflow-hidden` strands everything below the fold. Narrow windows
 * could not scroll at all.
 *
 * WHY THIS ASSERTS CLASSES, NOT SCROLL GEOMETRY: jsdom has no layout engine —
 * every `clientHeight`/`scrollHeight` is 0 there, so the behavioral form of
 * this check ("scrollHeight > clientHeight at a sub-`md` viewport") cannot run
 * under `bun run test:components`. This test pins the CSS invariant that
 * produces the behavior; the behavioral measurement is a real-browser check
 * (Playwright WebKit/Chromium at 700x900 against a served bundle) recorded in
 * the PR body. Class-name assertions are an established convention in this
 * suite (see CopyId.test.tsx).
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectProvider } from "../lib/project-context";
import { Layout } from "./Layout";

afterEach(cleanup);

function renderLayout() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/"]}>
        <ProjectProvider>
          <Layout>
            <div data-testid="page-content">content</div>
          </Layout>
        </ProjectProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("Layout shell scroll invariant", () => {
  test("the workspace column can shrink below its content height (min-h-0)", () => {
    renderLayout();
    const main = screen.getByRole("main");
    const workspaceColumn = main.parentElement;

    expect(workspaceColumn).not.toBeNull();
    // The load-bearing bit: without this the column's auto minimum size is its
    // content height in the sub-`md` column branch, so <main> never scrolls.
    expect(workspaceColumn?.className).toContain("min-h-0");
    // Guard the rest of the shape the invariant depends on.
    expect(workspaceColumn?.className).toContain("flex-col");
    expect(workspaceColumn?.className).toContain("flex-1");
  });

  test("main is the scroll container and can shrink", () => {
    renderLayout();
    const main = screen.getByRole("main");

    expect(main.className).toContain("overflow-auto");
    expect(main.className).toContain("flex-1");
  });

  test("the root clips overflow, which is what makes the column's min-h-0 load-bearing", () => {
    renderLayout();
    const root = screen.getByRole("main").parentElement?.parentElement;

    expect(root).not.toBeNull();
    expect(root?.className).toContain("overflow-hidden");
    expect(root?.className).toContain("h-screen");
    // Column below `md`, row at `md`+ — the branch that makes this a bug only
    // at narrow widths.
    expect(root?.className).toContain("flex-col");
    expect(root?.className).toContain("md:flex-row");
  });

  test("children render inside main", () => {
    renderLayout();
    expect(screen.getByTestId("page-content").closest("main")).not.toBeNull();
  });
});
