/**
 * MemoryDetail content (mt#2150; re-framed mt#2410).
 *
 * Originally a fixed slide-in drawer over MemoriesPage; mt#2410 retired the
 * overlay in favor of the URL-addressable entity-tab pattern — MemoryPage
 * (/memory/:id) hosts MemoryDetailBody, and lineage/similar navigation is
 * URL navigation supplied by the host via `onNavigate`.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { fetchWidgetData, type WidgetData } from "../lib/widget-client";
import { useOptionalProject, projectLabelById } from "../lib/project-context";
import { cn } from "../lib/utils";
import { Prose } from "../components/Prose";
import { EntityRef } from "../components/EntityRef";
import { useEntityIndex } from "../lib/use-entity-index";
import type { MemoryRecord, MemoryType, MemoryScope } from "@minsky/domain/memory/types";
import type { AssociationType } from "@minsky/domain/memory/associations";
import type { RoutableEntityType } from "../lib/entity-codec";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Textarea } from "../components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  useUpdateMemory,
  useSupersedeMemory,
  useDeleteMemory,
  type MemorySupersedeInput,
} from "../lib/memory-mutations";

/**
 * ADR-012's association vocabulary, declared LOCALLY rather than imported
 * from `@minsky/domain/memory/associations` at runtime: that module is
 * flagged by `custom/no-node-import-in-cockpit-web` (mt#3239) as reaching a
 * Node-only dependency transitively, so only its TYPE (`AssociationType`,
 * above) can cross into the browser bundle. This mirrors the same
 * declared-locally convention `MemoriesList.tsx` already uses for
 * server-only widget payload shapes — see that file's own docblock.
 *
 * ADR-012 fixes the canonical target-ID form per association type (tasks
 * `mt#NNNN`, PRs `PR#NNNN`, sessions a full UUID, rules a filename, skills a
 * bare name); the mt#4763 gate verdict (p) requires rendering each type
 * through the EXISTING `minsky://` entity codec using that declared form
 * rather than inventing a display mapping. Only the codec's own routable
 * types can become a real link — `rule`/`skill`/`transcript` have no cockpit
 * detail route (`entity-codec.ts`'s `ROUTABLE_ENTITY_TYPES`), so those stay
 * plain monospace text below, same as an unknown association key.
 */
const ASSOCIATION_ROUTABLE_KIND: Partial<Record<AssociationType, RoutableEntityType>> = {
  tracksTask: "task",
  relatedTask: "task",
  informsAsk: "ask",
  extractedFromSession: "session",
  citedInReview: "changeset",
  // originatesRule / originatesSkill / extractedFromTranscript have no
  // routable cockpit entity type — omitted, so they fall through to plain
  // monospace rendering below.
};

function isKnownAssociationType(key: string): key is AssociationType {
  return Object.hasOwn(ASSOCIATION_ROUTABLE_KIND, key) || key in ASSOCIATION_SEMANTICS;
}

/** Hover text only (`dt`'s `title`) — the full ADR-012 semantics table, duplicated locally for the same reason as above. */
const ASSOCIATION_SEMANTICS: Partial<Record<AssociationType, string>> = {
  tracksTask: "This memory is a bridge that retires when the named task ships",
  relatedTask: "This memory is related to (but not bridged on) the named task",
  originatesRule: "This memory originated the named rule file",
  originatesSkill: "This memory originated the named skill",
  informsAsk: "This memory was cited as evidence for the named ask",
  extractedFromSession: "This memory was extracted from the named session",
  extractedFromTranscript: "This memory was extracted from a specific transcript turn",
  citedInReview: "This memory was cited in a PR review",
};

/** ADR-012's PR target form is `PR#NNNN`; the changeset route id is the bare number. */
function prAssociationToChangesetId(value: string): string {
  return value.startsWith("PR#") ? value.slice("PR#".length) : value;
}

/**
 * A TAG that is itself an entity reference (mt#4763 PR #3500 R2 BLOCKING).
 *
 * Criterion 7 (tags navigate to the filtered `/memories` view) and
 * criterion 8 (`mt#NNNN` tags render as task deeplinks) name opposite
 * destinations for the SAME tag shape — resolved by SURFACE: on the
 * detail page, an entity-shaped tag is treated as a reference and wins
 * over the general filter-link rendering; on the list page (`MemoriesList.tsx`,
 * unaffected by this fix) every tag stays a filter, because a reader
 * scanning a table wants to narrow it, not jump away from it.
 *
 * `mt#NNNN` is confirmed common in the corpus (2,251 memories carry one).
 * `PR#NNNN` is ADR-012's declared canonical form for `citedInReview` and is
 * confirmed present, if rare (exactly one memory: `PR#3000`) — checked live
 * rather than assumed, per the instruction not to build for a shape the
 * corpus doesn't carry. A `.mdc` rule-filename shape was also checked and
 * found absent (0 hits) and is not implemented.
 */
function entityReferenceTag(tag: string): { type: RoutableEntityType; id: string } | null {
  if (/^mt#\d+$/.test(tag)) return { type: "task", id: tag };
  if (/^PR#\d+$/.test(tag)) return { type: "changeset", id: prAssociationToChangesetId(tag) };
  return null;
}

interface MemorySearchResult {
  record: MemoryRecord;
  score: number;
}

export interface MemoriesDetailPayload {
  record: MemoryRecord;
  lineage: MemoryRecord[];
  lineageTruncated: boolean;
  similar: MemorySearchResult[];
}

const TYPE_BADGE: Record<MemoryType, string> = {
  user: "bg-primary/20 text-primary",
  feedback: "bg-amber-500/20 text-amber-500",
  project: "bg-emerald-500/20 text-emerald-500",
  reference: "bg-muted text-muted-foreground",
};

/**
 * Declared LOCALLY rather than importing `MEMORY_TYPES`/`MEMORY_SCOPES` as
 * VALUES from `@minsky/domain/memory/types` — same `no-node-import-in-cockpit-web`
 * rationale as `ASSOCIATION_ROUTABLE_KIND` above (a type-only import crosses
 * the boundary; the runtime constant does not). Both enums are small and
 * closed (mirrors `MemoriesList.tsx`'s own local `TYPE_OPTIONS`/`SCOPE_OPTIONS`).
 */
const MEMORY_TYPE_OPTIONS: MemoryType[] = ["user", "feedback", "project", "reference"];
const MEMORY_SCOPE_OPTIONS: MemoryScope[] = ["project", "user", "cross_project"];

function relativeTime(date: Date | string): string {
  const d = date instanceof Date ? date : new Date(date);
  const diffMs = Date.now() - d.getTime();
  if (isNaN(diffMs)) return "—";
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2 py-1 border-b border-border/50 last:border-0 text-xs">
      <dt className="text-muted-foreground flex-shrink-0">{label}</dt>
      <dd className="text-right break-all">{value}</dd>
    </div>
  );
}

export function MemoryDetailContent({
  payload,
  onNavigate,
}: {
  payload: MemoriesDetailPayload;
  onNavigate?: (id: string) => void;
}) {
  const { record, lineage, lineageTruncated, similar } = payload;
  const entityIndex = useEntityIndex();
  // Project shown as slug/displayName, not the raw uuid (mt#4773 SC2). The
  // uuid stays as the last-resort fallback for a project the shell's list
  // does not know — a detail surface should degrade to the identifier it
  // has rather than hide the field. Optional context for the same reason.
  const projectCtx = useOptionalProject();
  const projectLabel = projectLabelById(projectCtx?.projects ?? [], record.projectId ?? null);

  return (
    <div className="space-y-4 overflow-y-auto flex-1">
      {/* Metadata */}
      <section>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Metadata
        </h3>
        <dl className="space-y-0">
          <MetaRow
            label="Type"
            value={
              <span
                className={cn("px-1.5 py-0.5 rounded text-xs capitalize", TYPE_BADGE[record.type])}
              >
                {record.type}
              </span>
            }
          />
          <MetaRow label="Scope" value={record.scope} />
          {record.projectId && (
            <MetaRow
              label="Project"
              value={projectLabel ?? <span className="font-mono">{record.projectId}</span>}
            />
          )}
          <MetaRow label="Created" value={relativeTime(record.createdAt)} />
          <MetaRow label="Updated" value={relativeTime(record.updatedAt)} />
          {record.lastAccessedAt && (
            <MetaRow label="Last accessed" value={relativeTime(record.lastAccessedAt)} />
          )}
          <MetaRow label="Access count" value={record.accessCount} />
          {record.sourceSessionId && (
            <MetaRow
              label="Source session"
              value={
                <EntityRef type="session" id={record.sourceSessionId} className="text-[10px]">
                  {record.sourceSessionId.slice(0, 8)}…
                </EntityRef>
              }
            />
          )}
          {record.supersededBy && (
            <MetaRow
              label="Superseded by"
              value={
                onNavigate ? (
                  <button
                    onClick={() => onNavigate(record.supersededBy!)}
                    className="font-mono text-[10px] text-primary hover:underline"
                  >
                    {record.supersededBy.slice(0, 8)}…
                  </button>
                ) : (
                  <span className="font-mono text-[10px]">{record.supersededBy.slice(0, 8)}…</span>
                )
              }
            />
          )}
        </dl>
      </section>

      {/* Tags — clickable everywhere they render (mt#4763 success criterion),
          EXCEPT an mt#NNNN/PR#NNNN-shaped tag on this page, which is a task
          or PR deeplink per criterion 8 (see `entityReferenceTag` above and
          the spec's criterion 7 amendment). Every other tag navigates to the
          `/memories` facet-filtered view rather than displaying inert text. */}
      {record.tags.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Tags
          </h3>
          <div className="flex flex-wrap gap-1">
            {record.tags.map((tag) => {
              const ref = entityReferenceTag(tag);
              if (ref) {
                return (
                  <EntityRef key={tag} type={ref.type} id={ref.id} className="text-[11px]">
                    {tag}
                  </EntityRef>
                );
              }
              return (
                <Link
                  key={tag}
                  to={`/memories?mem_f_tags=${encodeURIComponent(tag)}`}
                  title={tag}
                  aria-label={`Filter by ${tag}`}
                  className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-[11px] hover:bg-primary/20 hover:text-primary transition-colors"
                >
                  {tag}
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {/* Associations — rendered through the SAME minsky:// entity codec as
          every other cockpit deeplink, per ADR-012's declared target-ID form
          for each association type (mt#4763 gate verdict (p)): tasks and
          asks route on their id directly, PRs route via the changeset
          codec (bare PR number), sessions route on the full UUID. A type
          with no routable target kind (rule/skill/transcript) or an
          unrecognized key renders as plain monospace, same as before. */}
      {Object.keys(record.associations).length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Associations
          </h3>
          <dl>
            {Object.entries(record.associations).map(([type, targets]) => {
              const routableType = isKnownAssociationType(type)
                ? ASSOCIATION_ROUTABLE_KIND[type]
                : undefined;
              const semantics = isKnownAssociationType(type)
                ? ASSOCIATION_SEMANTICS[type]
                : undefined;
              return (
                <div
                  key={type}
                  className="flex items-start gap-2 py-1 border-b border-border/50 last:border-0 text-xs"
                >
                  <dt className="text-muted-foreground flex-shrink-0" title={semantics}>
                    {type}
                  </dt>
                  <dd className="flex flex-wrap gap-1">
                    {targets.map((t) =>
                      routableType ? (
                        <EntityRef
                          key={t}
                          type={routableType}
                          id={routableType === "changeset" ? prAssociationToChangesetId(t) : t}
                          className="text-[10px]"
                        >
                          {t}
                        </EntityRef>
                      ) : (
                        <span
                          key={t}
                          className="font-mono bg-muted px-1 py-0.5 rounded text-[10px]"
                        >
                          {t}
                        </span>
                      )
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      )}

      {/* Content */}
      <section>
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
          Content
        </h3>
        <Prose
          entityIndex={entityIndex}
          className="max-h-64 overflow-y-auto rounded border border-border/50 bg-muted/30 p-3"
        >
          {record.content}
        </Prose>
      </section>

      {/* Lineage */}
      {lineage.length > 0 && (
        <section>
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Supersession Chain
            {lineageTruncated && <span className="ml-1 text-muted-foreground">(truncated)</span>}
          </h3>
          <ol className="space-y-1">
            {lineage.map((rec, idx) => (
              <li key={rec.id} className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground w-4 flex-shrink-0">{idx + 1}.</span>
                {onNavigate ? (
                  <button
                    onClick={() => onNavigate(rec.id)}
                    className={cn(
                      "truncate text-left",
                      rec.id === record.id
                        ? "font-semibold text-foreground"
                        : "text-primary hover:underline"
                    )}
                  >
                    {rec.name}
                  </button>
                ) : (
                  <span className={cn("truncate", rec.id === record.id && "font-semibold")}>
                    {rec.name}
                  </span>
                )}
                <span className="text-muted-foreground flex-shrink-0">
                  {relativeTime(rec.createdAt)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* Similar memories */}
      {similar.length > 0 && (
        // mt#4787: a stable hook for the section whose numbers this task
        // corrected — used by scripts/capture-memories-render.ts to know the
        // list has actually rendered before the shutter, and available to any
        // future test of the orientation.
        <section data-testid="memory-similar">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
            Similar Memories
          </h3>
          <ul className="space-y-1">
            {similar.map(({ record: sim, score }) => (
              <li key={sim.id} className="flex items-center gap-2 text-xs">
                {onNavigate ? (
                  <button
                    onClick={() => onNavigate(sim.id)}
                    className="truncate text-left text-primary hover:underline flex-1 min-w-0"
                  >
                    {sim.name}
                  </button>
                ) : (
                  <span className="truncate flex-1 min-w-0">{sim.name}</span>
                )}
                {/* mt#4787: this expression is UNCHANGED and is now correct.
                    `score` used to be the vector store's raw L2 distance, so
                    the closest match rendered the smallest number; it is now a
                    cosine similarity in [0,1], converted once at the
                    MemoryService boundary. Do not add a `1 - x` here — that
                    would re-invert it, and the two other render sites would
                    then disagree with this one. */}
                <span
                  className="text-muted-foreground flex-shrink-0 tabular-nums"
                  title="Cosine similarity — higher is more similar"
                >
                  {(score * 100).toFixed(0)}%
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Curation actions (mt#4766) — edit tags, edit name/description, supersede,
// delete. Each is a controlled Dialog opened from a small action bar; success
// invalidates the relevant widget queries (`memory-mutations.ts`'s hooks), so
// the detail page and the `/memories` list reflect the change without a
// manual reload.
// ---------------------------------------------------------------------------

function EditTagsDialog({
  record,
  open,
  onOpenChange,
}: {
  record: MemoryRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [value, setValue] = useState(record.tags.join(", "));
  const mutation = useUpdateMemory();

  const close = (next: boolean) => {
    if (!next) mutation.reset();
    onOpenChange(next);
  };

  const save = () => {
    const tags = value
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    mutation.mutate({ id: record.id, fields: { tags } }, { onSuccess: () => close(false) });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit tags</DialogTitle>
          <DialogDescription>
            Comma-separated. Saved via the shared command layer.
          </DialogDescription>
        </DialogHeader>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Tags"
          className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
        />
        {mutation.isError && (
          <p className="text-xs text-destructive" role="alert">
            {mutation.error instanceof Error ? mutation.error.message : "Failed to save tags."}
          </p>
        )}
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={mutation.isPending} onClick={save}>
            {mutation.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditMetaDialog({
  record,
  open,
  onOpenChange,
}: {
  record: MemoryRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [name, setName] = useState(record.name);
  const [description, setDescription] = useState(record.description);
  const mutation = useUpdateMemory();

  const close = (next: boolean) => {
    if (!next) mutation.reset();
    onOpenChange(next);
  };

  const save = () => {
    mutation.mutate(
      { id: record.id, fields: { name, description } },
      { onSuccess: () => close(false) }
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit name / description</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Name"
            className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
          />
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            aria-label="Description"
            rows={3}
          />
        </div>
        {mutation.isError && (
          <p className="text-xs text-destructive" role="alert">
            {mutation.error instanceof Error ? mutation.error.message : "Failed to save."}
          </p>
        )}
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={mutation.isPending || name.trim().length === 0}
            onClick={save}
          >
            {mutation.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SupersedeDialog({
  record,
  open,
  onOpenChange,
  onSuperseded,
}: {
  record: MemoryRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuperseded: (replacementId: string) => void;
}) {
  const [form, setForm] = useState<MemorySupersedeInput>({
    type: record.type,
    name: record.name,
    description: record.description,
    content: record.content,
    scope: record.scope,
    tags: record.tags,
    reason: "",
  });
  const mutation = useSupersedeMemory();

  const close = (next: boolean) => {
    if (!next) mutation.reset();
    onOpenChange(next);
  };

  const save = () => {
    mutation.mutate(
      { oldId: record.id, input: form },
      { onSuccess: ({ replacement }) => onSuperseded(replacement.id) }
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Supersede this memory</DialogTitle>
          <DialogDescription>
            Creates a new record and marks this one superseded. Pre-filled from the current content
            — edit what changed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
          <div className="flex gap-2">
            <Select
              value={form.type}
              onValueChange={(v) => setForm((f) => ({ ...f, type: v as MemoryType }))}
            >
              <SelectTrigger className="h-8 w-32" aria-label="Type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEMORY_TYPE_OPTIONS.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={form.scope}
              onValueChange={(v) => setForm((f) => ({ ...f, scope: v as MemoryScope }))}
            >
              <SelectTrigger className="h-8 w-32" aria-label="Scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MEMORY_SCOPE_OPTIONS.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            aria-label="Name"
            className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
          />
          <input
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            aria-label="Description"
            className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
          />
          <Textarea
            value={form.content}
            onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
            aria-label="Content"
            rows={8}
          />
          <input
            value={(form.tags ?? []).join(", ")}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                tags: e.target.value
                  .split(",")
                  .map((t) => t.trim())
                  .filter((t) => t.length > 0),
              }))
            }
            aria-label="Tags"
            placeholder="Tags (comma-separated)"
            className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
          />
          <input
            value={form.reason ?? ""}
            onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
            aria-label="Reason"
            placeholder="Reason for superseding (recorded on the supersession chain)"
            className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
          />
        </div>
        {mutation.isError && (
          <p className="text-xs text-destructive" role="alert">
            {mutation.error instanceof Error ? mutation.error.message : "Failed to supersede."}
          </p>
        )}
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={
              mutation.isPending ||
              form.name.trim().length === 0 ||
              form.content.trim().length === 0
            }
            onClick={save}
          >
            {mutation.isPending ? "Superseding…" : "Supersede"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  record,
  open,
  onOpenChange,
  onDeleted,
}: {
  record: MemoryRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const mutation = useDeleteMemory();

  const close = (next: boolean) => {
    if (!next) mutation.reset();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this memory?</DialogTitle>
          <DialogDescription>
            {record.shortId ?? record.id.slice(0, 8)} — {record.name}
          </DialogDescription>
        </DialogHeader>
        {/*
          Stated plainly, per the spec's confirm-dialog requirement: this is a
          hard delete (row + best-effort embedding row), and unlike tasks
          there is no short-id tombstone table for memory — a deleted mem#N
          can be reissued to an unrelated future record.
        */}
        <p className="rounded border border-destructive/40 bg-destructive/5 p-3 text-xs">
          This permanently deletes the row and its embedding. There is no undo, and unlike tasks,
          memory has no short-id tombstone table — {record.shortId ?? "this record's short id"} can
          be reissued to a different, unrelated memory in the future.
        </p>
        {mutation.isError && (
          <p className="text-xs text-destructive" role="alert">
            {mutation.error instanceof Error ? mutation.error.message : "Failed to delete."}
          </p>
        )}
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate(record.id, { onSuccess: onDeleted })}
          >
            {mutation.isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type CurationDialog = "tags" | "meta" | "supersede" | "delete" | null;

function MemoryCurationBar({ record }: { record: MemoryRecord }) {
  const navigate = useNavigate();
  const [openDialog, setOpenDialog] = useState<CurationDialog>(null);

  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" onClick={() => setOpenDialog("tags")}>
        Edit tags
      </Button>
      <Button size="sm" variant="outline" onClick={() => setOpenDialog("meta")}>
        Edit name / description
      </Button>
      <Button size="sm" variant="outline" onClick={() => setOpenDialog("supersede")}>
        Supersede
      </Button>
      <Button size="sm" variant="destructive" onClick={() => setOpenDialog("delete")}>
        Delete
      </Button>

      <EditTagsDialog
        record={record}
        open={openDialog === "tags"}
        onOpenChange={(o) => setOpenDialog(o ? "tags" : null)}
      />
      <EditMetaDialog
        record={record}
        open={openDialog === "meta"}
        onOpenChange={(o) => setOpenDialog(o ? "meta" : null)}
      />
      <SupersedeDialog
        record={record}
        open={openDialog === "supersede"}
        onOpenChange={(o) => setOpenDialog(o ? "supersede" : null)}
        onSuperseded={(replacementId) => {
          setOpenDialog(null);
          navigate(`/memory/${encodeURIComponent(replacementId)}`);
        }}
      />
      <DeleteDialog
        record={record}
        open={openDialog === "delete"}
        onOpenChange={(o) => setOpenDialog(o ? "delete" : null)}
        onDeleted={() => {
          setOpenDialog(null);
          navigate("/memories");
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-fetching body (no overlay chrome) — hosted by MemoryPage (/memory/:id)
// ---------------------------------------------------------------------------

export function MemoryDetailBody({
  memoryId,
  onNavigate,
}: {
  memoryId: string;
  onNavigate?: (id: string) => void;
}) {
  const query = useQuery<WidgetData, Error>({
    queryKey: ["widget", "memories-detail", memoryId],
    // Params go through fetchWidgetData's params argument — embedding them in
    // the id segment misses the widget route and returns the SPA fallback (mt#2443).
    queryFn: () => fetchWidgetData("memories-detail", { id: memoryId }),
    staleTime: 30_000,
  });

  if (query.isPending) {
    return <p className="text-xs text-muted-foreground">Loading…</p>;
  }
  if (query.isError) {
    return <p className="text-xs text-destructive">Failed to load: {query.error.message}</p>;
  }
  if (query.data.state !== "ok") {
    return (
      <p className="text-xs text-muted-foreground">
        {query.data.state === "degraded" ? query.data.reason : "Memory detail unavailable."}
      </p>
    );
  }
  const payload = query.data.payload as MemoriesDetailPayload;
  return (
    <div className="space-y-3 flex flex-col flex-1 min-h-0">
      <MemoryCurationBar record={payload.record} />
      <MemoryDetailContent payload={payload} onNavigate={onNavigate} />
    </div>
  );
}
