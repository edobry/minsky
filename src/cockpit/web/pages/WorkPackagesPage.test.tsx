/**
 * Component tests for WorkPackagesPage (ADR-046, mt#2911).
 *
 * Stubs global fetch with fixture /api/work-packages responses and asserts:
 * the three lifecycle groups render with the right rows, claimed_by is
 * visible on a claimed package, the claim mutation posts to the claim
 * endpoint, and the launch command carries only the task id as variable
 * content.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  WorkPackagesPage,
  buildLaunchCommand,
  groupWorkPackages,
  type WorkPackageItem,
} from "./WorkPackagesPage";

const originalFetch = globalThis.fetch;

interface StubCall {
  url: string;
  method: string;
}

function stubFetch(packages: WorkPackageItem[]): StubCall[] {
  const calls: StubCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (method === "GET") {
      return new Response(JSON.stringify({ workPackages: packages }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: true, taskId: "mt#900" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

function makePackage(overrides: Partial<WorkPackageItem> = {}): WorkPackageItem {
  return {
    id: "mt#900",
    title: "Cockpit polish bundle",
    status: "READY",
    claimedBy: null,
    claimedAt: null,
    updatedAt: null,
    memberCount: 3,
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WorkPackagesPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

describe("groupWorkPackages", () => {
  test("splits by lifecycle status", () => {
    const groups = groupWorkPackages([
      makePackage({ id: "mt#1", status: "READY" }),
      makePackage({ id: "mt#2", status: "IN-PROGRESS", claimedBy: "conv-A" }),
      makePackage({ id: "mt#3", status: "TODO" }),
    ]);
    expect(groups.open.map((p) => p.id)).toEqual(["mt#1"]);
    expect(groups.claimed.map((p) => p.id)).toEqual(["mt#2"]);
    expect(groups.drafting.map((p) => p.id)).toEqual(["mt#3"]);
  });
});

describe("buildLaunchCommand", () => {
  test("the task id is the only variable content (id-as-transport)", () => {
    const a = buildLaunchCommand("mt#900");
    const b = buildLaunchCommand("mt#901");
    expect(a).toContain("mt#900");
    expect(a.replace("mt#900", "X")).toBe(b.replace("mt#901", "X"));
  });
});

describe("WorkPackagesPage", () => {
  test("renders an open package with claim + copy-launch, and a claimed one with its holder", async () => {
    stubFetch([
      makePackage({ id: "mt#900", status: "READY" }),
      makePackage({
        id: "mt#901",
        title: "Handoff: mt#2911 continuation",
        status: "IN-PROGRESS",
        claimedBy: "conv-abc",
        claimedAt: "2026-08-30T12:00:00.000Z",
        memberCount: 1,
      }),
    ]);
    renderPage();

    await waitFor(() => expect(screen.getByText("mt#900")).toBeTruthy());
    expect(screen.getByText("Claim")).toBeTruthy();
    expect(screen.getByText("Copy launch")).toBeTruthy();
    expect(screen.getByText("conv-abc")).toBeTruthy();
    expect(screen.getByText("Release")).toBeTruthy();
    // Section counters reflect the grouping.
    expect(screen.getByText("Open (1)")).toBeTruthy();
    expect(screen.getByText("Claimed (1)")).toBeTruthy();
  });

  test("claim posts to the claim endpoint with the encoded id", async () => {
    const calls = stubFetch([makePackage({ id: "mt#900", status: "READY" })]);
    renderPage();
    await waitFor(() => expect(screen.getByText("Claim")).toBeTruthy());

    fireEvent.click(screen.getByText("Claim"));
    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST");
      expect(post?.url).toBe("/api/work-packages/mt%23900/claim");
    });
  });

  test("empty pool renders the empty-state lines, not rows", async () => {
    stubFetch([]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("No packages open for claiming.")).toBeTruthy()
    );
    expect(screen.getByText("Nothing is claimed right now.")).toBeTruthy();
  });
});
