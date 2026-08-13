import { describe, test, expect } from "bun:test";
import {
  resolveAdmissionWatermarkBytes,
  decideAdmission,
  createAdmissionGate,
  formatAdmissionRefusal,
  DEFAULT_ADMISSION_WATERMARK_FRACTION,
} from "./memory-admission";

const MB = 1024 * 1024;
const CEILING = 2048 * MB;

describe("resolveAdmissionWatermarkBytes", () => {
  test("defaults to a fraction of the ceiling", () => {
    expect(resolveAdmissionWatermarkBytes(CEILING, {})).toBe(
      Math.floor(CEILING * DEFAULT_ADMISSION_WATERMARK_FRACTION)
    );
  });

  test("the default watermark sits well above the measured daemon band", () => {
    // mt#3811 measured daemon RSS at 84-257MB across 1/5/10 clients. A
    // watermark anywhere near that band would refuse sessions on a healthy
    // daemon, so the margin is the property worth asserting, not the number.
    const watermark = resolveAdmissionWatermarkBytes(CEILING, {}) as number;
    expect(watermark).toBeGreaterThan(257 * MB * 5);
  });

  test("an explicit MB value wins over the fraction", () => {
    expect(
      resolveAdmissionWatermarkBytes(CEILING, {
        MINSKY_MCP_SESSION_ADMISSION_WATERMARK_MB: "512",
      })
    ).toBe(512 * MB);
  });

  test("an unparseable explicit value disables the gate rather than falling back", () => {
    // Falling back to the default would silently ignore an operator's stated
    // intent; disabling is the visible outcome (the daemon logs no watermark).
    expect(
      resolveAdmissionWatermarkBytes(CEILING, {
        MINSKY_MCP_SESSION_ADMISSION_WATERMARK_MB: "not-a-number",
      })
    ).toBeNull();
  });

  test("a non-positive explicit value disables the gate", () => {
    expect(
      resolveAdmissionWatermarkBytes(CEILING, { MINSKY_MCP_SESSION_ADMISSION_WATERMARK_MB: "0" })
    ).toBeNull();
  });

  test("returns null when there is no usable ceiling to derive from", () => {
    expect(resolveAdmissionWatermarkBytes(0, {})).toBeNull();
  });
});

describe("decideAdmission", () => {
  test("admits below the watermark", () => {
    expect(decideAdmission({ residentBytes: 100 * MB, watermarkBytes: 1536 * MB }).admit).toBe(
      true
    );
  });

  test("refuses at the watermark exactly", () => {
    // `>=`, not `>`: a process exactly at the watermark is already in the
    // state the gate exists to react to.
    expect(decideAdmission({ residentBytes: 1536 * MB, watermarkBytes: 1536 * MB }).admit).toBe(
      false
    );
  });

  test("refuses above the watermark", () => {
    expect(decideAdmission({ residentBytes: 2000 * MB, watermarkBytes: 1536 * MB }).admit).toBe(
      false
    );
  });
});

describe("createAdmissionGate", () => {
  test("reads resident bytes on every call, not once at construction", () => {
    // The gate is consulted per session-creation over the daemon's whole life,
    // so a value captured at construction would answer for a process state
    // that is minutes or hours stale.
    let resident = 100 * MB;
    const gate = createAdmissionGate({
      getResidentBytes: () => resident,
      watermarkBytes: 1536 * MB,
    });
    expect(gate().admit).toBe(true);
    resident = 1600 * MB;
    expect(gate().admit).toBe(false);
  });

  test("fails OPEN when memory cannot be measured, and says so (mt#4104)", () => {
    const gate = createAdmissionGate({
      getResidentBytes: () => null,
      watermarkBytes: 1536 * MB,
    });

    const decision = gate();
    // Open, because refusing every session over a failed READING turns a
    // measurement gap into a total outage.
    expect(decision.admit).toBe(true);
    // But distinguishable from a healthy daemon: without `measured`, this
    // decision and "comfortably under the watermark" are the same object shape,
    // which is exactly how a daemon holding 48 GB reads as fine.
    expect(decision.measured).toBe(false);
    expect(decision.residentBytes).toBeNull();
  });

  test("a measured admit is distinguishable from an unmeasured one", () => {
    const measured = createAdmissionGate({
      getResidentBytes: () => 100 * MB,
      watermarkBytes: 1536 * MB,
    })();
    const unmeasured = createAdmissionGate({
      getResidentBytes: () => null,
      watermarkBytes: 1536 * MB,
    })();

    expect(measured.admit).toBe(unmeasured.admit);
    expect(measured.measured).not.toBe(unmeasured.measured);
  });
});

describe("formatAdmissionRefusal", () => {
  test("states both figures and that established sessions are unaffected", () => {
    const message = formatAdmissionRefusal(
      { admit: false, residentBytes: 1600 * MB, watermarkBytes: 1536 * MB, measured: true },
      30
    );
    expect(message).toContain("1600MB");
    expect(message).toContain("1536MB");
    expect(message).toContain("Established sessions are unaffected");
    expect(message).toContain("30s");
  });
});
