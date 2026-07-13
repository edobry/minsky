/**
 * BasicHealth component tests (mt#2152)
 *
 * Pattern example for cockpit React component testing with
 * bun:test + happy-dom + @testing-library/react.
 *
 * Run via: bun run test:components
 */
import { describe, test, expect, afterEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { BasicHealth } from "./BasicHealth";

describe("BasicHealth widget", () => {
  afterEach(cleanup);

  test("renders health data in ok state", () => {
    render(
      <BasicHealth
        data={{
          state: "ok",
          payload: { uptimeSec: 125, version: "1.2.3", loadedWidgetCount: 5 },
        }}
      />
    );

    expect(screen.getByText("System Health")).toBeDefined();
    expect(screen.getByText("2m 5s")).toBeDefined();
    expect(screen.getByText("1.2.3")).toBeDefined();
    expect(screen.getByText("5")).toBeDefined();
  });

  test("renders degraded state with reason", () => {
    render(<BasicHealth data={{ state: "degraded", reason: "Widget crashed unexpectedly" }} />);

    expect(screen.getByText("System Health")).toBeDefined();
    expect(screen.getByText("Widget crashed unexpectedly")).toBeDefined();
  });

  test("formats uptime correctly for zero seconds", () => {
    render(
      <BasicHealth
        data={{
          state: "ok",
          payload: { uptimeSec: 0, version: "0.0.1", loadedWidgetCount: 0 },
        }}
      />
    );

    expect(screen.getByText("0m 0s")).toBeDefined();
  });
});
