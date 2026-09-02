/**
 * Origin validation for URLs GitHub hands us that we then show to an operator.
 *
 * **Why this exists (mt#4764, PR #3511 R1).** Several code paths read a URL out
 * of a GitHub API response — `html_url` on an App, on an installation — and put
 * it in front of the operator as something to click. The value arrives over
 * HTTPS from `api.github.com`, which makes it trustworthy in practice and NOT
 * trustworthy by construction: it still crosses a trust boundary, and a
 * type-and-emptiness check says nothing about where the URL points.
 *
 * The remedy is deliberately narrow. This is not sanitization and not escaping —
 * it answers one question, "is this actually a github.com URL?", so a caller can
 * fall back to a known-safe value instead of rendering an arbitrary link.
 */

/** Hosts whose URLs we are willing to render to an operator. */
const TRUSTED_HOSTS = new Set(["github.com", "www.github.com"]);

/**
 * The URL if it is an `https://github.com/...` URL, otherwise `null`.
 *
 * Parsed with `URL` rather than matched with a string prefix, deliberately.
 * A prefix test invites near-miss reasoning about inputs like
 * `https://github.com@evil.com/` or `https://github.com.evil.com/` — both of
 * which a careful prefix check does reject, and neither of which you should
 * have to reason about. `URL` resolves the real host once and the question
 * becomes a set membership.
 *
 * `http:` is rejected along with everything else: every GitHub URL we render is
 * `https:`, so accepting the downgrade would only widen the surface.
 */
export function trustedGitHubUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // intentional-swallow: an unparseable URL is exactly the "not trusted"
    // answer this function exists to return, and the caller falls back.
    return null;
  }

  if (parsed.protocol !== "https:") return null;
  if (!TRUSTED_HOSTS.has(parsed.hostname.toLowerCase())) return null;

  // Credentials in a URL are never present in a GitHub API response and are a
  // classic way to make a link read as one host while behaving as another.
  if (parsed.username !== "" || parsed.password !== "") return null;

  return value;
}
