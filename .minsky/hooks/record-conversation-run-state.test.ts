import { describe, test, expect } from "bun:test";
import {
  buildIngestBody,
  postRunState,
  readCockpitToken,
  resolveCockpitOrigin,
  COCKPIT_URL_ENV,
  DEFAULT_COCKPIT_ORIGIN,
  RUN_STATE_POST_TIMEOUT_MS,
  MAX_BODY_CHARS,
  STATE_DIR_ENV,
  type RunStateIo,
} from "./record-conversation-run-state";
import type { ClaudeHookInput } from "./types";

const AT = new Date("2026-07-24T19:00:00.000Z");
const STATE_DIR = "/mock/state";
const TOKEN = "a".repeat(64);

/**
 * In-memory IO surface. Injected rather than touching the real filesystem, so
 * these tests exercise the resolution LOGIC with no temp dirs, no
 * `process.env` mutation, and no cross-test races.
 */
function fakeIo(files: Record<string, string>, env: Record<string, string> = {}): RunStateIo {
  return {
    readFile(filePath) {
      const contents = files[filePath];
      if (contents === undefined) throw new Error(`ENOENT: ${filePath}`);
      return contents;
    },
    readDir(dirPath) {
      const prefix = `${dirPath}/`;
      const entries = Object.keys(files)
        .filter((f) => f.startsWith(prefix))
        .map((f) => f.slice(prefix.length))
        .filter((rest) => !rest.includes("/"));
      if (entries.length === 0) throw new Error(`ENOENT: ${dirPath}`);
      return entries;
    },
    env: { [STATE_DIR_ENV]: STATE_DIR, ...env },
  };
}

const BASE_INPUT: ClaudeHookInput = {
  session_id: "conv-1",
  hook_event_name: "PreToolUse",
  cwd: "/repo",
};

/**
 * Every payload key `packages/domain/src/conversation-run-state/event-mapping.ts`
 * reads, across all ten mapped events. Each is read through its `str()` helper,
 * which requires `typeof value === "string"` — so the bound must leave every one
 * of these both PRESENT and STRING-TYPED.
 */
const CONSUMED_PAYLOAD_KEYS = [
  "prompt_id",
  "tool_name",
  "error_type",
  "error_message",
  "type",
  "trigger",
  "reason",
] as const;

describe("buildIngestBody", () => {
  test("forwards the whole payload so the mapping can stay server-side", () => {
    const input: ClaudeHookInput = { ...BASE_INPUT, tool_name: "Bash" } as ClaudeHookInput;
    const body = buildIngestBody(input, AT);
    expect(body).not.toBeNull();
    expect(body?.["conversationId"]).toBe("conv-1");
    expect(body?.["eventName"]).toBe("PreToolUse");
    expect(body?.["cwd"]).toBe("/repo");
    const payload = body?.["payload"] as Record<string, unknown>;
    expect(payload["tool_name"]).toBe("Bash");
  });

  // AT1 — the defect: an unbounded payload exceeded the daemon's body limit, so
  // the event was rejected and dropped. A `PostToolUse` `tool_response` of this
  // size is ordinary, not adversarial.
  test("bounds a multi-megabyte tool_response below the body ceiling", () => {
    const input = {
      ...BASE_INPUT,
      hook_event_name: "PostToolUse",
      tool_name: "Grep",
      tool_response: "x".repeat(5 * 1024 * 1024),
    } as unknown as ClaudeHookInput;

    const body = buildIngestBody(input, AT);
    expect(body).not.toBeNull();
    expect(JSON.stringify(body).length).toBeLessThanOrEqual(MAX_BODY_CHARS);

    const payload = body?.["payload"] as Record<string, unknown>;
    // Marked as truncated, not silently vanished — a reader can tell bounded
    // data from complete data.
    expect(String(payload["tool_response"])).toContain("truncated");
    // ...and the field the server actually reads is untouched.
    expect(payload["tool_name"]).toBe("Grep");
  });

  // AT2 — field-coverage regression: the bound must not drop a column the
  // server maps. Guards against a future tightening that trims real fields.
  test("preserves every payload field event-mapping consumes", () => {
    const input = {
      ...BASE_INPUT,
      tool_response: "x".repeat(2 * 1024 * 1024),
      ...Object.fromEntries(CONSUMED_PAYLOAD_KEYS.map((k) => [k, `value-of-${k}`])),
    } as unknown as ClaudeHookInput;

    const payload = buildIngestBody(input, AT)?.["payload"] as Record<string, unknown>;
    for (const key of CONSUMED_PAYLOAD_KEYS) {
      expect(payload[key]).toBe(`value-of-${key}`);
      expect(typeof payload[key]).toBe("string");
    }
  });

  test("bounds a payload of many mid-sized fields that individually pass", () => {
    // No single field trips the per-field ceiling, but together they would blow
    // past the body ceiling — the case a per-field bound alone would miss.
    const fields = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`filler_${i}`, "y".repeat(2000)])
    );
    const input = { ...BASE_INPUT, ...fields, tool_name: "Bash" } as unknown as ClaudeHookInput;

    const body = buildIngestBody(input, AT);
    expect(JSON.stringify(body).length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect((body?.["payload"] as Record<string, unknown>)["tool_name"]).toBe("Bash");
  });

  test("keeps an oversized non-string as a marker rather than a plausible value", () => {
    const input = {
      ...BASE_INPUT,
      tool_input: { rows: Array.from({ length: 20000 }, (_, i) => i) },
    } as unknown as ClaudeHookInput;

    const payload = buildIngestBody(input, AT)?.["payload"] as Record<string, unknown>;
    const marker = payload["tool_input"] as Record<string, unknown>;
    expect(marker["__truncated"]).toBe(true);
    // Not a string — so the server's string-typed accessor reads it as absent
    // instead of as a real value.
    expect(typeof payload["tool_input"]).not.toBe("string");
  });

  test("stamps observedAt at OBSERVATION time so transport latency cannot backdate liveness", () => {
    const body = buildIngestBody(BASE_INPUT, AT);
    expect(body?.["observedAt"]).toBe(AT.toISOString());
  });

  test("returns null when the payload lacks the fields that make it addressable", () => {
    expect(buildIngestBody({ hook_event_name: "Stop" } as ClaudeHookInput, AT)).toBeNull();
    expect(buildIngestBody({ session_id: "c" } as ClaudeHookInput, AT)).toBeNull();
    expect(buildIngestBody(undefined as unknown as ClaudeHookInput, AT)).toBeNull();
  });
});

describe("resolveCockpitOrigin", () => {
  test("prefers the explicit override env var", () => {
    const io = fakeIo({}, { [COCKPIT_URL_ENV]: "http://127.0.0.1:9999" });
    expect(resolveCockpitOrigin(io)).toBe("http://127.0.0.1:9999");
  });

  test("reads the recorded url from the main cockpit state file", () => {
    const io = fakeIo({
      [`${STATE_DIR}/cockpit/main.json`]: JSON.stringify({ url: "http://127.0.0.1:4242" }),
    });
    expect(resolveCockpitOrigin(io)).toBe("http://127.0.0.1:4242");
  });

  test("prefers main.json over a per-workspace state file", () => {
    const io = fakeIo({
      [`${STATE_DIR}/cockpit/abc-session.json`]: JSON.stringify({ url: "http://127.0.0.1:5555" }),
      [`${STATE_DIR}/cockpit/main.json`]: JSON.stringify({ url: "http://127.0.0.1:4242" }),
    });
    expect(resolveCockpitOrigin(io)).toBe("http://127.0.0.1:4242");
  });

  test("falls back to a per-workspace state file when main.json is absent", () => {
    const io = fakeIo({
      [`${STATE_DIR}/cockpit/abc-session.json`]: JSON.stringify({ url: "http://127.0.0.1:5555" }),
    });
    expect(resolveCockpitOrigin(io)).toBe("http://127.0.0.1:5555");
  });

  test("falls back to the default origin when no state file exists", () => {
    expect(resolveCockpitOrigin(fakeIo({}))).toBe(DEFAULT_COCKPIT_ORIGIN);
  });

  test("a malformed state file degrades to the default instead of throwing", () => {
    const io = fakeIo({ [`${STATE_DIR}/cockpit/main.json`]: "{not json" });
    expect(resolveCockpitOrigin(io)).toBe(DEFAULT_COCKPIT_ORIGIN);
  });
});

describe("readCockpitToken", () => {
  test("reads a canonical 64-hex token", () => {
    const io = fakeIo({ [`${STATE_DIR}/cockpit-token`]: `${TOKEN}\n` });
    expect(readCockpitToken(io)).toBe(TOKEN);
  });

  test("rejects a non-canonical token rather than sending a request that will 401", () => {
    const io = fakeIo({ [`${STATE_DIR}/cockpit-token`]: "not-a-real-token" });
    expect(readCockpitToken(io)).toBeNull();
  });

  test("returns null when the token file is absent", () => {
    expect(readCockpitToken(fakeIo({}))).toBeNull();
  });
});

describe("postRunState — fail-open contract", () => {
  test("returns false instead of throwing when the daemon is unreachable", async () => {
    // Port 1 on loopback refuses immediately. The contract that matters is that
    // this RESOLVES false rather than rejecting: a throw here would propagate
    // out of the hook and risk a non-zero exit, which is exactly what blocks
    // the turn the hook is observing.
    const ok = await postRunState("http://127.0.0.1:1", TOKEN, { conversationId: "c" });
    expect(ok).toBe(false);
  });

  test("returns false on a non-2xx rather than treating the write as landed", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 401 }) });
    try {
      const ok = await postRunState(`http://127.0.0.1:${server.port}`, TOKEN, {
        conversationId: "c",
      });
      expect(ok).toBe(false);
    } finally {
      server.stop(true);
    }
  });

  test("sends the bearer token and the JSON body, and reports true on 2xx", async () => {
    let seenAuth: string | null = null;
    let seenBody: Record<string, unknown> = {};
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seenAuth = req.headers.get("authorization");
        seenBody = (await req.json()) as Record<string, unknown>;
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    try {
      const ok = await postRunState(`http://127.0.0.1:${server.port}`, TOKEN, {
        conversationId: "conv-1",
        eventName: "Stop",
      });
      expect(ok).toBe(true);
      expect(seenAuth).toBe(`Bearer ${TOKEN}`);
      expect(seenBody["conversationId"]).toBe("conv-1");
    } finally {
      server.stop(true);
    }
  });

  test("gives up on a slow daemon within its budget instead of stalling the turn", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await Bun.sleep(RUN_STATE_POST_TIMEOUT_MS * 6);
        return new Response("late");
      },
    });
    try {
      const started = performance.now();
      const ok = await postRunState(`http://127.0.0.1:${server.port}`, TOKEN, {
        conversationId: "c",
      });
      const elapsed = performance.now() - started;
      expect(ok).toBe(false);
      // Bounded by the hook's own budget, not by the server's response.
      expect(elapsed).toBeLessThan(RUN_STATE_POST_TIMEOUT_MS * 4);
    } finally {
      server.stop(true);
    }
  });
});
