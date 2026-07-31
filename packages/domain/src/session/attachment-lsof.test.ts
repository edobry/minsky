/**
 * Tests for the local `lsof -d cwd` cross-check (mt#2284).
 */

import { describe, test, expect } from "bun:test";
import { parseLsofCwdOutput, detectLiveSessionProcesses } from "./attachment-lsof";

const SESSIONS_DIR = "/Users/edobry/.local/state/minsky/sessions";

describe("parseLsofCwdOutput", () => {
  test("parses a real-shaped lsof -Fpn field-mode block into live session processes", () => {
    const raw = [
      "p10242",
      "fcwd",
      "n/Users/edobry/.local/state/minsky/sessions/d018b4e1-cc44-4a7e-bdc7-f4f41a6cf711/infra",
      "p217",
      "fcwd",
      "n/",
      "p76180",
      "fcwd",
      "n/Users/edobry/.local/state/minsky/sessions/509ff0a5-05f0-404f-8993-076e9306f923",
    ].join("\n");

    const result = parseLsofCwdOutput(raw, SESSIONS_DIR);

    expect(result).toEqual([
      {
        pid: 10242,
        sessionId: "d018b4e1-cc44-4a7e-bdc7-f4f41a6cf711",
        cwd: "/Users/edobry/.local/state/minsky/sessions/d018b4e1-cc44-4a7e-bdc7-f4f41a6cf711/infra",
      },
      {
        pid: 76180,
        sessionId: "509ff0a5-05f0-404f-8993-076e9306f923",
        cwd: "/Users/edobry/.local/state/minsky/sessions/509ff0a5-05f0-404f-8993-076e9306f923",
      },
    ]);
  });

  test("ignores processes whose cwd is outside the sessions dir", () => {
    const raw = ["p100", "fcwd", "n/Users/edobry/Projects/minsky"].join("\n");
    expect(parseLsofCwdOutput(raw, SESSIONS_DIR)).toEqual([]);
  });

  test("handles a sessions dir with a trailing slash the same as without", () => {
    const raw = ["p1", "fcwd", "n/Users/edobry/.local/state/minsky/sessions/abc"].join("\n");
    expect(parseLsofCwdOutput(raw, `${SESSIONS_DIR}/`)).toEqual([
      { pid: 1, sessionId: "abc", cwd: "/Users/edobry/.local/state/minsky/sessions/abc" },
    ]);
  });

  test("returns an empty array for empty input", () => {
    expect(parseLsofCwdOutput("", SESSIONS_DIR)).toEqual([]);
  });
});

describe("detectLiveSessionProcesses", () => {
  test("uses the injected runner rather than shelling out for real", async () => {
    const fakeRunner = async () => ["p55", "fcwd", `n${SESSIONS_DIR}/session-x`].join("\n");

    const result = await detectLiveSessionProcesses(SESSIONS_DIR, fakeRunner);

    expect(result).toEqual([{ pid: 55, sessionId: "session-x", cwd: `${SESSIONS_DIR}/session-x` }]);
  });
});
