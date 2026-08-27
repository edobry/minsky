/**
 * Tests for the agent-proposal confirm control (mt#3368).
 *
 * The load-bearing property: there is NO path from a proposal to a committed
 * payload that does not pass through an explicit click, and an option the ask
 * does not have never reaches `composeResolvePayload` at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { ResolveProposalCard, resolveProposalOption } from "./ResolveProposalCard";
import { composeResolvePayload, type AskItem } from "../widgets/AskDetail";

const BASE_ASK = {
  id: "ask-1",
  kind: "authorization.approve",
  state: "pending",
  title: "Approve the migration",
  question: "Should I run the backfill?",
  requestor: "agent",
  createdAt: new Date().toISOString(),
  windowMissedCount: 0,
  metadata: {},
} as unknown as AskItem;

function askWithOptions(labels: string[]): AskItem {
  return { ...BASE_ASK, options: labels.map((label) => ({ label })) } as AskItem;
}

// Renders accumulate in document.body otherwise, so `screen` queries would match
// elements from prior tests — the sibling EntityThreadPanel suite does the same.
afterEach(() => {
  cleanup();
});

describe("resolveProposalOption", () => {
  test("maps a letter to the ask's own option", () => {
    const ask = askWithOptions(["Run it", "Hold off", "Escalate"]);
    expect(resolveProposalOption(ask, "B")).toEqual({ index: 1, label: "Hold off" });
  });

  test("returns null for a letter past the end of the option list", () => {
    // The guard that matters: composeResolvePayload falls back to "" for an
    // out-of-range index, which is the silent empty-selection shape mt#3181
    // fixed one layer down. An unvalidated model-authored letter must never
    // reach it.
    expect(resolveProposalOption(askWithOptions(["Run it", "Hold off"]), "D")).toBeNull();
  });

  test("handles the implicit two-option shape of an authorization ask", () => {
    expect(resolveProposalOption(BASE_ASK, "A")).toEqual({ index: 0, label: "Approve" });
    expect(resolveProposalOption(BASE_ASK, "B")).toEqual({ index: 1, label: "Deny" });
    expect(resolveProposalOption(BASE_ASK, "C")).toBeNull();
  });

  test("an ask with neither options nor an implicit shape accepts no letter", () => {
    const bare = { ...BASE_ASK, kind: "information.retrieve" } as AskItem;
    expect(resolveProposalOption(bare, "A")).toBeNull();
  });
});

describe("ResolveProposalCard", () => {
  test("shows the option and commits nothing until the operator clicks", () => {
    // A collector rather than a single `let`: control-flow analysis narrows a
    // `let` initialized to null down to `null`, since it cannot see the callback run.
    const confirmed: string[] = [];
    const ask = askWithOptions(["Run it", "Hold off"]);
    render(
      <ResolveProposalCard
        ask={ask}
        proposal={{ optionLetter: "B", rationale: "the branch is stale" }}
        disabled={false}
        onConfirm={(letter) => confirmed.push(letter)}
      />
    );

    expect(screen.getByText(/B\) Hold off/)).toBeDefined();
    expect(screen.getByText("the branch is stale")).toBeDefined();
    // Rendering alone must not resolve anything.
    expect(confirmed).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: /confirm and answer/i }));
    expect(confirmed).toEqual(["B"]);
  });

  test("displays the EXACT payload that will be sent, not a paraphrase", () => {
    const ask = askWithOptions(["Run it", "Hold off"]);
    render(
      <ResolveProposalCard
        ask={ask}
        proposal={{ optionLetter: "A" }}
        disabled={false}
        onConfirm={() => {}}
      />
    );

    const expected = JSON.stringify(composeResolvePayload(ask, "A", "thread"), null, 2);
    expect(screen.getByLabelText("Proposed resolve payload").textContent).toBe(expected);
  });

  test("an option the ask does not have offers NO confirm button", () => {
    render(
      <ResolveProposalCard
        ask={askWithOptions(["Run it", "Hold off"])}
        proposal={{ optionLetter: "D" }}
        disabled={false}
        onConfirm={() => {}}
      />
    );

    expect(screen.getByText(/does not exist on this ask/)).toBeDefined();
    expect(screen.queryByRole("button", { name: /confirm and answer/i })).toBeNull();
  });

  test("confirm is disabled while another resolve is already in flight", () => {
    render(
      <ResolveProposalCard
        ask={askWithOptions(["Run it", "Hold off"])}
        proposal={{ optionLetter: "A" }}
        disabled={true}
        onConfirm={() => {}}
      />
    );

    const button = screen.getByRole("button", { name: /confirm and answer/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});

describe("ResolveProposalCard reports its own confirm (mt#4503)", () => {
  test("at rest the card promises nothing has been sent", () => {
    render(
      <ResolveProposalCard
        ask={askWithOptions(["Run it", "Hold off"])}
        proposal={{ optionLetter: "A" }}
        disabled={false}
        onConfirm={() => {}}
      />
    );

    expect(screen.getByText("Nothing is committed until you confirm.")).toBeDefined();
    expect(screen.queryByTestId("pending-spinner")).toBeNull();
  });

  test("confirming: the spinner is on the button and the reassurance is replaced", () => {
    render(
      <ResolveProposalCard
        ask={askWithOptions(["Run it", "Hold off"])}
        proposal={{ optionLetter: "A" }}
        disabled={true}
        confirming={true}
        onConfirm={() => {}}
      />
    );

    const button = screen.getByRole("button", { name: /confirm and answer/i });
    expect(button.querySelector('[data-testid="pending-spinner"]')).not.toBeNull();
    expect(button.getAttribute("aria-busy")).toBe("true");

    // "Nothing is committed until you confirm" stops being true the moment the
    // request is out. Leaving it up would tell the operator the opposite of
    // what is happening.
    expect(screen.queryByText("Nothing is committed until you confirm.")).toBeNull();
    expect(screen.getByText("Saving your response…")).toBeDefined();
  });

  test("disabled by a SIBLING action shows no spinner — only the clicked control claims to work", () => {
    // `disabled` is true whenever any resolve is in flight, including one the
    // detail panel's own option buttons started. This card must not borrow that
    // and claim the confirm is what is saving.
    render(
      <ResolveProposalCard
        ask={askWithOptions(["Run it", "Hold off"])}
        proposal={{ optionLetter: "A" }}
        disabled={true}
        confirming={false}
        onConfirm={() => {}}
      />
    );

    const button = screen.getByRole("button", { name: /confirm and answer/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.querySelector('[data-testid="pending-spinner"]')).toBeNull();
    expect(screen.getByText("Nothing is committed until you confirm.")).toBeDefined();
  });

  test("a failed confirm renders the reason in place", () => {
    render(
      <ResolveProposalCard
        ask={askWithOptions(["Run it", "Hold off"])}
        proposal={{ optionLetter: "A" }}
        disabled={false}
        error={new Error("resolve failed (409): Ask is in \"closed\" state")}
        onConfirm={() => {}}
      />
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Your response was not saved");
    expect(alert.textContent).toContain("409");
  });
});
