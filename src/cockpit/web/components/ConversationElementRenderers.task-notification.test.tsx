/**
 * Task-notification body rendering (mt#4419).
 *
 * A backgrounded MCP call's notification IS that call's deferred tool result,
 * so its `<result>` payload goes through `ToolPayload` — the same JSON tree,
 * and the same per-tool registry, an INLINE tool result has used since mt#2552.
 * Before this, only the deferred copy came through the injected-content path,
 * which prints its body verbatim.
 *
 * These tests drive the real pipeline end to end — `splitInjectedContent` on a
 * fixture taken from the stored turn behind the report, then the component —
 * rather than hand-building a span. A hand-built span would assert the
 * renderer against a shape the parser might not actually produce, which is the
 * seam this task's whole design constraint sits on.
 *
 * The PARSE half lives in `../lib/injected-content.test.ts`.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, cleanup, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { InjectedContentBlock } from "./ConversationElementRenderers";
import { TOOL_RESULT_RENDERERS } from "./ToolPayload";
import { buildEntityIndex } from "../lib/entity-linkifier";
import { splitInjectedContent, type InjectedSpan } from "../lib/injected-content";

afterEach(cleanup);

const EMPTY_INDEX = buildEntityIndex({ taskIds: [], sessionIds: [], askIds: [], memoryIds: [] });

const OPEN = "<task-notification>";
const CLOSE = "</task-notification>";

/** The real shape, from the stored turn behind the report (session 322e94eb, turnIndex 177). */
const MCP_NOTIFICATION = [
  OPEN,
  "<task-id>kef11dmwa</task-id>",
  "<status>completed</status>",
  "<summary>MCP task kef11dmw (minsky/session_commit) completed.</summary>",
  "<result>",
  '{ "success": true, "subject": "fix(mt#4342): ascend to the work tree",',
  '  "message": "the probe tested `&lt;repoPath&gt;/.git`, so a server started",',
  '  "branch": "task/mt-4342" }',
  "</result>",
  CLOSE,
].join("\n");

function spanOf(turn: string): InjectedSpan {
  const first = splitInjectedContent(turn)[0];
  if (first === undefined || first.type !== "injected") {
    throw new Error("fixture did not produce an injected segment");
  }
  return first.span;
}

/** Render the block and open it — the body only exists once expanded. */
function renderExpanded(turn: string) {
  const result = render(
    <MemoryRouter>
      <InjectedContentBlock
        span={spanOf(turn)}
        entityIndex={EMPTY_INDEX}
        expandSignal={undefined}
      />
    </MemoryRouter>
  );
  const toggle = result.container.querySelector("button");
  if (toggle === null) throw new Error("no disclosure toggle rendered");
  fireEvent.click(toggle);
  return result;
}

describe("task-notification body (mt#4419)", () => {
  test("AT1: a JSON result renders as an interactive tree, not as raw text", () => {
    const { container } = renderExpanded(MCP_NOTIFICATION);

    // The discriminator is BEHAVIOUR, not markup. An earlier version of this
    // test asserted `querySelector("pre")` was null and that the payload's text
    // appeared — and it passed with the feature disabled, because the prose path
    // renders no <pre> either and shows the same characters. What only a tree
    // can do is COLLAPSE: JsonView gives each object node a toggle, so the
    // block's own disclosure is the only button on the prose path.
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThan(1);

    expect(container.textContent).toContain("branch");
    expect(container.textContent).toContain("task/mt-4342");

    // Collapsing the root removes the leaves it was rendering — the tree is
    // driving the DOM, not decorating it.
    fireEvent.click(buttons[1] as HTMLButtonElement);
    expect(container.textContent).not.toContain("task/mt-4342");
  });

  test("AT1: the envelope's own elements do not render as literal tags", () => {
    const { container } = renderExpanded(MCP_NOTIFICATION);

    expect(container.textContent).not.toContain("<task-id>");
    expect(container.textContent).not.toContain("<result>");
    expect(container.textContent).not.toContain("</summary>");
  });

  test("AT2: the tool name reaches ToolPayload, so a per-tool renderer applies", () => {
    // The registry ships one entry (`tasks_list`) by mt#2552's recorded
    // principal direction, so there is no `session_commit` renderer to observe
    // firing — a stub is the only way to test that the lookup happens at all.
    // Without it, the generic tree renders either way and the assertion could
    // not distinguish "registry consulted" from "registry ignored".
    const MARKER = "per-tool renderer fired";
    TOOL_RESULT_RENDERERS.session_commit = () => <span>{MARKER}</span>;
    try {
      const { container } = renderExpanded(MCP_NOTIFICATION);
      expect(container.textContent).toContain(MARKER);
    } finally {
      delete TOOL_RESULT_RENDERERS.session_commit;
    }
  });

  test("AT3: a non-JSON result renders as its own text, NOT as envelope markup", () => {
    // Rewritten at PR #3245 R1. This test previously asserted the opposite —
    // that the whole body, tags included, came through on this path — which
    // locked in the exact defect the task exists to fix, on the one path nobody
    // would look at. `ToolPayload` renders non-JSON as a <pre>, so the payload
    // is still shown; what is gone is the markup around it.
    const notJson = MCP_NOTIFICATION.replace(
      /<result>[\s\S]*<\/result>/,
      "<result>the daemon exited before writing a payload</result>"
    );

    const { container } = renderExpanded(notJson);

    expect(container.querySelector("pre")?.textContent).toContain(
      "the daemon exited before writing a payload"
    );
    expect(container.textContent).not.toContain("<task-id>");
    expect(container.textContent).not.toContain("<result>");
    // The meta row still names the task, exactly as on the JSON path.
    expect(container.textContent).toContain("kef11dmwa");
  });

  test("AT4: a notification with no result renders its meta row, not its tags", () => {
    // The mt#3396 shape, which predates `<result>` entirely.
    const noResult = [
      OPEN,
      "<task-id>bhlkh6oiq</task-id>",
      "<status>completed</status>",
      "<summary>Background shell command finished.</summary>",
      CLOSE,
    ].join("\n");

    const { container } = renderExpanded(noResult);

    expect(container.textContent).toContain("bhlkh6oiq");
    expect(container.textContent).toContain("completed");
    expect(container.textContent).not.toContain("<task-id>");
    // No payload, so no result section is rendered at all.
    expect(container.textContent).not.toContain("RESULT");
  });

  test("a body the parse can make nothing of falls back to verbatim, never to blank", () => {
    // The floor: a degenerate envelope of empty modelled tags leaves every part
    // null, so there is no structure to render and the pre-mt#4419 path stands.
    const degenerate = [OPEN, "<status></status>", CLOSE].join("\n");

    const { container } = renderExpanded(degenerate);

    expect(container.textContent).toContain("<status>");
  });

  test("AT5: entity-escaped text inside the result renders decoded", () => {
    const { container } = renderExpanded(MCP_NOTIFICATION);

    expect(container.textContent).toContain("<repoPath>/.git");
    expect(container.textContent).not.toContain("&lt;");
  });

  test("the task id and status render as a meta row rather than as tags", () => {
    const { container } = renderExpanded(MCP_NOTIFICATION);

    expect(container.textContent).toContain("kef11dmwa");
    expect(container.textContent).toContain("completed");
  });

  test("an unmodelled element still reaches the reader beneath the tree", () => {
    // demote-never-drop (mt#2791) at the seam where a structured view could
    // silently lose a tag it has no slot for.
    const withExtra = MCP_NOTIFICATION.replace(
      "<task-id>kef11dmwa</task-id>",
      "<task-id>kef11dmwa</task-id>\n<tool-use-id>toolu_01Qbhg9</tool-use-id>"
    );

    const { container } = renderExpanded(withExtra);

    // Still the tree path (more than the block's own disclosure button)...
    expect(container.querySelectorAll("button").length).toBeGreaterThan(1);
    // ...and the element the parse does not model came through anyway.
    expect(container.textContent).toContain("toolu_01Qbhg9");
  });

  test("the body is not rendered at all while collapsed", () => {
    const { container } = render(
      <MemoryRouter>
        <InjectedContentBlock
          span={spanOf(MCP_NOTIFICATION)}
          entityIndex={EMPTY_INDEX}
          expandSignal={undefined}
        />
      </MemoryRouter>
    );

    expect(container.textContent).not.toContain("task/mt-4342");
    // The row itself still names which task finished (mt#4417).
    expect(container.textContent).toContain("session_commit");
  });
});
