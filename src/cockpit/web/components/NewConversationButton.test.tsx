/**
 * NewConversationButton + NewConversationProvider tests (mt#3464).
 *
 * Pattern mirrors ProjectSelector.test.tsx: QueryClientProvider + mocked
 * globalThis.fetch + waitFor for async settling, plus a MemoryRouter because
 * the underlying `useStartDrivenSession` navigates to `/driven/:id` on
 * success.
 *
 * These cover the three failure modes the provider exists to prevent —
 * double-fire from two mounted rail surfaces, a launch requested while one is
 * in flight, and a swallowed launch failure — plus the shortcut's text-entry
 * guard end-to-end (the matcher's own unit tests live in
 * `lib/new-conversation.test.ts`).
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { NewConversationButton } from "./NewConversationButton";
import { NewConversationProvider } from "../hooks/useNewConversation";

function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
}

function renderButtons(count = 1) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <MemoryRouter>
        <NewConversationProvider>
          {Array.from({ length: count }, (_, i) => (
            <NewConversationButton key={i} />
          ))}
        </NewConversationProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

/** POST bodies seen by the mocked fetch, in call order. */
let launches: string[] = [];
let originalFetch: typeof globalThis.fetch;

function mockLaunch(impl: (body: string) => Promise<Response>) {
  globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    launches.push(body);
    return impl(body);
  }) as unknown as typeof globalThis.fetch;
}

function okResponse(): Response {
  return new Response(JSON.stringify({ sessionId: "sess-1", cwd: "/repo" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  launches = [];
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("NewConversationButton", () => {
  test("renders the shared label; the shortcut hint stays out of the accessible name", () => {
    mockLaunch(async () => okResponse());
    renderButtons();

    // getByRole with an exact name would fail if the `kbd` hint leaked into
    // the accessible name (it is aria-hidden precisely so it does not).
    const button = screen.getByRole("button", { name: "New conversation" });
    expect(button).toBeDefined();
    // The hint is still VISIBLE — the operator has to be able to learn it.
    expect(screen.getByText("⌘⇧O")).toBeDefined();
  });

  test("clicking launches an UNTASKED conversation (empty body — no taskId, no cwd)", async () => {
    mockLaunch(async () => okResponse());
    renderButtons();

    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));

    await waitFor(() => expect(launches.length).toBe(1));
    expect(JSON.parse(launches[0]!)).toEqual({});
  });

  test("a second click while a launch is in flight does NOT start a second conversation", async () => {
    // Never resolves: the mutation stays pending for the whole test.
    mockLaunch(() => new Promise<Response>(() => {}));
    renderButtons();

    const button = screen.getByRole("button", { name: /New conversation|Starting/ });
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText("Starting…")).toBeDefined());

    fireEvent.click(screen.getByRole("button"));
    expect(launches.length).toBe(1);
  });

  test("pending state disables the control", async () => {
    mockLaunch(() => new Promise<Response>(() => {}));
    renderButtons();

    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));

    await waitFor(() => expect(screen.getByText("Starting…")).toBeDefined());
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a failed launch surfaces the server's message in an alert — never silent", async () => {
    mockLaunch(
      async () =>
        new Response(JSON.stringify({ error: "daemon cwd is not a git repository" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
    );
    renderButtons();

    fireEvent.click(screen.getByRole("button", { name: "New conversation" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("daemon cwd is not a git repository");
  });
});

describe("NewConversationProvider — global shortcut", () => {
  test("⌘⇧O starts a conversation from anywhere", async () => {
    mockLaunch(async () => okResponse());
    renderButtons();

    fireEvent.keyDown(document.body, { key: "O", metaKey: true, shiftKey: true });

    await waitFor(() => expect(launches.length).toBe(1));
  });

  test("⌘⇧O is suppressed while focus is in a text-entry surface", async () => {
    mockLaunch(async () => okResponse());
    const { container } = renderButtons();
    const textarea = document.createElement("textarea");
    container.appendChild(textarea);

    fireEvent.keyDown(textarea, { key: "O", metaKey: true, shiftKey: true });

    // Give a would-be mutation a turn to fire before asserting it did not.
    await new Promise((r) => setTimeout(r, 10));
    expect(launches.length).toBe(0);
  });

  test("two mounted rail surfaces still start ONE conversation per keypress", async () => {
    // The desktop <aside> and the mobile drawer are both mounted while the
    // drawer is open. A per-surface keydown listener would fire twice here.
    mockLaunch(async () => okResponse());
    renderButtons(2);
    expect(screen.getAllByRole("button", { name: "New conversation" }).length).toBe(2);

    fireEvent.keyDown(document.body, { key: "O", metaKey: true, shiftKey: true });

    await waitFor(() => expect(launches.length).toBe(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(launches.length).toBe(1);
  });
});
