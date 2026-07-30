/**
 * Checkbox primitive tests (mt#3348).
 *
 * Covers the contract the 4 migrated call sites depend on:
 *   - it is NOT a native input (the whole point — a native checkbox keeps
 *     `appearance: auto` and paints OS chrome)
 *   - checked / unchecked / indeterminate render distinguishable state
 *   - `disabled` renders non-interactive (ActivityPage's filter-dependent
 *     checkbox relies on this)
 *   - toggling reports through `onCheckedChange`
 *   - a WRAPPING `<label>` still names the control. Three of the four call
 *     sites use implicit association rather than `aria-label`; Radix renders a
 *     `button role="checkbox"`, and a button is a labelable element, so this
 *     should hold — but a broken implicit association fails SILENTLY, so it is
 *     pinned here rather than assumed.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { Checkbox } from "./checkbox";

describe("Checkbox primitive (mt#3348)", () => {
  afterEach(cleanup);

  test("renders a button-based checkbox, not a native input", () => {
    render(<Checkbox aria-label="Hide superseded" />);
    const box = screen.getByRole("checkbox", { name: "Hide superseded" });
    expect(box.tagName).toBe("BUTTON");
    // The native element is what carried the OS chrome; it must be gone.
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  });

  test("checked and unchecked are distinguishable to assistive tech", () => {
    const { rerender } = render(<Checkbox aria-label="Semantic" checked={false} />);
    expect(screen.getByRole("checkbox", { name: "Semantic" }).dataset.state).toBe("unchecked");

    rerender(<Checkbox aria-label="Semantic" checked={true} />);
    expect(screen.getByRole("checkbox", { name: "Semantic" }).dataset.state).toBe("checked");
  });

  test("indeterminate renders its own state, not a silent fallback to unchecked", () => {
    render(<Checkbox aria-label="Partial" checked="indeterminate" />);
    expect(screen.getByRole("checkbox", { name: "Partial" }).dataset.state).toBe("indeterminate");
  });

  test("disabled renders non-interactive and does not fire onCheckedChange", () => {
    const seen: unknown[] = [];
    render(
      <Checkbox
        aria-label="Show informational events"
        checked={false}
        disabled
        onCheckedChange={(v) => seen.push(v)}
      />
    );
    const box = screen.getByRole("checkbox", {
      name: "Show informational events",
    }) as HTMLButtonElement;
    expect(box.disabled).toBe(true);
    fireEvent.click(box);
    expect(seen).toEqual([]);
  });

  test("clicking reports the new value through onCheckedChange", () => {
    const seen: unknown[] = [];
    render(<Checkbox aria-label="Semantic" checked={false} onCheckedChange={(v) => seen.push(v)} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Semantic" }));
    expect(seen).toEqual([true]);
  });

  test("a wrapping <label> still names the control (implicit association survives)", () => {
    render(
      <label>
        <Checkbox checked={false} />
        Hide superseded
      </label>
    );
    // No aria-label anywhere — the name must come from the wrapping label,
    // which is how ConversationSearchPanel / Agents / MemoriesList label theirs.
    expect(screen.getByRole("checkbox", { name: "Hide superseded" })).toBeDefined();
  });
});
