/**
 * HTML output encoding, split by the context the escaped value lands in (mt#4832).
 *
 * Before this module the repo carried four separate `escapeHtml` functions across
 * three different character sets, two of them EXPORTED under the same name. The
 * hazard was never the duplication itself: reaching for "the shared escapeHtml"
 * could resolve to a `& < >`-only helper, and using that in an `href="..."`
 * leaves the one character that closes the attribute unescaped — with no type
 * error, no test failure, and output that looks escaped.
 *
 * So the context is part of the name here, and a caller cannot pick the weaker
 * one without saying so. This mirrors OWASP's split between output encoding for
 * the HTML-attribute context and for element content.
 *
 * **Escaping is not URL validation.** Neither function says anything about where
 * a URL points; a value can be perfectly escaped and still link anywhere. A site
 * interpolating a third-party URL into an `href` needs both this and an origin
 * check — see `trustedGitHubUrl` in `../setup/github-app/trusted-url`, which is
 * deliberately a separate defence.
 *
 * **Deliberately NOT folded in here: `escapeXml` (`src/cockpit/launchd.ts`).** It
 * targets a launchd plist, which is XML, and emits `&apos;` — a valid XML entity
 * that is not valid HTML4. It is a different grammar, not a fifth copy of this.
 */

/**
 * Escape for HTML **element content** — text between tags.
 *
 * Escapes only the three characters that are markup-significant there. It is NOT
 * sufficient inside an attribute value: a `"` in `href="..."` closes the
 * attribute early, which yields malformed markup and lets the remaining text
 * inject further attributes. Use `escapeHtmlAttribute` for anything landing
 * inside quotes.
 *
 * Takes `unknown` rather than `string` on purpose. Callers routinely interpolate
 * fields read off a `JSON.parse`d API response through a bare `as` cast, so a
 * declared `string` is an assertion about the response, not a guarantee about the
 * value. Coercing here means a response that violates the cast is still escaped
 * rather than interpolated raw.
 *
 * `&` is replaced first; any other order double-escapes the entities the later
 * replacements introduce.
 */
export function escapeHtmlText(value: unknown): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escape for an HTML **attribute value** — and safe in element content too.
 *
 * A superset of `escapeHtmlText`: it additionally escapes both quote characters,
 * so the result cannot terminate a `"..."` or `'...'` attribute. Prefer
 * `escapeHtmlText` in element content where the extra entities are noise rather
 * than safety — a `'` rendered as `&#39;` in visible prose is correct but harder
 * to read.
 *
 * `'` is escaped as `&#39;` rather than `&apos;`: the numeric character reference
 * is valid in every HTML version, while `&apos;` is XML/HTML5-only. Escaping it
 * at all was raised as a non-blocking finding by `minsky-reviewer[bot]` on
 * PR #3527 — mt#4815's local helper covered `"` but not `'`, which was safe only
 * because every template it served used double-quoted attributes. That is a
 * property of those callers rather than of the escaper, and this is the shared
 * helper a future caller writing `href='...'` will reach for.
 */
export function escapeHtmlAttribute(value: unknown): string {
  return escapeHtmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
