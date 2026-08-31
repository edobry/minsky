/**
 * Codex Agents Compile Target (mt#3854)
 *
 * Reads the same `.minsky/agents/<name>/agent.ts` definitions the
 * `claude-agents` target reads and emits `.codex/agents/<name>.toml`, the shape
 * the hand-made `.codex/` port used: a `name`, a `description`, and the prompt
 * body as `developer_instructions`.
 *
 * Discovery, import and validation are shared via `./agent-target`; this module
 * owns only the TOML serializer.
 *
 * ## Why hand-rolled TOML
 *
 * The repo has no TOML stringifier: no `@iarna/toml` / `smol-toml` dependency,
 * and `Bun.TOML` exposes `parse` only (verified 2026-08-22 —
 * `Object.keys(Bun.TOML)` is `["parse"]`). Rather than take a dependency for
 * three scalar keys, this emits them directly. The escaping below is therefore
 * the load-bearing part, and it is written against the TOML v1.0.0 string
 * rules rather than against the three values that happen to exist today.
 *
 * @see mt#3854 — this target
 * @see mt#4431 — the hooks manifest and the reachability question
 * @see ADR-016 — compile pipeline convergence
 */

import { COMPILE_GENERATED_BANNER } from "../../rules/compile/banner-constants";
import { makeAgentTarget, realDynamicImport } from "./agent-target";
import type { DynamicImportFn } from "./agent-target";
import type { AgentDefinition } from "../../definitions/types";
import type { MinskyCompileTarget } from "../types";

// ---------------------------------------------------------------------------
// TOML string emission
// ---------------------------------------------------------------------------

/**
 * C0 control characters (minus the ones with a shorthand escape below) plus
 * DEL, which TOML requires be written as `\uXXXX` inside a basic string.
 *
 * Built from escape sequences rather than literal characters on purpose: a
 * literal control byte in the source makes the file read as binary to `grep`
 * and trips `no-control-regex` / `no-irregular-whitespace`. The set excludes
 * 	 (tab),
 * shorthand replacements that run before it: tab (0x09), LF (0x0A) and CR (0x0D).
 * shorthand replacements that run before it.
 */
// eslint-disable-next-line no-control-regex -- emitting valid TOML requires escaping exactly this set
const TOML_CONTROL_CHARS = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "g");

/**
 * Escape a value for a TOML **basic string** (the `"..."` form).
 *
 * Per TOML v1.0.0, a basic string may not contain a literal backslash, an
 * unescaped double quote, or a raw control character. Backslash is escaped
 * FIRST — escaping it after the quote rule would double-escape the backslashes
 * that rule just introduced.
 */
export function escapeTomlBasicString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(
      TOML_CONTROL_CHARS,
      (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()}`
    );
}

/**
 * Escape a value for a TOML **multi-line basic string** (the `"""..."""` form).
 *
 * Newlines and quotes are allowed raw here, which is the whole point — an agent
 * prompt is thousands of lines of Markdown and escaping every newline would
 * make the output unreadable and unreviewable. Two things still must be
 * handled, and both are real in this corpus rather than theoretical:
 *
 * 1. **Backslashes** — TOML treats `\` as an escape introducer inside multi-line
 *    basic strings too, so a prompt containing a regex like `\bfoo\b` would
 *    otherwise be silently mangled on parse. Agent prompts in this repo DO
 *    contain regexes.
 * 2. **A run of three or more quotes** — `"""` inside the body would terminate
 *    the string early. Escaping the first quote of any such run is sufficient
 *    and leaves ordinary `"quoted"` prose untouched.
 *
 * A trailing quote immediately before the closing delimiter is also escaped:
 * `..."` + `"""` would read as four quotes and end the string one character early.
 */
export function escapeTomlMultilineString(value: string): string {
  const backslashEscaped = value.replace(/\\/g, "\\\\");
  // Escape the leading quote of any run of 3+ quotes.
  const quoteEscaped = backslashEscaped.replace(/"{3,}/g, (run) => `\\"${run.slice(1)}`);
  // A body ending in a quote would fuse with the closing delimiter.
  return quoteEscaped.endsWith('"') ? `${quoteEscaped.slice(0, -1)}\\"` : quoteEscaped;
}

/**
 * Build `<name>.toml` content from a validated AgentDefinition.
 *
 * Deliberately narrow: `name`, `description` and `developer_instructions` are
 * the keys the hand-made `.codex/agents/*.toml` files carried, and emitting
 * fields Codex may not read would be inventing a contract rather than matching
 * one. The richer Claude frontmatter (`tools`, `model`, `skills`,
 * `permission-mode`, …) is intentionally NOT emitted — mapping it needs Codex's
 * agent-config documentation, which belongs with the same verification mt#4431
 * does for the hooks manifest, not a guess here.
 */
export function buildAgentToml(agent: AgentDefinition): string {
  const body = agent.prompt.startsWith("\n") ? agent.prompt.slice(1) : agent.prompt;

  // The delimiters sit on their own lines so the file stays readable — a 40KB
  // prompt on one line is unreviewable — and each is followed by a `\`
  // line-continuation, which TOML defines as trimming that newline and any
  // whitespace after it.
  //
  // Without the continuations the parsed value gains a leading and trailing
  // newline the source never had. TOML says a newline immediately after the
  // opening delimiter is trimmed, but `Bun.TOML.parse` does not do so
  // (measured — the round-trip test in codex-targets.test.ts failed on exactly
  // that), and relying on any parser's trimming would make the emitted value
  // depend on which parser reads it. The continuations make the round-trip
  // exact by construction instead, which is why that test asserts equality with
  // the source rather than equality-modulo-newlines.
  return [
    // SC6: `check-generated-file-edit.ts` decides by CONTENT, not path — it
    // scans the first lines for a generation banner. The hooks output inherits
    // one from the shared copy target; a `.toml` has no such convention, so
    // without these two lines a hand-edit of a generated agent file would be
    // permitted. `COMPILE_GENERATED_BANNER` is the shared constant the guard's
    // own pattern list is built against, imported rather than retyped so the
    // emit side and the detect side cannot drift (mt#1798).
    COMPILE_GENERATED_BANNER,
    `# Source: .minsky/agents/${agent.name}/agent.ts`,
    `name = "${escapeTomlBasicString(agent.name)}"`,
    `description = "${escapeTomlBasicString(agent.description)}"`,
    `developer_instructions = """\\`,
    `${escapeTomlMultilineString(body)}\\`,
    `"""`,
    "",
  ].join("\n");
}

/** Build the codex-agents target, injecting a dynamic-import function for tests. */
function makeCodexAgentsTarget(
  dynamicImport: DynamicImportFn = realDynamicImport
): MinskyCompileTarget {
  return makeAgentTarget(
    {
      id: "codex-agents",
      displayName: "Codex Agents",
      outputDirSegments: [".codex", "agents"],
      outputExtension: ".toml",
      // Unlike `.claude/agents/`, nothing hand-authored survives here once this
      // target owns the directory — every file is generated, so `--check`
      // SHOULD report orphans. That is what turns a leftover into a build
      // failure instead of the silent fossil mt#3854 was filed about.
      sharedOutputDirectory: false,
      buildContent: buildAgentToml,
    },
    dynamicImport
  );
}

export const codexAgentsTarget = makeCodexAgentsTarget();

/** Export factory for test injection */
export { makeCodexAgentsTarget };
