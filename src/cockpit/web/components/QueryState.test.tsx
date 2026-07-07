/**
 * LoadingState / ErrorState component tests (mt#2616).
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { LoadingState } from "./LoadingState";
import { ErrorState } from "./ErrorState";

describe("LoadingState", () => {
  afterEach(cleanup);

  test("renders default message", () => {
    render(<LoadingState />);
    expect(screen.getByText("Loading…")).toBeDefined();
  });

  test("renders a custom message", () => {
    render(<LoadingState message="Loading session abc123…" />);
    expect(screen.getByText("Loading session abc123…")).toBeDefined();
  });

  test("has aria-live=polite for assistive tech", () => {
    render(<LoadingState message="Loading providers..." />);
    const el = screen.getByText("Loading providers...");
    expect(el.getAttribute("aria-live")).toBe("polite");
  });

  test("page variant applies centered padding classes", () => {
    render(<LoadingState variant="page" />);
    const el = screen.getByText("Loading…");
    expect(el.className).toContain("py-8");
    expect(el.className).toContain("text-center");
  });

  test("inline variant (default) has no page padding", () => {
    render(<LoadingState />);
    const el = screen.getByText("Loading…");
    expect(el.className).not.toContain("py-8");
  });
});

describe("ErrorState", () => {
  afterEach(cleanup);

  test("renders a static message", () => {
    render(<ErrorState message="Task not found." />);
    expect(screen.getByText("Task not found.")).toBeDefined();
  });

  test("combines prefix + Error.message", () => {
    render(<ErrorState prefix="Failed to load activity" error={new Error("HTTP 500")} />);
    expect(screen.getByText("Failed to load activity: HTTP 500")).toBeDefined();
  });

  test("combines prefix + string error", () => {
    render(<ErrorState prefix="Failed to load asks" error="HTTP 500" />);
    expect(screen.getByText("Failed to load asks: HTTP 500")).toBeDefined();
  });

  test("falls back to prefix alone when error is absent", () => {
    render(<ErrorState prefix="Something failed" />);
    expect(screen.getByText("Something failed")).toBeDefined();
  });

  test("falls back to a generic message with no props", () => {
    render(<ErrorState />);
    expect(screen.getByText("Something went wrong.")).toBeDefined();
  });

  test("always uses role=alert and text-destructive (never a raw color)", () => {
    render(<ErrorState message="boom" />);
    const el = screen.getByRole("alert");
    expect(el.className).toContain("text-destructive");
    expect(el.className).not.toContain("text-red-400");
  });

  test("page variant applies centered padding classes", () => {
    render(<ErrorState message="boom" variant="page" />);
    const el = screen.getByRole("alert");
    expect(el.className).toContain("py-8");
  });
});
