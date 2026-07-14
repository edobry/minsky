/**
 * DrivenSessionComposer tests (mt#2751, Rung 2B).
 */
import { describe, test, expect, mock, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { DrivenSessionComposer } from "./DrivenSessionComposer";

afterEach(cleanup);

describe("DrivenSessionComposer", () => {
  test("submitting sends {\"text\":...} and clears the input", () => {
    const onSend = mock(() => {});
    render(<DrivenSessionComposer interactionState="awaiting-input" onSend={onSend} onStop={() => {}} />);

    const textarea = screen.getByLabelText("Message to the driven session") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "hello there" } });
    fireEvent.click(screen.getByText("Send"));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("hello there");
    expect(textarea.value).toBe("");
  });

  test("Enter (no shift) submits; Shift+Enter does not", () => {
    const onSend = mock(() => {});
    render(<DrivenSessionComposer interactionState="awaiting-input" onSend={onSend} onStop={() => {}} />);
    const textarea = screen.getByLabelText("Message to the driven session") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "line one" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("line one");
  });

  test("empty/whitespace-only text does not send", () => {
    const onSend = mock(() => {});
    render(<DrivenSessionComposer interactionState="awaiting-input" onSend={onSend} onStop={() => {}} />);
    const textarea = screen.getByLabelText("Message to the driven session") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.click(screen.getByText("Send"));
    expect(onSend).not.toHaveBeenCalled();
  });

  test("composer state reflects session state: input disabled while streaming, labeled accordingly", () => {
    render(<DrivenSessionComposer interactionState="streaming" onSend={() => {}} onStop={() => {}} />);
    const textarea = screen.getByLabelText("Message to the driven session") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(textarea.placeholder).toBe("Assistant is responding…");
    expect((screen.getByText("Send") as HTMLButtonElement).disabled).toBe(true);
  });

  test("composer state reflects session state: input and Stop both disabled once exited", () => {
    render(<DrivenSessionComposer interactionState="exited" onSend={() => {}} onStop={() => {}} />);
    const textarea = screen.getByLabelText("Message to the driven session") as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(true);
    expect(textarea.placeholder).toBe("Session has ended.");
    expect((screen.getByText("Stop") as HTMLButtonElement).disabled).toBe(true);
  });

  test("Stop button calls onStop while awaiting-input or streaming", () => {
    const onStop = mock(() => {});
    render(<DrivenSessionComposer interactionState="streaming" onSend={() => {}} onStop={onStop} />);
    fireEvent.click(screen.getByText("Stop"));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("Send stays disabled with empty input even when awaiting-input", () => {
    render(<DrivenSessionComposer interactionState="awaiting-input" onSend={() => {}} onStop={() => {}} />);
    expect((screen.getByText("Send") as HTMLButtonElement).disabled).toBe(true);
  });
});
