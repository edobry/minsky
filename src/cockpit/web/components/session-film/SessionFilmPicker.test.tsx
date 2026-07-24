/**
 * Tests for SessionFilmPicker.tsx (mt#3184, spec AT 8).
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SessionFilmPicker } from "./SessionFilmPicker";
import type { SessionFilmPickerRow } from "../../lib/session-film-client";

afterEach(() => cleanup());

function row(overrides: Partial<SessionFilmPickerRow> = {}): SessionFilmPickerRow {
  return {
    agentSessionId: "abc",
    label: "test session",
    startedAt: null,
    cwd: null,
    ingestedAt: null,
    scrubGateOk: true,
    ...overrides,
  };
}

describe("SessionFilmPicker — scrub gate (AT 8)", () => {
  test("a pre-cutoff session is disabled and shows an explanatory refusal", () => {
    render(
      <SessionFilmPicker sessions={[row({ scrubGateOk: false })]} isLoading={false} onSelect={() => {}} />
    );
    const btn = screen.getByTestId("session-film-picker-row-abc");
    expect(btn).toHaveProperty("disabled", true);
    expect(screen.getByTestId("session-film-picker-scrub-refusal")).toBeDefined();
  });

  test("clicking a disabled (pre-cutoff) row never fires onSelect", () => {
    const onSelect = mock(() => {});
    render(
      <SessionFilmPicker sessions={[row({ scrubGateOk: false })]} isLoading={false} onSelect={onSelect} />
    );
    fireEvent.click(screen.getByTestId("session-film-picker-row-abc"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("clicking a scrub-gate-OK row fires onSelect with its conversation id", () => {
    const onSelect = mock(() => {});
    render(<SessionFilmPicker sessions={[row({ scrubGateOk: true })]} isLoading={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("session-film-picker-row-abc"));
    expect(onSelect).toHaveBeenCalledWith("abc");
  });

  test("shows a loading state while sessions are being fetched", () => {
    render(<SessionFilmPicker sessions={[]} isLoading={true} onSelect={() => {}} />);
    expect(screen.getByText(/loading/i)).toBeDefined();
  });
});
