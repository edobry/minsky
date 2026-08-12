/**
 * Publish-confirmation tests (mt#4024).
 *
 * The confirmation is a CONTROL — the mitigation recorded in the task's
 * planning audit for the fact that the scrub gate covers credential patterns
 * and nothing else. So the tests that matter here are about restraint: opening
 * the dialog must not publish anything, and the operator must be shown what
 * becomes readable and told plainly what that includes.
 *
 * Run via:
 *   bun run test:components
 *   (or) bun test --preload ./tests/dom-setup.ts --preload ./tests/setup.ts
 *        --timeout=15000 src/cockpit/web/components/PublishConversationDialog.test.tsx
 */
import { describe, test, expect, afterEach, beforeEach, mock } from "bun:test";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { PublishConversationDialog } from "./PublishConversationDialog";
import type { SessionContextSnapshotBlock } from "@minsky/domain/context/types";

const CONVERSATION_ID = "agent-ae1576839e37ecab9";

function turnBlock(i: number, role: "user" | "assistant", body: string): SessionContextSnapshotBlock {
  return {
    id: `block-${i}`,
    type: role === "user" ? "user-prompt" : "assistant-text",
    source: "observed",
    content: { role, content: body },
    timestamp: new Date(Date.UTC(2026, 7, 11, 16, 0, i)).toISOString(),
    turnIndex: i,
    rawJsonlType: role,
  };
}

interface Call {
  url: string;
  method: string;
}

let calls: Call[] = [];
let originalFetch: typeof globalThis.fetch;

/** Serves the snapshot; `mintResponse` decides what POST /api/shares answers. */
function stubFetch(mintResponse: { status: number; body: unknown }) {
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    if (url.startsWith("/api/cockpit/context-inspector/snapshot")) {
      return new Response(
        JSON.stringify({
          agentSessionId: CONVERSATION_ID,
          harness: "claude_code",
          assembledAt: "2026-08-12T00:00:00.000Z",
          blocks: [
            turnBlock(0, "user", "first"),
            turnBlock(1, "assistant", "second"),
            turnBlock(2, "user", "third"),
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url === "/api/shares") {
      return new Response(JSON.stringify(mintResponse.body), {
        status: mintResponse.status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
}

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <PublishConversationDialog
        conversationId={CONVERSATION_ID}
        conversationLabel="Passkey gate research"
        open
        onOpenChange={() => {}}
      />
    </QueryClientProvider>
  );
}

const MINTED = {
  status: 201,
  body: {
    id: "share-1",
    conversationId: CONVERSATION_ID,
    label: "Passkey gate research",
    createdAt: "2026-08-12T00:00:00.000Z",
    revokedAt: null,
    lastAccessedAt: null,
    url: `/s/${"b".repeat(64)}`,
  },
};

beforeEach(() => {
  calls = [];
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("PublishConversationDialog (mt#4024)", () => {
  test("opening the dialog publishes NOTHING", async () => {
    stubFetch(MINTED);
    renderDialog();

    await waitFor(() => expect(screen.getByTestId("share-exposure")).toBeTruthy());

    // The property the confirmation exists for: nothing becomes readable until
    // the operator says so. A single-click affordance that minted on open would
    // pass every other test in this file.
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("shows what becomes readable: the conversation, its turn count, its dates", async () => {
    stubFetch(MINTED);
    renderDialog();

    const exposure = await screen.findByTestId("share-exposure");
    expect(exposure.textContent).toContain("Passkey gate research");
    // Three blocks in, three turns reported — the operator is shown the size of
    // what they are about to expose, not asked to remember it.
    await waitFor(() => expect(exposure.textContent).toContain("3"));
  });

  test("states plainly that everything becomes readable, and that scrubbing is partial", async () => {
    stubFetch(MINTED);
    renderDialog();

    const warning = await screen.findByText(/becomes readable by anyone holding the link/i);
    expect(warning.textContent).toContain("file contents");
    expect(warning.textContent).toContain("command output");
    expect(warning.textContent).toContain("tool results");
    // The honest half: the automated control does not cover the other
    // categories, so the operator is the one who has to look.
    expect(warning.textContent).toMatch(/credential patterns only/i);
  });

  test("confirming mints once and shows the link", async () => {
    stubFetch(MINTED);
    renderDialog();

    fireEvent.click(await screen.findByTestId("share-publish-confirm"));

    const field = (await screen.findByTestId("share-url")) as HTMLInputElement;
    expect(field.value).toContain(`/s/${"b".repeat(64)}`);
    expect(calls.filter((c) => c.url === "/api/shares" && c.method === "POST")).toHaveLength(1);
  });

  test("a refused publish surfaces the reason and yields no link", async () => {
    stubFetch({
      status: 422,
      body: { error: "unscrubbed", detail: "Export refused: session ingested before cutoff" },
    });
    renderDialog();

    fireEvent.click(await screen.findByTestId("share-publish-confirm"));

    const error = await screen.findByTestId("share-mint-error");
    expect(error.textContent).toContain("ingested before cutoff");
    expect(screen.queryByTestId("share-url")).toBeNull();
  });
});
