/**
 * Masked entry form for a credential request — component tests (mt#4030).
 *
 * The load-bearing assertions here are about where the value GOES, not about
 * layout: mt#4030's data-path invariant is that the credential reaches
 * `POST /api/credentials/add` and nothing else, so the fetch mock records every
 * call and the tests assert the value appears in exactly one of them.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CredentialRequestForm } from "./CredentialRequestForm";

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

const MOCK_PROVIDERS = [
  {
    id: "supabase-service-role",
    displayName: "Supabase service_role",
    acquireUrl: "https://supabase.com/dashboard/project/_/settings/api",
    scopeGuidance: "Project Settings → API → service_role. Not the anon key.",
  },
];

/** Every fetch the component made, so a test can assert what did NOT happen. */
interface RecordedCall {
  pathname: string;
  method: string;
  body: string | null;
}

let originalFetch: typeof globalThis.fetch;
let calls: RecordedCall[];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/**
 * @param addResponse what `POST /api/credentials/add` returns — a 200 body, or a
 * 400 carrying the provider's own rejection, which is the retry-in-place path.
 */
function mockFetch(
  addResponse: { status: number; body: unknown } = {
    status: 200,
    body: {
      provider: "supabase-service-role",
      validate: { ok: true, detail: "3 buckets visible" },
    },
  },
  providers = MOCK_PROVIDERS
) {
  globalThis.fetch = mock((url: string, init?: RequestInit) => {
    const pathname = typeof url === "string" ? new URL(url, "http://localhost").pathname : "";
    calls.push({
      pathname,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    });

    if (pathname === "/api/credentials/providers") {
      return Promise.resolve(
        new Response(JSON.stringify({ providers }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    if (pathname === "/api/credentials/add" && init?.method === "POST") {
      return Promise.resolve(
        new Response(JSON.stringify(addResponse.body), {
          status: addResponse.status,
          headers: { "Content-Type": "application/json" },
        })
      );
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as unknown as typeof globalThis.fetch;
}

describe("CredentialRequestForm", () => {
  test("renders a masked input bound to the requested provider", async () => {
    mockFetch();
    renderWithQuery(<CredentialRequestForm providerId="supabase-service-role" />);

    const input = await screen.findByTestId("credential-request-token-input");
    // type=password is the masking. Asserted on the attribute rather than on a
    // visual property because that attribute IS the guarantee.
    expect(input.getAttribute("type")).toBe("password");
    expect(screen.getByText(/Supabase service_role credential/)).toBeTruthy();
  });

  test("shows the provider's acquire link and scope guidance, so the principal can go get it", async () => {
    mockFetch();
    renderWithQuery(<CredentialRequestForm providerId="supabase-service-role" />);

    const link = await screen.findByText("Get it here");
    expect(link.getAttribute("href")).toBe(
      "https://supabase.com/dashboard/project/_/settings/api"
    );
    expect(screen.getByText(/Not the anon key/)).toBeTruthy();
  });

  test("posts the value to /api/credentials/add and nowhere else", async () => {
    mockFetch();
    const user = userEvent.setup();
    renderWithQuery(<CredentialRequestForm providerId="supabase-service-role" />);

    const input = await screen.findByTestId("credential-request-token-input");
    await user.type(input, "sbp_secret_value");
    await user.click(screen.getByRole("button", { name: /Save credential/ }));

    await waitFor(() => expect(screen.getByTestId("credential-request-stored")).toBeTruthy());

    const carrying = calls.filter((c) => (c.body ?? "").includes("sbp_secret_value"));
    expect(carrying.length).toBe(1);
    expect(carrying[0]?.pathname).toBe("/api/credentials/add");
    expect(carrying[0]?.method).toBe("POST");
  });

  test("clears the value from the input once stored", async () => {
    mockFetch();
    const user = userEvent.setup();
    renderWithQuery(<CredentialRequestForm providerId="supabase-service-role" />);

    const input = (await screen.findByTestId(
      "credential-request-token-input"
    )) as HTMLInputElement;
    await user.type(input, "sbp_secret_value");
    await user.click(screen.getByRole("button", { name: /Save credential/ }));

    await waitFor(() => expect(screen.getByTestId("credential-request-stored")).toBeTruthy());
    expect(input.value).toBe("");
  });

  test("a rejected credential stays open with the provider's own reason, for retry in place", async () => {
    mockFetch({
      status: 400,
      body: {
        error: { code: "validation_failed", message: "validation failed" },
        validate: { ok: false, detail: "401 — that's the anon key; you want service_role" },
      },
    });
    const user = userEvent.setup();
    renderWithQuery(<CredentialRequestForm providerId="supabase-service-role" />);

    const input = await screen.findByTestId("credential-request-token-input");
    await user.type(input, "wrong_key");
    await user.click(screen.getByRole("button", { name: /Save credential/ }));

    await waitFor(() =>
      expect(screen.getByText(/that's the anon key; you want service_role/)).toBeTruthy()
    );
    // Still usable — this is a retry, not a terminal error.
    expect(screen.getByTestId("credential-request-token-input")).toBeTruthy();
    expect(screen.queryByTestId("credential-request-stored")).toBeNull();
  });

  test("refuses to render an input for an unregistered provider", async () => {
    mockFetch(undefined, []);
    renderWithQuery(<CredentialRequestForm providerId="not-registered" />);

    await waitFor(() =>
      expect(screen.getByTestId("credential-request-unknown-provider")).toBeTruthy()
    );
    // No input at all: typing into a request that can never land is worse than
    // saying so, and the request tool refuses at call time for the same reason.
    expect(screen.queryByTestId("credential-request-token-input")).toBeNull();
  });

  test("decline is offered when the caller wires it, and never posts a value", async () => {
    mockFetch();
    const onDecline = mock(() => {});
    const user = userEvent.setup();
    renderWithQuery(
      <CredentialRequestForm providerId="supabase-service-role" onDecline={onDecline} />
    );

    await user.click(await screen.findByTestId("credential-request-decline"));

    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.pathname === "/api/credentials/add")).toBe(false);
  });
});
