#!/usr/bin/env bun
/// <reference types="bun" />
/**
 * Tiny Bun static-file server for the Astro build output at `services/site/dist/`.
 *
 * Used by the Railway deploy (start command: `bun run src/server.ts`). Bun.file
 * handles MIME-type inference and lazy reads natively; missing paths return
 * 404 via the explicit existence probe so we don't surface internal errors to
 * clients. Pretty paths (`/foo`) fall back to `dist/foo/index.html` which is
 * Astro's default static layout when `trailingSlash: "never"` is set in
 * astro.config.ts.
 */

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { log } from "./logger";

const PORT = Number(process.env.PORT ?? 4321);
const DIST_DIR = resolve(import.meta.dir, "..", "dist");

if (!existsSync(DIST_DIR)) {
  log.error("[site] dist directory missing", { dir: DIST_DIR });
  process.exit(1);
}

function safeJoin(base: string, candidate: string): string | null {
  // Resolve and confirm the result stays under base — prevents path traversal.
  const joined = resolve(join(base, candidate));
  if (!joined.startsWith(`${base}/`) && joined !== base) return null;
  return joined;
}

function tryPaths(pathname: string): string | null {
  // Strip leading slash, normalize. Empty path is index.
  const clean = pathname.replace(/^\//, "");
  const candidates =
    clean === "" ? ["index.html"] : [clean, `${clean}.html`, join(clean, "index.html")];

  for (const c of candidates) {
    const full = safeJoin(DIST_DIR, c);
    if (!full) continue;
    try {
      // statSync subsumes the existence probe (ENOENT throws) and closes the
      // existsSync->statSync TOCTOU gap. It can also throw on a race (file
      // removed mid-request) or a permission error (EACCES) even when the path
      // exists — treat any throw as "not a servable file" and fall through to
      // the next candidate rather than surfacing a 500.
      if (statSync(full).isFile()) return full;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Serve `path` as a response iff it is a readable file, else return null so the
 * caller can fall through. Mirrors the tryPaths guard (mt#2198 review): statSync
 * in try/catch treats ENOENT (race: file removed after an earlier probe) and
 * EACCES as "not servable" rather than letting a bare existsSync→Bun.file path
 * surface a 500. Used for the SPA-deck and 404 fallbacks.
 */
function serveIfFile(path: string | null, init?: ResponseInit): Response | null {
  if (!path) return null;
  try {
    if (statSync(path).isFile()) return new Response(Bun.file(path), init);
  } catch {
    // ENOENT / EACCES — not a servable file; let the caller fall through.
  }
  return null;
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    // /health is the Railway healthcheck path. Cheap, no fs touch.
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", service: "minsky-site" }), {
        headers: { "content-type": "application/json" },
      });
    }

    const filePath = tryPaths(url.pathname);
    if (!filePath) {
      // SPA fallback for client-routed talk decks — navigation requests only.
      // A deep link like /talks/<deck>/5 has no file on disk; serve that deck's
      // index.html (200) so slidev's client-side router resolves the slide.
      // A request is a navigation iff it has no file extension: asset requests
      // (/assets/*.js, *.css, ...) always carry an extension and fall through to
      // 404 instead of being masked by HTML. Extension is the sole signal so the
      // fallback stays correct behind proxies/CDNs that strip the Accept header.
      const hasFileExtension = /\.[a-zA-Z0-9]+$/.test(url.pathname);
      const deckMatch = url.pathname.match(/^\/talks\/([^/]+)\//);
      if (!hasFileExtension && deckMatch) {
        const deckIndex = safeJoin(DIST_DIR, join("talks", deckMatch[1], "index.html"));
        const deckResponse = serveIfFile(deckIndex, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
        if (deckResponse) return deckResponse;
      }

      const notFoundPath = safeJoin(DIST_DIR, "404.html");
      const notFoundResponse = serveIfFile(notFoundPath, {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
      if (notFoundResponse) return notFoundResponse;

      return new Response("Not Found", { status: 404 });
    }

    return new Response(Bun.file(filePath));
  },
});

log.info("[site] serving", {
  dir: DIST_DIR,
  host: server.hostname,
  port: server.port,
});
