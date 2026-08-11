import { describe, test, expect } from "bun:test";
import { DEFAULT_COCKPIT_PORT, COCKPIT_PORT_FLAG_DESCRIPTION } from "./port";

/**
 * `resolveCockpitPort`'s config branch reads the process-wide configuration
 * singleton, so it is exercised through the live daemon in the task's
 * acceptance tests rather than here. What IS unit-testable — and what actually
 * carries the precedence rule — is the explicit-flag branch: it must accept a
 * valid port, and it must REFUSE a malformed one rather than silently falling
 * back to config or the default. An operator who typed a port meant it.
 */
describe("resolveCockpitPort — explicit flag branch", () => {
  // Imported lazily so the module's configuration import is not pulled in for
  // the cases that never reach the config branch.
  async function resolve(flag?: string): Promise<number> {
    const { resolveCockpitPort } = await import("./port");
    return resolveCockpitPort(flag);
  }

  test("an explicit port wins", async () => {
    expect(await resolve("4317")).toBe(4317);
  });

  test("an explicit port equal to the default is still honored as explicit", async () => {
    // The reason the commander defaults were removed: with one in place this
    // case and an unset flag are indistinguishable, so config could never win.
    expect(await resolve(String(DEFAULT_COCKPIT_PORT))).toBe(DEFAULT_COCKPIT_PORT);
  });

  test("boundary ports are accepted", async () => {
    expect(await resolve("1")).toBe(1);
    expect(await resolve("65535")).toBe(65535);
  });

  test("a non-numeric port throws rather than falling back", async () => {
    await expect(resolve("not-a-port")).rejects.toThrow(/Invalid port/);
  });

  test("an out-of-range port throws on both sides", async () => {
    await expect(resolve("0")).rejects.toThrow(/Invalid port/);
    await expect(resolve("65536")).rejects.toThrow(/Invalid port/);
  });
});

describe("shared flag description", () => {
  test("names the config key and the fallback, so all three commands say the same thing", () => {
    expect(COCKPIT_PORT_FLAG_DESCRIPTION).toContain("cockpit.port");
    expect(COCKPIT_PORT_FLAG_DESCRIPTION).toContain(String(DEFAULT_COCKPIT_PORT));
  });
});
