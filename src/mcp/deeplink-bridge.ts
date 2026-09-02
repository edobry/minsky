/**
 * HTTPS → minsky:// deeplink bridge (mt#4604).
 *
 * Surfaces that only accept http(s) link targets — Notion, GitHub bodies, Slack,
 * email — cannot carry a `minsky://` URI (Notion strips the link at ingestion,
 * verified 2026-08-25). This module serves `GET /r/:type/:id` on the MCP HTTP
 * server: an interstitial page that immediately hands off to the corresponding
 * `minsky://` URI, so the OS scheme handler (cockpit-tray, mt#2528) opens the
 * entity. The page is also the graceful floor for a reader WITHOUT Minsky
 * installed: it shows the entity ref and the target URI rather than a dead
 * control.
 *
 * Interstitial rather than a bare 302 because browsers vary on following
 * cross-scheme redirects; the meta-refresh + script + visible-link combination
 * is the pattern app deep links (Zoom, Slack) use. The page itself is
 * host-agnostic — it embeds only the `minsky://` URI, never its own origin —
 * so the route can move to a future brand domain without content changes.
 *
 * Validation is delegated to the shared entity codec: the URI is built with
 * `entityToMinskyUri` and must round-trip through `parseMinskyUri` unchanged.
 * That inherits every codec rule (the seven accepted types, the digits-only
 * changeset ids, trailing-punctuation stripping) without a second copy that
 * could drift (mt#3694's lesson).
 */
import { escapeHtmlAttribute } from "@minsky/domain/html/escape";
import {
  ROUTABLE_ENTITY_TYPES,
  entityToMinskyUri,
  parseMinskyUri,
  type RoutableEntityType,
} from "../cockpit/web/lib/entity-codec";

export interface DeeplinkBridgeResult {
  status: 200 | 404;
  contentType: "text/html" | "text/plain";
  /**
   * Always "no-store" (PR #3362 R1): the route is public and un-authed, so an
   * intermediary caching a 200 is harmless today only because the page carries
   * no per-request state. Locking the header into the contract keeps a future
   * edit that adds request-derived content from becoming cacheable by default.
   */
  cacheControl: "no-store";
  body: string;
}

function isRoutableEntityType(rawType: string): rawType is RoutableEntityType {
  return (ROUTABLE_ENTITY_TYPES as readonly string[]).includes(rawType);
}

/**
 * Resolve a decoded `(type, id)` pair — Express has already percent-decoded
 * path params, so `/r/task/mt%232865` arrives as `("task", "mt#2865")` — to the
 * interstitial response, or a plain-text 404 when the pair does not name a
 * valid entity reference.
 */
export function resolveDeeplinkBridge(rawType: string, rawId: string): DeeplinkBridgeResult {
  if (!isRoutableEntityType(rawType) || !rawId) {
    return {
      status: 404,
      contentType: "text/plain",
      cacheControl: "no-store",
      body: "Unknown Minsky entity reference.",
    };
  }

  const uri = entityToMinskyUri(rawType, rawId);
  // Round-trip through the codec's parser so its validation rules apply here
  // verbatim. A parse failure (e.g. a non-numeric changeset id) or an id the
  // parser normalizes (trailing prose punctuation) is not a reference we can
  // faithfully hand off — refuse rather than open a different entity.
  const parsed = parseMinskyUri(uri);
  if (!parsed || parsed.type !== rawType || parsed.id !== rawId) {
    return {
      status: 404,
      contentType: "text/plain",
      cacheControl: "no-store",
      body: "Unknown Minsky entity reference.",
    };
  }

  const safeLabel = escapeHtmlAttribute(rawId);
  const safeUri = escapeHtmlAttribute(uri);
  // JSON.stringify produces a valid JS string literal; escape `<` so the
  // literal cannot close the surrounding <script> element via `</script>`.
  const scriptUri = JSON.stringify(uri).replace(/</g, "\\u003c");

  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0;url=${safeUri}">
<title>${safeLabel} — Minsky</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #101014; color: #e6e6ea;
         display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
  main { max-width: 34rem; padding: 2rem; }
  a.open { display: inline-block; background: #4f7cff; color: #fff; text-decoration: none;
           padding: 0.6rem 1.2rem; border-radius: 6px; margin: 1rem 0; }
  code { background: #1c1c22; padding: 0.2rem 0.4rem; border-radius: 4px; word-break: break-all; }
  p.dim { color: #9a9aa4; font-size: 0.9rem; }
</style>
<script>location.replace(${scriptUri});</script>
</head>
<body>
<main>
<h1>${safeLabel}</h1>
<p>Opening this ${escapeHtmlAttribute(rawType)} in Minsky…</p>
<a class="open" href="${safeUri}">Open in Minsky</a>
<p class="dim">Nothing happening? Minsky isn't installed on this device. The reference is
<code>${safeUri}</code> — open it on a machine running the Minsky cockpit.</p>
</main>
</body>
</html>
`;

  return { status: 200, contentType: "text/html", cacheControl: "no-store", body };
}
