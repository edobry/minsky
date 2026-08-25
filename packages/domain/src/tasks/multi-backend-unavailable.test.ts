/**
 * Zero-backend read guard (mt#3636).
 *
 * When Postgres fails to initialize at boot, DI substitutes
 * `UnconfiguredPersistenceProvider`, `createConfiguredTaskService` catches the
 * resulting throw, and the "mt" backend is never registered. Before this fix
 * the WRITE path guarded that state (`createTaskFromTitleAndSpec` threw "No
 * backends registered") but the READ path did not: `listTasks` iterated an
 * empty `backends` array and returned `[]`, and `getTask` fell through the same
 * empty loop and returned `null`. Both are byte-identical to the truthful
 * answers for an empty database and a nonexistent task, so an unreachable
 * database presented as an empty task graph.
 *
 * Observed against the un-fixed tree by booting the CLI with an unresolvable
 * Postgres host:
 *
 *   $ minsky tasks list --limit 3 --json
 *   { "tasks": [], "returned": 0, "total": 0, "truncated": false }   EXIT=0
 *   $ minsky tasks status get mt#3524
 *   Not found: Task mt#3524 not found or has no status                EXIT=0
 *
 * No mocks: `TaskServiceImpl` is exercised directly, and the "has a backend"
 * cases use a small in-memory backend rather than a patched collaborator.
 */

import { describe, test, expect } from "bun:test";
import { createTaskService } from "./multi-backend-service";
import type { Task, TaskBackend } from "./types";

const WORKSPACE = "/mock/mt3636-workspace";

/** The verbatim boot failure from the 2026-08-03 incident. */
const BOOT_FAILURE = "getaddrinfo ENOTFOUND";

/** The guard's error name — asserted rather than matched on prose. */
const UNAVAILABLE_ERROR = "TaskBackendUnavailableError";

/**
 * `.then` fulfilled-arm for a call the test expects to REJECT.
 *
 * Returning `never` keeps the awaited value a plain `Error`; the previous
 * `.catch((e) => e as Error)` widened it to `Error | Task`, so every assertion
 * below read a property off a union — and, worse, a call that unexpectedly
 * RESOLVED flowed through as the "error" and the test still passed. Throwing
 * here makes that case fail loudly instead.
 */
function expectedRejection(): never {
  throw new Error("expected the call to reject, but it resolved");
}

/** Minimal in-memory backend — enough to prove the guard does NOT fire. */
function fakeBackend(tasks: Task[] = []): TaskBackend {
  return {
    name: "minsky",
    prefix: "mt",
    async getTask(taskId: string) {
      return tasks.find((t) => t.id === taskId) ?? null;
    },
    async listTasks() {
      return tasks;
    },
    async getTaskStatus(taskId: string) {
      return tasks.find((t) => t.id === taskId)?.status;
    },
    async setTaskStatus() {
      return { recordsAffected: 1 };
    },
    async createTaskFromTitleAndSpec() {
      throw new Error("not used");
    },
    async deleteTask() {
      return true;
    },
    getCapabilities() {
      return { supportsTags: false };
    },
    getWorkspacePath() {
      return WORKSPACE;
    },
  } as unknown as TaskBackend;
}

describe("zero-backend read guard (mt#3636)", () => {
  describe("configured-but-unavailable — the boot-failure case", () => {
    const build = () => {
      const service = createTaskService({ workspacePath: WORKSPACE });
      service.setBackendUnavailable({
        reason: BOOT_FAILURE,
        configured: true,
        backend: "postgres",
      });
      return service;
    };

    test("listTasks RAISES instead of returning an empty list", async () => {
      await expect(build().listTasks()).rejects.toThrow(/Task backend unavailable/);
    });

    test("getTask RAISES instead of returning null", async () => {
      await expect(build().getTask("mt#3524")).rejects.toThrow(/Task backend unavailable/);
    });

    test("getTaskStatus RAISES instead of reporting a real task as not-found", async () => {
      // The incident's sharpest symptom: mt#3524 exists, and the degraded
      // server answered "not found or has no status".
      await expect(build().getTaskStatus("mt#3524")).rejects.toThrow(/Task backend unavailable/);
    });

    test("getTasks RAISES for a non-empty id set", async () => {
      await expect(build().getTasks(["mt#1", "mt#2"])).rejects.toThrow(/Task backend unavailable/);
    });

    test("deleteTask RAISES instead of returning false (which reads as not-found)", async () => {
      await expect(build().deleteTask("mt#3524")).rejects.toThrow(/Task backend unavailable/);
    });

    test("the WRITE path names the cause even with an EXPLICIT backend argument", async () => {
      // PR #2596 R2: the explicit-backend lookup runs before the default-backend
      // path, so with zero backends it used to answer "Requested backend
      // 'minsky' is not registered. Available backends: none." — a description
      // of the symptom that hides the unreachable database. The guard now runs
      // ahead of every routing decision.
      const error = await build()
        .createTaskFromTitleAndSpec("a title", "a spec", { backend: "minsky" })
        .then(expectedRejection, (e: unknown) => e as Error);

      expect(error.name).toBe(UNAVAILABLE_ERROR);
      expect(error.message).toContain(BOOT_FAILURE);
      expect(error.message).not.toContain("is not registered");
    });

    test("the WRITE path now names the cause too, not a bare 'No backends registered'", async () => {
      // The write path was always loud, but "No backends registered" was the
      // only signal a caller got during the incident — it says nothing about
      // the database being unreachable.
      const error = await build()
        .createTaskFromTitleAndSpec("a title", "a spec")
        .then(expectedRejection, (e: unknown) => e as Error);

      expect(error.name).toBe(UNAVAILABLE_ERROR);
      expect(error.message).toContain(BOOT_FAILURE);
      expect(error.message).not.toBe("No backends registered");
    });

    test("the error names the backend, the degraded state, and the underlying cause", async () => {
      const error = await build()
        .listTasks()
        .then(expectedRejection, (e: unknown) => e as Error);

      expect(error.message).toContain("postgres");
      expect(error.message).toContain(BOOT_FAILURE);
      expect(error.message).toContain("failed to initialize AT BOOT");
      // Must not be mistakable for a legitimately empty database.
      expect(error.message).toContain("not the same as an empty database");
      expect(error.name).toBe(UNAVAILABLE_ERROR);
    });

    // ---- mt#4379: the message must not report a boot fact in the present tense ----

    test("the error does NOT assert the database is currently unreachable", async () => {
      // The regression this guards is expensive and was paid twice. The old
      // wording said "The database is unreachable" and "`minsky persistence
      // check` reports the same failure" — both true AT BOOT, both false by the
      // time anyone read them. In the originating incident persistence had
      // recovered and `persistence check` returned "All checks passed" seconds
      // before this error rendered, and two separate agent sessions each spent
      // their first diagnostic minutes on a healthy database.
      const error = await build()
        .listTasks()
        .then(expectedRejection, (e: unknown) => e as Error);

      expect(error.message).not.toContain("The database is unreachable");
      expect(error.message).not.toContain("reports the same failure");
    });

    test("with no retry recorded, the error says so rather than implying a live outage", async () => {
      const error = await build()
        .listTasks()
        .then(expectedRejection, (e: unknown) => e as Error);

      expect(error.message).toContain("NOT been re-attempted since boot");
    });

    test("once a retry is recorded, the error carries its timestamp and cause", async () => {
      // ADR-035 rule 4: without `lastAttemptAt`, "stuck since boot" and "still
      // retrying against a real outage" are the same reading to an operator.
      const service = build() as unknown as {
        noteRetryAttempt(at: Date, error: string): void;
        listTasks(): Promise<unknown>;
      };
      service.noteRetryAttempt(new Date("2026-08-21T19:30:00.000Z"), "connect ECONNREFUSED");

      const error = await service.listTasks().then(expectedRejection, (e: unknown) => e as Error);

      expect(error.message).toContain("2026-08-21T19:30:00.000Z");
      expect(error.message).toContain("connect ECONNREFUSED");
      expect(error.message).not.toContain("NOT been re-attempted since boot");
    });

    // ---- mt#4379: the derived value must be enrollable for its own retry ----

    test("a configured-but-failed zero-backend service marks itself degradedSubstitute", async () => {
      // This is the whole fix for the derived-value gap. The container's
      // `asDegradedSubstitute()` is a STRUCTURAL check — `degradedSubstitute
      // === true` plus a callable `noteRetryAttempt` — so a service that does
      // not expose both is indistinguishable from a healthy resolution and gets
      // memoized as `useValue`, never retried. That is what left `session_start`
      // serving a zero-backend task service for 20+ hours.
      const service = build() as unknown as {
        degradedSubstitute: boolean;
        noteRetryAttempt: unknown;
      };

      expect(service.degradedSubstitute).toBe(true);
      expect(typeof service.noteRetryAttempt).toBe("function");
    });

    test("an UNCONFIGURED zero-backend service is NOT marked degraded", async () => {
      // ADR-035 rule 3, applied to the derived value: "configured but failing"
      // and "not configured" are different states with different correct
      // responses. A laptop with no Postgres at all is the expected local/dev
      // path — marking it degraded would spin the container's retry loop
      // forever on a machine where there is nothing to recover.
      const service = createTaskService({ workspacePath: WORKSPACE });
      service.setBackendUnavailable({
        reason: "no Postgres connection configured",
        configured: false,
      });

      expect((service as unknown as { degradedSubstitute: boolean }).degradedSubstitute).toBe(
        false
      );
    });

    test("a service with a registered backend is NOT marked degraded", async () => {
      // The healthy path must stay out of the retry loop entirely, even if a
      // stale unavailability was recorded before the backend came up.
      const service = createTaskService({ workspacePath: WORKSPACE });
      service.setBackendUnavailable({
        reason: BOOT_FAILURE,
        configured: true,
        backend: "postgres",
      });
      service.registerBackend(fakeBackend([]));

      expect((service as unknown as { degradedSubstitute: boolean }).degradedSubstitute).toBe(
        false
      );
    });

    test("getTasks([]) still returns empty — an empty request needs no backend", async () => {
      expect(await build().getTasks([])).toEqual([]);
    });
  });

  describe("deliberately unconfigured — the offline-boot case (mt#2349)", () => {
    // ADR-018, quoted in ADR-027: "A bare install with no Postgres connection
    // should fail with a clear 'configure Postgres' error, not silently fall
    // back." So this path ALSO raises — it just says something different.
    const build = () => {
      const service = createTaskService({ workspacePath: WORKSPACE });
      service.setBackendUnavailable({
        reason: "no Postgres connection configured",
        configured: false,
      });
      return service;
    };

    test("listTasks RAISES with configure-Postgres guidance, not a boot-failure claim", async () => {
      const error = await build()
        .listTasks()
        .then(expectedRejection, (e: unknown) => e as Error);

      expect(error.message).toContain("persistence is not configured");
      expect(error.message).toContain("persistence.postgres.connectionString");
      // Must NOT fabricate a boot failure that never happened.
      expect(error.message).not.toContain("failed to initialize at boot");
    });
  });

  describe("no reason recorded", () => {
    test("still raises rather than answering empty", async () => {
      const service = createTaskService({ workspacePath: WORKSPACE });
      await expect(service.listTasks()).rejects.toThrow(/no task backend is registered/);
    });
  });

  describe("the healthy path is untouched", () => {
    const task: Task = {
      id: "mt#1",
      title: "A real task",
      status: "TODO",
    } as Task;

    test("listTasks returns rows when a backend IS registered", async () => {
      const service = createTaskService({ workspacePath: WORKSPACE });
      service.registerBackend(fakeBackend([task]));
      expect(await service.listTasks()).toHaveLength(1);
    });

    test("getTask returns null for a genuinely absent task — the truthful not-found", async () => {
      const service = createTaskService({ workspacePath: WORKSPACE });
      service.registerBackend(fakeBackend([task]));
      expect(await service.getTask("mt#999")).toBeNull();
    });

    test("a recorded unavailability does not disable a backend that DID register", async () => {
      // The guard keys on backends.length, not on the recorded reason: a
      // GitHub backend that registered while Postgres was down can still answer.
      const service = createTaskService({ workspacePath: WORKSPACE });
      service.setBackendUnavailable({
        reason: BOOT_FAILURE,
        configured: true,
        backend: "postgres",
      });
      service.registerBackend(fakeBackend([task]));
      expect(await service.listTasks()).toHaveLength(1);
    });
  });
});
