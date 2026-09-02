/**
 * Shared `/api/projects` stub for cockpit component tests (mt#4842).
 *
 * ## Why this exists
 *
 * `ProjectProvider` fires its own query on mount (`project-context.tsx:175` →
 * `fetchProjects` at `:44`). Component tests stub `globalThis.fetch` with a
 * path-matching mock that answers the ONE endpoint under test and falls through
 * to a 404 (or a "not mocked" body) for everything else. `/api/projects` lands
 * in "everything else", so `res.ok` is false, the query throws, and the whole
 * tree renders with project context in an ERROR state — `projects` undefined,
 * `projectList` `[]`, and `shouldShowProjectIndicator` evaluated against an
 * empty list on every run.
 *
 * Nothing about that is visible: TanStack stores the error, the component
 * renders its empty-list branch, and assertions written against that branch
 * pass. There is no red and no warning.
 *
 * ## Why an installer rather than a route branch
 *
 * The nineteen affected files do not share a stub shape. Their handlers are
 * variously `(url: unknown)`, `(url: string)`, `(input: RequestInfo | URL)` —
 * and four of them install `mock(() => …)`, which takes no argument at all and
 * answers every URL with one response. There is no per-handler edit that is
 * uniform across those, and rewriting four handler signatures to add a branch
 * would change what those tests assert.
 *
 * `stubProjectsRoute()` decorates whatever stub is already installed, so it
 * composes with all four shapes without touching any of them. Call it AFTER the
 * test installs its own `fetch`.
 */
import type { ProjectSummary } from "../project-context";

/**
 * Default payload: TWO projects, deliberately.
 *
 * `shouldShowProjectIndicator` only takes its true branch with 2+ known
 * projects (see `widgets/Agents.projectbadge.test.tsx`'s header), so a
 * single-project default would leave the badge path as untested as the empty
 * list it replaces — the criterion this fixture exists to satisfy.
 *
 * One entry carries a `displayName` and one carries `null`, matching the
 * existing hand-rolled fixtures in `pages/AsksPage.projectbadge.test.tsx` and
 * `widgets/Agents.projectbadge.test.tsx` so the shared default does not
 * introduce a third convention.
 *
 * Annotated `ProjectSummary[]` on purpose: mem#1030 records a cockpit test
 * fixture that drifted from the type its component consumed and threw during
 * render, because the stub helper took its bodies as `unknown` and nothing ever
 * checked them. The annotation moves that class to typecheck time.
 */
export const MINSKY_PROJECT: ProjectSummary = {
  id: "3ac3d147-0000-0000-0000-000000000001",
  slug: "edobry/minsky",
  displayName: "Minsky",
};

export const PEEZOMBIE_PROJECT: ProjectSummary = {
  id: "3ac3d147-0000-0000-0000-000000000002",
  slug: "edobry/peezombie.me",
  displayName: null,
};

/**
 * Named separately above rather than indexed out of this array: the cockpit
 * tsconfig sets `noUncheckedIndexedAccess`, so `TEST_PROJECTS[0]` is
 * `ProjectSummary | undefined` and every consumer would carry a `!`.
 */
export const TEST_PROJECTS: ProjectSummary[] = [MINSKY_PROJECT, PEEZOMBIE_PROJECT];

/** True when `url` addresses the projects endpoint the provider fetches. */
export function isProjectsRequest(url: string): boolean {
  return url.includes("/api/projects");
}

/**
 * The 200 body `fetchProjects` expects — an object with a `projects` key, not a
 * bare array (`project-context.tsx:39-50` reads `body.projects`).
 */
export function projectsStubResponse(projects: ProjectSummary[] = TEST_PROJECTS): Response {
  return new Response(JSON.stringify({ projects }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Decorate the currently-installed `globalThis.fetch` so `/api/projects`
 * resolves, delegating everything else to it unchanged.
 *
 * Call AFTER the test installs its own stub:
 *
 * ```ts
 * globalThis.fetch = mock(async (url: string) => { ... });
 * stubProjectsRoute();
 * ```
 *
 * The caller's own `afterEach` restore is unaffected — this wraps the current
 * value rather than replacing the saved original.
 */
export function stubProjectsRoute(projects: ProjectSummary[] = TEST_PROJECTS): void {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isProjectsRequest(String(input))) {
      return projectsStubResponse(projects);
    }
    return inner(input, init);
  }) as typeof globalThis.fetch;
}
