#!/usr/bin/env bun
/**
 * E2E verification artifact for `minsky mcp shim` (mt#3812) — the §7a
 * structural-change smoke script this task's spec Success Criteria names
 * ("scripts/verify-conv-identity-injection.ts (or a sibling) exercises the
 * shim path end to end"), and the harness for the spec's BLOCKING-added
 * acceptance test (cold-start recovery without a client-visible error).
 *
 * Spawns the REAL shim (`bun scripts/cli-entry.ts mcp shim --url ...`, the
 * exact command an installed `minsky` binary runs) against a minimal mock
 * HTTP daemon (Bun.serve) that implements the same session-lifecycle
 * contract as src/mcp/server.ts's Streamable-HTTP handler: mints an
 * Mcp-Session-Id on `initialize`, rejects any other request carrying an
 * unknown/absent session id with a 404 `-32001 Session not found`, and
 * echoes a tools/call request's `_meta` back in its result so the test can
 * assert the shim's identity stamp actually crossed the wire (not just
 * that the pure `injectAgentIdMeta()` function is correct — identity.test.ts
 * already covers that in isolation).
 *
 * Using a protocol-compatible mock daemon rather than a full
 * `minsky mcp start --http` process is a deliberate scope choice: the real
 * daemon's lifecycle (fixed port, conflict detection, bearer-token
 * generation) is mt#3814's job, still unbuilt at this task's authoring
 * time — the spec names it as a separate subtask this task "bridges."
 * Testing against the exact wire contract this shim was built against
 * (src/mcp/server.ts's handleHttpPost, read in full while writing
 * src/mcp/shim/client.ts) is what makes this an END-TO-END proof of the
 * shim binary rather than a restatement of the unit tests.
 *
 * Cases:
 *   1. active:        CLAUDE_CODE_SESSION_ID set to a UUID -> tools/call
 *                      arrives at the daemon with _meta["io.minsky/agent_id"]
 *                      === com.anthropic.claude-code:conv:<uuid> (AT1, minus
 *                      the "not the launcher's pid" discriminator, which
 *                      case 2 supplies structurally: the env var is the ONLY
 *                      source, so its absence necessarily produces no stamp
 *                      at all rather than some ambient fallback identity).
 *   2. hookless:       env var absent -> tools/call forwarded with NO
 *                      _meta["io.minsky/agent_id"] key at all (AT3).
 *   3. already-set:    an inbound tools/call already carrying agent_id in
 *                      _meta passes through UNCHANGED (AT2).
 *   4. cold-start:     daemon stopped mid-conversation, restarted on the
 *                      SAME port; a tools/call issued during the down
 *                      window succeeds once the daemon returns, with the
 *                      client never observing an error (the spec's
 *                      BLOCKING-added acceptance test / mt#3811's gap).
 *
 * Requires no external env vars, credentials, or network — fully hermetic.
 * Exit 0 = all cases pass; non-zero = failure, JSON summary on stdout.
 *
 * Usage: bun scripts/verify-mcp-shim-e2e.ts
 */

import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { createInterface } from "readline";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { safeTruncate } from "@minsky/shared/safe-truncate";
import { readConversationMapping, resolveHarnessPid } from "@minsky/shared/conversation-pid-map";

const AGENT_ID_META_KEY = "io.minsky/agent_id";
/** The unprefixed `_meta` key MCP reserves for W3C Baggage (mt#3986). */
const BAGGAGE_META_KEY = "baggage";
const GEN_AI_CONVERSATION_ID_KEY = "gen_ai.conversation.id";
const TEST_UUID = "e2e0f1d2-3c4b-4a5d-9e8f-0123456789ab";
const EXPECTED_AGENT_ID = `com.anthropic.claude-code:conv:${TEST_UUID}`;
const EXPECTED_BAGGAGE = `${GEN_AI_CONVERSATION_ID_KEY}=${TEST_UUID}`;
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(SCRIPT_DIR, "cli-entry.ts");

interface JsonRpcLine {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Minimal mock MCP HTTP daemon matching src/mcp/server.ts's Streamable-HTTP
 * session contract closely enough to exercise the shim's real wire
 * behavior: initialize mints a session id; any other request with an
 * unknown/missing session id gets 404 -32001; tools/call echoes _meta back.
 */
function startMockDaemon(port: number): {
  server: ReturnType<typeof Bun.serve>;
  sessionIds: Set<string>;
} {
  const sessionIds = new Set<string>();
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });

      if (req.method === "DELETE") {
        const sid = req.headers.get("mcp-session-id");
        if (sid) sessionIds.delete(sid);
        return new Response(null, { status: 200 });
      }
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

      const body = (await req.json()) as JsonRpcLine;
      const sid = req.headers.get("mcp-session-id");

      if (body.method === "initialize") {
        const newSid = randomUUID();
        sessionIds.add(newSid);
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2025-06-18" },
          }),
          { status: 200, headers: { "content-type": "application/json", "mcp-session-id": newSid } }
        );
      }

      if (!sid || !sessionIds.has(sid)) {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" } }),
          { status: 404, headers: { "content-type": "application/json" } }
        );
      }

      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }

      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { receivedMeta: body.params?.["_meta"] ?? null, toolName: body.params?.["name"] },
        }),
        { status: 200, headers: { "content-type": "application/json", "mcp-session-id": sid } }
      );
    },
  });
  return { server, sessionIds };
}

interface ShimHandle {
  child: ChildProcess;
  lines: JsonRpcLine[];
  stderrTail: string;
  write(msg: JsonRpcLine): void;
  waitForId(id: number, timeoutMs: number): Promise<JsonRpcLine | null>;
}

function spawnShim(daemonUrl: string, env: Record<string, string | undefined>): ShimHandle {
  const child = spawn("bun", [CLI_ENTRY, "mcp", "shim", "--url", daemonUrl], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lines: JsonRpcLine[] = [];
  const rl = createInterface({ input: child.stdout as NodeJS.ReadableStream });
  rl.on("line", (line: string) => {
    if (!line.trim()) return;
    try {
      lines.push(JSON.parse(line) as JsonRpcLine);
    } catch {
      // non-JSON stdout output — ignore for this harness's purposes.
    }
  });

  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderrTail = safeTruncate(stderrTail + String(chunk), 4000, "tail");
  });

  return {
    child,
    lines,
    get stderrTail() {
      return stderrTail;
    },
    write(msg: JsonRpcLine) {
      child.stdin?.write(`${JSON.stringify(msg)}\n`);
    },
    async waitForId(id: number, timeoutMs: number): Promise<JsonRpcLine | null> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = lines.find((l) => l.id === id);
        if (found) return found;
        await sleep(100);
      }
      return null;
    },
  } as ShimHandle;
}

async function findFreePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  await sleep(50);
  if (port === undefined) {
    throw new Error("Bun.serve did not assign an ephemeral port");
  }
  return port;
}

async function runIdentityCase(opts: {
  name: string;
  env: Record<string, string | undefined>;
  assert: (toolsCallResponse: JsonRpcLine) => string | null;
}): Promise<CaseResult> {
  const port = await findFreePort();
  const { server } = startMockDaemon(port);
  const shim = spawnShim(`http://127.0.0.1:${port}/mcp`, opts.env);

  try {
    shim.write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify" } },
    });
    const initResp = await shim.waitForId(1, 8000);
    if (!initResp) {
      return {
        name: opts.name,
        pass: false,
        detail: `initialize timed out; stderr: ${shim.stderrTail}`,
      };
    }
    shim.write({ jsonrpc: "2.0", method: "notifications/initialized" });

    shim.write({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "tasks_get", arguments: { taskId: "mt#3812" } },
    });
    const toolResp = await shim.waitForId(2, 8000);
    if (!toolResp) {
      return {
        name: opts.name,
        pass: false,
        detail: `tools/call timed out; stderr: ${shim.stderrTail}`,
      };
    }

    const failure = opts.assert(toolResp);
    return { name: opts.name, pass: failure === null, detail: failure ?? "ok" };
  } finally {
    shim.child.kill("SIGTERM");
    server.stop(true);
  }
}

/**
 * `expectedBaggage` is passed in rather than derived from the env constant
 * (mt#4440): baggage carries whichever conversation the shim actually resolved,
 * which since mt#4440 is the live mapping where one exists. The agent_id half of
 * this assertion is unaffected — a caller-declared id is preserved regardless of
 * where the conversation grain came from.
 */
async function runAlreadySetCase(expectedBaggage: string): Promise<CaseResult> {
  const port = await findFreePort();
  const { server } = startMockDaemon(port);
  const shim = spawnShim(`http://127.0.0.1:${port}/mcp`, { CLAUDE_CODE_SESSION_ID: TEST_UUID });
  const preDeclaredAgentId = "minsky.native-subagent:task:mt#1@parent";

  try {
    shim.write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify" } },
    });
    await shim.waitForId(1, 8000);
    shim.write({ jsonrpc: "2.0", method: "notifications/initialized" });

    shim.write({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "tasks_get",
        arguments: { taskId: "mt#3812" },
        _meta: { [AGENT_ID_META_KEY]: preDeclaredAgentId },
      },
    });
    const toolResp = await shim.waitForId(2, 8000);
    if (!toolResp) {
      return {
        name: "already-set: pre-declared agent_id passes through unchanged (AT2)",
        pass: false,
        detail: `tools/call timed out; stderr: ${shim.stderrTail}`,
      };
    }
    const receivedMeta = (toolResp.result as { receivedMeta?: Record<string, unknown> } | undefined)
      ?.receivedMeta;
    // mt#3986: the agent_id is still preserved, but the frame is no longer
    // byte-identical — baggage is decided independently, so the caller keeps
    // its declared grain AND the conversation crosses the wire as well.
    const agentIdPreserved = receivedMeta?.[AGENT_ID_META_KEY] === preDeclaredAgentId;
    const baggageAdded = receivedMeta?.[BAGGAGE_META_KEY] === expectedBaggage;
    const pass = agentIdPreserved && baggageAdded;
    return {
      name: "already-set: pre-declared agent_id preserved, baggage still added (AT2)",
      pass,
      detail: pass
        ? "ok"
        : `expected agent_id unchanged (${preDeclaredAgentId}) and baggage ${expectedBaggage}, got: ${JSON.stringify(receivedMeta)}`,
    };
  } finally {
    shim.child.kill("SIGTERM");
    server.stop(true);
  }
}

async function runColdStartCase(): Promise<CaseResult> {
  const port = await findFreePort();
  let { server } = startMockDaemon(port);
  const shim = spawnShim(`http://127.0.0.1:${port}/mcp`, { CLAUDE_CODE_SESSION_ID: TEST_UUID });

  try {
    shim.write({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify" } },
    });
    const initResp = await shim.waitForId(1, 8000);
    if (!initResp) {
      return {
        name: "cold-start",
        pass: false,
        detail: `initial initialize timed out; stderr: ${shim.stderrTail}`,
      };
    }
    shim.write({ jsonrpc: "2.0", method: "notifications/initialized" });
    await sleep(200);

    // Stop the daemon — simulates a restart. The tools/call below is issued
    // WHILE nothing is listening (the mt#3811 cold-start-gap case).
    server.stop(true);
    await sleep(200);

    shim.write({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "tasks_get", arguments: { taskId: "mt#3812" } },
    });

    // Give the shim a moment to observe connection-refused and start
    // retrying, then bring the daemon back on the SAME port — a fresh
    // process (fresh session table), matching a real daemon restart.
    await sleep(800);
    ({ server } = startMockDaemon(port));

    const toolResp = await shim.waitForId(2, 15000);
    if (!toolResp) {
      return {
        name: "cold-start: tool call issued during the down window succeeds once the daemon returns",
        pass: false,
        detail: `no response arrived within the retry window; stderr: ${shim.stderrTail}`,
      };
    }
    if (toolResp.error) {
      return {
        name: "cold-start: tool call issued during the down window succeeds once the daemon returns",
        pass: false,
        detail: `client observed an error frame instead of success: ${JSON.stringify(toolResp.error)}`,
      };
    }
    const reinitLogged = shim.stderrTail.includes("re-initializ");
    return {
      name: "cold-start: tool call issued during the down window succeeds once the daemon returns",
      pass: reinitLogged,
      detail: reinitLogged
        ? "ok — result arrived with no error frame, and the shim logged re-initialization"
        : `result arrived clean but no re-initialize log line was observed; stderr: ${shim.stderrTail}`,
    };
  } finally {
    shim.child.kill("SIGTERM");
    server.stop(true);
  }
}

/**
 * Case 5 — the LIVE mapping beats a stale spawn-time env value (mt#4440, AT1).
 *
 * Every case above supplies `CLAUDE_CODE_SESSION_ID` and asserts the shim
 * stamps it, which is exactly the behavior that was WRONG: the env value is
 * frozen when Claude Code spawns the shim, and a `/clear` changes the
 * conversation without a respawn. A shim that outlived a clear kept stamping a
 * conversation that had ended, and nothing in this file could see it, because
 * every case here agreed with the env by construction.
 *
 * So this case deliberately makes the two sources DISAGREE: it feeds the shim a
 * stale UUID in the environment while the real `<harness pid> → conversation id`
 * mapping on this machine names the current one, and asserts the mapping wins on
 * the bytes the daemon actually received.
 *
 * It uses the REAL mapping and the REAL ancestor walk rather than a fixture:
 * the shim resolves its harness pid by walking to the nearest `claude` process,
 * and this script is itself a descendant of one when run from an agent session
 * or a developer's terminal. That is the whole point — a fixture would re-test
 * the unit tests, while this exercises the resolution path that actually ships.
 *
 * SKIPS (does not fail) where no harness ancestor or no mapping entry exists —
 * CI, a bare shell, a container. The condition is reported rather than swallowed,
 * so a skip can never be mistaken for a pass.
 */
async function runLiveMappingCase(): Promise<CaseResult> {
  const name = "live mapping BEATS a stale spawn-time env value (mt#4440 AT1)";

  const harnessPid = resolveHarnessPid();
  if (harnessPid === null) {
    return {
      name,
      pass: true,
      detail:
        "SKIP: no `claude` harness ancestor — the live mapping path cannot be exercised here (expected in CI)",
    };
  }

  const liveConversationId = readConversationMapping(harnessPid);
  if (liveConversationId === null) {
    return {
      name,
      pass: true,
      detail: `SKIP: harness pid ${harnessPid} has no mapping entry (no SessionStart hook has run for it)`,
    };
  }

  // Deliberately NOT the live id: this is what a shim spawned before the last
  // `/clear` would be holding.
  const staleUuid = "00000000-1111-4222-8333-444444444444";
  if (liveConversationId === staleUuid) {
    return { name, pass: false, detail: "fixture collision: live id equals the stale sentinel" };
  }

  const expectedLiveAgentId = `com.anthropic.claude-code:conv:${liveConversationId}`;
  const staleAgentId = `com.anthropic.claude-code:conv:${staleUuid}`;

  const result = await runIdentityCase({
    name,
    env: { CLAUDE_CODE_SESSION_ID: staleUuid },
    assert: (toolResp) => {
      const receivedMeta = (
        toolResp.result as { receivedMeta?: Record<string, unknown> } | undefined
      )?.receivedMeta;
      const received = receivedMeta?.[AGENT_ID_META_KEY];

      if (received === staleAgentId) {
        return `REPRODUCED THE DEFECT: the shim stamped the stale spawn-time id ${staleAgentId} instead of the live ${expectedLiveAgentId}`;
      }
      if (received !== expectedLiveAgentId) {
        return `expected _meta[${AGENT_ID_META_KEY}] === ${expectedLiveAgentId} (from the live mapping for harness pid ${harnessPid}), got: ${JSON.stringify(receivedMeta)}`;
      }
      // The baggage entry must carry the same LIVE id — a reader resolving
      // either key has to land on one conversation.
      const expectedBaggage = `${GEN_AI_CONVERSATION_ID_KEY}=${liveConversationId}`;
      if (receivedMeta?.[BAGGAGE_META_KEY] !== expectedBaggage) {
        return `expected _meta[${BAGGAGE_META_KEY}] === ${expectedBaggage}, got: ${JSON.stringify(receivedMeta)}`;
      }
      return null;
    },
  });

  return {
    ...result,
    detail:
      result.detail === "ok"
        ? `ok: harness pid ${harnessPid} -> ${expectedLiveAgentId} (env held ${staleAgentId})`
        : result.detail,
  };
}

async function main(): Promise<void> {
  const results: CaseResult[] = [];

  // mt#4440: the env var is no longer the only source. The shim now prefers the
  // live `<harness pid> → conversation id` mapping, so on a machine where one
  // exists for this process's harness ancestor, the mapping is what crosses the
  // wire — by design. Every case below is written against the source that
  // actually wins here rather than assuming the env does, which is what these
  // cases assumed when the shim was env-only.
  //
  // Resolved ONCE, with the same two calls the shim itself makes, so a case's
  // expectation cannot drift from what the binary under test will do.
  const ambientHarnessPid = resolveHarnessPid();
  const ambientLiveId =
    ambientHarnessPid !== null ? readConversationMapping(ambientHarnessPid) : null;
  const expectedActiveId = ambientLiveId
    ? `com.anthropic.claude-code:conv:${ambientLiveId}`
    : EXPECTED_AGENT_ID;
  const expectedActiveBaggage = ambientLiveId
    ? `${GEN_AI_CONVERSATION_ID_KEY}=${ambientLiveId}`
    : EXPECTED_BAGGAGE;
  const ambientNote = ambientLiveId
    ? `live mapping present (harness pid ${ambientHarnessPid})`
    : "no live mapping — env is the only source";

  results.push(
    await runIdentityCase({
      name: `active: the live conv-scoped agent_id crosses the HTTP wire (AT1) [${ambientNote}]`,
      env: { CLAUDE_CODE_SESSION_ID: TEST_UUID },
      assert: (toolResp) => {
        const receivedMeta = (
          toolResp.result as { receivedMeta?: Record<string, unknown> } | undefined
        )?.receivedMeta;
        if (!receivedMeta || receivedMeta[AGENT_ID_META_KEY] !== expectedActiveId) {
          return `expected _meta[${AGENT_ID_META_KEY}] === ${expectedActiveId}, got: ${JSON.stringify(receivedMeta)}`;
        }
        // mt#3986: the same conversation id must ALSO cross the wire as the
        // W3C baggage entry, so a server reading either key resolves the same
        // identity. Asserted on the bytes the daemon actually received.
        if (receivedMeta[BAGGAGE_META_KEY] !== expectedActiveBaggage) {
          return `expected _meta[${BAGGAGE_META_KEY}] === ${expectedActiveBaggage}, got: ${JSON.stringify(receivedMeta)}`;
        }
        return null;
      },
    })
  );

  if (ambientLiveId) {
    // A hookless environment is one with NO identity source at all. Where a live
    // mapping exists it is a real source, so the condition cannot be simulated
    // by unsetting the env var — the shim correctly stamps the mapped id, and
    // asserting "no _meta" here would be asserting the defect. Reported as a
    // skip rather than quietly dropped.
    results.push({
      name: "hookless: absent env forwards tools/call without _meta agent_id key (AT3)",
      pass: true,
      detail: `SKIP: cannot simulate hookless — a live mapping exists for harness pid ${ambientHarnessPid}, which is itself a valid identity source`,
    });
  } else {
    results.push(
      await runIdentityCase({
        name: "hookless: absent env forwards tools/call without _meta agent_id key (AT3)",
        env: { CLAUDE_CODE_SESSION_ID: undefined },
        assert: (toolResp) => {
          const receivedMeta = (toolResp.result as { receivedMeta?: unknown } | undefined)
            ?.receivedMeta;
          return receivedMeta ? `unexpected _meta present: ${JSON.stringify(receivedMeta)}` : null;
        },
      })
    );
  }

  results.push(await runAlreadySetCase(expectedActiveBaggage));
  results.push(await runColdStartCase());
  results.push(await runLiveMappingCase());

  const pass = results.every((r) => r.pass);
  process.stdout.write(
    `${JSON.stringify({ pass, expectedAgentId: EXPECTED_AGENT_ID, results }, null, 2)}\n`
  );
  process.exit(pass ? 0 : 1);
}

await main();
