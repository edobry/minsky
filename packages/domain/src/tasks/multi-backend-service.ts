import { injectable } from "tsyringe";
import type {
  Task,
  TaskBackend,
  TaskListOptions,
  CreateTaskOptions,
  DeleteTaskOptions,
  StatusWriteOutcome,
} from "./types";
export type { TaskBackend } from "./types";
import type { TaskServiceInterface, TaskSpecContentResult } from "../tasks";
import { log } from "@minsky/shared/logger";
import { MultiBackendError, TaskBackendUnavailableError } from "./multi-backend-errors";

/**
 * Why no task backend could be registered (mt#3636).
 *
 * Recorded by `createConfiguredTaskService` when backend registration fails, so
 * that a later zero-backend read can name the underlying cause instead of
 * answering with an empty list. Without this the failure is only in the boot
 * log — which an MCP client never sees.
 */
export interface TaskBackendUnavailability {
  /** The underlying initialization error, verbatim from the persistence layer. */
  reason: string;
  /**
   * `true` when a backend WAS configured but failed to initialize (a genuine
   * outage); `false` when nothing was configured at all (mt#2349's deliberate
   * offline boot). Mirrors `UnconfiguredPersistenceProvider.configuredButUnavailable`.
   */
  configured: boolean;
  /** The configured backend's name, e.g. `"postgres"`. */
  backend?: string;
}

// Multi-backend specific interface - different from the main TaskBackend interface
export interface MultiBackendTaskBackend {
  name: string;
  prefix: string; // Backend-specific prefix for qualified IDs
  createTask(spec: TaskSpec): Promise<Task>;
  getTask(taskId: string): Promise<Task | null>;
  updateTask(taskId: string, updates: Partial<Task>): Promise<Task>;
  deleteTask(taskId: string): Promise<void>;
  listTasks(filters?: TaskFilters): Promise<Task[]>;
  supportsFeature(feature: string): boolean;
  // New multi-backend methods
  exportTask(taskId: string): Promise<TaskExportData>;
  importTask(data: TaskExportData): Promise<Task>;
  validateLocalId(localId: string): boolean;
}

export interface TaskSpec {
  id: string;
  title: string;
  spec: string;
  status: string;
}

export interface TaskFilters {
  status?: string;
  backend?: string;
}

// Types for migration and cross-backend operations
export interface TaskExportData {
  spec: TaskSpec;
  metadata: Record<string, unknown>;
  backend: string;
  exportedAt?: string;
}

// Types for migration result tracking
export interface MigrationResult {
  success: boolean;
  tasksMigrated: number;
  errors: string[];
  backupFile?: string;
}

// Types for collision detection between backends
export interface TaskCollision {
  taskId: string;
  backends: string[];
  conflictType: "id" | "title" | "both";
}

export interface CollisionReport {
  collisions: TaskCollision[];
  totalChecked: number;
  hasConflicts: boolean;
}

// Public service interface - extends TaskServiceInterface for compatibility
export interface TaskService extends TaskServiceInterface {
  // Multi-backend specific methods
  registerBackend(backend: TaskBackend): void;
  listBackends(): TaskBackend[];

  /**
   * Record why no backend could be registered (mt#3636). Purely informational:
   * it does not itself disable anything — the zero-backend guard fires on
   * `backends.length === 0` regardless — it only supplies the cause the guard's
   * error message names.
   */
  setBackendUnavailable(unavailability: TaskBackendUnavailability): void;

  // Additional multi-backend methods
  updateTask(taskId: string, updates: Partial<Task>): Promise<Task>;
}

// Complete implementation that supports both single-backend and multi-backend operations
@injectable()
export class TaskServiceImpl implements TaskService {
  private readonly backends: TaskBackend[] = [];
  private readonly workspacePath: string;
  private defaultBackend: TaskBackend | null = null;
  /** Why registration failed, when it did — see `setBackendUnavailable` (mt#3636). */
  private unavailability: TaskBackendUnavailability | null = null;

  constructor(options: { workspacePath: string }) {
    this.workspacePath = options.workspacePath;
  }

  registerBackend(backend: TaskBackend): void {
    this.backends.push(backend);
    // Set first backend as default for unqualified IDs
    if (!this.defaultBackend) {
      this.defaultBackend = backend;
    }
  }

  setDefaultBackend(backendName: string): void {
    const backend = this.backends.find((b) => b.name === backendName);
    if (backend) {
      this.defaultBackend = backend;
    } else {
      log.warn(`Cannot set default backend '${backendName}' - backend not found`, {
        availableBackends: this.backends.map((b) => b.name),
      });
    }
  }

  listBackends(): TaskBackend[] {
    return [...this.backends];
  }

  setBackendUnavailable(unavailability: TaskBackendUnavailability): void {
    this.unavailability = unavailability;
  }

  /**
   * Structural marker making a zero-backend service enrollable for retry
   * (mt#4379, extending ADR-035 rule 1 to a DERIVED value).
   *
   * ADR-035 requires that a failed initialization not be memoized as a value
   * without also arming its retry. The composition root obeys that for
   * `persistence` itself — but this service is BUILT FROM that substitute, and
   * carried no marker of its own, so `asDegradedSubstitute()` in the container
   * saw an ordinary success and memoized it as `useValue`. Its recovery was
   * therefore entirely parasitic on the `persistence` key's retry cascade; when
   * a dependent lost the rebuild race, nothing could ever repair it again.
   *
   * The shape is duck-typed on purpose — the container checks
   * `degradedSubstitute === true` plus a callable `noteRetryAttempt`
   * structurally, so the domain layer never imports the composition layer.
   *
   * **Only a CONFIGURED-but-failed backend is degraded.** A zero-backend service
   * on a machine with no database at all is `configured: false` — the expected
   * local/dev path — and must NOT be marked, or every laptop without Postgres
   * would spin the retry loop forever. That is ADR-035 rule 3's
   * "configured but failing" vs "not configured" distinction, applied here.
   */
  get degradedSubstitute(): boolean {
    return this.backends.length === 0 && this.unavailability?.configured === true;
  }

  /**
   * Record a re-initialization attempt against this service (ADR-035 rule 4).
   *
   * Without this, "stuck since boot" and "retried just now and still failing"
   * render identically to an operator — the specific confusion that made
   * mt#4379 read as a database outage when the database was fine.
   */
  noteRetryAttempt(at: Date, error: string): void {
    this.lastRetryAt = at;
    this.lastRetryError = error;
  }

  /** When re-registration was last attempted; `null` means never since boot. */
  private lastRetryAt: Date | null = null;
  private lastRetryError: string | null = null;

  /**
   * Fail closed when there is no backend to answer an operation (mt#3636).
   *
   * The write path has always guarded this — `createTaskFromTitleAndSpec`
   * throws "No backends registered" — but the read path did not, so `listTasks`
   * iterated an empty array and returned `[]` while `getTask` fell through the
   * same empty loop and returned `null`. Both are byte-identical to the
   * truthful answers for an empty database and a nonexistent task, so a failed
   * Postgres boot presented as an empty task graph. That is strictly more
   * dangerous than an error: an erroring tool stops an agent, whereas "no
   * tasks" invites it to act on the emptiness — re-create tasks that already
   * exist, or conclude a dependency is missing.
   *
   * Fires only when ZERO backends are registered. A healthy service always has
   * at least one, so the working path is untouched.
   */
  private assertBackendAvailable(operation: string): void {
    if (this.backends.length > 0) return;
    throw new TaskBackendUnavailableError(operation, this.describeUnavailability());
  }

  /**
   * Build the actionable half of the guard's message: the backend, the degraded
   * state, and the underlying cause — matching what `persistence check` already
   * reports for the same failure.
   */
  private describeUnavailability(): string {
    const unavailability = this.unavailability;
    if (!unavailability) {
      return "no task backend is registered.";
    }
    if (unavailability.configured) {
      // The retry clause is what keeps this HONEST (mt#4379). The previous
      // wording asserted "The database is unreachable" and "`minsky persistence
      // check` reports the same failure" in the PRESENT tense — both describe
      // the moment of boot, and both were false by the time anyone read them.
      // In the originating incident persistence had long since recovered and
      // `persistence check` returned "All checks passed" seconds before this
      // error rendered, so two separate agents spent their first diagnostic
      // minutes on a healthy database. A boot-time observation must carry its
      // timestamp, not masquerade as current state.
      const retryClause = this.lastRetryAt
        ? `Last re-registration attempt ${this.lastRetryAt.toISOString()} also failed` +
          `${this.lastRetryError ? ` (${this.lastRetryError})` : ""}.`
        : "This registration has NOT been re-attempted since boot, so the underlying " +
          "dependency may well have recovered in the meantime.";
      return (
        `the '${unavailability.backend ?? "postgres"}' persistence backend was configured but ` +
        `failed to initialize AT BOOT (${unavailability.reason}), so no task backend was ` +
        `registered. ${retryClause} This is a backend-REGISTRATION failure, which is not the ` +
        "same as an empty database and not necessarily a current outage — an empty result here " +
        "would be indistinguishable from a real one, which is why this fails instead. Note " +
        "`minsky persistence check` may well PASS while this fails: it probes the live " +
        "connection, whereas this reports what happened when the backend was registered."
      );
    }
    return (
      `no task backend is registered because persistence is not configured ` +
      `(${unavailability.reason}). Set persistence.postgres.connectionString in config, or ` +
      "export MINSKY_PERSISTENCE_POSTGRES_URL."
    );
  }

  private parsePrefixFromId(taskId: string): string | null {
    const match = taskId.match(/^([a-zA-Z0-9_-]+)#/);
    return match ? match[1] || null : null;
  }

  private getBackendByPrefix(prefix: string | null): TaskBackend | null {
    if (!prefix) return null;
    const found = this.backends.find((b) => b.prefix === prefix);
    return found || null;
  }

  private qualifyTaskFromBackend(task: Task | null, backend: TaskBackend | null): Task | null {
    if (!task || !backend) return task;
    const prefix = backend.prefix;
    if (!prefix) return task;
    const id = task.id || "";
    if (id.includes("#")) {
      // If legacy format like #123, convert to md#123; if already qualified, keep
      if (/^#/.test(id)) {
        return { ...task, id: `${prefix}${id}` };
      }
      return task;
    }
    return { ...task, id: `${prefix}#${id}` };
  }

  async getTask(taskId: string): Promise<Task | null> {
    this.assertBackendAvailable(`read task ${taskId}`);
    const backend = this.getBackendByPrefix(this.parsePrefixFromId(taskId));
    if (backend) {
      const t = await backend.getTask(taskId);
      return this.qualifyTaskFromBackend(t, backend);
    }
    // Fallback: search all backends
    for (const b of this.backends) {
      const t = await b.getTask(taskId);
      if (t) return t;
    }
    return null;
  }

  // TaskServiceInterface implementation
  async listTasks(options?: TaskListOptions): Promise<Task[]> {
    this.assertBackendAvailable("list tasks");
    const results: Task[] = [];
    for (const b of this.backends) {
      const list = await b.listTasks(options);
      results.push(
        ...list.map((t) => this.qualifyTaskFromBackend(t, b)).filter((t): t is Task => t !== null)
      );
    }
    return results;
  }

  // Alias for backward compatibility
  async listAllTasks(): Promise<Task[]> {
    return this.listTasks();
  }

  async updateTask(taskId: string, updates: Partial<Task>): Promise<Task> {
    const backend = this.getBackendByPrefix(this.parsePrefixFromId(taskId));
    if (!backend) {
      throw new Error(`Backend not found for id: ${taskId}`);
    }

    // Get current task to merge with updates
    const currentTask = await backend.getTask(taskId);
    if (!currentTask) {
      throw new Error(`Task ${taskId} not found`);
    }

    // If backend has setTaskMetadata method, use it for comprehensive updates
    type BackendWithMetadata = typeof backend & {
      setTaskMetadata: (id: string, meta: Record<string, unknown>) => Promise<void>;
    };
    if (
      "setTaskMetadata" in backend &&
      typeof (backend as BackendWithMetadata).setTaskMetadata === "function"
    ) {
      const metadata = {
        id: taskId,
        title: updates.title !== undefined ? updates.title : currentTask.title,
        status: updates.status !== undefined ? updates.status : currentTask.status,
        spec: updates.spec,
        backend: currentTask.backend || backend.name,
        updatedAt: new Date(),
      };

      await (backend as BackendWithMetadata).setTaskMetadata(taskId, metadata);
    } else {
      // Fallback to individual updates for backends without setTaskMetadata

      // Update status via backend API if provided
      if (updates.status) {
        await backend.setTaskStatus(taskId, updates.status);
      }
    }

    // Handle tags update if backend supports it
    if (updates.tags !== undefined) {
      if (backend.getCapabilities().supportsTags && backend.updateTags) {
        await backend.updateTags(taskId, updates.tags);
      } else {
        log.warn(
          `Backend "${backend.name}" does not support tags; tag update skipped for ${taskId}`
        );
      }
    }

    const final = await this.getTask(taskId);
    // In tests with mocked IO, allow eventual consistency without throwing
    return (final || (await backend.getTask(taskId))) as Task;
  }

  async getTasks(ids: string[]): Promise<Task[]> {
    // An empty request is truthfully answered with an empty result without
    // touching a backend, so the guard belongs after this early return.
    if (ids.length === 0) return [];
    this.assertBackendAvailable(`read ${ids.length} task(s)`);

    // Partition IDs by backend prefix
    const byBackend = new Map<TaskBackend, string[]>();
    const unrouted: string[] = [];

    for (const id of ids) {
      const backend = this.getBackendByPrefix(this.parsePrefixFromId(id));
      if (backend) {
        const existing = byBackend.get(backend) ?? [];
        existing.push(id);
        byBackend.set(backend, existing);
      } else {
        unrouted.push(id);
      }
    }

    const results: Task[] = [];

    // Fetch from each backend, using batch getTasks if available, otherwise sequential
    for (const [backend, backendIds] of byBackend) {
      if (typeof backend.getTasks === "function") {
        const tasks = await backend.getTasks(backendIds);
        results.push(
          ...tasks
            .map((t) => this.qualifyTaskFromBackend(t, backend))
            .filter((t): t is Task => t !== null)
        );
      } else {
        for (const id of backendIds) {
          const t = await backend.getTask(id);
          if (t) {
            const qualified = this.qualifyTaskFromBackend(t, backend);
            if (qualified) results.push(qualified);
          }
        }
      }
    }

    // Unrouted IDs: search all backends sequentially
    for (const id of unrouted) {
      for (const b of this.backends) {
        const t = await b.getTask(id);
        if (t) {
          const qualified = this.qualifyTaskFromBackend(t, b);
          if (qualified) results.push(qualified);
          break;
        }
      }
    }

    return results;
  }

  async deleteTask(taskId: string, options?: DeleteTaskOptions): Promise<boolean> {
    // `false` here means "not found", which is the same lie the read path told.
    this.assertBackendAvailable(`delete task ${taskId}`);
    const prefix = this.parsePrefixFromId(taskId);
    const backend = this.getBackendByPrefix(prefix);

    // Primary route: attempt deletion via routed backend when available
    if (backend) {
      const deleted = await backend.deleteTask(taskId, options);
      if (deleted) {
        return true;
      }
      // Fall through to fallback search if primary backend reported not deleted
    }

    // Fallback: locate the task on any registered backend and delete there
    // This handles cases where IDs are qualified with a prefix whose backend
    // is unavailable, or where the task is stored under a different backend
    // but shares the same local identifier.
    for (const b of this.backends) {
      try {
        const found = await b.getTask(taskId);
        if (found) {
          const deleted = await b.deleteTask(taskId, options);
          if (deleted) return true;
        }
      } catch (_err) {
        // Ignore and continue trying other backends
      }
    }

    // If nothing deleted, return false to allow caller to format a failure
    return false;
  }

  // ---- TaskServiceInterface Required Methods ----

  async getTaskStatus(id: string): Promise<string | undefined> {
    // 1. Dedicated status read on the routed backend (single source of truth
    //    when available). Avoids early-returning from `backend.getTask`, which
    //    could surface backend-internal caches.
    let backend: TaskBackend;
    try {
      backend = this.routeToBackend(id);
    } catch {
      // routeToBackend threw (no prefix routes, no default backend); fall
      // through to the cross-backend aggregated search below rather than
      // throwing — preserves previous tolerance during boot / partial wiring.
      const bootTask = await this.getTask(id);
      return typeof bootTask?.status !== "undefined" ? bootTask.status : undefined;
    }

    // mt#4457: these reads are deliberately NOT wrapped in a catch.
    //
    // They used to be. The stated reason was tolerance for partial-implementation
    // mocks ("backend may not implement getTaskStatus directly"), but a bare catch
    // cannot distinguish that from a database read that FAILED — so under lock
    // contention a failing read silently degraded to the list-scan and then to the
    // cross-backend aggregate, returning a plausible value instead of an error.
    // A caller cannot tell such a value from a healthy read, which is the same
    // class of defect as the write path's false success.
    //
    // The capability check below buys the mock tolerance precisely, without
    // swallowing anything: an unimplemented method is answered by asking whether
    // it exists, and a read that exists and throws now propagates.
    if (typeof backend.getTaskStatus === "function") {
      const status = await backend.getTaskStatus(id);
      if (typeof status !== "undefined") return status;
    }

    // 1b. Backend list-scan fallback for partial-implementation mocks where
    //     getTaskStatus is unimplemented but listTasks populates rows.
    //
    // The narrowing here is INTENTIONAL (PR #3342 R1, non-blocking). The old
    // `catch` also absorbed a THROWING `listTasks`, not just a missing one. That
    // tolerance is deliberately not restored: a list read that fails is a failed
    // read, and converting it into "no status" is the same defect as the one
    // above it. The capability check preserves the tolerance that was actually
    // needed — a backend that does not implement the method.
    if (typeof backend.listTasks === "function") {
      const list = await backend.listTasks();
      const found = list.find((t) => {
        if (t.id === id) return true;
        const taskLocalId = t.id.includes("#") ? t.id.split("#").pop() : t.id;
        const searchLocalId = id.includes("#") ? id.split("#").pop() : id;
        if (taskLocalId === searchLocalId) return true;
        if (!/^#/.test(id) && t.id === `#${id}`) return true;
        if (id.startsWith("#") && t.id === id.substring(1)) return true;
        return false;
      });
      if (found && typeof found.status !== "undefined") return found.status;
    }

    // 2. Cross-backend aggregated search as final fallback. Tolerant of
    //    unqualified IDs that match across backends.
    const task = await this.getTask(id);
    return typeof task?.status !== "undefined" ? task.status : undefined;
  }

  async setTaskStatus(id: string, status: string): Promise<StatusWriteOutcome> {
    const backend = this.routeToBackend(id);
    const outcome = await backend.setTaskStatus(id, status);
    // Ensure cached reads see the updated status in mocked environments.
    // mt#4457: this touch-read stays swallowed deliberately — it is a cache
    // nudge whose result is discarded by design, and it runs AFTER the write
    // whose effect `outcome` already carries. Swallowing here cannot mask the
    // write, which is what the surrounding changes are about.
    try {
      await backend.getTask(id); // touch backend to refresh any caches; ignore result
    } catch (_e) {
      // intentional-swallow: cache-refresh nudge; the write's effect is in `outcome`
    }
    return outcome;
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }

  async createTaskFromTitleAndSpec(
    title: string,
    spec: string,
    options?: CreateTaskOptions
  ): Promise<Task> {
    // Fail closed BEFORE any routing decision (mt#3636, PR #2596 R2). With zero
    // backends the cause is unavailability, not a bad backend name — and the
    // explicit-backend lookup below would otherwise answer "Requested backend
    // 'minsky' is not registered. Available backends: none.", which describes
    // the symptom and hides that the database is unreachable.
    this.assertBackendAvailable("create a task");

    // If the caller requested a specific backend, route there instead of using the
    // configured default.  This is the fix for mt#2572 Bug 4: when the minsky DB
    // backend is down, GitHub becomes the effective defaultBackend, so tasks_create
    // with backend:"minsky" would silently create gh# issues.  Now we look up the
    // requested backend explicitly and throw a clear error if it isn't registered.
    let backend: (typeof this.backends)[number] | null | undefined = this.defaultBackend;

    if (options?.backend) {
      const requestedName = options.backend;
      backend = this.backends.find((b) => b.name === requestedName || b.prefix === requestedName);
      if (!backend) {
        const available = this.backends.map((b) => `${b.name}(${b.prefix}#)`).join(", ");
        throw new Error(
          `Requested backend '${requestedName}' is not registered. ` +
            `Available backends: ${available || "none"}. ` +
            `If you expected '${requestedName}' to be available, check the database ` +
            `connection and backend configuration.`
        );
      }
    }

    if (!backend) {
      // Zero backends is already handled by the guard at the top of this
      // method, so reaching here means backends ARE registered but no default
      // was selected. Unreachable today — `registerBackend` sets
      // `defaultBackend` on the first registration and nothing clears it — so
      // this is a defensive branch only, kept because TS still needs the
      // narrowing. It gets its own message because reusing "No backends
      // registered" here would state something plainly false about a service
      // that has backends (PR #2596 R1).
      const available = this.backends.map((b) => `${b.name}(${b.prefix}#)`).join(", ");
      throw new MultiBackendError(
        `No default task backend is selected, though backends are registered: ${available}. ` +
          "Set tasks.backend in configuration, or pass an explicit backend to this call.",
        "create_task"
      );
    }

    const created = await backend.createTaskFromTitleAndSpec(title, spec, options);
    const qualified = this.qualifyTaskFromBackend(created, backend);
    if (!qualified) {
      throw new Error(`Failed to qualify created task from backend: ${backend.name}`);
    }
    return qualified;
  }

  async getBackendForTask(taskId: string): Promise<string> {
    const prefix = this.parsePrefixFromId(taskId);
    if (prefix) {
      const backend = this.getBackendByPrefix(prefix);
      return backend?.name || "unknown";
    }
    return this.defaultBackend?.name || "default";
  }

  // ---- TaskServiceInterface Required Methods (continued) ----

  async getTaskSpecContent(taskId: string, section?: string): Promise<TaskSpecContentResult> {
    const backend = this.routeToBackend(taskId);

    // Get the task first
    const task = await this.getTask(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Check if backend has a getTaskSpecContent method
    type BackendWithSpecContent = typeof backend & {
      getTaskSpecContent: (id: string, section?: string) => Promise<TaskSpecContentResult>;
    };
    if ((backend as BackendWithSpecContent).getTaskSpecContent) {
      return await (backend as BackendWithSpecContent).getTaskSpecContent(taskId, section);
    }

    // Fallback: return empty content — spec is stored in the backend, not on disk.
    //
    // No `specUpdatedAt`: a backend that does not implement getTaskSpecContent
    // tracks no spec-content timestamp, and `task.updatedAt` is NOT a stand-in
    // (mt#4415 — any status change bumps it). Absent is the honest answer, and
    // callers must surface it as "not checked" rather than as a clean result.
    return {
      task,
      specPath: "",
      content: task.spec || "",
      section,
    };
  }

  // ---- Helper Methods ----

  private routeToBackend(taskId: string): TaskBackend {
    const backend = this.getBackendByPrefix(this.parsePrefixFromId(taskId)) || this.defaultBackend;
    if (!backend) {
      throw new Error(`No backend available for task: ${taskId}`);
    }
    return backend;
  }
}

// Production-ready factory function
export function createTaskService(options: { workspacePath: string }): TaskService {
  return new TaskServiceImpl(options);
}
