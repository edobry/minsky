/**
 * Tests for SessionFilmPicker.tsx (mt#3184; scrub-gate rows removed by
 * mt#3268 / ADR-040).
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
    ...overrides,
  };
}

describe("SessionFilmPicker", () => {
  test("clicking a row fires onSelect with its conversation id", () => {
    const onSelect = mock(() => {});
    render(<SessionFilmPicker sessions={[row()]} isLoading={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId("session-film-picker-row-abc"));
    expect(onSelect).toHaveBeenCalledWith("abc");
  });

  // ADR-040 / mt#3268 regression guard. This picker used to DISABLE a row
  // whose session predated the credential-scrub cutover and render a refusal
  // beside it — while the conversation view rendered that same transcript in
  // full, one route over. The gate now binds only where transcript bytes
  // cross the operator's trust boundary, so every ingested conversation is
  // selectable here regardless of its ingest date.
  test("a pre-cutoff session is selectable, with no refusal copy (ADR-040)", () => {
    const onSelect = mock(() => {});
    render(
      <SessionFilmPicker
        sessions={[row({ ingestedAt: "2026-01-01T00:00:00.000Z" })]}
        isLoading={false}
        onSelect={onSelect}
      />
    );
    const btn = screen.getByTestId("session-film-picker-row-abc");
    expect(btn).toHaveProperty("disabled", false);
    expect(screen.queryByTestId("session-film-picker-scrub-refusal")).toBeNull();
    fireEvent.click(btn);
    expect(onSelect).toHaveBeenCalledWith("abc");
  });

  test("shows a loading state while sessions are being fetched", () => {
    render(<SessionFilmPicker sessions={[]} isLoading={true} onSelect={() => {}} />);
    expect(screen.getByText(/loading/i)).toBeDefined();
  });

  test("shows an empty state when no sessions are ingested", () => {
    render(<SessionFilmPicker sessions={[]} isLoading={false} onSelect={() => {}} />);
    expect(screen.getByText(/no ingested sessions/i)).toBeDefined();
  });
});
