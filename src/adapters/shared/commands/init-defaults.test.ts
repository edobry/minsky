/**
 * `init`'s derive-or-ask decision (mt#5149).
 *
 * The prompts themselves are `@clack` calls behind `isInteractive()`, which no
 * test can drive; the DECISION is a value, and this file asserts it. Each case
 * names the runtime situation it stands for.
 */

import { describe, it, expect } from "bun:test";

import { planInitDefaults, ruleFormatForClient } from "./init-defaults";

const NO_FLAGS = {};

describe("mt#5149 — under a detected harness, init derives rather than asks", () => {
  it("Claude Code (env signal): minsky format, stdio MCP, no prompt", () => {
    const plan = planInitDefaults({
      interactive: true,
      harness: "claude-code",
      installedClients: [],
      params: NO_FLAGS,
    });

    expect(plan.client).toBe("claude-code");
    expect(plan.detected).toBe(true);
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
    const plan = planInitDefaults({
      interactive: true,
      harness: "cursor",
      installedClients: [],
      params: NO_FLAGS,
    });

    expect(plan.ruleFormat).toBe("cursor");
    expect(plan.summary).toContain("Detected Cursor");
    expect(plan.summary).toContain(".cursor/rules");
  });

  it("no env signal but an installed client: derived from the standalone fallback, no prompt", () => {
    const plan = planInitDefaults({
      interactive: true,
      harness: "standalone",
      installedClients: ["vscode"],
      params: NO_FLAGS,
    });

    expect(plan.client).toBe("vscode");
    expect(plan.detected).toBe(true);
    expect(plan.ruleFormat).toBe("cursor");
    expect(plan.summary).toContain("using the installed VS Code client");
  });
});

describe("mt#5149 — the one case the rule-format prompt survives in", () => {
  it("interactive, no env signal, nothing installed: ask", () => {
    // `resolveInitClient()` never returns "unknown" — it falls back to cursor —
    // so the resolver alone cannot see this case; the two detectors can.
    const plan = planInitDefaults({
      interactive: true,
      harness: "standalone",
      installedClients: [],
      params: NO_FLAGS,
    });

    expect(plan.detected).toBe(false);
    expect(plan.client).toBe("cursor");
    expect(plan.ruleFormat).toBe("ask");
    // MCP is still derived — its answer does not depend on the harness.
    expect(plan.mcp).toBeUndefined();
    expect(plan.summary).toContain("No agent harness or client detected");
    expect(plan.summary).not.toContain("rules compile");
    expect(plan.summary).toContain("stdio");
  });

  it("non-interactive with nothing detected: no prompt is possible, so the fallback applies", () => {
    const plan = planInitDefaults({
      interactive: false,
      harness: "standalone",
      installedClients: [],
      params: NO_FLAGS,
    });

    expect(plan.ruleFormat).toBe("cursor");
  });

  it("the prompt's pre-selected value is the same derivation the other branch uses", () => {
    expect(ruleFormatForClient("claude-code")).toBe("minsky");
    expect(ruleFormatForClient("cursor")).toBe("cursor");
    expect(ruleFormatForClient("claude-desktop")).toBe("cursor");
  });
});

describe("mt#5149 — explicit flags win over derivation on every path", () => {
  it("--rule-format cursor under Claude Code", () => {
    const plan = planInitDefaults({
      interactive: true,
      harness: "claude-code",
      installedClients: [],
      params: { ruleFormat: "cursor" },
    });

    expect(plan.ruleFormat).toBe("cursor");
    expect(plan.summary).toContain(".cursor/rules (--rule-format)");
  });

  it("--rule-format with nothing detected: the flag answers, so no prompt", () => {
    const plan = planInitDefaults({
      interactive: true,
      harness: "standalone",
      installedClients: [],
      params: { ruleFormat: "generic" },
    });

    expect(plan.ruleFormat).toBe("generic");
  });

  it("--mcp false skips registration and says so", () => {
    const plan = planInitDefaults({
      interactive: true,
      harness: "claude-code",
      installedClients: [],
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
      interactive: true,
      harness: "claude-code",
      installedClients: [],
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
      interactive: true,
      harness: "claude-code",
      installedClients: [],
      params: { mcpPort: "4000" },
    });

    expect(plan.mcp).toEqual({ enabled: true, transport: "stdio", port: 4000, host: undefined });
    expect(plan.summary).toContain("MCP registers over stdio (--mcp-port)");
    expect(plan.summary).not.toContain("on 4000");
    expect(plan.summary).not.toContain("--mcp-transport)");

    const explicitOn = planInitDefaults({
      interactive: true,
      harness: "claude-code",
      installedClients: [],
      params: { mcp: true },
    });
    expect(explicitOn.summary).toContain("MCP registers over stdio (--mcp)");
  });

  it("both flags given: the override hint is dropped, since nothing was derived", () => {
    const plan = planInitDefaults({
      interactive: true,
      harness: "claude-code",
      installedClients: [],
      params: { ruleFormat: "minsky", mcp: true },
    });

    expect(plan.summary).not.toContain("Override with");
  });

  it("an empty string on a string flag reads as not given, as it always has", () => {
    const plan = planInitDefaults({
      interactive: false,
      harness: "claude-code",
      installedClients: [],
      params: { mcpTransport: "", mcpPort: "", mcpHost: "" },
    });

    expect(plan.mcp).toBeUndefined();
  });
});
