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

function mockFetch(handler: (url: string) => unknown) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock((url: string) =>
    Promise.resolve(
      new Response(JSON.stringify(handler(url)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  ) as typeof globalThis.fetch;
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

    const anchor = container.querySelector('a[href="/embeddings"]');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("aria-label")).toBe("View embedding infrastructure details");
    expect(anchor?.querySelectorAll("a, button, select").length).toBe(0);
  });
});
