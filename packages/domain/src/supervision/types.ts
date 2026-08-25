/**
 * Shapes the unattended task supervisor reads and writes (mt#4571).
 *
 * Separated from the tick itself so the sweeper's production wiring, the store,
 * the read-surface commands and the tests all name one set of types.
 *
 * @see ./supervision-tick.ts — the tick that consumes these
 * @see ../storage/schemas/task-supervisions-schema.ts — their durable form
 */
import type {
  SupervisionDispatchStatus,
  SupervisionStatus,
} from "../storage/schemas/task-supervisions-schema";
import type { UmbrellaFrontier } from "../tasks/umbrella-frontier";

export type { SupervisionDispatchStatus, SupervisionStatus };

/** A supervision as the tick needs it — the durable row, statusFilter parsed. */
export interface SupervisionView {
  id: string;
  umbrellaTaskId: string;
  status: SupervisionStatus;
  statusFilter: string[];
  wipLimit: number;
  model: string | null;
  eventsWatermark: Date | null;
  lastTickAt: Date | null;
  lastAdvanceAt: Date | null;
  lastHoldReason: string | null;
}

/** One child the supervisor started. */
export interface DispatchView {
  id: string;
  supervisionId: string;
  taskId: string;
  status: SupervisionDispatchStatus;
  drivenSessionLocalId: string | null;
  minskySessionId: string | null;
  dispatchedAt: Date;
}

/**
 * What the daemon knows about a driven session's process right now.
 *
 * `unknown` is a first-class value, not an error: a daemon that restarted has
 * no in-memory record of a session it started before the restart, and treating
 * that as "exited" would strand every dispatch across every restart — the exact
 * failure this feature exists to survive.
 */
export type DrivenSessionLiveness = "live" | "exited" | "crashed" | "unknown";

export interface DispatchChildInput {
  taskId: string;
  /** Dispatch model alias, or null for the binary's own default. */
  model: string | null;
  /** The umbrella this child belongs to — carried into the child's prompt. */
  umbrellaTaskId: string;
}

export interface DispatchChildResult {
  drivenSessionLocalId: string;
  minskySessionId: string | null;
}

/** Which signal settled a dispatch. Recorded so a reader can tell them apart. */
export type SettledBy = "pr.merged" | "task-status" | "session-exit";

/**
 * Every durable read and write the tick performs, as one interface.
 *
 * The tick takes this rather than a database handle so its DAG-walking
 * behaviour — dispatch what is unblocked, hold at the WIP limit, advance when a
 * prerequisite completes — is exercisable against an in-memory fake
 * (`/implement-task` §6 testable-design checkpoint). The real implementation is
 * `./supervision-store.ts`.
 */
export interface SupervisionStore {
  listActiveSupervisions(): Promise<SupervisionView[]>;

  /**
   * Run `fn` while holding the single-actuator lock for this supervision,
   * resolving `null` without running it when the lock is already held.
   *
   * mt#4571 SC6: the governing RFC records from a live two-writer test that
   * `claude --resume` does lock-free last-writer-appends with zero multi-writer
   * safety. Two daemons ticking the same supervision would each read the same
   * frontier and each spawn a child for it, so the exclusion has to be
   * cross-process — an in-process mutex cannot see the other daemon.
   */
  withSupervisionLock<T>(supervisionId: string, fn: () => Promise<T>): Promise<T | null>;

  /** Dispatch rows for a supervision whose status still occupies a WIP slot. */
  listInFlightDispatches(supervisionId: string): Promise<DispatchView[]>;

  /**
   * Every task id this supervision has EVER dispatched, in any state.
   *
   * Deliberately not just the in-flight set: a child that failed must not be
   * re-dispatched on the next tick. An automatic retry loop would burn a WIP
   * slot indefinitely on work that needs a human to look at it, and mt#4571 SC10
   * asks for a visible record of the failure, not a silent retry.
   */
  listDispatchedTaskIds(supervisionId: string): Promise<Set<string>>;

  /**
   * `pr.merged` events at or after `since`, ascending, capped at `limit`.
   *
   * Returns `{ taskId, at }` for rows carrying a related task id. A cap means a
   * very busy window can leave events unread; that is survivable precisely
   * because the graph reconciliation in the same tick settles the same
   * dispatches from task status independently — the sweeper-over-queue backstop
   * from `decision-defaults.mdc §Reliability`.
   */
  listMergedSince(since: Date | null, limit: number): Promise<Array<{ taskId: string; at: Date }>>;

  recordDispatch(input: {
    supervisionId: string;
    taskId: string;
    drivenSessionLocalId: string;
    minskySessionId: string | null;
  }): Promise<void>;

  settleDispatch(input: {
    dispatchId: string;
    status: SupervisionDispatchStatus;
    settledBy: SettledBy;
    lastError: string | null;
    at: Date;
  }): Promise<void>;

  updateSupervision(input: {
    supervisionId: string;
    status?: SupervisionStatus;
    eventsWatermark?: Date | null;
    lastTickAt?: Date;
    lastAdvanceAt?: Date;
    lastHoldReason?: string | null;
    lastError?: string | null;
  }): Promise<void>;
}

/** The non-durable collaborators the tick needs. */
export interface SupervisionTickDeps {
  store: SupervisionStore;
  /** The shared frontier computation, bound to the real graph. */
  computeFrontier(
    umbrellaTaskId: string,
    statusFilter: readonly string[]
  ): Promise<UmbrellaFrontier>;
  /** Current status of each task id, absent when it could not be read. */
  getTaskStatuses(taskIds: string[]): Promise<Map<string, string>>;
  /** What the daemon knows about a driven session's process. */
  drivenSessionLiveness(localId: string): DrivenSessionLiveness;
  /** Spawn a `claude` child on a task and hand it its prompt. */
  dispatchChild(input: DispatchChildInput): Promise<DispatchChildResult>;
  now(): Date;
  logWarn(message: string): void;
}

/** What one supervision's tick did — reported up for logging and health. */
export interface SupervisionAdvance {
  supervisionId: string;
  umbrellaTaskId: string;
  /** Null when another actuator held the lock and this tick did nothing. */
  lockAcquired: boolean;
  dispatched: string[];
  settled: Array<{ taskId: string; status: SupervisionDispatchStatus; settledBy: SettledBy }>;
  holdReason: string | null;
  completed: boolean;
  error: string | null;
}

/** Aggregate result of one sweeper tick across every active supervision. */
export interface SupervisionTickResult {
  supervisionsConsidered: number;
  advances: SupervisionAdvance[];
  /** False when at least one supervision's tick threw. */
  ok: boolean;
}
