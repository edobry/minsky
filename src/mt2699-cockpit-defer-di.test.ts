/**
 * mt#2699 — cockpit preAction DI-skip discriminator.
 *
 * The cockpit is a standalone Express server with no tsyringe container
 * (`createCockpitCommand(_container?)` discards the parameter; cockpit data
 * paths bootstrap their own lazy PersistenceService singleton). The eager
 * preAction `container.initialize()` (~2.6 s network-bound DB connect) was
 * the dominant share of the cockpit daemon's cold-boot latency — the
 * deeplink white-window gap (mt#2688). `isCockpitInvocation` gates the skip;
 * these tests pin its shape the same way mt1751-defer-di.test.ts pins
 * `isMcpStartStdio`.
 */

import { describe, test, expect } from "bun:test";
import { Command } from "commander";

import { isCockpitInvocation } from "./cli-discriminators";

function buildSubcommand(parentName: string, leafName: string): Command {
  const root = new Command("minsky");
  const parent = new Command(parentName);
  const leaf = new Command(leafName);
  parent.addCommand(leaf);
  root.addCommand(parent);
  return leaf;
}

describe("isCockpitInvocation — mt#2699 preAction discriminator", () => {
  test("returns true for `cockpit start`", () => {
    expect(isCockpitInvocation(buildSubcommand("cockpit", "start"))).toBe(true);
  });

  test("returns true for every other cockpit subcommand (family-wide skip)", () => {
    // None of the cockpit family can consume the container — the parameter
    // is discarded at createCockpitCommand.
    for (const leaf of ["stop", "status", "install", "uninstall"]) {
      expect(isCockpitInvocation(buildSubcommand("cockpit", leaf))).toBe(true);
    }
  });

  test("returns true for a bare `cockpit` command node", () => {
    const root = new Command("minsky");
    const cockpit = new Command("cockpit");
    root.addCommand(cockpit);
    expect(isCockpitInvocation(cockpit)).toBe(true);
  });

  test("returns false for `session start` (needs the container)", () => {
    expect(isCockpitInvocation(buildSubcommand("session", "start"))).toBe(false);
  });

  test("returns false for `mcp start` (owned by the mt#1751 discriminator)", () => {
    expect(isCockpitInvocation(buildSubcommand("mcp", "start"))).toBe(false);
  });

  test("returns false for an unrelated top-level command (no parent)", () => {
    expect(isCockpitInvocation(new Command("tasks"))).toBe(false);
  });
});
