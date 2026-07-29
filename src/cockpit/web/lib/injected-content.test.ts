/**
 * Tests for the injected-content detector (mt#2791).
 *
 * Covers the spec's four acceptance fixtures (slash-command opening turn,
 * skill-body injection, system-reminder block, plain user prose) plus the
 * mixed-turn split and multi-skill-concatenation cases.
 */
import { describe, expect, test } from "bun:test";
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
