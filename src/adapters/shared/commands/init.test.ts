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

import { formatInitMessage, parseRuleIds } from "./init";

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
