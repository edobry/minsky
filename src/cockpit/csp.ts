/**
 * Cockpit daemon Content-Security-Policy (mt#2538).
 *
 * The cockpit SPA's webview/browser renders user-supplied content (transcript
 * text, entity titles), so the XSS surface is real even on a loopback-only
 * daemon. This module builds the header value for both production (built
 * bundle) and `--dev` (Vite HMR middleware) modes.
 */
import type { NextFunction, Request, Response } from "express";

const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'";

// Dev mode runs Vite's middleware for HMR. Relative to the prod policy this
// needs `'unsafe-inline'` + `'unsafe-eval'` on script-src: Vite's dev client
// bootstrap and esbuild's dev transform / React Fast Refresh re-evaluation
// rely on inline/eval'd script execution that the prod bundle (pre-built,
// content-hashed, no eval) never needs. connect-src already carries
// `ws:`/`wss:` in the prod policy (reserved for a future WS channel per
// mt#2750; /api/events SSE is plain HTTP, not WS) — the Vite HMR client's
// websocket rides the same allowance, so no further widening is needed there.
const DEV_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'";

export function buildCsp(dev: boolean): string {
  return dev ? DEV_CSP : PROD_CSP;
}

/**
 * Sets the Content-Security-Policy header on every GET/HEAD response. This
 * is harmless on JSON API responses (a CSP header only has effect when a
 * response is rendered as a document — i.e. the SPA's HTML) and keeps the
 * implementation simple: no per-route "is this HTML" branching, and dev
 * mode's Vite-served HTML gets the header too (this middleware is
 * registered before `app.use(vite.middlewares)` is added in
 * start-command.ts).
 */
export function cspMiddleware(dev: boolean) {
  const value = buildCsp(dev);
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method === "GET" || req.method === "HEAD") {
      res.setHeader("Content-Security-Policy", value);
    }
    next();
  };
}
