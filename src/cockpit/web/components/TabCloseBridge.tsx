/**
 * TabCloseBridge — installs `window.__minskyCloseActiveTab` (mt#4059, ADR-023).
 *
 * Renders nothing; it exists to own one native-seam global, mounted inside
 * `TabsProvider` so it can reach `useTabs`. Same idiom as `TabKeyboardNav`,
 * different job: that component owns DOM key bindings, this one owns the
 * Rust→SPA entry point the tray's `Close Tab` menu item (⌘W) evals.
 *
 * ## Why a global rather than a keydown handler
 *
 * `⌘W` is claimed by a native menu accelerator, so it never reaches the
 * document — and that is deliberate rather than a workaround. An accelerator
 * fires regardless of what holds focus, renders its chord in the Window menu
 * where an operator can find it, and does not rest on the unverified premise
 * that a chorded key reaches the WKWebView at all (mt#3475). ADR-023 fixes the
 * shape of the return path: the SPA is an untrusted external-origin webview
 * with no Tauri IPC, so native→SPA actions are `eval` of a small SPA-exposed
 * global — the `window.__minskyDeepLink` pattern in `useDeepLinkHandler`.
 *
 * ## Why it can be a no-op
 *
 * `activePath` is null whenever the operator is on a route that is not an
 * entity detail — a list page, the dashboard — even with tabs open. There is
 * no tab in view to close there, so this does nothing, and the tray side does
 * NOT fall back to closing the window: ⌘W on a list page is inert, which is
 * the browser's behavior for a window whose tab strip is empty inverted, and
 * the safer of the two failure directions (a stray close of the whole window
 * would discard the working set).
 */
import { useEffect } from "react";
import { useTabs } from "../lib/tabs";

declare global {
  interface Window {
    /**
     * Installed by TabCloseBridge; called by the cockpit tray's `Close Tab`
     * menu item via `WebviewWindow::eval` (`menu.rs eval_close_active_tab`).
     * Absent in a browser, and absent before the SPA mounts — the Rust side
     * guards on `typeof`.
     */
    __minskyCloseActiveTab?: () => void;
  }
}

export function TabCloseBridge() {
  const { activePath, closeTab } = useTabs();

  useEffect(() => {
    window.__minskyCloseActiveTab = () => {
      if (!activePath) return;
      closeTab(activePath);
    };

    return () => {
      // Cleared on unmount so a remount (Fast Refresh in dev) reinstalls the
      // closure over the current activePath rather than leaving a stale one.
      delete window.__minskyCloseActiveTab;
    };
  }, [activePath, closeTab]);

  return null;
}
