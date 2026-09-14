/**
 * `init` / `setup`'s shared "resolve, ask, or refuse" step (mt#5153).
 *
 * `decideClient` is pure and pinned directly; `resolveClientForCommand` is
 * driven through its injected resolver and prompt, so no `@clack` prompt runs
 * and no real detector is consulted (`testing-standards.mdc §Testable Design`).
 */

import { describe, expect, test } from "bun:test";
import { ValidationError } from "@minsky/domain/errors/index";
import {
  MANAGED_CLIENTS,
  type InitClientResolution,
} from "@minsky/domain/runtime/harness-detection";
import {
  CLIENT_PARAM,
  CLIENT_PROMPT_CANCELLED,
  decideClient,
  resolveClientForCommand,
} from "./client-resolution";

describe("decideClient (pure policy)", () => {
  test("a resolved client passes straight through with its source", () => {
    expect(
      decideClient({ kind: "resolved", client: "claude-code", source: "env" }, false, "--client")
    ).toEqual({ kind: "resolved", client: "claude-code", source: "env" });
  });

  test("ambiguous + TTY → prompt among the installed clients", () => {
    expect(
      decideClient({ kind: "ambiguous", installed: ["cursor", "claude-code"] }, true, "--client")
    ).toEqual({ kind: "prompt", options: ["cursor", "claude-code"] });
  });

  test("ambiguous with no TTY → refuse, naming the flag and the accepted values", () => {
    const decision = decideClient(
      { kind: "ambiguous", installed: ["cursor", "claude-code"] },
      false,
      "--client"
    );
    expect(decision.kind).toBe("refuse");
    if (decision.kind !== "refuse") throw new Error("unreachable");
    expect(decision.message).toContain("--client");
    expect(decision.message).toContain("cursor, claude-code");
    for (const client of MANAGED_CLIENTS) expect(decision.message).toContain(client);
  });

  test("none → refuse on a TTY too: a prompt over zero options answers nothing", () => {
    expect(decideClient({ kind: "none" }, true, "--client").kind).toBe("refuse");
  });
});

describe("resolveClientForCommand (shell)", () => {
  const ambiguous = (): InitClientResolution => ({
    kind: "ambiguous",
    installed: ["cursor", "claude-code"],
  });

  test("threads explicit and callerActorId into the resolver, and returns its answer", async () => {
    const seen: unknown[] = [];
    const result = await resolveClientForCommand({
      explicit: "codex",
      callerActorId: "com.anthropic.claude-code:proc:f36a2fd77a664ba3",
      flag: "--client",
      promptMessage: "?",
      interactive: false,
      resolve: (input) => {
        seen.push(input);
        return { kind: "resolved", client: "codex", source: "flag" };
      },
    });
    expect(result).toEqual({ client: "codex", source: "flag" });
    expect(seen).toEqual([
      { explicit: "codex", callerAgentId: "com.anthropic.claude-code:proc:f36a2fd77a664ba3" },
    ]);
  });

  test("a non-ManagedClient explicit value is refused before any resolution", async () => {
    await expect(
      resolveClientForCommand({
        explicit: "claude",
        flag: "--client",
        promptMessage: "?",
        interactive: false,
        resolve: () => {
          throw new Error("must not be reached");
        },
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  test("non-interactive + ambiguous throws the refusal as a ValidationError", async () => {
    await expect(
      resolveClientForCommand({
        flag: "--client",
        promptMessage: "?",
        interactive: false,
        resolve: ambiguous,
      })
    ).rejects.toThrow(/2 MCP clients are installed \(cursor, claude-code\)\. Pass --client/);
  });

  test("interactive + ambiguous prompts, and the operator's pick is recorded as `flag`", async () => {
    const result = await resolveClientForCommand({
      flag: "--client",
      promptMessage: "Which?",
      interactive: true,
      resolve: ambiguous,
      prompt: async (message, options) => {
        expect(message).toBe("Which?");
        expect(options).toEqual(["cursor", "claude-code"]);
        return "claude-code";
      },
    });
    expect(result).toEqual({ client: "claude-code", source: "flag" });
  });

  test("a cancelled prompt is returned as the sentinel, not thrown", async () => {
    const result = await resolveClientForCommand({
      flag: "--client",
      promptMessage: "?",
      interactive: true,
      resolve: ambiguous,
      prompt: async () => CLIENT_PROMPT_CANCELLED,
    });
    expect(result).toBe(CLIENT_PROMPT_CANCELLED);
  });
});

describe("CLIENT_PARAM", () => {
  test("its enum is exactly MANAGED_CLIENTS, so the refusal names what the schema accepts", () => {
    for (const client of MANAGED_CLIENTS) {
      expect(CLIENT_PARAM.schema.safeParse(client).success).toBe(true);
    }
    expect(CLIENT_PARAM.schema.safeParse("claude").success).toBe(false);
    expect(CLIENT_PARAM.schema.safeParse(undefined).success).toBe(true);
  });
});
