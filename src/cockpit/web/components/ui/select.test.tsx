/**
 * Select primitive tests (mt#3347).
 *
 * Covers the contract the 22 migrated call sites depend on:
 *   - the trigger renders the selected label and is a labelable button
 *     (so an existing `<label htmlFor>` association keeps working)
 *   - `disabled` renders a non-interactive trigger (the `start.isPending`
 *     case in TaskDetail relies on this)
 *   - opening the panel exposes the options as listbox options
 *   - selecting an option fires onValueChange with the item's value
 *   - an empty-string item value is NOT a usable sentinel — this is the
 *     migration hazard that forced ProjectSelector and MemoriesList to adopt
 *     explicit non-empty sentinels instead of the `""` they used natively.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./select";

function renderSelect(
  props: {
    value?: string;
    disabled?: boolean;
    onValueChange?: (v: string) => void;
    items?: Array<{ value: string; label: string }>;
  } = {}
) {
  const items = props.items ?? [
    { value: "sonnet", label: "Sonnet" },
    { value: "opus", label: "Opus" },
  ];
  return render(
    <Select value={props.value} onValueChange={props.onValueChange} disabled={props.disabled}>
      <SelectTrigger aria-label="Model" title="Model the driven session runs on">
        <SelectValue placeholder="Pick one" />
      </SelectTrigger>
      <SelectContent>
        {items.map((i) => (
          <SelectItem key={i.value} value={i.value}>
            {i.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

describe("Select primitive (mt#3347)", () => {
  afterEach(cleanup);

  test("trigger is a button carrying the aria-label, and shows the selected label", () => {
    renderSelect({ value: "sonnet" });
    const trigger = screen.getByRole("combobox", { name: "Model" });
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.textContent).toContain("Sonnet");
  });

  test("no value → placeholder renders", () => {
    renderSelect({});
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Pick one");
  });

  test("disabled trigger is non-interactive", () => {
    renderSelect({ value: "sonnet", disabled: true });
    const trigger = screen.getByRole("combobox", { name: "Model" }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(trigger.dataset.disabled).toBeDefined();
  });

  test("opening the panel exposes the items, and selecting one reports its value", () => {
    const seen: string[] = [];
    renderSelect({ value: "sonnet", onValueChange: (v) => seen.push(v) });

    const trigger = screen.getByRole("combobox", { name: "Model" });
    // Radix opens on keydown, not click, in a JSDOM-like environment: it gates
    // pointer events on pointer capture the happy-dom stub doesn't implement.
    fireEvent.keyDown(trigger, { key: "Enter" });

    const opus = screen.getByRole("option", { name: "Opus" });
    expect(opus).toBeDefined();

    fireEvent.click(opus);
    expect(seen).toEqual(["opus"]);
  });

  test("an empty-string item value does not round-trip as a real selection", () => {
    // Radix 2.3.7 ships no runtime guard against value="" (verified: zero
    // `Error` strings in the dist), but "" is how Radix spells "no value" —
    // an item with value="" cannot be distinguished from an unset Select, so
    // the placeholder wins over the item's own label. This is why the
    // migration replaced every native `<option value="">` with an explicit
    // sentinel rather than passing "" through.
    renderSelect({
      value: "",
      items: [
        { value: "", label: "All types" },
        { value: "project", label: "project" },
      ],
    });
    const trigger = screen.getByRole("combobox", { name: "Model" });
    expect(trigger.textContent).toContain("Pick one");
    expect(trigger.textContent).not.toContain("All types");
  });
});
