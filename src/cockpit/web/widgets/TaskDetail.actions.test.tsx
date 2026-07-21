/**
 * TaskActions rendering tests (mt#2986; supersedes the mt#2959
 * TaskDetail.startability tests).
 *
 * The act-here region renders the server-computed stage-appropriate actions:
 *   - plan → launch button ("Plan in session") with the honesty note inline.
 *   - start → launch button ("Start session").
 *   - resume → link to the workspace detail page.
 *   - view-pr → link to the changeset page (omitted when prNumber unknown).
 *   - terminal (empty actions) → nothing rendered.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TaskActions, type TaskAction } from "./TaskDetail";

function renderActions(actions: TaskAction[]) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TaskActions taskId="mt#9999" actions={actions} />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("TaskActions (mt#2986)", () => {
  afterEach(cleanup);

  test("plan action → launch button with honesty note", () => {
    renderActions([
      { kind: "plan", note: "Task must reach READY before a session can start — plan it first." },
    ]);
    expect(screen.getByRole("button", { name: /Plan mt#9999 in a driven session/ })).toBeDefined();
    expect(screen.getByText(/Task must reach READY/)).toBeDefined();
  });

  test("start action → launch button", () => {
    renderActions([{ kind: "start" }]);
    expect(screen.getByRole("button", { name: /Start driven session for mt#9999/ })).toBeDefined();
  });

  test("resume action → link to the workspace detail page", () => {
    renderActions([{ kind: "resume", sessionId: "abc-123" }]);
    const link = screen.getByRole("link", { name: /Open session/ });
    expect(link.getAttribute("href")).toBe("/agents/abc-123");
  });

  test("view-pr action → link to the changeset page", () => {
    renderActions([{ kind: "view-pr", prNumber: 2090 }]);
    const link = screen.getByRole("link", { name: /View PR #2090/ });
    expect(link.getAttribute("href")).toBe("/changeset/2090");
  });

  test("view-pr without a PR number renders nothing (never a dead control)", () => {
    const { container } = renderActions([{ kind: "view-pr" }]);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.textContent).toBe("");
  });

  test("terminal (empty actions) → renders nothing", () => {
    const { container } = renderActions([]);
    expect(container.textContent).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("primary + secondary actions render together (plan + resume)", () => {
    renderActions([{ kind: "plan" }, { kind: "resume", sessionId: "ws-1" }]);
    expect(screen.getByRole("button", { name: /Plan mt#9999/ })).toBeDefined();
    expect(screen.getByRole("link", { name: /Open session/ })).toBeDefined();
  });
});
