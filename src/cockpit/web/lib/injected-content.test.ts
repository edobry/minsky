/**
 * Tests for the injected-content detector (mt#2791).
 *
 * Covers the spec's four acceptance fixtures (slash-command opening turn,
 * skill-body injection, system-reminder block, plain user prose) plus the
 * mixed-turn split and multi-skill-concatenation cases.
 */
import { describe, expect, test } from "bun:test";
import {
  INTERRUPTION_NOTICE_PREFIX,
  INTERRUPTION_NOTICE_TEXT,
} from "@minsky/shared/minsky-notices";
import { splitInjectedContent } from "./injected-content";

// Reused across several fixtures below (the "error-handling" command-wrapper
// tests) — a shared constant, not a per-test literal, per
// custom/no-magic-string-duplication.
const ERROR_HANDLING_COMMAND_LABEL = "command: error-handling";

describe("splitInjectedContent — acceptance fixtures (mt#2791)", () => {
  test("fixture: slash-command opening turn -> one 'command: <name>' injected block, no raw XML leaks", () => {
    const input =
      "<command-message>error-handling</command-message>\n<command-name>error-handling</command-name>";
    const segments = splitInjectedContent(input);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      type: "injected",
      span: { kind: "command", label: ERROR_HANDLING_COMMAND_LABEL },
    });
    // Not raw XML in the label.
    expect((segments[0] as { span: { label: string } }).span.label).not.toContain("<");
  });

  test("fixture: skill-body injection -> collapsed 'skill body: <name>' block; content carries the full Markdown", () => {
    const body =
      "# plan-task\n\nDrive a task through PLANNING: investigate the spec, surface gaps, run the gate check.";
    const input =
      `<command-message>plan-task</command-message>\n` +
      `<command-name>plan-task</command-name>\n` +
      `<skill-format>true</skill-format>Base directory for this skill: /Users/edobry/Projects/minsky/.claude/skills/plan-task\n\n${
        body
      }`;
    const segments = splitInjectedContent(input);

    expect(segments).toHaveLength(1);
    const span = (
      segments[0] as { type: "injected"; span: { kind: string; label: string; content: string } }
    ).span;
    expect(span.kind).toBe("skill-body");
    expect(span.label).toBe("skill body: plan-task");
    // Expanding shows the full Markdown body (wrapper tags/preamble stripped).
    expect(span.content).toContain("# plan-task");
    expect(span.content).toContain("Drive a task through PLANNING");
    expect(span.content).not.toContain("<command-message>");
    expect(span.content).not.toContain("Base directory for this skill:");
  });

  test("fixture: standalone 'Base directory for this skill:' preamble (no command wrapper) -> skill-body block", () => {
    const input =
      "Base directory for this skill: /Users/edobry/Projects/minsky/.claude/skills/cockpit-design\n\n# cockpit-design\n\nMinsky-domain patterns.";
    const segments = splitInjectedContent(input);

    expect(segments).toHaveLength(1);
    const span = (segments[0] as { type: "injected"; span: { label: string; content: string } })
      .span;
    expect(span.label).toBe("skill body: cockpit-design");
    expect(span.content).toContain("# cockpit-design");
  });

  test("fixture: <system-reminder> block -> collapsed muted block", () => {
    const input = "<system-reminder>Background context injected by the harness.</system-reminder>";
    const segments = splitInjectedContent(input);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      type: "injected",
      span: {
        kind: "system-reminder",
        label: "system reminder",
        content: "Background context injected by the harness.",
      },
    });
  });

  test("fixture: plain user prose -> unchanged rendering (single verbatim prose segment)", () => {
    const input = "Why does the reviewer bot keep timing out on large diffs?";
    const segments = splitInjectedContent(input);

    expect(segments).toEqual([{ type: "prose", text: input }]);
  });
});

describe("splitInjectedContent — mixed turns (injected span collapses, prose does not)", () => {
  test("command wrapper followed by genuine operator prose splits into two segments", () => {
    const input =
      "<command-message>error-handling</command-message>\n<command-name>error-handling</command-name>\nplease also check the retry logic";
    const segments = splitInjectedContent(input);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ type: "injected", span: { kind: "command" } });
    expect(segments[1]?.type).toBe("prose");
    expect((segments[1] as { text: string }).text).toContain("please also check the retry logic");
  });

  test("system-reminder interleaved with real prose keeps the prose visible, only the reminder collapses", () => {
    const input =
      "some earlier context\n<system-reminder>internal injection</system-reminder>\nWhy is the build failing?";
    const segments = splitInjectedContent(input);

    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ type: "prose", text: "some earlier context\n" });
    expect(segments[1]).toMatchObject({
      type: "injected",
      span: { kind: "system-reminder", content: "internal injection" },
    });
    expect(segments[2]).toEqual({ type: "prose", text: "\nWhy is the build failing?" });
  });

  test("multiple system-reminder blocks in one turn each collapse independently", () => {
    const input =
      "<system-reminder>first</system-reminder><system-reminder>second</system-reminder>";
    const segments = splitInjectedContent(input);

    expect(segments).toHaveLength(2);
    expect(segments.every((s) => s.type === "injected")).toBe(true);
    expect((segments[0] as { span: { content: string } }).span.content).toBe("first");
    expect((segments[1] as { span: { content: string } }).span.content).toBe("second");
  });

  test("whitespace-only gaps between reminder blocks are dropped — behaviorally identical to today (PR #1968 R1)", () => {
    // A whitespace-only prose segment renders as NOTHING regardless: the
    // ConversationView consumer trims prose segments before pushing, and
    // <Prose> itself returns null for whitespace-only input. Dropping the
    // gap here is therefore not a rendering change; this test pins the
    // contract so a future consumer that stops trimming re-evaluates it.
    const input =
      "<system-reminder>first</system-reminder>\n\n  \n<system-reminder>second</system-reminder>";
    const segments = splitInjectedContent(input);

    expect(segments).toHaveLength(2);
    expect(segments.every((s) => s.type === "injected")).toBe(true);
  });

  test("two skills concatenated in one turn split into two separate skill-body blocks", () => {
    const skillA =
      "<command-message>cockpit-design</command-message>\n<command-name>cockpit-design</command-name>\n<skill-format>true</skill-format>Base directory for this skill: /a/.claude/skills/cockpit-design\n\nBody A content here.\n\n";
    const skillB =
      "<command-message>composition-patterns</command-message>\n<command-name>composition-patterns</command-name>\n<skill-format>true</skill-format>Base directory for this skill: /a/.claude/skills/composition-patterns\n\nBody B content here.";
    const segments = splitInjectedContent(skillA + skillB);

    expect(segments).toHaveLength(2);
    expect((segments[0] as { span: { label: string; content: string } }).span.label).toBe(
      "skill body: cockpit-design"
    );
    expect((segments[0] as { span: { content: string } }).span.content).toContain(
      "Body A content here."
    );
    expect((segments[0] as { span: { content: string } }).span.content).not.toContain("Body B");
    expect((segments[1] as { span: { label: string; content: string } }).span.label).toBe(
      "skill body: composition-patterns"
    );
    expect((segments[1] as { span: { content: string } }).span.content).toContain(
      "Body B content here."
    );
  });
});

describe("splitInjectedContent — conservative-detection edge cases", () => {
  test("empty string returns no segments", () => {
    expect(splitInjectedContent("")).toEqual([]);
  });

  test("mid-sentence mention of 'Base directory for this skill:' (not turn-anchored) is NOT detected", () => {
    const input = "the docs say Base directory for this skill: is set via an env var, fyi";
    const segments = splitInjectedContent(input);
    expect(segments).toEqual([{ type: "prose", text: input }]);
  });

  test("an attribute-bearing / whitespace-padded command-message tag still matches (harness-casing tolerance)", () => {
    const input = '<command-message kind="slash" >error-handling</command-message>';
    const segments = splitInjectedContent(input);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      type: "injected",
      span: { kind: "command", label: ERROR_HANDLING_COMMAND_LABEL },
    });
  });

  test("command-message tag matches case-insensitively", () => {
    const input =
      "<Command-Message>error-handling</Command-Message>\n<Command-Name>error-handling</Command-Name>";
    const segments = splitInjectedContent(input);
    expect(segments).toHaveLength(1);
    expect((segments[0] as { span: { label: string } }).span.label).toBe(
      ERROR_HANDLING_COMMAND_LABEL
    );
  });

  test("command-name content wins over command-message content when they differ", () => {
    const input =
      "<command-message>raw-slug</command-message>\n<command-name>friendly-name</command-name>";
    const segments = splitInjectedContent(input);
    expect((segments[0] as { span: { label: string } }).span.label).toBe("command: friendly-name");
  });
});

// ── mt#3322: wrapper-order tolerance, local-command blocks, ANSI stripping ───
//
// Every fixture below is copied from a real transcript line. Before mt#3322
// the detector matched only the `command-message`-first ordering, so a corpus
// survey found 124 of 134 turn-start command wrappers, all 118
// `local-command-stdout` turns, and all 125 `local-command-caveat` turns
// falling through to the prose path and rendering as raw XML.

/** Verbatim `/model` wrapper from conversation 77c6ca4f (command-name FIRST). */
const MODEL_COMMAND_WRAPPER =
  "<command-name>/model</command-name>\n" +
  "            <command-message>model</command-message>\n" +
  "            <command-args></command-args>";

/** Verbatim `/model` stdout, ANSI SGR bytes included. */
const MODEL_COMMAND_STDOUT =
  "<local-command-stdout>Set model to \u001b[1mFable 5\u001b[22m for this session only</local-command-stdout>";

function firstSpan(input: string): { kind: string; label: string; content: string } {
  const segments = splitInjectedContent(input);
  const segment = segments[0];
  if (!segment || segment.type !== "injected") {
    throw new Error(`expected an injected first segment, got: ${JSON.stringify(segments[0])}`);
  }
  return segment.span;
}

describe("splitInjectedContent — wrapper-order tolerance (mt#3322)", () => {
  test("command-name-FIRST wrapper is detected (the 124-of-134 corpus majority)", () => {
    const segments = splitInjectedContent(MODEL_COMMAND_WRAPPER);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      type: "injected",
      span: { kind: "command", label: "command: /model" },
    });
  });

  test("command-message-FIRST wrapper still matches (pre-mt#3322 regression check)", () => {
    const span = firstSpan(
      "<command-message>error-handling</command-message>\n<command-name>error-handling</command-name>"
    );
    expect(span.kind).toBe("command");
    expect(span.label).toBe(ERROR_HANDLING_COMMAND_LABEL);
  });

  test("skill body is still detected when the wrapper leads with command-name", () => {
    const span = firstSpan(
      "<command-name>plan-task</command-name>\n" +
        "<command-message>plan-task</command-message>\n" +
        "<skill-format>true</skill-format>" +
        "Base directory for this skill: /Users/edobry/Projects/minsky/.claude/skills/plan-task\n\n" +
        "# plan-task\n\nDrive a task through PLANNING."
    );
    expect(span.kind).toBe("skill-body");
    expect(span.label).toBe("skill body: plan-task");
    expect(span.content).toContain("Drive a task through PLANNING");
  });

  test("no raw wrapper XML survives into the rendered label or a prose segment", () => {
    const segments = splitInjectedContent(MODEL_COMMAND_WRAPPER);
    expect(segments.filter((s) => s.type === "prose")).toHaveLength(0);
    expect(firstSpan(MODEL_COMMAND_WRAPPER).label).not.toContain("<");
  });
});

describe("splitInjectedContent — local-command blocks (mt#3322)", () => {
  test("local-command-stdout becomes an injected span, not prose", () => {
    const span = firstSpan(MODEL_COMMAND_STDOUT);
    expect(span.kind).toBe("local-command-output");
    expect(span.label).toBe("command output");
  });

  test("ANSI escape bytes are stripped from the rendered stdout content", () => {
    const span = firstSpan(MODEL_COMMAND_STDOUT);
    expect(span.content).toBe("Set model to Fable 5 for this session only");
    expect(span.content).not.toContain("\u001b");
    // The visible bracket-digit residue an unstripped escape leaves behind.
    expect(span.content).not.toContain("[1m");
  });

  test("local-command-caveat becomes an injected span, not operator prose", () => {
    const span = firstSpan(
      "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.</local-command-caveat>"
    );
    expect(span.kind).toBe("local-command-caveat");
    expect(span.label).toBe("harness caveat");
    expect(span.content).toContain("DO NOT respond to these messages");
  });
});

describe("splitInjectedContent — conservative matching preserved (mt#3322)", () => {
  test("prose merely MENTIONING a wrapper tag mid-sentence is returned verbatim", () => {
    const input = "I was reading about <command-message> tags in the harness docs today.";
    const segments = splitInjectedContent(input);
    expect(segments).toEqual([{ type: "prose", text: input }]);
  });

  test("prose mentioning a local-command tag mid-sentence is returned verbatim", () => {
    const input = "The <local-command-stdout> wrapper is what carries the terminal output.";
    const segments = splitInjectedContent(input);
    expect(segments).toEqual([{ type: "prose", text: input }]);
  });

  test("ANSI stripping never touches operator prose", () => {
    const input = "Use \u001b[1m to start bold in a terminal.";
    const segments = splitInjectedContent(input);
    expect(segments).toEqual([{ type: "prose", text: input }]);
  });

  test("a wrapper followed by operator prose splits into injected + prose", () => {
    const prose = "\nOkay, now do the thing.";
    const segments = splitInjectedContent(MODEL_COMMAND_WRAPPER + prose);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ type: "injected", span: { kind: "command" } });
    expect(segments[1]).toEqual({ type: "prose", text: prose });
  });
});

/**
 * mt#3396 — two more harness-origin turn shapes.
 *
 * Both had been rendering under the operator's `user` label: nothing detected
 * them as injected, so `classifyTurnOrigin` saw a non-empty `text` element and
 * correctly (given its inputs) called it operator prose.
 */
describe("splitInjectedContent — task notifications (mt#3396 AT1)", () => {
  // Envelope pieces every fixture in this block shares. Named rather than
  // repeated so a harness tag rename is one edit, not a hunt through fixtures
  // (`custom/no-magic-string-duplication`).
  const OPEN = "<task-notification>";
  const CLOSE = "</task-notification>";
  const STATUS_COMPLETED = "<status>completed</status>";

  // The real on-disk shape, from the local transcript corpus: 48 turns carry
  // this tag and all 48 are role `user`.
  const TASK_NOTIFICATION_TURN = [
    OPEN,
    "<task-id>bhlkh6oiq</task-id>",
    "<tool-use-id>toolu_01Qbhg9FEjEW6VENjy6hGRmH</tool-use-id>",
    STATUS_COMPLETED,
    "<summary>Background shell command finished.</summary>",
    CLOSE,
  ].join("\n");

  test("a turn-start <task-notification> block is ONE injected segment of the new kind", () => {
    const segments = splitInjectedContent(TASK_NOTIFICATION_TURN);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      type: "injected",
      span: {
        kind: "task-notification",
        // mt#4417: the row names WHICH task finished. Before, every notification
        // in the transcript carried the identical fixed noun, so telling them
        // apart meant opening each one.
        label: "task notification: Background shell command finished. (completed)",
      },
    });
  });

  test("the block's body is preserved for the expand view", () => {
    const segments = splitInjectedContent(TASK_NOTIFICATION_TURN);
    const span = (segments[0] as { span: { content: string } }).span;
    expect(span.content).toContain("bhlkh6oiq");
    expect(span.content).toContain("Background shell command finished.");
  });

  // ── mt#4417 ────────────────────────────────────────────────────────────────
  //
  // The shape that prompted the report: an MCP task's notification carries a
  // `<result>` element holding the tool's entire JSON payload. Taken verbatim
  // from the stored turn behind it (session 322e94eb, turnIndex 177), including
  // the `&lt;` the harness escaped into the commit body.
  //
  // The summary is named so the several tests that swap it out cannot drift
  // from the fixture that defines it (`custom/no-magic-string-duplication`).
  const MCP_SUMMARY = "MCP task kef11dmw (minsky/session_commit) completed.";
  const MCP_SUMMARY_TAG = `<summary>${MCP_SUMMARY}</summary>`;

  // The result line the decode and decoy tests both reach for, named so the
  // three sites cannot drift (`custom/no-magic-string-duplication`).
  const MCP_RESULT_MESSAGE_LINE =
    '  "message": "the probe tested `&lt;repoPath&gt;/.git`, so a server started",';

  const MCP_TASK_NOTIFICATION_TURN = [
    OPEN,
    "<task-id>kef11dmwa</task-id>",
    STATUS_COMPLETED,
    MCP_SUMMARY_TAG,
    "<result>",
    '{ "success": true, "subject": "fix(mt#4342): ascend to the work tree",',
    MCP_RESULT_MESSAGE_LINE,
    '  "branch": "task/mt-4342" }',
    "</result>",
    CLOSE,
  ].join("\n");

  test("an MCP task's row names the tool, drawn from the harness's own summary", () => {
    const span = (
      splitInjectedContent(MCP_TASK_NOTIFICATION_TURN)[0] as { span: { label: string } }
    ).span;

    expect(span.label).toBe(`task notification: ${MCP_SUMMARY}`);
  });

  test("the status is not repeated when the summary already carries it", () => {
    const span = (
      splitInjectedContent(MCP_TASK_NOTIFICATION_TURN)[0] as { span: { label: string } }
    ).span;

    // "completed" appears once, in the harness's sentence — not again in parens.
    expect(span.label.match(/completed/g)).toHaveLength(1);
  });

  test("a status the summary does NOT carry is appended — the case worth seeing", () => {
    const failed = MCP_TASK_NOTIFICATION_TURN.replace(
      STATUS_COMPLETED,
      "<status>failed</status>"
    ).replace(
      MCP_SUMMARY_TAG,
      "<summary>MCP task kef11dmw (minsky/session_commit) finished.</summary>"
    );

    const span = (splitInjectedContent(failed)[0] as { span: { label: string } }).span;

    expect(span.label).toContain("(failed)");
  });

  test("a notification with no summary falls back to the fixed noun", () => {
    const noSummary = [OPEN, "<task-id>abc123</task-id>", STATUS_COMPLETED, CLOSE].join("\n");

    const span = (splitInjectedContent(noSummary)[0] as { span: { label: string } }).span;

    expect(span.label).toBe("task notification");
  });

  test("a long summary is bounded and marked, so it cannot push the row off screen", () => {
    const long = MCP_TASK_NOTIFICATION_TURN.replace(
      MCP_SUMMARY,
      `MCP task ${"x".repeat(200)} completed.`
    );

    const span = (splitInjectedContent(long)[0] as { span: { label: string } }).span;

    expect(span.label.length).toBeLessThan(100);
    expect(span.label.endsWith("…")).toBe(true);
    // Truncated from the HEAD: the words identifying the task lead.
    expect(span.label).toContain("task notification: MCP task xxx");
  });

  test("entity-escaped text renders as the characters it encodes", () => {
    const span = (
      splitInjectedContent(MCP_TASK_NOTIFICATION_TURN)[0] as { span: { content: string } }
    ).span;

    expect(span.content).toContain("`<repoPath>/.git`");
    expect(span.content).not.toContain("&lt;");
    expect(span.content).not.toContain("&gt;");
  });

  test("`&amp;` decodes last, so an escaped entity survives as an entity", () => {
    // `&amp;lt;` encodes the literal text `&lt;`. Decoding `&amp;` first would
    // collapse it to `<` and lose what the source actually said.
    const escaped = MCP_TASK_NOTIFICATION_TURN.replace(
      "&lt;repoPath&gt;",
      "&amp;lt;literal&amp;gt;"
    );

    const span = (splitInjectedContent(escaped)[0] as { span: { content: string } }).span;

    expect(span.content).toContain("&lt;literal&gt;");
    expect(span.content).not.toContain("<literal>");
  });

  test("a body with no entities is returned unchanged", () => {
    const span = (splitInjectedContent(TASK_NOTIFICATION_TURN)[0] as { span: { content: string } })
      .span;

    expect(span.content).toContain("<task-id>bhlkh6oiq</task-id>");
  });

  // ── PR #3239 R1 ────────────────────────────────────────────────────────────
  //
  // The label is derived from the UNDECODED body, because decoding manufactures
  // tags. A commit message quoting an XML tag arrives inside `<result>` as
  // `&lt;summary&gt;…&lt;/summary&gt;`; decode first and it becomes a REAL
  // `<summary>` element that the label's tag scan cannot distinguish from the
  // envelope's own.
  const ESCAPED_SUMMARY_IN_RESULT =
    '  "message": "the spec says &lt;summary&gt;not this one&lt;/summary&gt; and ' +
    '&lt;status&gt;failed&lt;/status&gt;",';

  test("an escaped <summary> inside the result does not displace the envelope's own", () => {
    const withDecoy = MCP_TASK_NOTIFICATION_TURN.replace(
      MCP_RESULT_MESSAGE_LINE,
      ESCAPED_SUMMARY_IN_RESULT
    );

    const span = (splitInjectedContent(withDecoy)[0] as { span: { label: string } }).span;

    expect(span.label).toBe(`task notification: ${MCP_SUMMARY}`);
    expect(span.label).not.toContain("not this one");
  });

  test("an escaped <summary> is not promoted when the envelope carries NO summary", () => {
    // The case that would actually have broken: with no real `<summary>` to win
    // the first-match race, a decoded decoy is the ONLY candidate — so the row
    // would have been labeled with a fragment of a commit message.
    const noSummaryWithDecoy = [
      OPEN,
      "<task-id>kef11dmwa</task-id>",
      STATUS_COMPLETED,
      "<result>",
      ESCAPED_SUMMARY_IN_RESULT,
      "</result>",
      CLOSE,
    ].join("\n");

    const span = (splitInjectedContent(noSummaryWithDecoy)[0] as { span: { label: string } }).span;

    expect(span.label).toBe("task notification");
  });

  test("the summary's own entities still decode — structure is raw, leaves are not", () => {
    // Reading structure from the raw body must not cost the row its decoding:
    // the summary is prose the harness escaped on the way into its envelope.
    const escapedSummary = MCP_TASK_NOTIFICATION_TURN.replace(
      MCP_SUMMARY_TAG,
      "<summary>MCP task read &lt;repoPath&gt;/.git completed.</summary>"
    );

    const span = (splitInjectedContent(escapedSummary)[0] as { span: { label: string } }).span;

    expect(span.label).toContain("<repoPath>/.git");
    expect(span.label).not.toContain("&lt;");
  });

  // ── mt#4419 — the envelope, taken apart ────────────────────────────────────
  //
  // The span now carries structured parts so the renderer can put the tool's
  // payload through the same JSON tree an inline tool result gets. These assert
  // the PARSE; the render half lives in
  // `../components/ConversationElementRenderers.task-notification.test.tsx`.

  function partsOf(turn: string) {
    const span = (splitInjectedContent(turn)[0] as { span: { notification?: unknown } }).span;
    return span.notification as {
      taskId: string | null;
      status: string | null;
      summary: string | null;
      toolName: string | null;
      result: string | null;
      remainder: string | null;
    };
  }

  test("the envelope's four modelled elements are carried on the span", () => {
    const parts = partsOf(MCP_TASK_NOTIFICATION_TURN);

    expect(parts.taskId).toBe("kef11dmwa");
    expect(parts.status).toBe("completed");
    expect(parts.summary).toBe(MCP_SUMMARY);
    expect(parts.result).toContain('"success": true');
  });

  test("the tool name is recovered from the summary, BARE — the form the registry keys on", () => {
    // `minsky/session_commit` → `session_commit`. Unsplit, it would never match
    // a registered per-tool renderer, and would do so silently.
    expect(partsOf(MCP_TASK_NOTIFICATION_TURN).toolName).toBe("session_commit");
  });

  test("a summary naming no tool yields no tool name, rather than a guess", () => {
    // The mt#3396 shape: a background shell command, no parenthesised tool.
    expect(partsOf(TASK_NOTIFICATION_TURN).toolName).toBeNull();
  });

  test("an ordinary parenthetical is NOT read as a tool name (PR #3245 R1)", () => {
    // The `server/tool` slash form is required. A wrong match would silently
    // invoke some other tool's renderer on this payload; no match falls through
    // to the generic tree, which is a perfectly good rendering. So an aside in
    // the summary must not be mistaken for a tool.
    const aside = MCP_TASK_NOTIFICATION_TURN.replace(
      MCP_SUMMARY_TAG,
      "<summary>Background task finished (retried once) and wrote its output.</summary>"
    );

    expect(partsOf(aside).toolName).toBeNull();
  });

  test("a parenthetical with more than one slash is not a tool name either", () => {
    const pathLike = MCP_TASK_NOTIFICATION_TURN.replace(
      MCP_SUMMARY_TAG,
      "<summary>MCP task abc (a/b/c) completed.</summary>"
    );

    expect(partsOf(pathLike).toolName).toBeNull();
  });

  test("an unmodelled element survives as the remainder — nothing is dropped", () => {
    // mt#2791's demote-never-drop contract, at the seam where a structured view
    // could silently lose a tag it has no slot for. `<tool-use-id>` is the one
    // in today's corpus; the point is the mechanism, not that tag.
    const parts = partsOf(TASK_NOTIFICATION_TURN);

    expect(parts.remainder).toContain("toolu_01Qbhg9FEjEW6VENjy6hGRmH");
  });

  test("a body the four elements fully account for leaves no remainder", () => {
    expect(partsOf(MCP_TASK_NOTIFICATION_TURN).remainder).toBeNull();
  });

  test("the result's escaped entities are decoded", () => {
    const parts = partsOf(MCP_TASK_NOTIFICATION_TURN);

    expect(parts.result).toContain("`<repoPath>/.git`");
    expect(parts.result).not.toContain("&lt;");
  });

  test("the parts are read from the RAW body — an escaped tag in the result cannot displace one", () => {
    // The same hazard PR #3239 R1 fixed for the label, now for the parts: decode
    // first and `&lt;summary&gt;…&lt;/summary&gt;` inside the payload becomes a
    // real element the tag scan cannot distinguish from the envelope's own.
    const withDecoy = MCP_TASK_NOTIFICATION_TURN.replace(
      MCP_RESULT_MESSAGE_LINE,
      ESCAPED_SUMMARY_IN_RESULT
    );

    const parts = partsOf(withDecoy);

    expect(parts.summary).toBe(MCP_SUMMARY);
    expect(parts.status).toBe("completed");
    expect(parts.toolName).toBe("session_commit");
  });

  test("no parts are attached to a span of a different kind", () => {
    // The field is opt-in per tag: a bash block declares no extractor, so its
    // span carries nothing and the renderer takes the unchanged prose path.
    const bash = "<bash-input>ls -la</bash-input>";
    const span = (splitInjectedContent(bash)[0] as { span: { notification?: unknown } }).span;

    expect(span.notification).toBeUndefined();
  });

  test("AT3 anchoring: prose mentioning the tag mid-sentence is NOT split", () => {
    // The conservatism the module's design depends on — an agent discussing the
    // tag must not have its own message reattributed to the harness.
    const input = "The <task-notification> block is what the harness emits on completion.";
    expect(splitInjectedContent(input)).toEqual([{ type: "prose", text: input }]);
  });
});

describe("splitInjectedContent — the resume notice (mt#3396 AT2)", () => {
  test("a turn carrying the notice is ONE injected segment labeled as a session notice", () => {
    const segments = splitInjectedContent(INTERRUPTION_NOTICE_TEXT);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      type: "injected",
      span: { kind: "session-notice", label: "session notice" },
    });
  });

  test("it is labeled a SESSION notice, not a harness one", () => {
    // Minsky wrote this text. Calling it "harness" would layer a second
    // misattribution on the one this task removes.
    const span = (splitInjectedContent(INTERRUPTION_NOTICE_TEXT)[0] as { span: { label: string } })
      .span;
    expect(span.label).not.toContain("harness");
  });

  test("AT3 anchoring: prose quoting the notice mid-sentence is NOT split", () => {
    const input = `I saw the banner — it said "${INTERRUPTION_NOTICE_PREFIX}" — so I re-checked.`;
    expect(splitInjectedContent(input)).toEqual([{ type: "prose", text: input }]);
  });

  test("the detector's anchor tracks the notice text, so a reword cannot silently disable it", () => {
    // The drift guard. `matchSessionNotice` anchors on the PREFIX; if the
    // notice's opening is reworded without updating the prefix, detection
    // breaks silently. This makes that a test failure instead.
    expect(INTERRUPTION_NOTICE_TEXT.startsWith(INTERRUPTION_NOTICE_PREFIX)).toBe(true);
  });
});

describe("splitInjectedContent — the notice never swallows operator prose (mt#3396, PR #2515 R1)", () => {
  test("a notice followed by operator prose splits into injected + prose", () => {
    // The first cut consumed the whole turn on the reasoning that the notice is
    // always sent alone. That made correctness depend on the SENDER rather than
    // on the text, and would have relabeled the operator's own words as
    // harness-origin — the worst direction for this particular span, since it
    // is Minsky's label the prose would disappear under.
    const prose = "\nok, but check the merge queue first";
    const segments = splitInjectedContent(INTERRUPTION_NOTICE_TEXT + prose);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ type: "injected", span: { kind: "session-notice" } });
    expect(segments[1]).toEqual({ type: "prose", text: prose });
  });

  test("the span content stops at the notice, carrying none of the prose", () => {
    const segments = splitInjectedContent(`${INTERRUPTION_NOTICE_TEXT}\nunrelated operator text`);
    const span = (segments[0] as { span: { content: string } }).span;
    expect(span.content).not.toContain("unrelated operator text");
    expect(span.content).toBe(INTERRUPTION_NOTICE_TEXT);
  });
});

describe("splitInjectedContent — notice with leading whitespace (PR #2515 R2)", () => {
  test("a leading newline does not produce a zero-length span", () => {
    // The guard tests `trimStart()`, so this matched; scanning the RAW text for
    // the first newline then found the LEADING one and consumed nothing,
    // silently disabling detection for the turn.
    const segments = splitInjectedContent(`\n${INTERRUPTION_NOTICE_TEXT}`);

    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      type: "injected",
      span: { kind: "session-notice", content: INTERRUPTION_NOTICE_TEXT },
    });
  });

  test("leading whitespace AND trailing prose still split correctly", () => {
    const prose = "\nand then merge it";
    const segments = splitInjectedContent(`\n  ${INTERRUPTION_NOTICE_TEXT}${prose}`);

    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ type: "injected", span: { kind: "session-notice" } });
    expect(segments[1]).toEqual({ type: "prose", text: prose });
  });
});

// ── mt#4058: bash-mode turns (`!`-prefixed commands) ────────────────────────
//
// Both fixtures below are copied from real transcript lines. Before mt#4058
// neither tag was in the inventory, so both turns fell to the verbatim-prose
// path: the principal's screenshot showed `<bash-input>minsky cockpit open`
// and `<bash-stdout>OPENED …</bash-stdout><bash-stderr></bash-stderr>` as two
// consecutive turns rendered under the OPERATOR's own label.

/** Verbatim, from the originating screenshot (conversation efb04b87). */
const BASH_INPUT_TURN = "<bash-input> minsky cockpit open</bash-input>";

/** Verbatim: the output pair arrives concatenated, stderr empty. */
const BASH_OUTPUT_TURN =
  "<bash-stdout>OPENED minsky://conversation/efb04b87-61e2-45b0-a63f-72092d1d3cf8</bash-stdout>" +
  "<bash-stderr></bash-stderr>";

describe("splitInjectedContent — bash-mode family (mt#4058)", () => {
  test("bash-input becomes an injected span, not verbatim prose", () => {
    const segments = splitInjectedContent(BASH_INPUT_TURN);
    expect(segments.filter((s) => s.type === "prose")).toHaveLength(0);
    expect(firstSpan(BASH_INPUT_TURN).kind).toBe("bash-command");
  });

  test("the bash-input header names the command, so collapsing hides nothing", () => {
    expect(firstSpan(BASH_INPUT_TURN).label).toBe("bash: minsky cockpit open");
  });

  test("a long command keeps its START, not its trailing args (PR #2935 R1)", () => {
    // The first cut used safeTruncate's default side ("tail"), which keeps the
    // LAST N code units — so this header read `bash: xxxx'` with `git log`
    // dropped. The original test asserted only a length bound, which that
    // defect satisfies perfectly; asserting the PREFIX is what catches it.
    const long = `git log --oneline --since='${"x".repeat(120)}'`;
    const span = firstSpan(`<bash-input> ${long}</bash-input>`);
    expect(span.label.startsWith("bash: git log --oneline --since=")).toBe(true);
    expect(span.label.endsWith("…")).toBe(true);
    expect(span.label.length).toBeLessThanOrEqual("bash: ".length + 72 + 1);
    expect(span.content).toBe(long);
  });

  test("a command that fits is not made to look truncated", () => {
    expect(firstSpan(BASH_INPUT_TURN).label).not.toContain("…");
  });

  test("a multi-line command labels from its first line only", () => {
    const span = firstSpan("<bash-input> cd /tmp\nls -la\n</bash-input>");
    expect(span.label).toBe("bash: cd /tmp");
    expect(span.content).toContain("ls -la");
  });

  test("stdout and stderr are BOTH consumed from the one concatenated turn", () => {
    const segments = splitInjectedContent(
      "<bash-stdout>ok</bash-stdout><bash-stderr>warn</bash-stderr>"
    );
    // Two spans, no leaked prose: a matcher that stopped after the first block
    // would leave the stderr half as raw XML.
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ span: { kind: "bash-output", content: "ok" } });
    expect(segments[1]).toMatchObject({ span: { kind: "bash-error", content: "warn" } });
  });

  test("an empty half renders nothing at all — no collapsed header over nothing", () => {
    const segments = splitInjectedContent(BASH_OUTPUT_TURN);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      type: "injected",
      span: { kind: "bash-output", label: "command output" },
    });
  });

  test("an empty stdout beside real stderr surfaces the stderr", () => {
    const segments = splitInjectedContent(
      "<bash-stdout></bash-stdout><bash-stderr>Environment not found.\n</bash-stderr>"
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      span: { kind: "bash-error", content: "Environment not found." },
    });
  });

  test("a wholly empty pair yields no segments, and never falls back to raw tags", () => {
    // Both halves empty: the text was RECOGNIZED, so it must not reach the
    // verbatim-prose path just because there was nothing to show.
    const segments = splitInjectedContent("<bash-stdout></bash-stdout><bash-stderr></bash-stderr>");
    expect(segments).toEqual([]);
  });

  test("ANSI escape bytes are stripped from bash output", () => {
    const esc = String.fromCharCode(27);
    const span = firstSpan(`<bash-stdout>done ${esc}[1mfast${esc}[22m</bash-stdout>`);
    expect(span.content).toBe("done fast");
    expect(span.content).not.toContain(esc);
    // The visible bracket-digit residue an unstripped escape leaves behind.
    expect(span.content).not.toContain("[1m");
  });

  test("prose merely MENTIONING a bash tag mid-sentence is returned verbatim", () => {
    const input = "The <bash-input> wrapper is what carries the typed command.";
    expect(splitInjectedContent(input)).toEqual([{ type: "prose", text: input }]);
  });

  test("a bash turn followed by operator prose splits into injected + prose", () => {
    const prose = "\nthat opened the wrong conversation";
    const segments = splitInjectedContent(BASH_INPUT_TURN + prose);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ type: "injected", span: { kind: "bash-command" } });
    expect(segments[1]).toEqual({ type: "prose", text: prose });
  });
});
