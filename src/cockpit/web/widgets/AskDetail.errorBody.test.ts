/**
 * Error-body readability for the ask mutation helpers (mt#4503).
 *
 * `resolveAsk`/`deferAsk`/`escalateAsk` interpolated `res.text()` straight into
 * their thrown message. That was harmless while nothing rendered the error and
 * became a defect the moment the ask panel started showing it: the cockpit's own
 * endpoints answer `{"error": "..."}`, so the operator was reading a JSON
 * literal with escaped quotes. Caught by looking at the rendered page, not by a
 * test — which is why one exists now.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach } from "bun:test";
import { resolveAsk, deferAsk, escalateAsk } from "./AskDetail";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stub(status: number, body: string, contentType = "application/json"): void {
  globalThis.fetch = (async () =>
    new Response(body, {
      status,
      headers: { "Content-Type": contentType },
    })) as unknown as typeof globalThis.fetch;
}

async function messageOf(run: () => Promise<void>): Promise<string> {
  try {
    await run();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the helper to throw");
}

describe("ask mutation errors read as prose, not as a JSON literal (mt#4503)", () => {
  test("a cockpit {error} body surfaces only its message", async () => {
    stub(409, JSON.stringify({ error: 'respondAndCloseAsk: Ask is in "closed" state' }));

    const message = await messageOf(() => resolveAsk("ask-1", {}));
    expect(message).toBe('resolve failed (409): respondAndCloseAsk: Ask is in "closed" state');
    // The shape the operator actually saw in the browser before this landed.
    expect(message).not.toContain('{"error"');
    expect(message).not.toContain('\\"');
  });

  test("the status code survives — it is what tells the failures apart", async () => {
    stub(503, JSON.stringify({ error: "Ask repository unavailable" }));
    expect(await messageOf(() => resolveAsk("ask-1", {}))).toBe(
      "resolve failed (503): Ask repository unavailable"
    );
  });

  test("a non-JSON body falls back to the raw text rather than to nothing", async () => {
    // A proxy 502 page is HTML. A mangled message beats an empty one.
    stub(502, "<html><body>Bad Gateway</body></html>", "text/html");
    expect(await messageOf(() => resolveAsk("ask-1", {}))).toContain("Bad Gateway");
  });

  test("a JSON body with no `error` key falls back to the raw text", async () => {
    stub(500, JSON.stringify({ detail: "something else" }));
    expect(await messageOf(() => resolveAsk("ask-1", {}))).toContain('"detail"');
  });

  test("defer and escalate get the same treatment, not just resolve", async () => {
    stub(500, JSON.stringify({ error: "boom" }));
    expect(await messageOf(() => deferAsk("ask-1"))).toBe("defer failed (500): boom");
    expect(await messageOf(() => escalateAsk("ask-1"))).toBe("escalate failed (500): boom");
  });
});
