/**
 * StartSessionButton gating tests (mt#2959).
 *
 * The cockpit must not present a "Start session" action that cannot succeed. The
 * button is gated on the server-computed `startability` signal:
 *   - startable → the launch button is shown.
 *   - not startable + reason → the reason is shown inline, NO button (the fix
 *     for the dead-end portal defect).
 *   - terminal (not startable, no reason) → nothing is rendered (prior behavior).
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StartSessionButton } from "./TaskDetail";

type StartabilityProp = Parameters<typeof StartSessionButton>[0]["startability"];

function renderButton(startability: StartabilityProp) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StartSessionButton taskId="mt#9999" startability={startability} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("StartSessionButton gating (mt#2959)", () => {
  afterEach(cleanup);

  test("startable → renders the launch button", () => {
    renderButton({ startable: true, startBlockedReason: null });
    expect(screen.getByRole("button", { name: /Start driven session for mt#9999/ })).toBeDefined();
  });

  test("blocked → renders the reason inline, no dead-end button", () => {
    renderButton({
      startable: false,
      startBlockedReason: "Task must reach READY before a session can start — plan it first.",
    });
    expect(screen.getByText(/Task must reach READY before a session can start/)).toBeDefined();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("terminal (not startable, no reason) → renders nothing", () => {
    const { container } = renderButton({ startable: false, startBlockedReason: null });
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("undefined startability (older payload) → renders nothing", () => {
    const { container } = renderButton(undefined);
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
