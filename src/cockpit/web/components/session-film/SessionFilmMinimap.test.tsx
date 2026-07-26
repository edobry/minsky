/**
 * Tests for SessionFilmMinimap.tsx (mt#3184).
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { SessionFilmMinimap } from "./SessionFilmMinimap";

afterEach(() => cleanup());

describe("SessionFilmMinimap", () => {
  test("positions the playhead marker proportionally to rowIndex/(rowCount-1)", () => {
    render(<SessionFilmMinimap rowCount={101} playheadRowIndex={50} onJump={() => {}} />);
    const marker = screen.getByTestId("session-film-minimap-playhead");
    expect(marker.style.left).toBe("50%");
  });

  test("exposes ARIA slider semantics for accessibility", () => {
    render(<SessionFilmMinimap rowCount={10} playheadRowIndex={3} onJump={() => {}} />);
    const slider = screen.getByRole("slider", { name: "Session film minimap" });
    expect(slider.getAttribute("aria-valuenow")).toBe("3");
    expect(slider.getAttribute("aria-valuemax")).toBe("9");
  });

  test("clicking calls onJump with a row index derived from click position", () => {
    const onJump = mock(() => {});
    render(<SessionFilmMinimap rowCount={100} playheadRowIndex={0} onJump={onJump} />);
    fireEvent.click(screen.getByTestId("session-film-minimap"));
    expect(onJump).toHaveBeenCalled();
  });
});
