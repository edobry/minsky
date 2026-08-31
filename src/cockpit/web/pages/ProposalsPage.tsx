/**
 * ProposalsPage — the EngProd toil-miner proposal digest (/proposals, mt#3331).
 *
 * The operator-facing half of the curation gate (RFC Notion
 * 3ac937f0-3cb4-816e-8af7-e5380f10a24b, Phase 1): each mining run's filed
 * `engprod-proposal` tasks, grouped by the run that produced them, with the
 * evidence block (tool sequence, frequency, sessions, chain length) and
 * inline Accept/Reject actions.
 *
 * Accept unblocks the task into the normal lifecycle (BLOCKED -> TODO) and
 * records `accepted` in the ledger; reject closes the task and records
 * `rejected` + the supplied reason — both writes happen atomically on the
 * server (../../routes/engprod-proposals.ts's `db.transaction()`).
 *
 * Run-level context (turns scanned, clusters found/sent-to-LLM, suppressed
 * breakdown, LLM errors) is ALWAYS visible per run, even for a run with zero
 * proposals — so a healthy quiet run ("nothing found this pass") reads
 * distinctly from an errored one (spec SC3 / AT2).
 *
 * Self-fetching via TanStack Query against GET /api/engprod/proposals; all
 * grouping/ranking/disposition derivation is pure (`../lib/engprod-proposals.ts`,
 * unit-tested there) — this file is fetch-wiring + render only, mirroring
 * the /digest page's split.
 */
import { useState } from "react";
import { InstanceScopeCue } from "../components/InstanceScopeCue";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../components/ui/dialog";
import { LoadingState } from "../components/LoadingState";
import { ErrorState } from "../components/ErrorState";
import { entityToPath } from "../lib/entity-codec";
import { cn } from "../lib/utils";
import { formatRelative } from "../widgets/AskDetail";
import {
  fetchEngprodProposals,
  acceptProposal,
  rejectProposal,
  groupProposalsByRun,
  deriveDisposition,
  runEmptyState,
  type EngprodProposalsResponse,
  type EngprodProposalRow,
  type EngprodRunGroup,
  type EngprodRunSummary,
} from "../lib/engprod-proposals";

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function useProposalActions() {
  const queryClient = useQueryClient();
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null);
  const [errorsByTaskId, setErrorsByTaskId] = useState<Record<string, string>>({});

  const settle = (taskId: string) => {
    setPendingTaskId(null);
    void queryClient.invalidateQueries({ queryKey: ["engprod-proposals"] });
    return taskId;
  };

  const clearError = (taskId: string) =>
    setErrorsByTaskId((prev) => {
      if (!(taskId in prev)) return prev;
      const next = { ...prev };
      delete next[taskId];
      return next;
    });

  const acceptMutation = useMutation({
    mutationFn: (taskId: string) => acceptProposal(taskId),
    onMutate: (taskId) => {
      setPendingTaskId(taskId);
      clearError(taskId);
    },
    onError: (err, taskId) => {
      setErrorsByTaskId((prev) => ({
        ...prev,
        [taskId]: err instanceof Error ? err.message : "Accept failed.",
      }));
    },
    onSettled: (_data, _err, taskId) => settle(taskId),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ taskId, reason }: { taskId: string; reason: string }) =>
      rejectProposal(taskId, reason),
    onMutate: ({ taskId }) => {
      setPendingTaskId(taskId);
      clearError(taskId);
    },
    onError: (err, { taskId }) => {
      setErrorsByTaskId((prev) => ({
        ...prev,
        [taskId]: err instanceof Error ? err.message : "Reject failed.",
      }));
    },
    onSettled: (_data, _err, { taskId }) => settle(taskId),
  });

  return { acceptMutation, rejectMutation, pendingTaskId, errorsByTaskId };
}

type ProposalActions = ReturnType<typeof useProposalActions>;

// ---------------------------------------------------------------------------
// Reject dialog — free-text reason required (spec requirement #4)
// ---------------------------------------------------------------------------

interface RejectTarget {
  taskId: string;
  title: string;
}

/**
 * The actual form body, keyed by `target.taskId` from the parent (below) so
 * React remounts it — and therefore resets the `reason` draft — whenever a
 * different row opens the dialog, without an effect.
 */
function RejectDialogBody({
  target,
  onClose,
  onConfirm,
  pending,
}: {
  target: RejectTarget;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  pending: boolean;
}) {
  const [reason, setReason] = useState("");

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Reject proposal</DialogTitle>
        <DialogDescription>
          {target.taskId} — {target.title}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2">
        <label htmlFor="reject-reason" className="text-sm font-medium text-foreground">
          Reason
        </label>
        <Textarea
          id="reject-reason"
          placeholder="Why is this proposal being rejected? (required — read by the re-surface threshold's audit trail)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          autoFocus
        />
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={pending || reason.trim().length === 0}
          onClick={() => onConfirm(reason.trim())}
        >
          {pending ? "Rejecting…" : "Reject"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

function RejectDialog({
  target,
  onClose,
  onConfirm,
  pending,
}: {
  target: RejectTarget | null;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  pending: boolean;
}) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {target && (
        <RejectDialogBody
          key={target.taskId}
          target={target}
          onClose={onClose}
          onConfirm={onConfirm}
          pending={pending}
        />
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Run header — counters + healthy-empty/errored distinction (AT2)
// ---------------------------------------------------------------------------

function Stat({ label, value }: { label: string; value: number }) {
  if (value === 0) return null;
  return (
    <span className="text-xs text-muted-foreground tabular-nums">
      {value.toLocaleString()} {label}
    </span>
  );
}

function RunHeader({ run }: { run: EngprodRunSummary }) {
  const empty = runEmptyState(run);
  return (
    <div className="flex flex-col gap-1 border-b border-border/60 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground" title={run.id}>
          run {run.id.slice(0, 8)}
        </span>
        <span className="text-xs text-muted-foreground">{formatRelative(run.startedAt)}</span>
        {run.errored && (
          <span className="flex items-center gap-1 rounded-full bg-warn-red/40 px-1.5 py-0.5 text-xs font-medium text-foreground">
            <AlertTriangle aria-hidden className="h-3 w-3" />
            errored
          </span>
        )}
        {empty === "healthy-empty" && (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
            nothing found this run
          </span>
        )}
        {empty === "errored" && !run.errored && (
          <span className="flex items-center gap-1 rounded-full bg-warn-red/40 px-1.5 py-0.5 text-xs font-medium text-foreground">
            <AlertTriangle aria-hidden className="h-3 w-3" />
            {run.llmErrors} LLM error{run.llmErrors === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <Stat label="turns scanned" value={run.turnsScanned} />
        <Stat label="clusters found" value={run.clustersFound} />
        <Stat label="sent to LLM" value={run.clustersSentToLlm} />
        <Stat label="proposed" value={run.proposalsGenerated} />
        <Stat label="suppressed (dedupe)" value={run.suppressedByDedupe} />
        <Stat label="suppressed (budget)" value={run.suppressedByBudget} />
        <Stat label="suppressed (collapsed)" value={run.suppressedByMaximalCollapse} />
        <Stat label="suppressed (low-distinctiveness)" value={run.suppressedByLowDistinctiveness} />
      </div>
    </div>
  );
}

function UnassignedRunHeader({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
      <AlertTriangle aria-hidden className="h-3.5 w-3.5 text-warn-amber" />
      <span className="text-sm font-medium text-foreground">No matching run record</span>
      <span className="text-xs text-muted-foreground">
        {count} proposal{count === 1 ? "" : "s"} filed by a run with no surviving
        `engprod_miner_runs` row (e.g. an interrupted tick) — evidence below is still accurate.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One proposal row
// ---------------------------------------------------------------------------

function ProposalRow({
  proposal,
  rank,
  actions,
  onRequestReject,
}: {
  proposal: EngprodProposalRow;
  rank: number;
  actions: ProposalActions;
  onRequestReject: (target: RejectTarget) => void;
}) {
  const disposition = deriveDisposition(proposal.status);
  const pending = actions.pendingTaskId === proposal.taskId;
  const rowError = actions.errorsByTaskId[proposal.taskId];

  return (
    <div
      className={cn(
        "flex flex-col gap-1 border-b border-border/40 px-3 py-2 last:border-b-0",
        pending && "opacity-50 pointer-events-none"
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-6 flex-shrink-0 text-right text-xs tabular-nums text-muted-foreground">
          #{rank}
        </span>
        <Link
          to={entityToPath("task", proposal.taskId)}
          className="font-mono text-sm text-foreground hover:text-signal-cyan transition-colors"
        >
          {proposal.taskId}
        </Link>
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {proposal.title}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {disposition === "pending" && (
            <>
              <Button
                size="sm"
                variant="default"
                className="h-6 px-2 text-xs"
                disabled={pending}
                aria-label={`Accept ${proposal.taskId}`}
                onClick={() => actions.acceptMutation.mutate(proposal.taskId)}
              >
                Accept
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="h-6 px-2 text-xs"
                disabled={pending}
                aria-label={`Reject ${proposal.taskId}`}
                onClick={() => onRequestReject({ taskId: proposal.taskId, title: proposal.title })}
              >
                Reject
              </Button>
            </>
          )}
          {disposition === "accepted" && (
            <span className="flex items-center gap-1 text-xs text-liveness-healthy">
              <CheckCircle2 aria-hidden className="h-3.5 w-3.5" />
              accepted
            </span>
          )}
          {disposition === "rejected" && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <XCircle aria-hidden className="h-3.5 w-3.5" />
              rejected
            </span>
          )}
        </span>
      </div>

      <div className="pl-8 font-mono text-xs text-muted-foreground truncate">
        {proposal.toolSequence.join(" -> ") || "(no tool sequence recorded)"}
      </div>

      <div className="pl-8 flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
        <span>{proposal.evidenceFrequency.toLocaleString()}x</span>
        <span>{proposal.evidenceSessions.toLocaleString()} sessions</span>
        <span>chain length {proposal.evidenceChainLength}</span>
      </div>

      {disposition === "rejected" && proposal.rejectionReason && (
        <div className="pl-8 text-xs text-muted-foreground italic">
          "{proposal.rejectionReason}"
        </div>
      )}

      {rowError && (
        <div className="pl-8 text-xs text-warn-red" role="alert">
          {rowError}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A run group section
// ---------------------------------------------------------------------------

function RunSection({
  group,
  actions,
  onRequestReject,
}: {
  group: EngprodRunGroup;
  actions: ProposalActions;
  onRequestReject: (target: RejectTarget) => void;
}) {
  return (
    <div className="rounded-md border border-border bg-card/50" data-testid="engprod-run-group">
      {group.run ? (
        <RunHeader run={group.run} />
      ) : (
        <UnassignedRunHeader count={group.proposals.length} />
      )}
      {group.proposals.length > 0 && (
        <div className="flex flex-col">
          {group.proposals.map((p, i) => (
            <ProposalRow
              key={p.taskId}
              proposal={p}
              rank={i + 1}
              actions={actions}
              onRequestReject={onRequestReject}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function ProposalsPage() {
  const actions = useProposalActions();
  const [rejectTarget, setRejectTarget] = useState<RejectTarget | null>(null);

  const query = useQuery<EngprodProposalsResponse, Error>({
    queryKey: ["engprod-proposals"],
    queryFn: fetchEngprodProposals,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  if (query.isLoading) {
    return (
      <div className="p-4 max-w-5xl mx-auto w-full">
        <LoadingState message="Loading proposals…" variant="page" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="p-4 max-w-5xl mx-auto w-full">
        <ErrorState prefix="Failed to load EngProd proposals" error={query.error} />
      </div>
    );
  }

  const { runs, proposals } = query.data ?? { runs: [], proposals: [] };
  const groups = groupProposalsByRun(runs, proposals);
  const pendingCount = proposals.filter((p) => deriveDisposition(p.status) === "pending").length;

  return (
    <div className="p-4 max-w-5xl mx-auto w-full space-y-3">
      <div className="flex items-center gap-2">
        <h1 className="text-h1 font-semibold text-foreground">Proposals</h1>
        <span className="text-sm font-normal text-muted-foreground">
          {pendingCount} pending · {proposals.length} total · {runs.length} run
          {runs.length === 1 ? "" : "s"}
        </span>
      </div>
      {/* Deliberately global (mt#4727 census: Minsky's own eng-process
          tooling); say so while a project filter is active (mt#4773). */}
      <InstanceScopeCue />

      {groups.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm font-medium text-foreground">No miner runs recorded</p>
          <p className="mt-1 text-xs text-muted-foreground">
            The EngProd toil miner hasn't run yet, or the ops loop is disabled.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {groups.map((group) => (
            <RunSection
              key={group.run?.id ?? "unassigned"}
              group={group}
              actions={actions}
              onRequestReject={setRejectTarget}
            />
          ))}
        </div>
      )}

      <RejectDialog
        target={rejectTarget}
        pending={actions.rejectMutation.isPending}
        onClose={() => setRejectTarget(null)}
        onConfirm={(reason) => {
          if (!rejectTarget) return;
          actions.rejectMutation.mutate(
            { taskId: rejectTarget.taskId, reason },
            { onSuccess: () => setRejectTarget(null) }
          );
        }}
      />
    </div>
  );
}
