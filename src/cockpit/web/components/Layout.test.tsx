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
 * WHY THESE ASSERT CLASSES, NOT SCROLL GEOMETRY: jsdom has no layout engine —
 * every `clientHeight`/`scrollHeight` is 0 there, so the behavioral form of
 * this check ("scrollHeight > clientHeight at a sub-`md` viewport") cannot run
 * under `bun run test:components`. These tests pin the CSS invariant that
 * produces the behavior. The behavioral measurement was run in a real browser
 * (Playwright WebKit at 700x900 / 600x1097 / 400x800 against a served bundle)
 * and recorded in the PR; automating it needs a browser-layout test harness
 * this repo does not have yet — tracked in mt#3338. Class-name assertions are
 * an established convention in this suite (see CopyId.test.tsx).
 *
 * Network is stubbed (Rail/ProjectProvider fetch on mount) per the
 * save-mock-restore `globalThis.fetch` convention in ProjectSelector.test.tsx —
 * a component test must not depend on a live daemon.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, beforeEach, mock } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectProvider } from "../lib/project-context";
import { stubProjectsRoute } from "../lib/test-support/projects";
import { Layout } from "./Layout";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  // Benign 200 for every shell-mount query; no test here asserts fetched data.
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify({ projects: [], tasks: [], asks: [], count: 0 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  ) as unknown as typeof globalThis.fetch;
  stubProjectsRoute();
  try {
    localStorage.clear();
  } catch {
    /* jsdom always provides localStorage; ignore if not */
  }
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function renderLayout() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
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
    expect(workspaceColumn?.className).toContain("min-w-0");
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

// ---------------------------------------------------------------------------
// Codified sweep (mt#3335, PR #2405 R1).
//
// The one-off sweep that found `Layout.tsx` as the sole offender is only worth
// as much as its recurrence guard: a future `flex-1 flex-col` container added
// above a scroller reintroduces the same unreachable-content bug. This scans
// the cockpit web sources for that shape and requires each site to either
// carry `min-h-0`, be a scroll container itself (an `overflow-*` class makes
// its automatic minimum size 0 already), or be listed below with a reason.
//
// LIMITATION, stated honestly: this is a line-scoped textual scan, so a
// className split across multiple lines can evade it. It guards the common
// single-line Tailwind shape, not every possible spelling.
// ---------------------------------------------------------------------------

/** Sites that combine flex-1 + flex-col but are NOT scroll ancestors. */
const SWEEP_ALLOWLIST: Array<{ file: string; reason: string }> = [
  {
    file: "widgets/Credentials.tsx",
    reason:
      "Form-field group inside a ROW parent — `flex-1` is horizontal there, and it has no " +
      "scrolling descendant, so the column auto-min-size rule does not apply.",
  },
];

function collectTsxFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules") continue;
      collectTsxFiles(full, acc);
    } else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) {
      acc.push(full);
    }
  }
  return acc;
}

describe("cockpit shell column-flex sweep", () => {
  test("every flex-1 + flex-col container can shrink, scrolls itself, or is allowlisted", () => {
    const webRoot = join(process.cwd(), "src/cockpit/web");
    const offenders: string[] = [];

    for (const file of collectTsxFiles(webRoot)) {
      const relative = file.slice(webRoot.length + 1);
      const allowed = SWEEP_ALLOWLIST.some((entry) => entry.file === relative);
      if (allowed) continue;

      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("flex-1") || !line.includes("flex-col")) return;
        // Either it can shrink explicitly, or it is itself a scroll container
        // (which already gives it an automatic minimum size of 0).
        if (line.includes("min-h-0") || line.includes("overflow-")) return;
        offenders.push(`${relative}:${i + 1} — ${line.trim()}`);
      });
    }

    expect(offenders).toEqual([]);
  });

  test("the allowlist stays honest — every entry still matches the shape it excuses", () => {
    const webRoot = join(process.cwd(), "src/cockpit/web");
    for (const entry of SWEEP_ALLOWLIST) {
      const source = readFileSync(join(webRoot, entry.file), "utf8");
      const stillMatches = source
        .split("\n")
        .some((line) => line.includes("flex-1") && line.includes("flex-col"));
      // A stale allowlist entry silently shrinks the sweep's coverage.
      expect(stillMatches).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });
});
