import { describe, test, expect } from "bun:test";
import { safeShellQuote } from "@minsky/shared/exec";

// ---------------------------------------------------------------------------
// safeShellQuote (mt#1742) — POSIX single-quote wrapping for shell arguments
// ---------------------------------------------------------------------------
//
// The originating incident was commit messages containing markdown backticks
// (e.g., `` `bun install` ``) being interpolated into a /bin/sh -c template
// without escaping. The shell parser performed command substitution on the
// backticked contents, hanging the parent shell on a postinstall hook and
// leaking `.git/index.lock`.
//
// The fix wraps such arguments in POSIX single quotes, which suppress ALL
// shell metacharacter interpretation. These tests pin that contract.

describe("safeShellQuote (mt#1742)", () => {
  test("wraps plain ASCII in single quotes", () => {
    expect(safeShellQuote("hello world")).toBe("'hello world'");
  });

  test("backticks pass through literally — no command substitution", () => {
    // The originating incident: ` ` `bun install` ` ` would be substituted
    // by /bin/sh if interpolated into a double-quoted template. Wrapped in
    // single quotes, it must remain literal.
    const message = "feat: docs reference `bun install --production`";
    const quoted = safeShellQuote(message);

    // Should be wrapped in single quotes
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    // Backticks must be present in the wrapped output verbatim (not stripped
    // or escaped — single quotes already protect them)
    expect(quoted).toContain("`bun install --production`");
    // And the wrapped output must NOT contain a closing-then-reopening
    // structure that would let the shell escape the quote.
    expect(quoted).not.toContain("'`");
  });

  test("$VAR pass through literally — no variable expansion", () => {
    const quoted = safeShellQuote("export $HOME=/tmp");
    expect(quoted).toBe("'export $HOME=/tmp'");
  });

  test("double quotes pass through literally", () => {
    const quoted = safeShellQuote('She said "hi" then left');
    expect(quoted).toBe("'She said \"hi\" then left'");
  });

  test("backslash passes through literally", () => {
    const quoted = safeShellQuote("path\\to\\file");
    expect(quoted).toBe("'path\\to\\file'");
  });

  test("newlines and tabs pass through literally", () => {
    const message = "line one\nline two\tline three";
    const quoted = safeShellQuote(message);
    expect(quoted).toBe("'line one\nline two\tline three'");
  });

  test("single quote inside input uses the canonical '\\'' escape", () => {
    // POSIX single-quoted strings cannot themselves contain a single quote.
    // The canonical escape is: close the quote, emit a backslash-escaped
    // single quote outside quotes, reopen the quote. So `it's` becomes
    // `'it'\''s'`.
    const quoted = safeShellQuote("it's broken");
    expect(quoted).toBe("'it'\\''s broken'");
  });

  test("multiple embedded single quotes each get the canonical escape", () => {
    const quoted = safeShellQuote("'a' and 'b'");
    expect(quoted).toBe("''\\''a'\\'' and '\\''b'\\'''");
  });

  test("empty string yields empty single-quoted pair", () => {
    expect(safeShellQuote("")).toBe("''");
  });

  test("string of pure metacharacters passes through literally", () => {
    // Every shell metacharacter we care about, in one fixture. Wrapped in
    // single quotes, /bin/sh -c MUST treat the entire thing as one argument.
    const evil = '`$"\\*?[](){}|&;<>~!#';
    const quoted = safeShellQuote(evil);
    expect(quoted).toBe(`'${evil}'`);
  });

  test("multi-line commit message — mt#1742 regression fixture", () => {
    // The exact shape of the mt#1726 commit message that triggered the
    // original incident: multi-line, with markdown backticks inline.
    const message = [
      "feat(mt#1726): harden minsky-mcp Dockerfile",
      "",
      "Changes:",
      "1. `bun install` flags hardened",
      "2. Selective `COPY` replaces `COPY . .`",
      "",
      "$HOME should not expand.",
    ].join("\n");

    const quoted = safeShellQuote(message);

    // The wrapped string is the original message verbatim, surrounded by
    // single quotes — no substitution, no expansion, no surprises.
    expect(quoted).toBe(`'${message}'`);
    expect(quoted).toContain("`bun install`");
    expect(quoted).toContain("$HOME");
  });
});
