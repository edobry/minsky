/**
 * Which MCP client `init` / `setup` are for — resolved, asked, or refused
 * (mt#5153).
 *
 * The two commands used to answer this question differently: `setup` prompted
 * on a TTY and otherwise failed naming the accepted values, while `init`
 * picked one by ranking the installed clients and said nothing. This module is
 * the one answer, in two layers:
 *
 *   - `decideClient` is PURE: given a resolution and whether a TTY is present,
 *     it says whether to proceed, prompt, or refuse. Assertable without driving
 *     `@clack` (`testing-standards.mdc §Testable Design`).
 *   - `resolveClientForCommand` is the imperative shell that runs the real
 *     detectors, drives the prompt when the decision says to, and throws the
 *     refusal as a `ValidationError`.
 *
 * The signal order lives in `resolveInitClient` (domain); this module adds only
 * the interaction policy: prompt when there is someone to ask, refuse when there
 * is not, never guess.
 */

import { select, isCancel } from "@clack/prompts";
import { z } from "zod";
import { ValidationError } from "@minsky/domain/errors/index";
import {
  MANAGED_CLIENTS,
  describeUnresolvedClient,
  isManagedClient,
  resolveInitClient,
  type HarnessSource,
  type InitClientResolution,
  type ManagedClient,
} from "@minsky/domain/runtime/harness-detection";
import { isInteractive } from "../../../utils/interactive";

export interface ResolvedClient {
  client: ManagedClient;
  source: HarnessSource;
}

export type ClientDecision =
  | { kind: "resolved"; client: ManagedClient; source: HarnessSource }
  /** A TTY is present and more than one client is installed: ask. */
  | { kind: "prompt"; options: ManagedClient[] }
  /** Nobody to ask, or nothing to choose from: refuse, naming the remedy. */
  | { kind: "refuse"; message: string };

/**
 * The interaction policy over a resolution (pure).
 *
 * `ambiguous` + interactive → prompt among the installed clients. Everything
 * else that did not resolve → refuse with `describeUnresolvedClient`'s message:
 * an `ambiguous` result with no TTY (an agent's shell, CI, the MCP path with an
 * unmapped client), or `none` on any path — a prompt over zero options would
 * only re-ask the question the refusal already answers (`--client`).
 */
export function decideClient(
  resolution: InitClientResolution,
  interactive: boolean,
  flag: string,
  /** Which empty signal the refusal names: the MCP caller (with its id) or the CLI env. */
  witness: { kind: "env" } | { kind: "mcp-client"; agentId: string } = { kind: "env" }
): ClientDecision {
  if (resolution.kind === "resolved") {
    return { kind: "resolved", client: resolution.client, source: resolution.source };
  }
  if (resolution.kind === "ambiguous" && interactive) {
    return { kind: "prompt", options: resolution.installed };
  }
  return { kind: "refuse", message: describeUnresolvedClient(resolution, flag, witness) };
}

/**
 * The shared `client` parameter for `init` and `setup` — one enum, sourced from
 * `MANAGED_CLIENTS`, so the accepted values a refusal names are the values the
 * schema accepts.
 */
export const CLIENT_PARAM = {
  schema: z.enum(MANAGED_CLIENTS as [ManagedClient, ...ManagedClient[]]).optional(),
  description:
    `MCP client / agent harness to set this project up for (${MANAGED_CLIENTS.join(", ")}). ` +
    "Outranks detection. Required when nothing else resolves it: no harness signal in the " +
    "environment (or, over MCP, an unrecognised client) and more than one client installed.",
  required: false,
} as const;

/**
 * The server-injected caller identity, hidden from both advertised surfaces.
 * Same shape as `tasks.claims.release`'s parameter (mt#4568): the MCP server
 * overwrites any hand-supplied value, and the CLI path never carries it.
 */
export const CALLER_ACTOR_ID_PARAM = {
  schema: z.string(),
  description:
    "The caller's resolved agentId (ADR-006). Over MCP the harness is derived from this — " +
    "the shared daemon's own environment describes whatever spawned the daemon, not the " +
    "caller. Server-injected from the resolved MCP identity (src/mcp/server.ts); not " +
    "supplied by hand, and any hand-supplied value is overwritten there. Absent on the CLI " +
    "path, which reads its own harness environment instead.",
  required: false,
  cliHidden: true,
  mcpHidden: true,
} as const;

export interface ResolveClientForCommandInput {
  /** The `client` parameter, if given. Validated here for the string-typed `setup` path. */
  explicit?: unknown;
  /** The server-injected `callerActorId`, present on the MCP path only. */
  callerActorId?: unknown;
  /** The flag the refusal names — `--client`. */
  flag: string;
  /** The prompt shown when a TTY is present and the choice is ambiguous. */
  promptMessage: string;
  /** `isInteractive()` unless a test supplies it. */
  interactive?: boolean;
  /** `resolveInitClient` unless a test supplies it. */
  resolve?: (input: {
    explicit?: ManagedClient;
    callerAgentId?: string | null;
  }) => InitClientResolution;
  /** The prompt driver; `@clack`'s `select` unless a test supplies it. */
  prompt?: (message: string, options: ManagedClient[]) => Promise<ManagedClient | symbol>;
}

/** The value returned when the operator cancels the prompt. */
export const CLIENT_PROMPT_CANCELLED = Symbol("client-prompt-cancelled");

/**
 * Resolve the client for `init`/`setup`, asking or refusing per `decideClient`.
 *
 * @throws ValidationError when the explicit value is not a `ManagedClient`, or
 * when nothing resolved and there is no TTY to ask on.
 * @returns The resolved client and its source, or `CLIENT_PROMPT_CANCELLED`.
 */
export async function resolveClientForCommand(
  input: ResolveClientForCommandInput
): Promise<ResolvedClient | typeof CLIENT_PROMPT_CANCELLED> {
  const { explicit, callerActorId, flag, promptMessage } = input;
  if (explicit !== undefined && !isManagedClient(explicit)) {
    throw new ValidationError(
      `Unknown client "${String(explicit)}" for ${flag}. Accepted values: ${MANAGED_CLIENTS.join(", ")}.`
    );
  }
  const resolve = input.resolve ?? resolveInitClient;
  const callerAgentId = typeof callerActorId === "string" ? callerActorId : null;
  const resolution = resolve({ explicit, callerAgentId });
  const decision = decideClient(
    resolution,
    input.interactive ?? isInteractive(),
    flag,
    callerAgentId ? { kind: "mcp-client", agentId: callerAgentId } : { kind: "env" }
  );

  if (decision.kind === "resolved") return { client: decision.client, source: decision.source };
  if (decision.kind === "refuse") throw new ValidationError(decision.message);

  const prompt = input.prompt ?? defaultPrompt;
  const chosen = await prompt(promptMessage, decision.options);
  if (typeof chosen === "symbol") return CLIENT_PROMPT_CANCELLED;
  // An operator's answer at the prompt is an explicit choice — the same trust
  // as `--client`, which is what `flag` records. `installed` is reserved for
  // the case where the machine answered alone (exactly one client found).
  return { client: chosen, source: "flag" };
}

async function defaultPrompt(
  message: string,
  options: ManagedClient[]
): Promise<ManagedClient | symbol> {
  const selected = await select({
    message,
    options: options.map((c) => ({ value: c, label: c })),
    initialValue: options[0],
  });
  if (isCancel(selected)) return CLIENT_PROMPT_CANCELLED;
  return selected as ManagedClient;
}
