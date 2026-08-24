/**
 * PendingButton tests (mt#4503).
 *
 * Pins the three properties the component exists for, each of which the old
 * bare `<Button disabled={...}>` lacked:
 *
 *   - a spinner renders while and only while `pending`
 *   - `aria-busy` is set, so the state is not purely visual
 *   - the child label survives, so a row of long option labels does not reflow
 *     under the pointer mid-click
 *
 * Plus the safety property: a pending button is also disabled, because a second
 * click would fire a second mutation against an ask the first is already
 * closing.
 *
 * Run via:
 *   bun test --preload ./tests/dom-setup.ts src/cockpit/web/components/PendingButton.test.tsx
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PendingButton } from "./PendingButton";

afterEach(cleanup);

describe("PendingButton (mt#4503)", () => {
  test("at rest: no spinner, no aria-busy, clickable", () => {
    let clicks = 0;
    render(<PendingButton onClick={() => clicks++}>A) Hold off</PendingButton>);

    const button = screen.getByRole("button", { name: /hold off/i });
    expect(button.querySelector('[data-testid="pending-spinner"]')).toBeNull();
    expect(button.getAttribute("aria-busy")).toBeNull();

    fireEvent.click(button);
    expect(clicks).toBe(1);
  });

  test("pending: spinner renders, aria-busy is set, and the label is unchanged", () => {
    render(<PendingButton pending>A) Hold off</PendingButton>);

    const button = screen.getByRole("button", { name: /hold off/i });
    expect(button.querySelector('[data-testid="pending-spinner"]')).not.toBeNull();
    expect(button.getAttribute("aria-busy")).toBe("true");
    // The whole reason the spinner is PREPENDED rather than replacing the text.
    expect(button.textContent).toContain("A) Hold off");
  });

  test("pending implies disabled — a second click cannot fire a second mutation", () => {
    let clicks = 0;
    render(
      <PendingButton pending onClick={() => clicks++}>
        A) Hold off
      </PendingButton>
    );

    const button = screen.getByRole("button", { name: /hold off/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(clicks).toBe(0);
  });

  test("disabled without pending shows no spinner — the two states stay distinct", () => {
    // This is the distinction the whole task turns on: `disabled` alone is what
    // the cockpit used to render for a SAVING control, and it is also what it
    // renders for a sibling control that merely cannot be used right now. They
    // must not look the same.
    render(<PendingButton disabled>B) Run it</PendingButton>);

    const button = screen.getByRole("button", { name: /run it/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.querySelector('[data-testid="pending-spinner"]')).toBeNull();
    expect(button.getAttribute("aria-busy")).toBeNull();
  });
});
