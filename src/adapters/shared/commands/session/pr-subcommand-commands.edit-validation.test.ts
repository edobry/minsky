import { describe, it, expect } from "bun:test";
import { SessionPrEditCommand } from "./pr-subcommand-commands";
import type { CommandExecutionContext } from "../../../schemas/command-registry";

/** Unit tests focused on title/type handling for edit */
describe("SessionPrEditCommand - title/type validation", () => {
  const context: CommandExecutionContext = { interface: "cli", workingDirectory: "/tmp" } as any;

  it("throws when --title is description-only without --type", async () => {
    const cmd = new SessionPrEditCommand();
    await expect(async () => {
      await cmd.executeCommand({ title: "add something", name: "s" }, context);
    }).rejects.toThrow(/Invalid title|conventional commit/i);
  });

  it("accepts description-only title when --type provided (composed)", async () => {
    const cmd = new SessionPrEditCommand();
    const res = await cmd
      .executeCommand({ type: "fix", title: "adjust x", name: "s", body: "b" }, context)
      .catch((e) => e);
    const msg = String(res?.message || res);
    expect(/(No PR|Session|Failed to edit session PR)/i.test(msg)).toBe(true);
  });

  it("accepts full conventional commit title without --type", async () => {
    const cmd = new SessionPrEditCommand();
    const res = await cmd
      .executeCommand({ title: "fix(ui): tweak", name: "s", body: "b" }, context)
      .catch((e) => e);
    const msg = String(res?.message || res);
    expect(/(No PR|Session|Failed to edit session PR)/i.test(msg)).toBe(true);
  });
});
