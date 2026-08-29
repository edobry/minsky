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
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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
    expect(screen.getByRole("button", { name: /Plan mt#9999 in a new session/ })).toBeDefined();
    expect(screen.getByText(/Task must reach READY/)).toBeDefined();
  });

  test("start action → launch button", () => {
    renderActions([{ kind: "start" }]);
    expect(screen.getByRole("button", { name: /Start a session for mt#9999/ })).toBeDefined();
  });

  test("resume action → link to the workspace detail page", () => {
    renderActions([{ kind: "resume", sessionId: "abc-123" }]);
    const link = screen.getByRole("link", { name: /Open session/ });
    expect(link.getAttribute("href")).toBe("/agents/abc-123");
  });

  // mt#3400 — the one-hop return to a live driven session.
  test("drive action → link to the driven-session view", () => {
    renderActions([{ kind: "drive", drivenSessionId: "ds-abc123" }]);
    const link = screen.getByRole("link", { name: /Return to the live drive view/ });
    expect(link.getAttribute("href")).toBe("/driven/ds-abc123");
  });

  // PR #2448 R1 — the two adjacent controls must not both read "…session".
  test("the drive label is distinguishable from the workspace 'Open session' label", () => {
    renderActions([
      { kind: "drive", drivenSessionId: "ds-abc123" },
      { kind: "resume", sessionId: "ws-999" },
    ]);
    expect(screen.getByText("Return to drive view")).toBeDefined();
    expect(screen.getByText("Open session")).toBeDefined();
  });

  test("drive without a driven session id renders nothing (never a dead control)", () => {
    const { container } = renderActions([{ kind: "drive" }]);
    expect(container.querySelector("a")).toBeNull();
  });

  test("a live drive action LEADS the workspace link when both are present", () => {
    renderActions([
      { kind: "drive", drivenSessionId: "ds-abc123" },
      { kind: "resume", sessionId: "ws-999" },
    ]);
    const links = screen.getAllByRole("link");
    expect(links[0]?.getAttribute("href")).toBe("/driven/ds-abc123");
    expect(links[1]?.getAttribute("href")).toBe("/agents/ws-999");
  });

  test("view-pr action → link to the changeset page", () => {
    renderActions([{ kind: "view-pr", prNumber: 2090 }]);
    const link = screen.getByRole("link", { name: /View PR #2090/ });
    expect(link.getAttribute("href")).toBe("/changeset/2090");
  });

  // mt#4731 (added scope) — the qualified `owner/repo#N` form (mt#4724) takes
  // precedence over the bare PR number, which is ambiguous once a second
  // project can claim the same number.
  test("view-pr action with a qualified changesetId links to the qualified changeset path", () => {
    renderActions([{ kind: "view-pr", prNumber: 1, changesetId: "edobry/peezombie.me#1" }]);
    const link = screen.getByRole("link", { name: /View PR #1/ });
    expect(link.getAttribute("href")).toBe("/changeset/edobry%2Fpeezombie.me%231");
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

  // -------------------------------------------------------------------------
  // Model selection (mt#3040) — defaulted-with-visible-override
  // -------------------------------------------------------------------------

  test("launch action renders a model picker defaulting to Sonnet, with Fable available", () => {
    renderActions([{ kind: "start" }]);
    const picker = screen.getByRole("combobox", {
      name: /Model for start session/i,
    });
    // The trigger shows the selected label; the option list is portalled and
    // only mounts while open.
    expect(picker.textContent).toContain("Sonnet");

    fireEvent.keyDown(picker, { key: "Enter" });
    expect(screen.getByRole("option", { name: "Fable" })).toBeDefined();
    expect(screen.getByRole("option", { name: "Opus" })).toBeDefined();
  });

  test("the principal can override the launch model to Fable", () => {
    renderActions([{ kind: "start" }]);
    const picker = screen.getByRole("combobox", {
      name: /Model for start session/i,
    });
    fireEvent.keyDown(picker, { key: "Enter" });
    fireEvent.click(screen.getByRole("option", { name: "Fable" }));
    expect(picker.textContent).toContain("Fable");
  });

  test("non-launch actions render no model picker", () => {
    renderActions([{ kind: "resume", sessionId: "abc-123" }]);
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
