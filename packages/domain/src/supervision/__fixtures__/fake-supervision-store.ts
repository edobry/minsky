/**
 * In-memory {@link SupervisionStore} plus a fake task graph, for exercising the
 * supervisor tick without a database or a real `claude` child (mt#4571).
 *
 * The tick's whole job is a DAG walk — dispatch what is unblocked, hold at the
 * WIP limit, advance when a prerequisite completes — and that behaviour is what
 * has to be right. Spawning genuine child processes to test it would make the
 * tests slow, flaky and unable to assert the interesting states at all, so the
 * three actuators are injected. The REAL binding of those actuators is verified
 * separately by `scripts/verify-task-supervision.ts` (`/implement-task` §7a).
 */
import type {
  DispatchChildInput,
  DispatchChildResult,
  DispatchView,
  DrivenSessionLiveness,
  SettledBy,
  SupervisionDispatchStatus,
  SupervisionStatus,
  SupervisionStore,
  SupervisionView,
} from "../types";

export interface FakeTask {
  id: string;
  title: string;
  status: string;
  /** Parent umbrella id, if any. */
  parent?: string;
  /** Task ids this task depends on. */
  dependsOn?: string[];
}

/**
 * A fake task graph the frontier computation reads. Mutate `tasks` between
 * ticks to simulate a child completing.
 */
export class FakeTaskGraph {
  readonly tasks = new Map<string, FakeTask>();

  constructor(tasks: FakeTask[]) {
    for (const t of tasks) this.tasks.set(t.id, { ...t });
  }

  setStatus(taskId: string, status: string): void {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`FakeTaskGraph: no such task ${taskId}`);
    task.status = status;
  }

  listChildren = async (parentTaskId: string): Promise<string[]> =>
    [...this.tasks.values()].filter((t) => t.parent === parentTaskId).map((t) => t.id);

  getDependsRelationships = async (
    taskIds: string[]
  ): Promise<Array<{ fromTaskId: string; toTaskId: string }>> => {
    const wanted = new Set(taskIds);
    const out: Array<{ fromTaskId: string; toTaskId: string }> = [];
    for (const task of this.tasks.values()) {
      if (!wanted.has(task.id)) continue;
      for (const dep of task.dependsOn ?? []) out.push({ fromTaskId: task.id, toTaskId: dep });
    }
    return out;
  };

  getTasks = async (
    taskIds: string[]
  ): Promise<Array<{ id: string; title?: string; status?: string }>> => {
    const out: Array<{ id: string; title?: string; status?: string }> = [];
    for (const id of taskIds) {
      const task = this.tasks.get(id);
      if (task) out.push({ id: task.id, title: task.title, status: task.status });
    }
    return out;
  };

  getTaskStatuses = async (taskIds: string[]): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    for (const id of taskIds) {
      const task = this.tasks.get(id);
      if (task) out.set(id, task.status);
    }
    return out;
  };
}

interface StoredSupervision extends SupervisionView {
  lastError: string | null;
}

interface StoredDispatch extends DispatchView {
  settledBy: SettledBy | null;
  lastError: string | null;
  settledAt: Date | null;
}

export class FakeSupervisionStore implements SupervisionStore {
  readonly supervisions = new Map<string, StoredSupervision>();
  readonly dispatches: StoredDispatch[] = [];
  readonly mergedEvents: Array<{ taskId: string; at: Date }> = [];

  /** Set to a supervision id to simulate another actuator holding its lock. */
  lockedElsewhere: string | null = null;

  private seq = 0;

  addSupervision(input: {
    id?: string;
    umbrellaTaskId: string;
    statusFilter?: string[];
    wipLimit?: number;
    model?: string | null;
    status?: SupervisionStatus;
  }): SupervisionView {
    const record: StoredSupervision = {
      id: input.id ?? `sup-${++this.seq}`,
      umbrellaTaskId: input.umbrellaTaskId,
      status: input.status ?? "active",
      statusFilter: input.statusFilter ?? ["TODO", "READY"],
      wipLimit: input.wipLimit ?? 4,
      model: input.model ?? null,
      eventsWatermark: null,
      lastTickAt: null,
      lastAdvanceAt: null,
      lastHoldReason: null,
      lastError: null,
    };
    this.supervisions.set(record.id, record);
    return record;
  }

  listActiveSupervisions = async (): Promise<SupervisionView[]> =>
    [...this.supervisions.values()].filter((s) => s.status === "active").map((s) => ({ ...s }));

  withSupervisionLock = async <T>(
    supervisionId: string,
    fn: () => Promise<T>
  ): Promise<T | null> => {
    if (this.lockedElsewhere === supervisionId) return null;
    return await fn();
  };

  listInFlightDispatches = async (supervisionId: string): Promise<DispatchView[]> =>
    this.dispatches
      .filter((d) => d.supervisionId === supervisionId && d.status === "dispatched")
      .map((d) => ({ ...d }));

  listDispatchedTaskIds = async (supervisionId: string): Promise<Set<string>> =>
    new Set(this.dispatches.filter((d) => d.supervisionId === supervisionId).map((d) => d.taskId));

  listMergedSince = async (
    since: Date | null,
    limit: number
  ): Promise<Array<{ taskId: string; at: Date }>> =>
    this.mergedEvents
      .filter((e) => since === null || e.at >= since)
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .slice(0, limit);

  recordDispatch = async (input: {
    supervisionId: string;
    taskId: string;
    drivenSessionLocalId: string;
    minskySessionId: string | null;
  }): Promise<void> => {
    // Mirrors the real ON CONFLICT DO NOTHING against
    // uq_task_supervision_dispatches_supervision_task.
    const exists = this.dispatches.some(
      (d) => d.supervisionId === input.supervisionId && d.taskId === input.taskId
    );
    if (exists) return;
    this.dispatches.push({
      id: `dispatch-${++this.seq}`,
      supervisionId: input.supervisionId,
      taskId: input.taskId,
      status: "dispatched",
      drivenSessionLocalId: input.drivenSessionLocalId,
      minskySessionId: input.minskySessionId,
      dispatchedAt: new Date(),
      settledBy: null,
      lastError: null,
      settledAt: null,
    });
  };

  settleDispatch = async (input: {
    dispatchId: string;
    status: SupervisionDispatchStatus;
    settledBy: SettledBy;
    lastError: string | null;
    at: Date;
  }): Promise<void> => {
    const row = this.dispatches.find((d) => d.id === input.dispatchId);
    // Status-guarded like the real UPDATE: only an in-flight row settles.
    if (!row || row.status !== "dispatched") return;
    row.status = input.status;
    row.settledBy = input.settledBy;
    row.lastError = input.lastError;
    row.settledAt = input.at;
  };

  updateSupervision = async (input: {
    supervisionId: string;
    status?: SupervisionStatus;
    eventsWatermark?: Date | null;
    lastTickAt?: Date;
    lastAdvanceAt?: Date;
    lastHoldReason?: string | null;
    lastError?: string | null;
  }): Promise<void> => {
    const row = this.supervisions.get(input.supervisionId);
    if (!row) return;
    if (input.status !== undefined) row.status = input.status;
    if (input.eventsWatermark !== undefined) row.eventsWatermark = input.eventsWatermark;
    if (input.lastTickAt !== undefined) row.lastTickAt = input.lastTickAt;
    if (input.lastAdvanceAt !== undefined) row.lastAdvanceAt = input.lastAdvanceAt;
    if (input.lastHoldReason !== undefined) row.lastHoldReason = input.lastHoldReason;
    if (input.lastError !== undefined) row.lastError = input.lastError;
  };
}

/** Records every spawn request and hands back synthetic session identifiers. */
export class FakeSpawner {
  readonly calls: DispatchChildInput[] = [];
  /** Task ids whose dispatch should throw, simulating a spawn failure. */
  failFor = new Set<string>();
  private seq = 0;
  /** Liveness reported per driven-session local id. Default "live". */
  readonly liveness = new Map<string, DrivenSessionLiveness>();

  dispatchChild = async (input: DispatchChildInput): Promise<DispatchChildResult> => {
    this.calls.push(input);
    if (this.failFor.has(input.taskId)) {
      throw new Error(`spawn refused for ${input.taskId}`);
    }
    const localId = `driven-${++this.seq}`;
    this.liveness.set(localId, "live");
    return { drivenSessionLocalId: localId, minskySessionId: `ws-${localId}` };
  };

  drivenSessionLiveness = (localId: string): DrivenSessionLiveness =>
    this.liveness.get(localId) ?? "unknown";

  /** The local id handed out for a task, or undefined if it was never dispatched. */
  localIdFor(taskId: string): string | undefined {
    const index = this.calls.findIndex((c) => c.taskId === taskId);
    return index === -1 ? undefined : `driven-${index + 1}`;
  }
}
