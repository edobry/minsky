/**
 * Contract test pinning the `/api/health` response shape against the shared
 * golden fixture consumed by the Rust tray supervisor (mt#2629).
 *
 * `contract/cockpit-health-shape.json` at the repo root is the single
 * checked-in source of truth for the field set + per-field types this route
 * emits. The Rust side (`cockpit-tray/src-tauri/src/supervisor.rs`'s
 * `health_contract` test module) reads the SAME fixture via `include_str!`
 * and additionally scans the literal TypeScript source of `./routes/health.ts`
 * for the field names it depends on (`db`, `processStartedAtMs`). Renaming,
 * removing, or re-typing any field emitted here fails THIS test immediately;
 * renaming one of the two Rust-consumed fields also fails the cargo test.
 * See `contract/README.md` for the full contract note.
 *
 * @see contract/cockpit-health-shape.json
 * @see contract/README.md
 * @see cockpit-tray/src-tauri/src/supervisor.rs — `health_contract` test module
 */
import { describe, test, expect, afterEach } from "bun:test";
import { createServer } from "http";
import type { Server } from "http";
import { createCockpitServer } from "./server";
// Static JSON import (resolveJsonModule) — the checked-in golden fixture IS
// the contract under test, so no fs access is needed (and the
// custom/no-real-fs-in-tests rule stays satisfied without an exception).
import healthShapeFixtureJson from "../../contract/cockpit-health-shape.json";

interface HealthShapeFixture {
  fields: Record<string, string>;
}

function loadFixture(): HealthShapeFixture {
  return healthShapeFixtureJson as unknown as HealthShapeFixture;
}

/** Map a JS runtime value to the coarse type vocabulary used by the fixture. */
function typeOf(value: unknown): string {
  if (value === null) return "object"; // JSON null has no dedicated slot here; unused by this route.
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// mt#2538: createCockpitServer now generates/persists a real bearer token on
// first use unless overridden — pass a fixed test token so these GET-only
// tests never touch ~/.local/state/minsky/cockpit-token.
const TEST_TOKEN = "test-health-contract-token";

async function startTestServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const app = createCockpitServer({ overrideToken: TEST_TOKEN });
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("unexpected addr shape");
  const url = `http://127.0.0.1:${addr.port}`;
  const close = () =>
    new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return { url, close };
}

describe("Cockpit /api/health contract (mt#2629)", () => {
  const closeList: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closeList.splice(0)) {
      await close();
    }
  });

  test("live response field set matches the shared golden fixture exactly", async () => {
    const fixture = loadFixture();
    const { url, close } = await startTestServer();
    closeList.push(close);

    const res = await fetch(`${url}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    const fixtureFields = Object.keys(fixture.fields).sort();
    const actualFields = Object.keys(body).sort();

    // Exact set equality — a field added, removed, or renamed in health.ts
    // must be reflected in contract/cockpit-health-shape.json in the same PR.
    expect(actualFields).toEqual(fixtureFields);
  });

  test("live response field types match the shared golden fixture", async () => {
    const fixture = loadFixture();
    const { url, close } = await startTestServer();
    closeList.push(close);

    const res = await fetch(`${url}/api/health`);
    const body = (await res.json()) as Record<string, unknown>;

    for (const [field, expectedType] of Object.entries(fixture.fields)) {
      expect(body).toHaveProperty(field);
      expect(typeOf(body[field])).toBe(expectedType);
    }
  });

  test("fixture's rustConsumedFields are a subset of its own fields", async () => {
    // Self-consistency guard on the fixture file itself: the field names the
    // Rust supervisor is documented to depend on must actually be declared
    // in `fields` — otherwise the cargo-side pin (see supervisor.rs) would be
    // checking a field this fixture doesn't even claim to emit.
    const parsed = healthShapeFixtureJson as unknown as HealthShapeFixture & {
      rustConsumedFields: string[];
    };
    for (const field of parsed.rustConsumedFields) {
      expect(Object.keys(parsed.fields)).toContain(field);
    }
  });
});
