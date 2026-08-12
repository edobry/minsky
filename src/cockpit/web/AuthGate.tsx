/**
 * Passkey sign-in gate for the public cockpit deployment (mt#4023).
 *
 * The server denies every data route without a session; this is the screen the
 * operator sees instead of an app full of failed requests.
 *
 * Local-daemon behavior is deliberately unchanged: the auth routes are mounted
 * only on the `isPublicDeployment` branch, so `/api/auth/status` 404s on a
 * local cockpit and this component renders its children untouched. That is why
 * the not-mounted case is treated as "no gate here" rather than as an error —
 * getting it backwards would lock the local daemon out of itself.
 */
import { useCallback, useEffect, useState } from "react";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

interface AuthStatus {
  /** False on a local daemon: no gate is present, render straight through. */
  gated?: boolean;
  authenticated: boolean;
  enrollmentOpen: boolean;
}

type GateState =
  | { kind: "checking" }
  | { kind: "not-applicable" }
  | { kind: "authenticated" }
  | { kind: "locked"; enrollmentOpen: boolean };

async function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * True on a published share page (mt#4024). Those are public by design — the
 * whole feature is handing a link to someone who has no account — so the gate
 * must not render a login screen over them. Read from `window.location`
 * directly rather than from the router, because AuthGate sits ABOVE the routes
 * and must decide before anything below it mounts.
 *
 * Narrow by construction: only `/s/<token>` matches. The server is the actual
 * authority (`isPublicPath`); this only keeps the client from covering a page
 * the server already agreed to serve.
 */
function isPublicSharePath(pathname: string): boolean {
  return /^\/s\/[^/]+\/?$/.test(pathname);
}

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: "checking" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (isPublicSharePath(window.location.pathname)) {
      setState({ kind: "not-applicable" });
      return;
    }
    try {
      const res = await fetch("/api/auth/status");
      if (!res.ok) {
        setState({ kind: "locked", enrollmentOpen: false });
        return;
      }
      // Every cockpit answers this route, so a non-JSON body means something
      // other than the endpoint replied (the SPA catch-all, a proxy) — fail
      // closed rather than guess.
      const status = (await res.json().catch(() => null)) as AuthStatus | null;
      if (!status) {
        setState({ kind: "locked", enrollmentOpen: false });
        return;
      }
      if (status.gated === false) {
        setState({ kind: "not-applicable" });
        return;
      }
      setState(
        status.authenticated
          ? { kind: "authenticated" }
          : { kind: "locked", enrollmentOpen: status.enrollmentOpen }
      );
    } catch {
      setState({ kind: "locked", enrollmentOpen: false });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runCeremony = useCallback(
    async (mode: "login" | "register") => {
      setBusy(true);
      setError(null);
      try {
        const startRes = await postJson(`/api/auth/passkey/${mode}/start`, {});
        if (!startRes.ok) {
          const body = (await startRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Could not start ${mode}`);
        }
        const { ceremonyId, options } = (await startRes.json()) as {
          ceremonyId: string;
          options: Record<string, unknown>;
        };

        const response =
          mode === "register"
            ? await startRegistration({ optionsJSON: options as never })
            : await startAuthentication({ optionsJSON: options as never });

        const finishRes = await postJson(`/api/auth/passkey/${mode}/finish`, {
          ceremonyId,
          response,
        });
        if (!finishRes.ok) {
          const body = (await finishRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `Could not complete ${mode}`);
        }
        await refresh();
      } catch (err: unknown) {
        // A user who dismisses the system passkey sheet lands here too; the
        // browser's own message is clearer than anything invented for it.
        setError(err instanceof Error ? err.message : "Passkey ceremony failed");
      } finally {
        setBusy(false);
      }
    },
    [refresh]
  );

  if (state.kind === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Checking sign-in…
      </div>
    );
  }

  if (state.kind === "authenticated" || state.kind === "not-applicable") {
    return <>{children}</>;
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-border p-6">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">Minsky Cockpit</h1>
          <p className="text-sm text-muted-foreground">
            {state.enrollmentOpen
              ? "No passkey is registered yet. Set one up to take ownership of this instance."
              : "Sign in with your passkey to continue."}
          </p>
        </div>

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}

        <button
          type="button"
          className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          disabled={busy}
          onClick={() => void runCeremony(state.enrollmentOpen ? "register" : "login")}
        >
          {busy ? "Waiting for passkey…" : state.enrollmentOpen ? "Set up a passkey" : "Sign in"}
        </button>

        {state.enrollmentOpen ? null : (
          <button
            type="button"
            className="w-full text-xs text-muted-foreground underline disabled:opacity-60"
            disabled={busy}
            onClick={() => void runCeremony("register")}
          >
            Add another passkey (requires an existing session)
          </button>
        )}
      </div>
    </div>
  );
}
