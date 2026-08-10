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

/**
 * Mirrors the widget's `CredentialListing`. Declared explicitly so `source` is a
 * known property: without it TypeScript infers the array's element type from these
 * literals alone, and a fixture adding `source` fails to typecheck (mt#3569).
 */
type MockCredentialListing = {
  provider: string;
  displayName: string;
  configPath: string;
  configured: boolean;
  source?: "provider" | "schema";
  lastValidatedAt?: string;
  lastValidationDetail?: string;
};

const MOCK_CREDENTIALS: MockCredentialListing[] = [
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

const MOCK_PROVIDERS = [
  {
    id: "github",
    displayName: "GitHub",
    acquireUrl: "https://github.com/settings/tokens",
    scopeGuidance: "repo, read:org",
  },
  {
    id: "supabase",
    displayName: "Supabase",
    acquireUrl: "https://supabase.com/dashboard/account/tokens",
    scopeGuidance: "access token",
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    acquireUrl: "https://console.anthropic.com/settings/keys",
    scopeGuidance: "API key",
  },
  {
    id: "railway",
    displayName: "Railway",
    acquireUrl: "https://railway.app/account/tokens",
    scopeGuidance: "API token",
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

function mockFetchCredentials(credentials = MOCK_CREDENTIALS, providers = MOCK_PROVIDERS) {
  globalThis.fetch = mock((url: string, init?: RequestInit) => {
    // Exact pathname matching (not endsWith) so the branch order is irrelevant —
    // "/api/credentials/providers" also ends with "/api/credentials", which would
    // misroute under a substring check if the blocks were ever reordered.
    const pathname = typeof url === "string" ? new URL(url, "http://localhost").pathname : "";
    if (pathname === "/api/credentials/providers") {
      return Promise.resolve(
        new Response(JSON.stringify({ providers }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    if (pathname === "/api/credentials" && (!init || init.method !== "POST")) {
      return Promise.resolve(
        new Response(JSON.stringify({ credentials }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    if (pathname === "/api/credentials/add" && init?.method === "POST") {
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
  }) as unknown as typeof globalThis.fetch;
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

    // findByLabelText awaits the providers query (a separate fetch from the
    // parent credentials load) so the add-form controls are deterministically
    // present before we assert on them.
    const providerSelect = await screen.findByLabelText("Select credential provider");
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

    const addBtn = (await screen.findByLabelText(
      "Validate and save token"
    )) as HTMLButtonElement;
    expect(addBtn.disabled).toBe(true);
  });

  test("add button enables after typing a token", async () => {
    mockFetchCredentials();
    renderWithQuery(<CredentialsManager />);

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).toBeNull();
    });

    const tokenInput = await screen.findByLabelText("Paste credential token");
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
    ) as unknown as typeof globalThis.fetch;

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

    const tokenInput = await screen.findByLabelText("Paste credential token");
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

  // mt#3569: schema-derived rows are presence-only. `removeCredential` throws
  // "Unknown credential provider" for them, so the row must not offer the action.
  test("a schema-derived row offers no Remove action", async () => {
    mockFetchCredentials([
      ...MOCK_CREDENTIALS,
      {
        provider: "openai",
        displayName: "OpenAI",
        configPath: "ai.providers.openai.apiKey",
        configured: true,
        source: "schema",
      },
    ]);
    renderWithQuery(<CredentialsManager />);

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).toBeNull();
    });

    const openaiLabel = screen
      .getAllByText("OpenAI")
      .find((el) => el.classList.contains("font-medium"));
    expect(openaiLabel).toBeDefined();

    const openaiRow = openaiLabel!.closest("div[class*='flex items-center']") as HTMLElement;
    expect(openaiRow).toBeDefined();
    // No Remove button at all — not merely disabled. A disabled button would still
    // suggest the action exists for this row.
    expect(within(openaiRow).queryByText("Remove")).toBeNull();
    expect(within(openaiRow).getByText("config-only")).toBeDefined();
  });

  test("a row without an explicit source keeps its Remove action", async () => {
    // Wire-compat: a server predating `source` has no schema-derived rows, so every
    // row it sends is manageable. The first draft treated absence as unmanaged and
    // stripped Remove from every row — MOCK_CREDENTIALS omits `source`, which is
    // what caught it.
    mockFetchCredentials();
    renderWithQuery(<CredentialsManager />);

    await waitFor(() => {
      expect(screen.queryByText("Loading...")).toBeNull();
    });

    const githubLabel = screen
      .getAllByText("GitHub")
      .find((el) => el.classList.contains("font-medium"));
    const githubRow = githubLabel!.closest("div[class*='flex items-center']") as HTMLElement;
    expect(within(githubRow).getByText("Remove")).toBeDefined();
  });
});
