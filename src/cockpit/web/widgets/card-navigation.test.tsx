/**
 * Home-page status-card navigability tests (mt#2246)
 *
 * Verifies that the purely-presentational System-status cards (CredentialsSummary,
 * EmbeddingsHealth) render as a whole-card navigation link to their destination
 * page, with a descriptive aria-label and NO nested anchor (valid HTML — the
 * LinkCard surface must not contain another interactive element).
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CredentialsSummary } from "./Credentials";
import { EmbeddingsHealth } from "./EmbeddingsHealth";

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function renderWidget(ui: React.ReactElement) {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

let originalFetch: typeof globalThis.fetch;

afterEach(() => {
  cleanup();
  if (originalFetch) globalThis.fetch = originalFetch;
});

function mockFetch(handler: (url: string) => unknown, status = 200) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock((url: string) =>
    Promise.resolve(
      new Response(JSON.stringify(handler(url)), {
        status,
        headers: { "Content-Type": "application/json" },
      })
    )
  ) as typeof globalThis.fetch;
}

/** Assert `container` holds exactly one whole-card anchor to `href` with the
 *  given aria-label and no nested interactive element. */
function expectWholeCardLink(container: HTMLElement, href: string, ariaLabel: string) {
  const anchor = container.querySelector(`a[href="${href}"]`);
  expect(anchor).not.toBeNull();
  expect(anchor?.getAttribute("aria-label")).toBe(ariaLabel);
  expect(anchor?.querySelectorAll("a, button, select").length).toBe(0);
}

describe("Home-page status card navigability (mt#2246)", () => {
  test("CredentialsSummary renders a whole-card link to /settings with aria-label and no nested anchor", async () => {
    mockFetch(() => ({
      credentials: [
        { provider: "github", displayName: "GitHub", configPath: "github.token", configured: true },
      ],
    }));

    const { container } = renderWidget(<CredentialsSummary />);

    await waitFor(() => {
      expect(screen.getByText(/configured/)).toBeDefined();
    });

    const anchor = container.querySelector('a[href="/settings"]');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("aria-label")).toBe("Manage credentials");
    // The whole card is the anchor — no interactive element nested inside it.
    expect(anchor?.querySelectorAll("a, button, select").length).toBe(0);
  });

  test("CredentialsSummary is a link even in the loading state", () => {
    // Never-resolving fetch keeps the widget in its loading state.
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() => new Promise(() => {})) as typeof globalThis.fetch;

    const { container } = renderWidget(<CredentialsSummary />);

    const anchor = container.querySelector('a[href="/settings"]');
    expect(anchor).not.toBeNull();
    expect(screen.getByText("Loading...")).toBeDefined();
  });

  test("EmbeddingsHealth renders a whole-card link to /embeddings with aria-label and no nested anchor", async () => {
    mockFetch(() => ({
      state: "ok",
      payload: {
        provider: "openai",
        status: "healthy",
        lastErrorAt: null,
        errorCountLastHour: 0,
        degradedReason: null,
        coverage: {
          tasks: { indexed: 5, total: 10 },
          memories: { indexed: 3, total: 4 },
        },
      },
    }));

    const { container } = renderWidget(<EmbeddingsHealth />);

    await waitFor(() => {
      expect(screen.getByText("Healthy")).toBeDefined();
    });

    expectWholeCardLink(container, "/embeddings", "View embedding infrastructure details");
  });

  test("CredentialsSummary error state is still a whole-card link to /settings", async () => {
    mockFetch(() => ({ error: { code: "internal", message: "boom" } }), 500);

    const { container } = renderWidget(<CredentialsSummary />);

    await waitFor(() => {
      expect(screen.getByText("Failed to load")).toBeDefined();
    });

    expectWholeCardLink(container, "/settings", "Manage credentials");
  });

  test("EmbeddingsHealth degraded state is still a whole-card link to /embeddings", async () => {
    mockFetch(() => ({ state: "degraded", reason: "embeddings provider unavailable" }));

    const { container } = renderWidget(<EmbeddingsHealth />);

    await waitFor(() => {
      expect(screen.getByText("embeddings provider unavailable")).toBeDefined();
    });

    expectWholeCardLink(container, "/embeddings", "View embedding infrastructure details");
  });

  test("EmbeddingsHealth exhausted status is still a whole-card link to /embeddings", async () => {
    mockFetch(() => ({
      state: "ok",
      payload: {
        provider: "openai",
        status: "exhausted",
        lastErrorAt: new Date().toISOString(),
        errorCountLastHour: 12,
        degradedReason: "quota exhausted",
        coverage: null,
      },
    }));

    const { container } = renderWidget(<EmbeddingsHealth />);

    await waitFor(() => {
      expect(screen.getByText("Exhausted")).toBeDefined();
    });

    expectWholeCardLink(container, "/embeddings", "View embedding infrastructure details");
  });
});
