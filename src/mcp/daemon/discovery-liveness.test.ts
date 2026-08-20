import { describe, expect, test } from "bun:test";
import {
  classifyDiscoveryLiveness,
  healthUrlFor,
  isDaemonUsable,
  type DiscoveryLiveness,
} from "./discovery-liveness";
import type { HealthProbeOutcome, LocalDaemonDiscoveryRecord } from "./local-daemon";

const RECORD: LocalDaemonDiscoveryRecord = {
  port: 48765,
  host: "127.0.0.1",
  pid: 27569,
  startedAt: "2026-08-20T21:55:57.121Z",
};

/** A `/health` body the identity assertion accepts. */
const HEALTHY_BODY = { status: "ok", service: "minsky-mcp" };

const alive = () => true;
const dead = () => false;

const answers = (body: unknown) => async (): Promise<HealthProbeOutcome> => ({
  kind: "body",
  body,
});
const refuses = async (): Promise<HealthProbeOutcome> => ({
  kind: "unreachable",
  detail: "connect ECONNREFUSED 127.0.0.1:48765",
});
const httpError = (status: number) => async (): Promise<HealthProbeOutcome> => ({
  kind: "http-error",
  status,
});

describe("classifyDiscoveryLiveness", () => {
  test("a record naming a pid that does not exist is not live", async () => {
    const result = await classifyDiscoveryLiveness(RECORD, {
      pidAlive: dead,
      probe: answers(HEALTHY_BODY),
    });

    expect(result.state).toBe("not-live");
    if (result.state !== "not-live") throw new Error("unreachable");
    expect(result.reason).toBe("pid-dead");
    expect(result.detail).toContain("27569");
    expect(isDaemonUsable(result)).toBe(false);
  });

  test("NEGATIVE CONTROL: the same record with a live pid and a healthy answer IS live", async () => {
    // Without this, the assertion above passes for a classifier that returns
    // not-live unconditionally. This is the run that proves the probe can
    // distinguish, not merely refuse.
    const result = await classifyDiscoveryLiveness(RECORD, {
      pidAlive: alive,
      probe: answers(HEALTHY_BODY),
    });

    expect(result.state).toBe("live");
    expect(isDaemonUsable(result)).toBe(true);
  });

  test("a live pid with nothing listening on the port is not live", async () => {
    // The case the pid check ALONE cannot reach: pid alive (or reused), port
    // dead. This is why the classifier does not short-circuit on a live pid.
    const result = await classifyDiscoveryLiveness(RECORD, {
      pidAlive: alive,
      probe: refuses,
    });

    expect(result.state).toBe("not-live");
    if (result.state !== "not-live") throw new Error("unreachable");
    expect(result.reason).toBe("not-serving");
    expect(isDaemonUsable(result)).toBe(false);
  });

  test("a port answering with the WRONG service identity is not live", async () => {
    // mt#3142: another Minsky app answers /health exactly like the right one.
    const result = await classifyDiscoveryLiveness(RECORD, {
      pidAlive: alive,
      probe: answers({ status: "ok", service: "minsky-cockpit" }),
    });

    expect(result.state).toBe("not-live");
    if (result.state !== "not-live") throw new Error("unreachable");
    expect(result.reason).toBe("wrong-service");
    expect(isDaemonUsable(result)).toBe(false);
  });

  test("an identity-free HTTP error is INDETERMINATE, not dead", async () => {
    const result = await classifyDiscoveryLiveness(RECORD, {
      pidAlive: alive,
      probe: httpError(502),
    });

    expect(result.state).toBe("indeterminate");
    expect(result.detail).toContain("502");
  });

  test("indeterminate fails CLOSED — the whole point of the third state", async () => {
    // The bug this guards: `state !== "not-live"` reads as a reasonable
    // usability test and is wrong on exactly this input.
    const result = await classifyDiscoveryLiveness(RECORD, {
      pidAlive: alive,
      probe: httpError(500),
    });

    expect(result.state).toBe("indeterminate");
    expect(isDaemonUsable(result)).toBe(false);
    expect(result.state !== "not-live").toBe(true); // the naive test disagrees
  });

  test("no record is not live, and is distinguishable from a dead daemon", async () => {
    const result = await classifyDiscoveryLiveness(null);

    expect(result.state).toBe("not-live");
    if (result.state !== "not-live") throw new Error("unreachable");
    expect(result.reason).toBe("no-record");
    expect(result.record).toBeNull();
  });

  test("startedAt is never consulted — no timeout is load-bearing", async () => {
    // "No timeout may be load-bearing for a safety property" (Presence vs lock
    // RFC). An ancient startedAt on a serving daemon must still read live.
    const ancient: LocalDaemonDiscoveryRecord = {
      ...RECORD,
      startedAt: "2020-01-01T00:00:00.000Z",
    };

    const result = await classifyDiscoveryLiveness(ancient, {
      pidAlive: alive,
      probe: answers(HEALTHY_BODY),
    });

    expect(result.state).toBe("live");
  });

  test("the probed URL is built from the record, not a hardcoded default", async () => {
    const odd: LocalDaemonDiscoveryRecord = { ...RECORD, host: "127.0.0.2", port: 51000 };
    let probed = "";

    await classifyDiscoveryLiveness(odd, {
      pidAlive: alive,
      probe: async (url) => {
        probed = url;
        return { kind: "body", body: HEALTHY_BODY };
      },
    });

    expect(probed).toBe("http://127.0.0.2:51000/health");
    expect(healthUrlFor(odd)).toBe(probed);
  });

  test("a dead pid short-circuits before the port is probed", async () => {
    let probeCalled = false;

    await classifyDiscoveryLiveness(RECORD, {
      pidAlive: dead,
      probe: async () => {
        probeCalled = true;
        return { kind: "body", body: HEALTHY_BODY };
      },
    });

    expect(probeCalled).toBe(false);
  });
});

describe("isDaemonUsable", () => {
  test("admits live and nothing else", () => {
    const live: DiscoveryLiveness = { state: "live", record: RECORD, detail: "" };
    const notLive: DiscoveryLiveness = {
      state: "not-live",
      reason: "pid-dead",
      detail: "",
      record: RECORD,
    };
    const unknown: DiscoveryLiveness = { state: "indeterminate", detail: "", record: RECORD };

    expect(isDaemonUsable(live)).toBe(true);
    expect(isDaemonUsable(notLive)).toBe(false);
    expect(isDaemonUsable(unknown)).toBe(false);
  });
});
