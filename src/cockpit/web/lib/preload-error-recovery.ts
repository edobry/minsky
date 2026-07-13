/**
 * Stale-chunk recovery (mt#2674).
 *
 * The tray auto-rebuilds cockpit-web on every merge to main (mt#2297/mt#2299),
 * which replaces the content-hashed chunk files a long-lived window's module
 * graph points at. The next lazy-page navigation then fails its dynamic
 * import. Vite surfaces that failure as a `vite:preloadError` window event
 * (vite.dev/guide/build, "Load Error Handling"); the documented recovery is a
 * page reload, which picks up the fresh index.html and chunk hashes.
 *
 * The reload is time-guarded: if a recovery reload already happened within
 * RELOAD_WINDOW_MS, the event is left alone so a genuinely broken build
 * surfaces through the widget error boundary instead of reload-looping.
 */

const RELOAD_AT_KEY = "minsky:preload-error-reload-at";
export const RELOAD_WINDOW_MS = 10_000;

export interface PreloadRecoveryHooks {
  reload: () => void;
  now: () => number;
  storage: Pick<Storage, "getItem" | "setItem">;
}

/**
 * Handle one vite:preloadError event. Returns true when a recovery reload was
 * triggered, false when the guard suppressed it (recent reload already tried).
 */
export function handlePreloadError(
  event: Pick<Event, "preventDefault">,
  hooks: PreloadRecoveryHooks
): boolean {
  const lastReloadAt = Number(hooks.storage.getItem(RELOAD_AT_KEY) ?? 0);
  if (Number.isFinite(lastReloadAt) && hooks.now() - lastReloadAt < RELOAD_WINDOW_MS) {
    return false;
  }
  hooks.storage.setItem(RELOAD_AT_KEY, String(hooks.now()));
  event.preventDefault();
  hooks.reload();
  return true;
}

/** Wire the recovery handler onto a window. Call once at app boot. */
export function installPreloadErrorRecovery(
  win: Pick<Window, "addEventListener" | "sessionStorage"> & { location: { reload: () => void } },
  hooks: Partial<PreloadRecoveryHooks> = {}
): void {
  const effective: PreloadRecoveryHooks = {
    reload: hooks.reload ?? (() => win.location.reload()),
    now: hooks.now ?? (() => Date.now()),
    storage: hooks.storage ?? win.sessionStorage,
  };
  win.addEventListener("vite:preloadError", (event) => {
    try {
      handlePreloadError(event, effective);
    } catch {
      // Recovery must never break the app; a storage failure (e.g. disabled
      // sessionStorage) just means the original import error surfaces.
    }
  });
}
