import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parsePositiveIntEnv } from "./config";

describe("parsePositiveIntEnv (mt#1086)", () => {
  const ENV_NAME = "TEST_TIMEOUT_MS";
  const original = process.env[ENV_NAME];

  beforeEach(() => {
    delete process.env[ENV_NAME];
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env[ENV_NAME];
    } else {
      process.env[ENV_NAME] = original;
    }
  });

  test("returns the default when the env var is unset", () => {
    expect(parsePositiveIntEnv(ENV_NAME, 30_000)).toBe(30_000);
  });

  test("returns the default when the env var is the empty string", () => {
    process.env[ENV_NAME] = "";
    expect(parsePositiveIntEnv(ENV_NAME, 30_000)).toBe(30_000);
  });

  test("parses a plain positive integer", () => {
    process.env[ENV_NAME] = "5000";
    expect(parsePositiveIntEnv(ENV_NAME, 30_000)).toBe(5_000);
  });

  test("parses a leading-plus positive integer", () => {
    process.env[ENV_NAME] = "+42";
    expect(parsePositiveIntEnv(ENV_NAME, 30_000)).toBe(42);
  });

  test("throws on non-numeric values like 'abc'", () => {
    process.env[ENV_NAME] = "abc";
    expect(() => parsePositiveIntEnv(ENV_NAME, 30_000)).toThrow(/positive integer/);
  });

  test("throws on negative values like '-5'", () => {
    process.env[ENV_NAME] = "-5";
    expect(() => parsePositiveIntEnv(ENV_NAME, 30_000)).toThrow(/positive integer/);
  });

  test("throws on zero — '0' is non-positive even though it parses as a number", () => {
    process.env[ENV_NAME] = "0";
    expect(() => parsePositiveIntEnv(ENV_NAME, 30_000)).toThrow(/positive integer/);
  });

  test("throws on non-integer numerics like '3.14'", () => {
    process.env[ENV_NAME] = "3.14";
    expect(() => parsePositiveIntEnv(ENV_NAME, 30_000)).toThrow(/positive integer/);
  });

  test("throws on whitespace-padded values that wouldn't survive a strict integer parse", () => {
    process.env[ENV_NAME] = " 100 ";
    expect(() => parsePositiveIntEnv(ENV_NAME, 30_000)).toThrow(/positive integer/);
  });

  test("error message names the env var so operators can correlate to config", () => {
    process.env[ENV_NAME] = "abc";
    expect(() => parsePositiveIntEnv(ENV_NAME, 30_000)).toThrow(new RegExp(ENV_NAME));
  });
});
