/**
 * Credentials widget component tests (mt#2152)
 *
 * Tests the Credentials React component's rendering and user interactions
 * with mocked fetch responses. Exercises the UI layer that Tier 1 (mt#2146,
 * server integration tests) does not cover.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, waitFor, within, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CredentialsManager } from "./Credentials";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = createTestQueryClient();
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const MOCK_CREDENTIALS = [
  {
    provider: "github",
    displayName: "GitHub",
    configPath: "github.token",
    configured: true,
    lastValidatedAt: new Date().toISOString(),
    lastValidationDetail: "github:octocat",
  },
  {
    provider: "supabase",
    displayName: "Supabase",
    configPath: "supabase.accessToken",
    configured: false,
  },
  {
    provider: "anthropic",
    displayName: "Anthropic",
    configPath: "ai.providers.anthropic.apiKey",
    configured: true,
    lastValidatedAt: new Date().toISOString(),
    lastValidationDetail: "anthropic:key-valid",
  },
  {
    provider: "railway",
    displayName: "Railway",
    configPath: "railway.apiToken",
    configured: false,
  },
];

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function mockFetchCredentials(credentials = MOCK_CREDENTIALS) {
  globalThis.fetch = mock((url: string, init?: RequestInit) => {
    if (
      typeof url === "string" &&
      url.endsWith("/api/credentials") &&
      (!init || init.method !== "POST")
    ) {
      return Promise.resolve(
        new Response(JSON.stringify({ credentials }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    if (
      typeof url === "string" &&
      url.endsWith("/api/credentials/add") &&
      init?.method === "POST"
    ) {
      const body = JSON.parse(init.body as string) as { provider: string };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            provider: body.provider,
            validate: { ok: true, detail: "stub-ok" },
            stored: { configFilePath: "/mock/config.yaml" },
            test: { ok: true, detail: "smoke-ok" },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    return Promise.resolve(new Response("Not found", { status: 404 }));
  }) as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Credentials widget", () => {
  test("renders loading state initially", () => {
    mockFetchCredentials();
    renderWithQuery(<CredentialsManager />);
    expect(screen.getByText("Loading...")).toBeDefined();
  });

  test("renders all provider names after data loads", async () => {
    mockFetchCredentials();
    renderWithQuery(<CredentialsManager />);

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).toBeNull();
    });

    expect(screen.getAllByText("GitHub").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Supabase").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Anthropic").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Railway").length).toBeGreaterThan(0);
  });

  test("shows configured/not-configured status for each provider", async () => {
    mockFetchCredentials();
    renderWithQuery(<CredentialsManager />);

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).toBeNull();
    });

    const configuredBadges = screen.getAllByText("Configured");
    const notConfiguredBadges = screen.getAllByText("Not configured");

    expect(configuredBadges.length).toBe(2);
    expect(notConfiguredBadges.length).toBe(2);
  });

  test("renders the add form with provider selector and token input", async () => {
    mockFetchCredentials();
    renderWithQuery(<CredentialsManager />);

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).toBeNull();
    });

    const providerSelect = screen.getByLabelText("Select credential provider");
    expect(providerSelect).toBeDefined();

    const tokenInput = screen.getByLabelText("Paste credential token");
    expect(tokenInput).toBeDefined();

    const validateBtn = screen.getByLabelText("Validate token without saving");
    expect(validateBtn).toBeDefined();

    const addBtn = screen.getByLabelText("Validate and save token");
    expect(addBtn).toBeDefined();
  });

  test("add button is disabled when token input is empty", async () => {
    mockFetchCredentials();
    renderWithQuery(<CredentialsManager />);

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).toBeNull();
    });

    const addBtn = screen.getByLabelText("Validate and save token") as HTMLButtonElement;
    expect(addBtn.disabled).toBe(true);
  });

  test("add button enables after typing a token", async () => {
    mockFetchCredentials();
    renderWithQuery(<CredentialsManager />);

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).toBeNull();
    });

    const tokenInput = screen.getByLabelText("Paste credential token");
    const addBtn = screen.getByLabelText("Validate and save token") as HTMLButtonElement;

    await userEvent.type(tokenInput, "test-token-value");
    expect(addBtn.disabled).toBe(false);
  });

  test("renders error state when fetch fails", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: "internal", message: "Server error" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        })
      )
    ) as typeof globalThis.fetch;

    renderWithQuery(<CredentialsManager />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load credentials/)).toBeDefined();
    });
  });

  test("renders empty provider list message when no providers exist", async () => {
    mockFetchCredentials([]);
    renderWithQuery(<CredentialsManager />);

    await waitFor(() => {
      expect(screen.getByText("No credential providers registered.")).toBeDefined();
    });
  });

  test("shows success feedback after adding a credential", async () => {
    mockFetchCredentials();
    renderWithQuery(<CredentialsManager />);

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).toBeNull();
    });

    const tokenInput = screen.getByLabelText("Paste credential token");
    const addBtn = screen.getByLabelText("Validate and save token");

    await userEvent.type(tokenInput, "test-token-value");
    await userEvent.click(addBtn);

    await waitFor(() => {
      expect(screen.getByText("stub-ok")).toBeDefined();
    });

    const storedText = screen.getByText(/Stored at/);
    expect(storedText).toBeDefined();
  });

  test("remove button is disabled for unconfigured providers", async () => {
    mockFetchCredentials();
    renderWithQuery(<CredentialsManager />);

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).toBeNull();
    });

    const supabaseLabel = screen
      .getAllByText("Supabase")
      .find((el) => el.classList.contains("font-medium"));
    expect(supabaseLabel).toBeDefined();
    const supabaseRow = supabaseLabel!.closest("div[class*='flex items-center']");
    if (supabaseRow) {
      const removeBtn = within(supabaseRow as HTMLElement).getByText("Remove") as HTMLButtonElement;
      expect(removeBtn.disabled).toBe(true);
    }
  });
});
