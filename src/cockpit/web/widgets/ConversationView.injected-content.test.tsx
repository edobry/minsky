/**
 * ConversationView injected-content rendering tests (mt#2791).
 *
 * Verifies the render-path integration of the injected-content detector
 * (../lib/injected-content.ts) inside ConversationView: harness-injected
 * command wrappers, skill-body preambles, and system-reminder blocks render
 * as collapsed, muted, origin-labeled blocks instead of raw XML/Markdown —
 * covering the spec's four acceptance fixtures plus the mixed-turn split and
 * the expand-all/collapse-all broadcast.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { INTERRUPTION_NOTICE_TEXT } from "@minsky/shared/minsky-notices";
import { ConversationView } from "./ConversationView";
import type {
  SessionContextSnapshot,
  SessionContextSnapshotBlock,
} from "@minsky/domain/context/types";

function createTestQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderCV(snapshot: SessionContextSnapshot) {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={createTestQueryClient()}>
        <ConversationView snapshot={snapshot} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function ts(index: number): string {
  return new Date(Date.UTC(2026, 6, 14, 12, 0, index)).toISOString();
}

function userTextBlock(index: number, text: string): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "user-prompt",
    source: "observed",
    content: { role: "user", content: [{ type: "text", text }] },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "user",
  };
}

/**
 * A user turn whose message content array carries MULTIPLE separate text
 * parts (mt#2791) — reproduces the real harness split verified against a
 * live transcript: a skill invocation's command-wrapper/skill-format
 * preamble arrives as one content-array text part, and the "Base directory
 * for this skill:" line + full body as the NEXT part, in the SAME message.
 */
function userMultiPartTextBlock(index: number, parts: string[]): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "user-prompt",
    source: "observed",
    content: { role: "user", content: parts.map((text) => ({ type: "text", text })) },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "user",
  };
}

function assistantTextBlock(index: number, text: string): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "assistant-text",
    source: "observed",
    content: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "assistant",
  };
}

function snapshotWithBlocks(blocks: SessionContextSnapshotBlock[]): SessionContextSnapshot {
  return {
    agentSessionId: "agent-injected-content-test",
    harness: "claude_code",
    blocks,
    assembledAt: "2026-07-14T12:00:00.000Z",
  };
}

/**
 * The rendered per-turn origin labels, in document order (mt#3374). Replaces
 * counting `"user"` labels as a proxy for "how many turn bubbles rendered" —
 * that proxy silently stopped being a turn count once harness turns started
 * carrying their own labels, and it asserted the misattribution besides.
 */
function turnLabels(): string[] {
  return screen.getAllByTestId("turn-role-label").map((el) => el.textContent ?? "");
}

describe("ConversationView — injected-content collapsing (mt#2791)", () => {
  afterEach(cleanup);

  test("fixture: slash-command opening turn renders one muted command block, not raw XML", () => {
    const { container } = renderCV(
      snapshotWithBlocks([
        userTextBlock(
          0,
          "<command-message>error-handling</command-message>\n<command-name>error-handling</command-name>"
        ),
      ])
    );

    // mt#3322 changed this block's PRESENTATION (not its purpose): a command
    // now renders in the terminal's shape — the prompt line `/error-handling`
    // with its raw markup behind the disclosure — instead of a collapsed
    // `command: error-handling` header. A command with captured stdout and one
    // without must look the same, so both go through the same element; the
    // mt#2791 guarantees this test exists for (no raw XML, collapsed by
    // default) are asserted below and unchanged.
    expect(screen.getByText("/error-handling")).toBeDefined();
    // Raw XML never leaks into the DOM text content.
    expect(container.textContent).not.toContain("<command-message>");
    expect(container.textContent).not.toContain("</command-message>");
    // Collapsed by default.
    const toggle = container.querySelector('button[aria-expanded]');
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  });

  test("fixture: skill-body injection renders a collapsed 'skill body: plan-task' block; expanding shows the full Markdown", () => {
    const body = "Drive a task through PLANNING: investigate the spec, surface gaps, run the gate check.";
    const { container } = renderCV(
      snapshotWithBlocks([
        userTextBlock(
          0,
          "<command-message>plan-task</command-message>\n" +
            "<command-name>plan-task</command-name>\n" +
            "<skill-format>true</skill-format>Base directory for this skill: /Users/edobry/Projects/minsky/.claude/skills/plan-task\n\n" +
            `# plan-task\n\n${body}`
        ),
      ])
    );

    expect(screen.getByText("skill body: plan-task")).toBeDefined();
    // Collapsed: the body markdown is not yet in the DOM.
    expect(screen.queryByText(new RegExp(body))).toBeNull();
    expect(container.textContent).not.toContain("<command-message>");

    fireEvent.click(screen.getByText("skill body: plan-task"));
    expect(screen.getByText(new RegExp(body))).toBeDefined();
  });

  test("real-harness split: a skill invocation arriving as TWO content-array text parts merges into ONE 'skill body:' block, no leaked <skill-format> tag (regression for live-verification bug)", () => {
    // Reproduces the exact structure captured from a live transcript
    // (agent-a812eb3483b89ec09): part 1 ends right after `</skill-format>`
    // with NO "Base directory..." in it; part 2 starts with "Base directory
    // for this skill:" and carries the full body — two SEPARATE entries in
    // the message's content array, not one concatenated string.
    const part1 =
      "<command-message>implement-task</command-message>\n<command-name>implement-task</command-name>\n<skill-format>true</skill-format>";
    const part2 =
      "Base directory for this skill: /Users/edobry/Projects/minsky/.claude/skills/implement-task\n\n# Implement Task\n\nStep-by-step implementation lifecycle.";
    const { container } = renderCV(snapshotWithBlocks([userMultiPartTextBlock(0, [part1, part2])]));

    // Exactly ONE injected block for the whole invocation, correctly
    // labeled "skill body:" (not split into a separate "command:" block).
    const toggles = container.querySelectorAll('button[aria-expanded]');
    expect(toggles).toHaveLength(1);
    expect(screen.getByText("skill body: implement-task")).toBeDefined();
    expect(screen.queryByText(/^command: implement-task$/)).toBeNull();

    // No raw wrapper tag leaks into the DOM as literal text at any point.
    expect(container.textContent).not.toContain("<command-message>");
    expect(container.textContent).not.toContain("<skill-format>");
    expect(container.textContent).not.toContain("</skill-format>");

    fireEvent.click(screen.getByText("skill body: implement-task"));
    expect(screen.getByText(/Step-by-step implementation lifecycle/)).toBeDefined();
  });

  test("fixture: <system-reminder> block renders a collapsed muted block", () => {
    renderCV(
      snapshotWithBlocks([
        userTextBlock(0, "<system-reminder>Background context injected by the harness.</system-reminder>"),
      ])
    );

    // Two elements now carry this text: the collapsed block's own header, and
    // the turn's origin label (mt#3374) — the turn is harness-authored, so it
    // no longer claims to be the operator's.
    expect(screen.getAllByText("system reminder").length).toBeGreaterThanOrEqual(1);
    expect(turnLabels()).toEqual(["system reminder"]);
    expect(screen.queryByText(/Background context injected/)).toBeNull();
  });

  test("fixture: plain user prose renders unchanged (no injected block, no collapsing)", () => {
    const { container } = renderCV(
      snapshotWithBlocks([userTextBlock(0, "Why does the reviewer bot keep timing out on large diffs?")])
    );

    expect(screen.getByText(/Why does the reviewer bot keep timing out/)).toBeDefined();
    expect(container.querySelector('button[aria-expanded]')).toBeNull();
  });

  test("a mixed turn (command wrapper + genuine prose) collapses only the injected span", () => {
    renderCV(
      snapshotWithBlocks([
        userTextBlock(
          0,
          "<command-message>error-handling</command-message>\n<command-name>error-handling</command-name>\nplease also check the retry logic"
        ),
      ])
    );

    // Command presentation per mt#3322 (see the fixture test above).
    expect(screen.getByText("/error-handling")).toBeDefined();
    // The genuine prose renders visibly, uncollapsed, alongside the injected block.
    expect(screen.getByText(/please also check the retry logic/)).toBeDefined();
  });

  test("assistant-role text is never treated as injected content, even if it contains the literal markers", () => {
    renderCV(
      snapshotWithBlocks([
        assistantTextBlock(
          0,
          "I saw a `<system-reminder>` tag in the transcript while investigating mt#2791."
        ),
      ])
    );

    // Rendered as plain prose (inline code span from the markdown backticks),
    // never collapsed behind a "system reminder" header.
    expect(screen.queryByText("system reminder")).toBeNull();
    expect(screen.getByText(/I saw a/)).toBeDefined();
  });

  test("expand all / collapse all broadcasts to injected-content blocks alongside tool-invocation blocks", () => {
    renderCV(
      snapshotWithBlocks([
        userTextBlock(0, "<system-reminder>internal context</system-reminder>"),
      ])
    );

    const toggle = () => screen.getByRole("button", { name: /system reminder/ });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByText("Expand all"));
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("internal context")).toBeDefined();

    fireEvent.click(screen.getByText("Collapse all"));
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });
});

// ── mt#3322: the three-turn slash-command render ────────────────────────────
//
// End-content regression for the originating incident: a single `/model`
// invocation rendered as THREE separate USER bubbles of raw harness XML above
// the operator's real message. Every fixture below is the verbatim payload
// from conversation 77c6ca4f, whose `content` is a plain STRING (as real
// harness lines are), not the content-array shape the mt#2791 helpers build.

const MODEL_CAVEAT_TEXT =
  "Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.";

/** A user turn whose `content` is a bare string — the real harness line shape. */
function userStringBlock(
  index: number,
  text: string,
  extra?: { isMeta?: boolean }
): SessionContextSnapshotBlock {
  return {
    id: `block-${index}`,
    type: "user-prompt",
    source: "observed",
    content: { role: "user", content: text },
    timestamp: ts(index),
    turnIndex: index,
    rawJsonlType: "user",
    ...(extra?.isMeta ? { isMeta: true } : {}),
  };
}

/** The wrapper group the harness emits for a slash command, command-name first. */
function commandWrapper(name: string): string {
  return (
    `<command-name>${name}</command-name>\n` +
    `            <command-message>${name.replace(/^\//, "")}</command-message>\n` +
    "            <command-args></command-args>"
  );
}

function commandStdout(text: string): string {
  return `<local-command-stdout>${text}</local-command-stdout>`;
}

/**
 * The three turns the harness emits for one `/model` invocation.
 *
 * **Ordering matters here and is NOT the JSONL file order.** In the
 * originating transcript the caveat is the FIRST line in the file but carries
 * the LATEST timestamp (.486, against .481 for both the command and the
 * stdout) — so once turns are ordered by timestamp the rendered group is
 * command -> stdout -> caveat. This fixture reproduces that order. An earlier
 * version used naive file order, which let a backward-only merge scan pass
 * this test while the caveat still rendered as a stray bubble in the real
 * cockpit.
 */
function modelCommandBlocks(startIndex = 0): SessionContextSnapshotBlock[] {
  return [
    userStringBlock(startIndex, commandWrapper("/model")),
    userStringBlock(
      startIndex + 1,
      commandStdout("Set model to \u001b[1mFable 5\u001b[22m for this session only")
    ),
    userStringBlock(
      startIndex + 2,
      `<local-command-caveat>${MODEL_CAVEAT_TEXT}</local-command-caveat>`,
      { isMeta: true }
    ),
  ];
}

describe("ConversationView — slash-command invocation rendering (mt#3322)", () => {
  afterEach(cleanup);

  test("a /model invocation renders the command and its result as visible text, not raw XML", () => {
    const { container } = renderCV(snapshotWithBlocks(modelCommandBlocks()));

    expect(screen.getByText("/model")).toBeDefined();
    expect(screen.getByText("Set model to Fable 5 for this session only")).toBeDefined();

    // No harness markup and no ANSI residue reaches the DOM.
    expect(container.textContent).not.toContain("<command-name>");
    expect(container.textContent).not.toContain("<command-args>");
    expect(container.textContent).not.toContain("<local-command-stdout>");
    expect(container.textContent).not.toContain("\u001b");
    expect(container.textContent).not.toContain("[1m");
  });

  test("the model-directed caveat is not shown as operator prose (but is not destroyed)", () => {
    const { container } = renderCV(snapshotWithBlocks(modelCommandBlocks()));

    // Collapsed by default — the caveat is addressed to the model, not the reader.
    expect(container.textContent).not.toContain("DO NOT respond to these messages");

    // Still reachable: expanding the command's disclosure reveals it, per the
    // mt#2791 contract that injected content is demoted, never dropped.
    const toggle = container.querySelector("button[aria-expanded]");
    expect(toggle).not.toBeNull();
    fireEvent.click(toggle as Element);
    expect(container.textContent).toContain("DO NOT respond to these messages");
  });

  test("the three harness turns collapse into ONE rendered turn, and operator prose is untouched", () => {
    const prose = "Okay, I want to think through this aspect of the system.";
    const { container } = renderCV(
      snapshotWithBlocks([...modelCommandBlocks(), userStringBlock(3, prose)])
    );

    // Two USER turns render: the merged command invocation, and the real
    // message. Before mt#3322 this was four (three raw-XML bubbles + prose).
    // Counted via the per-turn role label, which is what marks a turn bubble.
    // mt#3374: the labels are now per-ORIGIN, so the command turn says
    // `command` and only the operator's own message says `user` — counting
    // `user` labels would silently stop being a turn count.
    expect(turnLabels()).toEqual(["command", "user"]);

    expect(screen.getByText(prose)).toBeDefined();
  });

  // PR #2403 R1 (BLOCKING): the first implementation scanned a symmetric
  // +/-3-turn window and absorbed the first part of each kind it found, with
  // nothing tying a part to a specific command. Two commands in quick
  // succession could therefore cross-wire — one command's stdout attaching to
  // the other, and the wrong turn silently drained out of the render.
  test("two commands in quick succession keep their own output — no cross-wiring", () => {
    renderCV(
      snapshotWithBlocks([
        userStringBlock(0, commandWrapper("/model")),
        userStringBlock(1, commandStdout("Set model to Fable 5 for this session only")),
        userStringBlock(2, commandWrapper("/cost")),
        userStringBlock(3, commandStdout("Total cost: $1.23")),
      ])
    );

    // Both commands render, each with its OWN result, and nothing is dropped.
    expect(screen.getByText("/model")).toBeDefined();
    expect(screen.getByText("/cost")).toBeDefined();
    expect(screen.getByText("Set model to Fable 5 for this session only")).toBeDefined();
    expect(screen.getByText("Total cost: $1.23")).toBeDefined();
    // ONE label, not two (mt#3845): both turns are the same actor — harness,
    // origin `command` — so they share a run and its single header. The
    // no-cross-wiring property this test is about is carried by the four
    // assertions above, which show each command keeping its OWN output; the
    // label count was only ever a proxy for "two turns rendered", and turns are
    // no longer what carries a label.
    expect(turnLabels()).toEqual(["command"]);
  });

  test("a command with no output of its own does not steal a later command's output", () => {
    renderCV(
      snapshotWithBlocks([
        userStringBlock(0, commandWrapper("/clear")),
        userStringBlock(1, commandWrapper("/cost")),
        userStringBlock(2, commandStdout("Total cost: $1.23")),
      ])
    );

    // `/clear` must stop at the `/cost` wrapper rather than reaching past it.
    // Asserted on render ORDER: nothing between the two command prompts may
    // carry the output, and the output must appear after `/cost`.
    const text = document.body.textContent ?? "";
    const clearAt = text.indexOf("/clear");
    const costAt = text.indexOf("/cost");
    const outputAt = text.indexOf("Total cost: $1.23");

    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(costAt).toBeGreaterThan(clearAt);
    // The output belongs to `/cost`, so it renders after it — not between the
    // two commands, which is where a stolen output would land.
    expect(outputAt).toBeGreaterThan(costAt);
    // ONE label for the shared run (mt#3845) — see the sibling test above. The
    // output-stealing property is carried by the ORDER assertions, which are
    // unaffected by grouping.
    expect(turnLabels()).toEqual(["command"]);
  });

  test("a turn that is not a command part ends the group (operator prose is never absorbed)", () => {
    const prose = "wait, actually hold on";
    renderCV(
      snapshotWithBlocks([
        userStringBlock(0, commandWrapper("/model")),
        userStringBlock(1, prose),
        userStringBlock(2, commandStdout("Set model to Fable 5 for this session only")),
      ])
    );

    // The prose turn renders in full, and the stdout beyond it is NOT pulled
    // across it into the command element.
    expect(screen.getByText(prose)).toBeDefined();
    // Three turns, and each carries its true origin: the command, the
    // operator's interjection, and the orphaned stdout the command could not
    // absorb across it.
    expect(turnLabels()).toEqual(["command", "user", "command output"]);
  });
});

/**
 * mt#3396 — the two shapes mt#3374's live verification found still claiming to
 * be the operator's messages.
 *
 * `turnLabels()` is the load-bearing assertion: the render can show the harness
 * noun somewhere and STILL label the turn `user`, which is precisely the defect
 * (the label is what attributes authorship).
 */
describe("ConversationView — remaining harness-origin shapes (mt#3396)", () => {
  afterEach(cleanup);

  const TASK_NOTIFICATION_TURN = [
    "<task-notification>",
    "<task-id>bhlkh6oiq</task-id>",
    "<status>completed</status>",
    "<summary>Background shell command finished.</summary>",
    "</task-notification>",
  ].join("\n");

  test("AT4: a task-notification turn is labeled a task notification, never 'user'", () => {
    renderCV(snapshotWithBlocks([userTextBlock(0, TASK_NOTIFICATION_TURN)]));

    expect(turnLabels()).toEqual(["task notification"]);
    expect(screen.queryAllByText("user")).toHaveLength(0);
  });

  test("AT4: a resume-notice turn is labeled a session notice, never 'user'", () => {
    renderCV(snapshotWithBlocks([userTextBlock(0, INTERRUPTION_NOTICE_TEXT)]));

    expect(turnLabels()).toEqual(["session notice"]);
    expect(screen.queryAllByText("user")).toHaveLength(0);
  });

  test("neither shape leaks raw markup into the rendered text", () => {
    const { container } = renderCV(
      snapshotWithBlocks([userTextBlock(0, TASK_NOTIFICATION_TURN)])
    );
    expect(container.textContent).not.toContain("<task-notification>");
  });

  test("SC5: a turn mixing a notification with genuine prose still labels as the operator's", () => {
    // `classifyTurnOrigin`'s prose-wins rule, unchanged by this task — asserted
    // here because these new kinds are the first ones that could have broken
    // it, and a turn the operator actually contributed to is theirs.
    renderCV(
      snapshotWithBlocks([
        userTextBlock(0, `${TASK_NOTIFICATION_TURN}\nthanks — go ahead and merge it`),
      ])
    );

    expect(turnLabels()).toEqual(["user"]);
  });
});

describe("ConversationView — a notice turn with operator prose stays the operator's (PR #2515 R1)", () => {
  afterEach(cleanup);

  test("SC5 for the session notice: prose still wins", () => {
    renderCV(
      snapshotWithBlocks([
        userTextBlock(0, `${INTERRUPTION_NOTICE_TEXT}\nok, but check the merge queue first`),
      ])
    );

    expect(turnLabels()).toEqual(["user"]);
    expect(screen.getByText(/check the merge queue first/)).toBeDefined();
  });
});
