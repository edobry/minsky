/**
 * AT1 for mt#4130 — a query-driven render throw names its error instead of going blank.
 *
 * The subject here is the HARNESS, not a cockpit widget: these assertions fail if
 * `tests/dom-setup.ts` stops capturing React's uncaught-render report, which is
 * the regression that would silently restore the mt#4069 defect class.
 *
 * ## Which throws are silent — measured, and narrower than the task assumed
 *
 * The spec said a render throw is silent "by construction". Building this file
 * falsified that as stated; the truth is more specific, and worth writing down
 * because the wrong version sends you looking in the wrong place:
 *
 *   - **Initial synchronous render** — NOT silent. `render()` runs it inside
 *     `act()` and @testing-library/react rethrows, so the test fails at the
 *     `render()` call with the real TypeError.
 *   - **A re-render driven by a bare `useEffect` + `setState`** — NOT silent.
 *     React rethrows from `commitRootImpl`, the error escapes to the scheduler
 *     task, and bun attributes it to the running test.
 *   - **A re-render driven by a QUERY state update, with a `waitFor` in flight**
 *     — SILENT. The raw TypeError never reaches the runner; `waitFor` reports
 *     its own timeout instead, and the container is empty. This is mt#4069's
 *     exact shape, and it is the case this mechanism exists for.
 *
 * So the fixture below uses a real `useQuery` and a real (stubbed) fetch. A
 * simpler fixture would pass without the mechanism installed and prove nothing —
 * the negative control in the PR body is what pins that.
 *
 * Each case CONSUMES the captured error via `takeCapturedReactRenderErrors()` —
 * the documented opt-out, and what keeps the harness's own `afterEach` from
 * failing a test whose whole purpose is to throw.
 *
 * Run via `bun run test:components`.
 */
import { describe, test, expect, afterEach, beforeEach, mock } from "bun:test";
import { render, cleanup, waitFor, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { takeCapturedReactRenderErrors } from "../../../../tests/react-render-error-capture";
import { ErrorBoundary } from "./ErrorBoundary";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Paired with the afterEach restore (PR #2987 R1): a test that dies before
  // teardown would otherwise leak this file's stub into whatever runs next, and
  // a leaked fetch is invisible where it lands rather than where it came from.
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  // Belt-and-braces: if an assertion below throws before its own take() runs,
  // clear the capture so the harness hook doesn't attribute it to the NEXT test.
  takeCapturedReactRenderErrors();
});

/**
 * Stands in for the real mt#4069 shape: a payload that arrives from a query
 * missing a field the component treats as required. Renders `Loading…` first,
 * throws when the data lands.
 */
function FamilyChipsLookalike({ omitFamilies }: { omitFamilies: boolean }) {
  const { data } = useQuery({
    queryKey: ["mt4130-fixture", omitFamilies],
    queryFn: async () => {
      const res = await fetch("/api/mt4130-fixture");
      return (await res.json()) as { entry: { families?: string[] } };
    },
  });

  if (!data) return <p>Loading…</p>;
  return <span data-testid="chips">{(data.entry.families as string[]).map((f) => f)}</span>;
}

function stubPayload(omitFamilies: boolean): void {
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify({ entry: omitFamilies ? {} : { families: ["guard"] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
  ) as unknown as typeof globalThis.fetch;
}

function renderFixture(omitFamilies: boolean): HTMLElement {
  stubPayload(omitFamilies);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <FamilyChipsLookalike omitFamilies={omitFamilies} />
    </QueryClientProvider>
  );
  return container;
}

/**
 * Reproduce mt#4069's ordering: a `waitFor` is in flight when the throw lands,
 * so the author sees ITS timeout rather than the TypeError. Swallowing that
 * timeout here is the point — it is the misleading symptom, not the finding.
 */
async function maskedByWaitFor(): Promise<void> {
  await waitFor(() => expect(screen.getByText("never-appears")).toBeDefined(), {
    timeout: 400,
  }).then(
    () => undefined,
    () => undefined
  );
}

describe("AT1 — a query-driven React render throw is visible, not silent", () => {
  test("the thrown error's message is captured", async () => {
    renderFixture(true);
    await maskedByWaitFor();

    const errors = takeCapturedReactRenderErrors();
    expect(errors.length).toBeGreaterThan(0);

    const message = errors.join("\n");
    // BOTH halves of Success Criterion 1, asserted separately because they come
    // from separate console.error calls and an earlier revision kept only the
    // second — naming the component while dropping the failure itself.
    expect(message).toContain("TypeError");
    expect(message).toContain("families");
    // React's report names the component that threw; without it a reader knows
    // something threw but not where.
    expect(message).toContain("FamilyChipsLookalike");
  });

  test("the container really is empty — the symptom the message explains", async () => {
    // Pins the premise the mechanism rests on: React 18 unmounts the ROOT on an
    // uncaught render error, which is why the pane goes blank rather than
    // rendering a partial tree.
    const container = renderFixture(true);
    await maskedByWaitFor();

    expect(container.innerHTML).toBe("");
    expect(takeCapturedReactRenderErrors().length).toBeGreaterThan(0);
  });

  test("a throw an ErrorBoundary catches is NOT flagged", async () => {
    // Designed degradation, not the defect: the boundary renders a named crash
    // instead of a blank pane — the pattern mt#4069 added to `PeekHost`. React
    // logs the same report either way, so only its tail distinguishes them; if
    // this test fails, the discriminator regressed and the mechanism has started
    // punishing correct error handling.
    stubPayload(true);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    render(
      <QueryClientProvider client={client}>
        <ErrorBoundary id="mt4130-fixture">
          <FamilyChipsLookalike omitFamilies />
        </ErrorBoundary>
      </QueryClientProvider>
    );
    await maskedByWaitFor();

    expect(takeCapturedReactRenderErrors()).toEqual([]);
  });

  test("a clean query-driven render captures nothing", async () => {
    // AT3's unit-level guard: the mechanism must not fire on healthy renders, or
    // it would fail the whole suite rather than surface one defect.
    const container = renderFixture(false);
    await waitFor(() => expect(container.querySelector("[data-testid='chips']")).not.toBeNull());

    expect(takeCapturedReactRenderErrors()).toEqual([]);
  });
});
