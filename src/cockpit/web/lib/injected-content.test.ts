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
