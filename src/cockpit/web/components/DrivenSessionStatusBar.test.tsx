/**
 * DrivenSessionStatusBar tests (mt#2751, Rung 2B).
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { DrivenSessionStatusBar } from "./DrivenSessionStatusBar";

afterEach(cleanup);

describe("DrivenSessionStatusBar", () => {
  test("connecting", () => {
    render(<DrivenSessionStatusBar status="connecting" />);
    expect(screen.getByText("Connecting…")).toBeDefined();
  });

  test("live shows the emerald live-dot convention", () => {
    const { container } = render(<DrivenSessionStatusBar status="live" />);
    expect(screen.getByText("Live")).toBeDefined();
    expect(container.querySelector('[aria-label="live"]')).not.toBeNull();
  });

  test("exited shows a formatted result summary", () => {
    render(
      <DrivenSessionStatusBar
        status="exited"
        resultSummary={{ isError: false, durationMs: 4200, totalCostUsd: 0.0123, numTurns: 3 }}
      />
    );
    expect(screen.getByText("Exited")).toBeDefined();
    expect(screen.getByText("4.2s · $0.0123 · 3 turns")).toBeDefined();
  });

  test("exited with no result summary shows no extra text", () => {
    render(<DrivenSessionStatusBar status="exited" />);
    expect(screen.getByText("Exited")).toBeDefined();
  });

  test("crashed shows the readable error message", () => {
    render(<DrivenSessionStatusBar status="crashed" errorMessage="claude exited with code=1" />);
    expect(screen.getByText("Crashed")).toBeDefined();
    expect(screen.getByText("claude exited with code=1")).toBeDefined();
  });

  test("single-turn summary uses singular 'turn'", () => {
    render(
      <DrivenSessionStatusBar status="exited" resultSummary={{ isError: false, numTurns: 1 }} />
    );
    expect(screen.getByText("1 turn")).toBeDefined();
  });
});
