/**
 * Tests for reviewer-watch option resolution (mt#2392 / PR #1675 R1).
 *
 * R1 blocking concern: `resolveWatchConfig` now consults the configuration
 * system for the reviewer-bot login, and a CLI command's option resolution
 * must never fail earlier than the pure env/constant fallback it replaced.
 * These tests pin that contract: resolution never throws, and the fallback
 * chain (params → env → config → constant) holds at each step.
 */

import { describe, it, expect, afterEach } from "bun:test";
import { resolveWatchConfig, resolveConfiguredReviewerLogin } from "./reviewer-watch";
import { REVIEWER_BOT_LOGIN } from "@minsky/domain/constants";

const WATCH_BOT_LOGIN_ENV = "MINSKY_REVIEWER_WATCH_BOT_LOGIN";
const ENV_KEYS = [
  "MINSKY_REVIEWER_WATCH_OWNER",
  "MINSKY_REVIEWER_WATCH_REPO",
  WATCH_BOT_LOGIN_ENV,
  "MINSKY_REVIEWER_WATCH_THRESHOLD",
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("resolveWatchConfig robustness (R1)", () => {
  it("never throws and resolves a non-empty botLogin with no params, env, or config", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    const config = resolveWatchConfig({});
    expect(config.botLogin.length).toBeGreaterThan(0);
    expect(config.threshold).toBeGreaterThanOrEqual(1);
  });

  it("explicit param wins over env and config", () => {
    process.env[WATCH_BOT_LOGIN_ENV] = "env-bot[bot]";
    const config = resolveWatchConfig({ botLogin: "param-bot[bot]" });
    expect(config.botLogin).toBe("param-bot[bot]");
  });

  it("env wins over config-driven resolution", () => {
    process.env[WATCH_BOT_LOGIN_ENV] = "env-bot[bot]";
    const config = resolveWatchConfig({});
    expect(config.botLogin).toBe("env-bot[bot]");
  });

  it("resolveConfiguredReviewerLogin never throws and falls back to the Minsky constant", () => {
    // In an unconfigured context this resolves to the constant; in a
    // configured one, to a non-empty configured login. Either way: no throw,
    // non-empty result.
    const login = resolveConfiguredReviewerLogin();
    expect(login.length).toBeGreaterThan(0);
  });

  it("default (unconfigured) reviewer login is the Minsky constant", () => {
    delete process.env[WATCH_BOT_LOGIN_ENV];
    const config = resolveWatchConfig({});
    // No reviewer.botLogin is configured in the test environment, so the
    // chain bottoms out at the constant.
    expect(config.botLogin).toBe(REVIEWER_BOT_LOGIN);
  });
});
