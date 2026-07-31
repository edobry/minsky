/**
 * ANSI escape-sequence stripping (mt#3322).
 *
 * Harness transcript payloads can carry raw terminal control bytes: a
 * `<local-command-stdout>` block captures a slash command's terminal output
 * verbatim, so `/model` arrives as
 * `Set model to ESC[1mFable 5ESC[22m for this session only`. Rendered
 * into the DOM unchanged, the escape bytes surface as replacement glyphs.
 *
 * The pattern is the community-canonical `ansi-regex` one (ECMA-48 CSI/SGR
 * plus the OSC form), inlined rather than added as a dependency: it is a
 * single expression, and the cockpit web bundle is the only consumer.
 *
 * Stripping is deliberate, not conversion — the cockpit is not a terminal
 * emulator, and reproducing bold/color styling from transcript bytes is a
 * different (unrequested) feature. `ESC[1mFable 5ESC[22m` becomes the
 * plain text `Fable 5`.
 *
 * **Known boundary, inherited from the upstream pattern:** the OSC branch
 * excludes whitespace from its payload character class, so an OSC sequence
 * whose payload contains a space (a `set window title` escape, say) has only
 * its introducer consumed and leaves the payload text behind. That is
 * upstream `ansi-regex` behavior, not a local narrowing, and it does not
 * affect the payloads this exists for: harness-captured command output
 * carries SGR codes, not OSC window titles.
 */

/**
 * Matches an ANSI escape sequence: `ESC`/`CSI` introducer, optional
 * intermediate bytes, then either an OSC string terminated by `BEL` or a
 * standard CSI final byte.
 *
 * Built fresh per call — a module-level global-flagged regex carries mutable
 * `lastIndex` state across `.replace()` calls, which leaks between the many
 * strings this runs over per render.
 */
function ansiEscapeRegex(): RegExp {
  return new RegExp(
    "[\\u001B\\u009B][[\\]()#;?]*" +
      "(?:(?:(?:(?:;[-a-zA-Z\\d/#&.:=?%@~_]+)*" +
      "|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d/#&.:=?%@~_]*)*)?\\u0007)" +
      "|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
    "g"
  );
}

/**
 * Remove every ANSI escape sequence from `text`. Returns the input unchanged
 * when it contains none (the overwhelmingly common case), so this is safe to
 * apply unconditionally on a render path.
 */
export function stripAnsi(text: string): string {
  if (!text) return text;
  return text.replace(ansiEscapeRegex(), "");
}
