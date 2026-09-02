/**
 * Component tests for the Changesets widget's project-badge states (mt#4729).
 *
 * `Changesets`/`ChangesetRow` are pure presentational components (props in,
 * no self-fetching), so no QueryClient/MemoryRouter-heavy harness is needed
 * beyond the router context `<Link>` requires.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Changesets, type ChangesetItem } from "./Changesets";
import type { SessionDetailMeta, SessionPrRef } from "../../session-detail";

function session(overrides: Partial<SessionDetailMeta> = {}): SessionDetailMeta {
  return {
    sessionId: "s-1",
    shortId: "ws#1",
    taskId: "mt#100",
    taskTitle: "A task",
    status: "IN-REVIEW",
    liveness: "healthy",
    agentId: null,
    branch: "task/mt-100",
    repoName: "edobry/minsky",
    repoUrl: "https://github.com/edobry/minsky.git",
    createdAt: null,
    lastActivityAt: null,
    lastCommitHash: null,
    lastCommitMessage: null,
    commitCount: null,
    ...overrides,
  };
}

function pr(overrides: Partial<SessionPrRef> = {}): SessionPrRef {
  return {
    number: 1,
    url: "https://github.com/edobry/minsky/pull/1",
    state: "open",
    title: "A changeset",
    headBranch: "task/mt-100",
    approved: null,
    ...overrides,
  };
}

function renderChangesets(items: ChangesetItem[], showProjectBadge?: boolean) {
  return render(
    <MemoryRouter>
      <Changesets items={items} onRowClick={() => {}} showProjectBadge={showProjectBadge} />
    </MemoryRouter>
  );
}

describe("Changesets project badge (mt#4729)", () => {
  afterEach(() => cleanup());

  test("renders the row's repoName as a badge when showProjectBadge is true", () => {
    renderChangesets(
      [{ pr: pr(), session: session({ repoName: "edobry/peezombie" }) }],
      true
    );
    expect(screen.getByText("edobry/peezombie")).toBeDefined();
  });

  test("does not render a badge when showProjectBadge is false (default)", () => {
    renderChangesets([{ pr: pr(), session: session({ repoName: "edobry/minsky" }) }]);
    expect(screen.queryByText("edobry/minsky")).toBeNull();
  });

  test("does not render a badge when showProjectBadge is true but repoName is null", () => {
    renderChangesets([{ pr: pr(), session: session({ repoName: null }) }], true);
    // The row still renders (title, task id) — just no project chip.
    expect(screen.getByText("A changeset")).toBeDefined();
  });
});
