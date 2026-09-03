/**
 * `AcpTransport` (mt#4936, ADR-047) — the second `DriverTransport`
 * implementation: an Agent Client Protocol (ACP) client speaking JSON-RPC 2.0
 * over stdio to a spawned ACP agent subprocess. Proven first on a non-Claude
 * harness (Codex CLI's `@agentclientprotocol/codex-acp`) and exercised on
 * Claude Code only through its own official ACP adapter
 * (`@agentclientprotocol/claude-agent-acp`) under `auth_mode: "api-key"`.
 *
 * ## The seam this transport enforces
 *
 * mt#2237/mt#2750's load-bearing constraint (restated in ADR-047): drive the
 * genuine Claude binary with the user's OWN credentials, never the Agent SDK
 * with a claude.ai login. `claude-agent-acp` is built on the Agent SDK, so
 * this transport REFUSES to spawn under `authMode !== "api-key"` — there is
 * no `"subscription"` posture for an ACP-driven harness in this build, full
 * stop, not only for `harnessKind: "claude-code-acp"`. See {@link spawn}'s
 * first check.
 *
 * ## Wire protocol
 *
 * Uses `@agentclientprotocol/sdk`'s `ClientSideConnection` (the low-level,
 * still-exported, imperative connection class — NOT the newer
 * `client()`/`connectWith()` builder, whose single-enclosing-callback shape
 * does not fit `DriverTransport`'s multi-call imperative contract: `spawn`,
 * `attach`, `sendUserTurn` and `stop` are four SEPARATE public method calls
 * over a session's life, not one continuation). `ndJsonStream` bridges the
 * spawned child's stdio (Node streams, converted to WHATWG streams via
 * `Writable.toWeb`/`Readable.toWeb`) into the SDK's `Stream` abstraction.
 *
 * ## Session-update classification (mt#4936, SC1)
 *
 * The first producer to classify into `DriverTransportEvent`'s
 * `assistantDelta` / `toolUseStarted` / `toolUseFinished` /
 * `permissionRequested` kinds (`../driver-transport.ts`'s docblock notes
 * `ClaudeStreamJsonTransport` never needed to). ACP's `tool_call_update` can
 * be either a progress update OR a completion; this transport maps EVERY
 * `tool_call_update` to `toolUseFinished` — imprecise for an in-progress
 * update, but the interface exposes no third "tool use progress" kind, and
 * getting the coarse start/finish signal onto the WS stream is what SC1
 * asks for. `plan` / `user_message_chunk` / `agent_thought_chunk` have no
 * matching kind and are forwarded as `raw`, exactly as
 * `ClaudeStreamJsonTransport` forwards everything it does not classify.
 *
 * ## Permission requests become asks (mt#4936, SC2)
 *
 * `session/request_permission` is a genuine JSON-RPC REQUEST the agent
 * blocks on — so the whole create-ask/poll/respond cycle happens INSIDE
 * this transport's `Client.requestPermission` handler, entirely hidden from
 * the supervisor (`../driven-session-host.ts`). See
 * `../../packages/domain/src/ask/acp-permission-request.ts` for the pure
 * draft/classify pair this method drives.
 *
 * @see mt#4936 — this transport
 * @see docs/architecture/adr-047-driver-transport-interface.md
 * @see ./driver-transport.ts — the interface this implements
 * @see ./claude-transport.ts — the sibling this parallels structurally
 */

import { spawn as nodeSpawn } from "child_process";
import { Readable, Writable } from "stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type ContentBlock,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { log } from "@minsky/shared/logger";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";
import { missingCwdReason, probeSpawnCwd } from "./claude-cwd-preflight";
import { readConfiguredAnthropicApiKey } from "@minsky/domain/credentials/anthropic-api-key";
import { readConfiguredOpenAiApiKey } from "@minsky/domain/credentials/openai-api-key";
import {
  TRANSPORT_ID_ACP,
  HARNESS_KIND_CODEX,
  HARNESS_KIND_CLAUDE_CODE_ACP,
} from "@minsky/domain/storage/schemas/driven-session-defaults";
import { DrizzleAskRepository, type AskRepository } from "@minsky/domain/ask/repository";
import { createCachedSqlDbGetter } from "./db-providers";
import {
  buildAcpPermissionRequestAsk,
  classifyAcpPermissionResponse,
  type AcpPermissionOptionInput,
} from "@minsky/domain/ask/acp-permission-request";
import type {
  DriverTransport,
  DriverTransportEvent,
  DriverTransportResumeOptions,
  DriverTransportSpawnResult,
  DriverTransportStartOptions,
  DrivenInputImage,
  DrivenSessionCostSummary,
  ProcessLike,
  SpawnFn,
} from "./driver-transport";

// ---------------------------------------------------------------------------
// Agent command resolution — which ACP agent binary a harnessKind spawns.
// ---------------------------------------------------------------------------

interface AcpAgentCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Which credential this harness's child process needs, and the env var
   * name(s) it reads it from. */
  readonly credential: "openai" | "anthropic";
}

/**
 * Production defaults (mt#4936 Third-party dependency verification): both
 * packages bundle/vendor their own agent binary — `npm install -g` is not
 * required, `npx -y` fetches-and-runs on first use. Overridable per-instance
 * via the constructor `agentCommands` option (test seam — points at a fake
 * script instead of a real network-fetching `npx` invocation).
 */
const DEFAULT_ACP_AGENT_COMMANDS: Readonly<Record<string, AcpAgentCommand>> = {
  [HARNESS_KIND_CODEX]: {
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
    credential: "openai",
  },
  [HARNESS_KIND_CLAUDE_CODE_ACP]: {
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    credential: "anthropic",
  },
};

export class UnknownAcpHarnessError extends Error {
  constructor(harnessKind: string) {
    super(
      `AcpTransport: no ACP agent command configured for harnessKind "${harnessKind}". ` +
        `Known: ${Object.keys(DEFAULT_ACP_AGENT_COMMANDS).join(", ")}`
    );
    this.name = "UnknownAcpHarnessError";
  }
}

/**
 * Thrown when `authMode` is anything other than `"api-key"` — the seam
 * (mt#2237/mt#2750, ADR-047): this transport has no `"subscription"` posture
 * for ANY harness. Grep target for AT4 (`grep -n "subscription" <transport
 * module>`).
 */
export class AcpSubscriptionAuthRefusedError extends Error {
  constructor(harnessKind: string) {
    super(
      `AcpTransport: refusing harnessKind "${harnessKind}" under auth_mode "subscription" — ` +
        `the ACP transport has no subscription posture for any harness (mt#2237/mt#2750 seam, ` +
        `ADR-047). Only auth_mode "api-key" is permitted here; the genuine-binary ` +
        `"claude-stream-json" transport is the sole subscription-auth driver.`
    );
    this.name = "AcpSubscriptionAuthRefusedError";
  }
}

export class MissingAcpCredentialError extends Error {
  constructor(context: string, provider: "openai" | "anthropic", configKey: string) {
    super(
      `${context}: auth_mode "api-key" requires ${configKey} to be configured — ` +
        `no ${provider} credential found`
    );
    this.name = "MissingAcpCredentialError";
  }
}

// ---------------------------------------------------------------------------
// Per-process connection state
// ---------------------------------------------------------------------------

interface DeferredSessionId {
  readonly promise: Promise<string>;
  resolve(id: string): void;
  reject(err: unknown): void;
}

function deferSessionId(): DeferredSessionId {
  let resolve!: (id: string) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The mutable dispatch cell {@link AcpTransport.buildConnection} installs
 * and {@link AcpTransport.bindEventHandlers} rebinds — see that method's
 * doc comment for why a cell, not a closure swap. */
interface HandlerCell {
  requestPermission: Client["requestPermission"];
  sessionUpdate: Client["sessionUpdate"];
}

interface AcpProcState {
  readonly connection: ClientSideConnection;
  readonly harnessKind: string;
  readonly cwd: string;
  readonly taskId: string | null;
  /** `null` on a fresh spawn until `session/new` resolves; pre-populated on
   * a resume. */
  sessionId: string | null;
  readonly sessionIdDeferred: DeferredSessionId;
  /** `true` for `spawnResume` — tells the init routine to call
   * `resumeSession` instead of `newSession`. */
  readonly isResume: boolean;
  turnIndex: number;
  attached: boolean;
  /** Set once by `stop()` (mt#4936 PR #3596 R1) — makes `stop()` idempotent
   * (a second call is a no-op) and refuses any `sendUserTurn` after close
   * rather than sending `session/prompt` on a session the agent has already
   * been told to release. */
  closed: boolean;
}

// ---------------------------------------------------------------------------
// Production defaults for the two seams a real spawn needs beyond SpawnFn
// ---------------------------------------------------------------------------

const prodSpawnFn: SpawnFn = (command, args, opts) =>
  // eslint-disable-next-line custom/no-excessive-as-unknown -- ChildProcess -> ProcessLike structural narrowing, no alternative typing (mirrors claude-transport.ts's identical precedent)
  nodeSpawn(command, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  }) as unknown as ProcessLike;

export interface AcpTransportOptions {
  /** Override the spawn function (test seam — REQUIRED for tests, mirrors
   * ClaudeStreamJsonTransport's identical constraint: spawning the real
   * command would run a real network-fetching `npx` invocation). */
  spawnFn?: SpawnFn;
  /** Override the per-harness agent command table (test seam — points at a
   * fake script instead of `npx -y @agentclientprotocol/...`). */
  agentCommands?: Readonly<Record<string, AcpAgentCommand>>;
  /** Override how the configured OpenAI key is read (test seam). */
  getOpenAiApiKey?: () => string | null;
  /** Override how the configured Anthropic key is read (test seam). */
  getAnthropicApiKey?: () => string | null;
  /**
   * Construct the `AskRepository` a permission request creates its ask
   * through. Lazy (called once per permission request, not per transport
   * instance) so DB-handle resolution is deferred until genuinely needed.
   * Defaults to {@link defaultCreateAskRepository} (a real, DB-backed
   * repository) — test seam: `acp-transport.test.ts` always injects a fake
   * here rather than exercising the default. A `null` return (store
   * unreachable) refuses the permission request with `{ outcome: "cancelled"
   * }` and a logged error — fail closed, never silently approve.
   */
  createAskRepository?: () => Promise<AskRepository | null>;
  /** Stable per-process identity for the `requestor` field on a created ask
   * (ADR-006 AgentId format). Defaults to a fixed cockpit-daemon identity. */
  requestorAgentId?: string;
}

const DEFAULT_REQUESTOR_AGENT_ID = "minsky.cockpit:proc:acp-transport";

/**
 * Lazy, cached SQL handle for the production `createAskRepository` default —
 * module-scoped (not per-instance) so every `AcpTransport` the daemon
 * constructs shares one connection-resolution cache, matching
 * `conversation-presence.ts`'s `getPresenceDb` pattern exactly.
 * `cacheNegative: false`: a failed probe is retried on the next permission
 * request rather than latched, since a permission request is rare enough
 * that "wait for the DB to come back" beats "permanently refuse every ask
 * for this daemon's lifetime because it happened to poll during an outage."
 *
 * SAFETY: `createCachedSqlDbGetter` with no `getProvider` override is the
 * PRODUCTION resolution path, which THROWS `TestEnvironmentDbAccessError`
 * under `NODE_ENV=test` with no explicit opt-in (`db-providers.ts`) — so a
 * test that accidentally exercises this default (rather than injecting its
 * own `createAskRepository`, as `acp-transport.test.ts` always does) fails
 * loudly instead of silently reaching a real Postgres connection.
 */
const getAcpAskDb = createCachedSqlDbGetter({ cacheNegative: false });

async function defaultCreateAskRepository(): Promise<AskRepository | null> {
  const db = await getAcpAskDb();
  return db ? new DrizzleAskRepository(db) : null;
}

export class AcpTransport implements DriverTransport {
  readonly id = TRANSPORT_ID_ACP;
  private readonly spawnFn: SpawnFn;
  private readonly agentCommands: Readonly<Record<string, AcpAgentCommand>>;
  private readonly getOpenAiApiKey: () => string | null;
  private readonly getAnthropicApiKey: () => string | null;
  private readonly createAskRepository: () => Promise<AskRepository | null>;
  private readonly requestorAgentId: string;
  private readonly procState = new WeakMap<ProcessLike, AcpProcState>();

  constructor(opts: AcpTransportOptions = {}) {
    this.spawnFn = opts.spawnFn ?? prodSpawnFn;
    this.agentCommands = opts.agentCommands ?? DEFAULT_ACP_AGENT_COMMANDS;
    this.getOpenAiApiKey = opts.getOpenAiApiKey ?? readConfiguredOpenAiApiKey;
    this.getAnthropicApiKey = opts.getAnthropicApiKey ?? readConfiguredAnthropicApiKey;
    this.createAskRepository = opts.createAskRepository ?? defaultCreateAskRepository;
    this.requestorAgentId = opts.requestorAgentId ?? DEFAULT_REQUESTOR_AGENT_ID;
  }

  // -------------------------------------------------------------------------
  // spawn / spawnResume
  // -------------------------------------------------------------------------

  private resolveAgentCommand(harnessKindRaw: string | undefined): AcpAgentCommand {
    const harnessKind = harnessKindRaw ?? HARNESS_KIND_CODEX;
    const entry = this.agentCommands[harnessKind];
    if (!entry) throw new UnknownAcpHarnessError(harnessKind);
    return entry;
  }

  private resolveEnvForCredential(
    credential: "openai" | "anthropic",
    baseEnv: NodeJS.ProcessEnv | undefined,
    context: string
  ): NodeJS.ProcessEnv {
    if (credential === "openai") {
      const key = this.getOpenAiApiKey();
      if (!key) {
        throw new MissingAcpCredentialError(context, "openai", "ai.providers.openai.apiKey");
      }
      // Both names: codex-acp's README documents CODEX_API_KEY / OPENAI_API_KEY
      // as equivalent api-key selectors (mt#4936 Third-party dependency
      // verification) — set both so either build reads it.
      return { ...(baseEnv ?? process.env), OPENAI_API_KEY: key, CODEX_API_KEY: key };
    }
    const key = this.getAnthropicApiKey();
    if (!key) {
      throw new MissingAcpCredentialError(context, "anthropic", "ai.providers.anthropic.apiKey");
    }
    return { ...(baseEnv ?? process.env), ANTHROPIC_API_KEY: key };
  }

  spawn(opts: DriverTransportStartOptions): DriverTransportSpawnResult {
    return this.doSpawn(opts, { isResume: false, sessionId: null, taskId: opts.taskId ?? null });
  }

  spawnResume(opts: DriverTransportResumeOptions): DriverTransportSpawnResult {
    return this.doSpawn(opts, {
      isResume: true,
      sessionId: opts.harnessSessionId,
      taskId: opts.taskId ?? null,
    });
  }

  private doSpawn(
    opts: DriverTransportStartOptions,
    resume: { isResume: boolean; sessionId: string | null; taskId: string | null }
  ): DriverTransportSpawnResult {
    const harnessKind = opts.harnessKind ?? HARNESS_KIND_CODEX;

    // The seam (mt#2237/mt#2750, ADR-047): refused BEFORE any spawn attempt,
    // same "refuse before announcing anything" discipline as
    // ClaudeStreamJsonTransport's api-key resolution.
    if (opts.authMode !== "api-key") {
      throw new AcpSubscriptionAuthRefusedError(harnessKind);
    }

    if (probeSpawnCwd(opts.cwd) === "missing") {
      const reason = missingCwdReason(opts.cwd);
      log.error(`[acp-transport] not spawning ${harnessKind} — ${reason}`);
      return { ok: false, reason };
    }

    let agentCommand: AcpAgentCommand;
    try {
      agentCommand = this.resolveAgentCommand(harnessKind);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.error(`[acp-transport] ${reason}`);
      return { ok: false, reason };
    }

    // Resolve (and, on a missing credential, THROW) before spawning anything
    // — mirrors ClaudeStreamJsonTransport's identical ordering and rationale
    // (a credential-posture failure must not be preceded by a spawn attempt).
    const context = resume.isResume ? `resume ${resume.sessionId}` : "start";
    const env = this.resolveEnvForCredential(agentCommand.credential, opts.env, context);

    log.info(
      `[acp-transport] spawning ${agentCommand.command} ${agentCommand.args.join(" ")} ` +
        `(harnessKind=${harnessKind}, cwd=${opts.cwd}, resume=${resume.isResume})`
    );

    const proc = this.spawnFn(agentCommand.command, [...agentCommand.args], {
      cwd: opts.cwd,
      env,
    });

    const sessionIdDeferred = deferSessionId();
    if (resume.isResume && resume.sessionId) {
      sessionIdDeferred.resolve(resume.sessionId);
    }

    this.procState.set(proc, {
      connection: this.buildConnection(proc),
      harnessKind,
      cwd: opts.cwd,
      taskId: resume.taskId,
      sessionId: resume.isResume ? resume.sessionId : null,
      sessionIdDeferred,
      isResume: resume.isResume,
      turnIndex: 0,
      attached: false,
      closed: false,
    });

    return { ok: true, proc, argv: [agentCommand.command, ...agentCommand.args] };
  }

  /**
   * Build the `ClientSideConnection`. The `Client` implementation handed to
   * it indirects through a mutable "handler cell" stored in
   * {@link handlerCells} rather than closing over fixed functions: the SDK
   * resolves `toClient(agent)` exactly ONCE, at construction, and dispatches
   * to the returned object's methods by reference thereafter — so a cell
   * whose OWN methods are reassigned in place (by `attach()`, once the real
   * `onEvent` + ask machinery exist) is what lets `attach()` rebind behavior
   * on a connection that already exists. Replacing the `client` object
   * itself would not work; the connection only ever calls the ORIGINAL
   * object's methods.
   */
  private buildConnection(proc: ProcessLike): ClientSideConnection {
    const stream = ndJsonStream(
      // eslint-disable-next-line custom/no-excessive-as-unknown -- NodeJS.WritableStream/ReadableStream -> real stream.Writable/Readable for Writable.toWeb/Readable.toWeb; both a real ChildProcess pipe and a test PassThrough double satisfy this at runtime (mirrors claude-transport.ts's ProcessLike casts)
      Writable.toWeb(proc.stdin as unknown as Writable) as WritableStream<Uint8Array>,
      // eslint-disable-next-line custom/no-excessive-as-unknown -- see above
      Readable.toWeb(proc.stdout as unknown as Readable) as ReadableStream<Uint8Array>
    );
    const cell: HandlerCell = {
      requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      sessionUpdate: async () => {
        /* rebound by attach() */
      },
    };
    this.handlerCells.set(proc, cell);
    const client: Client = {
      requestPermission: (params) => cell.requestPermission(params),
      sessionUpdate: (params) => cell.sessionUpdate(params),
    };
    return new ClientSideConnection(() => client, stream);
  }

  // -------------------------------------------------------------------------
  // attach — wire the connection: run initialize + new/resume session, pump
  // session/update notifications into onEvent, handle permission requests.
  // -------------------------------------------------------------------------

  attach(proc: ProcessLike, _cwd: string, onEvent: (event: DriverTransportEvent) => void): void {
    const state = this.procState.get(proc);
    if (!state) {
      log.error("[acp-transport] attach() called on an unknown process — dropping");
      return;
    }
    state.attached = true;

    // `sendUserTurn`'s eventual `turnResult` (once its fire-and-forget
    // `prompt()` promise resolves, well after this call returns) reaches
    // `onEvent` through this sink rather than a captured closure — see
    // `emitFromProc`'s doc comment.
    this.eventSinks.set(proc, onEvent);

    // Rebind the connection's Client handlers (installed as placeholders by
    // `buildConnection`, during `spawn`/`spawnResume`) to the real
    // onEvent-backed implementations — see `bindEventHandlers`'s doc
    // comment for why this is a cell mutation, not a client replacement.
    this.bindEventHandlers(state, proc, onEvent);

    proc.on("error", (err: Error) => {
      const isEnoent = (err as NodeJS.ErrnoException).code === "ENOENT";
      const crashError = isEnoent
        ? `Failed to start ACP agent (${state.harnessKind}): not found — is it on PATH? (${err.message})`
        : `Failed to start ACP agent (${state.harnessKind}): ${err.message}`;
      onEvent({ kind: "processError", crashError });
      state.sessionIdDeferred.reject(err);
    });

    proc.on("exit", (code, signal) => {
      const crashErrorBase = `ACP agent (${state.harnessKind}) exited with code=${
        code ?? "null"
      } signal=${signal ?? "null"}`;
      onEvent({ kind: "processExited", code, signal, crashErrorBase });
      state.sessionIdDeferred.reject(new Error(crashErrorBase));
    });

    void this.runInitAndSession(state, onEvent);
  }

  /** Populated by {@link buildConnection} (during `spawn`/`spawnResume`,
   * always before `attach`); rebound in place by {@link bindEventHandlers}. */
  private handlerCells = new WeakMap<ProcessLike, HandlerCell>();

  private bindEventHandlers(
    state: AcpProcState,
    proc: ProcessLike,
    onEvent: (event: DriverTransportEvent) => void
  ): void {
    const cell = this.handlerCells.get(proc);
    if (!cell) {
      // Would mean attach() ran without a prior spawn()/spawnResume() for
      // this proc — not reachable via the supervisor's own call ordering
      // (spawn/spawnResume always installs the cell before attach can run),
      // but failing loudly here is cheap insurance against a future
      // refactor silently reordering the two, which would otherwise present
      // as "permission requests go nowhere" with no error anywhere.
      log.error(
        `[acp-transport] attach() found no handler cell for ${state.harnessKind} — ` +
          "spawn()/spawnResume() must run first; permission requests will be refused"
      );
      return;
    }
    cell.requestPermission = (params) => this.handlePermissionRequest(state, params, onEvent);
    cell.sessionUpdate = async (params) => {
      onEvent(classifySessionUpdate(params));
    };
  }

  private async handlePermissionRequest(
    state: AcpProcState,
    params: RequestPermissionRequest,
    onEvent: (event: DriverTransportEvent) => void
  ): Promise<RequestPermissionResponse> {
    const options: AcpPermissionOptionInput[] = params.options.map((o) => ({
      optionId: o.optionId,
      name: o.name,
      kind: o.kind,
    }));
    const toolTitle = params.toolCall.title ?? params.toolCall.toolCallId;

    // SC1 — the first producer to classify into `permissionRequested`.
    // Emitted BEFORE ask creation/polling so an observer sees the request
    // arrive even if ask creation itself fails or is refused below (the
    // WS/persistence pipeline forwards `raw` regardless of what happens
    // next, mirroring every other event kind's "always append" contract —
    // see `handleTransportEvent`'s doc comment in ../driven-session-host.ts).
    onEvent({
      kind: "permissionRequested",
      raw: {
        type: "minsky_acp_permission_requested",
        toolCallId: params.toolCall.toolCallId,
        toolTitle,
        options,
      },
    });

    let repo: AskRepository | null;
    try {
      repo = await this.createAskRepository();
    } catch (err) {
      log.error("[acp-transport] failed to resolve ask repository", {
        error: getLoggableErrorSummary(err),
      });
      return { outcome: { outcome: "cancelled" } };
    }
    if (!repo) {
      log.error("[acp-transport] ask store unavailable — refusing permission request closed");
      return { outcome: { outcome: "cancelled" } };
    }

    const draft = buildAcpPermissionRequestAsk({
      harnessKind: state.harnessKind,
      toolCallId: params.toolCall.toolCallId,
      toolTitle,
      options,
      ...(state.taskId ? { parentTaskId: state.taskId } : {}),
    });

    const ask = await repo.create({
      kind: draft.kind,
      classifierVersion: "v1",
      requestor: this.requestorAgentId,
      title: draft.title,
      question: draft.question,
      options: draft.options,
      metadata: draft.metadata,
      ...(draft.parentTaskId ? { parentTaskId: draft.parentTaskId } : {}),
    });

    log.info(
      `[acp-transport] permission ask created for "${toolTitle}" — askId=${ask.id} ` +
        `harnessKind=${state.harnessKind}`
    );

    const resolved = await this.pollAskUntilResolved(repo, ask.id);
    if (resolved.status === "selected") {
      return { outcome: { outcome: "selected", optionId: resolved.optionId } };
    }
    return { outcome: { outcome: "cancelled" } };
  }

  /** Poll cadence for a suspended ask — deliberately short: a permission
   * request blocks the agent's whole turn, so the operator-visible latency
   * this adds on top of their own response time should be small. */
  private static readonly ASK_POLL_INTERVAL_MS = 2000;
  private static readonly ASK_POLL_TIMEOUT_MS = 30 * 60 * 1000;

  private async pollAskUntilResolved(
    repo: AskRepository,
    askId: string
  ): Promise<ReturnType<typeof classifyAcpPermissionResponse>> {
    const deadline = Date.now() + AcpTransport.ASK_POLL_TIMEOUT_MS;
    for (;;) {
      const ask = await repo.getById(askId);
      if (!ask) {
        log.error(`[acp-transport] permission ask ${askId} vanished while polling`);
        return { status: "cancelled" };
      }
      const classified = classifyAcpPermissionResponse(ask);
      if (classified.status !== "pending") return classified;
      if (Date.now() > deadline) {
        log.warn(`[acp-transport] permission ask ${askId} timed out after 30 minutes`);
        return { status: "cancelled" };
      }
      await new Promise((r) => setTimeout(r, AcpTransport.ASK_POLL_INTERVAL_MS));
    }
  }

  private async runInitAndSession(
    state: AcpProcState,
    onEvent: (event: DriverTransportEvent) => void
  ): Promise<void> {
    try {
      await state.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      });

      if (state.isResume && state.sessionId) {
        await state.connection.resumeSession({
          sessionId: state.sessionId,
          cwd: state.cwd,
          mcpServers: [],
        });
      } else {
        const result = await state.connection.newSession({ cwd: state.cwd, mcpServers: [] });
        state.sessionId = result.sessionId;
        state.sessionIdDeferred.resolve(result.sessionId);
        onEvent({
          kind: "harnessSessionDiscovered",
          harnessSessionId: result.sessionId,
          raw: { type: "minsky_acp_session_new", sessionId: result.sessionId },
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[acp-transport] initialize/session setup failed: ${message}`);
      onEvent({ kind: "processError", crashError: `ACP session setup failed: ${message}` });
      state.sessionIdDeferred.reject(err);
    }
  }

  // -------------------------------------------------------------------------
  // sendUserTurn / stop / isAlive
  // -------------------------------------------------------------------------

  sendUserTurn(proc: ProcessLike, text: string, images: readonly DrivenInputImage[] = []): boolean {
    const state = this.procState.get(proc);
    if (!state) return false;
    // mt#4936 PR #3596 R1 — never send session/prompt on a session already
    // told to close; the agent may have freed its resources.
    if (state.closed) return false;

    const prompt: ContentBlock[] = [];
    if (text.length > 0) prompt.push({ type: "text", text });
    for (const image of images) {
      prompt.push({ type: "image", data: image.base64, mimeType: image.mediaType });
    }
    if (prompt.length === 0) return false;

    // Fire-and-forget: `prompt()` resolves only once the WHOLE turn
    // completes (per the SDK's own doc comment on `ClientSideConnection
    // .prompt`), so awaiting it here would block `sendUserTurn`'s
    // synchronous contract for the entire turn. The eventual resolution is
    // reported as a `turnResult` event instead — see below. This is a
    // deliberate, documented divergence from `ClaudeStreamJsonTransport
    // .sendUserTurn`, whose synchronous `proc.stdin.write` has no such
    // multi-second round trip to hide.
    void state.sessionIdDeferred.promise
      .then((sessionId) =>
        state.connection.prompt({ sessionId, prompt }).then((response) => {
          const turnIndex = state.turnIndex;
          state.turnIndex += 1;
          const summary: DrivenSessionCostSummary = {
            turnIndex,
            subtype: response.stopReason,
            isError: response.stopReason === "refusal",
            totalCostUsd: null,
            durationMs: null,
            durationApiMs: null,
            numTurns: null,
            usage: null,
            modelUsage: null,
            observedAt: new Date().toISOString(),
          };
          this.emitFromProc(proc, {
            kind: "turnResult",
            summary,
            raw: { type: "minsky_acp_prompt_result", stopReason: response.stopReason },
          });
        })
      )
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`[acp-transport] prompt failed: ${message}`);
      });
    return true;
  }

  /** `turnResult` (and any other post-attach event) is emitted from inside a
   * promise chain, well after `attach()`'s own `onEvent` closure went out of
   * this method's local scope — so it is captured on the state cell instead
   * (mirrors storing `onEvent` on `attach()`'s closure by keeping a
   * reference on `AcpProcState` rather than threading it through every
   * later call). */
  private eventSinks = new WeakMap<ProcessLike, (event: DriverTransportEvent) => void>();

  private emitFromProc(proc: ProcessLike, event: DriverTransportEvent): void {
    const sink = this.eventSinks.get(proc);
    if (sink) sink(event);
  }

  /**
   * Graceful stop (mt#4936 PR #3596 R1): `session/cancel` for any in-flight
   * turn, THEN `session/close` to release the agent's session resources,
   * THEN end stdin and fall back to SIGTERM after `graceMs` — same shape and
   * deadline as `ClaudeStreamJsonTransport.stop`, with the two ACP-specific
   * RPCs inserted ahead of it. Idempotent: a second call on an already-closed
   * state is a no-op, matching `ClaudeStreamJsonTransport.stop`'s own
   * best-effort posture (a stop on an already-exited record is a documented
   * no-op there too — see that method's doc comment).
   *
   * Both RPCs are best-effort, sequenced, and — this is load-bearing, not
   * cosmetic — `proc.stdin.end()` runs only AFTER the chain SETTLES
   * (`.finally`), never concurrently with it. `stdin.end()` closes the
   * WHATWG `WritableStream` the connection's `Stream` wraps
   * (`Writable.toWeb(proc.stdin)`); ending it while `cancel`'s notification
   * write or `closeSession`'s request write is still in flight races the
   * teardown against the write and can silently drop or corrupt it. Neither
   * RPC's OUTCOME gates teardown — an agent that doesn't advertise the
   * `session.close` capability, or a pipe that's already gone, must not
   * block termination — only their SETTLING (success or failure) does,
   * which is bounded by the RPCs' own timeout, not by this method.
   */
  stop(proc: ProcessLike, opts: { graceMs?: number } = {}): void {
    const state = this.procState.get(proc);
    if (!state || state.closed) return;
    state.closed = true;

    const teardown = (): void => {
      try {
        proc.stdin.end();
      } catch {
        // Best-effort.
      }
      const graceMs = opts.graceMs ?? 3000;
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {
          // Best-effort.
        }
      }, graceMs);
      // eslint-disable-next-line custom/no-excessive-as-unknown -- Timeout#unref side-channel, no alternative typing (mirrors claude-transport.ts's identical cast)
      (timer as unknown as { unref?: () => void }).unref?.();
    };

    if (!state.sessionId) {
      teardown();
      return;
    }
    const sessionId = state.sessionId;
    state.connection
      .cancel({ sessionId })
      .catch(() => {
        // Best-effort — mirrors ClaudeStreamJsonTransport.stop's try/catch
        // posture around a pipe/process that may already be gone.
      })
      .then(() => state.connection.closeSession({ sessionId }).catch(() => {}))
      .finally(teardown);
  }

  isAlive(proc: ProcessLike): boolean {
    return proc.pid !== undefined;
  }
}

// ---------------------------------------------------------------------------
// session/update classification (SC1)
// ---------------------------------------------------------------------------

function classifySessionUpdate(params: SessionNotification): DriverTransportEvent {
  const update = params.update;
  const raw = update as Record<string, unknown>;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      return { kind: "assistantDelta", raw };
    case "tool_call":
      return { kind: "toolUseStarted", raw };
    case "tool_call_update":
      // Imprecise (progress vs. completion) — see module docblock.
      return { kind: "toolUseFinished", raw };
    default:
      return { kind: "raw", raw };
  }
}
