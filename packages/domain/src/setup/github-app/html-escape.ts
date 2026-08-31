/**
 * HTML escaping for the setup provisioners' served pages (mt#4815).
 *
 * **Why this is separate from `trustedGitHubUrl`.** They are two different
 * defences and neither substitutes for the other. `trustedGitHubUrl` answers
 * "does this URL point at github.com?" and says nothing about a `"` inside it;
 * a value can be perfectly on-origin and still close an `href` attribute early,
 * injecting further attributes. Escaping alone has the opposite hole — it would
 * faithfully render a link pointing anywhere. A site interpolating a
 * third-party value into an attribute needs both. This mirrors OWASP's split
 * between context-specific output encoding for the HTML-attribute context and
 * scheme/host validation of a URL.
 *
 * `"` is escaped alongside the three text-context characters, so this is safe
 * inside a double-quoted attribute as well as in element content. That is the
 * whole reason this is not `escapeHtml` from `notify/markdown-to-telegram-html`,
 * which is deliberately `& < >` only for Telegram's text-context subset.
 *
 * This is a local helper by design, not a general utility: mt#4815 is a
 * security-shaped change and extracting a shared escaper would have widened its
 * diff into unrelated files. mt#4832 owns consolidating this with the three
 * other implementations in the repo.
 */

/**
 * The value escaped for interpolation into served HTML, in element content or
 * inside a double-quoted attribute.
 *
 * Takes `unknown` rather than `string` on purpose. The callers interpolate
 * fields read off a `JSON.parse`d GitHub API response through a bare `as` cast,
 * so their declared `number` and `string` types are assertions about the
 * response, not guarantees about the value. Coercing here means a response that
 * violates the cast is still escaped rather than interpolated raw.
 *
 * `&` is replaced first; any other order double-escapes the entities the later
 * replacements introduce.
 */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
