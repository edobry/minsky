/**
 * CopyId tests (mt#2943).
 */
import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CopyId } from "./CopyId";
import { entityToMinskyUri } from "../lib/entity-codec";

afterEach(cleanup);

const ASK_ID = "550e8400-e29b-41d4-a716-446655440000";

describe("CopyId", () => {
  test("renders a long id as truncated, selectable monospace text with the full id in the title", () => {
    render(<CopyId type="ask" id={ASK_ID} />);
    const idEl = screen.getByTitle(ASK_ID);
    expect(idEl.className).toContain("select-all");
    expect(idEl.className).toContain("font-mono");
    // Display is truncated (shortenId default 8 code points + ellipsis) — not the full 36-char UUID.
    expect(idEl.textContent).not.toBe(ASK_ID);
    expect(idEl.textContent?.endsWith("…")).toBe(true);
  });

  test("short ids (e.g. a task's mt#... id) are rendered in full, not force-truncated", () => {
    render(<CopyId type="task" id="mt#2410" />);
    const idEl = screen.getByTitle("mt#2410");
    expect(idEl.textContent).toBe("mt#2410");
  });

  test("trigger has an aria-label", () => {
    render(<CopyId type="ask" id={ASK_ID} />);
    expect(screen.getByRole("button", { name: "Copy ask id" })).toBeTruthy();
  });

  test("Copy ID writes the bare full id to the clipboard and toggles Copy -> Check feedback", async () => {
    const writeText = spyOn(navigator.clipboard, "writeText");
    render(<CopyId type="ask" id={ASK_ID} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy ask id" }));
    fireEvent.click(await screen.findByText("Copy ID"));

    expect(writeText).toHaveBeenCalledWith(ASK_ID);

    // Icon/label swap: "Copied" feedback renders transiently...
    await screen.findByText("Copied");
    // ...then reverts after ~2s (component's setTimeout(..., 2000)).
    await waitFor(() => expect(screen.queryByText("Copied")).toBeNull(), { timeout: 3000 });
  });

  test("Copy link writes the ask's minsky:// deeplink (percent-encoded uuid) to the clipboard", async () => {
    const writeText = spyOn(navigator.clipboard, "writeText");
    render(<CopyId type="ask" id={ASK_ID} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy ask id" }));
    fireEvent.click(await screen.findByText("Copy link"));

    const expected = entityToMinskyUri("ask", ASK_ID);
    expect(expected).toBe(`minsky://ask/${ASK_ID}`); // UUIDs need no percent-encoding
    expect(writeText).toHaveBeenCalledWith(expected);
    await screen.findByText("Copied");
  });

  test("Copy link for a task percent-encodes the '#' in the minsky:// deeplink", async () => {
    const writeText = spyOn(navigator.clipboard, "writeText");
    render(<CopyId type="task" id="mt#2410" />);

    fireEvent.click(screen.getByRole("button", { name: "Copy task id" }));
    fireEvent.click(await screen.findByText("Copy link"));

    expect(writeText).toHaveBeenCalledWith("minsky://task/mt%232410");
  });

  test("keyboard: Enter on the focused trigger opens the menu, Enter on the focused item activates it", async () => {
    const user = userEvent.setup();
    const writeText = spyOn(navigator.clipboard, "writeText");
    render(<CopyId type="ask" id={ASK_ID} />);

    const trigger = screen.getByRole("button", { name: "Copy ask id" });
    trigger.focus();
    await user.keyboard("{Enter}");

    const copyIdItem = await screen.findByText("Copy ID");
    copyIdItem.focus();
    await user.keyboard("{Enter}");

    expect(writeText).toHaveBeenCalledWith(ASK_ID);
  });
});
