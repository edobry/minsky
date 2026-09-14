/**
 * `init`'s selection-surface output (mt#4872 SC2/SC4).
 *
 * Covers the two invocation legs that cannot be checked by running the CLI and
 * reading stdout:
 *
 *   - The **MCP tool result**, whose payload is exactly what this command
 *     returns. The MCP daemon serves the installed build rather than a session
 *     workspace, so a live `mcp__minsky__init` call pre-merge exercises the OLD
 *     code and is evidence about nothing.
 *   - The **message composition**, which is what BOTH stdout paths render:
 *     `src/commands/init/index.ts` prints `result.message` and nothing else.
 */

import { describe, it, expect } from "bun:test";

import { initializeProject } from "@minsky/domain/init";
import { createMockFs } from "@minsky/domain/interfaces/mock-fs";
import { createInitCommand } from "../../../commands/init";
import { sharedCommandRegistry } from "../command-registry";
import { paramNameToFlag } from "../schema-bridge";
import { formatInitMessage, parseRuleIds, registerInitCommands } from "./init";

const DECLINABLE = [
  { id: "json-parsing", description: "Use jq, never grep, when parsing JSON output." },
  { id: "git-safety", description: "Destructive git operations require the git-safety skill." },
];

describe("mt#4872 SC2 — the declinable set reaches the operator", () => {
  it("names every declinable rule, with the line that says what it is for", () => {
    const message = formatInitMessage(DECLINABLE);

    for (const rule of DECLINABLE) {
      expect(message).toContain(rule.id);
      // The id alone is not a basis for a decision — the description is what
      // makes the choice answerable, so it has to survive into the message.
      expect(message).toContain(rule.description);
    }
    expect(message).toContain("2 optional rule(s)");
  });

  it("states how to decline, and that not declining is a decision", () => {
    const message = formatInitMessage(DECLINABLE);

    // The conversation is the primary selection path (ask#11288); the flags
    // are the non-interactive one. Both have to be named, in that order.
    expect(message).toContain("Ask your agent to walk you through them");
    expect(message).toContain("minsky rules disable --id <id>");
    expect(message).toContain("minsky compile");
    // SC6: the cost the principal accepted with "propose then decline"
    // (ask#11764) — a project nobody asks keeps them.
    expect(message).toContain("They stay until you remove them.");
  });

  it("says nothing extra when there is nothing to decline", () => {
    // A project that already declined everything declinable is a real state,
    // not a failure. Emitting an empty "0 optional rules" block would train the
    // reader to skip the section in the case where it matters.
    expect(formatInitMessage([])).toBe("Project initialized successfully.");
  });
});

describe("mt#5148 — the CLI renders the declinable list exactly once", () => {
  /**
   * The CLI's stdout is the domain's `info` lines (sunk through `log.cli`)
   * followed by `result.message` (printed by `src/commands/init/index.ts`).
   * mt#4872 added the list to BOTH — SC6 rewrote the domain line, SC2 folded
   * it into the message — and every test asserted its own channel, so a fresh
   * `minsky init` printed the thirteen ids twice, back to back (observed
   * 2026-09-14). This is the test on the combined render that was missing:
   * the same two channels, concatenated the way the CLI concatenates them.
   */
  it("mentions the optional-rule set once across the info lines and the message", async () => {
    const info: string[] = [];
    const warnings: string[] = [];
    const result = await initializeProject(
      {
        repoPath: "/tmp/mt5148-once",
        backend: "minsky",
        ruleFormat: "minsky",
        mcp: { enabled: false },
        overwrite: false,
        // mt#5153: the domain no longer resolves a client itself.
        client: "claude-code",
        harnessSource: "flag",
      },
      createMockFs(),
      {
        info: (line) => info.push(line),
        warn: (line) => warnings.push(line),
        compileForHarness: async () => ({ definitionsIncluded: [], definitionsSkipped: [] }),
      }
    );
    const rendered = [...info, ...warnings, formatInitMessage(result.declinable)].join("\n");

    // The list is real on this run, so "once" is not vacuous.
    expect(result.declinable.length).toBeGreaterThan(0);
    expect(rendered.match(/optional rule\(s\)/g)?.length).toBe(1);
    // ...and it is the descriptive rendering that survives, not the bare ids.
    for (const rule of result.declinable) {
      expect(rendered).toContain(`  - ${rule.id}: ${rule.description}`);
    }
    // The count line is a different fact and still prints once.
    expect(rendered.match(/wrote \d+ rule\(s\)/g)?.length).toBe(1);
  });
});

describe("mt#4872 SC4 — non-interactive rule ids", () => {
  it("accepts a comma-separated list, an array, and mixtures of both", () => {
    expect(parseRuleIds("json-parsing,git-safety")).toEqual(["json-parsing", "git-safety"]);
    expect(parseRuleIds(["json-parsing", "git-safety"])).toEqual(["json-parsing", "git-safety"]);
    expect(parseRuleIds(["json-parsing,git-safety", "test-expectations"])).toEqual([
      "json-parsing",
      "git-safety",
      "test-expectations",
    ]);
  });

  it("tolerates spacing and empty entries rather than forwarding them as ids", () => {
    // An empty id would reach `disableRule` and fail id validation with a
    // confusing message about an unknown rule "".
    expect(parseRuleIds(" json-parsing , git-safety ")).toEqual(["json-parsing", "git-safety"]);
    expect(parseRuleIds("json-parsing,,")).toEqual(["json-parsing"]);
    expect(parseRuleIds("")).toEqual([]);
    expect(parseRuleIds(undefined)).toEqual([]);
  });
});

describe("mt#4872 — the CLI command and the shared definition must not drift", () => {
  /**
   * `src/commands/init/index.ts` is a hand-written Commander command, registered
   * top-level because the INIT category is hidden from CLI auto-generation
   * (`init-customizations.ts`). So `init` has TWO option lists, and nothing
   * connected them: `--enable` / `--disable` were added to the shared
   * definition, reached the MCP surface, and did not appear on the CLI at all.
   *
   * Same parallel-mapping shape as `compileCheckTargets` in mt#4866, and the
   * same remedy: a test that fails when one side is edited without the other.
   * Reviewer-suggested (PR #3655 R1); the drift it describes had already
   * happened once in this task.
   */
  it("every shared init parameter has a matching CLI flag", () => {
    registerInitCommands();
    const commandDef = sharedCommandRegistry.getCommand("init");
    if (commandDef === undefined) throw new Error("init is not registered in the shared registry");

    const cliFlags = new Set(
      createInitCommand()
        .options.map((option) => option.long)
        .filter((long): long is string => typeof long === "string")
    );

    const parameters = commandDef.parameters ?? {};
    const missing = Object.keys(parameters)
      // A `cliHidden` parameter is server-injected (mt#5153: `callerActorId`)
      // and has no CLI surface by design — mirroring it as a flag would
      // advertise a value the operator must never hand-pass.
      .filter((name) => (parameters[name] as { cliHidden?: boolean }).cliHidden !== true)
      .map((name) => `--${paramNameToFlag(name)}`)
      // `session` is a shared parameter with no CLI surface on this command.
      .filter((flag) => flag !== "--session")
      .filter((flag) => !cliFlags.has(flag));

    expect(missing).toEqual([]);
  });
});
