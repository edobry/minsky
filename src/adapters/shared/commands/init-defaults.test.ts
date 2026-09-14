/**
 * `init`'s derivation plan (mt#5149, re-based on a resolved client in mt#5153).
 *
 * The prompts themselves are `@clack` calls behind `isInteractive()`, which no
 * test can drive; the DECISION is a value, and this file asserts it. Each case
 * names the runtime situation it stands for. The client itself is settled
 * before this runs (`client-resolution.test.ts` covers ask-or-refuse), so every
 * case here starts from a known client and says how it was known.
 */

import { describe, it, expect } from "bun:test";

import { planInitDefaults, ruleFormatForClient } from "./init-defaults";

const NO_FLAGS = {};

describe("mt#5149 — under a detected harness, init derives rather than asks", () => {
  it("Claude Code (env signal): minsky format, stdio MCP, no prompt", () => {
    const plan = planInitDefaults({ client: "claude-code", source: "env", params: NO_FLAGS });

    expect(plan.client).toBe("claude-code");
    expect(plan.ruleFormat).toBe("minsky");
    // `undefined` is the non-interactive path's long-standing value: enabled,
    // registered over stdio by `performSetup`.
    expect(plan.mcp).toBeUndefined();
    expect(plan.summary).toContain("Detected Claude Code");
    expect(plan.summary).toContain("CLAUDE.md");
    expect(plan.summary).toContain("stdio");
    expect(plan.summary).toContain("--rule-format");
  });

  it("Cursor (env signal): cursor format, no prompt", () => {
    const plan = planInitDefaults({ client: "cursor", source: "env", params: NO_FLAGS });

    expect(plan.ruleFormat).toBe("cursor");
    expect(plan.summary).toContain("Detected Cursor");
    expect(plan.summary).toContain(".cursor/rules");
  });

  it("the one installed client: derived, and the summary says the machine answered", () => {
    const plan = planInitDefaults({ client: "vscode", source: "installed", params: NO_FLAGS });

    expect(plan.client).toBe("vscode");
    expect(plan.ruleFormat).toBe("cursor");
    expect(plan.summary).toContain("Using VS Code (the only MCP client installed on this machine)");
  });
});

describe("mt#5153 — the summary names how the harness was chosen", () => {
  it("an MCP caller's identity reads as detected, and says which witness", () => {
    const plan = planInitDefaults({
      client: "claude-code",
      source: "mcp-client",
      params: NO_FLAGS,
    });

    expect(plan.summary).toContain(
      "Detected Claude Code (from the MCP client that made this call)"
    );
  });

  it("--client reads as an explicit choice, not a detection", () => {
    const plan = planInitDefaults({ client: "codex", source: "flag", params: NO_FLAGS });

    expect(plan.summary).toContain("Using Codex (from --client)");
    expect(plan.summary).not.toContain("Detected");
  });

  it("the rule-format prompt is gone: the client is always known here, so the format derives", () => {
    // What used to be "interactive, no env signal, nothing installed: ask" —
    // that state no longer reaches the plan; `resolveClientForCommand` asked
    // for the CLIENT (or refused), and the format follows from the answer.
    expect(ruleFormatForClient("claude-code")).toBe("minsky");
    expect(ruleFormatForClient("cursor")).toBe("cursor");
    expect(ruleFormatForClient("claude-desktop")).toBe("cursor");
  });

  it("--client joins the override hint, and the hint is dropped only when every value was given", () => {
    const derived = planInitDefaults({ client: "claude-code", source: "env", params: NO_FLAGS });
    expect(derived.summary).toContain(
      "Override with --client, --rule-format, --mcp, --mcp-transport."
    );

    const allGiven = planInitDefaults({
      client: "claude-code",
      source: "flag",
      params: { ruleFormat: "minsky", mcp: true },
    });
    expect(allGiven.summary).not.toContain("Override with");

    // Flags for format and MCP but a DETECTED client: the client is still a
    // derived value, so the hint stays.
    const clientDerived = planInitDefaults({
      client: "claude-code",
      source: "env",
      params: { ruleFormat: "minsky", mcp: true },
    });
    expect(clientDerived.summary).toContain("Override with --client");
  });
});

describe("mt#5149 — explicit flags win over derivation on every path", () => {
  it("--rule-format cursor under Claude Code", () => {
    const plan = planInitDefaults({
      client: "claude-code",
      source: "env",
      params: { ruleFormat: "cursor" },
    });

    expect(plan.ruleFormat).toBe("cursor");
    expect(plan.summary).toContain(".cursor/rules (--rule-format)");
  });

  it("--rule-format generic with an explicit client", () => {
    const plan = planInitDefaults({
      client: "cursor",
      source: "flag",
      params: { ruleFormat: "generic" },
    });

    expect(plan.ruleFormat).toBe("generic");
  });

  it("--mcp false skips registration and says so", () => {
    const plan = planInitDefaults({
      client: "claude-code",
      source: "env",
      params: { mcp: "false" },
    });

    expect(plan.mcp).toEqual({
      enabled: false,
      transport: "stdio",
      port: undefined,
      host: undefined,
    });
    expect(plan.summary).toContain("MCP registration skipped (--mcp false)");
  });

  it("--mcp-transport sse --mcp-port 4000 --mcp-host localhost is carried through", () => {
    const plan = planInitDefaults({
      client: "claude-code",
      source: "env",
      params: { mcpTransport: "sse", mcpPort: "4000", mcpHost: "localhost" },
    });

    expect(plan.mcp).toEqual({ enabled: true, transport: "sse", port: 4000, host: "localhost" });
    expect(plan.summary).toContain(
      "MCP registers over sse on localhost:4000 (--mcp-transport, --mcp-port, --mcp-host)"
    );
  });

  it("names the flags actually given, and shows no host/port for stdio (PR #3756 R1)", () => {
    // `--mcp-port 4000` alone: the transport stays stdio, which has no port to
    // report, and the attribution must not name a flag the user never passed.
    const plan = planInitDefaults({
      client: "claude-code",
      source: "env",
      params: { mcpPort: "4000" },
    });

    expect(plan.mcp).toEqual({ enabled: true, transport: "stdio", port: 4000, host: undefined });
    expect(plan.summary).toContain("MCP registers over stdio (--mcp-port)");
    expect(plan.summary).not.toContain("on 4000");
    expect(plan.summary).not.toContain("--mcp-transport)");

    const explicitOn = planInitDefaults({
      client: "claude-code",
      source: "env",
      params: { mcp: true },
    });
    expect(explicitOn.summary).toContain("MCP registers over stdio (--mcp)");
  });

  it("an empty string on a string flag reads as not given, as it always has", () => {
    const plan = planInitDefaults({
      client: "claude-code",
      source: "env",
      params: { mcpTransport: "", mcpPort: "", mcpHost: "" },
    });

    expect(plan.mcp).toBeUndefined();
  });
});
