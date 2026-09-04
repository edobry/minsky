# ADR-048: `rules_embeddings` and `knowledge_embeddings` stay Minsky-instance-level

## Status

**Accepted** — 2026-09-04. Decided by the principal via ask#11550 (option: _"Ratify the split as
recommended"_), closing a disposition that had been pending since the 2026-07-20 investigation.
Carried out by mt#2938; supersedes two rows of mt#2417's Phase-1.4 classification table.

## Decision (read this first)

**Neither `rules_embeddings` nor `knowledge_embeddings` gets a `project_id`. Knowledge is
reclassified not-applicable-by-design and is finished. Rules remain project-scoped in PRINCIPLE
but are gated behind a named trigger, not built.**

Consequences of accepting:

1. **`knowledge_embeddings` is closed**, not deferred — it joins `tool_embeddings` and
   `principal_corpus_embeddings` as instance-level by design. No follow-up is owed.
2. **`rules_embeddings` keeps a real, unfixed defect**, deliberately: `rules search` / `rules
similar` query the entire shared table with no workspace restriction today.
3. **Nothing is built speculatively.** No project param is threaded through `indexRule`,
   `searchByText`, or the rules CLI/MCP commands.
4. **A concrete trigger reopens it** (§The trigger), and the interim fix's shape is recorded
   along with the constraint that nearly broke it.
5. **mt#2417's "needs-scoping in principle; fix deferred" is retired** for both tables — the
   phrase should not be cited as a live gap after this date.

## Context: what mt#2417 left open

mt#2417 (Phase 1.4 of the "Minsky beyond Minsky" project-identity work, RFC
`37a937f0-3cb4-81ed-9a08-fbdeebd8845d`) classified every embeddings table. Six were settled. Two —
`rules_embeddings` and `knowledge_embeddings` — were marked **"Needs-scoping in principle; fix
deferred"** and handed to mt#2938, because unlike transcripts (which had a `cwd` signal captured at
ingest) neither service has any project-awareness anywhere in its write or read path. Scoping them
would mean inventing plumbing, which is design work rather than audit cleanup.

That phrase then sat in an Accepted classification table for six weeks as an open gap with no
disposition. This ADR closes it.

**The RFC's committed Phase 1 does not cover these tables.** Verified against the RFC page:
Phase 1 adds a `project_id` FK to **tasks**, **sessions**, **asks** and formalizes the existing
nullable `memories.project_id`. Rules, tools and knowledge are absent from that set, so declining
to scope them is consistent with the roadmap rather than a departure from it.

## Knowledge: not applicable by design

Three independent reasons, any one of which would be sufficient:

**1. The collision that motivated the classification cannot occur.** `document_id` is not a
Minsky-issued key. Measured 2026-09-04, it is a composite of source name, externally-issued
document id, and chunk index:

```
minsky-design:33a937f0-3cb4-8119-9bbd-e69f3fc63de4:0
```

The middle component is a Notion page UUID — globally unique by construction, independent of how
many projects Minsky serves — and the `sourceName` prefix disambiguates further. Two projects
indexing the same document produce the same id because it IS the same document, which is
deduplication working, not interleaving.

> **Note for anyone auditing this argument.** The 2026-07-20 investigation described `document_id`
> as "an externally-issued UUID (Notion page id / Google Doc id)". That is imprecise — it is the
> composite above. The conclusion is unaffected and in fact strengthened; the shape is stated here
> so a later reader checking the claim finds the id the system actually stores.

**2. Knowledge sources are operator-configured, not project-configured.** `KnowledgeService.sync`
reads `config.knowledgeBases` from `getConfiguration()` — a process-global singleton. There is no
per-served-project knowledge-base list to scope BY, and inventing one would be a product decision
about what knowledge is, not a scoping fix.

**3. It matches the posture already ratified for the principal corpus.** mt#2417 classified
`principal_corpus_embeddings` not-applicable-by-design on exactly this reasoning: the corpus spans
all of one principal's projects, and scoping it would be a regression. Knowledge corpora are
principal-scoped in the same sense.

**Reclassification:** `knowledge_embeddings` → **not-applicable-by-design**.

## Rules: real in principle, gated in practice

Rules genuinely differ from knowledge. They are authored and versioned per repo in
`.minsky/rules`, so two served projects CAN define divergent rules under the same slug. The
classification was right. Building the fix now would still be wrong, per
`decision-defaults.mdc §Build vs buy`'s speculative-build argument: no collision has occurred,
because Minsky serves one project.

**Two findings recorded here because they are live facts, not hypotheses**, and because whoever
reopens this will need them:

- **The rules read path is completely unfiltered today.**
  `packages/domain/src/rules/rule-similarity-service.ts:80` maps
  `response.items.map((i) => ({ id: i.id, score: i.score }))` and passes no `filters` to
  `core.search({ queryText, limit })`. `rules search` and `rules similar` therefore query the whole
  shared `rules_embeddings` table with zero workspace restriction. Tools do the same
  (`tool-similarity-service.ts:112`, `:122`), which is harmless there because the tool catalog is
  genuinely instance-wide.
- **Slug collision is the guaranteed default on onboarding a second project.**
  `packages/domain/src/init.ts` scaffolds rules on every `minsky init` from a fixed shipped set, so
  a second project starts with the same slugs by construction. Content-hash skip-if-unchanged keeps
  identical copies harmless; the moment one project CUSTOMIZES a shared-slug rule, the shared table
  starts serving one project's rule text to the other, silently.

  **Updated 2026-09-04 by mt#4974, which replaced the mechanism this finding was measured against.**
  The original wording cited `packages/domain/src/init/rule-templates.ts:31-38`, which hardcoded 6
  of 7 TypeScript templates. That file and the whole template system are deleted. The scaffolded set
  is now the `base` tier of the package-resident corpus
  (`packages/domain/src/rules/corpus/*.mdc`), selected by `selectScaffoldableRules`
  (`packages/domain/src/rules/corpus.ts`) and written by
  `packages/domain/src/init/rule-corpus-scaffold.ts`.

  **The finding holds and its surface got LARGER, which is the part worth carrying forward.** The
  scaffolded slugs are still fixed and still identical across projects — `key-workflows`,
  `minsky-session-workflow`, `operational-safety-dry-run-first`,
  `task-status-workflow-protocol` — so collision remains the default rather than the exception. Two
  changes push the trigger closer, not further away: the corpus ships 17 rules where the templates
  shipped 7, and Phase 2 (mt#573) will make the other 13 installable per project, which is precisely
  the "one project CUSTOMIZES a shared-slug rule" case. mt#4974 deliberately did NOT add `project_id`,
  filter the read path, or otherwise act on this ADR's decision — it only kept this finding pointing
  at code that exists.

## The trigger

Stated in two steps, because the precondition is not currently met and a one-step reading produces
a false negative.

1. **Precondition — `minsky init` has been run in a second repo**, creating a `.minsky/rules`
   directory with the scaffolded template set. Until then there is no collision surface at all.
2. **Trigger — once that holds, any same-slug rule whose CONTENT diverges** from this repo's
   version.

**Why the two steps matter.** Checked 2026-09-04: the one other repo in this operator's working set
(`raycast`) has **no `.minsky/rules` directory** — `minsky init` has never been run there. A reader
who checks it for divergence finds none, and would be reading an absence as a clean signal. The
directory is not undiverged; it does not exist.

Re-run that check against whatever repos are in the working set at the time, rather than against a
path recorded here. An absolute path would pin this ADR to one machine and go stale the moment the
working set changes — leaving the trigger unverifiable exactly when someone needs to verify it.

**This ADR is the trigger's home.** The 2026-07-20 investigation proposed folding the check into
mt#2929's dogfood gap list; mt#2929 went DONE on 2026-08-27, so that home is closed and a check
filed there would be filed nowhere. Re-open by filing a task that cites this ADR.

## The interim fix, and the constraint that nearly broke it

When the trigger fires, the cheap fix is **a project tag in `rules_embeddings.metadata` plus a
search-time filter** — the column already exists and `PostgresVectorStorage` already supports
`filters`. That is far smaller than mirroring ADR-021's full project_id/scope-resolver plumbing.

**Read this before implementing it.** mt#4919 measured that pgvector applies a `WHERE` filter
AFTER the HNSW index scan, and the scan yields only `hnsw.ef_search` candidates (default 40) — so a
selective filter silently returns fewer rows than `LIMIT` asked for, non-monotonically (10 of 20
requested at ~12.7% selectivity, 7 of 20 at ~6%). `rules_embeddings` holds 71 rows against that
40-candidate default, so a filter at roughly half selectivity would leave ~20 rows for a page that
asked for more. **The interim fix above is exactly that construction.**

mt#4937 defused it on 2026-09-03 by issuing `SET LOCAL hnsw.iterative_scan = strict_order` on the
shared filtered path, so the fix is safe as written today. Do not re-derive the filter outside that
path.

## Supersedes

mt#2417's classification table, two rows, both previously **"Needs-scoping in principle; fix
deferred"**:

| Table                  | Was                                      | Now                                                |
| ---------------------- | ---------------------------------------- | -------------------------------------------------- |
| `knowledge_embeddings` | Needs-scoping in principle; fix deferred | **Not applicable, by design**                      |
| `rules_embeddings`     | Needs-scoping in principle; fix deferred | **Deferred behind a named trigger** (§The trigger) |

The other six rows are unchanged. mt#2417's separately-recorded gap — that
`TaskSimilarityService.similarToTask()` and `MemoryService.similar()` did not enforce project
scoping despite tasks and memories being covered-transitively — is **not** addressed here, and is
**already closed**: mt#2939 shipped that fix on 2026-07-20, roughly six weeks before this ADR was
written. Nothing remains owed on it.

> Corrected 2026-09-04 (mt#4957). This sentence originally read "remains owned by mt#2939",
> describing shipped work as pending. The citation was copied from mt#2417's
> `### Known gap discovered` section — _"Follow-up filed: mt#2939"_, an accurate statement about
> FILING that says nothing about status — and its status was never looked up. mt#2417's section is
> now annotated CLOSED so the next reader cannot repeat the inference.

## What would reopen this

- **Rules:** the two-step trigger above.
- **Knowledge:** a knowledge source whose document ids are Minsky-issued rather than
  externally-issued, or a per-served-project `knowledgeBases` list. Either would break a premise
  this decision rests on.
- **Neither:** Minsky merely serving a second project. That is the precondition for the rules
  trigger, not the trigger itself, and it changes nothing about knowledge.

## Cross-references

ADR-021 (project-scoping resolution model — _Proposed_; governs HOW scope resolves for entities
already scoped, not WHETHER a table should be) · RFC `37a937f0-3cb4-81ed-9a08-fbdeebd8845d`
("Minsky beyond Minsky", the governing record) · mt#2391 (Phase 1, IN-PROGRESS; entity set disjoint
from this one) · mt#2417 (the audit this supersedes two rows of) · mt#2938 (this decision's task) ·
mt#2939 (the similarity-endpoint scoping gap, separate — DONE 2026-07-20) · mt#4919 / mt#4937 (the filtered-recall
defect and its fix) · mt#4866 (init's template set) · ask#11550 (the ratification).
