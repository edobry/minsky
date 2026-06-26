/**
 * useDeepLinkHandler — installs `window.__minskyDeepLink(uri)` and drains
 * `window.__minskyPendingDeepLink` on mount (mt#2528, ADR-023).
 *
 * The cockpit tray (Tauri) forwards `minsky://` deep-link URLs to the SPA via
 * Rust→webview eval rather than Tauri IPC, because the SPA is an untrusted
 * external-URL webview (ADR-023). The Rust handler:
 *
 *   1. Always sets `window.__minskyPendingDeepLink = uri` so the URL survives
 *      if the SPA hasn't mounted yet.
 *   2. Calls `window.__minskyDeepLink(uri)` immediately if already defined
 *      (hot-start fast path).
 *
 * This hook:
 *   - Installs `window.__minskyDeepLink` so the Rust side can call it directly
 *     on hot-start (SPA already mounted).
 *   - On mount, drains `window.__minskyPendingDeepLink` (set by Rust on cold-start
 *     before this hook's effect ran).
 *
 * Must be mounted AFTER the router is available (i.e., inside a component rendered
 * inside `<BrowserRouter>`) because it calls `useNavigate`.
 *
 * @see src/cockpit/web/lib/entity-codec.ts — `minskyUriToPath` (the URL→path codec)
 * @see docs/architecture/adr-023-cockpit-ui-delivery-native-boundary.md
 */

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { minskyUriToPath } from "../lib/entity-codec";

/** Extend the Window interface so TypeScript knows about the Rust-injected globals. */
declare global {
  interface Window {
    /** Installed by useDeepLinkHandler; called by Rust on hot-start. */
    __minskyDeepLink?: (uri: string) => void;
    /**
     * Stashed by Rust on cold-start (before the SPA mounted).
     * Drained and cleared by useDeepLinkHandler on mount.
     */
    __minskyPendingDeepLink?: string | null;
  }
}

/**
 * Resolve and navigate to a `minsky://` URI.
 *
 * Returns the resolved cockpit path (for logging), or null if the URI is not
 * routable (unknown type, empty id, etc.). Navigation is a no-op on null.
 */
function navigateToUri(uri: string, navigate: ReturnType<typeof useNavigate>): string | null {
  const path = minskyUriToPath(uri);
  if (!path) {
    // Unrouted entity type (e.g. pr, agent) or malformed URI — no-op.
    // (changeset became routable in mt#2536; task/ask/session/memory always route.)
    return null;
  }
  navigate(path);
  return path;
}

/**
 * Hook: install `window.__minskyDeepLink` and drain `window.__minskyPendingDeepLink`.
 *
 * Call once at the App level (inside the router tree so `useNavigate` is available).
 */
export function useDeepLinkHandler(): void {
  const navigate = useNavigate();

  useEffect(() => {
    // Install the global so Rust can call it on subsequent deep-link activations
    // while the app is already running (hot-start / re-activation path).
    window.__minskyDeepLink = (uri: string) => {
      navigateToUri(uri, navigate);
    };

    // Drain any URL that Rust stashed before this effect ran (cold-start path).
    // Rust sets window.__minskyPendingDeepLink when the webview accepted the eval
    // but __minskyDeepLink wasn't defined yet (SPA still mounting).
    const pending = window.__minskyPendingDeepLink;
    if (pending) {
      window.__minskyPendingDeepLink = null;
      navigateToUri(pending, navigate);
    }

    return () => {
      // On unmount (e.g., Fast Refresh in dev), clear the global so the next
      // mount re-installs it with a fresh navigate reference.
      delete window.__minskyDeepLink;
    };
  }, [navigate]);
}
